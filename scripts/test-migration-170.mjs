/**
 * test-migration-170.mjs — A581: the cloud payment plan (cloud_plans, cloud_payments, cloud_plan_reminders), run for real
 * against the WHOLE schema (every migration before 170 replayed into PGlite).
 *
 * Owner, 2026-10-23: "add payment plan option such that i can select month on month and always remind me on email about
 * expiry and also the client". Paid-until stays businesses.web_access_expires_at.
 *
 *   - 170 runs twice, recorded once; every column it creates is in scripts/schema-index.json (later migrations may add more); the updated_at trigger on cloud_plans.
 *   - one plan per business; only the known periods; an amount not below 0.
 *   - a payment: amount above 0; the known methods; an M-Pesa payment needs its code; an M-Pesa code once only (any
 *     client, any case); a bank reference may repeat; paid-until must move forward.
 *   - a reminder once per (business, paid-until, milestone); a new paid-until starts afresh; only the known milestones.
 *   - an admin removed: the payment stays (recorded_by emptied, the email kept); an invoice removed: the payment stays.
 *   - RLS: the owner reads their plan and payments only; another owner none; anon none; nobody but the server reads the
 *     reminders; authenticated cannot write.
 *
 * MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted — listed in the A581 report):
 *   - cloud_payments_one_mpesa_code removed                 → "an M-Pesa code once only" fails
 *   - cloud_plan_reminders_once removed                     → "a reminder once per milestone" fails
 *   - recorded_by ON DELETE SET NULL → CASCADE               → "an admin removed: the payment stays" fails
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
const THIS = '170_cloud_plans.sql';
for (const f of files.filter((f) => num(f) < 170)) await db.exec(sanitize(fs.readFileSync(path.join(MIG, f), 'utf8')));

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
console.log('\nMigration 170 (cloud plans) — PGlite, every migration\n');
const id = (n) => `00000000-0000-0000-0000-${n.toString(16).padStart(12, '0')}`;
const A = id(0xa), B = id(0xb), OWNER = id(0xa0f), OWNER_B = id(0xb0f), ADMIN = id(0xad);
await db.query(`INSERT INTO auth.users (id, email) VALUES ($1, 'owner@a'), ($2, 'owner@b')`, [OWNER, OWNER_B]);
await put('businesses', { id: A, name: 'Pollo', type: 'restaurant', owner_id: OWNER });
await put('businesses', { id: B, name: 'Duka', type: 'retail', owner_id: OWNER_B });
await put('admin_users', { id: ADMIN, email: 'boss@zaptill.test', name: 'Boss' });

const sql = sanitize(fs.readFileSync(path.join(MIG, THIS), 'utf8'));
await ok('170 runs (and again — idempotent), recorded once; the updated_at trigger; the indexes', async () => {
  await db.exec(sql); await db.exec(sql);
  assert.equal(Number((await one(`SELECT count(*) AS n FROM public.schema_migrations WHERE version = '170_cloud_plans'`)).n), 1);
  const trg = (await q(`SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.cloud_plans'::regclass AND NOT tgisinternal`)).map((r) => r.tgname);
  assert.deepEqual(trg, ['cloud_plans_set_updated_at']);
  const idx = (await q(`SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`)).map((r) => r.indexname);
  for (const n of ['cloud_payments_business', 'cloud_payments_one_mpesa_code', 'cloud_plan_reminders_once']) assert.ok(idx.includes(n), `index ${n} missing`);
});
await ok('the columns match scripts/schema-index.json', async () => {
  const idx = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/schema-index.json'), 'utf8'));
  for (const t of ['cloud_plans', 'cloud_payments', 'cloud_plan_reminders']) {
    assert.ok(idx[t], `${t} missing from schema-index.json`);
    const cols = (await q(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`, [t])).map((r) => r.column_name).sort();
    // Every column 170 creates is in the index; a later migration may add more (173: cloud_plans.billing_from).
    const missing = cols.filter((c) => !Object.keys(idx[t]).includes(c));
    assert.deepEqual(missing, [], `${t}: ${missing.join(', ')} not in schema-index.json`);
  }
});
const plan = (o = {}) => put('cloud_plans', { business_id: A, period: 'monthly', amount: 3000, ...o });
await ok('one plan per business; only the known periods; an amount not below 0', async () => {
  await plan();
  await assert.rejects(() => plan(), /duplicate|unique/i);
  await assert.rejects(() => plan({ business_id: B, period: 'weekly' }), /check/i);
  await assert.rejects(() => plan({ business_id: B, amount: -1 }), /check/i);
  for (const p of ['3_months', '6_months', '12_months', 'custom']) await db.query(`UPDATE public.cloud_plans SET period = $1 WHERE business_id = $2`, [p, A]);
});
await ok('updated_at moves on a change', async () => {
  await db.query(`UPDATE public.cloud_plans SET updated_at = '2026-01-01T00:00:00Z' WHERE business_id = $1`, [A]);
  await db.query(`UPDATE public.cloud_plans SET amount = 9000 WHERE business_id = $1`, [A]);
  assert.ok(new Date((await one(`SELECT updated_at FROM public.cloud_plans WHERE business_id = $1`, [A])).updated_at).getTime() > Date.parse('2026-01-02T00:00:00Z'));
});
let seq = 0;
const pay = (o = {}) => put('cloud_payments', { business_id: A, amount: 3000, period: 'monthly', method: 'mpesa', reference: `SJK${String(++seq).padStart(7, '0')}`,
  paid_until_before: '2026-11-01T00:00:00Z', paid_until_after: '2026-12-01T00:00:00Z', recorded_by: ADMIN, recorded_by_email: 'boss@zaptill.test', ...o });
let P1;
await ok('a payment: amount above 0, the known methods, an M-Pesa payment needs its code, paid-until must move forward', async () => {
  P1 = await pay({ reference: 'SJK4H7Q2LM' });
  await assert.rejects(() => pay({ amount: 0 }), /check/i);
  await assert.rejects(() => pay({ method: 'cheque' }), /check/i);
  await assert.rejects(() => pay({ reference: null }), /check/i);
  await assert.rejects(() => pay({ paid_until_after: '2026-10-01T00:00:00Z' }), /check/i);
  await pay({ method: 'cash', reference: null });
  await pay({ paid_until_before: null });
});
await ok('an M-Pesa code once only (any client, any case); a bank reference may repeat', async () => {
  await assert.rejects(() => pay({ reference: 'SJK4H7Q2LM' }), /duplicate|unique/i);
  await assert.rejects(() => pay({ business_id: B, reference: 'sjk4h7q2lm' }), /duplicate|unique/i);
  await pay({ method: 'bank', reference: 'EQUITY-1' }); await pay({ method: 'bank', reference: 'EQUITY-1' });
});
const rem = (o = {}) => put('cloud_plan_reminders', { business_id: A, paid_until: '2026-12-01T00:00:00Z', milestone: 'before_7', ...o });
await ok('a reminder once per (business, paid-until, milestone); a new paid-until starts afresh; only the known milestones', async () => {
  await rem();
  await assert.rejects(() => rem(), /duplicate|unique/i);
  await rem({ paid_until: '2027-01-01T00:00:00Z' });
  await rem({ business_id: B });
  for (const m of ['before_14', 'before_3', 'before_1', 'lapse_day', 'lapsed_w1', 'lapsed_w8']) await rem({ milestone: m });
  for (const m of ['before_5', 'lapsed_w0', 'lapsed_w10', 'soon']) await assert.rejects(() => rem({ milestone: m }), /check/i, m);
});
await ok('an admin removed: the payment stays (recorded_by emptied, the email kept); an invoice removed: the payment stays', async () => {
  const INV = (await put('invoices', { business_id: A, invoice_number: 'INV-2026-0001', amount: 3000 })).id;
  await db.query(`UPDATE public.cloud_payments SET invoice_id = $1 WHERE id = $2`, [INV, P1.id]);
  await db.query(`DELETE FROM public.invoices WHERE id = $1`, [INV]);
  await db.query(`DELETE FROM public.admin_users WHERE id = $1`, [ADMIN]);
  const r = await one(`SELECT recorded_by, recorded_by_email, invoice_id FROM public.cloud_payments WHERE id = $1`, [P1.id]);
  assert.ok(r, 'the payment went');
  assert.equal(r.recorded_by, null); assert.equal(r.invoice_id, null); assert.equal(r.recorded_by_email, 'boss@zaptill.test');
});
await ok('RLS: the owner reads their plan and payments only; another owner none; nobody but the server reads the reminders; anon none; authenticated cannot write', async () => {
  for (const t of ['cloud_plans', 'cloud_payments', 'cloud_plan_reminders']) {
    assert.equal((await one(`SELECT relrowsecurity FROM pg_class WHERE oid = 'public.${t}'::regclass`)).relrowsecurity, true, t);
    assert.equal((await one(`SELECT has_table_privilege('anon', 'public.${t}', 'SELECT') AS x`)).x, false, t);
    assert.equal((await one(`SELECT has_table_privilege('authenticated', 'public.${t}', 'INSERT') AS x`)).x, false, t);
  }
  assert.equal((await one(`SELECT has_table_privilege('authenticated', 'public.cloud_plan_reminders', 'SELECT') AS x`)).x, false);
  await db.exec(`GRANT USAGE ON SCHEMA auth TO authenticated; GRANT SELECT ON public.businesses TO authenticated; ALTER TABLE public.businesses DISABLE ROW LEVEL SECURITY;`);
  const as = async (uid, t) => {
    await db.exec(`SET row_security = on; SET test.uid = '${uid}'; SET ROLE authenticated;`);
    try { return (await q(`SELECT business_id FROM public.${t}`)).map((r) => r.business_id); }
    finally { await db.exec(`RESET ROLE; RESET test.uid;`); }
  };
  try {
    const a = await as(OWNER, 'cloud_payments');
    assert.ok(a.length >= 2 && a.every((b) => b === A), `the owner saw ${a.join(', ')}`);
    assert.deepEqual(await as(OWNER, 'cloud_plans'), [A]);
    assert.deepEqual(await as(OWNER_B, 'cloud_plans'), []);
    assert.deepEqual(await as(OWNER_B, 'cloud_payments'), []);
  } finally {
    await db.exec(`RESET ROLE; ALTER TABLE public.businesses ENABLE ROW LEVEL SECURITY;`);
  }
});
await ok('a business removed takes its plan, payments and reminders (ON DELETE CASCADE)', async () => {
  for (const t of ['cloud_plans', 'cloud_payments', 'cloud_plan_reminders']) {
    const r = await one(`SELECT confdeltype FROM pg_constraint WHERE conrelid = 'public.${t}'::regclass AND contype = 'f' AND confrelid = 'public.businesses'::regclass`);
    assert.equal(r?.confdeltype, 'c', t);
  }
});
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
