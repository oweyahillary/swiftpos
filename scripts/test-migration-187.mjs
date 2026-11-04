/**
 * test-migration-187.mjs — A619 (owner, 2026-11-01): delivery platform prices. An item's own platform price
 * (products.platform_prices) and what a sale records of the pricing that applied (orders.price_list / platform_rule /
 * platform_uplift). Run for real against the WHOLE schema (every migration before 187 replayed into PGlite).
 *
 * MUTATIONS TO CONFIRM BITE: the price_list CHECK dropped → "a price list that is not a method code is refused" fails;
 * the platform_prices CHECK dropped → "an own price list that is not an object is refused" fails; the index without its
 * WHERE → "only platform sales are indexed" fails.
 */
import fs from 'node:fs'; import path from 'node:path'; import { createRequire } from 'node:module';
import assert from 'node:assert'; import { fileURLToPath } from 'node:url';
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
const THIS = '187_platform_prices.sql';
for (const f of files.filter((f) => num(f) < 187)) await db.exec(sanitize(fs.readFileSync(path.join(MIG, f), 'utf8')));

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

console.log('\nMigration 187 (delivery platform prices) — PGlite, every migration\n');
const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const A = id(0xa), B1 = id(0xb1), P1 = id(0xc1), O1 = id(0xd1), O2 = id(0xd2);
await put('businesses', { id: A, name: 'Sample Grill', type: 'restaurant' });
await put('branches', { id: B1, business_id: A, name: 'Main' });
await put('products', { id: P1, business_id: A, name: '3 Piece Chicken', base_price: 1000 });
await put('orders', { id: O1, business_id: A, branch_id: B1, order_number: 'T1-1', total: 1150, subtotal: 1150 });
const sql = sanitize(fs.readFileSync(path.join(MIG, THIS), 'utf8'));

await ok('runs, and again (idempotent)', async () => { await db.exec(sql); await db.exec(sql); });
await ok('existing rows untouched: no own platform price, normal prices (price_list NULL)', async () => {
  assert.equal((await one(`SELECT platform_prices FROM public.products WHERE id = $1`, [P1])).platform_prices, null);
  const o = await one(`SELECT price_list, platform_rule, platform_uplift FROM public.orders WHERE id = $1`, [O1]);
  assert.equal(o.price_list, null); assert.equal(o.platform_rule, null); assert.equal(o.platform_uplift, null);
});
await ok('an item\'s own platform price per platform', async () => {
  await db.query(`UPDATE public.products SET platform_prices = '{"glovo": 1200, "uber_eats": 1250}' WHERE id = $1`, [P1]);
  assert.deepEqual((await one(`SELECT platform_prices FROM public.products WHERE id = $1`, [P1])).platform_prices, { glovo: 1200, uber_eats: 1250 });
});
await ok('an own price list that is not an object is refused', async () => {
  await assert.rejects(db.query(`UPDATE public.products SET platform_prices = '[1200]' WHERE id = $1`, [P1]), /check/i);
});
await ok('a sale records the platform, its rule and the uplift (kept as it was)', async () => {
  await db.query(`UPDATE public.orders SET price_list = 'glovo', platform_rule = '{"kind":"percent","value":15,"rounding":"up10"}', platform_uplift = 150 WHERE id = $1`, [O1]);
  const o = await one(`SELECT price_list, platform_rule, platform_uplift FROM public.orders WHERE id = $1`, [O1]);
  assert.equal(o.price_list, 'glovo'); assert.deepEqual(o.platform_rule, { kind: 'percent', value: 15, rounding: 'up10' });
  assert.equal(Number(o.platform_uplift), 150);
});
await ok('a price list that is not a method code is refused', async () => {
  await assert.rejects(db.query(`UPDATE public.orders SET price_list = 'Glovo prices!' WHERE id = $1`, [O1]), /check/i);
});
await ok('only platform sales are indexed (the reports\' "of which uplift")', async () => {
  const ix = await one(`SELECT indexdef FROM pg_indexes WHERE indexname = 'orders_price_list_period'`);
  assert.match(ix.indexdef, /WHERE \(price_list IS NOT NULL\)/);
  await put('orders', { id: O2, business_id: A, branch_id: B1, order_number: 'T1-2', total: 500, subtotal: 500 });
});
await ok('products and orders keep their row level security', async () => {
  for (const t of ['products', 'orders']) assert.equal((await one(`SELECT relrowsecurity FROM pg_class WHERE oid = $1::regclass`, [`public.${t}`])).relrowsecurity, true, t);
});
await ok('recording itself in schema_migrations', async () => {
  assert.equal((await one(`SELECT count(*)::int AS n FROM public.schema_migrations WHERE version = '187_platform_prices'`)).n, 1);
});
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
