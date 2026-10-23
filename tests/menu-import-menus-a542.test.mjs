/**
 * menu-import-menus-a542.test.mjs — A542: the Menu upload's Products tab takes an optional `menu` column.
 *
 * A537 put menus (Food, Soft drinks, Alcohol, Tea …) above the categories — one menu per category. The upload's `menu`
 * column puts the row's CATEGORY in the menu named (a menu not there yet is created — this business's, a clean name,
 * the menu.edit permission the menus routes ask); blank leaves the category's menu alone; DELETE takes the category out
 * of its menu; two rows of one category naming different menus — the first wins, the later row is refused.
 *
 *   node tests/menu-import-menus-a542.test.mjs          (build apps/server first — this runs its dist/)
 *
 * RUNS the COMPILED products router behind the real auth middleware over HTTP (database in memory).
 *
 * MUTATIONS TO CONFIRM BITE: the menu lookup without .eq('business_id') → "another business's menu" fails; the clash
 * check dropped (menuRowError never set on a clash) → "a clash" fails; DELETE read as a menu name → "DELETE" fails;
 * the unchanged skip dropped → "unchanged" fails; the product's own category not used → "no category" fails.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'apps/server/dist');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };

if (!fs.existsSync(path.join(DIST, 'routes/products.js'))) {
  console.log('\nCannot load apps/server/dist/routes/products.js — build the server first:\n  cd apps/server && npm run build\n');
  process.exit(1);
}
process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
process.env.JWT_SECRET = randomBytes(24).toString('hex');
process.env.ADMIN_JWT_SECRET ??= randomBytes(24).toString('hex');
process.env.SUPABASE_JWT_SECRET ??= randomBytes(24).toString('hex');
const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const { supabase } = require(path.join(DIST, 'lib/supabase.js'));

const BZ = randomUUID(), OTHER = randomUUID(), OWNER = randomUUID(), CLERK = randomUUID();
let db, seq = 0;
const reset = () => {
  db = {
    products: [], categories: [], menus: [],
    users: [{ id: CLERK, business_id: BZ, name: 'Pat', status: 'active', permissions_version: 0, role_id: null }],
  };
};
reset();

// A small PostgREST stand-in: select / eq / is / in / order / range / limit / insert / update / single / maybeSingle.
const writes = [];
supabase.from = (table) => {
  const f = []; let patch = null, inserted = null, ordering = null, window = null;
  const rows = () => (db[table] ??= []).filter((r) => f.every((fn) => fn(r)));
  const run = () => {
    if (inserted) return inserted;
    if (patch) { const hit = rows(); hit.forEach((r) => Object.assign(r, patch)); writes.push({ table, patch, n: hit.length }); return hit; }
    let out = rows().slice();
    if (ordering) out.sort((a, b) => String(a[ordering]).localeCompare(String(b[ordering])));
    if (window) out = out.slice(window[0], window[1] + 1);
    return out;
  };
  const q = new Proxy({}, {
    get(_t, p) {
      if (p === 'eq') return (k, v) => { f.push((r) => r[k] === v); return q; };
      if (p === 'is') return (k, v) => { f.push((r) => (r[k] ?? null) === v); return q; };
      if (p === 'in') return (k, a) => { f.push((r) => a.includes(r[k])); return q; };
      if (p === 'order') return (k) => { ordering = k; return q; };
      if (p === 'range') return (a, b) => { window = [a, b]; return q; };
      if (p === 'update') return (x) => { patch = x; return q; };
      if (p === 'insert') return (r) => {
        inserted = (Array.isArray(r) ? r : [r]).map((x) => ({ id: `id-${++seq}`, created_at: new Date(Date.UTC(2026, 9, 21, 0, 0, seq)).toISOString(), deleted_at: null, ...x }));
        (db[table] ??= []).push(...inserted); writes.push({ table, insert: inserted }); return q;
      };
      if (p === 'single' || p === 'maybeSingle') return () => Promise.resolve({ data: run()[0] ?? null, error: null });
      if (p === 'then') return (res, rej) => Promise.resolve({ data: run(), error: null }).then(res, rej);
      return () => q;
    },
  });
  return q;
};
supabase.rpc = async () => ({ data: null, error: null });

const express = require('express'); const jwt = require('jsonwebtoken');
const app = express(); app.use(express.json());
app.use('/api/products', require(path.join(DIST, 'routes/products.js')).default);
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const sign = (p) => jwt.sign({ sessionId: 's', permissionsVersion: 0, surface: 'web', businessId: BZ, ...p }, process.env.JWT_SECRET);
const OWNER_T = sign({ userId: OWNER, isOwner: true, ownerLogin: true, permissionKeys: ['*'] });
const post = async (rows, token = OWNER_T) => {
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/products/bulk`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ rows }) });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const cat = (name, bz = BZ) => db.categories.find((c) => c.name === name && c.business_id === bz);
const menu = (name, bz = BZ) => db.menus.find((m) => m.name === name && m.business_id === bz && !m.deleted_at);

try {
  await ok('a menu not there yet is created and the category put in it', async () => {
    const r = await post([{ name: 'Chicken Burger', category: 'Burgers', price: 390, menu: 'Food' }]);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.menus_created, ['Food']); assert.equal(r.body.categories_moved, 1);
    assert.ok(menu('Food'), 'the menu is there'); assert.equal(menu('Food').business_id, BZ);
    assert.equal(cat('Burgers').menu_id, menu('Food').id);
  });
  await ok('an existing menu is matched by name (case and spaces ignored) — no second menu', async () => {
    db.menus.push({ id: 'm-drinks', business_id: BZ, name: 'Soft drinks', sort_order: 5, active: true, deleted_at: null });
    const r = await post([{ name: 'Soda', category: 'Soft Drinks', price: 100, menu: ' SOFT  drinks ' }]);
    assert.deepEqual(r.body.menus_created, [], JSON.stringify(r.body));
    assert.equal(cat('Soft Drinks').menu_id, 'm-drinks');
    assert.equal(db.menus.filter((m) => m.name.toLowerCase() === 'soft drinks').length, 1);
  });
  await ok('a blank menu cell leaves the category\'s menu alone', async () => {
    const r = await post([{ name: 'Soda', category: 'Soft Drinks', price: 110, menu: '' }]);
    assert.equal(r.body.updated, 1); assert.equal(r.body.categories_moved, 0);
    assert.equal(cat('Soft Drinks').menu_id, 'm-drinks');
  });
  await ok('unchanged: the category already in that menu is not written again (no sync entry)', async () => {
    writes.length = 0;
    const r = await post([{ name: 'Soda', category: 'Soft Drinks', price: 110, menu: 'Soft drinks' }]);
    assert.equal(r.body.categories_moved, 0);
    assert.ok(!writes.some((w) => w.table === 'categories' && w.patch && 'menu_id' in w.patch), JSON.stringify(writes));
  });
  await ok('DELETE takes the category out of its menu (the menu stays)', async () => {
    const r = await post([{ name: 'Soda', category: 'Soft Drinks', price: 110, menu: 'delete' }]);
    assert.equal(r.body.categories_moved, 1, JSON.stringify(r.body));
    assert.equal(cat('Soft Drinks').menu_id, null);
    assert.ok(menu('Soft drinks')); assert.ok(!menu('delete') && !menu('DELETE'));
  });
  await ok('a clash: two rows of one category naming different menus — the first wins, the later row is refused', async () => {
    const r = await post([
      { name: 'Wings', category: 'Grills', price: 650, menu: 'Food' },
      { name: 'Ribs', category: 'grills', price: 900, menu: 'Alcohol' },
      { name: 'Chops', category: 'Grills', price: 800, menu: 'food' },
    ]);
    assert.equal(r.status, 200);
    assert.equal(r.body.created, 2, JSON.stringify(r.body));
    assert.equal(r.body.errors.length, 1); assert.equal(r.body.errors[0].row, 2);
    assert.match(r.body.errors[0].error, /clashes with row 1/);
    assert.equal(cat('Grills').menu_id, menu('Food').id);
    assert.ok(!menu('Alcohol'), 'the losing menu is not created');
    assert.ok(!db.products.some((p) => p.name === 'Ribs'), 'the refused row is skipped');
  });
  await ok('no category in the row: the matched product\'s own category is used; none at all is a row error', async () => {
    const r = await post([{ name: 'Chicken Burger', menu: 'Grill menu' }, { name: 'Mystery', price: 5, menu: 'Food' }]);
    assert.equal(cat('Burgers').menu_id, menu('Grill menu').id, JSON.stringify(r.body));
    assert.equal(r.body.errors.length, 1); assert.equal(r.body.errors[0].row, 2);
    assert.match(r.body.errors[0].error, /needs a category/);
  });
  await ok('a name over 60 characters is refused for that row', async () => {
    const r = await post([{ name: 'Tea', category: 'Hot', price: 50, menu: 'x'.repeat(61) }]);
    assert.equal(r.body.errors.length, 1); assert.match(r.body.errors[0].error, /at most 60/);
  });
  await ok('business scoping: another business\'s menu of the same name is never used, nor its category touched', async () => {
    db.menus.push({ id: 'm-theirs', business_id: OTHER, name: 'Tea', sort_order: 1, active: true, deleted_at: null });
    db.categories.push({ id: 'c-theirs', business_id: OTHER, name: 'Chai', menu_id: null });
    const r = await post([{ name: 'Masala Chai', category: 'Chai', price: 80, menu: 'Tea' }]);
    assert.deepEqual(r.body.menus_created, ['Tea'], JSON.stringify(r.body));
    assert.notEqual(menu('Tea').id, 'm-theirs');
    assert.equal(cat('Chai').menu_id, menu('Tea').id);
    assert.equal(db.categories.find((c) => c.id === 'c-theirs').menu_id, null);
  });
  await ok('a deleted menu of that name is not reused — a new one is made', async () => {
    db.menus.push({ id: 'm-gone', business_id: BZ, name: 'Brunch', sort_order: 9, active: false, deleted_at: '2026-10-01T00:00:00Z' });
    await post([{ name: 'Pancakes', category: 'Breakfast', price: 300, menu: 'Brunch' }]);
    assert.notEqual(cat('Breakfast').menu_id, 'm-gone');
    assert.ok(menu('Brunch'));
  });
  await ok('permission: the import (menu column and all) is menu.edit — without it, 403 and nothing written', async () => {
    const before = db.menus.length;
    const r = await post([{ name: 'Beer', category: 'Beers', price: 300, menu: 'Alcohol' }], sign({ userId: CLERK, isOwner: false, permissionKeys: ['menu.view'] }));
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(db.menus.length, before); assert.ok(!cat('Beers'));
  });
} finally { server.close(); }

await ok('the upload screen: the template carries the menu column and says what it does; the preview flags a clash', () => {
  const m = fs.readFileSync(path.join(ROOT, 'apps/dashboard/src/pages/products/MenuUpload.tsx'), 'utf8');
  assert.match(m, /'status', 'show_days', 'menu'\]/);
  assert.match(m, /MENU \(optional\): e\.g\. Food — puts the product\\'s CATEGORY in that menu/);
  assert.match(m, /DELETE = take the category out of its menu/);
  assert.match(m, /if \(tab === 'products'\) e\.push\(\.\.\.menuClashes\(rows\)\);/);
  assert.match(m, /one menu per category` \}\);/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
