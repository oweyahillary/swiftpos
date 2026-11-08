/**
 * forecourt-shared.test.mjs — one forecourt for both POS (owner, 2026-11-04: "6 yes" — the web POS takes the desktop's
 * dispensers, gauges and fuel keypad, built once in packages/ui and used by both, keeping the web's phone layout usable).
 *
 *   node --no-warnings tests/forecourt-shared.test.mjs
 *
 *   O  once: @zaptill/ui FuelKeypad and Pumps (GradeGauge, Dispenser) are imported by the desktop's PumpsView and the web's
 *      CashierScreen; no app keeps a keypad, a gauge or a dispenser of its own; packages/ui holds no class names (each
 *      app's look is in its own file).
 *   K  the REAL FuelKeypad rendered (react-dom/server) in each app's look: Amount / Litres, 500 / 1,000 / 2,000, Full tank,
 *      the number pad, Add to sale off until something is entered; the grade's own unit on the web (fuel_unit).
 *   P  the phone: the web's gauges and dispensers in a grid that fits two to a phone's width; the keypad's card fits it.
 *
 * MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted):
 *   - FuelKeypad's Add without `disabled={!ready}`                          → K "Add to sale off"
 *   - CashierScreen keeping its own Amount / Litres inputs (fuelAmountStr)   → O "no app keeps a keypad"
 *   - the web's dispenser grid at minmax(200px, …)                          → P "two to a phone's width"
 *   - addPumpFuel opening a new sale even when the pump has one             → T "only when it has none"
 *
 *   T  a pump tapped on the web (owner, 2026-11-05): the keypad for its grade straight away, as on the desktop; the pump's
 *      sale opens and the pump is activated only when fuel is added; closing the keypad leaves nothing behind.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const dashReq = createRequire(path.join(ROOT, 'apps/dashboard/package.json'));
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${String(d).slice(0, 800)}`); fail++; } };

try {
  console.log('\nO. Once');
  const pv = read('apps/desktop/src/renderer/components/PumpsView.tsx');
  const cs = read('apps/dashboard/src/pages/pos/CashierScreen.tsx');
  const web = read('apps/dashboard/src/pages/pos/cashier/Forecourt.tsx');
  const kp = read('packages/ui/src/FuelKeypad.tsx'), pumps = read('packages/ui/src/Pumps.tsx');
  ok('the desktop\'s PumpsView uses the shared keypad, gauge and dispenser',
    pv.includes("import FuelKeypad, { type FuelKeypadLook } from '@zaptill/ui/FuelKeypad';")
    && pv.includes("import { GradeGauge as SharedGauge, Dispenser as SharedDispenser, type GradeGaugeLook, type DispenserLook } from '@zaptill/ui/Pumps';")
    && pv.includes('<FuelKeypad ') && pv.includes('<SharedGauge ') && pv.includes('<SharedDispenser '));
  ok('the web POS uses the same three', cs.includes("import FuelKeypad from '@zaptill/ui/FuelKeypad';") && cs.includes("import { GradeGauge, Dispenser } from '@zaptill/ui/Pumps';")
    && cs.includes('<FuelKeypad look={KEYPAD_LOOK}') && cs.includes('<GradeGauge key={g.id}') && cs.includes('<Dispenser key={pump.id} look={DISPENSER_LOOK}'));
  ok('no app keeps a keypad, a gauge or a dispenser of its own', ![pv, cs, web].some((t) => /keyIn\(|QUICK_AMOUNTS\.map|fuelAmountStr|fuelLitresStr|M 10 50 A 40 40/.test(t))
    && !/fuelEdited|fuelAmountStr/.test(read('apps/dashboard/src/pages/pos/cashier/useCart.ts')));
  ok('packages/ui holds no class names (each app\'s look lives in its own file)', !/className=["{`]/.test(kp) && !/className=["{`]/.test(pumps));
  ok('the rules stay in packages/core (keyIn, fuelSale, pumpState, gradeGauge)', kp.includes("import { QUICK_AMOUNTS, keyIn, fuelSale, litresText, moneyText, type FuelField } from '@zaptill/core/forecourt';")
    && cs.includes("import { gradeColour, gradeGauge, pumpState } from '@zaptill/core/forecourt';"));

  console.log('\nK. The keypad, rendered in each app\'s look');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-forecourt-'));
  const entry = path.join(tmp, 'entry.tsx');
  const at = (p) => JSON.stringify(path.join(ROOT, p).replace(/\\/g, '/'));
  fs.writeFileSync(entry, `export { default as FuelKeypad } from ${at('packages/ui/src/FuelKeypad.tsx')};
export { KEYPAD_LOOK } from ${at('apps/dashboard/src/pages/pos/cashier/Forecourt.tsx')};
export { createElement } from 'react';
export { renderToStaticMarkup } from 'react-dom/server';`);
  const out = path.join(tmp, 'ui.cjs');
  dashReq('esbuild').buildSync({ entryPoints: [entry], bundle: true, format: 'cjs', platform: 'node', outfile: out, logLevel: 'silent', jsx: 'automatic',
    nodePaths: [path.join(ROOT, 'apps/dashboard/node_modules')], define: { 'process.env.NODE_ENV': '"production"' } });
  const UI = createRequire(import.meta.url)(out);
  const h = UI.createElement, html = (el) => UI.renderToStaticMarkup(el);
  const pad = html(h(UI.FuelKeypad, { title: 'Pump 2', grade: 'Diesel', colour: '#f59e0b', price: 171.6, currency: 'KES', onAdd: () => {}, onClose: () => {}, look: UI.KEYPAD_LOOK }));
  ok('Amount (KES) / Litres', pad.includes('Amount (KES)') && pad.includes('>Litres<'), pad);
  ok('500 / 1,000 / 2,000 and Full tank', (pad.match(/data-testid="fuel-quick"/g) ?? []).length === 3 && pad.includes('>1,000<') && pad.includes('>2,000<') && pad.includes('data-testid="fuel-full-tank"'));
  ok('the number pad: 0–9, the point and delete', ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', 'back'].every((k) => pad.includes(`data-testid="fuel-key-${k}"`)));
  ok('the pump, its grade in its colour and the price per litre', pad.includes('Pump 2') && pad.includes('color:#f59e0b') && pad.includes('KES 171.60/L'));
  ok('Add to sale is off until something is entered', /<button[^>]*disabled=""[^>]*data-testid="fuel-add"|<button[^>]*data-testid="fuel-add"[^>]*disabled=""/.test(pad), pad.slice(pad.indexOf('fuel-add') - 300, pad.indexOf('fuel-add') + 100));
  const kg = html(h(UI.FuelKeypad, { title: 'LPG', grade: 'LPG', colour: '#22c55e', price: 300, currency: 'KES', unit: 'kg', onAdd: () => {}, onClose: () => {}, look: UI.KEYPAD_LOOK }));
  ok('a grade sold in another unit (the web\'s fuel_unit) says so', kg.includes('KES 300.00/kg') && kg.includes('>kg<') && !kg.includes('>Litres<'));

  console.log('\nP. The phone');
  ok('the web\'s gauges and dispensers: a grid that fits two to a 360 px phone (≤ 170 px a column)',
    cs.includes("gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))'") && cs.includes("gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))'"));
  ok('the keypad\'s card fits a phone (92 % of the width, scrolls when short)', /card: \{ className: 'animate-pop-in', style: \{ width: '92vw', maxWidth: 420, maxHeight: '94vh', overflowY: 'auto'/.test(web));
  ok('the web\'s product tile and its fuel nozzles stay as they are', cs.includes('<FuelStrip grades={fuelGrades.map') && cs.includes('data-testid="product-card"'));

  console.log('\nT. A pump tapped (owner, 2026-11-05: the desktop\'s way on the web)');
  const fn = (name) => { const i = cs.indexOf(`function ${name}(`); return i < 0 ? '' : cs.slice(i, cs.indexOf('\n  }\n', i)); };
  const tap = fn('onPumpTap'), add = fn('addPumpFuel'), shut = fn('closeFuelKeypad');
  ok('a pump with a priced grade opens the keypad for that grade — no Activate question first',
    /if \(grade && Number\(grade\.base_price\) > 0\) \{\s*setKeypadPump\(pump\);\s*setFuelEntry\(grade\);\s*return;/.test(tap)
      && tap.indexOf('setFuelEntry(grade)') < tap.indexOf('setShowPumpModal(true)'), tap);
  ok('a pump already on a sale switches to that sale before the keypad opens', tap.indexOf('setActiveKey(key)') > -1 && tap.indexOf('setActiveKey(key)') < tap.indexOf('setFuelEntry(grade)'), tap);
  ok('the pump\'s sale opens (and the pump is activated) only when fuel is added, and only when it has none',
    /if \(keypadPump && !saleOfPump\(keypadPump\.id\)\) openPumpSale\(keypadPump\);\s*addFuelToCart\(grade, litres, amount\);/.test(add), add);
  ok('closing the keypad leaves no sale and no activated pump', shut.includes('setKeypadPump(null)') && !/openPumpSale|activate/.test(shut), shut);
  ok('the keypad adds through the pump\'s path', cs.includes('onAdd={(litres, amount) => addPumpFuel(fuelEntry, litres, amount)} onClose={closeFuelKeypad}'));
} catch (e) {
  ok('the test ran to its end', false, e?.stack ?? String(e));
} finally {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
