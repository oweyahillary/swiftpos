// A594 — cash in / cash out on the desktop POS: off for cashiers by default, a manager approves on the spot, every one
// gives a reason, and a cash in that looks like a drawer count is asked again.
// Owner, 2026-10-26 (a cashier typed the day's drawer counts into Cash in — twice, no reason, nobody approving — and the
// expected cash rose by both): "we need to turn off that option for cashiers by default unless allowed".
//
// Drives the REAL compiled IPC handlers (dist/main) on a REAL SQLite file, electron shimmed, NO network: the cashier's and
// the manager's credentials cached the way an online sign-in does (real pinCache, real bcrypt). The machine is a branch
// server, so the same run also drives the remote path (branchClose:shiftMoney, A465) on its own drawer.
//
//   cd apps/desktop && npx tsc -b tsconfig.main.json && node test/cash-movements-a594.test.mjs
//
// MUTATIONS TO CONFIRM BITE:
//   - shift:float without the reason check                        → "a cash in with no reason is refused" fails
//   - cashMovementNeedsApprover answering type === 'float_out'   → "a cashier without Record cash in needs a manager" fails
//   - shift:float without the looksLikeDrawerCount check          → "a cash in of the expected cash is asked again" fails
//   - looksLikeDrawerCount without the ± 1 tolerance              → "… within 1 shilling" fails
//   - branchClose:shiftMoney without the reason / count checks    → the remote cases fail
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'main');
const require = createRequire(import.meta.url);
const read = (p) => fs.readFileSync(path.join(here, '..', p), 'utf8').replace(/\r\n/g, '\n');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-a594-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `
  const handlers = (global.__handlers = {});
  module.exports = {
    app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '1.0.22', on() {}, isPackaged: false },
    ipcMain: { handle(ch, fn) { handlers[ch] = fn; }, on() {}, removeHandler() {} },
    BrowserWindow: class { static getAllWindows() { return []; } static getFocusedWindow() { return null; } },
    dialog: {}, shell: {}, screen: {}, Menu: {}, powerMonitor: { on() {}, getSystemIdleTime: () => 0 },
    safeStorage: { isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from('w:' + s), decryptString: (b) => Buffer.from(b).toString().slice(2) },
    net: { isOnline: () => false },
  };`);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) { return orig.call(this, req === 'electron' ? shim : req, parent, ...rest); };
globalThis.fetch = async () => { throw new TypeError('fetch failed'); };   // offline

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };
const said = async (fn) => { try { await fn(); return ''; } catch (e) { return String(e?.message ?? e); } };

const L = require(path.join(dist, 'localDb.js'));
const db = L.getLocalDb();
db.prepare(`INSERT INTO session (id, token, user_id, business_id, business_name, logged_in_at) VALUES (1, 't', 'u-owner', 'biz-1', 'Sample Shop', '2026-10-26T00:00:00Z')`).run();
require(path.join(dist, 'deviceConfig.js')).saveDeviceConfig({ deploy_mode: 'cloud', server_url: 'http://cloud', branch_id: 'br-1',
  device_id: 'dev-S', device_role: 'node', terminal_code: 'T1', device_name: 'Front Counter' });
db.prepare(`INSERT INTO users (id, name) VALUES ('u-mary', 'Mary'), ('u-tom', 'Tom'), ('u-ivy', 'Ivy')`).run();

// The catalogue maps the cloud sends from A490 on (MAP_MARKER): a cashier WITHOUT Record cash in (A594's default), one
// given it (Ivy — per person in Staff), and a manager (approves drawers, holds the three rights).
const MARK = '"catalogue.v2":true';
const CASHIER = `{"orders.create":true,${MARK}}`;
const CASHIER_ALLOWED = `{"orders.create":true,"shifts.cash_movements":true,${MARK}}`;
const MANAGER = `{"orders.create":true,"shifts.confirm":true,"shifts.cash_movements":true,"shifts.cash_out":true,"expenses.record":true,${MARK}}`;
const bcrypt = require('bcryptjs');
const P = require(path.join(dist, 'pinCache.js'));
P.cacheStaffCredential({ staffId: 'u-mary', name: 'Mary', roleName: 'manager', permissions: JSON.parse(MANAGER) }, bcrypt.hashSync('4321', 4), 'br-1');
P.cacheStaffCredential({ staffId: 'u-tom', name: 'Tom', roleName: 'cashier', permissions: JSON.parse(CASHIER) }, bcrypt.hashSync('1111', 4), 'br-1');
const signIn = (id, name, role, perms) => db.prepare(`INSERT OR REPLACE INTO staff_session (id, staff_id, staff_name, role_name, permissions, branch_id, token, logged_in_at)
  VALUES (1, ?, ?, ?, ?, 'br-1', 'tok', '2026-10-26T06:00:00Z')`).run(id, name, role, perms);
const sale = (() => { let n = 0; return (shiftId, amount) => {
  const id = `o${++n}`;
  db.prepare(`INSERT INTO orders (id, business_id, branch_id, order_number, status, subtotal, vat_amount, total, shift_id, created_at, sync_status, device_id)
              VALUES (?, 'biz-1', 'br-1', ?, 'completed', ?, 0, ?, ?, ?, 'synced', 'dev-S')`).run(id, id, amount, amount, shiftId, new Date().toISOString());
  db.prepare(`INSERT INTO payments (id, order_id, method, amount, amount_tendered, created_at) VALUES (?, ?, 'cash', ?, ?, ?)`)
    .run(`p-${id}`, id, amount, amount, new Date().toISOString());
}; })();

require(path.join(dist, 'ipcHandlers.js')).registerIpcHandlers();
const H = global.__handlers;
const S = require(path.join(dist, 'shiftService.js'));
const F = require(path.join(dist, 'posFeatures.js'));
const call = (ch, p) => H[ch]({}, p);
const floats = () => db.prepare(`SELECT type, amount, reason, approved_by, approved_by_name FROM float_transactions ORDER BY created_at, rowid`).all();
const expected = (id) => S.computeZReport(id).totals.expectedCash;

console.log('\nA594 — the rules (shared/posFeatures.ts)\n');
ok('a cash out always needs an approver; a cash in only for someone without Record cash in',
  F.cashMovementNeedsApprover('float_out', true) && F.cashMovementNeedsApprover('float_in', false) && !F.cashMovementNeedsApprover('float_in', true));
ok('a drawer count: the cash sales, the expected cash, or float + cash sales — within 1 shilling; nothing else',
  F.looksLikeDrawerCount(4450, { openingFloat: 1000, cashSales: 4450, expected: 9900 })
  && F.looksLikeDrawerCount(5450, { openingFloat: 1000, cashSales: 4450, expected: 9900 })
  && F.looksLikeDrawerCount(9899.5, { openingFloat: 1000, cashSales: 4450, expected: 9900 })
  && F.looksLikeDrawerCount(4451, { openingFloat: 1000, cashSales: 4450, expected: 9900 })
  && !F.looksLikeDrawerCount(4452, { openingFloat: 1000, cashSales: 4450, expected: 9900 })
  && !F.looksLikeDrawerCount(500, { openingFloat: 1000, cashSales: 4450, expected: 9900 })
  && !F.looksLikeDrawerCount(0, { openingFloat: 0, cashSales: 0, expected: 0 }));
ok('the confirmation names the amount and Close shift', F.cashInAddsText('KES 4,450.00') === 'This ADDS KES 4,450.00 to the cash expected in the drawer. To count the drawer, use Close shift.');

console.log('\nA cashier without Record cash in (the new default)\n');
signIn('u-tom', 'Tom', 'cashier', CASHIER);
const sh = S.openShift(1000);
sale(sh.id, 4450);
ok('to start: float 1,000 + cash sales 4,450', expected(sh.id) === 5450, String(expected(sh.id)));
ok('a cash in with no reason is refused (nothing written)', /reason/i.test(await said(() => call('shift:float', { type: 'float_in', amount: 200 }))) && floats().length === 0);
ok('a cashier without Record cash in needs a manager for a cash in (no PIN: refused, nothing written)',
  /manager must approve/i.test(await said(() => call('shift:float', { type: 'float_in', amount: 200, reason: 'Change from the bank' }))) && floats().length === 0);
ok('…their own PIN does not approve it', /not recognised/i.test(await said(() => call('shift:float', { type: 'float_in', amount: 200, reason: 'Change', pin: '1111' }))));
await call('shift:float', { type: 'float_in', amount: 200, reason: 'Change from the bank', pin: '4321' });
const f1 = floats()[0];
ok('a manager\'s PIN approves it on the spot — offline — and the approver is kept on the entry',
  f1?.type === 'float_in' && f1.approved_by === 'u-mary' && f1.approved_by_name === 'Mary' && f1.reason === 'Change from the bank', JSON.stringify(f1));
ok('a cash out still needs a manager (A388)', /manager must approve/i.test(await said(() => call('shift:float', { type: 'float_out', amount: 50, reason: 'Ice' }))));

console.log('\nThe drawer-count warning (the incident)\n');
// Expected now 5,650 (1,000 + 4,450 + 200). The cashier types the cash sales (4,450), then float + sales (5,450).
const before = floats().length;
const w1 = await said(() => call('shift:float', { type: 'float_in', amount: 4450, reason: 'cash', pin: '4321' }));
ok('a cash in of the shift\'s cash sales is asked again — nothing written', w1 === F.DRAWER_COUNT_WARNING && floats().length === before, w1);
const w2 = await said(() => call('shift:float', { type: 'float_in', amount: 5450, reason: 'cash', pin: '4321' }));
ok('…and of float + cash sales', w2 === F.DRAWER_COUNT_WARNING && floats().length === before, w2);
const w3 = await said(() => call('shift:float', { type: 'float_in', amount: 5650.5, reason: 'cash', pin: '4321' }));
ok('a cash in of the expected cash is asked again (within 1 shilling)', w3 === F.DRAWER_COUNT_WARNING, w3);
await call('shift:float', { type: 'float_in', amount: 4450, reason: 'Owner brought change', pin: '4321', countAck: true });
ok('confirmed a second time (countAck), it is recorded — approved', floats().length === before + 1 && floats().at(-1).approved_by === 'u-mary');
ok('a cash out is never asked (only a cash in can be a count typed in the wrong place)',
  !(await said(() => call('shift:float', { type: 'float_out', amount: 4450, reason: 'Banked', pin: '4321' }))).includes('drawer count'));

console.log('\nA cashier given Record cash in (per person / per role) and a manager — as before\n');
signIn('u-ivy', 'Ivy', 'cashier', CASHIER_ALLOWED);
await call('shift:float', { type: 'float_in', amount: 300, reason: 'Top-up' });
ok('given the right: a cash in needs nobody', floats().at(-1).reason === 'Top-up' && floats().at(-1).approved_by === null);
signIn('u-mary', 'Mary', 'manager', MANAGER);
await call('shift:float', { type: 'float_in', amount: 120, reason: 'Change' });
await call('shift:float', { type: 'float_out', amount: 80, reason: 'Gas' });
ok('a manager signed in: cash in with nobody approving, cash out approved as themselves — no PIN (unchanged)',
  floats().at(-2).approved_by === null && floats().at(-1).approved_by === 'u-mary');
ok('a manager still gives a reason', /reason/i.test(await said(() => call('shift:float', { type: 'float_out', amount: 10 }))));

console.log('\nExpenses — a manager approves, key or not\n');
signIn('u-tom', 'Tom', 'cashier', CASHIER);
ok('a cashier without Record expenses: no longer refused outright (A453) — a manager must approve',
  /manager must approve/i.test(await said(() => call('expense:create', { description: 'Gas', amount: 300 }))));
const ex = await call('expense:create', { description: 'Gas', amount: 300, pin: '4321' });
ok('…with the manager\'s PIN it is recorded, approved', ex?.approvedBy === 'Mary');

console.log('\nThe branch server\'s remote path (branchClose:shiftMoney, A465)\n');
signIn('u-mary', 'Mary', 'manager', MANAGER);
const r0 = await call('branchClose:shiftMoney', { device_id: 'dev-S', shift_id: sh.id, kind: 'float_in', amount: 50 });
ok('a cash in with no reason is refused', r0.ok === false && /reason/i.test(r0.error), JSON.stringify(r0));
const exp = expected(sh.id);
const r1 = await call('branchClose:shiftMoney', { device_id: 'dev-S', shift_id: sh.id, kind: 'float_in', amount: exp, reason: 'cash' });
ok('a cash in of the drawer\'s expected cash comes back with the warning\'s code — nothing written', r1.ok === false && r1.code === F.DRAWER_COUNT_CODE && expected(sh.id) === exp, JSON.stringify(r1));
const r2 = await call('branchClose:shiftMoney', { device_id: 'dev-S', shift_id: sh.id, kind: 'float_in', amount: exp, reason: 'Float top-up', count_ack: true });
ok('confirmed (count_ack), it is recorded with the manager as approver', r2.ok === true && floats().at(-1).approved_by === 'u-mary', JSON.stringify(r2));
signIn('u-tom', 'Tom', 'cashier', CASHIER);
const r3 = await call('branchClose:shiftMoney', { device_id: 'dev-S', shift_id: sh.id, kind: 'float_in', amount: 20, reason: 'x' });
ok('a cashier cannot use it (only a manager who approves, signed in here)', r3.ok === false, JSON.stringify(r3));

console.log('\nThe screens\n');
const sp = read('src/renderer/pages/ShiftPanel.tsx');
ok('the shift screen confirms a cash in ("This ADDS …"), then asks again on the drawer-count warning, then sends countAck',
  /setFloatStep\('adds'\)/.test(sp) && /msg\.includes\(DRAWER_COUNT_WARNING\)\) \{ setFloatStep\('count'\)/.test(sp) && /sendFloat\(true\)/.test(sp)
  && /data-testid="cash-in-adds"/.test(sp) && /data-testid="cash-in-count-warning"/.test(sp));
ok('…asks the manager\'s PIN for a cash in by someone without the right, and requires the reason',
  /const floatNeedsPin = cashMovementNeedsApprover\(floatType, mayCashIn\) && !isManager;/.test(sp) && /setError\(CASH_MOVEMENT_REASON_REQUIRED\)/.test(sp));
const bc = read('src/renderer/pages/BranchCloseTab.tsx');
ok('Close Branch\'s cash in / out: the reason, the confirmation and count_ack', /setError\(CASH_MOVEMENT_REASON_REQUIRED\)/.test(bc)
  && /r\.code === DRAWER_COUNT_CODE\) \{ setStep\('count'\)/.test(bc) && /count_ack: true/.test(bc));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
