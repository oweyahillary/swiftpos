// A504 — a person's session the cloud refused for good never holds the till's drawers, days and expenses.
//
// A494 ends a person's sessions when they are deactivated, re-roled or moved, and /auth/refresh now re-reads the person
// (401 SIGN_IN_AGAIN). The till pushes its cash records (/api/sync/push), closes, confirmations and price edits with the
// person signed in (pushAuthHeaders: staff token first). Once that token's renewal was refused, the dead token was sent
// again on every pass until the person signed out — all shift long nothing but orders (which fall back) reached the
// cloud. Now the till's own session carries them (the cloud takes it: routes/sync.ts req.isTill); a new sign-in's token
// is used again.
//
// RUNS the real compiled dist/main (electron shimmed, REAL SQLite, the cloud mocked):
//   cd apps/desktop && npm run build:main && node test/staff-token-refused-push.test.mjs
//
// MUTATION TO CONFIRM BITE: pushAuthHeaders back to `_staffToken || _accessToken` → "reaches the cloud" fails.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'main');
const require = createRequire(import.meta.url);
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-a504-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `module.exports = { app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '0.0.0', isPackaged: false }, ipcMain: { handle() {} }, BrowserWindow: class { static getAllWindows() { return []; } }, dialog: {}, safeStorage: { isEncryptionAvailable: () => false }, net: { isOnline: () => true } };`);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) { return req === 'electron' ? shim : orig.call(this, req, parent, ...rest); };

const L = require(path.join(dist, 'localDb.js'));
const T = require(path.join(dist, 'tokenStore.js'));
const E = require(path.join(dist, 'syncEngine.js'));
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };

const db = L.getLocalDb();
db.prepare(`INSERT INTO session (id, token, refresh_token, user_id, business_id, business_name, logged_in_at) VALUES (1, 'till-tok', 'till-ref', 'dev-T1', 'biz-1', 'Pollo', '2026-10-15T00:00:00Z')`).run();
require(path.join(dist, 'deviceConfig.js')).saveDeviceConfig({ deploy_mode: 'cloud', server_url: 'http://cloud', branch_id: 'br-1',
  device_id: 'dev-T1', device_role: 'till', terminal_code: 'T1', device_name: 'Till 1' });
db.prepare(`INSERT INTO staff_session (id, staff_id, staff_name, role_name, branch_id, token, logged_in_at) VALUES (1, 'u-mgr', 'Mary', 'manager', 'br-1', '', '2026-10-15T06:00:00Z')`).run();
T.writeStaffTokens({ token: 'staff-dead', refreshToken: 'staff-ref' });
E.configureSyncEngine('http://cloud', 'till-tok', 'till-ref');
E.configureStaffSession('staff-dead', 'staff-ref');

const cloud = { pushBearers: [], live: new Set(['till-tok']), shifts: new Set() };
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const body = init.body ? JSON.parse(init.body) : {};
  const bearer = String(init.headers?.Authorization ?? '').replace('Bearer ', '');
  if (u.endsWith('/api/auth/refresh')) {
    if (body.refreshToken === 'staff-ref') return json(401, { error: 'Please sign in again.', code: 'SIGN_IN_AGAIN', reason: 'ACCOUNT_INACTIVE' });
    return json(200, { accessToken: 'till-tok', refreshToken: 'till-ref' });
  }
  if (u.endsWith('/api/sync/push')) {
    cloud.pushBearers.push(bearer);
    if (!cloud.live.has(bearer)) return json(401, { error: 'Invalid or expired token' });
    for (const s of body.shifts ?? []) cloud.shifts.add(s.id);
    return json(200, { ok: true, upserted: { shifts: (body.shifts ?? []).length, floats: 0, expenses: 0, businessDays: (body.business_days ?? []).length }, rejected: [] });
  }
  return json(404, { error: 'not here' });
};

const now = () => new Date().toISOString();
db.prepare(`INSERT INTO business_days (id, business_id, branch_id, device_id, terminal_code, business_date, opened_at, status, created_at, sync_status)
            VALUES ('day-1', 'biz-1', 'br-1', 'dev-T1', 'T1', '2026-10-15', ?, 'open', ?, 'pending')`).run(now(), now());
db.prepare(`INSERT INTO shifts (id, business_id, branch_id, cashier_id, opened_at, status, opening_float, created_at, sync_status, device_id, terminal_code, business_day_id, opened_by)
            VALUES ('sh-1', 'biz-1', 'br-1', 'u-mgr', ?, 'open', 1000, ?, 'pending', 'dev-T1', 'T1', 'day-1', 'u-mgr')`).run(now(), now());
const st = (id) => db.prepare(`SELECT sync_status FROM shifts WHERE id = ?`).get(id)?.sync_status;

console.log('\nA manager deactivated mid-shift: the cloud refuses her session and its renewal\n');
for (let i = 0; i < 3; i++) await E.syncPush();
ok('the drawer reaches the cloud under the till\'s own session (within the next pass)', st('sh-1') === 'synced' && cloud.shifts.has('sh-1'),
  JSON.stringify({ status: st('sh-1'), bearers: cloud.pushBearers }));
ok('the dead token is not sent pass after pass (at most once)', cloud.pushBearers.filter((b) => b === 'staff-dead').length <= 1, JSON.stringify(cloud.pushBearers));

console.log('\nThe next person signs in: their own session is used again\n');
db.prepare(`UPDATE staff_session SET staff_id = 'u-cash', staff_name = 'Cal' WHERE id = 1`).run();
T.writeStaffTokens({ token: 'staff-new', refreshToken: 'ref-new' });
E.configureStaffSession('staff-new', 'ref-new');
cloud.live.add('staff-new');
db.prepare(`INSERT INTO shifts (id, business_id, branch_id, cashier_id, opened_at, status, opening_float, created_at, sync_status, device_id, terminal_code, business_day_id, opened_by)
            VALUES ('sh-2', 'biz-1', 'br-1', 'u-cash', ?, 'closed', 500, ?, 'pending', 'dev-T1', 'T1', 'day-1', 'u-cash')`).run(now(), now());
cloud.pushBearers.length = 0;
await E.syncPush();
ok('a fresh sign-in pushes under its own token', cloud.pushBearers.includes('staff-new') && !cloud.pushBearers.includes('till-tok'), JSON.stringify(cloud.pushBearers));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
