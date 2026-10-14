/**
 * test-migration-132.mjs — A482: clearing test data can also delete the whole menu — purge_test_data(..., p_menu) run
 * for real against the WHOLE schema (every migration replayed into PGlite), two businesses, a test window.
 *
 * Owner, 2026-10-14: "can we add purge menu where we delete everything in the menu even the test data, should be a check
 * box when deleting test data".
 *
 * MUTATIONS TO CONFIRM BITE: the real-sale check removed → "a real sale outside the window refuses — nothing deleted"
 * fails (the products go); a menu DELETE scoped by product only for offers (business_id dropped → every business's
 * offers) → "another business's menu is untouched" fails; `menu` not recorded → "the clear is recorded with menu" fails;
 * the deletes run when p_menu is false → "unticked, the menu stays" fails.
 */
import fs from 'node:fs'; import path from 'node:path'; import { createRequire } from 'node:module';
import assert from 'node:assert'; import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
let PGlite;
try { ({ PGlite } = require('@electric-sql/pglite')); } catch { console.error('\n@electric-sql/pglite not installed — cannot run.\n'); process.exit(1); }
const MIG = path.join(ROOT, 'migrations');
const files = fs.readdirSync(MIG).filter(f => f.endsWith('.sql')).sort((a, b) => (+a.split('_')[0]) - (+b.split('_')[0]) || a.localeCompare(b));
const BS = String.fromCharCode(92);
const sanitize = sql => sql.split('\n').filter(l => { const t = l.trim(); return !(t.startsWith(BS) || /^CREATE SCHEMA public;/i.test(t) || /set_config\('search_path'/i.test(t) || /^SET\s+search_path/i.test(t)); }).join('\n').replace(/uuid_generate_v4\(\)/gi, 'gen_random_uuid()');
const db = new PGlite();
await db.exec(`CREATE SCHEMA IF NOT EXISTS auth; CREATE SCHEMA IF NOT EXISTS extensions;
  DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN CREATE ROLE service_role; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text);
  CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
  CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT 'service_role'::text $$;
  CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT '{}'::jsonb $$;
  CREATE OR REPLACE FUNCTION extensions.uuid_generate_v4() RETURNS uuid LANGUAGE sql AS $$ SELECT gen_random_uuid() $$;
  CREATE OR REPLACE FUNCTION extensions.gen_random_uuid() RETURNS uuid LANGUAGE sql AS $$ SELECT gen_random_uuid() $$;
  CREATE OR REPLACE FUNCTION extensions.digest(text,text) RETURNS bytea LANGUAGE sql AS $$ SELECT sha256($1::bytea) $$;`);
await db.exec('SET search_path TO public, extensions, auth;');
for (const f of files) await db.exec(sanitize(fs.readFileSync(path.join(MIG, f), 'utf8')));   // every migration, in order — a failure fails the test

let pass = 0, fail = 0;
const ok = async (n, fn) => { try { await fn(); pass++; console.log(`  ok   ${n}`); } catch (e) { fail++; console.log(`  FAIL ${n}\n         ${e.message}`); } };
const q = async (s, p = []) => (await db.query(s, p)).rows;
const one = async (s, p = []) => (await q(s, p))[0];
const count = async (t, w = 'true', p = []) => Number((await one(`SELECT count(*)::int AS n FROM public.${t} WHERE ${w}`, p)).n);

// A row with what the table demands (NOT NULL, no default) filled in, then the given values.
const colsOf = new Map();
const put = async (table, row) => {
  if (!colsOf.has(table)) colsOf.set(table, await q(`SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`, [table]));
  const full = { ...row };
  for (const c of colsOf.get(table)) {
    if (c.is_nullable === 'YES' || c.column_default !== null || c.column_name in full) continue;
    const t = c.data_type;
    full[c.column_name] = t === 'uuid' ? crypto.randomUUID() : /int|numeric|double|real/.test(t) ? 0 : t === 'boolean' ? false
      : /timestamp/.test(t) ? '2026-10-01T10:00:00Z' : t === 'date' ? '2026-10-01' : t === 'jsonb' || t === 'json' ? '{}' : t === 'ARRAY' ? '{}' : 'x';
  }
  const k = Object.keys(full);
  await db.query(`INSERT INTO public.${table} (${k.join(',')}) VALUES (${k.map((_, i) => `$${i + 1}`).join(',')})`, k.map((x) => full[x]));
};

console.log('\nMigration 132 (clear test data — and the whole menu) — PGlite, every migration\n');
const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const B = id(0xb1), OTHER = id(0xb2), BR = id(0xa1), OBR = id(0xa2), U = id(0xe1);
const FROM = '2026-10-01T08:00:00Z', TO = '2026-10-02T18:00:00Z';
await put('businesses', { id: B, name: 'African Fries', type: 'restaurant' });
await put('businesses', { id: OTHER, name: 'Someone Else', type: 'restaurant' });
await put('branches', { id: BR, business_id: B, name: 'Westlands' });
await put('branches', { id: OBR, business_id: OTHER, name: 'Other' });
await put('users', { id: U, business_id: B, name: 'Mary' });
await put('ingredients', { id: id(0xd1), business_id: B, name: 'Cooking oil' });
await put('suppliers', { id: id(0xf1), business_id: B, name: 'Brookside' });
await put('ingredients', { id: id(0xd2), business_id: OTHER, name: 'Their oil' });

/** A whole menu for a business: a category routed to a station, a product with variants, add-ons, an extra, a recipe,
 *  packaging, a branch price, stock, a batch; a combo of it; a fuel product with a tank and a pump; an offer; a promotion. */
const menu = async (biz, br, base) => {
  const cat = id(base + 1), p = id(base + 2), combo = id(base + 3), fuel = id(base + 4), vg = id(base + 5), mg = id(base + 6);
  const ag = id(base + 7), slot = id(base + 8), tank = id(base + 9), st = id(base + 10), pump = id(base + 11);
  await put('categories', { id: cat, business_id: biz, name: 'Drinks' });
  await put('print_stations', { id: st, business_id: biz, name: 'Bar' });
  await put('category_stations', { category_id: cat, station_id: st, business_id: biz });
  await put('products', { id: p, business_id: biz, category_id: cat, name: 'Coke 500ml', has_variants: true, has_modifiers: true });
  await put('products', { id: combo, business_id: biz, category_id: cat, name: 'Meal deal', is_combo: true });
  await put('products', { id: fuel, business_id: biz, name: 'Petrol', is_fuel: true });
  await put('variant_groups', { id: vg, product_id: p, name: 'Size' });
  await put('variant_options', { variant_group_id: vg, name: 'Large', linked_product_id: p });
  await put('variant_group_products', { variant_group_id: vg, product_id: combo });
  await put('modifier_groups', { id: mg, product_id: p, name: 'Ice' });
  await put('modifier_options', { modifier_group_id: mg, name: 'No ice' });
  await put('attribute_groups', { id: ag, business_id: biz, name: 'Extras' });
  await put('attribute_options', { group_id: ag, name: 'Lemon' });
  await put('product_attributes', { product_id: p, group_id: ag });
  await put('combo_items', { combo_id: combo, product_id: p, quantity: 1 });
  await put('component_slots', { id: slot, business_id: biz, product_id: combo, name: 'Drink' });
  await put('slot_options', { slot_id: slot, option_product_id: p });
  await put('recipes', { business_id: biz, product_id: p, ingredient_id: biz === B ? id(0xd1) : biz === OTHER ? id(0xd2) : id(0xd3) });
  await put('branch_prices', { business_id: biz, branch_id: br, product_id: p, price: 120 });
  await put('stock_levels', { product_id: p, branch_id: br, quantity: 40 });
  await put('stock_batches', { business_id: biz, branch_id: br, item_kind: 'product', product_id: p, quantity_received: 40 });
  await put('stock_movements', { product_id: p, branch_id: br, movement_type: 'restock', quantity_change: 40, quantity_after: 40, created_at: '2026-09-20T10:00:00Z' });
  await put('fuel_tanks', { id: tank, business_id: biz, branch_id: br, fuel_product_id: fuel, product_id: fuel, name: 'Tank 1' });
  await put('pumps', { id: pump, business_id: biz, branch_id: br, fuel_product_id: fuel, tank_id: tank, name: 'Pump 1' });
  await put('offers', { business_id: biz, name: 'Happy hour', kind: 'percent_off', value: 10, applies_to: 'products', product_ids: [p] });
  await put('promotions', { business_id: biz, name: 'Old promo' });
  return { cat, p, combo, fuel, pump };
};
const mine = await menu(B, BR, 0x100);
const theirs = await menu(OTHER, OBR, 0x200);
// A third business clears its test sale WITHOUT the box ticked — its menu must stay.
const THIRD = id(0xb3), TBR = id(0xa3);
await put('businesses', { id: THIRD, name: 'Third', type: 'restaurant' });
await put('branches', { id: TBR, business_id: THIRD, name: 'Third' });
await put('ingredients', { id: id(0xd3), business_id: THIRD, name: 'Third oil' });

// The test: one sale in the window of the Coke. A real sale after the window of the Coke too (it must refuse).
await put('orders', { id: id(0xa5), business_id: B, branch_id: BR, order_number: 'T1-0001', total: 120, created_at: '2026-10-01T12:00:00Z' });
await put('order_items', { order_id: id(0xa5), product_id: mine.p, product_name: 'Coke', unit_price: 120, subtotal: 120 });
await put('orders', { id: id(0xa7), business_id: B, branch_id: BR, order_number: 'T1-0002', total: 120, created_at: '2026-10-03T09:00:00Z' });
await put('order_items', { id: id(0xa77), order_id: id(0xa7), product_id: mine.p, product_name: 'Coke', unit_price: 120, subtotal: 120 });
// the other business sells its own Coke in the same hours — never touched
await put('orders', { id: id(0xa8), business_id: OTHER, branch_id: OBR, order_number: 'X-0001', total: 120, created_at: '2026-10-01T12:00:00Z' });
await put('order_items', { order_id: id(0xa8), product_id: theirs.p, product_name: 'Coke', unit_price: 120, subtotal: 120 });

const run = (args) => { const menu = args[6]; return one(`SELECT public.${menu ? 'purge_test_menu' : 'purge_test_data'}($1, $2, $3, $4, $5, $6, 'hillary@zaptill.co.ke', 'test') AS r`, args.slice(0, 6)).then((x) => x.r); };
const MENU_TABLES = {
  products: `business_id = '${B}'`, categories: `business_id = '${B}'`, variant_groups: `product_id = '${mine.p}'`,
  variant_options: `name = 'Large' AND variant_group_id = '${id(0x105)}'`, variant_group_products: `variant_group_id = '${id(0x105)}'`,
  modifier_groups: `product_id = '${mine.p}'`, modifier_options: `modifier_group_id = '${id(0x106)}'`,
  attribute_groups: `business_id = '${B}'`, attribute_options: `group_id = '${id(0x107)}'`, product_attributes: `product_id = '${mine.p}'`,
  combo_items: `combo_id = '${mine.combo}'`, component_slots: `business_id = '${B}'`, slot_options: `slot_id = '${id(0x108)}'`,
  recipes: `business_id = '${B}'`, branch_prices: `business_id = '${B}'`, stock_levels: `branch_id = '${BR}'`,
  stock_batches: `business_id = '${B}'`, stock_movements: `branch_id = '${BR}'`, fuel_tanks: `business_id = '${B}'`,
  offers: `business_id = '${B}'`, promotions: `business_id = '${B}'`, category_stations: `business_id = '${B}'`,
};
const OTHER_TABLES = {
  products: `business_id = '${OTHER}'`, categories: `business_id = '${OTHER}'`, variant_groups: `product_id = '${theirs.p}'`,
  modifier_groups: `product_id = '${theirs.p}'`, attribute_groups: `business_id = '${OTHER}'`, combo_items: `combo_id = '${theirs.combo}'`,
  component_slots: `business_id = '${OTHER}'`, recipes: `business_id = '${OTHER}'`, branch_prices: `business_id = '${OTHER}'`,
  stock_levels: `branch_id = '${OBR}'`, stock_batches: `business_id = '${OTHER}'`, fuel_tanks: `business_id = '${OTHER}'`,
  offers: `business_id = '${OTHER}'`, promotions: `business_id = '${OTHER}'`, category_stations: `business_id = '${OTHER}'`,
};
const menuLeft = async (tables) => { const left = {}; for (const [t, w] of Object.entries(tables)) left[t] = await count(t, w); return left; };

await ok('purge_test_data is unchanged (one signature — re-running 122 / 123 stays safe); the menu clear is its own function', async () => {
  assert.equal(Number((await one(`SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'purge_test_data'`)).n), 1);
  assert.equal(Number((await one(`SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'purge_test_menu'`)).n), 1);
  const r = (await one(`SELECT public.purge_test_data($1, $2, $3, 'undo', false, true) AS r`, [B, FROM, TO])).r;
  assert.equal(r.counts.menu_products, undefined, 'unticked: no menu counts');
});
await ok('a preview with the menu counts every menu row — and changes nothing', async () => {
  await db.exec(`DELETE FROM public.order_items WHERE id = '${id(0xa77)}'`);   // the real sale's line, put back below
  const r = await run([B, FROM, TO, 'undo', false, true, true]);
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  assert.equal(r.counts.menu, true);
  assert.equal(r.counts.menu_products, 3); assert.equal(r.counts.menu_categories, 1);
  assert.equal(r.counts.menu_variants, 2); assert.equal(r.counts.menu_modifiers, 2); assert.equal(r.counts.menu_extras, 2);
  assert.equal(r.counts.menu_combos, 2); assert.equal(r.counts.menu_recipes, 1); assert.equal(r.counts.menu_offers, 2);
  assert.equal(r.counts.menu_branch_prices, 1); assert.equal(r.counts.menu_stock_lines, 3);
  assert.equal(await count('products', `business_id = '${B}'`), 3);
  await put('order_items', { id: id(0xa77), order_id: id(0xa7), product_id: mine.p, product_name: 'Coke', unit_price: 120, subtotal: 120 });
});
await ok('a real sale outside the window on a menu item refuses — nothing deleted (not the window\'s sales either)', async () => {
  const r = await run([B, FROM, TO, 'undo', false, false, true]);
  assert.equal(r.ok, false);
  assert.match(r.problems.join(' '), /1 real sale\(s\) outside the window use the menu — clear those first or untick 'Also delete the whole menu'/);
  const left = await menuLeft(MENU_TABLES);
  for (const [t, n] of Object.entries(left)) assert.ok(n > 0, `${t} was touched`);
  assert.equal(await count('orders', `business_id = '${B}'`), 2, 'the test sale is still there');
  assert.equal(await count('test_data_purges'), 0);
});
await ok('a window the clear itself refuses (ends in the future) refuses the menu too — nothing deleted', async () => {
  const r = await run([B, FROM, '2099-01-01T00:00:00Z', 'undo', false, false, true]);
  assert.equal(r.ok, false); assert.match(r.problems.join(' '), /in the future/);
  assert.equal(await count('products', `business_id = '${B}'`), 3); assert.equal(await count('test_data_purges'), 0);
});
await ok('unticked, a clear removes the window\'s sale only — the menu stays, and a real sale on it does not refuse', async () => {
  const t = await menu(THIRD, TBR, 0x300);
  await put('orders', { id: id(0xa9), business_id: THIRD, branch_id: TBR, order_number: 'Z-0001', total: 120, created_at: '2026-10-01T12:00:00Z' });
  await put('order_items', { order_id: id(0xa9), product_id: t.p, product_name: 'Coke', unit_price: 120, subtotal: 120 });
  await put('orders', { id: id(0xaa), business_id: THIRD, branch_id: TBR, order_number: 'Z-0002', total: 120, created_at: '2026-10-03T12:00:00Z' });
  await put('order_items', { order_id: id(0xaa), product_id: t.p, product_name: 'Coke', unit_price: 120, subtotal: 120 });
  const r = await run([THIRD, FROM, TO, 'keep', false, false, false]);
  assert.equal(r.ok, true, JSON.stringify(r.problems)); assert.equal(r.counts.menu_products, undefined);
  assert.equal(await count('orders', `business_id = '${THIRD}'`), 1, 'the window\'s sale went, the real one stayed');
  for (const tb of ['products', 'categories', 'offers', 'promotions', 'branch_prices', 'recipes', 'fuel_tanks', 'attribute_groups', 'component_slots']) {
    assert.ok(await count(tb, `business_id = '${THIRD}'`) > 0, `${tb} was deleted`);
  }
  assert.equal(await count('stock_levels', `branch_id = '${TBR}'`), 1);
  assert.equal((await one(`SELECT menu FROM public.test_data_purges WHERE business_id = '${THIRD}'`)).menu, false);
});
await ok('the clear with the menu: the window\'s sale and every menu row of the business go — in one go', async () => {
  await db.exec(`DELETE FROM public.order_items WHERE order_id = '${id(0xa7)}'; DELETE FROM public.orders WHERE id = '${id(0xa7)}'`);   // "clear those first"
  const r = await run([B, FROM, TO, 'undo', false, false, true]);
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  assert.equal(await count('orders', `business_id = '${B}'`), 0);
  const left = await menuLeft(MENU_TABLES);
  for (const [t, n] of Object.entries(left)) assert.equal(n, 0, `${t} still has ${n}`);
  assert.equal(await count('stock', `product_id = '${mine.p}'`), 0);
});
await ok('what is not the menu stays: ingredients, suppliers, the branch, the pump (unlinked), the print station', async () => {
  assert.equal(await count('ingredients', `business_id = '${B}'`), 1); assert.equal(await count('suppliers', `business_id = '${B}'`), 1);
  assert.equal(await count('branches', `business_id = '${B}'`), 1); assert.equal(await count('print_stations', `business_id = '${B}'`), 1);
  const pump = await one(`SELECT fuel_product_id, tank_id FROM public.pumps WHERE id = '${mine.pump}'`);
  assert.ok(pump, 'the pump stays'); assert.equal(pump.fuel_product_id, null); assert.equal(pump.tank_id, null);
});
await ok('another business\'s menu and sale are untouched', async () => {
  const left = await menuLeft(OTHER_TABLES);
  for (const [t, n] of Object.entries(left)) assert.ok(n > 0, `${t} of the other business was deleted`);
  assert.equal(await count('products', `business_id = '${OTHER}'`), 3);
  assert.equal(await count('order_items', `product_id = '${theirs.p}'`), 1);
});
await ok('the clear is recorded with menu = true (what the tills read)', async () => {
  const rec = await one(`SELECT menu, (counts->>'menu')::boolean AS cm, (counts->>'menu_products')::int AS np FROM public.test_data_purges WHERE business_id = '${B}'`);
  assert.equal(rec.menu, true); assert.equal(rec.cm, true); assert.equal(rec.np, 3);
});
await ok('it (and 123 after it) runs twice without error and records itself once', async () => {
  for (const f of ['123_wastage.sql', '132_test_data_menu.sql']) await db.exec(sanitize(fs.readFileSync(path.join(MIG, f), 'utf8')));   // an older one re-run after it too
  assert.equal(await count('schema_migrations', `version = '132_test_data_menu'`), 1);
  assert.equal(Number((await one(`SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'purge_test_data'`)).n), 1);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
