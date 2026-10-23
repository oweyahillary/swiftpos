/**
 * test-migration-166.mjs — A576: loss_alerts (the owner's watch list of loss-prevention alerts), run for real against the
 * WHOLE schema (every migration before 166 replayed into PGlite).
 *
 * Owner, 2026-10-23: voids and discounts are a warning only, for investigation; at most 10 shown; to the owner and the
 * managers, never on the cashier's screen.
 *
 *   - 166 runs twice, recorded once; the columns match scripts/schema-index.json; the updated_at trigger; the indexes.
 *   - one alert per (business, alert_key): the job's upsert on that pair updates the same row (idempotent) — and keeps
 *     notified_at / dismissed_at; another business may use the same key.
 *   - only the known kinds and periods; a message 1..600; a count not below 0; a dismiss note at most 300.
 *   - a person removed → the alert stays (staff_id emptied); a branch removed takes its alerts; a business removed too.
 *   - RLS: the owner reads their business's rows only; a member who is not the owner reads none (the alerts are about
 *     staff); anon reads nothing; authenticated cannot write.
 *
 * MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted — listed in the A576 report):
 *   - loss_alerts_one_per_key removed                       → "one alert per key" fails
 *   - the policy on users (any member) instead of the owner → "RLS: … a member who is not the owner reads none" fails
 *   - ON DELETE SET NULL on staff_id → CASCADE               → "a person removed: the alert stays" fails
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
const THIS = '166_loss_alerts.sql';
for (const f of files.filter((f) => num(f) < 166)) await db.exec(sanitize(fs.readFileSync(path.join(MIG, f), 'utf8')));

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
console.log('\nMigration 166 (loss_alerts) — PGlite, every migration\n');
const id = (n) => `00000000-0000-0000-0000-${n.toString(16).padStart(12, '0')}`;
const A = id(0xa), B = id(0xb), W = id(0xa1), K = id(0xa2), BRB = id(0xb1);
const OWNER = id(0xa0f), OWNER_B = id(0xb0f);
await db.query(`INSERT INTO auth.users (id, email) VALUES ($1, 'owner@a'), ($2, 'owner@b')`, [OWNER, OWNER_B]);
await put('businesses', { id: A, name: 'Test Bar', type: 'restaurant', owner_id: OWNER });
await put('businesses', { id: B, name: 'Other', type: 'retail', owner_id: OWNER_B });
await put('branches', { id: W, business_id: A, name: 'Westlands' });
await put('branches', { id: K, business_id: A, name: 'Kilimani' });
await put('branches', { id: BRB, business_id: B, name: 'Theirs' });
const MARY = id(0xa0b);
await put('users', { id: MARY, business_id: A, name: 'Mary', email: 'mary@test' });
const base = (over = {}) => ({ business_id: A, branch_id: W, staff_id: MARY, alert_key: `paid_voids:day:2026-10-23:${W}:${MARY}`,
  kind: 'paid_voids', period: 'day', business_date: '2026-10-23', count: 6, peer_low: 0, peer_high: 1, score: 97,
  message: 'Mary voided 6 paid orders today (others: 0-1). Worth a look.', link: '/dashboard/reports?tab=voids', ...over });
const ins = async (over = {}) => {
  const row = base(over); const k = Object.keys(row);
  return (await db.query(`INSERT INTO public.loss_alerts (${k.join(',')}) VALUES (${k.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`, k.map((x) => row[x]))).rows[0];
};
/** The job's write: INSERT … ON CONFLICT (business_id, alert_key) DO UPDATE the figures (what supabase-js upsert sends). */
const upsert = async (over = {}) => {
  const row = base(over); const k = Object.keys(row);
  const sets = k.filter((x) => !['business_id', 'alert_key'].includes(x)).map((x) => `${x} = EXCLUDED.${x}`).join(', ');
  return (await db.query(`INSERT INTO public.loss_alerts (${k.join(',')}) VALUES (${k.map((_, i) => `$${i + 1}`).join(',')})
    ON CONFLICT (business_id, alert_key) DO UPDATE SET ${sets} RETURNING *`, k.map((x) => row[x]))).rows[0];
};

const sql = sanitize(fs.readFileSync(path.join(MIG, THIS), 'utf8'));
await ok('166 runs (and again — idempotent), recorded once; the updated_at trigger; the indexes', async () => {
  await db.exec(sql); await db.exec(sql);
  assert.equal(Number((await one(`SELECT count(*) AS n FROM public.schema_migrations WHERE version = '166_loss_alerts'`)).n), 1);
  const trg = (await q(`SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.loss_alerts'::regclass AND NOT tgisinternal`)).map((r) => r.tgname);
  assert.deepEqual(trg, ['loss_alerts_set_updated_at']);
  const idx = (await q(`SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`)).map((r) => r.indexname);
  for (const n of ['loss_alerts_business_date', 'loss_alerts_branch_date', 'idx_orders_voided_at', 'idx_shifts_confirmed_at', 'parking_sessions_voided_ended'])
    assert.ok(idx.includes(n), `index ${n} missing`);
});
await ok('the columns match scripts/schema-index.json', async () => {
  const idx = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/schema-index.json'), 'utf8'));
  assert.ok(idx.loss_alerts, 'loss_alerts missing from schema-index.json');
  const cols = (await q(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'loss_alerts'`)).map((r) => r.column_name).sort();
  assert.deepEqual(Object.keys(idx.loss_alerts).sort(), cols);
});
let R1;
await ok('one alert per key: the job writes it again as an update (the count grows) and keeps notified_at / dismissed_at; another business may use the same key', async () => {
  R1 = await upsert({ count: 3 });
  await db.query(`UPDATE public.loss_alerts SET notified_at = now(), dismissed_at = now(), dismiss_note = 'Spoke to Mary' WHERE id = $1`, [R1.id]);
  const again = await upsert({ count: 6 });
  assert.equal(again.id, R1.id);
  const r = await one(`SELECT count, notified_at, dismissed_at, dismiss_note FROM public.loss_alerts WHERE id = $1`, [R1.id]);
  assert.equal(r.count, 6);
  assert.ok(r.notified_at && r.dismissed_at);
  assert.equal(r.dismiss_note, 'Spoke to Mary');
  assert.equal(Number((await one(`SELECT count(*) AS n FROM public.loss_alerts WHERE business_id = $1`, [A])).n), 1);
  await assert.rejects(() => ins(), /duplicate|unique/i);
  await ins({ business_id: B, branch_id: BRB, staff_id: null });   // the same key at another business: its own row
});
await ok('only the known kinds and periods; a message 1..600; a count not below 0; a dismiss note at most 300', async () => {
  await assert.rejects(() => ins({ alert_key: 'x1', kind: 'theft' }), /check/i);
  await assert.rejects(() => ins({ alert_key: 'x2', period: 'month' }), /check/i);
  await assert.rejects(() => ins({ alert_key: 'x3', message: '' }), /check/i);
  await assert.rejects(() => ins({ alert_key: 'x4', message: 'x'.repeat(601) }), /check/i);
  await assert.rejects(() => ins({ alert_key: 'x5', count: -1 }), /check/i);
  await assert.rejects(() => db.query(`UPDATE public.loss_alerts SET dismiss_note = $2 WHERE id = $1`, [R1.id, 'x'.repeat(301)]), /check/i);
  for (const k of ['many_voids', 'many_refunds', 'big_discounts', 'frequent_discounts', 'free_sales', 'cash_short', 'price_below_list', 'kitchen_removed', 'parking_no_charge'])
    await ins({ alert_key: `ok-${k}`, kind: k, period: 'week' });
});
await ok('updated_at moves on a change', async () => {
  await db.query(`UPDATE public.loss_alerts SET updated_at = '2026-01-01T00:00:00Z' WHERE id = $1`, [R1.id]);
  await db.query(`UPDATE public.loss_alerts SET count = 7 WHERE id = $1`, [R1.id]);
  const r = await one(`SELECT updated_at FROM public.loss_alerts WHERE id = $1`, [R1.id]);
  assert.ok(new Date(r.updated_at).getTime() > Date.parse('2026-01-02T00:00:00Z'));
});
await ok('a person removed: the alert stays (staff_id emptied); a branch removed takes its alerts', async () => {
  const GONE = id(0xa0d);
  await put('users', { id: GONE, business_id: A, name: 'Leaver', email: 'leaver@test' });
  const g = await ins({ alert_key: 'leaver', staff_id: GONE });
  await db.query(`DELETE FROM public.users WHERE id = $1`, [GONE]);
  const r = await one(`SELECT staff_id FROM public.loss_alerts WHERE id = $1`, [g.id]);
  assert.ok(r, 'the alert went with the person');
  assert.equal(r.staff_id, null);
  const k = await ins({ alert_key: 'kilimani', branch_id: K });
  await db.query(`DELETE FROM public.branches WHERE id = $1`, [K]);
  assert.equal(await one(`SELECT id FROM public.loss_alerts WHERE id = $1`, [k.id]), undefined);
});
await ok("RLS: the owner reads their business's rows only; a member who is not the owner reads none; anon cannot read; authenticated cannot write", async () => {
  assert.equal((await one(`SELECT relrowsecurity FROM pg_class WHERE oid = 'public.loss_alerts'::regclass`)).relrowsecurity, true);
  assert.equal((await one(`SELECT has_table_privilege('anon', 'public.loss_alerts', 'SELECT') AS x`)).x, false);
  assert.equal((await one(`SELECT has_table_privilege('authenticated', 'public.loss_alerts', 'INSERT') AS x`)).x, false, 'writes go through the server');
  const MEMBER = id(0xa0a);
  await db.query(`INSERT INTO auth.users (id, email) VALUES ($1, 'member@test') ON CONFLICT DO NOTHING`, [MEMBER]);
  await put('users', { id: MEMBER, business_id: A, name: 'Member', email: 'member@test' });
  await db.exec(`GRANT USAGE ON SCHEMA auth TO authenticated; GRANT SELECT ON public.users, public.businesses TO authenticated;`);
  await db.exec(`ALTER TABLE public.users DISABLE ROW LEVEL SECURITY; ALTER TABLE public.businesses DISABLE ROW LEVEL SECURITY;`);
  const as = async (uid) => {
    await db.exec(`SET row_security = on; SET test.uid = '${uid}'; SET ROLE authenticated;`);
    try { return (await q(`SELECT business_id FROM public.loss_alerts`)).map((r) => r.business_id); }
    finally { await db.exec(`RESET ROLE; RESET test.uid;`); }
  };
  try {
    const owner = await as(OWNER);
    assert.ok(owner.length >= 2 && owner.every((b) => b === A), `the owner saw ${owner.join(', ')}`);
    const member = await as(MEMBER);
    assert.deepEqual(member, [], 'a staff member (not the owner) reads no alert');
  } finally {
    await db.exec(`RESET ROLE;`);
    await db.exec(`ALTER TABLE public.users ENABLE ROW LEVEL SECURITY; ALTER TABLE public.businesses ENABLE ROW LEVEL SECURITY;`);
  }
});
await ok('a business removed takes its alerts (business_id ON DELETE CASCADE)', async () => {
  const r = await one(`SELECT confdeltype FROM pg_constraint WHERE conrelid = 'public.loss_alerts'::regclass AND contype = 'f'
    AND confrelid = 'public.businesses'::regclass`);
  assert.equal(r?.confdeltype, 'c');
});
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
