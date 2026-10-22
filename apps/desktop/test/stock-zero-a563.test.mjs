// A563 — when an item's stock reaches zero: sell as normal, show as sold out, or hide (the owner's choice), on the till.
// Owner, 2026-10-22: "add a feature where an owner can enable not to prevent items with zero stock from appearing in the
// inventory or if they do they cannot be sold".
//
// Drives the REAL compiled dist/main (localDb, deviceConfig, stockGateLocal, the shared stockGate rules, and the real
// order:create handler from ipc/sale.ts registered on a stand-in `handle`, saving through syncEngine.createLocalOrder) on a
// REAL SQLite file; reads the sale screen's source for the grid, the badge and the taps.
//
//   cd apps/desktop && npx tsc -b tsconfig.main.json && node test/stock-zero-a563.test.mjs
//
// MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted):
//   - order:create without the saleStockRefusal check                 → "sold out: order:create refuses …" fails
//   - readStockView without `p.track_stock = 1`                        → "an item that does not track stock is never …" fails
//   - availableOf treating no level as 0 (unknown = out)               → "unknown stock sells" fails
//   - outOfStockMode reading only stock_zero_sold_out (hide ignored)   → "hide: …" fails
//   - readStockView without `synced_at IS NOT NULL` (a made-up level)   → "…and again: the -1 this till wrote itself" fails
//   - POSPage filter without hiddenOutOfStock                           → "the grid and search leave out …" fails
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'main');
const srcDir = path.join(here, '..', 'src');
const require = createRequire(import.meta.url);
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-a563-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `module.exports = { app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '1.0.20' }, ipcMain: { handle() {} }, BrowserWindow: class { static getAllWindows() { return []; } }, dialog: {}, safeStorage: { isEncryptionAvailable: () => false }, net: { isOnline: () => false } };`);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) { return req === 'electron' ? shim : orig.call(this, req, parent, ...rest); };

const L = require(path.join(dist, 'localDb.js'));
const C = require(path.join(dist, 'deviceConfig.js'));
const E = require(path.join(dist, 'syncEngine.js'));
const G = require(path.join(dist, 'stockGateLocal.js'));
const S = require(path.join(dist, 'stockGate.js'));
const SH = require(path.join(dist, 'shiftService.js'));
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };
const throwsMsg = async (fn) => { try { await fn(); return null; } catch (e) { return e?.message ?? String(e); } };

const db = L.getLocalDb();
db.prepare(`INSERT INTO session (id, token, refresh_token, user_id, business_id, business_name, logged_in_at) VALUES (1, 'acc', 'ref', 'u-owner', 'biz-1', 'B Foods', '2026-10-22T00:00:00Z')`).run();
C.saveDeviceConfig({ deploy_mode: 'cloud', server_url: 'http://cloud', branch_id: 'br-1', device_id: 'dev-T1', device_role: 'till', terminal_code: 'T1', device_name: 'Till 1' });
E.configureSyncEngine('http://cloud', 'acc', 'ref');
const prod = (id, name, track, extra = '') => db.prepare(`INSERT INTO products (id, name, base_price, status, track_stock${extra ? ', is_fuel' : ''}) VALUES (?, ?, 100, 'active', ?${extra ? ', 1' : ''})`).run(id, name, track ? 1 : 0);
prod('p-chips', 'Chips', true);       // tracked, 0 at br-1
prod('p-soda', 'Soda', true);         // tracked, 2 at br-1
prod('p-tea', 'Tea', false);          // NOT tracked, 0 at br-1
prod('p-new', 'Samosa', true);        // tracked, no level heard at br-1 (unknown)
prod('p-burger', 'Burger', true);     // tracked, 5
prod('p-combo', 'Burger Combo', false); // a combo: Burger + Chips
prod('p-petrol', 'Petrol', true, 'fuel');
// A level as the cloud's change log writes it (A535 writeStockRows: synced_at stamped).
const level = (id, q, branch = 'br-1') => db.prepare(`INSERT INTO stock_levels (product_id, branch_id, quantity, synced_at) VALUES (?, ?, ?, '2026-10-22T06:00:00Z')
  ON CONFLICT(product_id, branch_id) DO UPDATE SET quantity = excluded.quantity, synced_at = excluded.synced_at`).run(id, branch, q);
level('p-chips', 0); level('p-soda', 2); level('p-tea', 0); level('p-burger', 5); level('p-petrol', 0);
level('p-new', 9, 'br-2');   // another branch's level is not this till's
db.prepare(`INSERT INTO combo_items (combo_id, product_id, name, quantity) VALUES ('p-combo', 'p-burger', 'Burger', 1), ('p-combo', 'p-chips', 'Chips', 1)`).run();

// The person at the till (A519: Sell).
db.prepare(`INSERT INTO staff_session (id, staff_id, staff_name, role_name, permissions, branch_id, token, logged_in_at) VALUES (1, 'u-cate', 'Cate', 'cashier', ?, 'br-1', 'tok', '2026-10-22T06:00:00Z')`)
  .run(JSON.stringify({ 'catalogue.v2': true, 'orders.create': true }));
SH.openShift(1000);

// The real order:create (ipc/sale.ts) on a stand-in handle; printing stubbed (a sale never waits on a printer).
const handlers = {};
const { registerSaleHandlers } = require(path.join(dist, 'ipc', 'sale.js'));
registerSaleHandlers({ handle: (name, fn) => { handlers[name] = fn; }, queueThermal: () => ({ failed: [] }), STATIONS_REFUSED: [], readOrderDetail: () => null });
let n = 0;
const line = (id, name, quantity = 1, extra = {}) => ({ product: { id, name }, unitPrice: 100, quantity, lineTotal: 100 * quantity, selectedVariants: [], selectedModifiers: [], ...extra });
const sale = (items) => ({ branch_id: 'br-1', order_number: `T1-${++n}`, order_type: 'retail', subtotal: 100, vat_amount: 0, total: 100,
  items, payments: [{ method: 'cash', amount: 100, amount_tendered: 100, change_given: 0 }] });
const charge = (items) => throwsMsg(() => handlers['order:create'](null, sale(items)));
const savedOrders = () => db.prepare(`SELECT COUNT(*) AS c FROM orders`).get().c;
const setMode = (flags) => C.setPosFeatures(flags);   // what the pull does with the cloud's posFeatures

console.log('\nA563 — when an item\'s stock reaches zero (the till)\n');

console.log('The setting syncs (two POS switches, one choice)');
{
  setMode({});
  ok('no switch heard (an older cloud, a new till): sell as normal', G.tillStockView().mode === 'sell');
  setMode({ stock_zero_sold_out: true });
  ok('the pull\'s posFeatures { stock_zero_sold_out } → "show as sold out", kept on the till (device_config.pos_features)',
    G.tillStockView().mode === 'sold_out' && JSON.parse(C.getDeviceConfig().pos_features).stock_zero_sold_out === true);
  setMode({ stock_zero_sold_out: true, stock_zero_hide: true });
  ok('hide wins when both are on', G.tillStockView().mode === 'hide');
  ok('the cloud\'s choice → the switches it writes, and back', S.outOfStockMode(S.outOfStockFlags('hide')) === 'hide'
    && S.outOfStockMode(S.outOfStockFlags('sold_out')) === 'sold_out' && S.outOfStockMode(S.outOfStockFlags('sell')) === 'sell');
  const posF = fs.readFileSync(path.join(srcDir, 'shared', 'posFeatures.ts'), 'utf8');
  ok('both are POS switches (shared/posFeatures.ts) — pos/init, the change log (topic money) and a branch server carry them',
    posF.includes("key: 'stock_zero_sold_out'") && posF.includes("key: 'stock_zero_hide'"));
}

console.log('\nSell as normal (the default)');
{
  setMode({});
  const before = savedOrders();
  const m = await charge([line('p-chips', 'Chips')]);
  ok('sell as normal: a sale at zero goes through (the stock goes negative, as before)', m === null && savedOrders() === before + 1, m);
  ok('…and the level went to -1', db.prepare(`SELECT quantity FROM stock_levels WHERE product_id='p-chips' AND branch_id='br-1'`).get().quantity === -1);
  ok('the sale screen is told "sell" with no levels (nothing to grey)', JSON.stringify(G.tillStockView().levels) === '{}');
  level('p-chips', 0);
}

console.log('\nShow as sold out');
{
  setMode({ stock_zero_sold_out: true });
  const v = G.tillStockView();
  ok('the levels are this branch\'s tracked items only (no untracked, no fuel, no other branch)',
    v.levels['p-chips'] === 0 && v.levels['p-soda'] === 2 && !('p-tea' in v.levels) && !('p-petrol' in v.levels) && !('p-new' in v.levels), JSON.stringify(v.levels));
  ok('Chips (tracked, 0) is greyed "Sold out", not hidden', S.showsSoldOut(v.mode, v, 'p-chips') && !S.hiddenOutOfStock(v.mode, v, 'p-chips'));
  ok('an item that does not track stock is never sold out (Tea at 0)', !S.showsSoldOut(v.mode, v, 'p-tea'));
  ok('unknown stock sells (Samosa: no level heard at this branch)', !S.showsSoldOut(v.mode, v, 'p-new') && S.availableOf(v, 'p-new') === null);
  ok('a combo is sold out when a tracked item in it is (Burger Combo: Chips out)', S.showsSoldOut(v.mode, v, 'p-combo'));
  const before = savedOrders();
  let m = await charge([line('p-chips', 'Chips')]);
  ok('sold out: order:create refuses it in MAIN ("Chips is sold out.") and nothing is saved', /Chips is sold out\./.test(m ?? '') && savedOrders() === before, m);
  m = await charge([line('p-tea', 'Tea')]);
  ok('…an untracked item at 0 is sold', m === null, m);
  m = await charge([line('p-new', 'Samosa')]);
  ok('…an item with unknown stock is sold', m === null, m);
  const made = db.prepare(`SELECT quantity, synced_at FROM stock_levels WHERE product_id='p-new' AND branch_id='br-1'`).get();
  m = await charge([line('p-new', 'Samosa')]);
  ok('…and again: the -1 this till wrote itself (never heard from the cloud) is still unknown', made?.quantity === -1 && made?.synced_at == null && m === null, `${JSON.stringify(made)} ${m}`);
  m = await charge([line('p-soda', 'Soda', 3)]);
  ok('…more than the branch has: "Only 2 of Soda left."', /Only 2 of Soda left\./.test(m ?? ''), m);
  m = await charge([line('p-soda', 'Soda', 2)]);
  ok('…exactly what it has: sold (Soda now 0)', m === null && G.tillStockView().levels['p-soda'] === 0, m);
  m = await charge([line('p-combo', 'Burger Combo')]);
  ok('…a combo with an item out is refused', /Burger Combo is sold out/.test(m ?? ''), m);
  m = await charge([{ ...line('p-petrol', 'Petrol', 20), isFuel: true, pumpId: 'pump-1' }]);
  ok('…fuel from a pump is never gated (its stock is the tank\'s)', m === null, m);
  m = await charge([line('p-burger', 'Burger'), line('p-chips', 'Chips')]);
  ok('a held order charged later: only the line that sold out is named (Chips), the rest is fine', /Chips is sold out\./.test(m ?? '') && !/Burger/.test(m ?? ''), m);
  level('p-chips', 4);
  m = await charge([line('p-chips', 'Chips')]);
  ok('stock comes in (the change log writes 4): sold again', m === null && G.tillStockView().levels['p-chips'] === 3, m);
  level('p-chips', 0); level('p-soda', 2);
}

console.log('\nHide when out of stock');
{
  setMode({ stock_zero_hide: true });
  const v = G.tillStockView();
  ok('hide: Chips (0) is off the menu, not greyed', S.hiddenOutOfStock(v.mode, v, 'p-chips') && !S.showsSoldOut(v.mode, v, 'p-chips'));
  ok("hide: Soda (2), Tea (untracked) and Samosa (unknown) stay", !S.hiddenOutOfStock(v.mode, v, 'p-soda') && !S.hiddenOutOfStock(v.mode, v, 'p-tea') && !S.hiddenOutOfStock(v.mode, v, 'p-new'), JSON.stringify(v.levels));
  const m = await charge([line('p-chips', 'Chips')]);
  ok('hide: a hidden item still in a held order is refused at Charge', /Chips is sold out\./.test(m ?? ''), m);
  level('p-chips', 1);
  const w = G.tillStockView();
  ok('it comes back by itself when stock comes in', !S.hiddenOutOfStock(w.mode, w, 'p-chips'));
}

console.log('\nThe sale screen keeps in step (main is the authority)');
{
  const pos = fs.readFileSync(path.join(srcDir, 'renderer', 'pages', 'POSPage.tsx'), 'utf8');
  ok('the grid and search leave out an item hidden for stock', /const matchStock\s+= !hiddenOutOfStock\(stockView\.mode, stockView, p\.id\);/.test(pos)
    && /matchDay && matchStock;/.test(pos));
  ok('a sold-out tile is greyed with a badge', pos.includes('soldOut={showsSoldOut(stockView.mode, stockView, product.id)}') && pos.includes('Sold out'));
  ok('a tap, a scan or + on the order is refused on the same rules', /const addSimple = \(product: any\) => \{\n\s+if \(refuseFrozen\(product\)\) return;\n\s+if \(refuseNewSale\(\)\) return;   \/\/ A519\n\s+if \(refuseOutOfStock\(product\)\) return;/.test(pos)
    && /const handleTap = \(product: any\) => \{\n\s+if \(refuseFrozen\(product\)\) return;\n\s+if \(refuseNewSale\(\)\) return;   \/\/ A519\n\s+if \(refuseOutOfStock\(product\)\) return;/.test(pos)
    && pos.includes('if (delta > 0 && refuseOutOfStock(item.product)) return;'));
  ok('the levels are read again after a sale, after a pull and every 20 s', pos.includes('loadStockView();   // A563') && pos.includes('setInterval(loadStockView, 20_000)'));
  const sale = fs.readFileSync(path.join(srcDir, 'main', 'ipc', 'sale.ts'), 'utf8');
  ok('order:create checks BEFORE the sale is saved', /const soldOut = saleStockRefusal\(orderPayload\);[\s\S]{0,4000}createLocalOrder\(orderPayload\)/.test(sale));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
