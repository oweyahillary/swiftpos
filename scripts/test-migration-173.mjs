/**
 * test-migration-173.mjs — A587: invoices.status 'written_off' (the locked time's / "Not interested" cloud invoices,
 * closed, not charged), the 'not_interested' notice, and cloud_plans.billing_from (a bridged licence kept locked) — run
 * for real against the WHOLE schema (every migration before 173 replayed into PGlite).
 *
 * Owner, 2026-10-24: "it's pay as you go, not pay for missed months" · "if they fail to pay for 3 months we assume they are
 * not interested" · "Should already-locked clients get the 7 days? — no".
 *
 *   - 173 runs twice, recorded once; cloud_plans.billing_from matches scripts/schema-index.json.
 *   - an invoice may be written_off (and every earlier status still goes); anything else refused.
 *   - the notices: not_interested accepted, every earlier milestone still accepted; anything else refused.
 *   - billing_from: NULL by default (A584), a date when set.
 *
 *   node --no-warnings scripts/test-migration-173.mjs
 *
 * MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted — listed in the A587 report):
 *   - the status check without 'written_off'       → "written_off" fails
 *   - the milestone check without 'not_interested' → "the notices" fails
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
  CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.uid', true), '')::uuid $$;
  CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT 'service_role'::text $$;
  CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT '{}'::jsonb $$;
  CREATE OR REPLACE FUNCTION extensions.uuid_generate_v4() RETURNS uuid LANGUAGE sql AS $$ SELECT gen_random_uuid() $$;
  CREATE OR REPLACE FUNCTION extensions.gen_random_uuid() RETURNS uuid LANGUAGE sql AS $$ SELECT gen_random_uuid() $$;
  CREATE OR REPLACE FUNCTION extensions.digest(text,text) RETURNS bytea LANGUAGE sql AS $$ SELECT sha256($1::bytea) $$;`);
await db.exec('SET search_path TO public, extensions, auth;');
const THIS = '173_cloud_billing_offset.sql';
for (const f of files.filter((f) => num(f) < 173)) await db.exec(sanitize(fs.readFileSync(path.join(MIG, f), 'utf8')));

let pass = 0, fail = 0;
const ok = async (n, fn) => { try { await fn(); pass++; console.log(`  ok   ${n}`); } catch (e) { fail++; console.log(`  FAIL ${n}\n         ${e.message}`); } };
const q = async (s, p = []) => (await db.query(s, p)).rows;
const one = async (s, p = []) => (await q(s, p))[0];
const colsOf = new Map();
const fill = async (table, row) => {
  if (!colsOf.has(table)) colsOf.set(table, await q(`SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`, [table]));
  const full = { ...row };
  for (const c of colsOf.get(table)) {
    if (c.is_nullable === 'YES' || c.column_default !== null || c.column_name in full) continue;
    const t = c.data_type;
    full[c.column_name] = t === 'uuid' ? crypto.randomUUID() : /int|numeric|double|real/.test(t) ? 0 : t === 'boolean' ? false
      : /timestamp/.test(t) ? '2026-10-01T10:00:00Z' : t === 'date' ? '2026-10-01' : t === 'jsonb' || t === 'json' ? '{}' : t === 'ARRAY' ? '{}' : `x-${crypto.randomUUID().slice(0, 8)}`;
  }
  return full;
};
const put = async (table, row) => {
  const full = await fill(table, row);
  const k = Object.keys(full);
  return (await db.query(`INSERT INTO public.${table} (${k.join(',')}) VALUES (${k.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`, k.map((x) => full[x]))).rows[0];
};
console.log('\nMigration 173 (cloud billing: pay as you go, not interested) — PGlite, every migration\n');
const id = (n) => `00000000-0000-0000-0000-${n.toString(16).padStart(12, '0')}`;
const A = id(0xa);
await put('businesses', { id: A, name: 'Pollo', type: 'restaurant' });
const sql = sanitize(fs.readFileSync(path.join(MIG, THIS), 'utf8'));
await ok('173 runs (and again — idempotent), recorded once; cloud_plans matches scripts/schema-index.json', async () => {
  await db.exec(sql); await db.exec(sql);
  assert.equal(Number((await one(`SELECT count(*) AS n FROM public.schema_migrations WHERE version = '173_cloud_billing_offset'`)).n), 1);
  const idx = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/schema-index.json'), 'utf8'));
  const cols = (await q(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'cloud_plans'`)).map((r) => r.column_name).sort();
  assert.deepEqual(Object.keys(idx.cloud_plans).sort(), cols);
});
let n = 0;
const inv = (o = {}) => put('invoices', { business_id: A, invoice_number: `INV-2026-${String(++n).padStart(4, '0')}`, amount: 3000, currency: 'KES', period_start: `2026-${String(n).padStart(2, '0')}-01T07:00:00Z`, kind: 'cloud', ...o });
await ok('written_off: a cloud invoice closed, not charged; every earlier status still goes; anything else refused', async () => {
  for (const s of ['pending', 'paid', 'failed', 'refunded', 'written_off']) await inv({ status: s });
  const row = await inv({ status: 'pending' });
  await db.query(`UPDATE public.invoices SET status = 'written_off' WHERE id = $1`, [row.id]);
  await assert.rejects(() => inv({ status: 'cancelled' }), /check/i);
});
const rem = (o = {}) => put('cloud_plan_reminders', { business_id: A, paid_until: '2026-11-23T07:00:00Z', milestone: 'not_interested', ...o });
await ok('the notices: not_interested once per (business, due date); the earlier milestones kept; anything else refused', async () => {
  await rem();
  await assert.rejects(() => rem(), /duplicate|unique/i);
  for (const m of ['invoice', 'unpaid_5', 'locked', 'trial_end', 'before_7', 'lapsed_w3']) await rem({ milestone: m });
  for (const m of ['notinterested', 'written_off']) await assert.rejects(() => rem({ milestone: m, paid_until: '2026-12-01T00:00:00Z' }), /check/i, m);
});
await ok('cloud_plans.billing_from: NULL by default (A584), a date when the bridge keeps a licence locked', async () => {
  const p = await put('cloud_plans', { business_id: A, period: '12_months', amount: 36000, currency: 'KES' });
  assert.equal(p.billing_from, null);
  await db.query(`UPDATE public.cloud_plans SET billing_from = '2026-08-01T07:00:00Z' WHERE business_id = $1`, [A]);
  assert.ok((await one(`SELECT billing_from FROM public.cloud_plans WHERE business_id = $1`, [A])).billing_from);
});
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
