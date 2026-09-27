// Cross-sync stage 1 (2026-09-27) — the web POS's sales on THIS till's drawer are downloaded and held on the till.
// Owner: "what i sell on the web using the same till should appear on the till".
//
// Drives the REAL compiled dist/main/webSales.js (+ localDb, shiftService, nodeIngest) on a REAL SQLite file,
// electron shimmed as in shared-drawer.test.mjs. The cloud call (POST /api/shifts/:id/foreign-orders) is not made
// here — its answer is passed to applyWebOrders, which is exactly the seam syncEngine.pullWebSales uses.
//
//   cd apps/desktop && npx tsc -b tsconfig.main.json && node test/web-sales.test.mjs
//
// MUTATIONS TO CONFIRM BITE:
//   - applyWebOrders writes sync_status 'pending' (or queues the sale)   → "never pushed back" fails
//   - fillNodeOutbox loses the origin exclusion                          → "never offered to the branch node" fails
//   - ownOrderIds stops excluding downloaded sales                       → "the till's own = what it rang" fails
//   - the "never overwrite the till's own sale" guard dropped            → "a sale this till rang is never touched" fails
//   - the ON CONFLICT update drops status                                → "a void on the web reaches the till" fails
//   - pending payments stored                                            → "only money the close counts" fails
//   - computeZReport's webSales counts voided sales                      → "a voided web sale is no longer reported" fails
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'main');
const require = createRequire(import.meta.url);

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'swiftpos-websales-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `module.exports = { app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '0.0.0' }, ipcMain: { handle() {} }, BrowserWindow: class {}, safeStorage: { isEncryptionAvailable: () => false }, net: { isOnline: () => false } };`);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) {
  if (req === 'electron') return shim;
  return orig.call(this, req, parent, ...rest);
};

const L = require(path.join(dist, 'localDb.js'));
const S = require(path.join(dist, 'shiftService.js'));
const W = require(path.join(dist, 'webSales.js'));
const N = require(path.join(dist, 'nodeIngest.js'));
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };

const db = L.getLocalDb();
db.prepare(`INSERT INTO session (id, token, user_id, business_id, business_name, logged_in_at) VALUES (1, 't', 'u-owner', 'biz-1', 'Your Business', '2026-09-27T00:00:00Z')`).run();
require(path.join(dist, 'deviceConfig.js')).saveDeviceConfig({ deploy_mode: 'cloud', server_url: 'http://x', branch_id: 'br-1',
  device_id: 'dev-T1', device_role: 'till', terminal_code: 'T1', device_name: 'Front Counter' });
db.prepare(`INSERT INTO staff_session (id, staff_id, staff_name, role_name, branch_id, token, logged_in_at) VALUES (1, 'u-tom', 'Tom', 'cashier', 'br-1', 'tok', '2026-09-27T09:30:00Z')`).run();

console.log('Cross-sync stage 1 — web sales on this till\'s drawer\n');
const cols = db.prepare(`PRAGMA table_info(orders)`).all().map((c) => c.name);
ok('local schema 55 or later: orders.origin exists', L.LOCAL_SCHEMA_VERSION >= 55 && cols.includes('origin'), String(L.LOCAL_SCHEMA_VERSION));

// The drawer (opened on the web as this till and joined — A334), float 1000.
const shift = S.adoptCloudShift({ id: 'sh-1', status: 'open', device_id: 'dev-T1', branch_id: 'br-1', cashier_id: 'u-jane',
  opened_by: 'u-jane', opened_at: '2026-09-27T09:00:00Z', opening_float: 1000, terminal_code: 'T1' });
ok('setup: the shared drawer is open on this till', shift?.id === 'sh-1');
// Another till's drawer, also held here (a node, say) — never asked about by THIS till.
db.prepare(`INSERT INTO shifts (id, business_id, branch_id, cashier_id, opened_at, status, opening_float, created_at, device_id)
            VALUES ('sh-T2', 'biz-1', 'br-1', 'u-sam', '2026-09-27T09:00:00Z', 'open', 0, '2026-09-27T09:00:00Z', 'dev-T2')`).run();

// This till's own sale: 400 cash, not yet pushed.
db.prepare(`INSERT INTO orders (id, business_id, branch_id, order_number, status, subtotal, vat_amount, total, shift_id, created_at, sync_status, device_id)
            VALUES ('o-till-1', 'biz-1', 'br-1', 'T1-1', 'completed', 400, 0, 400, 'sh-1', '2026-09-27T10:00:00Z', 'pending', 'dev-T1')`).run();
db.prepare(`INSERT INTO payments (id, order_id, method, amount, amount_tendered, created_at) VALUES ('p-till-1', 'o-till-1', 'cash', 400, 400, '2026-09-27T10:00:00Z')`).run();

ok('the drawers this till asks about: its own open one only', JSON.stringify(W.webSaleShifts().map((s) => s.id)) === '["sh-1"]',
  JSON.stringify(W.webSaleShifts()));

// The cloud's answer: one web sale, 700 (500 cash + 200 M-Pesa), plus an M-Pesa push still pending.
const web = {
  id: 'c-web-1', order_number: 'W-17', order_type: 'retail', status: 'completed', subtotal: 700, vat_amount: 0, total: 700,
  idempotency_key: 'web-key-17', cashier_id: 'u-jane', shift_id: 'sh-1', branch_id: 'br-1', created_at: '2026-09-27T10:05:00Z',
  refunded_amount: 0,
  order_items: [
    { id: 'i-1', product_id: 'p-tea', product_name: 'Tea', unit_price: 200, quantity: 2, subtotal: 400 },
    { id: 'i-2', product_id: null, product_name: 'Open item', unit_price: 300, quantity: 1, subtotal: 300 },
  ],
  payments: [
    { id: 'wp-1', method: 'cash', amount: 500, amount_tendered: 1000, change_given: 500, status: 'completed', created_at: '2026-09-27T10:05:00Z' },
    { id: 'wp-2', method: 'mpesa', amount: 200, status: 'completed', created_at: '2026-09-27T10:05:00Z' },
    { id: 'wp-3', method: 'mpesa', amount: 999, status: 'pending', created_at: '2026-09-27T10:05:00Z' },
  ],
};
const shiftRow = W.webSaleShifts()[0];
ok('a new web sale is stored (1 changed)', W.applyWebOrders(shiftRow, [web]) === 1);
const row = db.prepare(`SELECT * FROM orders WHERE id='c-web-1'`).get();
ok('…under the CLOUD id, marked web, synced, on this till and drawer',
  row && row.origin === 'web' && row.sync_status === 'synced' && row.device_id === 'dev-T1' && row.shift_id === 'sh-1' && row.order_number === 'W-17',
  JSON.stringify(row));
ok('…with its lines (a line with no product keeps its name)',
  db.prepare(`SELECT COUNT(*) c FROM order_items WHERE order_id='c-web-1'`).get().c === 2
  && db.prepare(`SELECT product_name FROM order_items WHERE id='i-2'`).get().product_name === 'Open item');
ok('only money the close counts: completed payments stored, the pending push is not',
  JSON.stringify(db.prepare(`SELECT id FROM payments WHERE order_id='c-web-1' ORDER BY id`).all().map((p) => p.id)) === '["wp-1","wp-2"]');
ok('never pushed back: nothing in sync_queue', db.prepare(`SELECT COUNT(*) c FROM sync_queue`).get().c === 0);
ok('…and it never holds up the close: only the till\'s own unsynced sale blocks reconcile',
  db.prepare(`SELECT COUNT(*) AS count FROM orders WHERE shift_id='sh-1' AND sync_status!='synced'`).get().count === 1);

ok('the till\'s own = what it rang (sent as own_ids)', JSON.stringify(W.ownOrderIds('sh-1')) === '["o-till-1"]', JSON.stringify(W.ownOrderIds('sh-1')));
ok('what it HOLDS includes the web sale (sent to foreign-cash, so the cloud never counts it again)',
  S.localShiftIds('sh-1').order_ids.includes('c-web-1'));

const z = S.computeZReport('sh-1', { orders: 0, cash_sales: 0, float_in: 0, float_out: 0, expenses: 0 });
ok('the shift shows it: 2 orders, 1,100 gross', z.totals.orderCount === 2 && z.totals.grossSales === 1100, JSON.stringify(z.totals));
ok('expected cash counts the web cash once: 1000 + 400 + 500 = 1900', z.totals.expectedCash === 1900, String(z.totals.expectedCash));
ok('the panel can still say what the web rang: webSales = 1 sale, 500 cash (already inside the totals)',
  z.totals.webSales?.orders === 1 && z.totals.webSales?.cash_sales === 500, JSON.stringify(z.totals.webSales));
ok('M-Pesa in the method split', z.byMethod.find((m) => m.method === 'mpesa')?.amount === 200, JSON.stringify(z.byMethod));

ok('pulling again changes nothing (idempotent)', W.applyWebOrders(shiftRow, [web]) === 0
  && db.prepare(`SELECT COUNT(*) c FROM payments WHERE order_id='c-web-1'`).get().c === 2);

ok('a sale this till rang is never touched, even if the cloud sent it',
  W.applyWebOrders(shiftRow, [{ ...web, id: 'o-till-1', status: 'voided', payments: [], order_items: [] }]) === 0
  && db.prepare(`SELECT status FROM orders WHERE id='o-till-1'`).get().status === 'completed'
  && db.prepare(`SELECT COUNT(*) c FROM payments WHERE order_id='o-till-1'`).get().c === 1);

// A void on the web reaches the till.
W.applyWebOrders(shiftRow, [{ ...web, status: 'voided', void_reason: 'wrong item', voided_at: '2026-09-27T10:10:00Z' }]);
const zv = S.computeZReport('sh-1');
ok('a void on the web reaches the till: status voided, expected back to 1400',
  db.prepare(`SELECT status FROM orders WHERE id='c-web-1'`).get().status === 'voided' && zv.totals.expectedCash === 1400,
  String(zv.totals.expectedCash));
ok('…and a voided web sale is no longer reported as the web\'s', zv.totals.webSales?.orders === 0, JSON.stringify(zv.totals.webSales));

// A refund on the web: the sale stays completed, the negative cash row comes with it.
const refunded = { ...web, id: 'c-web-2', idempotency_key: 'web-key-18', order_number: 'W-18', refunded_amount: 500,
  refunded_at: '2026-09-27T10:20:00Z', refund_reason: 'returned',
  order_items: [], payments: [{ ...web.payments[0], id: 'wp2-1' }, { id: 'wp-r', method: 'cash', amount: -500, status: 'refunded', created_at: '2026-09-27T10:20:00Z' }] };
W.applyWebOrders(shiftRow, [{ ...refunded, refunded_amount: 0, refunded_at: null, payments: [{ ...web.payments[0], id: 'wp2-1' }] }]);
ok('before the refund: 1400 + 500 = 1900', S.computeZReport('sh-1').totals.expectedCash === 1900);
ok('a refund on the web reaches the till (1 changed): the cash goes back out → 1400',
  W.applyWebOrders(shiftRow, [refunded]) === 1 && S.computeZReport('sh-1').totals.expectedCash === 1400,
  String(S.computeZReport('sh-1').totals.expectedCash));

// The branch node is fed by the till that RANG a sale.
N.fillNodeOutbox();
const offered = db.prepare(`SELECT row_id FROM node_queue WHERE table_name='orders'`).all().map((r) => r.row_id);
ok('never offered to the branch node: the till\'s own sale is, the web\'s are not',
  offered.includes('o-till-1') && !offered.includes('c-web-1') && !offered.includes('c-web-2'), JSON.stringify(offered));
ok('…and never numbered for it', db.prepare(`SELECT seq FROM orders WHERE id='c-web-1'`).get().seq === null);

// The manager's branch view (read from the cloud).
const b = W.cloudBranchOrders([
  { id: 'x1', order_number: 'T1-9', status: 'completed', total: '250.00', created_at: '2026-09-27T11:00:00Z', device_id: 'dev-T1',
    payments: [{ method: 'cash', amount: '250', status: 'completed' }, { method: 'mpesa', amount: '99', status: 'pending' }] },
  { id: 'x2', order_number: 'T2-4', status: 'completed', total: 80, created_at: '2026-09-27T11:01:00Z', device_id: 'dev-T2', payments: [] },
], 'dev-T1');
ok('branch view: this till\'s sales are marked, other tills\' are not', b[0].this_till === true && b[1].this_till === false);
ok('branch view: money as the close counts it (no pending), numbers not strings',
  b[0].total === 250 && JSON.stringify(b[0].payments) === '[{"method":"cash","amount":250}]');

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
