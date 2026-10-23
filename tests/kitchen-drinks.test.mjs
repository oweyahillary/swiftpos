/**
 * kitchen-drinks.test.mjs — A276 (2026-09-28): both printing paths apply the drinks rule to whole LINES.
 *
 * The rule itself is run for real in shared/printing/test/a276-soda-routing.test.ts. This pins that the two places that
 * build ticket lines — the till (escposBridge.printSale) and the web POS (printRouted.ts, through the committed bundle)
 * — strip the kitchen from an excluded LINE, not only from its units, and use the built-in drinks terms plus the
 * owner's own. Runs the committed web bundle to prove the functions it ships are the shared ones.
 *
 *   node tests/kitchen-drinks.test.mjs
 *
 * MUTATION TO CONFIRM BITE: either caller back to `stationIds: lineStationIds` → its pin fails. A559: the bundle rebuilt with
 * the modifier on ids.dispatch only → "the committed web bundle prints an extra on the KITCHEN ticket" fails.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = (n, f) => { try { f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };

const bridge = read('apps/desktop/src/main/escposBridge.ts');
ok('till: the LINE\'s stations lose the kitchen when excluded; units too; built-in drinks + owner terms', () => {
  assert.match(bridge, /const excluded = kitchenExclusionTerms\(kitchenExclusions\(\)\);/);
  assert.match(bridge, /stationIds: stripKitchenIfExcluded\(l\.product\.name, lineStationIds, ids, excluded\),/);
  assert.match(bridge, /stationIds: stripKitchenIfExcluded\(u\.name, u\.stationIds, ids, excluded\)/);
});
const web = read('apps/dashboard/src/lib/printRouted.ts');
ok('web POS: the same, line and units', () => {
  assert.match(web, /const exc = kitchenExclusionTerms\(a\.kitchenExclusions \?\? \[\]\);/);
  assert.match(web, /stationIds: stripKitchenIfExcluded\(item\.product\?\.name \?\? 'Item', lineStationIds, ids, exc\),/);
  assert.match(web, /stationIds: stripKitchenIfExcluded\(u\.name, u\.stationIds, ids, exc\)/);
});
const E = await import(pathToFileURL(path.join(ROOT, 'apps/dashboard/src/lib/escposRenderer.js')).href);
ok('the committed web bundle ships the rule: a soda loses the kitchen, BBQ-sauce wings keep it', () => {
  const ids = { kitchen: ['k'], dispatch: ['d'] };
  const terms = E.kitchenExclusionTerms([]);
  assert.deepEqual(E.stripKitchenIfExcluded('Soda 500ml', ['k'], ids, terms), []);
  assert.deepEqual(E.stripKitchenIfExcluded('Wings in BBQ Sauce', ['k'], ids, terms), ['k']);
  // A358: a standalone sauce leaves the kitchen on the web too.
  assert.deepEqual(E.stripKitchenIfExcluded('Honey Mustard Sauce', ['k', 'd'], ids, terms), ['d']);
  assert.deepEqual(E.stripKitchenIfExcluded('Chocolate Shake', ['k', 'd'], ids, E.kitchenExclusionTerms(['shake'])), ['d']);
});
ok('A559: the committed web bundle prints an extra on the KITCHEN ticket ("+ Extra Cheese"), with the notes', () => {
  // As printRouted builds a line: toUnits, then each unit and the line stripped by the exclusions.
  const ids = { kitchen: ['k'], dispatch: ['d'] };
  const routing = { byCategory: { food: ['k'] }, kitchenCategories: new Set() };
  const terms = E.kitchenExclusionTerms([]);
  const lineIds = E.stationsForCategory('food', ids, routing);
  const routable = { product: { id: 'p', name: 'Wings', category_id: 'food' }, selectedModifiers: [{ name: 'Extra Cheese', price: 50 }] };
  const units = E.toUnits(routable, ids, lineIds, routing).map((u) => ({ ...u, stationIds: E.stripKitchenIfExcluded(u.name, u.stationIds, ids, terms) }));
  assert.deepEqual(units[0].stationIds, ['k', 'd']);
  const order = { billNumber: 'W-1', orderType: 'takeaway', cashierName: 'Cate', soldAt: new Date().toISOString(), payments: [], changeGiven: 0,
    total: 60000, kotCount: 0, note: 'Allergy: nuts',
    lines: [{ name: 'Wings', quantity: 1, unitPrice: 60000, lineTotal: 60000, stationIds: E.stripKitchenIfExcluded('Wings', lineIds, ids, terms), units, note: 'Well done' }] };
  const biz = { name: 'B FOODS', currencyCode: 'KES', vatRate: 16, ctlRate: 0 };
  const station = { id: 'k', type: 'kitchen', paperWidthMm: 80 };
  assert.equal(E.stationHasContent(order, biz, station), true);
  const text = Buffer.from(E.renderStationEscPos(order, biz, station)).toString('latin1');
  for (const want of ['WINGS', '+ Extra Cheese', '** Well done', 'NOTE: Allergy: nuts', '1 items to cook']) assert.ok(text.includes(want), want);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
