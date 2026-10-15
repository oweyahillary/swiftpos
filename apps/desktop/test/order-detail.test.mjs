// A444 — a manager sees the items inside an order, reprints it and voids / refunds it, on the till and the web.
// Owner, 2026-10-11: "manager should be able to do a receipt reprint · void / refund an order · view items inside an
// order — build on both online and desktop app". No screen showed an order's items; the till's Manager › Orders was
// read-only; reprint worked only for a sale with a receipt stored on that same till.
//
// Registers the REAL compiled IPC handlers (dist/main/ipcHandlers.js) on a REAL SQLite file, electron shimmed, a
// stand-in cloud for another till's order; the pure shared module; and the screens' wiring, read from source.
//
//   cd apps/desktop && npx tsc -p tsconfig.main.json && node test/order-detail.test.mjs
//
// MUTATIONS TO CONFIRM BITE:
//   - localOrderDetail drops the modifiers query                   → "sizes, extras and notes on each line" fails
//   - order:detail skips the own-only check for a cashier          → "a cashier cannot open another's sale" fails
//   - order:detail returns every payment to a method-limited cashier → "only the methods their History shows" fails
//   - readOrderDetail never asks the cloud                          → "another till's order is read from the cloud" fails
//   - the reprint goes back to "No stored receipt" only             → "a sale with no stored receipt is reprinted" fails
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..', '..');
const dist = path.join(here, '..', 'dist', 'main');
const require = createRequire(import.meta.url);
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-a444-'));
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
    net: { isOnline: () => true },
  };`);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) { return orig.call(this, req === 'electron' ? shim : req, parent, ...rest); };

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };

const L = require(path.join(dist, 'localDb.js'));
const db = L.getLocalDb();
db.prepare(`INSERT INTO session (id, token, user_id, business_id, business_name, logged_in_at) VALUES (1, 'owner-tok', 'u-owner', 'biz-1', 'Your Business', '2026-10-11T00:00:00Z')`).run();
const C = require(path.join(dist, 'deviceConfig.js'));
C.saveDeviceConfig({ deploy_mode: 'cloud', server_url: 'http://cloud', branch_id: 'br-1', device_id: 'dev-T1', device_role: 'till', terminal_code: 'T1', device_name: 'Front' });
db.prepare(`INSERT INTO users (id, name) VALUES ('u-amy', 'Amy'), ('u-brian', 'Brian'), ('u-mary', 'Mary')`).run();
// A490: a role's NAME decides nothing on the till — a manager is the permissions an older cloud sent a manager.
const A490_MANAGER = '{"orders.void":true,"settings.manage":true}';
const signIn = (id, name, role, perms = ['manager', 'supervisor'].includes(role) ? A490_MANAGER : '{}') => db.prepare(`INSERT OR REPLACE INTO staff_session (id, staff_id, staff_name, role_name, permissions, branch_id, token, logged_in_at)
  VALUES (1, ?, ?, ?, ?, 'br-1', 'tok', '2026-10-11T06:00:00Z')`).run(id, name, role, perms);

// Amy's sale: a large burger with cheese and a note, and two sodas; paid 500 cash + 450 M-Pesa.
db.prepare(`INSERT INTO orders (id, business_id, branch_id, order_number, order_type, status, subtotal, vat_amount, discount_amount, total, created_at, device_id, cashier_id, notes)
  VALUES ('o-1', 'biz-1', 'br-1', 'T1-0042', 'takeaway', 'completed', 950, 131.03, 0, 950, '2026-10-11T09:00:00Z', 'dev-T1', 'u-amy', 'Pack separately')`).run();
db.prepare(`INSERT INTO order_items (id, order_id, product_id, product_name, category_name, unit_price, quantity, subtotal, notes) VALUES
  ('i-1', 'o-1', 'p-burger', 'Burger', 'Food', 750, 1, 750, 'no onions'),
  ('i-2', 'o-1', 'p-soda', 'Soda', 'Drinks', 100, 2, 200, NULL)`).run();
db.prepare(`INSERT INTO order_item_variants (id, order_item_id, variant_group_name, variant_option_name, price_adjustment) VALUES ('v-1', 'i-1', 'Size', 'Large', 150)`).run();
db.prepare(`INSERT INTO order_item_modifiers (id, order_item_id, modifier_group_name, modifier_option_name, price) VALUES ('m-1', 'i-1', 'Extras', 'Cheese', 100)`).run();
db.prepare(`INSERT INTO payments (id, order_id, method, amount, amount_tendered, status, created_at) VALUES
  ('pay-1', 'o-1', 'cash', 500, 500, 'completed', '2026-10-11T09:00:01Z'),
  ('pay-2', 'o-1', 'mpesa', 450, 450, 'completed', '2026-10-11T09:00:02Z')`).run();

// The stand-in cloud: another till's order, as GET /api/orders/:id returns it.
const cloudOrder = {
  id: '6f1c2a10-0000-4000-8000-000000000001', order_number: 'T2-0007', order_type: 'dine_in', status: 'completed',
  subtotal: 600, vat_amount: 82.76, discount_amount: 0, total: 600, created_at: '2026-10-11T10:00:00Z', cashier_id: 'u-brian',
  cashier_name: 'Brian', table_number: '4',
  order_items: [{ product_name: 'Pizza', unit_price: 600, quantity: 1, subtotal: 600, notes: null,
    order_item_variants: [{ variant_group_name: 'Crust', variant_option_name: 'Thin', price_adjustment: 0 }],
    order_item_modifiers: [{ modifier_group_name: 'Toppings', modifier_option_name: 'Olives', price: 0 }] }],
  payments: [{ method: 'card', amount: 600, status: 'completed', reference: 'AUTH77' }],
};
const asked = [];
globalThis.fetch = async (url) => {
  asked.push(String(url));
  if (String(url).endsWith(`/api/orders/${cloudOrder.id}`)) return new Response(JSON.stringify(cloudOrder), { status: 200 });
  return new Response('{"error":"Order not found"}', { status: 404 });
};

require(path.join(dist, 'ipcHandlers.js')).registerIpcHandlers();
// The real print queue on the same database, a receipt printer bound to this till (an address nothing answers on, so
// the job stays queued and its bytes can be read back).
require(path.join(dist, 'print', 'printWorker.js')).initPrinting(db, () => null);
db.prepare(`INSERT INTO station_printers (station_id, target, paper_width_mm, updated_at) VALUES ('receipt', '127.0.0.1:9', 80, 0)`).run();
const lastReceipt = () => {
  const row = db.prepare(`SELECT bytes FROM print_jobs WHERE kind = 'receipt' ORDER BY created_at DESC, rowid DESC LIMIT 1`).get();
  return row ? Buffer.from(row.bytes).toString('latin1') : '';
};
const H = global.__handlers;
const D = require(path.join(dist, 'orderDetail.js'));

console.log('\nThe items inside an order, on the till\n');
signIn('u-mary', 'Mary', 'manager');
{
  const r = await H['order:detail'](null, 'o-1');
  const d = r.detail;
  ok('a manager opens a sale: every line with its quantity and price', r.ok && d.items.length === 2
    && d.items[0].name === 'Burger' && d.items[0].quantity === 1 && d.items[0].subtotal === 750 && d.items[1].quantity === 2, JSON.stringify(r).slice(0, 300));
  ok('…its sizes, extras and notes on each line', JSON.stringify(d.items[0].options) === '["Size: Large","+ Cheese"]' && d.items[0].notes === 'no onions');
  ok('…the order\'s note, who sold it, and each payment', d.notes === 'Pack separately' && d.cashier_name === 'Amy'
    && d.payments.map((p) => `${p.method}:${p.amount}`).join(',') === 'cash:500,mpesa:450' && d.source === 'till');
  ok('…and a manager may reprint it', r.canReprint === true);
}
{
  const r = await H['order:detail'](null, cloudOrder.id);
  ok('another till\'s order is read from the cloud (this till does not hold it)', r.ok && r.detail.source === 'cloud'
    && asked.some((u) => u.endsWith(`/api/orders/${cloudOrder.id}`)), JSON.stringify(r).slice(0, 200));
  ok('…with its lines, choices, table and cashier', r.detail.items[0].name === 'Pizza'
    && JSON.stringify(r.detail.items[0].options) === '["Crust: Thin","+ Olives"]' && r.detail.table_number === '4' && r.detail.cashier_name === 'Brian');
  const missing = await H['order:detail'](null, '6f1c2a10-0000-4000-8000-0000000000ff');
  ok('an order nobody has says so', !missing.ok && /not found/i.test(missing.error ?? ''));
}

console.log('\nWhat a cashier may open\n');
{
  C.setPosFeatures({ cashier_own_history: true });
  signIn('u-brian', 'Brian', 'cashier');
  const r = await H['order:detail'](null, 'o-1');
  ok('with "own history" on, a cashier cannot open another\'s sale', !r.ok && /not yours/i.test(r.error ?? ''), JSON.stringify(r));
  signIn('u-amy', 'Amy', 'cashier');
  C.setCashierHistoryMethods(['cash']);
  const own = await H['order:detail'](null, 'o-1');
  ok('…their own, yes — with only the payment methods their History shows', own.ok && own.detail.payments.length === 1
    && own.detail.payments[0].method === 'cash', JSON.stringify(own.detail?.payments));
  ok('…and no Reprint for a cashier', own.canReprint === false);
  const pr = await H['escpos:reprintReceiptForOrder'](null, 'o-1');
  ok('the till refuses a cashier\'s reprint as before', !pr.ok && /managers/i.test(pr.error ?? ''));
  C.setCashierHistoryMethods([]);
  C.setPosFeatures({ cashier_own_history: false });
}

console.log('\nReprint any order\n');
signIn('u-mary', 'Mary', 'manager');
{
  const r = await H['escpos:reprintReceiptForOrder'](null, 'o-1');
  const paper = lastReceipt();
  ok('a sale with no stored receipt on this till is reprinted (rebuilt from the order)', r.ok === true && /T1-0042/.test(paper), JSON.stringify(r));
  ok('…the paper has its lines, choices, note and who sold it, marked a duplicate',
    /Burger/.test(paper) && /Large/.test(paper) && /Cheese/.test(paper) && /no onions/.test(paper) && /Amy/.test(paper) && /DUPLICATE|REPRINT/i.test(paper),
    paper.replace(/[^\x20-\x7e\n]/g, '').slice(0, 600));
  asked.length = 0;
  const c = await H['escpos:reprintReceiptForOrder'](null, cloudOrder.id);
  ok('…another till\'s sale too, from the cloud', c.ok === true && asked.some((u) => u.endsWith(cloudOrder.id))
    && /T2-0007/.test(lastReceipt()) && /Pizza/.test(lastReceipt()), JSON.stringify(c));
}
{
  const local = D.detailFromLocal(
    { id: 'x', order_number: 'N1', total: 950, discount_amount: 50, tip_amount: 20, delivery_fee: 100, delivery_free: 0, cashier_name: 'Amy', notes: 'n' },
    [{ id: 'i', product_name: 'Burger', unit_price: 750, quantity: 1, subtotal: 750, notes: 'x' }],
    [{ order_item_id: 'i', variant_group_name: 'Size', variant_option_name: 'Large', price_adjustment: 150 }],
    [{ order_item_id: 'i', modifier_group_name: 'Extras', modifier_option_name: 'Cheese', price: 100 }],
    [{ method: 'cash', amount: 1070 }, { method: 'cash', amount: -1070, status: 'refunded' }]);
  const p = D.receiptPayloadFromDetail(local);
  ok('the rebuilt receipt carries the lines, choices and notes the till prints',
    p.items[0].product.name === 'Burger' && p.items[0].lineTotal === 750 && p.items[0].selectedVariants[0].optionName === 'Large'
    && p.items[0].selectedModifiers[0].name === 'Cheese' && p.items[0].notes === 'x', JSON.stringify(p.items[0]));
  ok('…the money as the sale was (discount, tip, delivery) and who sold it',
    p.total === 950 && p.discount_amount === 50 && p.tip_amount === 20 && p.delivery_fee === 100 && p.cashier_name === 'Amy');
  ok('…and only the payments taken (a refund leg is not printed as a payment)', p.payments.length === 1 && p.payments[0].amount === 1070);
  ok('the receipt names who sold it, not whoever reprints', /cashierName:\s+String\(payload\.cashier_name \?\? staff\?\.staff_name/.test(read('apps/desktop/src/main/ipcHandlers.ts')));
}

console.log('\nThe screens\n');
{
  const pos = read('apps/desktop/src/renderer/pages/POSPage.tsx');
  ok('till History: tapping a sale opens it', /data-testid="history-row" onClick=\{\(\) => setDetailId\(o\.id\)\}/.test(pos) && /<OrderDetailPanel\s+orderId=\{detailId\}/.test(pos));
  ok('…and its Reprint / Void buttons do not also open it', (pos.match(/e\.stopPropagation\(\);/g) ?? []).length >= 2);
  const mgr = read('apps/desktop/src/renderer/pages/ManagerPage.tsx');
  // A490: void and refund are separate keys (sales.void / sales.refund), each its own right.
  ok('till Manager › Orders: a sale opens with Void / Refund for sales.void / sales.refund holders',
    /data-testid="manager-order-row" onClick=\{\(\) => setDetailId\(o\.id\)\}/.test(mgr) && /<OrdersTab currency=\{currency\} rights=\{\{ void: has\('sales\.void'\), refund: has\('sales\.refund'\) \}\} \/>/.test(mgr));
  const panel = read('apps/desktop/src/renderer/components/OrderDetailPanel.tsx');
  ok('the panel reverses through the same VoidModal and rules as History', /reverseActionFor\(detail, rights, Date\.now\(\), windowMin\)/.test(panel) && /<VoidModal/.test(panel));
  const web = read('apps/dashboard/src/pages/OrdersPage.tsx');
  ok('web Orders: the items, Reprint only as the cloud allows, and a manager\'s PIN', /<OrderItems orderId=\{o\.id\}/.test(web)
    && /\{canReprint && <div className="pt-2">/.test(web) && /override_pin: pin\.trim\(\)/.test(web));
  const hist = read('apps/dashboard/src/pages/pos/POSOrderHistoryTab.tsx');
  ok('web POS / manager order history: the items, and Void inside the window next to Refund', /<OrderItems orderId=\{order\.id\}/.test(hist)
    && /inVoidWindow\(order\) && \(/.test(hist) && /\/api\/orders\/\$\{order\.id\}\/\$\{revMode\}/.test(hist));
  ok('the cloud names who sold an order', /A444: who sold it/.test(read('apps/server/src/routes/orders.ts')));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
