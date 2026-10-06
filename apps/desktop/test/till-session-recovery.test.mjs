// A407 — a till's sign-in is never lost: refused → it signs itself back in with its device secret; a till enrolled
// before it kept one is given one on an ordinary renewal; with none, the cloud is told (ZapTill is emailed) and
// cashiers keep signing in on the till's own PIN check.
// Owner, 2026-10-05: "how do we prevent this from ever happening" — "if a till is rejected when it comes online after a
// long offline period i should get an email".
//
// Drives the REAL compiled dist/main (localDb, tokenStore, syncEngine.refreshAccessToken, sessionRecovery) on a REAL
// SQLite file, with a stand-in cloud.
//
//   cd apps/desktop && npx tsc -p tsconfig.main.json && node test/till-session-recovery.test.mjs
//
// MUTATIONS TO CONFIRM BITE:
//   - the device grant not tried on a refused renewal         → "signs itself back in" fails
//   - the secret from a renewal not kept                       → "kept for next time" fails
//   - isSessionRefusal treating "Invalid PIN" as a refusal     → "a wrong PIN is still a wrong PIN" fails
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'main');
const require = createRequire(import.meta.url);
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-a407-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `module.exports = { app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '0.0.0' }, ipcMain: { handle() {} }, BrowserWindow: class { static getAllWindows() { return []; } }, dialog: {}, safeStorage: { isEncryptionAvailable: () => false }, net: { isOnline: () => true } };`);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) { return req === 'electron' ? shim : orig.call(this, req, parent, ...rest); };

const L = require(path.join(dist, 'localDb.js'));
const T = require(path.join(dist, 'tokenStore.js'));
const E = require(path.join(dist, 'syncEngine.js'));
const R = require(path.join(dist, 'sessionRecovery.js'));
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };

console.log('\nThe rules (pure)\n');
ok('a refused session is told apart from a wrong PIN', R.isSessionRefusal({ code: 'TOKEN_REPLAYED' }) && R.isSessionRefusal({ code: 'SIGN_IN_AGAIN' })
  && R.isSessionRefusal({ error: 'Invalid or expired token' }) && !R.isSessionRefusal({ error: 'Invalid PIN' }) && !R.isSessionRefusal({ code: 'BRANCH_NOT_LICENSED' }));
ok('the device-token body: business, device, secret (empty still goes — the cloud records the till)',
  JSON.stringify(R.deviceGrantBody('b1', 'dev-T1', '')) === JSON.stringify({ business_id: 'b1', device_id: 'dev-T1', device_secret: '' }) && R.deviceGrantBody(null, 'x', 's') === null);

console.log('\nThe till, end to end\n');
const db = L.getLocalDb();
db.prepare(`INSERT INTO session (id, token, refresh_token, user_id, business_id, business_name, logged_in_at) VALUES (1, 'acc-0', 'ref-0', 'u-owner', 'biz-1', 'Pollo', '2026-10-01T00:00:00Z')`).run();
require(path.join(dist, 'deviceConfig.js')).saveDeviceConfig({ deploy_mode: 'cloud', server_url: 'http://cloud', branch_id: 'br-1',
  device_id: 'dev-T1', device_role: 'till', terminal_code: 'T1', device_name: 'Till 1' });
E.configureSyncEngine('http://cloud', 'acc-0', 'ref-0');

const cloud = { refresh: 'ok', giveSecret: 'sec-123', grants: [], refreshHeaders: [] };
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const body = init.body ? JSON.parse(init.body) : {};
  const json = (status, b) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
  if (u.endsWith('/api/auth/refresh')) {
    cloud.refreshHeaders.push(init.headers?.['X-Device-Id']);
    if (cloud.refresh === 'refuse') return json(401, { error: 'Refresh token already used — all sessions revoked for security', code: 'TOKEN_REPLAYED' });
    return json(200, { accessToken: 'acc-1', refreshToken: 'ref-1', ...(cloud.giveSecret ? { deviceSecret: cloud.giveSecret } : {}) });
  }
  if (u.endsWith('/api/auth/device-token')) {
    cloud.grants.push(body);
    if (body.device_secret === 'sec-123' && body.device_id === 'dev-T1' && body.business_id === 'biz-1') return json(200, { accessToken: 'acc-2', refreshToken: 'ref-2' });
    return json(401, { error: body.device_secret ? 'Device grant refused' : 'This till needs a new enrolment code.', code: body.device_secret ? 'DEVICE_GRANT_INVALID' : 'DEVICE_NO_SECRET' });
  }
  return json(404, {});
};

ok('before: an old till holds no device secret', T.readDeviceSecret() === '');
ok('an ordinary renewal sends the device id …', (await E.refreshAccessToken()) === true && cloud.refreshHeaders[0] === 'dev-T1', JSON.stringify(cloud.refreshHeaders));
ok('… and the secret the cloud hands over is kept for next time', T.readDeviceSecret() === 'sec-123' && T.readSessionTokens().refreshToken === 'ref-1');

cloud.refresh = 'refuse'; cloud.giveSecret = null;
ok('a refused renewal → the till signs itself back in with its device secret', (await E.refreshAccessToken()) === true
  && cloud.grants.length === 1 && cloud.grants[0].device_secret === 'sec-123' && T.readSessionTokens().token === 'acc-2' && T.readSessionTokens().refreshToken === 'ref-2',
  JSON.stringify({ grants: cloud.grants, tok: T.readSessionTokens() }));

T.clearDeviceSecret();
ok('no secret: the cloud is still told (it records the till, ZapTill is emailed); the renewal fails cleanly',
  (await E.refreshAccessToken()) === false && cloud.grants.length === 2 && cloud.grants[1].device_secret === '');

console.log('\nThe wiring (source)\n');
const src = (p) => fs.readFileSync(path.join(here, '..', 'src', p), 'utf8');
const ipc = src('main/ipcHandlers.ts');
// A415: there is no "sign the till out" any more — a technician rejoins it instead, keeping everything on it.
ok('enrolment (and a technician\'s rejoin) keeps the secret; nothing on the till signs it out of the business',
  /if \(typeof data\.deviceSecret === 'string' && data\.deviceSecret\) writeDeviceSecret\(data\.deviceSecret\);/.test(ipc)
  && !/handle\('auth:logout'/.test(ipc) && !/clearDeviceSecret\(\)/.test(ipc));
ok('a refused session: the PIN is checked on the till and the cashier sells (a wrong PIN stays wrong)',
  /if \(res\.status === 401 && isSessionRefusal\(data\)\) \{[\s\S]{0,200}return fallbackToLocalAuthority\(\);\s*\}\s*if \(!res\.ok\) throw new Error\(data\.error \?\? 'Invalid PIN'\);/.test(ipc));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
