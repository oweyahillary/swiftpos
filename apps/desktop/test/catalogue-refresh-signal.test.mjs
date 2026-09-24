// A321 — a pull that lands must refresh the open screens, whichever path pulled; and the 20-s freshness
// check must not fail silently. Harness: the same shims as syncEngine-failures.test.mjs (plus isNodeRole),
// driving the REAL compiled dist/main/syncEngine.js with a URL-routed fetch stub — a genuine successful
// catalogue pull runs end to end (pos/init → staff → stations → day-close), not a mocked return value.
//
// MUTATIONS TO CONFIRM BITE:
//   - remove `if (pulled) notifyCataloguePulled();` from syncAll  → the listener cases fail
//   - restore the silent `if (!res.ok) return` in the 20-s check   → the "recorded" cases fail
//   - drop the 401 refresh-and-retry                               → "a 401 is refreshed and retried" fails
//   - index.ts back to getAllWindows()[0] from the 20-s check only  → the wiring pins fail
//   - PinPage back to read-once                                     → the lock-screen pins fail
//
// Original header of the harness this is copied from:
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swiftpos-refresh-'));

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
  // applyPulled* are the real module's writers; the engine calls them when the cloud sends branding/theme.
  module.exports = { getLocalDb: () => ({ prepare, exec: () => {}, transaction: (f) => f }),
                     LOCAL_SCHEMA_VERSION: 51, applyPulledBranding: () => {}, applyPulledTheme: () => {} };`);

const deviceConfigShim = w('deviceConfig.cjs', `
  module.exports = { getDeviceConfig: () => ({ device_id: 'test-device', branch_id: null }),
                     saveDeviceConfig: () => {}, getServerUrl: () => 'http://127.0.0.1:1',
                     canSell: () => true, isNodeRole: () => false };`);

const nodeClientShim = w('nodeClient.cjs', `
  module.exports = { hasNode: () => false, pushRowsToNode: async () => ({}), measureNodeDrift: async () => ({}),
    // A24: pullCatalogue() calls this unconditionally and falls through to the
    // cloud when it returns null. The shim omitted it, so the pull threw before
    // ever reaching the cloud 403 — which is what these tests exercise.
    fetchReferenceFromNode: async () => null };`);

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



let route = () => null;
const calls = [];
const resp = (status, body) => ({ ok: status >= 200 && status < 300, status, statusText: String(status),
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  json: async () => (typeof body === 'string' ? JSON.parse(body) : body) });
globalThis.fetch = async (url, opts) => {
  const u = String(url).replace('http://127.0.0.1:1', '');
  calls.push({ u, auth: opts?.headers?.Authorization ?? '' });
  const r = route(u, opts);
  if (r instanceof Error) throw r;
  // Unrouted refresh = REJECTED. (A default 200 [] here "refreshed" to an undefined token and silently
  // de-configured the engine for every later case — caught on the first run of this file.)
  if (!r && u.startsWith('/api/auth/refresh')) return resp(401, '{"error":"invalid refresh token"}');
  return r ?? resp(200, []);
};
const INIT_OK = (u) => u.startsWith('/api/pos/init') ? resp(200, { products: [], categories: [], branchId: null }) : null;

const engine = await import(pathToFileURL(path.join(dist, 'syncEngine.js')).href);
engine.configureSyncEngine('http://127.0.0.1:1', 'access-token', 'refresh-token');

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { console.log(`  ok   ${name}`); pass++; } else { console.log(`  FAIL ${name}  ${detail}`); fail++; }
};
let fired = 0;
const off = engine.onCataloguePulled(() => { fired++; });

console.log('A321 — catalogue refresh signal\n');

// 1. Any successful pull tells the screens (the 10-min floor, startup, manual sync… all call syncAll).
route = INIT_OK; fired = 0;
let r = await engine.syncAll();
check('a successful syncAll pull fires the refresh signal exactly once', r.pulled === true && fired === 1, `pulled=${r.pulled} fired=${fired}`);

// 2. A failed pull must not tell the screens anything changed.
route = (u) => u.startsWith('/api/pos/init') ? resp(403, '{"error":"Branch not licensed","code":"BRANCH_NOT_LICENSED"}') : null;
fired = 0; r = await engine.syncAll();
check('a FAILED pull does not fire it', r.pulled === false && fired === 0, `pulled=${r.pulled} fired=${fired}`);

// 3. Listener mechanics: all listeners run, a throwing one does not stop the rest, unsubscribe works.
let second = 0;
const offThrow = engine.onCataloguePulled(() => { throw new Error('boom'); });
const offSecond = engine.onCataloguePulled(() => { second++; });
route = INIT_OK; fired = 0; second = 0; await engine.syncAll();
check('every listener runs, even after one throws', fired === 1 && second === 1, `fired=${fired} second=${second}`);
offThrow(); offSecond(); fired = 0; second = 0; await engine.syncAll();
check('unsubscribe removes a listener', fired === 1 && second === 0, `fired=${fired} second=${second}`);

// 4. The 20-s check: a moved version pulls (and so fires); an unchanged one does nothing.
const ver = (v) => (u) => u.startsWith('/api/pos/catalogue-version') ? resp(200, { version: v }) : INIT_OK(u);
route = ver('2026-09-23T10:00:00Z'); fired = 0;
let c = await engine.pullIfCatalogueChanged();
check('20-s check: a new version pulls and fires the signal', c.changed && c.pulled && fired === 1, JSON.stringify(c) + ` fired=${fired}`);
fired = 0; c = await engine.pullIfCatalogueChanged();
check('20-s check: the same version again does nothing', !c.changed && fired === 0, JSON.stringify(c));

// 5. A 401 on the check is refreshed and retried — it used to be dropped as "no change".
let versionCalls = 0;
route = (u, o) => {
  if (u.startsWith('/api/auth/refresh')) return resp(200, { accessToken: 'fresh-token', refreshToken: 'refresh-2' });
  if (u.startsWith('/api/pos/catalogue-version')) {
    versionCalls++;
    return String(o?.headers?.Authorization).includes('fresh-token') ? resp(200, { version: '2026-09-23T11:00:00Z' }) : resp(401, '{"error":"expired"}');
  }
  return INIT_OK(u);
};
fired = 0; c = await engine.pullIfCatalogueChanged();
check('a 401 on the check is refreshed and retried, then pulls', versionCalls === 2 && c.pulled && fired === 1, `versionCalls=${versionCalls} ${JSON.stringify(c)} fired=${fired}`);
check('…and leaves no failure on the status', !String(engine.getSyncStatus().pullError ?? '').includes('catalogue-version'), String(engine.getSyncStatus().pullError));

// 6. Any other failure is RECORDED (tech screen sync status), not swallowed; recovery clears it.
route = (u) => u.startsWith('/api/pos/catalogue-version') ? resp(500, 'oops') : INIT_OK(u);
c = await engine.pullIfCatalogueChanged();
const s500 = String(engine.getSyncStatus().pullError ?? '');
check('a 500 on the check is recorded on the sync status', !c.changed && /catalogue-version check failed: HTTP 500/.test(s500), s500);
check('…and says changes will still arrive with the 10-minute sync', /10-minute sync/.test(s500));
route = () => new Error('getaddrinfo ENOTFOUND'); await engine.pullIfCatalogueChanged();
check('a network failure on the check is recorded too', /catalogue-version check failed: getaddrinfo ENOTFOUND/.test(String(engine.getSyncStatus().pullError)), String(engine.getSyncStatus().pullError));
route = ver('2026-09-23T12:00:00Z'); await engine.pullIfCatalogueChanged();
check('a later successful check clears it', !String(engine.getSyncStatus().pullError ?? '').includes('catalogue-version'), String(engine.getSyncStatus().pullError));
off();

// 7. Wiring the engine cannot show: index.ts sends to EVERY window on ANY pull; the lock screen listens.
const src = (p) => fs.readFileSync(path.join(here, '..', 'src', p), 'utf8');
const idx = src('main/index.ts');
check('index.ts registers the refresh listener with the engine', /onCataloguePulled\(\(\) => \{/.test(idx));
check('…and it messages every window, skipping destroyed ones',
  /for \(const w of BrowserWindow\.getAllWindows\(\)\) \{\s*if \(!w\.isDestroyed\(\)\) w\.webContents\.send\('catalogue:changed'\);/.test(idx));
check('the old "first window, 20-s path only" send is gone', !/getAllWindows\(\)\[0\]\?\.webContents\.send\('catalogue:changed'\)/.test(idx));
const pin = src('renderer/pages/PinPage.tsx');
check('the lock screen re-reads branding on the refresh signal', /const unsubscribe = posApi\.pos\.onCatalogueChanged\(load\);/.test(pin) && /return \(\) => \{ cancelled = true; unsubscribe\(\); \};/.test(pin));
// A326 changed this line: with themes ON and no brand colour the PIN screen now takes the theme. The A321 intent
// is unchanged — with no brand colour and themes OFF, null is APPLIED (back to the default), never ignored.
check('…and a cleared branding returns it to the default (null is applied, not ignored)',
  /setAccentHex\(b\?\.accentHex \?\? \(b\?\.themeId \? resolveTheme\(b\.themeId\)\.shades\[500\] : null\)\)/.test(pin) && !/if \(cancelled \|\| !b\) return;/.test(pin));
const pos = src('renderer/pages/POSPage.tsx');
check('the POS grid still reloads on the same signal', /posApi\.pos\.onCatalogueChanged\(loadCatalogue\)/.test(pos));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
