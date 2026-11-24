/**
 * test-migration-194.mjs — A625 (owner, 2026-11-23): per-branch menu. product_branches_hidden — a product off a branch's
 * menu (an exclusion table; no rows = on every branch, as before). Run for real against the WHOLE schema in PGlite.
 *
 * MUTATIONS TO CONFIRM BITE: drop the PRIMARY KEY → "one row per (product, branch)" fails; drop the product FK cascade →
 * "deleting a product clears its rows" fails; drop the schema_migrations insert → "records itself" fails.
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
const THIS = '194_product_branches_hidden.sql';
for (const f of files.filter((f) => num(f) < 194)) await db.exec(sanitize(fs.readFileSync(path.join(MIG, f), 'utf8')));

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
const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;

console.log('\nMigration 194 (product_branches_hidden: per-branch menu) — PGlite, every migration\n');
const B = id(0xb), BR1 = id(0xb1), BR2 = id(0xb2), P1 = id(0x1), P2 = id(0x2);
await put('businesses', { id: B, name: 'Grill', type: 'restaurant' });
await put('branches', { id: BR1, business_id: B, name: 'Westlands' });
await put('branches', { id: BR2, business_id: B, name: 'CBD' });
await put('categories', { id: id(0xca), business_id: B, name: 'Food' });
await put('products', { id: P1, business_id: B, name: 'Nyama Choma', base_price: 1200, category_id: id(0xca) });
await put('products', { id: P2, business_id: B, name: 'Chips', base_price: 300, category_id: id(0xca) });
const sql = sanitize(fs.readFileSync(path.join(MIG, THIS), 'utf8'));

await ok('runs, and again (idempotent)', async () => { await db.exec(sql); await db.exec(sql); });
await ok('no rows = a product is on every branch (the default, nothing changes)', async () => {
  assert.equal((await one(`SELECT count(*)::int AS n FROM public.product_branches_hidden`)).n, 0);
});
await ok('a product can be hidden at a branch (off that branch\'s menu)', async () => {
  await db.query(`INSERT INTO public.product_branches_hidden (product_id, branch_id, business_id) VALUES ($1, $2, $3)`, [P1, BR2, B]);
  const r = await q(`SELECT product_id, branch_id FROM public.product_branches_hidden WHERE product_id = $1`, [P1]);
  assert.deepEqual(r, [{ product_id: P1, branch_id: BR2 }], 'P1 hidden at CBD only');
});
await ok('one row per (product, branch) — the same exclusion again is rejected', async () => {
  await assert.rejects(db.query(`INSERT INTO public.product_branches_hidden (product_id, branch_id, business_id) VALUES ($1, $2, $3)`, [P1, BR2, B]), undefined, 'duplicate');
});
await ok('deleting a product clears its rows (FK cascade)', async () => {
  await db.query(`INSERT INTO public.product_branches_hidden (product_id, branch_id, business_id) VALUES ($1, $2, $3)`, [P2, BR1, B]);
  await db.query(`DELETE FROM public.products WHERE id = $1`, [P2]);
  assert.equal((await one(`SELECT count(*)::int AS n FROM public.product_branches_hidden WHERE product_id = $1`, [P2])).n, 0);
});
await ok('deleting a branch clears its rows (FK cascade)', async () => {
  await db.query(`DELETE FROM public.branches WHERE id = $1`, [BR2]);
  assert.equal((await one(`SELECT count(*)::int AS n FROM public.product_branches_hidden WHERE branch_id = $1`, [BR2])).n, 0);
});
await ok('records itself in schema_migrations', async () => {
  assert.equal((await one(`SELECT count(*)::int AS n FROM public.schema_migrations WHERE version = '194_product_branches_hidden'`)).n, 1);
});

console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
