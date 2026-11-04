// Print bill and Transfer table on the desktop POS (owner, 2026-11-04: "1-5 yes only if the web licence is active").
//
// A restaurant with the online licence gets the web POS's two table extras on the desktop: Print bill (the open order's
// bill before payment) and Transfer (the open dine-in order to a free table).
//
// Drives the REAL compiled dist/main for the bill: ipc/sale.ts's escpos:printBill → ipc/shared.ts's queueThermal →
// escposBridge.printSale → shared/printing's render, on a REAL SQLite file, electron shimmed; only the spool is stood in
// for (printWorker.queueTickets keeps what it is handed). The receipt bytes are compared, not only the text.
//
//   cd apps/desktop && npx tsc -b tsconfig.main.json && node test/print-bill-transfer.test.mjs
//
//   B  the bill: "BILL - NOT A RECEIPT", no bill number, no payments or change, the lines, the offers and the total; the
//      receipt station only (never a kitchen ticket); refused without the online licence; refused with printing off.
//   R  a sale's receipt is byte-identical: its ticket carries no proforma key, and its bytes equal the receipt rendered
//      from the same order without the new code's field.
//   T  Transfer: only a free table (no held tab, not the order's own); the sale screen moves the order's table.
//   W  the sale screen: both buttons only for a restaurant with the online licence (Transfer: a dine-in order with a table).
//
// MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted):
//   - printBill handler without requireOnlineLicence()                   → B "refused without the online licence"
//   - queueThermal passing proforma for every ticket (proforma = true)   → R "a sale's receipt"
//   - printBill queueing ['kitchen', 'receipt']                          → B "the receipt station only"
//   - freeTables keeping the tables a held tab is on                     → T "only a free table"
//   - POSPage showing Print bill without onlineLicence                   → W
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'main');
const require = createRequire(import.meta.url);
const src = (p) => fs.readFileSync(path.join(here, '..', 'src', p), 'utf8');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-bill-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `module.exports = { app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '1.0.24' }, ipcMain: { handle() {} }, BrowserWindow: class { static getAllWindows() { return []; } }, dialog: {}, safeStorage: { isEncryptionAvailable: () => false }, net: { isOnline: () => false }, shell: {} };`);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) { return req === 'electron' ? shim : orig.call(this, req, parent, ...rest); };

const L = require(path.join(dist, 'localDb.js'));
const C = require(path.join(dist, 'deviceConfig.js'));
const PW = require(path.join(dist, 'print', 'printWorker.js'));
const B = require(path.join(dist, 'escposBridge.js'));
const { createIpcShared } = require(path.join(dist, 'ipc', 'shared.js'));
const { registerSaleHandlers } = require(path.join(dist, 'ipc', 'sale.js'));
const P = require('@swiftpos/printing');

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${String(d).slice(0, 1500)}`); fail++; } };

const db = L.getLocalDb();
db.prepare(`INSERT INTO session (id, token, refresh_token, user_id, business_id, business_name, currency, logged_in_at) VALUES (1, 'acc', 'ref', 'u-owner', 'biz-1', 'B Foods', 'KES', '2026-11-04T00:00:00Z')`).run();
C.saveDeviceConfig({ deploy_mode: 'cloud', server_url: 'http://cloud', branch_id: 'br-1', device_id: 'dev-T1', device_role: 'till', terminal_code: 'T1', device_name: 'Till 1' });
db.prepare(`INSERT INTO print_stations (id, name, kind, sort_order, active) VALUES ('st-k', 'Kitchen', 'kitchen', 1, 1), ('st-r', 'POS', 'receipt', 3, 1)`).run();
db.prepare(`INSERT INTO category_stations (category_id, station_id) VALUES ('c-food', 'st-k')`).run();

const queued = [];
PW.queueTickets = (contexts, stations) => { queued.push({ contexts, stations }); return { queued: stations.map((s) => s.id), skipped: [], failed: [] }; };
PW.assignments = () => [{ stationId: 'st-k', target: 'tcp://10.0.0.5:9100', paperWidthMm: 80 }, { stationId: 'st-r', target: 'tcp://10.0.0.7:9100', paperWidthMm: 80 }];
const handlers = {};
const ctx = createIpcShared((channel, fn) => { handlers[channel] = fn; });
registerSaleHandlers(ctx);
const licence = (on) => db.prepare(`UPDATE device_config SET web_pos_enabled = ? WHERE id = 1`).run(on ? 1 : 0);

const product = (id, name, category_id = 'c-food') => ({ id, name, category_id, categories: null, description: null });
const items = [
  { product: product('p-wings', 'Wings'), unitPrice: 650, quantity: 2, lineTotal: 1300, selectedVariants: [], selectedModifiers: [], notes: null },
  { product: product('p-soda', 'Soda 500ml', 'c-drinks'), unitPrice: 120, quantity: 1, lineTotal: 120, selectedVariants: [], selectedModifiers: [], notes: null },
];
// POSPage's printBill payload: the open order, after offers.
const billPayload = { order_type: 'dine_in', table_number: '4', delivery_person: null, items, total: 1320, discount_amount: 100,
  offers: [{ name: 'Happy hour', amount: 100 }], notes: null };
const rows = (t) => t.split('\n').map((x) => x.replace(/\s+$/, ''));
const renderAt = (entry, kind) => {
  const station = entry.stations.find((s) => s.kind === kind);
  return station ? P.renderTicket({ ...entry.contexts[0], station }) : null;
};

console.log('\nB. the bill\n');
B.setEscposEnabled(true);
licence(false);
{
  let threw = '';
  try { handlers['escpos:printBill'](null, billPayload); } catch (e) { threw = e.message; }
  ok('refused without the online licence (nothing queued)', /online licence/.test(threw) && queued.length === 0, threw);
}
licence(true);
{
  const r = handlers['escpos:printBill'](null, billPayload);
  ok('printed with the online licence', r?.ok === true && queued.length === 1, JSON.stringify(r));
  const entry = queued[0];
  ok('the receipt station only (never a kitchen ticket)', entry.stations.every((s) => s.kind === 'receipt'), JSON.stringify(entry.stations.map((s) => s.kind)));
  const t = P.toPreview(renderAt(entry, 'receipt'));
  const r2 = rows(t);
  console.log(t);
  ok('marked "BILL - NOT A RECEIPT"', r2.some((x) => x.includes('BILL - NOT A RECEIPT')), t);
  ok('no bill number (a bill is not a sale)', !/Bill No\./.test(t), t);
  ok('no payments and no change', !/\bCASH\b|\bCHANGE\b|\bMPESA\b/.test(t), t);
  ok('the lines, the offer and what is to pay', /Wings/i.test(t) && /Soda/i.test(t) && /Happy hour/.test(t) && /PAY: KES 1,320\.00/.test(t), t);
  ok('the table', r2.some((x) => x.trim() === 'Table: 4'), t);
  ok('the bill\'s ticket says proforma; a sale\'s never does', entry.contexts[0].proforma === true);
}
B.setEscposEnabled(false);
{
  const r = handlers['escpos:printBill'](null, billPayload);
  ok('printing off on this POS: refused in words, nothing queued', r?.ok === false && /Printing is off/.test(r.error) && queued.length === 1, JSON.stringify(r));
}
B.setEscposEnabled(true);

console.log('\nR. a sale\'s receipt is byte-identical\n');
{
  queued.length = 0;
  const sale = { order_number: 'T1-3001', order_type: 'dine_in', table_number: '4', cashier_name: 'Cate', items, total: 1420,
    discount_amount: 0, payments: [{ method: 'cash', amount: 1500 }], change_given: 80 };
  ctx.queueThermal(sale, ['receipt']);
  const entry = queued[0];
  ok('a sale\'s ticket carries no proforma key at all', entry && !('proforma' in entry.contexts[0]), JSON.stringify(Object.keys(entry?.contexts?.[0] ?? {})));
  const bytes = renderAt(entry, 'receipt');
  const station = entry.stations.find((s) => s.kind === 'receipt');
  const plain = { ...entry.contexts[0] };
  delete plain.proforma;
  const before = P.renderTicket({ ...plain, station });
  ok('its ESC/POS bytes equal the receipt rendered without the new field', Buffer.compare(Buffer.from(P.toEscPos(bytes)), Buffer.from(P.toEscPos(before))) === 0);
  ok('…and it is a receipt: the bill number and the payment', P.toPreview(bytes).includes('Bill No.: T1-3001') && /CASH/.test(P.toPreview(bytes)));
}

console.log('\nT. Transfer\n');
{
  const m = src('renderer/components/TransferTableModal.tsx');
  // The pure rule, run from its source text (the .tsx also holds the modal).
  const body = m.slice(m.indexOf('export function freeTables'), m.indexOf('export default function'));
  const freeTables = new Function(`${body.replace('export function freeTables(tables: DiningTable[], heldOrders: HeldOrder[], current: string): DiningTable[]', 'return function freeTables(tables, heldOrders, current)')}`)();
  const tables = ['1', '2', '3', '4', '5'].map((n) => ({ id: `t${n}`, name: n }));
  const held = [{ orderType: 'dine_in', tableNumber: '2' }, { orderType: 'takeaway', tableNumber: '' }, { orderType: 'dine_in', tableNumber: '5' }];
  ok('only a free table: no held tab on it, not the order\'s own', JSON.stringify(freeTables(tables, held, '4').map((t) => t.name)) === '["1","3"]', JSON.stringify(freeTables(tables, held, '4')));
  const p = src('renderer/pages/POSPage.tsx');
  ok('the sale screen moves the order to the table picked (its number, lines and kitchen record stay)',
    /onPick=\{\(t\) => \{ setShowTransfer\(false\); setTableNumber\(t\.name\); setBillMsg\(`Moved to Table \$\{t\.name\}\.`\); \}\}/.test(p));
  ok('the picker loads on demand', /const TransferTableModal = lazy\(\(\) => import\('\.\.\/components\/TransferTableModal'\)\);/.test(p));
}

console.log('\nW. the sale screen\n');
{
  const p = src('renderer/pages/POSPage.tsx');
  const row = p.slice(p.indexOf('data-testid="cart-split-bill"') - 400, p.indexOf('data-testid="bill-msg"'));
  ok('Print bill only with the online licence', /\{onlineLicence && \(\s+<button type="button" onClick=\{\(\) => void printBill\(\)\} data-testid="cart-print-bill"/.test(row), row);
  ok('Transfer only with the online licence, for a dine-in order with a table',
    /\{onlineLicence && orderType === 'dine_in' && tableNumber && \(\s+<button type="button" onClick=\{\(\) => setShowTransfer\(true\)\} data-testid="cart-transfer"/.test(row), row);
  ok('both inside the restaurant\'s row (one line of extra buttons)', /\{flags\.isRestaurant && cart\.length > 0 && \(\s+<div className="flex gap-2">/.test(row), row);
  ok('Print bill sends the open order after offers (the sale\'s own line shape)',
    /items: cart\.map\(saleLine\),\s+total: toPay,\s+discount_amount: offerOff,/.test(p));
  ok('the sale uses the same line shape', /items: \(payment\.platform\?\.lines \?\? cart\)\.map\(\(item, idx\) => \(\{\s+\.\.\.saleLine\(item\),/.test(p));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
