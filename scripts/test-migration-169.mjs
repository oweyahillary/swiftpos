/**
 * test-migration-169.mjs — A580: the unused built-in Waiter, Kitchen and Kitchen Manager roles are taken off businesses
 * that are not a restaurant or a café; a role with staff on it (active or inactive) stays; a role the owner made by hand
 * (is_default false) is never touched; a restaurant and a café keep theirs — run for real against
 * the WHOLE schema (every migration before 169 replayed into PGlite).
 *
 * Owner, 2026-10-23: "how can shops have waiter and kitchen roles unless requested keep them off we only have cashier and
 * other roles".
 *
 * MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted — A580's report):
 *   - the NOT EXISTS (users) check dropped              → "a role with staff stays (active or inactive)" fails
 *   - `r.is_default = true` dropped                    → "a role the owner made by hand is never touched" fails
 *   - 'cafe' left out of the food types                → "a café keeps its roles" fails
 *   - the guard removed                                → "a Waiter the owner adds later is not taken again" fails
 */
import fs from 'node:fs'; import path from 'node:path'; import { createRequire } from 'node:module';
import assert from 'node:assert'; import { fileURLToPath, pathToFileURL } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
let PGlite;
try { ({ PGlite } = require('@electric-sql/pglite')); } catch { console.error('\n@electric-sql/pglite not installed — cannot run.\n'); process.exit(1); }
const MIG = path.join(ROOT, 'migrations');
const num = (f) => +f.split('_')[0];
const files = fs.readdirSync(MIG).filter(f => f.endsWith('.sql') && Number.isFinite(num(f))).sort((a, b) => num(a) - num(b) || a.localeCompare(b));
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
const THIS = '169_shop_kitchen_roles.sql';
for (const f of files.filter((f) => num(f) < 169)) await db.exec(sanitize(fs.readFileSync(path.join(MIG, f), 'utf8')));

let pass = 0, fail = 0;
const ok = async (n, fn) => { try { await fn(); pass++; console.log(`  ok   ${n}`); } catch (e) { fail++; console.log(`  FAIL ${n}\n         ${e.message}`); } };
const q = async (s, p = []) => (await db.query(s, p)).rows;
const one = async (s, p = []) => (await q(s, p))[0];
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
const P = await import(pathToFileURL(path.join(ROOT, 'shared/permissions.ts')).href);

console.log('\nMigration 169 (A580 shop kitchen roles) — PGlite, every migration\n');
let n = 0;
const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const biz = {};
for (const [k, type] of [['shop', 'retail'], ['mini', 'minimart'], ['pump', 'petrol_station'], ['park', 'parking'], ['oth', 'other'],
  ['rest', 'restaurant'], ['cafe', 'cafe']]) {   // businesses.type is NOT NULL and checked (migration 58)
  biz[k] = id();
  await put('businesses', { id: biz[k], name: `Biz ${k}`, type });
}
const roles = {};
const role = async (key, b, name, isDefault = true) => { roles[key] = id(); await put('roles', { id: roles[key], business_id: b, name, description: null, is_default: isDefault }); return roles[key]; };
// the shop: each built-in, one with an active person, one with an inactive person, one the owner made, Cashier
await role('shopWaiter', biz.shop, 'Waiter');
await role('shopKitchen', biz.shop, 'Kitchen');
await role('shopKm', biz.shop, 'Kitchen Manager');
await role('shopCashier', biz.shop, 'Cashier');
await role('miniWaiter', biz.mini, ' WAITER ');
await role('miniKitchen', biz.mini, 'kitchen');           // an inactive person on it
await role('miniKm', biz.mini, 'Kitchen_Manager');        // an active person on it
await role('pumpKm', biz.pump, 'Kitchen Manager');
await role('pumpFuel', biz.pump, 'Fuel attendant');
await role('parkWaiter', biz.park, 'Waiter');
await role('othKitchen', biz.oth, 'Kitchen');
await role('othOwnWaiter', biz.oth, 'Waiter ', false);    // made by hand — never touched
await role('restWaiter', biz.rest, 'Waiter');
await role('restKitchen', biz.rest, 'Kitchen');
await role('restKm', biz.rest, 'Kitchen Manager');
await role('cafeWaiter', biz.cafe, 'Waiter');
await role('cafeKm', biz.cafe, 'Kitchen Manager');
await put('users', { id: id(), business_id: biz.mini, name: 'Old cook', role_id: roles.miniKitchen, status: 'inactive' });
await put('users', { id: id(), business_id: biz.mini, name: 'Chef Ann', role_id: roles.miniKm, status: 'active' });
await db.query(`INSERT INTO public.role_permissions (role_id, permission_id) SELECT $1, id FROM public.permissions WHERE key = 'products.view'`, [roles.shopWaiter]);

const exists = async (key) => !!(await one(`SELECT 1 AS x FROM public.roles WHERE id = $1`, [roles[key]]));
const sql = fs.readFileSync(path.join(MIG, THIS), 'utf8');

await ok('the SQL names exactly the food-only built-in roles and the food types of shared/permissions.ts', async () => {
  const food = P.BUILT_IN_ROLES.filter((r) => r.types && r.types.includes('restaurant')).map((r) => r.name.toLowerCase());
  assert.deepEqual(food, ['waiter', 'kitchen', 'kitchen manager']);
  assert.deepEqual([...P.FOOD_BUSINESS_TYPES], ['restaurant', 'cafe']);
  for (const stmt of sql.split(/;\s*\n/).filter((s) => /DELETE FROM public\.roles/.test(s) || /SELECT count\(\*\) INTO v_kept/.test(s))) {
    assert.match(stmt, /IN \('waiter', 'kitchen', 'kitchen manager'\)/);
    assert.match(stmt, /NOT IN \('restaurant', 'cafe'\)/);
  }
  for (const r of ['Waiter', 'Kitchen', 'Kitchen Manager']) {
    assert.ok(!P.builtInRolesFor('retail').some((b) => b.name === r), `a new shop is not seeded with ${r}`);
    assert.ok(P.builtInRolesFor('restaurant').some((b) => b.name === r) && P.builtInRolesFor('cafe').some((b) => b.name === r), r);
  }
});
await ok('169 runs', async () => { await db.exec(sanitize(sql)); });
await ok('a shop (retail, minimart), a petrol station, a car park and "other" lose the unused Waiter / Kitchen / Kitchen Manager (any case, spaces, underscores) and their keys', async () => {
  for (const k of ['shopWaiter', 'shopKitchen', 'shopKm', 'miniWaiter', 'pumpKm', 'parkWaiter', 'othKitchen']) assert.equal(await exists(k), false, k);
  assert.equal((await one(`SELECT count(*)::int AS n FROM public.role_permissions WHERE role_id = $1`, [roles.shopWaiter])).n, 0, 'keys cascade');
});
await ok('a role with staff stays (active or inactive)', async () => {
  assert.equal(await exists('miniKitchen'), true, 'an inactive person on it');
  assert.equal(await exists('miniKm'), true, 'an active person on it');
});
await ok('a role the owner made by hand is never touched; Cashier and Fuel attendant untouched', async () => {
  for (const k of ['othOwnWaiter', 'shopCashier', 'pumpFuel']) assert.equal(await exists(k), true, k);
});
await ok('a restaurant keeps its roles; a café keeps its roles', async () => {
  for (const k of ['restWaiter', 'restKitchen', 'restKm']) assert.equal(await exists(k), true, k);
  for (const k of ['cafeWaiter', 'cafeKm']) assert.equal(await exists(k), true, k);
});
await ok('runs twice, records itself once; a Waiter the owner adds later is not taken again', async () => {
  await role('shopWaiter2', biz.shop, 'Waiter');
  await db.exec(sanitize(sql));
  assert.equal(await exists('shopWaiter2'), true);
  assert.equal((await one(`SELECT count(*)::int AS n FROM public.schema_migrations WHERE version = '169_shop_kitchen_roles'`)).n, 1);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
