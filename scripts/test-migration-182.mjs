/**
 * test-migration-182.mjs — A612 (owner, 2026-10-30): the cloud billed per branch. branch_cloud_plans — one row per branch
 * (period, amount, paid-until, billing start, web_off) — filled from each business's plan so nobody is locked by the change.
 * Idempotent. Run for real against the WHOLE schema (every migration before 182 replayed into PGlite).
 *
 * MUTATIONS TO CONFIRM BITE: the fill's JOIN on cloud_plans dropped (every branch filled) → "only businesses on the plan"
 * fails; ON CONFLICT dropped → "runs, and again" fails; the amount CHECK dropped → "amount and period checked" fails; the
 * schema_migrations insert dropped → "recording itself" fails.
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
const THIS = '182_branch_cloud_plans.sql';
for (const f of files.filter((f) => num(f) < 182)) await db.exec(sanitize(fs.readFileSync(path.join(MIG, f), 'utf8')));

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


console.log('\nMigration 182 (branch_cloud_plans: the cloud per branch) — PGlite, every migration\n');
const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const A = id(0xa), A1 = id(0xa1), A2 = id(0xa2), Z = id(0xc), Z1 = id(0xc1);
await put('businesses', { id: A, name: 'On the plan', type: 'retail', web_access_expires_at: '2026-11-20T21:00:00Z' });
await put('branches', { id: A1, business_id: A, name: 'Westlands' });
await put('branches', { id: A2, business_id: A, name: 'CBD' });
await put('businesses', { id: Z, name: 'No plan', type: 'retail' });
await put('branches', { id: Z1, business_id: Z, name: 'Main' });
await db.query(`INSERT INTO public.cloud_plans (business_id, period, amount, created_at, billing_from) VALUES ($1, '3_months', 9000, '2026-08-01T00:00:00Z', '2026-07-01T00:00:00Z')`, [A]);
const sql = sanitize(fs.readFileSync(path.join(MIG, THIS), 'utf8'));

await ok('runs, and again (idempotent)', async () => { await db.exec(sql); await db.exec(sql); });
await ok('each branch of a business on the plan inherits it: paid-until, period, amount, billing start', async () => {
  const rows = await q(`SELECT branch_id, business_id, period, amount::float AS amount, paid_until, billing_from, created_at, web_off FROM public.branch_cloud_plans ORDER BY branch_id`);
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.equal(r.business_id, A);
    assert.deepEqual([r.period, r.amount, r.web_off], ['3_months', 9000, false]);
    assert.equal(new Date(r.paid_until).toISOString(), '2026-11-20T21:00:00.000Z');
    assert.equal(new Date(r.billing_from).toISOString(), '2026-07-01T00:00:00.000Z');
    assert.equal(new Date(r.created_at).toISOString(), '2026-08-01T00:00:00.000Z', 'the day billing began, kept');
  }
});
await ok('only businesses on the plan: a branch of a business with no plan gets no row (it follows its business)', async () => {
  assert.equal((await one(`SELECT count(*)::int AS n FROM public.branch_cloud_plans WHERE business_id = $1`, [Z])).n, 0);
});
await ok('amount and period checked', async () => {
  await assert.rejects(db.query(`UPDATE public.branch_cloud_plans SET amount = -1 WHERE branch_id = $1`, [A1]), undefined, 'negative amount');
  await assert.rejects(db.query(`UPDATE public.branch_cloud_plans SET period = 'weekly' WHERE branch_id = $1`, [A1]), undefined, 'unknown period');
});
await ok('one row per branch; a row names its business', async () => {
  await assert.rejects(db.query(`INSERT INTO public.branch_cloud_plans (branch_id, business_id, amount) VALUES ($1, $2, 1)`, [A1, A]), undefined, 'a second row');
  await assert.rejects(db.query(`INSERT INTO public.branch_cloud_plans (branch_id, amount) VALUES ($1, 1)`, [Z1]), undefined, 'no business');
});
await ok('updated_at moves on an update', async () => {
  const before = (await one(`SELECT updated_at FROM public.branch_cloud_plans WHERE branch_id = $1`, [A1])).updated_at;
  await new Promise((r) => setTimeout(r, 15));
  await db.query(`UPDATE public.branch_cloud_plans SET amount = 2500 WHERE branch_id = $1`, [A1]);
  const after = (await one(`SELECT updated_at FROM public.branch_cloud_plans WHERE branch_id = $1`, [A1])).updated_at;
  assert.ok(new Date(after) > new Date(before));
});
await ok('premium: only analytics, attendance, themes; the package a switch; both off by default', async () => {
  const r = await one(`SELECT premium, package FROM public.branch_cloud_plans WHERE branch_id = $1`, [A1]);
  assert.deepEqual([r.premium, r.package], [[], false]);
  await db.query(`UPDATE public.branch_cloud_plans SET premium = ARRAY['analytics','themes'], package = true WHERE branch_id = $1`, [A1]);
  await assert.rejects(db.query(`UPDATE public.branch_cloud_plans SET premium = ARRAY['images'] WHERE branch_id = $1`, [A1]), undefined, 'not a premium item');
});
await ok('an invoice and a payment name their branches; the invoice its lines', async () => {
  const cols = (t) => q(`SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`, [t]);
  const inv = await cols('invoices'), pay = await cols('cloud_payments');
  assert.equal(inv.find((c) => c.column_name === 'branch_ids')?.data_type, 'ARRAY');
  assert.equal(inv.find((c) => c.column_name === 'lines')?.data_type, 'jsonb');
  assert.equal(pay.find((c) => c.column_name === 'branch_ids')?.data_type, 'ARRAY');
});
await ok('RLS on, the owner reads their own (one policy)', async () => {
  assert.equal((await one(`SELECT relrowsecurity FROM pg_class WHERE relname = 'branch_cloud_plans'`)).relrowsecurity, true);
  assert.equal((await one(`SELECT count(*)::int AS n FROM pg_policies WHERE tablename = 'branch_cloud_plans'`)).n, 1);
});
await ok('recording itself in schema_migrations', async () => {
  assert.equal((await one(`SELECT count(*)::int AS n FROM public.schema_migrations WHERE version = '182_branch_cloud_plans'`)).n, 1);
});
await ok('a branch going takes its row with it', async () => {
  await db.query(`DELETE FROM public.branches WHERE id = $1`, [A2]);
  assert.equal((await one(`SELECT count(*)::int AS n FROM public.branch_cloud_plans WHERE branch_id = $1`, [A2])).n, 0);
});
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
