/**
 * product-import.test.mjs — A165, single-upload menu importer.
 *
 * Proves buildProductPatch, the sparse patch behind "upload only the columns you
 * want to change." The failure mode is CATALOGUE DATA LOSS: the old importer
 * rebuilt the whole row, so a missing column wiped that field. So the asserts
 * target exactly that — an absent column and a blank cell must be OMITTED from
 * the patch (field left alone), DELETE must clear, and price must be required
 * only on create. Those are mutation-checked.
 *
 * Imports the real built server dist (no DB). Skips if the server isn't built.
 *   node tests/product-import.test.mjs
 */
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import path from 'node:path';

let pass = 0, fail = 0;
const ok = (l, c) => { if (c) { pass++; console.log(`PASS  ${l}`); } else { fail++; console.log(`FAIL  ${l}`); } };
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

const dist = path.resolve('apps/server/dist/lib/productImport.js');
if (!existsSync(dist)) { console.log('SKIP  build the server first'); process.exit(0); }
const { buildProductPatch, rowMatchKeys } = await import(pathToFileURL(dist).href);

const upd = { isCreate: false, categoryProvided: false, categoryId: null };
const cre = { isCreate: true,  categoryProvided: false, categoryId: null };

// ── The core sparse guarantee ──
{
  const r = buildProductPatch({ name: 'Soda', price: '120' }, upd);
  ok('update: only name+price present → patch has base_price', r.patch && r.patch.base_price === 120);
  ok('update: absent description → OMITTED (not wiped)', r.patch && !has(r.patch, 'description'));
  ok('update: absent cost_price → OMITTED', r.patch && !has(r.patch, 'cost_price'));
  ok('update: absent category → category_id NOT touched', r.patch && !has(r.patch, 'category_id'));
}
{
  // A column present in the file but blank on this row must also be left alone.
  const r = buildProductPatch({ name: 'Soda', price: '120', description: '', cost_price: '  ' }, upd);
  ok('update: blank description cell → OMITTED (leave alone)', r.patch && !has(r.patch, 'description'));
  ok('update: blank cost_price cell → OMITTED', r.patch && !has(r.patch, 'cost_price'));
}
{
  const r = buildProductPatch({ name: 'Soda', description: 'DELETE', cost_price: 'DELETE' }, upd);
  ok('DELETE description → set null (clear)', r.patch && r.patch.description === null);
  ok('DELETE cost_price → set null', r.patch && r.patch.cost_price === null);
}

// ── price required only on create ──
ok('create without price → error', 'error' in buildProductPatch({ name: 'New Item' }, cre));
ok('update without price → OK (no error)', 'patch' in buildProductPatch({ name: 'New Item' }, upd));
ok('create with price → OK', 'patch' in buildProductPatch({ name: 'New Item', price: '300' }, cre));
ok('create without name → error', 'error' in buildProductPatch({ price: '300' }, cre));

// ── validation ──
ok('negative price → error', 'error' in buildProductPatch({ name: 'X', price: '-5' }, upd));
ok('non-numeric price → error', 'error' in buildProductPatch({ name: 'X', price: 'abc' }, upd));
ok('bad sold_by → error', 'error' in buildProductPatch({ name: 'X', sold_by: 'litres' }, upd));
ok('bad tax_type → error', 'error' in buildProductPatch({ name: 'X', tax_type: 'Z' }, upd));
ok('bad source → error', 'error' in buildProductPatch({ name: 'X', source: 'homemade' }, upd));
{
  const r = buildProductPatch({ name: 'X', sold_by: 'WEIGHT', tax_type: 'b', source: 'central_kitchen', is_kitchen: 'yes', track_stock: 'no' }, upd);
  ok('sold_by normalised to lowercase', r.patch && r.patch.sold_by === 'weight');
  ok('tax_type normalised to uppercase', r.patch && r.patch.tax_type === 'B');
  ok('is_kitchen yes → true', r.patch && r.patch.is_kitchen === true);
  ok('track_stock no → false', r.patch && r.patch.track_stock === false);
}

// ── friendly aliases + category ──
{
  const r = buildProductPatch({ name: 'X', base_price: '90' }, upd);
  ok('base_price alias accepted', r.patch && r.patch.base_price === 90);
}
{
  const r = buildProductPatch({ name: 'X', price: '90' }, { isCreate: false, categoryProvided: true, categoryId: 'cat-1' });
  ok('categoryProvided → category_id set from caller', r.patch && r.patch.category_id === 'cat-1');
}

// ── match keys (rename-safe) ──
{
  const k = rowMatchKeys({ name: 'Soda', plu_code: 'SODA', barcode: '' });
  ok('match keys: barcode blank omitted, plu + name kept', k.barcode === undefined && k.plu === 'SODA' && k.name === 'Soda');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
