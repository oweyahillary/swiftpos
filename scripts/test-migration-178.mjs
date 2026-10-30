/**
 * test-migration-178.mjs — A595, owner decision D4 (2026-10-27): credit limits with branches — customers' lock columns and
 * customer_branch_credit_limits (RLS by business, one row per customer and branch, a limit never below 0). Idempotent.
 * Run for real against the WHOLE schema (every migration before 178 replayed into PGlite).
 *
 * MUTATIONS TO CONFIRM BITE: the UNIQUE dropped → "one limit per customer and branch" fails; the CHECK dropped → "never
 * below 0" fails; ENABLE ROW LEVEL SECURITY dropped → "row-level security" fails.
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
const THIS = '178_branch_credit.sql';
for (const f of files.filter((f) => num(f) < 178)) await db.exec(sanitize(fs.readFileSync(path.join(MIG, f), 'utf8')));

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


console.log('\nMigration 178 (credit per branch: the lock and customer_branch_credit_limits) — PGlite, every migration\n');
const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const A = id(0xa), BR = id(0xb1), C = id(0xc1);
await put('businesses', { id: A, name: 'Sample Shop', type: 'retail' });
await put('branches', { id: BR, business_id: A, name: 'Main' });
await put('customers', { id: C, business_id: A, name: 'Mary', credit_limit: 1000 });
const sql = fs.readFileSync(path.join(MIG, THIS), 'utf8');
await ok('178 runs, and again (idempotent), recording itself once', async () => {
  await db.exec(sanitize(sql)); await db.exec(sanitize(sql));
  assert.equal((await one(`SELECT count(*)::int AS n FROM public.schema_migrations WHERE version = '178_branch_credit'`)).n, 1);
});
await ok('customers: credit_limit_locked (false by default), locked_by, locked_at', async () => {
  const r = await one(`SELECT credit_limit_locked, credit_limit_locked_by, credit_limit_locked_at FROM public.customers WHERE id = $1`, [C]);
  assert.equal(r.credit_limit_locked, false); assert.equal(r.credit_limit_locked_by, null);
});
await ok('one limit per customer and branch; never below 0; who and when kept', async () => {
  await db.query(`INSERT INTO public.customer_branch_credit_limits (business_id, customer_id, branch_id, credit_limit, set_by_name) VALUES ($1, $2, $3, 300, 'Pam')`, [A, C, BR]);
  await assert.rejects(db.query(`INSERT INTO public.customer_branch_credit_limits (business_id, customer_id, branch_id, credit_limit) VALUES ($1, $2, $3, 100)`, [A, C, BR]));
  await assert.rejects(db.query(`UPDATE public.customer_branch_credit_limits SET credit_limit = -1`));
  const r = await one(`SELECT set_by_name, set_at FROM public.customer_branch_credit_limits`);
  assert.equal(r.set_by_name, 'Pam'); assert.ok(r.set_at);
});
await ok('row-level security on, by business (as A585 / A564)', async () => {
  const r = await one(`SELECT relrowsecurity FROM pg_class WHERE relname = 'customer_branch_credit_limits'`);
  assert.equal(r.relrowsecurity, true);
  assert.ok((await q(`SELECT policyname FROM pg_policies WHERE tablename = 'customer_branch_credit_limits'`)).length >= 1);
});
await ok('a customer removed takes their branch limits with them', async () => {
  await db.query(`DELETE FROM public.customers WHERE id = $1`, [C]);
  assert.equal((await one(`SELECT count(*)::int AS n FROM public.customer_branch_credit_limits`)).n, 0);
});
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
