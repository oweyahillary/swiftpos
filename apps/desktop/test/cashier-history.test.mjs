// A387 / A627 — which payment methods a cashier sees in History is a per-person RIGHT (sales.history_all_payments):
// with it (or as a manager) every method; without it, cash only (a split sale shows only its cash part). A cashier never
// reprints. The old 'cashier_history_methods' business/branch/till setting is gone (it is the right now).
//
// Drives the REAL compiled dist/main (localDb, syncEngine.createLocalOrder, shiftService.historyScope,
// managerReports.getRecentOrders, cashierHistory) on a REAL SQLite file.
//
//   cd apps/desktop && npx tsc -p tsconfig.main.json && node test/cashier-history.test.mjs
//
// MUTATIONS TO CONFIRM BITE:
//   - historyScope gives a cashier without the right [] (every method) → "a cashier without the right sees cash only" fails
//   - historyScope lets a cashier reprint                              → "a cashier never reprints" fails
//   - historyScope ignores the sales.history_all_payments right         → "a cashier WITH the right sees every method" fails
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
const E = require(path.join(dist, 'syncEngine.js'));
const S = require(path.join(dist, 'shiftService.js'));
const M = require(path.join(dist, 'managerReports.js'));
const H = require('@zaptill/core/cashierHistory');
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };

const db = L.getLocalDb();
db.prepare(`INSERT INTO session (id, token, user_id, business_id, business_name, logged_in_at) VALUES (1, 't', 'u-owner', 'biz-1', 'B', '2026-10-03T00:00:00Z')`).run();
C.saveDeviceConfig({ deploy_mode: 'cloud', server_url: 'http://cloud', branch_id: 'br-1', device_id: 'dev-T1', device_role: 'till', terminal_code: 'T1', device_name: 'Front' });
db.prepare(`INSERT INTO users (id, name) VALUES ('u-amy', 'Amy'), ('u-mgr', 'Mary')`).run();
// A490: a role's NAME decides nothing on the till — a manager is the permissions an older cloud sent a manager. A627:
// 'allpay' is a cashier holding sales.history_all_payments (and nothing else).
const PERMS = { manager: '{"orders.void":true,"settings.manage":true}', allpay: '{"sales.history_all_payments":true}' };
const signIn = (id, name, role) => db.prepare(`INSERT OR REPLACE INTO staff_session (id, staff_id, staff_name, role_name, permissions, branch_id, token, logged_in_at)
  VALUES (1, ?, ?, ?, ?, 'br-1', 'tok', '2026-10-03T06:00:00Z')`).run(id, name, role, PERMS[role] ?? '{}');
db.prepare(`INSERT INTO products (id, name, base_price, status) VALUES ('p-chk', 'Chicken', 1000, 'active')`).run();

console.log('A387 / A627 — which payments a cashier sees in History (the right)\n');

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

// A cashier WITHOUT sales.history_all_payments → cash only.
const scope = S.historyScope();
ok('a cashier without the right sees cash only', JSON.stringify(scope.methods) === '["cash"]', JSON.stringify(scope));
ok('a cashier never reprints', scope.canReprint === false);
// The pos:history handler: getRecentOrders, then cashierHistoryView with the scope's methods.
const view = H.cashierHistoryView(M.getRecentOrders(0), scope.methods);
ok('…History shows the cash sale and the split, not the M-Pesa sale',
  JSON.stringify(view.map((o) => o.order_number).sort()) === '["T1-1","T1-3"]', JSON.stringify(view.map((o) => o.order_number)));
const split = view.find((o) => o.order_number === 'T1-3');
ok('…the split shows only its cash part (400), never the bill',
  split?.history_partial === true && split.history_shown_total === 400 && split.payments.length === 1, JSON.stringify(split));

// The SAME cashier, now holding sales.history_all_payments → every method, still no reprint.
signIn('u-amy', 'Amy', 'allpay');
const ap = S.historyScope();
ok('a cashier WITH the right sees every method, and still never reprints',
  ap.methods.length === 0 && ap.canReprint === false
  && H.cashierHistoryView(M.getRecentOrders(0), ap.methods).length === 3, JSON.stringify(ap));

// A manager → every method, whole, and may reprint.
signIn('u-mgr', 'Mary', 'manager');
const ms = S.historyScope();
ok('a manager sees every method and may reprint', ms.methods.length === 0 && ms.canReprint === true, JSON.stringify(ms));
ok('…every sale, whole', H.cashierHistoryView(M.getRecentOrders(0), ms.methods).length === 3);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
