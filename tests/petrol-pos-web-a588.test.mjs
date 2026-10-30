/**
 * petrol-pos-web-a588.test.mjs — A588: the web POS at a petrol station — the shop's items on the grid, the grades as
 * nozzles, a pump's grade and tank level, the fuel entry's Full tank.
 *
 * Owner, 2026-10-24: "FIX the petrol pos shop item, make it feel petrol-like, you can add gauges". The web POS had the
 * till's bug: CashierScreen's grid rule `isPetrol ? is_fuel === true : !is_fuel` showed a petrol station ONLY its fuel,
 * so the forecourt shop's items (oil, water, snacks, car care) could only be scanned.
 *
 *   node --no-warnings tests/petrol-pos-web-a588.test.mjs
 *
 *   G  the grid: CashierScreen's own rule run on a petrol station's catalogue — the shop's items in, fuel out (every
 *      business type); the grades reachable as nozzles (FuelStrip, a petrol station only) → the fuel entry as before.
 *   R  the REAL FuelStrip and PumpGrade rendered (react-dom/server): the grades with their colour and price per litre, the
 *      open pump's grade first; a pump's tank "x L left", red and "Low" under 20 %; no tank linked → no gauge.
 *   F  the fuel entry: 500 / 1,000 / 2,000 and Full tank (→ litres), litres to 3 decimals; the fuel line unchanged.
 *
 * MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted — listed in the A588 report):
 *   - CashierScreen's matchFuel back to `isPetrol ? (p as any).is_fuel === true : !(p as any).is_fuel` → G fails
 *   - PumpGrade drawing a gauge with no tank (capacity 0)                                         → R "no tank" fails
 *   - FuelStrip not putting the open pump's grade first                                            → R "first" fails
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const dashReq = createRequire(path.join(ROOT, 'apps/dashboard/package.json'));
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };

const PRODUCTS = [
  { id: 'f-super', name: 'Super Petrol', base_price: 184.5, is_fuel: true, status: 'active' },
  { id: 'f-diesel', name: 'Diesel', base_price: 171.6, is_fuel: true, status: 'active' },
  { id: 's-oil', name: 'Engine Oil 1L', base_price: 850, is_fuel: false, status: 'active' },
  { id: 's-water', name: 'Water 1L', base_price: 70, status: 'active' },
];

console.log('\nA588 — the web POS at a petrol station\n');
try {
  console.log('G. The grid is the forecourt shop; the grades are nozzles');
  {
    const cs = read('apps/dashboard/src/pages/pos/CashierScreen.tsx');
    const line = cs.match(/const matchFuel = ([^;]+);/);
    ok('CashierScreen has one fuel rule for its grid', !!line);
    const rule = new Function('p', 'isPetrol', `return (${(line?.[1] ?? 'false').replace(/ as any/g, '')});`);
    const grid = (petrol) => PRODUCTS.filter((p) => rule(p, petrol)).map((p) => p.id).join(',');
    ok('a petrol station\'s grid: Engine Oil and Water — no Super or Diesel', grid(true) === 's-oil,s-water', grid(true));
    ok('…and every other business the same', grid(false) === 's-oil,s-water');
    ok('the rule rides with the others', cs.includes("return p.status === 'active' && matchCat && matchMenu && matchSearch && matchFuel && matchDay && matchStock && matchHours;"));
    ok('the nozzles strip shows at a petrol station only, the open pump\'s grade first; a tap → addToCart → the fuel entry',
      /\{isPetrol && \(\s*<FuelStrip grades=\{fuelGrades\.map/.test(cs) && cs.includes('onPick={(g) => addToCart(g as unknown as Product)} />')
      && cs.includes("firstId={pumps.find((p) => p.id === (activeKey ? openOrders[activeKey]?.pumpId : undefined))?.fuel_product_id ?? null}")
      && /if \(\(product as any\)\.is_fuel\) \{\s+setFuelEntry\(product\);/.test(read('apps/dashboard/src/pages/pos/cashier/useCart.ts')));
    ok('the grades: the active fuel products', cs.includes("const fuelGrades = useMemo(() => products.filter((p) => (p as any).is_fuel && p.status === 'active'), [products]);"));
    ok('each pump card names its grade and its tank (the /api/pumps row: fuel_product_id, fuel_tanks)',
      cs.includes('<PumpGrade name={fuelById.get(pump.fuel_product_id ?? \'\')?.name ?? null} productId={pump.fuel_product_id ?? null}')
      && /fuel_tanks\?:/.test(read('apps/dashboard/src/pages/pos/cashier/types.ts'))
      && read('apps/server/src/routes/fueltanks.ts').includes(".select('*, fuel_tanks(id, name, current_level, capacity_litres)')"));
  }

  console.log('\nR. FuelStrip and PumpGrade, rendered');
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-a588-web-'));
    const entry = path.join(tmp, 'entry.tsx');
    fs.writeFileSync(entry, `export { FuelStrip, PumpGrade } from ${JSON.stringify(path.join(ROOT, 'apps/dashboard/src/pages/pos/cashier/Forecourt.tsx').replace(/\\/g, '/'))};
export { createElement } from 'react';
export { renderToStaticMarkup } from 'react-dom/server';`);
    const out = path.join(tmp, 'ui.cjs');
    dashReq('esbuild').buildSync({ entryPoints: [entry], bundle: true, format: 'cjs', platform: 'node', outfile: out, logLevel: 'silent', jsx: 'automatic',
      nodePaths: [path.join(ROOT, 'apps/dashboard/node_modules')], define: { 'process.env.NODE_ENV': '"production"' } });
    const UI = createRequire(import.meta.url)(out);
    const h = UI.createElement, html = (el) => UI.renderToStaticMarkup(el);
    const grades = PRODUCTS.filter((p) => p.is_fuel);
    const strip = html(h(UI.FuelStrip, { grades, currency: 'KES', firstId: 'f-diesel', onPick: () => {} }));
    ok('the strip: both grades with their price per litre, as buttons', (strip.match(/data-testid="fuel-grade"/g) ?? []).length === 2
      && strip.includes('KES 184.50/L') && strip.includes('KES 171.60/L'));
    ok('the open pump\'s grade (Diesel) first, outlined in its colour', strip.indexOf('Diesel') < strip.indexOf('Super Petrol') && strip.includes('border:2px solid #f59e0b'));
    ok('no shop item on the strip', !strip.includes('Engine Oil'));
    ok('no grades (not a petrol catalogue) → nothing drawn', html(h(UI.FuelStrip, { grades: [], currency: 'KES', onPick: () => {} })) === '');
    const low = html(h(UI.PumpGrade, { name: 'Diesel', productId: 'f-diesel', index: 1, tanks: { id: 't1', current_level: '2400', capacity_litres: '15000' } }));
    ok('a pump\'s tank at 16 %: "2,400 L left · Low", red', low.includes('2,400 L left · Low') && low.includes('data-low="1"') && low.includes('width:16%'), low);
    const fine = html(h(UI.PumpGrade, { name: 'Super Petrol', productId: 'f-super', index: 0, tanks: [{ id: 't2', current_level: 6200, capacity_litres: 10000 }] }));
    ok('a tank at 62 %: "6,200 L left", the grade\'s red, not low', fine.includes('6,200 L left') && !fine.includes('Low') && fine.includes('data-low="0"') && fine.includes('background:#dc2626'));
    const none = html(h(UI.PumpGrade, { name: 'Super Petrol', productId: 'f-super', index: 0, tanks: null }));
    const zero = html(h(UI.PumpGrade, { name: 'Super Petrol', productId: 'f-super', index: 0, tanks: { id: 't3', current_level: 10, capacity_litres: 0 } }));
    ok('no tank linked (or one with no capacity) → the grade\'s name, no gauge — no level made up',
      none.includes('Super Petrol') && !none.includes('pump-tank') && !zero.includes('pump-tank'));
  }

  console.log('\nF. The fuel entry');
  {
    const cs = read('apps/dashboard/src/pages/pos/CashierScreen.tsx');
    const FC = await import(pathToFileURL(path.join(ROOT, 'packages/core/src/forecourt.ts')).href);
    ok('500 / 1,000 / 2,000 (the till\'s) and Full tank → litres', JSON.stringify(FC.QUICK_AMOUNTS) === '[500,1000,2000]' && cs.includes('{QUICK_AMOUNTS.map(q => (')
      && cs.includes("onClick={() => { setFuelEdited('litres'); setFuelLitresStr(''); }}>") && cs.includes('Full tank'));
    ok('litres shown to 3 decimals', cs.includes("{litres ? litres.toFixed(3) : '0.000'} {unit}") && cs.includes("(litres ? litres.toFixed(3) : '')"));
    ok('the fuel line as before (addFuelToCart: litres, the amount, isFuel)', cs.includes('addFuelToCart(fuelEntry, litres, amount)')
      && /quantity: litres,[\s\S]{0,120}lineTotal: amount,\s+isFuel: true,/.test(read('apps/dashboard/src/pages/pos/cashier/useCart.ts')));
  }
} catch (e) {
  ok('the test ran to its end', false, e?.stack ?? String(e));
} finally {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
