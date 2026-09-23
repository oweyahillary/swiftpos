/**
 * product-save-payloads.test.mjs — A317: the product schemas accept what the clients actually send.
 *
 *   node tests/product-save-payloads.test.mjs      (needs the server built: run-all builds it first)
 *
 * Why this exists: A157 wired CreateProductSchema/UpdateProductSchema through validateLoose and its test
 * (validation-wiring.test.mjs) only proved the WIRING by regex — no payload ever went through the schema.
 * Every client clears an empty description by sending `null`; the schema allowed a string or absent, not
 * null, so every save of a product with an empty description box failed:
 *   "description: Invalid input: expected string, received null"   (owner's Edit form, 2026-09-23)
 *
 * So this drives the REAL middleware from the built server with the payload each caller builds, in the
 * shape its source builds it (the source lines are pinned below so the two can't drift apart silently),
 * and checks the rejects that must survive, so the fix can't be "accept anything".
 *
 * MUTATIONS TO CONFIRM BITE:
 *   - drop .nullable() from CreateProductSchema.description → the create cases fail
 *   - drop .nullable() from UpdateProductSchema.description → the update cases fail (image 5's)
 *   - loosen description to z.any()                          → "a NUMBER description is still refused" fails
 */
import fs from 'node:fs';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (l, c, d = '') => { if (c) { pass++; console.log(`PASS  ${l}`); } else { fail++; console.log(`FAIL  ${l}  ${d}`); } };

const distSchemas = path.join(ROOT, 'apps/server/dist/lib/schemas.js');
const distValidate = path.join(ROOT, 'apps/server/dist/middleware/validate.js');
if (!existsSync(distSchemas) || !existsSync(distValidate)) {
  // In CI a skip here would be decoration: the server is built before the unit tests there.
  if (process.env.CI) { console.log('FAIL  server dist missing in CI — this test would silently not run'); process.exit(1); }
  console.log('SKIP  build the server first (cd apps/server && npm run build)'); process.exit(0);
}
const { CreateProductSchema, UpdateProductSchema } = await import(pathToFileURL(distSchemas).href);
const { validateLoose } = await import(pathToFileURL(distValidate).href);

// Run the real middleware the way Express does; report the 400 body verbatim.
const run = (schema, body) => {
  let status = 200, sent = null, nexted = false;
  const req = { body: structuredClone(body) };
  const res = { status(c) { status = c; return this; }, json(b) { sent = b; return this; } };
  validateLoose(schema)(req, res, () => { nexted = true; });
  return { passed: nexted && status === 200, status, error: sent && JSON.stringify(sent).slice(0, 160), body: req.body };
};

// The source lines each payload below mirrors — if a caller changes how it sends description,
// this fails and the payload here must be updated to match, rather than testing a shape nobody sends.
const src = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
ok('web Products page still sends an empty description as null',
  /description:\s*form\.description\.trim\(\)\s*\|\|\s*null/.test(src('apps/dashboard/src/pages/products/ProductsPage.tsx')));
ok('till ManageTabs still sends an empty description as null',
  /description:\s*form\.description\?\.trim\(\)\s*\|\|\s*null/.test(src('apps/desktop/src/renderer/pages/ManageTabs.tsx')));
ok('till MenuWorkbench still sends an empty description as null',
  /description:\s*description\.trim\(\)\s*\|\|\s*null/.test(src('apps/desktop/src/renderer/pages/MenuWorkbench.tsx')));

const CAT = '3f0b8f7e-2c1a-4d5e-9f00-1a2b3c4d5e6f';
// web ProductsPage.save — the full object it builds (image 5: a Burger at 881, empty description)
const webEdit = { name: 'Cheese Crispy Burger', description: null, base_price: 881, cost_price: null, category_id: CAT,
  track_stock: false, status: 'active', image_url: null, tax_type: 'B', kra_item_class_code: null,
  sold_by: 'unit', is_fuel: false, fuel_unit: null };
// till ManageTabs.save (create and update send the same object)
const tillManage = { name: 'Rafiki Box', base_price: 2500, category_id: CAT, description: null, track_stock: false };
// till MenuWorkbench.save (update only)
const tillWorkbench = { name: 'Kanka Meal', category_id: CAT, description: null };

{
  const r = run(UpdateProductSchema, webEdit);
  ok('web Edit form, empty description (image 5) → accepted', r.passed, r.error);
  ok('…and null reaches the handler as null (clears the description)', r.passed && r.body.description === null);
}
{ const r = run(CreateProductSchema, webEdit);        ok('web New product, empty description → accepted', r.passed, r.error); }
{ const r = run(CreateProductSchema, tillManage);     ok('till ManageTabs create, empty description → accepted', r.passed, r.error); }
{ const r = run(UpdateProductSchema, tillManage);     ok('till ManageTabs update, empty description → accepted', r.passed, r.error); }
{ const r = run(UpdateProductSchema, tillWorkbench);  ok('till MenuWorkbench update, empty description → accepted', r.passed, r.error); }
{
  const r = run(UpdateProductSchema, { ...webEdit, description: '12pc tender + 4 sauces + large fries + 1L soft drink' });
  ok('a real description still passes unchanged', r.passed && r.body.description.startsWith('12pc tender'), r.error);
}
{ const r = run(UpdateProductSchema, { base_price: 3250 });  ok('a price-only update (inline price edit) → accepted, nothing injected',
    r.passed && Object.keys(r.body).join() === 'base_price', JSON.stringify(r.body)); }

// What must STILL be refused — the fix is "null is a value", not "anything goes".
// Each starts from a payload that PASSES, so a 400 here can only be the field under test
// (built on the null-description payload, these were "refused" for the wrong reason at the tip).
const valid = { ...webEdit, description: 'Crispy fillet, lettuce, house sauce' };
{ const r = run(UpdateProductSchema, valid);  ok('baseline: the valid payload passes (so the refusals below mean something)', r.passed, r.error); }
const refusedFor = (schema, body, field) => { const r = run(schema, body); return r.status === 400 && (r.error || '').includes(`"field":"${field}"`); };
ok('an empty name is still refused', refusedFor(CreateProductSchema, { ...valid, name: '' }, 'name'));
ok('a 501-char description is still refused', refusedFor(UpdateProductSchema, { ...valid, description: 'x'.repeat(501) }, 'description'));
ok('a NUMBER description is still refused', refusedFor(UpdateProductSchema, { ...valid, description: 42 }, 'description'));
ok('a negative price is still refused', refusedFor(UpdateProductSchema, { ...valid, base_price: -1 }, 'base_price'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
