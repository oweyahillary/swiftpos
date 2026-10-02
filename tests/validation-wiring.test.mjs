/**
 * A157 — input-validation schemas wired via validateLoose (catchall passthrough),
 * so known fields are validated and unknown fields (device_id, tax fields, …) pass
 * through untouched. Guards the wiring + the de-defaulted UpdateProductSchema.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const r = p => fs.readFileSync(path.join(root, p), 'utf8');

let pass = 0, fail = 0;
const ok = (n, f) => { try { f(); pass++; console.log('PASS ' + n); } catch (e) { fail++; console.log('FAIL ' + n + '\n   ' + e.message); } };

ok('validateLoose validates known fields + passes unknown (catchall)', () => {
  const v = r('apps/server/src/middleware/validate.ts');
  assert.match(v, /export function validateLoose/);
  assert.match(v, /schema\.catchall\(z\.unknown\(\)\)/);
});
ok('login is validated (LoginSchema) without breaking device fields', () => {
  const a = r('apps/server/src/routes/auth.ts');
  assert.match(a, /router\.post\('\/login', validateLoose\(LoginSchema\)/);
});
ok('product create + update are validated', () => {
  const p = r('apps/server/src/routes/products.ts');
  assert.match(p, /validateLoose\(CreateProductSchema\)/);
  assert.match(p, /validateLoose\(UpdateProductSchema\)/);
});
ok('category create is validated', () => {
  assert.match(r('apps/server/src/routes/categories.ts'), /validateLoose\(CreateCategorySchema\)/);
});
ok('UpdateProductSchema has NO defaults (update never injects/resets fields)', () => {
  const s = r('apps/server/src/lib/schemas.ts');
  const block = s.slice(s.indexOf('export const UpdateProductSchema'), s.indexOf('export const UpdateProductSchema') + 600);
  assert.doesNotMatch(block, /\.default\(/);                 // no injected defaults on update
  assert.doesNotMatch(block, /CreateProductSchema\.partial/); // not the default-carrying partial
  assert.match(block, /track_stock:\s+z\.boolean\(\)\.optional\(\)/);
});

ok('A257: api client surfaces field-level validation errors (not just "Validation failed")', () => {
  const api = r('apps/dashboard/src/lib/api.ts');
  assert.match(api, /const fieldErrors = Array\.isArray/);
  assert.match(api, /e\.field \? `\$\{e\.field\}: \$\{e\.message\}` : e\.message/);
  assert.match(api, /new Error\(fieldErrors \|\| json\.error/);
});
ok('A257: category form placeholder is not petrol-specific ("Diesel")', () => {
  const c = r('apps/dashboard/src/pages/products/CategoriesPage.tsx');
  assert.doesNotMatch(c, /e\.g\. Diesel/);
});

console.log(`\n${fail ? '== ' + fail + ' FAILED ==' : 'all green'} (${pass} passed)`);
process.exit(fail ? 1 : 0);
