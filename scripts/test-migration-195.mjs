/**
 * test-migration-195.mjs — A626 Phase 1 (owner, 2026-11-25): ZapTill's cloud-billing Paybill C2B pipe. Migration 195 adds
 * the single registration row (zaptill_billing_c2b) and the raw receipts feed (cloud_billing_receipts, deduped on the
 * M-Pesa code). Run for real against the WHOLE schema (every migration before 195 replayed into PGlite).
 *
 * MUTATIONS TO CONFIRM BITE: drop the singleton PK → "one row only" fails; drop the trans_id UNIQUE → "deduped" fails;
 * drop the amount>0 CHECK → "a zero amount is refused" fails; drop the schema_migrations insert → "records itself" fails.
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
const THIS = '195_zaptill_billing_c2b.sql';
for (const f of files.filter((f) => num(f) < 195)) await db.exec(sanitize(fs.readFileSync(path.join(MIG, f), 'utf8')));

let pass = 0, fail = 0;
const ok = async (n, fn) => { try { await fn(); pass++; console.log(`  ok   ${n}`); } catch (e) { fail++; console.log(`  FAIL ${n}\n         ${e.message}`); } };
const q = async (s, p = []) => (await db.query(s, p)).rows;
const one = async (s, p = []) => (await q(s, p))[0];
const throws = async (s, p = []) => { try { await db.query(s, p); return false; } catch { return true; } };

console.log('\nMigration 195 (ZapTill cloud-billing Paybill C2B — the pipe) — PGlite, every migration\n');

const sql = sanitize(fs.readFileSync(path.join(MIG, THIS), 'utf8'));
await ok('runs, and again (idempotent)', async () => { await db.exec(sql); await db.exec(sql); });

await ok('zaptill_billing_c2b: one row only (singleton primary key)', async () => {
  await db.query(`INSERT INTO public.zaptill_billing_c2b (singleton) VALUES (true) ON CONFLICT (singleton) DO NOTHING`);
  assert.equal(await throws(`INSERT INTO public.zaptill_billing_c2b (singleton) VALUES (true)`), true, 'a second row must conflict');
  assert.equal((await one(`SELECT count(*)::int AS n FROM public.zaptill_billing_c2b`)).n, 1);
});
await ok('a token_hash must be 64 hex (or null)', async () => {
  assert.equal(await throws(`UPDATE public.zaptill_billing_c2b SET token_hash = 'nope' WHERE singleton`), true);
  await db.query(`UPDATE public.zaptill_billing_c2b SET token_hash = repeat('a',64) WHERE singleton`);
});
await ok('cloud_billing_receipts: a receipt lands, deduped on the M-Pesa code (trans_id)', async () => {
  await db.query(`INSERT INTO public.cloud_billing_receipts (trans_id, shortcode, amount, bill_ref, bill_ref_norm) VALUES ('QJK7XT3L5P','123456',1080,'KUDO','KUDO')`);
  assert.equal(await throws(`INSERT INTO public.cloud_billing_receipts (trans_id, shortcode, amount) VALUES ('QJK7XT3L5P','123456',1)`), true, 'same trans_id must conflict');
  assert.equal((await one(`SELECT count(*)::int AS n FROM public.cloud_billing_receipts`)).n, 1);
});
await ok('a zero or negative amount is refused', async () => {
  assert.equal(await throws(`INSERT INTO public.cloud_billing_receipts (trans_id, shortcode, amount) VALUES ('ZERO01','123456',0)`), true);
});
await ok('a full Kenyan phone number is refused (no full MSISDN kept)', async () => {
  assert.equal(await throws(`INSERT INTO public.cloud_billing_receipts (trans_id, shortcode, amount, phone_masked) VALUES ('PHONE1','123456',10,'254712345678')`), true);
  await db.query(`INSERT INTO public.cloud_billing_receipts (trans_id, shortcode, amount, phone_masked) VALUES ('MASK1','123456',10,'2547 ***** 149')`);
});
await ok('an unknown status is refused', async () => {
  assert.equal(await throws(`INSERT INTO public.cloud_billing_receipts (trans_id, shortcode, amount, status) VALUES ('ST1','123456',10,'paid')`), true);
});
await ok('both tables have RLS enabled', async () => {
  const r = await q(`SELECT relname FROM pg_class WHERE relname IN ('zaptill_billing_c2b','cloud_billing_receipts') AND relrowsecurity = true`);
  assert.equal(r.length, 2, 'both tables must have RLS on');
});
await ok('records itself in schema_migrations', async () => {
  assert.equal((await one(`SELECT count(*)::int AS n FROM public.schema_migrations WHERE version = '195_zaptill_billing_c2b'`)).n, 1);
});

console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
