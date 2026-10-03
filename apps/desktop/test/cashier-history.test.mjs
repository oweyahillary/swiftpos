// 0.6.37 (A387) — a cashier's History shows only the payment methods the manager chose; a cashier never reprints.
// Owner, 2026-10-03: "the manager selects what the cashier sees" — "based on payment method" — "They can only see
// allowed method eg mpesa, cash, card but never reprints a receipt".
//
// Drives the REAL compiled dist/main (localDb, deviceConfig, referenceBundle, syncEngine.createLocalOrder,
// shiftService.historyScope, managerReports.getRecentOrders, cashierHistory) on a REAL SQLite file.
//
//   cd apps/desktop && npx tsc -p tsconfig.main.json && node test/cashier-history.test.mjs
//
// MUTATIONS TO CONFIRM BITE:
//   - historyScope gives a cashier methods [] (every)              → "a cashier's scope carries the manager's methods" fails
//   - historyScope lets a cashier reprint                           → "a cashier never reprints" fails
//   - setCashierHistoryMethods stores an invalid list               → "a bad list is ignored" fails
//   - unpackNodeBundle drops cashierHistoryMethods                   → "a peer takes the node's list" fails
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'main');
const require = createRequire(import.meta.url);
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'swiftpos-0637-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `module.exports = { app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '0.0.0' }, ipcMain: { handle() {} }, BrowserWindow: class { static getAllWindows() { return []; } }, dialog: {}, safeStorage: { isEncryptionAvailable: () => false }, net: { isOnline: () => false } };`);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) { return req === 'electron' ? shim : orig.call(this, req, parent, ...rest); };

const L = require(path.join(dist, 'localDb.js'));
const C = require(path.join(dist, 'deviceConfig.js'));
const R = require(path.join(dist, 'referenceBundle.js'));
const E = require(path.join(dist, 'syncEngine.js'));
const S = require(path.join(dist, 'shiftService.js'));
const M = require(path.join(dist, 'managerReports.js'));
const H = require(path.join(dist, 'cashierHistory.js'));
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };

const db = L.getLocalDb();
db.prepare(`INSERT INTO session (id, token, user_id, business_id, business_name, logged_in_at) VALUES (1, 't', 'u-owner', 'biz-1', 'B', '2026-10-03T00:00:00Z')`).run();
C.saveDeviceConfig({ deploy_mode: 'cloud', server_url: 'http://cloud', branch_id: 'br-1', device_id: 'dev-T1', device_role: 'till', terminal_code: 'T1', device_name: 'Front' });
db.prepare(`INSERT INTO users (id, name) VALUES ('u-amy', 'Amy'), ('u-mgr', 'Mary')`).run();
const signIn = (id, name, role) => db.prepare(`INSERT OR REPLACE INTO staff_session (id, staff_id, staff_name, role_name, permissions, branch_id, token, logged_in_at)
  VALUES (1, ?, ?, ?, '{}', 'br-1', 'tok', '2026-10-03T06:00:00Z')`).run(id, name, role);
db.prepare(`INSERT INTO products (id, name, base_price, status) VALUES ('p-chk', 'Chicken', 1000, 'active')`).run();

console.log('0.6.37 — what a cashier sees in History\n');

ok('schema 66 adds device_config.cashier_history_methods', L.LOCAL_SCHEMA_VERSION >= 66
  && db.prepare(`PRAGMA table_info(device_config)`).all().some((c) => c.name === 'cashier_history_methods'));
ok('never told → every method', C.getCashierHistoryMethods().length === 0);

C.setCashierHistoryMethods(['MPESA']);
ok('the pull stores the list (lower-case)', JSON.stringify(C.getCashierHistoryMethods()) === '["mpesa"]');
C.setCashierHistoryMethods(undefined);
ok('an older cloud (nothing said) keeps it', JSON.stringify(C.getCashierHistoryMethods()) === '["mpesa"]');
C.setCashierHistoryMethods(['m pesa']);
ok('a bad list is ignored', JSON.stringify(C.getCashierHistoryMethods()) === '["mpesa"]');
C.saveDeviceConfig({ device_name: 'Front 2', cashier_history_methods: '[]' });
ok('config:save never changes it (only the pull and a manager\'s change do)', JSON.stringify(C.getCashierHistoryMethods()) === '["mpesa"]');
ok('a peer takes the node\'s list (bundle unpacked); an older node says nothing',
  JSON.stringify(R.unpackNodeBundle({ posInit: { cashierHistoryMethods: ['cash'] } }).config.cashierHistoryMethods) === '["cash"]'
  && R.unpackNodeBundle({ posInit: {} }).config.cashierHistoryMethods === undefined);

// ── Three sales: cash, M-Pesa, and a cash + M-Pesa split ──
signIn('u-amy', 'Amy', 'cashier');
S.openShift(1000);
const sale = (n, payments) => E.createLocalOrder({
  branch_id: 'br-1', order_number: n, order_type: 'takeaway', subtotal: 1000, vat_amount: 0, total: 1000,
  items: [{ product: { id: 'p-chk', name: 'Chicken' }, unitPrice: 1000, quantity: 1, lineTotal: 1000 }], payments,
});
sale('T1-1', [{ method: 'cash', amount: 1000 }]);
sale('T1-2', [{ method: 'mpesa', amount: 1000 }]);
sale('T1-3', [{ method: 'cash', amount: 400 }, { method: 'mpesa', amount: 600 }]);

const scope = S.historyScope();
ok('a cashier\'s scope carries the manager\'s methods', JSON.stringify(scope.methods) === '["mpesa"]', JSON.stringify(scope));
ok('a cashier never reprints', scope.canReprint === false);
// The pos:history handler: getRecentOrders, then cashierHistoryView with the scope's methods.
const view = H.cashierHistoryView(M.getRecentOrders(0), scope.methods);
ok('…History shows the M-Pesa sale and the split, not the cash sale',
  JSON.stringify(view.map((o) => o.order_number).sort()) === '["T1-2","T1-3"]', JSON.stringify(view.map((o) => o.order_number)));
const split = view.find((o) => o.order_number === 'T1-3');
ok('…the split shows only its M-Pesa part (600), never the bill',
  split?.history_partial === true && split.history_shown_total === 600 && split.payments.length === 1, JSON.stringify(split));

signIn('u-mgr', 'Mary', 'manager');
const ms = S.historyScope();
ok('a manager sees every method and may reprint', ms.methods.length === 0 && ms.canReprint === true);
ok('…every sale, whole', H.cashierHistoryView(M.getRecentOrders(0), ms.methods).length === 3);

C.setCashierHistoryMethods([]);
signIn('u-amy', 'Amy', 'cashier');
ok('the manager ticks every method → a cashier sees every sale, and still never reprints',
  S.historyScope().methods.length === 0 && !S.historyScope().canReprint
  && H.cashierHistoryView(M.getRecentOrders(0), S.historyScope().methods).length === 3);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
