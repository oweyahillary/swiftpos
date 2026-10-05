/**
 * combo-stock.test.mjs — A400: a combo (set meal) uses up what is in it — stock, recipes, food cost.
 *
 * Owner, 2026-10-05: recipes and ingredient stock — selling a Family Meal takes away its burgers, fries and soda, and
 * the food-cost report shows what it really cost. lib/comboStock.ts runs for real; stockEffects and the report pinned.
 *
 * MUTATIONS TO CONFIRM BITE: expandComboLines not multiplying by the combo's quantity → "2 Family Meals" fails;
 * usageWithCombos ignoring combos → "burgers used inside combos" fails; servingCost leaving out the items → "a combo's
 * serving cost" fails; stockEffects not expanding → its pin fails.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };
const C = await import(pathToFileURL(path.join(ROOT, 'apps/server/src/lib/comboStock.ts')).href);

// Family Corner: 1 pizza, 1 coleslaw, 2 large fries, 2 chicken burgers, 1 L soda
const ITEMS = [
  { combo_id: 'family', product_id: 'pizza', quantity: 1 }, { combo_id: 'family', product_id: 'coleslaw', quantity: 1 },
  { combo_id: 'family', product_id: 'fries-l', quantity: 2 }, { combo_id: 'family', product_id: 'burger', quantity: 2 },
  { combo_id: 'family', product_id: 'soda-1l', quantity: '1' },
];

await ok('2 Family Meals sold → the combo line stays, and its items are used ×2', () => {
  const out = C.expandComboLines([{ productId: 'family', quantity: 2, variants: [] }, { productId: 'burger', quantity: 1 }], ITEMS);
  assert.deepEqual(out.map((l) => [l.productId, l.quantity]), [
    ['family', 2], ['pizza', 2], ['coleslaw', 2], ['fries-l', 4], ['burger', 4], ['soda-1l', 2], ['burger', 1],
  ]);
  assert.deepEqual(C.expandComboLines([{ productId: 'burger', quantity: 3 }], ITEMS).length, 1, 'not a combo → untouched');
  assert.equal(C.expandComboLines([{ productId: 'loop', quantity: 1 }], [{ combo_id: 'loop', product_id: 'loop', quantity: 1 }]).length, 1, 'a combo containing itself is not opened');
});
await ok('burgers used inside combos count for the ingredients (usage = alone + in combos)', () => {
  assert.deepEqual(C.usageWithCombos({ family: 3, burger: 5 }, ITEMS), { family: 3, burger: 11, pizza: 3, coleslaw: 3, 'fries-l': 6, 'soda-1l': 3 });
});
await ok('a combo\'s serving cost is its own recipe plus its items\'; a product\'s is its recipe; none → unknown', () => {
  const own = { burger: 180, 'fries-l': 60, pizza: 300, family: 20 };   // coleslaw and soda have no recipe cost
  assert.equal(C.servingCost('family', own, ITEMS), 20 + 300 + 2 * 60 + 2 * 180);
  assert.equal(C.servingCost('burger', own, ITEMS), 180);
  assert.equal(C.servingCost('soda-1l', own, ITEMS), null);
  assert.equal(C.servingCost('family', {}, ITEMS), null);
});
await ok('every sale path deducts a combo\'s items (stockEffects expands before deducting)', () => {
  const s = read('apps/server/src/lib/stockEffects.ts');
  assert.match(s, /from\('combo_items'\)\.select\('combo_id, product_id, quantity'\)\.in\('combo_id', ids\);\n\s+if \(items\?\.length\) lines = expandComboLines\(params\.lines, items as ComboItem\[\]\) as StockLine\[\];/);
  assert.ok(s.indexOf('expandComboLines(') < s.indexOf('// 6a. Product-level stock'), 'expanded before any deduction');
});
await ok('the food-cost report counts combos: ingredients by usage, a combo\'s cost from its items', () => {
  const r = read('apps/server/src/routes/reports.ts');
  assert.match(r, /const usage = usageWithCombos\(/);
  assert.match(r, /const used = usage\[recipe\.product_id\];/);
  assert.match(r, /const per = servingCost\(id, ownCost, comboItems\);/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
