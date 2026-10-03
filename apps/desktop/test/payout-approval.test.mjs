// 0.6.37 (A388) — a manager approves a cash-out (pay out) and an expense on the spot, offline too.
// Owner, 2026-10-03: "Manager approve cashout and expense" — "Manager PIN on the spot".
//
// Registers the REAL compiled IPC handlers (dist/main/ipcHandlers.js) with electron shimmed and NO network, caches a
// manager's and a cashier's credential the way an online sign-in does (real pinCache, real bcrypt), and calls the real
// shift:float and expense:create; then the real Z-report (shiftService.computeZReport) and the push's rows.
//
//   cd apps/desktop && npx tsc -p tsconfig.main.json && node test/payout-approval.test.mjs
//
// MUTATIONS TO CONFIRM BITE:
//   - shift:float skips payoutApprover                  → "a cashier's pay out with no PIN is refused" fails
//   - expense:create skips payoutApprover               → "a cashier's expense with no PIN is refused" fails
//   - payoutApprover accepts any saved PIN              → "a cashier's own PIN does not approve" fails
//   - the Z-report drops approvedSuffix                 → "the Z-report says who approved" fails
//   - the push leaves approved_by out of its SELECT      → "the push carries the approver" fails
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'main');
const require = createRequire(import.meta.url);

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'swiftpos-0637a-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `
  const handlers = (global.__handlers = {});
  module.exports = {
    app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '0.0.0', on() {}, isPackaged: false },
    ipcMain: { handle(ch, fn) { handlers[ch] = fn; }, on() {}, removeHandler() {} },
    BrowserWindow: class { static getAllWindows() { return []; } static getFocusedWindow() { return null; } },
    dialog: {}, shell: {}, screen: {}, Menu: {}, powerMonitor: { on() {}, getSystemIdleTime: () => 0 },
    safeStorage: { isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from('w:' + s), decryptString: (b) => Buffer.from(b).toString().slice(2) },
    net: { isOnline: () => false },
  };`);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) {
  if (req === 'electron') return shim;
  return orig.call(this, req, parent, ...rest);
};

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };
const rejects = async (p) => { try { await p; return null; } catch (e) { return e; } };

const L = require(path.join(dist, 'localDb.js'));
const db = L.getLocalDb();
db.prepare(`INSERT INTO session (id, token, user_id, business_id, business_name, logged_in_at) VALUES (1, 'owner-tok', 'u-owner', 'biz-1', 'Your Business', '2026-10-03T00:00:00Z')`).run();
require(path.join(dist, 'deviceConfig.js')).saveDeviceConfig({ deploy_mode: 'cloud', server_url: 'http://cloud', branch_id: 'br-1',
  device_id: 'dev-T1', device_role: 'till', terminal_code: 'T1', device_name: 'Front Counter' });
db.prepare(`INSERT INTO users (id, name) VALUES ('u-mary', 'Mary'), ('u-tom', 'Tom')`).run();

const bcrypt = require('bcryptjs');
const P = require(path.join(dist, 'pinCache.js'));
P.cacheStaffCredential({ staffId: 'u-mary', name: 'Mary', roleName: 'manager', permissions: { 'orders.void': true } },
  bcrypt.hashSync('4321', 4), 'br-1');
P.cacheStaffCredential({ staffId: 'u-tom', name: 'Tom', roleName: 'cashier', permissions: { 'orders.create': true } },
  bcrypt.hashSync('1111', 4), 'br-1');
const signIn = (id, name, role, perms = '{}') => db.prepare(`INSERT OR REPLACE INTO staff_session (id, staff_id, staff_name, role_name, permissions, branch_id, token, logged_in_at)
  VALUES (1, ?, ?, ?, ?, 'br-1', 'tok', '2026-10-03T06:00:00Z')`).run(id, name, role, perms);

globalThis.fetch = async () => { throw new TypeError('fetch failed'); };   // offline
require(path.join(dist, 'ipcHandlers.js')).registerIpcHandlers();
const H = global.__handlers;
const S = require(path.join(dist, 'shiftService.js'));
ok('setup: the real shift:float and expense:create handlers are registered',
  typeof H['shift:float'] === 'function' && typeof H['expense:create'] === 'function');

console.log('\n0.6.37 — a manager approves pay outs and expenses (offline)\n');
signIn('u-tom', 'Tom', 'cashier', '{"orders.create":true}');
S.openShift(1000);
const shiftId = S.currentShiftReport().shift.id;

const e1 = await rejects(H['shift:float']({}, { type: 'float_out', amount: 200, reason: 'Change run' }));
ok('a cashier\'s pay out with no PIN is refused', e1 && /manager must approve/i.test(e1.message), e1?.message);
const e2 = await rejects(H['shift:float']({}, { type: 'float_out', amount: 200, reason: 'Change run', pin: '1111' }));
ok('a cashier\'s own PIN does not approve', e2 && /not recognised/i.test(e2.message), e2?.message);
await H['shift:float']({}, { type: 'float_out', amount: 200, reason: 'Change run', pin: '4321' });
const f = db.prepare(`SELECT approved_by, approved_by_name FROM float_transactions WHERE type='float_out' AND shift_id=?`).get(shiftId);
ok('the manager\'s PIN approves it, offline — and the approver is kept on the row', f?.approved_by === 'u-mary' && f.approved_by_name === 'Mary', JSON.stringify(f));
await H['shift:float']({}, { type: 'float_in', amount: 500, reason: 'Top-up' });
ok('a pay in needs nobody', db.prepare(`SELECT approved_by FROM float_transactions WHERE type='float_in'`).get()?.approved_by === null);

const e3 = await rejects(H['expense:create']({}, { description: 'Gas', amount: 300 }));
ok('a cashier\'s expense with no PIN is refused (nothing saved)', e3 && /manager must approve/i.test(e3.message)
  && db.prepare(`SELECT COUNT(*) AS n FROM expenses`).get().n === 0, e3?.message);
const saved = await H['expense:create']({}, { description: 'Gas', amount: 300, pin: '4321' });
const ex = db.prepare(`SELECT approved_by, approved_by_name FROM expenses WHERE id=?`).get(saved.id);
ok('the manager\'s PIN approves the expense; the screen is told who', ex?.approved_by === 'u-mary' && saved.approvedBy === 'Mary', JSON.stringify({ ex, saved }));

signIn('u-mary', 'Mary', 'manager', '{"orders.void":true}');
await H['shift:float']({}, { type: 'float_out', amount: 100, reason: 'Ice' });
await H['expense:create']({}, { description: 'Water', amount: 80 });
ok('a manager signed in approves as themselves — no PIN',
  db.prepare(`SELECT approved_by FROM float_transactions WHERE reason='Ice'`).get()?.approved_by === 'u-mary'
  && db.prepare(`SELECT approved_by FROM expenses WHERE description='Water'`).get()?.approved_by === 'u-mary');

const z = S.computeZReport(shiftId);
ok('the Z-report lists the pay outs and who approved each',
  JSON.stringify(z.payoutLines.map((p) => p.label)) === '["Change run · approved Mary","Ice · approved Mary"]', JSON.stringify(z.payoutLines));
ok('the Z-report says who approved each expense', z.expenseLines.every((e) => / · approved Mary$/.test(e.label)), JSON.stringify(z.expenseLines.map((e) => e.label)));
ok('the cash still adds up (1000 + 500 − 200 − 100 − 300 − 80 = 820)', z.totals.expectedCash === 820, String(z.totals.expectedCash));
ok('an expense recorded before 0.6.37 (no approver) prints as before', S.approvedSuffix(null) === '' && S.approvedSuffix('Mary') === ' · approved Mary');

const src = fs.readFileSync(path.join(here, '..', 'src', 'main', 'syncEngine.ts'), 'utf8');
ok('the push carries the approver (floats and expenses)',
  (src.match(/approved_by, approved_by_name/g) ?? []).length >= 2);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
