/**
 * menu-import.test.mjs — A165 slice 2. Proves the pure grouping/validation behind
 * the Upgrades & Spices and Recipe tabs.
 *
 * The load-bearing rules: a FREE choice can't carry a price, and an UPGRADE ladder
 * MUST have a 0 baseline (or it charges every customer the cheapest step). Both are
 * mutation-checked. Recipe: lines grouped per product, positive quantity required,
 * DELETE drops a line.
 *
 * Imports the real built server dist (no DB). Skips if the server isn't built.
 *   node tests/menu-import.test.mjs
 */
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import path from 'node:path';

let pass = 0, fail = 0;
const ok = (l, c) => { if (c) { pass++; console.log(`PASS  ${l}`); } else { fail++; console.log(`FAIL  ${l}`); } };

const dist = path.resolve('apps/server/dist/lib/productImport.js');
if (!existsSync(dist)) { console.log('SKIP  build the server first'); process.exit(0); }
const { buildChoiceImport, buildRecipeImport } = await import(pathToFileURL(dist).href);

// ── Choices: happy paths ──
{
  const r = buildChoiceImport([
    { product: 'Chicken', group: 'Spice level', type: 'free', option: 'Normal', price_added: '0' },
    { product: 'Chicken', group: 'Spice level', type: 'free', option: 'Spicy',  price_added: '0' },
  ]);
  ok('free choice → kind choice, no errors', r.errors.length === 0 && r.groups.length === 1 && r.groups[0].kind === 'choice');
  ok('free choice is required + 2 options', r.groups[0].required === true && r.groups[0].options.length === 2);
}
{
  const r = buildChoiceImport([
    { product: 'Soda', group: 'Drink size', type: 'upgrade', option: '350ml', price_added: '0' },
    { product: 'Soda', group: 'Drink size', type: 'upgrade', option: '500ml', price_added: '20' },
    { product: 'Soda', group: 'Drink size', type: 'upgrade', option: '1.25L', price_added: '130' },
  ]);
  ok('upgrade with 0 baseline → no errors, kind upgrade', r.errors.length === 0 && r.groups[0].kind === 'upgrade');
  ok('upgrade options carry price_adjustment', r.groups[0].options[2].price_adjustment === 130);
  ok('option sort_order preserved', r.groups[0].options[0].sort_order === 0 && r.groups[0].options[1].sort_order === 1);
}

// ── Choices: the two guards ──
{
  const r = buildChoiceImport([{ product: 'Chicken', group: 'Spice', type: 'free', option: 'Spicy', price_added: '50' }]);
  ok('FREE choice WITH a price → error (category error)', r.errors.length === 1 && r.groups.length === 0);
}
{
  const r = buildChoiceImport([
    { product: 'Soda', group: 'Size', type: 'upgrade', option: '500ml', price_added: '20' },
    { product: 'Soda', group: 'Size', type: 'upgrade', option: '1.25L', price_added: '130' },
  ]);
  ok('UPGRADE without a 0 baseline → error (would charge everyone the cheapest step)', r.errors.length === 1 && r.groups.length === 0);
}

// ── Choices: structure + delete + validation ──
ok('missing product → error', buildChoiceImport([{ group: 'X', type: 'free', option: 'A', price_added: '0' }]).errors.length === 1);
ok('missing group → error', buildChoiceImport([{ product: 'P', type: 'free', option: 'A', price_added: '0' }]).errors.length === 1);
ok('bad type → error', buildChoiceImport([{ product: 'P', group: 'G', type: 'combo', option: 'A', price_added: '0' }]).errors.length === 1);
{
  const r = buildChoiceImport([{ product: 'Soda', group: 'Drink size', type: 'upgrade', option: 'DELETE' }]);
  ok('option DELETE → group flagged for deletion', r.groups.length === 1 && r.groups[0].del === true);
}
{
  const r = buildChoiceImport([{ product: 'X', group: 'G', type: 'FREE', option: 'A', price_added: '0' }]);
  ok('type is case-insensitive (FREE → choice)', r.groups[0].kind === 'choice');
}

// ── Recipe ──
{
  const r = buildRecipeImport([
    { product: 'Burger', ingredient: 'Bun', quantity_per_serving: '1', unit: 'pc' },
    { product: 'Burger', ingredient: 'Patty', quantity_per_serving: '1', unit: 'pc' },
    { product: 'Burger', ingredient: 'Lettuce', quantity_per_serving: '20', unit: 'g' },
  ]);
  ok('recipe grouped by product, 3 lines', r.errors.length === 0 && r.products.length === 1 && r.products[0].lines.length === 3);
  ok('recipe line carries qty + unit', r.products[0].lines[2].quantity_per_serving === 20 && r.products[0].lines[2].unit === 'g');
}
ok('recipe: zero quantity → error', buildRecipeImport([{ product: 'B', ingredient: 'X', quantity_per_serving: '0', unit: 'g' }]).errors.length === 1);
ok('recipe: missing quantity → error', buildRecipeImport([{ product: 'B', ingredient: 'X', unit: 'g' }]).errors.length === 1);
ok('recipe: missing ingredient → error', buildRecipeImport([{ product: 'B', quantity_per_serving: '1', unit: 'g' }]).errors.length === 1);
{
  const r = buildRecipeImport([
    { product: 'Burger', ingredient: 'Bun', quantity_per_serving: '1', unit: 'pc' },
    { product: 'Burger', ingredient: 'DELETE' },
  ]);
  ok('recipe: DELETE line dropped (keeps the real line)', r.products[0].lines.length === 1 && r.errors.length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
