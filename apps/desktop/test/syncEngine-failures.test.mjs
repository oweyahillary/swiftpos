// Integration test for the inbound-failure capture added to main/syncEngine.ts.
//
// Drives the REAL compiled dist/main/syncEngine.js. better-sqlite3 cannot be
// built in every environment, so localDb/deviceConfig/nodeClient are shimmed at
// the module-resolution boundary and `fetch` is stubbed. logFile.js is NOT
// shimmed — the real one runs, into a temp userData.
//
// What this proves: a failing catalogue pull and a failing token refresh are
// recorded with status + body, surfaced through getSyncStatus(), timestamped on
// FIRST failure rather than last retry, and cleared on recovery. It does not
// prove anything about better-sqlite3 behaviour on Windows.
//
// Run: node apps/desktop/test/syncEngine-failures.test.mjs

import fs from 'fs';
import os from 'os';
import path from 'path';
import Module from 'module';
import assert from 'assert';
import { fileURLToPath, pathToFileURL } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'main');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swiftpos-sync-'));

if (!fs.existsSync(path.join(dist, 'syncEngine.js'))) {
  console.error('dist/main not built. Run:  npx tsc -b tsconfig.main.json --force');
  process.exit(1);
}

// ── shims ────────────────────────────────────────────────────────────────────
const w = (name, src) => {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, src);
  return p;
};

const electronShim = w('electron.cjs',
  `module.exports = {
     app: { getPath: () => ${JSON.stringify(tmp)} },
     net: { isOnline: () => true },
     // Deliberately unavailable: exercises tokenStore's plaintext fallback,
     // which is the path a machine with no keyring takes. The wrapped path has
     // its own suite (tokenStore.test.mjs).
     safeStorage: { isEncryptionAvailable: () => false },
   };`);

// Counts are irrelevant here; the point is that getSyncStatus() can run.
// Enough of a session/staff_session table for the token paths to be exercised
// for real: refresh tokens are read back from "disk", so a test can simulate
// another caller having already rotated one.
const localDbShim = w('localDb.cjs', `
  const state = { session: { token: '', refresh_token: '' },
                  staff_session: { token: '', refresh_token: '' } };
  global.__dbState = state;
  function prepare(sql) {
    const isStaff = /staff_session/.test(sql);
    const row = () => state[isStaff ? 'staff_session' : 'session'];
    if (/^\\s*SELECT token, refresh_token, token_enc/i.test(sql)) {
      return { get: () => ({ token: row().token, refresh_token: row().refresh_token, token_enc: null, refresh_token_enc: null }), all: () => [], run: () => ({}) };
    }
    if (/^\\s*SELECT refresh_token/i.test(sql)) return { get: () => ({ refresh_token: row().refresh_token }), all: () => [], run: () => ({}) };
    if (/^\\s*UPDATE\\s+(session|staff_session)\\s+SET/i.test(sql) || /SET\\s+token\\s*=/i.test(sql)) {
      return { run: (t, r) => { const x = row(); x.token = t; x.refresh_token = r; return { changes: 1 }; }, get: () => undefined, all: () => [] };
    }
    return { get: () => ({ count: 0 }), all: () => [], run: () => ({ changes: 0 }) };
  }
  module.exports = { getLocalDb: () => ({ prepare, exec: () => {}, transaction: (f) => f }),
                     LOCAL_SCHEMA_VERSION: 51 };`);

const deviceConfigShim = w('deviceConfig.cjs', `
  module.exports = { getDeviceConfig: () => ({ device_id: 'test-device', branch_id: null }),
                     saveDeviceConfig: () => {}, getServerUrl: () => 'http://127.0.0.1:1',
                     canSell: () => true };`);

const nodeClientShim = w('nodeClient.cjs', `
  module.exports = { hasNode: () => false, pushRowsToNode: async () => ({}), measureNodeDrift: async () => ({}) };`);

const nodeIngestShim = w('nodeIngest.cjs', `module.exports = new Proxy({}, { get: () => () => {} });`);

const map = {
  electron: electronShim,
  './localDb': localDbShim,
  './deviceConfig': deviceConfigShim,
  './nodeClient': nodeClientShim,
  './nodeIngest': nodeIngestShim,
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) {
  const fromDist = parent?.filename?.startsWith(dist);
  if (req === 'electron') return map.electron;
  if (fromDist && map[req]) return map[req];
  return origResolve.call(this, req, parent, ...rest);
};

// ── stub fetch ───────────────────────────────────────────────────────────────
let nextResponse = null;
globalThis.fetch = async () => {
  if (typeof nextResponse === 'function') return nextResponse();
  return nextResponse;
};
const resp = (status, body, statusText) => ({
  ok: status >= 200 && status < 300,
  status, statusText,
  text: async () => body,
  json: async () => JSON.parse(body),
});

const engine = await import(pathToFileURL(path.join(dist, 'syncEngine.js')).href);
const logPath = path.join(tmp, 'swiftpos.log');

let pass = 0, fail = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
};
const log = () => (fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '');

console.log('syncEngine - inbound failure capture\n');

engine.configureSyncEngine('http://127.0.0.1:1', 'access-token', 'refresh-token');

check('getSyncStatus exposes the new fields', () => {
  const s = engine.getSyncStatus();
  assert.ok('pullError' in s, 'pullError missing from status');
  assert.ok('pullErrorSince' in s, 'pullErrorSince missing from status');
  assert.strictEqual(s.logPath, logPath);
});

check('clean start reports no pull error', () => {
  assert.strictEqual(engine.getSyncStatus().pullError, undefined);
});

// 403 BRANCH_NOT_LICENSED — the D11 case.
nextResponse = resp(403, '{"error":"Branch not licensed","code":"BRANCH_NOT_LICENSED","ref":"341849fb"}', 'Forbidden');
await engine.syncAll();

check('a 403 catalogue pull is captured with status and body', () => {
  assert.ok(engine.getSyncStatus().pullError, 'nothing reported at all');
  const line = log();
  assert.match(line, /catalogue pull failed/);
  assert.match(line, /HTTP 403/);
  assert.match(line, /BRANCH_NOT_LICENSED/);
});

check('the server ref survives, keyed to the server log', () => {
  assert.match(engine.getSyncStatus().pullError, /341849fb/);
});

check('it reaches the durable log too', () => {
  assert.match(log(), /\[sync\] catalogue pull failed: HTTP 403/);
});

const firstSince = engine.getSyncStatus().pullErrorSince;
check('the pull failure is not masked by the auth failure it triggered', () => {
  assert.match(log(), /\[sync\] catalogue pull failed: HTTP 403/,
    'the real cause must survive in the durable log');
});
check('pullErrorSince is set on first failure', () => {
  assert.ok(firstSince, 'no since timestamp');
  assert.ok(!Number.isNaN(Date.parse(firstSince)), 'since is not a date');
});

await new Promise(r => setTimeout(r, 20));
await engine.syncAll(); // same failure again

check('repeat of the SAME failure keeps the original timestamp', () => {
  assert.strictEqual(engine.getSyncStatus().pullErrorSince, firstSince,
    'since moved on retry - it would report "broken for 0 seconds" forever');
});

nextResponse = resp(500, '{"error":"Failed to create order","ref":"deadbeef"}');
await engine.syncAll();
check('a DIFFERENT failure resets the timestamp', () => {
  const s = engine.getSyncStatus();
  assert.match(s.pullError, /HTTP 500/);
  assert.notStrictEqual(s.pullErrorSince, firstSince);
});

// Network down — fetch throws rather than returning a response.
globalThis.fetch = async () => { throw new Error('ECONNREFUSED 127.0.0.1:1'); };
await engine.syncAll();
check('an unreachable server is captured, not swallowed', () => {
  assert.match(log(), /\[sync\] catalogue pull unreachable: ECONNREFUSED/);
});

check('auth is reported ahead of sync when both are broken', () => {
  const s = engine.getSyncStatus();
  assert.match(s.pullError, /token refresh/,
    'a dead token explains a dead pull; the cause must win over the symptom');
});

// Recovery.
globalThis.fetch = async () => resp(200, JSON.stringify({
  products: [], categories: [], branchId: null, vatRate: 16, ctlRate: 2,
  maxDiscountPct: 100, businessType: 'restaurant', comboItems: [],
  receiptHeader: '', receiptFooter: '', kitchenExclusions: [],
}));
await engine.syncAll();

check('a successful pull clears the SYNC failure', () => {
  assert.match(log(), /\[sync\] recovered after:/);
});

check('but a still-broken auth failure is NOT cleared by it', () => {
  assert.match(engine.getSyncStatus().pullError, /token refresh/,
    'clearing one scope must not hide another that is still broken');
});

check('a successful refresh clears the auth failure and the slate', async () => {});
globalThis.fetch = async () => resp(200, JSON.stringify({
  accessToken: 'new-access', refreshToken: 'new-refresh',
}));
await engine.refreshAccessToken();
check('everything clear once both recover', () => {
  const s = engine.getSyncStatus();
  assert.strictEqual(s.pullError, undefined);
  assert.strictEqual(s.pullErrorSince, undefined);
  assert.match(log(), /\[auth\] recovered after:/);
});

check('no token or refresh token leaked into the log', () => {
  const body = log();
  assert.ok(!body.includes('access-token'), 'access token in log');
  assert.ok(!body.includes('refresh-token'), 'refresh token in log');
});

console.log('\nsyncEngine - token refresh capture\n');

globalThis.fetch = async () => resp(401, '{"error":"Refresh token revoked"}', 'Unauthorized');
const ok = await engine.refreshAccessToken();

check('a revoked refresh token still returns false', () => {
  assert.strictEqual(ok, false);
});

check('the D13 re-login case is now recorded, not silent', () => {
  const s = engine.getSyncStatus();
  assert.match(s.pullError, /owner token refresh failed/);
  assert.match(s.pullError, /HTTP 401/);
  assert.match(log(), /\[auth\] owner token refresh failed/);
});

globalThis.fetch = async () => { throw new Error('socket hang up'); };
await engine.refreshAccessToken();
check('a thrown refresh is recorded rather than swallowed', () => {
  assert.match(engine.getSyncStatus().pullError, /owner token refresh error: socket hang up/);
});

console.log('\nsyncEngine - refresh single-flight (D13)\n');

// D13: refresh tokens rotate and the server revokes the consumed one, so two
// concurrent refreshes mean the loser is handed a 401 for a token that was
// valid when it read it. Offline that is unrecoverable - there is no way to
// sign back in.
let refreshCalls = 0;
let releaseRefresh;
const gate = new Promise(r => { releaseRefresh = r; });
globalThis.fetch = async () => {
  refreshCalls++;
  await gate;                                  // hold every call open together
  return resp(200, JSON.stringify({ accessToken: 'a' + refreshCalls, refreshToken: 'r' + refreshCalls }));
};

const trio = Promise.all([
  engine.refreshAccessToken(), engine.refreshAccessToken(), engine.refreshAccessToken(),
]);
await new Promise(r => setTimeout(r, 20));
releaseRefresh();
const results = await trio;

check('three concurrent refreshes make ONE request', () => {
  assert.strictEqual(refreshCalls, 1,
    `${refreshCalls} requests - the losers get a 401 on an already-rotated token`);
});

check('every concurrent caller gets the winning result', () => {
  assert.deepStrictEqual(results, [true, true, true]);
});

check('the rotated token is persisted', () => {
  assert.strictEqual(globalThis.__dbState.session.refresh_token, 'r1');
});

check('the guard clears, so a later refresh still runs', async () => {});
refreshCalls = 0;
globalThis.fetch = async () => {
  refreshCalls++;
  return resp(200, JSON.stringify({ accessToken: 'a9', refreshToken: 'r9' }));
};
await engine.refreshAccessToken();
check('a subsequent refresh is not blocked by the previous one', () => {
  assert.strictEqual(refreshCalls, 1);
});

check('the guard clears after a FAILED refresh too', async () => {});
globalThis.fetch = async () => { throw new Error('boom'); };
await engine.refreshAccessToken();
refreshCalls = 0;
globalThis.fetch = async () => { refreshCalls++; return resp(200, JSON.stringify({ accessToken: 'a10', refreshToken: 'r10' })); };
const after = await engine.refreshAccessToken();
check('a failure does not wedge the guard forever', () => {
  assert.strictEqual(after, true);
  assert.strictEqual(refreshCalls, 1, 'a stuck guard means the till can never refresh again');
});

console.log('\nsyncEngine - stale token retry (D13)\n');

// In-memory copy lags what is on disk. Presenting the stale one to a rotating
// endpoint earns a 401 that is bookkeeping, not a revoked session.
globalThis.__dbState.session.refresh_token = 'fresh-on-disk';
engine.configureSyncEngine('http://127.0.0.1:1', 'access', 'stale-in-memory');
let seen = [];
globalThis.fetch = async (_url, opts) => {
  const sent = JSON.parse(opts.body).refreshToken;
  seen.push(sent);
  return sent === 'fresh-on-disk'
    ? resp(200, JSON.stringify({ accessToken: 'aok', refreshToken: 'rok' }))
    : resp(401, '{"error":"Invalid refresh token"}', 'Unauthorized');
};
const recovered = await engine.refreshAccessToken();

check('a 401 on a stale token retries with the persisted one', () => {
  assert.deepStrictEqual(seen, ['stale-in-memory', 'fresh-on-disk']);
  assert.strictEqual(recovered, true, 'this is an avoidable logout, and offline it is fatal');
});

check('the retry is logged so it is not invisible', () => {
  assert.match(log(), /refresh rejected on a stale token/);
});

seen = [];
globalThis.__dbState.session.refresh_token = 'same-token';
engine.configureSyncEngine('http://127.0.0.1:1', 'access', 'same-token');
globalThis.fetch = async (_url, opts) => { seen.push(JSON.parse(opts.body).refreshToken); return resp(401, '{"error":"Revoked"}', 'Unauthorized'); };
const genuinely = await engine.refreshAccessToken();

check('a genuinely revoked token is NOT retried', () => {
  assert.strictEqual(seen.length, 1,
    're-asking a question already answered just doubles the load on a dead session');
  assert.strictEqual(genuinely, false);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
