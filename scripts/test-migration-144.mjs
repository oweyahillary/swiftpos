/**
 * test-migration-144.mjs — A518: promotions.applies_at_sale (a promotion saved since A518 is charged at the sale as an
 * offer) — added false for every existing row, idempotent — run for real against the WHOLE schema (PGlite).
 *
 * MUTATIONS TO CONFIRM BITE: DEFAULT true → "existing promotions are not switched on" fails; IF NOT EXISTS dropped →
 * "runs twice" fails.
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
const THIS = '144_promotions_at_sale.sql';
for (const f of files.filter((f) => num(f) < 144)) await db.exec(sanitize(fs.readFileSync(path.join(MIG, f), 'utf8')));
let pass = 0, fail = 0;
const ok = async (n, fn) => { try { await fn(); pass++; console.log(`  ok   ${n}`); } catch (e) { fail++; console.log(`  FAIL ${n}\n         ${e.message}`); } };
const q = async (s, p = []) => (await db.query(s, p)).rows;

console.log('\nMigration 144 (promotions.applies_at_sale) — PGlite, every migration\n');
const BZ = '00000000-0000-0000-0000-00000000000a';
await db.query(`INSERT INTO public.businesses (id, name, type) VALUES ($1, 'KRUNCH', 'restaurant')`, [BZ]);
await db.query(`INSERT INTO public.promotions (business_id, name) VALUES ($1, 'Old happy hour')`, [BZ]);
const sql = fs.readFileSync(path.join(MIG, THIS), 'utf8');
await ok('144 runs', async () => { await db.exec(sanitize(sql)); });
await ok('existing promotions are not switched on (false), a new row defaults false, the column is NOT NULL', async () => {
  assert.deepEqual((await q(`SELECT applies_at_sale FROM public.promotions`)).map((r) => r.applies_at_sale), [false]);
  await db.query(`INSERT INTO public.promotions (business_id, name) VALUES ($1, 'New')`, [BZ]);
  assert.equal((await q(`SELECT applies_at_sale FROM public.promotions WHERE name = 'New'`))[0].applies_at_sale, false);
  const c = (await q(`SELECT is_nullable FROM information_schema.columns WHERE table_name = 'promotions' AND column_name = 'applies_at_sale'`))[0];
  assert.equal(c.is_nullable, 'NO');
});
await ok('144 runs twice and records itself once', async () => {
  await db.exec(sanitize(sql));
  assert.equal((await q(`SELECT count(*)::int AS n FROM public.schema_migrations WHERE version = '144_promotions_at_sale'`))[0].n, 1);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
