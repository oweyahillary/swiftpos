/**
 * test-migration-123.mjs — A399: wastage_entries and inventory.waste, and purge_test_data clearing wastage too — run for
 * real against the WHOLE schema (every migration replayed into PGlite).
 *
 * MUTATIONS TO CONFIRM BITE: the reason CHECK dropped → "one of the known reasons" fails; the wastage DELETE left out of
 * purge_test_data → "removes the wastage in the window" fails; the grant dropped → "the manager tier has it" fails.
 */
import fs from 'node:fs'; import path from 'node:path'; import { createRequire } from 'node:module';
import assert from 'node:assert'; import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
let PGlite;
try { ({ PGlite } = require('@electric-sql/pglite')); } catch { console.error('\n@electric-sql/pglite not installed — cannot run.\n'); process.exit(1); }
const MIG = path.join(ROOT, 'migrations');
const files = fs.readdirSync(MIG).filter(f => f.endsWith('.sql')).sort((a, b) => (+a.split('_')[0]) - (+b.split('_')[0]) || a.localeCompare(b));
const sanitize = sql => sql.split('\n').filter(l => { const t = l.trim(); return !(t.startsWith('\\') || /^CREATE SCHEMA public;/i.test(t) || /set_config\('search_path'/i.test(t) || /^SET\s+search_path/i.test(t)); }).join('\n').replace(/uuid_generate_v4\(\)/gi, 'gen_random_uuid()');
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

console.log('\nMigration 123 (wastage) — PGlite, every migration\n');
const B = '00000000-0000-0000-0000-0000000000b1', BR = '00000000-0000-0000-0000-0000000000a1';
const P = '00000000-0000-0000-0000-0000000000c1', I = '00000000-0000-0000-0000-0000000000d1';
const R = '00000000-0000-0000-0000-0000000000e9';
await db.exec(`
  INSERT INTO public.businesses (id, name, type) VALUES ('${B}', 'African Fries', 'restaurant');
  INSERT INTO public.branches (id, business_id, name) VALUES ('${BR}', '${B}', 'Westlands');
  INSERT INTO public.products (id, business_id, name) VALUES ('${P}', '${B}', 'Coke 500ml');
  INSERT INTO public.ingredients (id, business_id, name) VALUES ('${I}', '${B}', 'Cooking oil');
  INSERT INTO public.roles (id, business_id, name) VALUES ('${R}', '${B}', 'Branch Manager');`);
// 122/123's grant runs over the roles that exist when the migration runs — replay the grant for this new role the way
// a later migration's INSERT … SELECT would, by re-running 123.
await db.exec(sanitize(fs.readFileSync(path.join(MIG, '123_wastage.sql'), 'utf8')));

const add = (over = {}) => {
  const r = { business_id: B, branch_id: BR, ref: 'WST-0001', item_kind: 'product', product_id: P, ingredient_id: null, name: 'Coke 500ml',
    quantity: 2, unit_cost: 60, value: 120, reason: 'expired', created_at: '2026-10-01T12:00:00Z', ...over };
  const k = Object.keys(r);
  return db.query(`INSERT INTO public.wastage_entries (${k.join(', ')}) VALUES (${k.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`, k.map((x) => r[x]));
};

await ok('an entry: a product or an ingredient, a quantity above 0, one of the known reasons', async () => {
  await add();
  await add({ item_kind: 'ingredient', product_id: null, ingredient_id: I, name: 'Cooking oil', quantity: 1.5, reason: 'spoiled' });
  for (const [bad, why] of [
    [{ quantity: 0 }, 'quantity 0'], [{ reason: 'stolen' }, 'unknown reason'], [{ item_kind: 'fuel' }, 'unknown kind'],
    [{ item_kind: 'ingredient', product_id: P }, 'an ingredient row naming a product'],
  ]) {
    let threw = false; try { await add(bad); } catch { threw = true; }
    assert.ok(threw, `refused: ${why}`);
  }
  assert.equal(await count('wastage_entries'), 2);
});
await ok('the item deleted later → the entry stays, with its name', async () => {
  await db.exec(`DELETE FROM public.ingredients WHERE id = '${I}'`);
  const r = await one(`SELECT name, ingredient_id FROM public.wastage_entries WHERE item_kind = 'ingredient'`);
  assert.equal(r.name, 'Cooking oil'); assert.equal(r.ingredient_id, null);
});
await ok('inventory.waste exists and the manager tier has it; the owner keeps voiding (inventory.adjust is not granted here)', async () => {
  assert.equal(await count('permissions', `key = 'inventory.waste'`), 1);
  assert.equal(await count('role_permissions rp JOIN public.permissions p ON p.id = rp.permission_id', `rp.role_id = '${R}' AND p.key = 'inventory.waste'`), 1);
  assert.equal(await count('role_permissions rp JOIN public.permissions p ON p.id = rp.permission_id', `rp.role_id = '${R}' AND p.key = 'inventory.adjust'`), 0);
});
await ok('clearing test data counts and removes the wastage in the window, not after it', async () => {
  await add({ created_at: '2026-10-05T09:00:00Z', ref: 'WST-0002' });   // a real write-off after testing
  const prev = (await one(`SELECT public.purge_test_data('${B}', '2026-10-01T08:00:00Z', '2026-10-02T18:00:00Z', 'keep', false, true) AS r`)).r;
  assert.equal(prev.counts.wastage, 2, JSON.stringify(prev.counts));
  assert.equal(await count('wastage_entries'), 3, 'a preview changes nothing');
  const done = (await one(`SELECT public.purge_test_data('${B}', '2026-10-01T08:00:00Z', '2026-10-02T18:00:00Z', 'keep', false, false) AS r`)).r;
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.deepEqual((await q(`SELECT ref FROM public.wastage_entries`)).map((r) => r.ref), ['WST-0002']);
});
await ok('recorded as applied', async () => {
  assert.equal(await count('schema_migrations', `version = '123_wastage'`), 1);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
