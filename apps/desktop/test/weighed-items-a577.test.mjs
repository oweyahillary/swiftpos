// A577 — items sold by weight at the till: weighing-scale labels scanned, a weight typed, the sale end to end, in every
// mode the till runs (a shop, a restaurant, a petrol station; parking and "other" run the shop's grid).
//
// Owner, 2026-10-23 (approved): "items sold by weight" — a scale label (EAN-13, 21–29, the item's scale code and its price
// or weight inside) scanned at the till adds the item with the weight as its quantity (0.452 kg) and the right amount; an
// item sold by weight tapped on the grid asks for the weight. Then (the owner): "let us not forget other business in the
// tills ... based on how they operate" — a restaurant's nyama choma by the kilo goes to the kitchen with its weight; a
// petrol station's shop scans labels too, and its fuel (litres) is not touched.
//
// Drives the REAL compiled dist/main (localDb, deviceConfig, syncEngine — the catalogue pull from a stand-in cloud,
// createLocalOrder, the sync queue —, referenceBundle, kitchenService, escposBridge.measureOf) on a REAL SQLite file, the
// till's own copy of the shared parser (src/shared/scaleBarcode.ts), and @swiftpos/printing for the paper.
//
//   cd apps/desktop && npx tsc -b tsconfig.main.json && node test/weighed-items-a577.test.mjs
//
//   1  local schema 77 (products.sold_by / unit_label, device_config.scale_barcodes); REQUIRED moves with it.
//   2  the pull: the cloud's plu_code lands in the till's plu (before A577 it never did — no PLU ever matched a scan),
//      sold_by and unit_label; the scale layout stored; an older cloud (no key) and a bad layout keep the till's.
//   3  the branch server relays all of it to its tills.
//   4  RETAIL (minimart): a price label scanned → 0.452 kg at KES 294; a 20 code (ZapTill's own) is a barcode, never a
//      label; the sale saved with 0.452 (order_items, the sync queue's payload) and the stock taken to the gram
//      (10 → 9.548, then 9.248 after 0.1 + 0.2 — no float dust); the receipt "0.452 kg @ 650/kg", Total Qty counting it
//      once; a reprint (no unit on the stored line) still prints the weight; a gram-shown item "125 g @ 800/kg".
//   5  RESTAURANT: goat meat tapped, 0.750 typed → KES 900; sent to the kitchen as 0.75 (the kitchen ledger) and printed
//      "0.750 kg   GOAT MEAT"; the dine-in sale saved.
//   6  PETROL: 20.5 L of diesel from a pump and a weight label from the shop in one sale — the fuel line is fuel (no
//      weight unit, its litres kept, pump_id on the order), the beef is weighed (0.750 kg).
//   7  the sale screen in each mode: the scanner listens in a shop, parking, "other" and a petrol station's shop grid
//      (never on the pumps, never in a restaurant — it taps); a weighed tap asks for the weight everywhere; a weighed line
//      is its own line, never stepped, sent with its unit.
//
// MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted — listed in the A577 report):
//   - writeProducts reading only p.plu (the old line)               → 2 "the cloud's plu_code lands in plu" and 4 fail
//   - createLocalOrder without the 3-decimal rounding of the level   → 4 "no float dust" fails
//   - measureOf not reading the product (a reprint)                  → 4 "a reprint still prints the weight" fails
//   - setScaleBarcodes storing what it is given uncleaned            → 2 "a bad layout keeps the till's" fails
//   - the scanner's petrol condition back to "flags.isPetrol"        → 7 "a petrol station's shop grid" fails
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'main');
const src = (p) => fs.readFileSync(path.join(here, '..', 'src', p), 'utf8');
const require = createRequire(import.meta.url);
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-a577-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `module.exports = { app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '1.0.20', getName: () => 'ZapTill', on() {}, isPackaged: false }, ipcMain: { handle() {}, on() {} }, BrowserWindow: class { static getAllWindows() { return []; } }, dialog: {}, shell: {}, safeStorage: { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(String(s)), decryptString: (b) => Buffer.from(b).toString() }, net: { isOnline: () => true }, powerMonitor: { on() {}, getSystemIdleTime: () => 0 } };`);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) { return req === 'electron' ? shim : orig.call(this, req, parent, ...rest); };

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };

const SB = await import(pathToFileURL(path.join(here, '..', 'src', 'shared', 'scaleBarcode.ts')).href);
const MODE = await import(pathToFileURL(path.join(here, '..', 'src', 'renderer', 'lib', 'posMode.ts')).href);
/** An EAN-13 with its check digit — the published GS1 rule, written out here. */
const ean = (b) => { let s = 0; for (let i = 0; i < 12; i++) s += Number(b[i]) * (i % 2 ? 3 : 1); return b + ((10 - (s % 10)) % 10); };

// ── The stand-in cloud ───────────────────────────────────────────────────────────────────────────────────────────────
const BR = 'br-1';
const PRODUCTS = [
  { id: 'p-beef', name: 'Beef steak', base_price: 650, status: 'active', track_stock: true, sold_by: 'weight', plu_code: '01234', unit_label: 'kg', category_id: 'c-butch' },
  { id: 'p-goat', name: 'Goat meat', base_price: 1200, status: 'active', track_stock: false, sold_by: 'weight', plu_code: '777', unit_label: 'kg', category_id: 'c-grill' },
  { id: 'p-sweets', name: 'Loose sweets', base_price: 800, status: 'active', track_stock: false, sold_by: 'weight', plu_code: '555', unit_label: 'g' },
  { id: 'p-soda', name: 'Soda 500ml', base_price: 80, status: 'active', track_stock: true, sold_by: 'each', barcode: '2000000000015', unit_label: 'pc' },
  { id: 'p-diesel', name: 'Diesel', base_price: 180, status: 'active', track_stock: false, sold_by: 'volume', is_fuel: true, fuel_unit: 'L' },
].map((p) => ({ description: null, image_url: null, has_variants: false, has_modifiers: false, branch_price: null, category_id: null, barcode: null, is_kitchen: null, show_days: null, ...p }));   // the cloud sends every column (select *)
const initWith = (extra) => ({ products: PRODUCTS, categories: [], comboItems: {}, offers: [], paymentMethods: [], branchId: BR, pricingBranchId: BR,
  vatRate: 16, ctlRate: 0, maxDiscountPct: 50, businessType: 'minimart', businessName: 'Mama Mboga Mart', currency: 'KES', ...extra });
const cloud = { init: initWith({ scaleBarcodes: SB.presetSettings('generic-price') }) };
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'x-zaptill-server': '1' }); res.end(JSON.stringify(body)); };
  if (u.pathname === '/api/pos/init') return send(200, cloud.init);
  if (u.pathname === '/api/pos/branch-staff') return send(200, { branch_id: BR, version: 'v1', staff: [] });
  if (/\/api\/(inventory|tables|pumps|stations|staff)/.test(u.pathname)) return send(200, []);
  return send(200, {});
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const CLOUD = `http://127.0.0.1:${srv.address().port}`;

const L = require(path.join(dist, 'localDb.js'));
const db = L.getLocalDb();
db.prepare(`INSERT INTO session (id, token, refresh_token, user_id, business_id, business_name, logged_in_at) VALUES (1, 'tok', 'r1', 'u-owner', 'biz-1', 'Mama Mboga Mart', '2026-10-23T00:00:00Z')`).run();
const DC = require(path.join(dist, 'deviceConfig.js'));
DC.saveDeviceConfig({ deploy_mode: 'cloud', server_url: CLOUD, branch_id: BR, device_id: 'dev-T1', device_role: 'till', terminal_code: 'T1', device_name: 'Till 1', business_type: 'minimart' });
require(path.join(dist, 'tokenStore.js')).writeSessionTokens({ token: 'tok', refreshToken: 'r1' });
const E = require(path.join(dist, 'syncEngine.js'));
E.configureSyncEngine(CLOUD, 'tok', 'r1');
const S = require(path.join(dist, 'shiftService.js'));
const RB = require(path.join(dist, 'referenceBundle.js'));
const K = require(path.join(dist, 'kitchenService.js'));
const B = require(path.join(dist, 'escposBridge.js'));
const P = require('@swiftpos/printing');
const stored = () => db.prepare(`SELECT scale_barcodes FROM device_config WHERE id = 1`).get().scale_barcodes;
const product = (id) => db.prepare(`SELECT * FROM products WHERE id = ?`).get(id);
const allProducts = () => db.prepare(`SELECT * FROM products WHERE status = 'active'`).all();
const effective = (p) => (p.branch_price !== null && p.branch_price !== undefined ? Number(p.branch_price) : Number(p.base_price));

// What the sale screen sends for a line (POSPage's payload), and what printSale builds from it (escposBridge).
const payloadLine = (p, l, extra = {}) => ({ product: { id: p.id, name: p.name, category_id: p.category_id ?? null }, unitPrice: l.unitPrice,
  quantity: l.quantity, lineTotal: l.lineTotal, selectedVariants: [], selectedModifiers: [], ...extra });
const printLine = (l, stationIds = []) => ({ name: l.product.name, quantity: l.quantity, ...B.measureOf(l), stationIds,
  unitPrice: Math.round(l.unitPrice * 100), lineTotal: Math.round(l.lineTotal * 100), units: [] });
const paper = (lines, station) => {
  const total = lines.reduce((s, l) => s + l.lineTotal, 0);
  const doc = P.renderTicket({ business: { ...P.sampleBusiness }, station, order: { billNumber: 'T1-1', orderType: 'counter', cashierName: 'Cate',
    soldAt: new Date(2026, 9, 23, 10, 0, 0), lines, payments: [{ label: 'CASH', amount: total }], changeGiven: 0, total, kotCount: 0 } });
  return doc.blocks.flatMap((b) => (b.kind === 'text' ? [b.text] : []));
};
let n = 0;
const sale = (items, extra = {}) => { const total = Math.round(items.reduce((s, i) => s + i.lineTotal, 0) * 100) / 100;
  return { branch_id: BR, order_number: `T1-${++n}`, order_type: 'retail', subtotal: total, vat_amount: 0, total, items,
    payments: [{ method: 'cash', amount: total, amount_tendered: total, change_given: 0 }], ...extra }; };

console.log('\nA577 — items sold by weight at the till\n');
try {
  console.log('1. Local schema');
  {
    const required = Number((fs.readFileSync(path.join(here, '..', '..', 'server', 'src', 'lib', 'desktopSchema.ts'), 'utf8').match(/REQUIRED_DESKTOP_SCHEMA = (\d+)/) || [])[1]);
    const pc = db.prepare(`PRAGMA table_info(products)`).all().map((c) => c.name);
    const dc = db.prepare(`PRAGMA table_info(device_config)`).all().map((c) => c.name);
    ok('local schema 77: products.sold_by + unit_label, device_config.scale_barcodes; REQUIRED moves with it',
      L.LOCAL_SCHEMA_VERSION >= 77 && required === L.LOCAL_SCHEMA_VERSION && pc.includes('sold_by') && pc.includes('unit_label') && dc.includes('scale_barcodes'),
      JSON.stringify({ v: L.LOCAL_SCHEMA_VERSION, required }));
  }

  console.log('\n2. The pull');
  {
    const r = await E.pullCatalogueNow();
    const beef = product('p-beef');
    ok('the cloud\'s plu_code lands in the till\'s plu (it never did before), with sold_by and unit_label',
      r.pulled === true && beef?.plu === '01234' && beef.sold_by === 'weight' && beef.unit_label === 'kg' && product('p-sweets').unit_label === 'g',
      JSON.stringify({ r, beef }));
    ok('the scale layout is stored and read back', JSON.stringify(DC.getScaleSettings()) === JSON.stringify(SB.presetSettings('generic-price')), stored());
    cloud.init = initWith({});   // an older cloud: no scaleBarcodes key
    await E.pullCatalogueNow();
    ok('an older cloud (no key): the till keeps its layout', DC.getScaleSettings().preset === 'generic-price', stored());
    cloud.init = initWith({ scaleBarcodes: SB.presetSettings('digi') });
    await E.pullCatalogueNow();
    ok('a new layout replaces it', DC.getScaleSettings().preset === 'digi' && DC.getScaleSettings().valueCheckDigit === true, stored());
    cloud.init = initWith({ scaleBarcodes: { prefixes: ['20'] } });
    await E.pullCatalogueNow();
    ok('a layout that does not clean (a 20 prefix): the till keeps its own', DC.getScaleSettings().preset === 'digi', stored());
    ok('the sale screen gets it with pos:init', /scaleBarcodes: getScaleSettings\(\),/.test(src('main/ipc/catalogue.ts')));
  }

  console.log('\n3. The branch server relays it');
  {
    const bundle = RB.buildReferenceBundle(db, {});
    const beef = (bundle.posInit?.products ?? []).find((p) => p.id === 'p-beef');
    ok('its tills get the PLU, sold_by, unit_label and the layout', beef?.plu === '01234' && beef.sold_by === 'weight' && beef.unit_label === 'kg'
      && bundle.posInit?.scaleBarcodes?.preset === 'digi', JSON.stringify({ beef, sb: bundle.posInit?.scaleBarcodes }));
    const back = RB.unpackNodeBundle(bundle);
    ok('…and a till unpacks it (an older server sends none → keep)', back.config.scaleBarcodes?.preset === 'digi'
      && RB.unpackNodeBundle({ posInit: {} }).config.scaleBarcodes === undefined);
  }

  console.log('\n4. RETAIL (minimart): a scale label scanned');
  cloud.init = initWith({ scaleBarcodes: SB.presetSettings('generic-price') });
  await E.pullCatalogueNow();
  db.prepare(`INSERT INTO staff_session (id, staff_id, staff_name, role_name, permissions, branch_id, token, logged_in_at) VALUES (1, 'u-cate', 'Cate', 'cashier', '{"orders.create":true}', ?, 'tok', '2026-10-23T06:00:00Z')`).run(BR);
  S.openShift(1000);
  db.prepare(`INSERT OR REPLACE INTO stock_levels (product_id, branch_id, quantity, low_stock_threshold) VALUES ('p-beef', ?, 10, 1), ('p-soda', ?, 5, 1)`).run(BR, BR);
  let saleId;
  {
    const settings = DC.getScaleSettings();
    const label = ean('220123400294');
    const reading = SB.parseScaleBarcode(label, settings);
    const beef = SB.findScaleProduct(allProducts(), reading?.itemCode ?? '');
    const line = beef ? SB.scaleLine(effective(beef), reading) : null;
    ok('the label 22 01234 00294 C → Beef steak, 0.452 kg at KES 294 (the label\'s price; the weight worked back)',
      beef?.id === 'p-beef' && line?.quantity === 0.452 && line.lineTotal === 294 && line.unitPrice === 650, JSON.stringify({ reading, line }));
    ok('the soda\'s own code 2000000000015 (prefix 20, ZapTill\'s) is a barcode, never a scale label',
      SB.parseScaleBarcode('2000000000015', settings) === null && allProducts().find((p) => p.barcode === '2000000000015')?.id === 'p-soda');
    const items = [payloadLine(beef, line, { measureUnit: 'kg' }), payloadLine(product('p-soda'), { unitPrice: 80, quantity: 2, lineTotal: 160 })];
    saleId = E.createLocalOrder(sale(items));
    const its = db.prepare(`SELECT product_id, quantity, unit_price, subtotal FROM order_items WHERE order_id = ? ORDER BY product_id`).all(saleId);
    ok('the sale is saved with 0.452 kg at 650/kg = 294', its[0].product_id === 'p-beef' && its[0].quantity === 0.452 && its[0].subtotal === 294 && its[0].unit_price === 650,
      JSON.stringify(its));
    const q = JSON.parse(db.prepare(`SELECT payload FROM sync_queue WHERE order_id = ?`).get(saleId).payload);
    ok('…and goes to the cloud as 0.452 with its amount', q.items[0].quantity === 0.452 && q.items[0].lineTotal === 294, JSON.stringify(q.items[0]));
    const level = () => db.prepare(`SELECT quantity FROM stock_levels WHERE product_id = 'p-beef' AND branch_id = ?`).get(BR).quantity;
    ok('the stock taken to the gram: 10 → 9.548', level() === 9.548, String(level()));
    E.createLocalOrder(sale([payloadLine(beef, SB.weighedLine(650, 0.1), { measureUnit: 'kg' })]));
    E.createLocalOrder(sale([payloadLine(beef, SB.weighedLine(650, 0.2), { measureUnit: 'kg' })]));
    ok('…then 0.1 and 0.2 more: 9.248 exactly (no float dust like 9.248000000000001)', level() === 9.248, String(level()));
    const mv = db.prepare(`SELECT quantity_change, quantity_after FROM stock_movements WHERE product_id = 'p-beef' ORDER BY created_at, rowid LIMIT 1`).get();
    ok('the movement log: -0.452 → 9.548', mv.quantity_change === -0.452 && mv.quantity_after === 9.548, JSON.stringify(mv));

    const r = paper(items.map((l) => printLine(l)), P.receiptPreset('st-till', 'Till', 80));
    const at = r.findIndex((t) => t.startsWith('Beef steak'));
    ok('the receipt: "Beef steak … 1", then "0.452 kg @ 650/kg"', at >= 0 && /\s1\s+\d/.test(r[at]) && r[at + 1]?.trim() === '0.452 kg @ 650/kg', r.join(' | '));
    ok('…Total Qty counts the weight once (1 + 2 sodas = 3)', r.some((t) => /^Total Qty:\s+3$/.test(t)), r.join(' | '));
    const reprint = { product: { id: 'p-beef', name: 'Beef steak' }, quantity: its[0].quantity, unitPrice: its[0].unit_price, lineTotal: its[0].subtotal };
    ok('a reprint from the stored line (no unit on it) still prints the weight — the product says kg', B.measureOf(reprint).measureUnit === 'kg'
      && paper([printLine(reprint)], P.receiptPreset('st-till', 'Till', 58)).some((t) => t.trim() === '0.452 kg @ 650/kg'));
    const sw = SB.findScaleProduct(allProducts(), '00555');
    const swl = SB.scaleLine(effective(sw), SB.parseScaleBarcode(ean('210055500100'), SB.presetSettings('generic-price')));
    ok('an item shown in grams: "125 g @ 800/kg"', paper([printLine(payloadLine(sw, swl))], P.receiptPreset('st-till', 'Till', 80)).some((t) => t.trim() === '125 g @ 800/kg'),
      JSON.stringify(swl));
    ok('the soda is not a measure (Qty 2, no "@" row); fuel and each items get no unit', !r.some((t) => /2 @/.test(t))
      && B.measureOf({ product: { id: 'p-soda' } }).measureUnit === undefined && B.measureOf({ product: { id: 'p-diesel' } }).measureUnit === undefined);
  }

  console.log('\n5. RESTAURANT: nyama choma by the kilo');
  {
    DC.saveDeviceConfig({ business_type: 'restaurant' });
    ok('the till is in restaurant mode (tables, kitchen, order types)', MODE.modeFlags(DC.getDeviceConfig()?.business_type).isRestaurant === true);
    const goat = product('p-goat');
    const line = SB.weighedLine(effective(goat), 0.75);   // the cashier taps Goat meat and types 0.750 on the keypad
    ok('0.750 kg typed → KES 900 (1200/kg)', line.quantity === 0.75 && line.lineTotal === 900);
    const pl = payloadLine(goat, line, { measureUnit: 'kg', lineId: 'L-goat' });
    const recorded = K.recordKitchenSend('T1-90', [{ line_id: 'L-goat', product_id: goat.id, product_name: goat.name, unit_price: 1200, qty: 0.75, item: pl }],
      { order_type: 'dine_in', table_number: '4' });
    const kl = db.prepare(`SELECT sent_qty, item_json FROM kitchen_lines WHERE order_number = 'T1-90'`).get();
    ok('sent to the kitchen as 0.75 (the kitchen ledger), its unit kept for a reprint', recorded === 1 && kl?.sent_qty === 0.75 && JSON.parse(kl.item_json).measureUnit === 'kg',
      JSON.stringify(kl));
    const k = paper([printLine(pl, ['st-kitchen'])], P.kitchenPreset('st-kitchen', 'Grill', 80));
    ok('the kitchen ticket: "0.750 kg   GOAT MEAT"', k.some((t) => t.startsWith('0.750 kg   GOAT MEAT')), k.join(' | '));
    const id = E.createLocalOrder(sale([pl], { order_type: 'dine_in', order_number: 'T1-90' }));
    const it = db.prepare(`SELECT quantity, subtotal FROM order_items WHERE order_id = ?`).get(id);
    const o = db.prepare(`SELECT order_type FROM orders WHERE id = ?`).get(id);
    ok('the dine-in sale is saved with 0.75 kg at 900', it.quantity === 0.75 && it.subtotal === 900 && o.order_type === 'dine_in', JSON.stringify({ it, o }));
  }

  console.log('\n6. PETROL: fuel from a pump and a weighed item from the shop');
  {
    DC.saveDeviceConfig({ business_type: 'petrol_station' });
    ok('the till is in petrol mode', MODE.modeFlags(DC.getDeviceConfig()?.business_type).isPetrol === true);
    db.prepare(`UPDATE device_config SET scale_barcodes = ? WHERE id = 1`).run(JSON.stringify(SB.presetSettings('generic-weight')));
    const beef = product('p-beef');
    const reading = SB.parseScaleBarcode(ean('210123400750'), DC.getScaleSettings());
    const line = SB.scaleLine(effective(beef), reading);
    ok('a weight label 21 01234 00750 C → 0.750 kg × 650 = KES 487.50', line.quantity === 0.75 && line.lineTotal === 487.5, JSON.stringify(line));
    const fuel = { ...payloadLine(product('p-diesel'), { unitPrice: 180, quantity: 20.5, lineTotal: 3690 }), isFuel: true, pumpId: 'pump-1' };
    const id = E.createLocalOrder(sale([fuel, payloadLine(beef, line, { measureUnit: 'kg' })], { order_type: 'fuel_sale', pump_id: 'pump-1' }));
    const its = db.prepare(`SELECT product_id, quantity, subtotal FROM order_items WHERE order_id = ? ORDER BY product_id`).all(id);
    const o = db.prepare(`SELECT pump_id FROM orders WHERE id = ?`).get(id);
    ok('both saved: the beef 0.75 kg (487.50), the diesel 20.5 L (3690) — the fuel path untouched, pump_id on the order',
      its.find((i) => i.product_id === 'p-beef')?.quantity === 0.75 && its.find((i) => i.product_id === 'p-diesel')?.quantity === 20.5 && o.pump_id === 'pump-1',
      JSON.stringify({ its, o }));
    const r = paper([printLine(fuel), printLine(payloadLine(beef, line, { measureUnit: 'kg' }))], P.receiptPreset('st-till', 'Till', 80));
    ok('the receipt: the diesel as litres ("20.5 @ 180", no weight unit), the beef "0.750 kg @ 650/kg"',
      r.some((t) => t.trim() === '20.5 @ 180') && r.some((t) => t.trim() === '0.750 kg @ 650/kg') && !r.some((t) => /20\.5 kg/.test(t)), r.join(' | '));
  }

  console.log('\n7. The sale screen, mode by mode');
  {
    const pos = src('renderer/pages/POSPage.tsx');
    const scanGate = /if \(flags\.isRestaurant \|\| \(flags\.isPetrol && view !== 'products'\)\) return;/.test(pos);
    const listens = (type, view) => { const f = MODE.modeFlags(type); return !(f.isRestaurant || (f.isPetrol && view !== 'products')); };
    ok('the scanner: a shop, a minimart, parking and "other" (the shop\'s grid) listen; a petrol station only on its shop grid; a restaurant taps',
      scanGate && listens('retail', 'products') && listens('minimart', 'products') && listens('parking', 'products') && listens('other', 'products')
      && listens('petrol_station', 'products') && !listens('petrol_station', 'pumps') && !listens('restaurant', 'tables') && !listens('cafe', 'products'));
    ok('a scan tries the scale label first (the newest handler, through a ref)', pos.includes('if (scaleScanRef.current(scanned)) { setSearch(\'\'); return; }')
      && pos.includes('const reading = scaleSettings ? parseScaleBarcode(code, scaleSettings) : null;') && pos.includes('findScaleProduct(products as any[], reading.itemCode)'));
    ok('a weighed item tapped (any mode — handleTap → addSimple) or scanned by its own barcode asks for the weight',
      /const addSimple = \(product: any\) => \{\s+if \(isSoldByWeight\(product\)\) \{[^\n]*setWeighFor\(product\); return; \}/.test(pos) && pos.includes('<WeightModal'));
    ok('a weighed line is its own line, never stepped (+/−), shown as its weight, sent with its unit',
      pos.includes('if (item.measureUnit) return;   // A577') && pos.includes('formatWeight(item.quantity, item.measureUnit)')
      && pos.includes("...(item.measureUnit ? { measureUnit: item.measureUnit } : {}),") && pos.includes('measureUnit: weightUnitOf(product) }]);'));
    ok('the keypad: kg to the gram, the amount from weighedLine', /export function typeKey/.test(src('renderer/components/WeightModal.tsx'))
      && src('renderer/components/WeightModal.tsx').includes('const line = weighedLine(pricePerKg, kg);'));
    ok('printSale prints every line\'s measure (measureOf)', src('main/escposBridge.ts').includes('...measureOf(l),'));
  }
} finally {
  srv.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
