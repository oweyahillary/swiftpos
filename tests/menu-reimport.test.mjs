/**
 * menu-reimport.test.mjs — 2026-10-04: uploading the same menu again UPDATES what is there; it never adds a second copy.
 *
 * Owner: "if i upload the same product it reuploads the same product it does not check if the product exist" — then
 * "the variants were added on the same product which were there". The choices import looked a group up by its EXACT
 * name with maybeSingle: "Drink size" ≠ "Drink Size", and once a product held two groups of one name maybeSingle
 * errored, was read as "none", and every upload added ANOTHER.
 *
 *   node tests/menu-reimport.test.mjs          (build apps/server first — this runs its dist/)
 *
 * RUNS the COMPILED products and variants routers behind the real auth middleware over HTTP (database in memory).
 *
 * MUTATIONS TO CONFIRM BITE: importKey back to trim().toLowerCase() → "hidden and double spaces" fails; the variants
 * lookup back to the exact name → "a group named in another case" fails; duplicates not removed → "heals" fails; the
 * active-first sort dropped → "an archived copy is never the one updated" fails.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'apps/server/dist');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };

if (!fs.existsSync(path.join(DIST, 'routes/variants.js'))) {
  console.log('\nCannot load apps/server/dist/routes/variants.js — build the server first:\n  cd apps/server && npm run build\n');
  process.exit(1);
}
process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
process.env.JWT_SECRET = randomBytes(24).toString('hex');
process.env.ADMIN_JWT_SECRET ??= randomBytes(24).toString('hex');
process.env.SUPABASE_JWT_SECRET ??= randomBytes(24).toString('hex');
const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const { supabase } = require(path.join(DIST, 'lib/supabase.js'));

const BZ = '11111111-1111-4111-8111-111111111111', U = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const db = { products: [], categories: [], variant_groups: [], variant_options: [] };
let seq = 0, clock = 0;
const nextId = () => `id-${++seq}`;
const stamp = () => new Date(Date.UTC(2026, 9, 4, 0, 0, clock++)).toISOString();

// A small PostgREST stand-in: select / eq / order / range / insert (one or many) / update / delete / single.
supabase.from = (table) => {
  const filters = []; let op = 'select', payload = null, ordering = null, window = null, inserted = null;
  const matching = () => (db[table] ??= []).filter((r) => filters.every(([k, v]) => r[k] === v));
  const run = () => {
    if (op === 'insert') return { data: inserted, error: null };
    if (op === 'update') { matching().forEach((r) => Object.assign(r, payload)); return { data: null, error: null }; }
    if (op === 'delete') { const gone = new Set(matching()); db[table] = db[table].filter((r) => !gone.has(r)); return { data: null, error: null }; }
    let rows = matching().slice();
    if (ordering) rows.sort((a, b) => String(a[ordering]).localeCompare(String(b[ordering])));
    if (window) rows = rows.slice(window[0], window[1] + 1);
    return { data: rows, error: null };
  };
  const q = new Proxy({}, {
    get(_t, p) {
      if (p === 'select') return () => q;
      if (p === 'eq') return (k, v) => { filters.push([k, v]); return q; };
      if (p === 'order') return (k) => { ordering = k; return q; };
      if (p === 'range') return (a, b) => { window = [a, b]; return q; };
      if (p === 'insert') return (rows) => {
        op = 'insert';
        const list = (Array.isArray(rows) ? rows : [rows]).map((r) => ({ id: nextId(), created_at: stamp(), ...r }));
        (db[table] ??= []).push(...list); inserted = Array.isArray(rows) ? list : list[0];
        return q;
      };
      if (p === 'update') return (patch) => { op = 'update'; payload = patch; return q; };
      if (p === 'delete') return () => { op = 'delete'; return q; };
      if (p === 'single' || p === 'maybeSingle') return () => {
        const r = run(); const d = Array.isArray(r.data) ? r.data[0] ?? null : r.data;
        return Promise.resolve({ data: d, error: null });
      };
      if (p === 'then') return (res, rej) => Promise.resolve(run()).then(res, rej);
      return () => q;
    },
  });
  return q;
};
supabase.rpc = async () => ({ data: null, error: null });

const express = require('express'); const jwt = require('jsonwebtoken');
const app = express(); app.use(express.json());
app.use('/api/products', require(path.join(DIST, 'routes/products.js')).default);
app.use('/api/variants', require(path.join(DIST, 'routes/variants.js')).default);
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const token = jwt.sign({ userId: U, businessId: BZ, isOwner: true, permissionKeys: ['*'], permissionsVersion: 0, sessionId: 's', surface: 'web' },
  process.env.JWT_SECRET);
const post = async (url, rows) => {
  const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ rows }) });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const named = (n) => db.products.filter((p) => p.name.toLowerCase().replace(/\s+/g, ' ') === n.toLowerCase());
const groupsOf = (pid, n) => db.variant_groups.filter((g) => g.product_id === pid && g.name.toLowerCase() === n.toLowerCase());

const MENU = [
  { name: 'Chicken Burger', category: 'Burgers', price: 390 },
  { name: 'Soda', category: 'Soft Drinks', price: 100 },
];
const CHOICES = [
  { product: 'Soda', group: 'Drink size', type: 'upgrade', option: '350ml', price_added: 0 },
  { product: 'Soda', group: 'Drink size', type: 'upgrade', option: '1.25L', price_added: 130 },
];

try {
  await ok('the first upload adds the products, and says which are new', async () => {
    const r = await post('/api/products/bulk', MENU);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.created, 2); assert.deepEqual(r.body.created_names, ['Chicken Burger', 'Soda']);
  });
  await ok('the same file again UPDATES — no second product', async () => {
    const r = await post('/api/products/bulk', [{ ...MENU[0], price: 420 }, MENU[1]]);
    assert.equal(r.body.created, 0); assert.equal(r.body.updated, 2); assert.deepEqual(r.body.created_names, []);
    assert.equal(named('Chicken Burger').length, 1); assert.equal(named('Chicken Burger')[0].base_price, 420);
  });
  await ok('hidden and double spaces, and capitals, are the same product (Excel / WhatsApp copies)', async () => {
    const r = await post('/api/products/bulk', [{ name: 'chicken  BURGER​', price: 450 }, { name: ' SODA ', price: 110 }]);
    assert.equal(r.body.created, 0, JSON.stringify(r.body)); assert.equal(r.body.updated, 2);
    assert.equal(db.products.length, 2);
  });
  await ok('a category spelled with another case or spacing is not created twice', async () => {
    await post('/api/products/bulk', [{ name: 'Fanta', category: 'soft  drinks', price: 100 }]);
    assert.equal(db.categories.filter((c) => c.name.toLowerCase().replace(/\s+/g, ' ') === 'soft drinks').length, 1);
  });
  await ok('an archived copy is never the one updated: the ACTIVE product of that name is', async () => {
    db.products.push({ id: 'old-wings', business_id: BZ, name: 'Wings', status: 'inactive', base_price: 1, created_at: '2026-01-01T00:00:00Z' });
    db.products.push({ id: 'live-wings', business_id: BZ, name: 'Wings', status: 'active', base_price: 2, created_at: '2026-02-01T00:00:00Z' });
    await post('/api/products/bulk', [{ name: 'Wings', price: 650 }]);
    assert.equal(db.products.find((p) => p.id === 'live-wings').base_price, 650);
    assert.equal(db.products.find((p) => p.id === 'old-wings').base_price, 1);
  });

  const soda = () => named('Soda')[0].id;
  await ok('choices: the first upload adds the group with its options', async () => {
    const r = await post('/api/variants/bulk', CHOICES);
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.created, 1);
    assert.equal(groupsOf(soda(), 'Drink size').length, 1);
    assert.equal(db.variant_options.filter((o) => o.variant_group_id === groupsOf(soda(), 'Drink size')[0].id).length, 2);
  });
  await ok('choices: the same upload again UPDATES the group — no second group, no doubled options', async () => {
    const r = await post('/api/variants/bulk', CHOICES);
    assert.equal(r.body.created, 0); assert.equal(r.body.updated, 1);
    const g = groupsOf(soda(), 'Drink size'); assert.equal(g.length, 1);
    assert.equal(db.variant_options.filter((o) => o.variant_group_id === g[0].id).length, 2);
  });
  await ok('choices: a group named in another case or spacing is the same group', async () => {
    const r = await post('/api/variants/bulk', CHOICES.map((c) => ({ ...c, product: 'soda', group: 'DRINK  SIZE' })));
    assert.equal(r.body.created, 0, JSON.stringify(r.body));
    assert.equal(db.variant_groups.filter((g) => g.product_id === soda()).length, 1);
  });
  await ok('choices: copies an earlier upload left are removed — a re-upload heals the duplicates (the owner\'s case)', async () => {
    const extra = { id: 'dup-1', product_id: soda(), name: 'Drink size', kind: 'upgrade', required: false, sort_order: 0, shared: false, combo_item_id: null, created_at: stamp() };
    db.variant_groups.push(extra, { ...extra, id: 'dup-2', created_at: stamp() });
    db.variant_options.push({ id: 'o-d1', variant_group_id: 'dup-1', name: '350ml' }, { id: 'o-d2', variant_group_id: 'dup-2', name: '350ml' });
    const r = await post('/api/variants/bulk', CHOICES);
    assert.equal(r.body.merged, 2, JSON.stringify(r.body));
    assert.equal(groupsOf(soda(), 'Drink size').length, 1);
    assert.ok(!db.variant_options.some((o) => o.variant_group_id === 'dup-1' || o.variant_group_id === 'dup-2'));
  });
  await ok('choices: a SHARED group of the same name is never touched', async () => {
    db.variant_groups.push({ id: 'shared-1', product_id: soda(), name: 'Drink size', shared: true, combo_item_id: null, created_at: stamp() });
    await post('/api/variants/bulk', CHOICES);
    assert.ok(db.variant_groups.some((g) => g.id === 'shared-1'));
  });
  await ok('choices: DELETE removes the group and every copy of it', async () => {
    db.variant_groups.push({ id: 'dup-3', product_id: soda(), name: 'drink size', shared: false, combo_item_id: null, created_at: stamp() });
    const r = await post('/api/variants/bulk', [{ product: 'Soda', group: 'Drink size', type: 'upgrade', option: 'DELETE' }]);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(db.variant_groups.filter((g) => g.product_id === soda() && !g.shared).length, 0, JSON.stringify(r.body));
  });
} finally { server.close(); }

await ok('the screens show added and updated apart, and name the new products', () => {
  const m = fs.readFileSync(path.join(ROOT, 'apps/dashboard/src/pages/products/MenuUpload.tsx'), 'utf8');
  assert.match(m, /\{added\} added · \{updated\} updated/);
  assert.match(m, /New: \{r\.created_names\.slice\(0, 12\)\.join\(', '\)\}/);
  assert.match(fs.readFileSync(path.join(ROOT, 'apps/dashboard/src/pages/products/BulkProductImport.tsx'), 'utf8'), /importResult\.created_names/);
  const t = fs.readFileSync(path.join(ROOT, 'apps/desktop/src/renderer/pages/ManageTabs.tsx'), 'utf8');
  assert.match(t, /for \(const clash of clashes\) await posApi\.manage\.deleteVariantGroup\(clash\.id\);/);
  assert.match(t, /for \(const clash of clashes\) await posApi\.manage\.deleteModifierGroup\(clash\.id\);/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
