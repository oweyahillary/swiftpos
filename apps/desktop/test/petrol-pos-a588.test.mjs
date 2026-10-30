// A588 — the petrol POS: the forecourt shop's items on the Shop grid, the pumps as dispensers with gauges, the fuel keypad.
//
// Owner, 2026-10-24: "FIX the petrol pos shop item, make it feel petrol-like, you can add gauges". The bug (found by the
// website agent): the petrol POS's "Shop items →" grid listed ONLY the fuel grades (POSPage's matchFuel was
// `flags.isPetrol ? is_fuel === true : !is_fuel`), so oil, water, snacks and car care could only be scanned.
//
//   cd apps/desktop && npx tsc -b tsconfig.main.json && node test/petrol-pos-a588.test.mjs
//
//   1  the Shop grid: POSPage's own grid rule run on a petrol station's catalogue — the shop's items in, fuel out (every
//      mode); "Pumps | Shop" always at the top of a petrol POS; the old buttons gone.
//   2  the pumps view: the REAL PumpsView rendered (react-dom/server) — only the fuel grades, each pump a dispenser (its
//      grade's colour, price per litre, state, last sale, today's litres); no shop item.
//   3  a mixed sale on the REAL compiled main (SQLite): fuel from a pump (KES 2,000 → litres at full precision) and two
//      shop items in one sale — stored as always (order_type fuel_sale, pump_id, the fuel line's litres); then the
//      counters (main/forecourt.ts): the pump's litres today and last sale, the grade's today / yesterday; another POS's
//      sale and a voided one not counted.
//   4  the gauges: a tank's level ("x L left", red under 20 % or at its reorder level, several tanks summed); no tank
//      known → today's litres against yesterday (the real counters, never a made-up level); still loading → no number.
//      The tanks: only with the online licence, this branch's and the business-wide ones, asked at most once a minute,
//      the last answer kept (with its time) when the cloud cannot answer.
//   5  the keypad: amount (2 decimals) or litres (3), the other worked out (litres = KES ÷ price; amount = litres × price,
//      the fuel path's own rule), 500 / 1,000 / 2,000 and Full tank (→ litres); the line goes through addFuelLine as always.
//   6  the bundle (A517): PumpsView and the branch lookup load when opened — the POS's main chunk ≤ 452 kB (445 until A605).
//
// MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted — listed in the A588 report):
//   - POSPage's matchFuel back to `flags.isPetrol ? (p as any).is_fuel === true : !(p as any).is_fuel` → 1 fails
//   - PumpsView imported statically again                                  → 6 "PumpsView is its own chunk" fails
//   - gradeGauge ignoring the tanks' reorder level                          → 4 "at its reorder level" fails
//   - forecourtSales without the device scope                               → 3 "another POS's sale not counted" fails
//   - fuelSale amount → litres rounded to 2 decimals                         → 5 "full precision" fails
//   - forecourtTanks asking without the online licence                      → 4 "no licence: never asked" fails
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.join(here, '..');
const dist = path.join(desktop, 'dist', 'main');
const src = (p) => fs.readFileSync(path.join(desktop, 'src', p), 'utf8').replace(/\r\n/g, '\n');
const require = createRequire(import.meta.url);
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-a588-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `module.exports = { app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '1.0.21', getName: () => 'ZapTill', on() {}, isPackaged: false }, ipcMain: { handle() {}, on() {} }, BrowserWindow: class { static getAllWindows() { return []; } }, dialog: {}, shell: {}, safeStorage: { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(String(s)), decryptString: (b) => Buffer.from(b).toString() }, net: { isOnline: () => true }, powerMonitor: { on() {}, getSystemIdleTime: () => 0 } };`);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) { return req === 'electron' ? shim : orig.call(this, req, parent, ...rest); };

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };

const FC = await import(pathToFileURL(path.join(desktop, '..', '..', 'packages', 'core', 'src', 'forecourt.ts')).href);
const MODE = await import(pathToFileURL(path.join(desktop, 'src', 'renderer', 'lib', 'posMode.ts')).href);

// The REAL PumpsView, bundled for Node and rendered to HTML (no browser): window.swiftpos is a stand-in bridge.
globalThis.window = { swiftpos: { pos: { forecourt: async () => null } } };
const bundle = path.join(userData, 'pumps.cjs');
const entry = path.join(userData, 'entry.tsx');
fs.writeFileSync(entry, `export { default as PumpsView, GradeGauge, Dispenser } from ${JSON.stringify(path.join(desktop, 'src/renderer/components/PumpsView.tsx').replace(/\\/g, '/'))};
export { createElement } from 'react';
export { renderToStaticMarkup } from 'react-dom/server';`);
require('esbuild').buildSync({ entryPoints: [entry], bundle: true, format: 'cjs', platform: 'node', outfile: bundle, logLevel: 'silent',
  jsx: 'automatic', nodePaths: [path.join(desktop, 'node_modules')], define: { 'process.env.NODE_ENV': '"production"' } });
const UI = require(bundle);
const html = (el) => UI.renderToStaticMarkup(el);
const h = UI.createElement;

// A petrol station's catalogue (Kifaru Fuel & Mart, a fictional demo brand): three grades and the forecourt shop.
const PRODUCTS = [
  { id: 'f-super', name: 'Super Petrol', base_price: 184.5, is_fuel: true, status: 'active', category_id: 'c-fuel', category_color: '#123456' },
  { id: 'f-diesel', name: 'Diesel', base_price: 171.6, is_fuel: true, status: 'active', category_id: 'c-fuel' },
  { id: 'f-kero', name: 'Kerosene', base_price: 155.2, is_fuel: true, status: 'active', category_id: 'c-fuel' },
  { id: 's-oil', name: 'Engine Oil 1L', base_price: 850, is_fuel: false, status: 'active', category_id: 'c-lube' },
  { id: 's-water', name: 'Water 1L', base_price: 70, is_fuel: 0, status: 'active', category_id: 'c-shop' },
  { id: 's-wash', name: 'Car Shampoo', base_price: 450, status: 'active', category_id: 'c-care' },
];
const pump = (i, f, extra = {}) => ({ id: `pm${i}`, name: `Pump ${i}`, status: 'idle', sort_order: i, fuel_product_id: f.id, fuel_product_name: f.name, price_per_litre: f.base_price, ...extra });
const PUMPS = [pump(1, PRODUCTS[0]), pump(2, PRODUCTS[0]), pump(3, PRODUCTS[1]), pump(4, PRODUCTS[2], { status: 'inactive' })];

console.log('\nA588 — the petrol POS: its shop, its pumps, its gauges\n');
let srvClose = () => {};
try {
  console.log('1. The Shop grid lists the forecourt shop — never fuel');
  {
    const pos = src('renderer/pages/POSPage.tsx');
    const line = pos.match(/const matchFuel\s+=([^;]+);/);
    ok('POSPage has one fuel rule for its grid', !!line, 'no matchFuel line');
    // POSPage's own expression, run on the catalogue for each mode
    const rule = new Function('p', 'flags', `return (${(line?.[1] ?? 'false').replace(/ as any/g, '')});`);
    const grid = (type) => PRODUCTS.filter((p) => rule(p, MODE.modeFlags(type))).map((p) => p.id);
    ok('a petrol station\'s grid: Engine Oil, Water, Car Shampoo — no Super, Diesel or Kerosene',
      JSON.stringify(grid('petrol_station')) === JSON.stringify(['s-oil', 's-water', 's-wash']), JSON.stringify(grid('petrol_station')));
    ok('…every other business the same (fuel is never a tile)', ['retail', 'minimart', 'restaurant', 'cafe', 'parking', 'other']
      .every((t) => JSON.stringify(grid(t)) === JSON.stringify(['s-oil', 's-water', 's-wash'])));
    ok('the rule rides with the others (menus, search, chosen days, stock, hours)',
      pos.includes("return p.status === 'active' && matchCat && matchMenu && matchSearch && matchFuel && matchDay && matchStock && matchHours;"));
    ok('"Pumps | Shop" at the top of both petrol views; the old "Shop items →" and "← Pumps" gone',
      (pos.match(/<ForecourtTabs view=\{view\} onView=\{setView\} \/>/g) ?? []).length === 2
      && pos.includes("{flags.isPetrol && <ForecourtTabs view={view} onView={setView} />}")
      && /data-testid=\{`forecourt-tab-\$\{v === 'pumps' \? 'pumps' : 'shop'\}`\}/.test(pos) && pos.includes("{tab('products', 'Shop', '🛒')}")
      && !pos.includes('← Pumps') && !src('renderer/components/PumpsView.tsx').includes('Shop items'));
    ok('a petrol POS still opens on the pumps, and goes back to them after a sale',
      pos.includes("setView('pumps');                         // petrol opens on the pump grid") && pos.includes("if (flags.isPetrol) setView('pumps');"));
    ok('the shop grid scans (A577) — the scanner listens on the Shop view, never on the pumps',
      /if \(flags\.isRestaurant \|\| \(flags\.isPetrol && view !== 'products'\)\) return;/.test(pos));
  }

  console.log('\n2. The pumps view: only fuel, each pump a dispenser');
  {
    const out = html(h(UI.PumpsView, { pumps: PUMPS, currency: 'KES', onAddFuel: () => {}, products: PRODUCTS, onSale: new Set(['pm2']) }));
    ok('four pump cards, the three grades named', (out.match(/data-testid="pump-card"/g) ?? []).length === 4
      && ['Super Petrol', 'Diesel', 'Kerosene'].every((g) => out.includes(g)));
    ok('no shop item on the pumps', !['Engine Oil', 'Water 1L', 'Car Shampoo'].some((s) => out.includes(s)));
    ok('the state on each card: Pump 2 on this sale is In use, Pump 4 Off, the others Idle',
      /data-state="in_use"[^]*?Pump 2/.test(out) && /data-state="off"[^]*?Pump 4/.test(out) && (out.match(/data-state="idle"/g) ?? []).length === 2);
    ok('the grade\'s colour on its card (Super red, Diesel amber, Kerosene blue) and the price per litre',
      out.includes('background:#dc2626') && out.includes('background:#f59e0b') && out.includes('background:#3f6fb5')
      && out.includes('KES 184.50') && out.includes('171.60'));
    ok('before the counters are read: no last sale, no litres made up ("— —", no "Today")',
      out.includes('— —') && !out.includes('data-testid="pump-today"'));
    const card = html(h(UI.Dispenser, { pump: PUMPS[2], currency: 'KES', colour: '#f59e0b', state: 'selected', onTap: () => {},
      day: { pump_id: 'pm3', litres_today: 245.3, last_sale_at: '2026-10-24T11:05:00.000Z', last_sale_litres: 11.655, last_sale_amount: 2000 } }));
    ok('a dispenser with its counters: the last sale on the display (KES 2,000.00 · 11.655 L), Today 245.300 L, Selected',
      card.includes('2,000.00') && card.includes('11.655 L') && card.includes('Today 245.300 L') && card.includes('data-state="selected"'), card);
    ok('the colour rule: by the grade\'s name, else its category\'s colour, else a fixed one by position',
      FC.gradeColour('V-Power') === '#9333ea' && FC.gradeColour('Unleaded 91') === '#dc2626' && FC.gradeColour('AGO') === '#f59e0b'
      && FC.gradeColour('Paraffin') === '#3f6fb5' && FC.gradeColour('LPG') === '#0d9488'
      && FC.gradeColour('Biofuel X', '#123456') === '#123456' && FC.gradeColour('Biofuel X', 'red', 1) === '#db2777');
  }

  console.log('\n3. A mixed sale (the real main, SQLite) and the counters');
  {
    const L = require(path.join(dist, 'localDb.js'));
    const db = L.getLocalDb();
    db.prepare(`INSERT INTO session (id, token, refresh_token, user_id, business_id, business_name, logged_in_at) VALUES (1, 'tok', 'r1', 'u-owner', 'biz-3', 'Kifaru Fuel & Mart', '2026-10-24T00:00:00Z')`).run();
    const DC = require(path.join(dist, 'deviceConfig.js'));
    DC.saveDeviceConfig({ deploy_mode: 'cloud', server_url: 'http://127.0.0.1:9', branch_id: 'br-1', device_id: 'dev-T1', device_role: 'till', terminal_code: 'T1', device_name: 'POS 1', business_type: 'petrol_station' });
    const E = require(path.join(dist, 'syncEngine.js'));
    E.configureSyncEngine('http://127.0.0.1:9', 'tok', 'r1');
    const S = require(path.join(dist, 'shiftService.js'));
    for (const p of PRODUCTS) db.prepare(`INSERT INTO products (id, name, base_price, status, is_fuel) VALUES (?, ?, ?, 'active', ?)`).run(p.id, p.name, p.base_price, p.is_fuel ? 1 : 0);
    for (const p of PUMPS) db.prepare(`INSERT INTO pumps (id, branch_id, fuel_product_id, name, status, sort_order) VALUES (?, 'br-1', ?, ?, ?, ?)`).run(p.id, p.fuel_product_id, p.name, p.status, p.sort_order);
    db.prepare(`INSERT INTO staff_session (id, staff_id, staff_name, role_name, permissions, branch_id, token, logged_in_at) VALUES (1, 'u-brian', 'Brian', 'cashier', '{"orders.create":true}', 'br-1', 'tok', '2026-10-24T06:00:00Z')`).run();
    S.openShift(1000);

    // The keypad's KES 2,000 at Pump 1 (Super 184.50) → the line POSPage.addFuelLine builds: litres at full precision.
    const fuel = FC.fuelSale('amount', '2000', 184.5);
    const fuelLine = { product: { id: 'f-super', name: 'Super Petrol', category_id: null }, quantity: fuel.litres, unitPrice: 184.5, lineTotal: fuel.amount,
      selectedVariants: [], selectedModifiers: [], isFuel: true, pumpId: 'pm1' };
    const shop = (p, q) => ({ product: { id: p.id, name: p.name, category_id: p.category_id }, quantity: q, unitPrice: p.base_price, lineTotal: p.base_price * q, selectedVariants: [], selectedModifiers: [] });
    const items = [fuelLine, shop(PRODUCTS[3], 1), shop(PRODUCTS[4], 2)];
    const total = Math.round(items.reduce((s, i) => s + i.lineTotal, 0) * 100) / 100;
    const sale = (num, its, tot, extra = {}) => ({ branch_id: 'br-1', order_number: num, order_type: 'fuel_sale', subtotal: tot, vat_amount: 0, total: tot, items: its,
      payments: [{ method: 'cash', amount: tot, amount_tendered: tot, change_given: 0 }], pump_id: 'pm1', ...extra });
    const id = E.createLocalOrder(sale('T1-1', items, total));
    const o = db.prepare(`SELECT order_type, pump_id, total, device_id FROM orders WHERE id = ?`).get(id);
    const its = db.prepare(`SELECT product_id, quantity, subtotal FROM order_items WHERE order_id = ? ORDER BY product_id`).all(id);
    const f = its.find((i) => i.product_id === 'f-super');
    ok('one sale: KES 2,000 of Super from Pump 1 and two shop items (Engine Oil, 2 × Water) — KES 2,990',
      total === 2990 && its.length === 3 && its.some((i) => i.product_id === 's-oil' && i.quantity === 1) && its.some((i) => i.product_id === 's-water' && i.quantity === 2), JSON.stringify(its));
    ok('stored as always: order_type fuel_sale, pump_id pm1, the fuel line\'s litres at full precision (2000 ÷ 184.5), KES 2,000',
      o.order_type === 'fuel_sale' && o.pump_id === 'pm1' && Math.abs(f.quantity - 2000 / 184.5) < 1e-9 && f.subtotal === 2000, JSON.stringify({ o, f }));

    // Another POS's sale on this (branch server's) table, and a voided sale: neither is this POS's litres.
    db.prepare(`INSERT INTO orders (id, business_id, branch_id, order_number, order_type, status, subtotal, vat_amount, total, created_at, device_id, pump_id, sync_status)
      VALUES ('o-T2', 'biz-3', 'br-1', 'T2-9', 'fuel_sale', 'completed', 900, 0, 900, ?, 'dev-T2', 'pm1', 'synced')`).run(new Date().toISOString());
    db.prepare(`INSERT INTO order_items (id, order_id, product_id, product_name, unit_price, quantity, subtotal) VALUES ('oi-T2', 'o-T2', 'f-super', 'Super Petrol', 184.5, 50, 9225)`).run();
    const vid = E.createLocalOrder(sale('T1-2', [{ ...fuelLine, quantity: 5, lineTotal: 922.5 }], 922.5));
    db.prepare(`UPDATE orders SET status = 'voided' WHERE id = ?`).run(vid);
    // Yesterday on this POS: 40 L of Super.
    const y = new Date(); y.setDate(y.getDate() - 1); y.setHours(12, 0, 0, 0);
    db.prepare(`INSERT INTO orders (id, business_id, branch_id, order_number, order_type, status, subtotal, vat_amount, total, created_at, device_id, pump_id, sync_status)
      VALUES ('o-y', 'biz-3', 'br-1', 'T1-0', 'fuel_sale', 'completed', 7380, 0, 7380, ?, 'dev-T1', 'pm2', 'synced')`).run(y.toISOString());
    db.prepare(`INSERT INTO order_items (id, order_id, product_id, product_name, unit_price, quantity, subtotal) VALUES ('oi-y', 'o-y', 'f-super', 'Super Petrol', 184.5, 40, 7380)`).run();

    const F = require(path.join(dist, 'forecourt.js'));
    const day = F.forecourtSales();
    const p1 = day.pumps.find((p) => p.pump_id === 'pm1'), p3 = day.pumps.find((p) => p.pump_id === 'pm3');
    const g = day.grades.find((r) => r.product_id === 'f-super');
    ok('Pump 1 today: the 10.840 L of this sale; its last sale KES 2,000 / 10.840 L — the shop lines are not litres',
      Math.abs(p1.litres_today - 2000 / 184.5) < 1e-9 && p1.last_sale_amount === 2000 && Math.abs(p1.last_sale_litres - 2000 / 184.5) < 1e-9 && !!p1.last_sale_at, JSON.stringify(p1));
    ok('another POS\'s sale and a voided one are not counted (this POS\'s own sales — the screen says so)',
      Math.abs(g.litres_today - 2000 / 184.5) < 1e-9 && day.pumps.length === 4, JSON.stringify(g));
    ok('Super: today 10.840 L against yesterday 40 L; Pump 3 (Diesel) nothing yet — 0, no last sale',
      g.litres_yesterday === 40 && p3.litres_today === 0 && p3.last_sale_at === null, JSON.stringify({ g, p3 }));

    console.log('\n4. The gauges');
    const gauge = FC.gradeGauge('f-super', { ...day, tanks: null, tanksAt: null });
    ok('no tank known → Super\'s gauge is today against yesterday (10.840 of 40 L = 27 %)', gauge.kind === 'today' && Math.round(gauge.pct) === 27
      && Math.abs(gauge.today - 2000 / 184.5) < 1e-9 && gauge.yesterday === 40, JSON.stringify(gauge));
    const todayHtml = html(h(UI.GradeGauge, { name: 'Super Petrol', colour: '#dc2626', gauge }));
    ok('…drawn: "10.840 L today", "40.000 L yesterday", no level, no "left"', todayHtml.includes('10.840 L today')
      && todayHtml.includes('40.000 L yesterday') && !/left/.test(todayHtml) && todayHtml.includes('data-kind="today"'), todayHtml);
    ok('still loading → no number at all ("–")', FC.gradeGauge('f-super', null) === null
      && html(h(UI.GradeGauge, { name: 'Diesel', colour: '#f59e0b', gauge: null })).includes('not known yet'));
    const tanks = [
      { id: 't1', name: 'Super A', product_id: 'f-super', capacity_litres: 10000, current_level: 6200, reorder_level: 1500 },
      { id: 't2', name: 'Super B', product_id: 'f-super', capacity_litres: 5000, current_level: 1800, reorder_level: 1000 },
      { id: 't3', name: 'Diesel', product_id: 'f-diesel', capacity_litres: 15000, current_level: 2400, reorder_level: 0 },
      { id: 't4', name: 'Kero', product_id: 'f-kero', capacity_litres: 8000, current_level: 3000, reorder_level: 3500 },
    ];
    const data = { ...day, tanks, tanksAt: '2026-10-24T11:00:00.000Z' };
    const sup = FC.gradeGauge('f-super', data), dsl = FC.gradeGauge('f-diesel', data), ker = FC.gradeGauge('f-kero', data);
    ok('tanks known → Super\'s two tanks summed: 8,000 L left of 15,000 (53 %), not low', sup.kind === 'tank' && sup.left === 8000 && sup.capacity === 15000
      && Math.round(sup.pct) === 53 && !sup.low && sup.tanks === 2, JSON.stringify(sup));
    ok('Diesel at 16 % → low (under 20 %)', dsl.low && Math.round(dsl.pct) === 16);
    ok('Kerosene at 37.5 % but at its reorder level (3,500) → low', ker.low && ker.pct === 37.5);
    const lowHtml = html(h(UI.GradeGauge, { name: 'Diesel', colour: '#f59e0b', gauge: dsl }));
    ok('…drawn: "2,400 L left" of "15,000 L", red, "Low", the fill on the arc', lowHtml.includes('2,400 L left') && lowHtml.includes('15,000 L')
      && lowHtml.includes('data-low="1"') && lowHtml.includes('stroke="#ef4444"') && lowHtml.includes('Low') && lowHtml.includes('data-testid="gauge-fill"'), lowHtml);
    ok('tanks known but none for a grade → that grade falls back to its litres', FC.gradeGauge('f-other', data).kind === 'today'
      && FC.gradeGauge('f-super', { ...day, tanks: [], tanksAt: null }).kind === 'today');

    // The tanks from the cloud: the licence, the branch, once a minute, the last answer kept.
    F._resetForecourtTanks();
    let asked = 0;
    const rows = [
      { id: 't1', name: 'Super A', branch_id: 'br-1', fuel_product_id: 'f-super', capacity_litres: '10000', current_level: '6200.5', reorder_level: 1500 },
      { id: 't9', name: 'Other branch', branch_id: 'br-2', fuel_product_id: 'f-super', capacity_litres: 9000, current_level: 100, reorder_level: null },
      { id: 't5', name: 'Shared', branch_id: null, fuel_product_id: 'f-diesel', capacity_litres: 5000, current_level: 4000, reorder_level: null },
      { id: 'bad', name: 'No capacity', branch_id: 'br-1', fuel_product_id: 'f-kero', capacity_litres: 0, current_level: 10 },
    ];
    const ask = async () => { asked++; return rows; };
    const t0 = Date.UTC(2026, 9, 24, 9, 0, 0);
    DC.saveDeviceConfig({ web_pos_enabled: false });
    const noLic = await F.forecourtTanks(ask, t0);
    ok('no online licence (A460: stock is premium): never asked, no tanks', noLic.tanks === null && noLic.tanksAt === null && asked === 0);
    db.prepare(`UPDATE device_config SET web_pos_enabled = 1 WHERE id = 1`).run();
    const a = await F.forecourtTanks(ask, t0);
    ok('with it: this branch\'s tanks and the business-wide one — not another branch\'s, not one with no capacity',
      asked === 1 && JSON.stringify(a.tanks.map((t) => t.id)) === '["t1","t5"]' && a.tanks[0].current_level === 6200.5 && a.tanksAt === new Date(t0).toISOString(), JSON.stringify(a));
    await F.forecourtTanks(ask, t0 + 30_000);
    ok('asked at most once a minute', asked === 1);
    const b = await F.forecourtTanks(async () => { asked++; throw new Error('offline'); }, t0 + 61_000);
    ok('the cloud cannot answer → the last answer, with the time it was read ("as of")', asked === 2 && b.tanks.length === 2 && b.tanksAt === new Date(t0).toISOString());
    ok('an answer that is not a list is ignored', F.cleanTanks({ error: 'x' }, 'br-1') === null && F.cleanTanks([], 'br-1').length === 0);
    const cat = src('main/ipc/catalogue.ts');
    ok('pos:forecourt: the counters and the tanks (GET /api/fuel-tanks, 2 s); bridged and validated',
      cat.includes("handle('pos:forecourt', async () => {") && cat.includes("withinMs(tillFetch('/api/fuel-tanks', {}, 2_000), 2_000)")
      && cat.includes('return { ...forecourtSales(), ...tanks };') && src('main/preload.ts').includes("forecourt:    ()                  => ipcRenderer.invoke('pos:forecourt'),")
      && src('main/ipcSchemas.ts').includes("'pos:forecourt':      NO_PAYLOAD,"));
    const server = fs.readFileSync(path.join(desktop, '..', 'server', 'src', 'routes', 'fueltanks.ts'), 'utf8');
    ok('…the cloud lets a cashier read the tanks (orders.create)', server.includes("const canReadFuel = requireAnyPermission('fuel.manage', 'reports.fuel', 'orders.create');")
      && server.includes("fuelTanksRouter.get('/', canReadFuel,"));
    const pv = src('renderer/components/PumpsView.tsx');
    ok('the screen says where the gauges come from (tank levels "As of …" / "Sold on this POS today, against yesterday")',
      pv.includes("{tanksKnown ? `As of ${asOf}` : 'Sold on this POS today, against yesterday'}"));
  }

  console.log('\n5. The keypad');
  {
    const type = (keys, field) => keys.reduce((s, k) => FC.keyIn(s, k, field), '');
    ok('amount: 2 decimals at most, no leading zero, one point', type(['0', '5', '0', '0', '.', '2', '5', '9'], 'amount') === '500.25'
      && type(['.', '5'], 'amount') === '0.5' && type(['1', '.', '.', '2'], 'amount') === '1.2');
    ok('litres: 3 decimals; ⌫ and clear', type(['1', '2', '.', '3', '4', '5', '6'], 'litres') === '12.345'
      && FC.keyIn('12.3', 'back', 'litres') === '12.' && FC.keyIn('12.3', 'clear', 'litres') === '');
    const s = FC.fuelSale('amount', '2000', 184.5);
    ok('KES 2,000 at 184.50 → 10.840 L shown, litres kept at full precision (2000 ÷ 184.5), KES 2,000 exactly',
      s.litres === 2000 / 184.5 && FC.litresText(s.litres) === '10.840 L' && s.amount === 2000);
    const l = FC.fuelSale('litres', '12.5', 184.5);
    ok('12.5 L at 184.50 → KES 2,306.25 (amount = litres × price, the fuel path\'s rule)', l.amount === 2306.25 && l.litres === 12.5 && FC.moneyText(l.amount) === '2,306.25');
    ok('no price → no litres (never a divide by zero)', FC.fuelSale('amount', '500', 0).litres === 0);
    ok('the quick amounts: 500, 1,000, 2,000 — and Full tank (→ litres)', JSON.stringify(FC.QUICK_AMOUNTS) === '[500,1000,2000]'
      && src('renderer/components/PumpsView.tsx').includes("onClick={() => { setField('litres'); setEntry(''); setFullTank(true); }}"));
    const pv = src('renderer/components/PumpsView.tsx'), pos = src('renderer/pages/POSPage.tsx');
    ok('Add to sale hands the litres and the amount to POSPage.addFuelLine — the fuel line as always (quantity = litres, isFuel, pumpId)',
      pv.includes('onAddFuel(active, sale.litres, sale.amount);') && pos.includes('onAddFuel={addFuelLine}')
      && /const addFuelLine = \(pump: Pump, litres: number, amount: number\) => \{[\s\S]{0,700}quantity: litres,[\s\S]{0,200}lineTotal: amount,\s+isFuel: true,\s+pumpId: pump\.id,/.test(pos)
      && pos.includes("order_type: flags.isPetrol ? 'fuel_sale'"));
    ok('a USB numpad works the keypad (digits, ., Backspace, Enter, Escape)', pv.includes("window.addEventListener('keydown', onKey);")
      && pv.includes("else if (e.key === 'Enter') { confirm(); e.preventDefault(); }"));
  }

  console.log('\n6. The bundle (A517): the forecourt loads when opened');
  {
    const pos = src('renderer/pages/POSPage.tsx');
    ok('PumpsView and the branch lookup are lazy (never imported statically)', pos.includes("const PumpsView = lazy(() => import('../components/PumpsView'));")
      && pos.includes("const FindInBranches = lazy(() => import('../components/BranchStockTab').then((m) => ({ default: m.FindInBranches })));")
      && !/^import[^\n]*'\.\.\/components\/(PumpsView|BranchStockTab)'/m.test(pos));
    const susp = (tag) => { const i = pos.indexOf(`<${tag}`); const before = pos.slice(0, i); return i > 0 && before.lastIndexOf('<Suspense') > before.lastIndexOf('</Suspense>'); };
    ok('…each rendered inside a Suspense boundary', susp('PumpsView') && susp('FindInBranches'));
    let vite = null;
    try { vite = await import(pathToFileURL(require.resolve('vite', { paths: [desktop] })).href); } catch { /* not installed */ }
    if (!vite) console.log('  SKIPPED the build check — vite is not installed here (npm ci in apps/desktop)');
    else {
      const out = await vite.build({ root: desktop, configFile: path.join(desktop, 'vite.config.ts'), logLevel: 'silent', build: { write: false, emptyOutDir: false } });
      const output = (Array.isArray(out) ? out[0] : out).output;
      const chunks = output.filter((o) => o.type === 'chunk');
      const main = chunks.find((c) => c.isEntry);
      const mods = (c) => Object.keys(c.modules).map((m) => m.replace(/\\/g, '/'));
      const inMain = (rel) => mods(main).some((m) => m.endsWith(`/src/${rel}`));
      const kb = (main.code.length / 1024).toFixed(1);
      console.log(`  (built: main chunk ${kb} kB; PumpsView ${((chunks.find((c) => c.name === 'PumpsView')?.code.length ?? 0) / 1024).toFixed(1)} kB)`);
      ok('PumpsView is its own chunk — not in the main one (nor the forecourt rules)', !inMain('renderer/components/PumpsView.tsx') && !mods(main).some((m) => m.endsWith('/packages/core/src/forecourt.ts'))
        && chunks.some((c) => c.isDynamicEntry && mods(c).some((m) => m.endsWith('/src/renderer/components/PumpsView.tsx'))));
      ok('the branch lookup (BranchStockTab) is not in the main chunk', !inMain('renderer/components/BranchStockTab.tsx'));
      ok('the POS still in the main chunk (POSPage, the payment, the cart)', ['renderer/pages/POSPage.tsx', 'renderer/components/PaymentModal.tsx', 'renderer/lib/cart.ts'].every(inMain));
      // 2026-10-28: 445 → 452 kB. A605's brand palette (shared/themes.ts) must paint the first screen in the brand's colours
      // and A601's cut-off notice sits on the POS page — 448.9 kB with both; the new Manager / Tech panels stay in their lazy pages.
      ok('the main chunk ≤ 452 kB (449.7 kB before A588; 445 until A605\'s palette)', main.code.length <= 452 * 1024, `${kb} kB`);
    }
  }
} catch (e) {
  ok('the test ran to its end', false, e?.stack ?? String(e));
} finally {
  srvClose();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
