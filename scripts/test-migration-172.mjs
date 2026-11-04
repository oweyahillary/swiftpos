/**
 * test-migration-172.mjs — A584: invoices.kind ('cloud') with ONE cloud invoice per business and period start, and the
 * billing notices' milestones — run for real against the WHOLE schema (every migration before 172 replayed into PGlite).
 *
 * Owner, 2026-10-23: "an invoice is sent to the client on the first day of their billing".
 *
 *   - 172 runs twice, recorded once; invoices.kind matches scripts/schema-index.json.
 *   - an invoice that is not a cloud one is untouched (kind NULL, any number per period); only 'cloud' is a kind.
 *   - one cloud invoice per business and period start (the job and a payment can never raise two); another period, or
 *     another business, is a new one.
 *   - the notices: invoice / unpaid_5 / locked / trial_end accepted, once per (business, due date, milestone); A581's
 *     milestones still accepted (history); anything else refused.
 *
 *   node --no-warnings scripts/test-migration-172.mjs
 *
 * MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted — listed in the A584 report):
 *   - invoices_one_cloud_period removed           → "one cloud invoice per period" fails
 *   - the milestone check without 'unpaid_5'       → "the notices" fails
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
const THIS = '172_cloud_billing.sql';
for (const f of files.filter((f) => num(f) < 172)) await db.exec(sanitize(fs.readFileSync(path.join(MIG, f), 'utf8')));

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
console.log('\nMigration 172 (cloud billing) — PGlite, every migration\n');
const id = (n) => `00000000-0000-0000-0000-${n.toString(16).padStart(12, '0')}`;
const A = id(0xa), B = id(0xb);
await put('businesses', { id: A, name: 'Pollo', type: 'restaurant' });
await put('businesses', { id: B, name: 'Duka', type: 'retail' });
const sql = sanitize(fs.readFileSync(path.join(MIG, THIS), 'utf8'));
await ok('172 runs (and again — idempotent), recorded once; invoices.kind matches scripts/schema-index.json', async () => {
  await db.exec(sql); await db.exec(sql);
  assert.equal(Number((await one(`SELECT count(*) AS n FROM public.schema_migrations WHERE version = '172_cloud_billing'`)).n), 1);
  const idx = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/schema-index.json'), 'utf8'));
  const cols = (await q(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'invoices'`)).map((r) => r.column_name).sort();
  // the columns later migrations add are in the index too (182, A612: branch_ids, lines) — not yet at 172
  const LATER = ['branch_ids', 'lines'];
  assert.deepEqual(Object.keys(idx.invoices).filter((c) => !LATER.includes(c)).sort(), cols);
});
let n = 0;
const inv = (o = {}) => put('invoices', { business_id: A, invoice_number: `INV-2026-${String(++n).padStart(4, '0')}`, amount: 3000, period_start: '2026-11-23T07:00:00Z', ...o });
await ok('an invoice that is not a cloud one is untouched: kind NULL, any number for the same period; only cloud is a kind', async () => {
  await inv(); await inv();
  await assert.rejects(() => inv({ kind: 'licence' }), /check/i);
});
await ok('one cloud invoice per business and period start; another period or another business is a new one', async () => {
  await inv({ kind: 'cloud', status: 'pending' });
  await assert.rejects(() => inv({ kind: 'cloud', status: 'paid' }), /duplicate|unique/i);
  await inv({ kind: 'cloud', period_start: '2026-12-23T07:00:00Z' });
  await inv({ kind: 'cloud', business_id: B });
  await inv();   // a hand-raised invoice on the same period still goes
});
const rem = (o = {}) => put('cloud_plan_reminders', { business_id: A, paid_until: '2026-11-23T07:00:00Z', milestone: 'invoice', ...o });
await ok('the notices: invoice / unpaid_5 / locked / trial_end, once per (business, due date, milestone); A581 history kept; anything else refused', async () => {
  for (const m of ['invoice', 'unpaid_5', 'locked', 'trial_end']) await rem({ milestone: m });
  await assert.rejects(() => rem(), /duplicate|unique/i);
  await rem({ paid_until: '2026-12-23T07:00:00Z' });
  for (const m of ['before_7', 'lapse_day', 'lapsed_w3']) await rem({ milestone: m });
  for (const m of ['unpaid_4', 'locked_soon', 'invoices']) await assert.rejects(() => rem({ milestone: m }), /check/i, m);
});
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
