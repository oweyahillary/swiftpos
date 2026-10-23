/**
 * test-migration-157.mjs — A545: credit_confirmations (every sale on account confirmed or disputed by a manager), run for
 * real against the WHOLE schema (every migration before 157 replayed into PGlite).
 *
 * Owner, 2026-10-21: "for credit I think the manager has to know which sale is on credit and they have to confirm that it
 * was done."
 *
 *   - 157 runs twice, recorded once; the columns match scripts/schema-index.json; the updated_at trigger.
 *   - one row per sale (the order is the key; a missing order refused); born awaiting by default.
 *   - born confirmed only with decided_at; a dispute needs a reason (not blank, at most 300); states / sources checked.
 *   - a sale removed takes its row; a person removed empties decided_by and keeps the row.
 *   - RLS: a member reads their business's rows only; anon reads nothing; authenticated cannot write.
 *
 * MUTATIONS TO CONFIRM BITE (checked by hand, 2026-10-21):
 *   - credit_confirmations_reason removed                  → "a dispute needs a reason" fails
 *   - credit_confirmations_decided removed                 → "born confirmed … need decided_at" fails
 *   - ON DELETE CASCADE removed from order_id              → "a sale removed takes its row" fails
 *   - the policy USING (true)                              → "never another business's" fails
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
// auth.uid() reads a test setting, so the RLS case can sign in as a member (NULL otherwise, as the other tests).
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
const THIS = '157_credit_confirmations.sql';
for (const f of files.filter((f) => num(f) < 157)) await db.exec(sanitize(fs.readFileSync(path.join(MIG, f), 'utf8')));

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
const maxSeq = async () => Number((await one(`SELECT COALESCE(max(seq), 0) AS m FROM public.sync_changes`)).m);
const since = async (from) => (await q(`SELECT table_name, row_id, topic, op, branch_id FROM public.sync_changes WHERE seq > $1 ORDER BY seq`, [from]))
  .map((r) => `${r.table_name}:${r.row_id}:${r.topic}:${r.op}@${r.branch_id ?? 'every'}`);
const ver = async (biz) => Number((await one(`SELECT version FROM public.sync_versions WHERE business_id = $1 AND topic = 'catalogue'`, [biz]))?.version ?? -1);
console.log('\nMigration 157 (credit_confirmations) — PGlite, every migration\n');
const id = (n) => `00000000-0000-0000-0000-${n.toString(16).padStart(12, '0')}`;
const A = id(0xa), B = id(0xb), BR1 = id(0xa1), BR2 = id(0xa2), BRB = id(0xb1);
await put('businesses', { id: A, name: 'Test Grill', type: 'restaurant' });
await put('businesses', { id: B, name: 'Other', type: 'restaurant' });
await put('branches', { id: BR1, business_id: A, name: 'Westlands' });
await put('branches', { id: BR2, business_id: A, name: 'Kilimani' });
await put('branches', { id: BRB, business_id: B, name: 'Theirs' });
const MGR = id(0xa0b), CASH = id(0xa0c);
await put('users', { id: MGR, business_id: A, name: 'Max', email: 'max@test' });
await put('users', { id: CASH, business_id: A, name: 'Cate', email: 'cate@test' });
const CUST = (await put('customers', { business_id: A, name: 'Acme Ltd' })).id;
const order = async (biz, branch, n) => (await put('orders', { business_id: biz, branch_id: branch, order_number: `ORD-${n}`, total: 500 })).id;
const O1 = await order(A, BR1, 1), O2 = await order(A, BR1, 2), O3 = await order(A, BR2, 3), OB = await order(B, BRB, 4), OGONE = await order(A, BR1, 5);

const sql = sanitize(fs.readFileSync(path.join(MIG, THIS), 'utf8'));
await ok('157 runs (and again — idempotent), recorded once; the updated_at trigger', async () => {
  await db.exec(sql); await db.exec(sql);
  assert.equal(Number((await one(`SELECT count(*) AS n FROM public.schema_migrations WHERE version = '157_credit_confirmations'`)).n), 1);
  const trg = (await q(`SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.credit_confirmations'::regclass AND NOT tgisinternal ORDER BY tgname`)).map((r) => r.tgname);
  assert.deepEqual(trg, ['credit_confirmations_set_updated_at']);
});
await ok('the columns match scripts/schema-index.json', async () => {
  const idx = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/schema-index.json'), 'utf8'));
  assert.ok(idx.credit_confirmations, 'credit_confirmations missing from schema-index.json');
  const cols = (await q(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'credit_confirmations'`)).map((r) => r.column_name).sort();
  assert.deepEqual(Object.keys(idx.credit_confirmations).sort(), cols);
});
await ok('a sale on account is born awaiting (defaults: state awaiting, source web, not over the limit)', async () => {
  await db.query(`INSERT INTO public.credit_confirmations (order_id, business_id, branch_id, customer_id, amount, cashier_id) VALUES ($1, $2, $3, $4, 500, $5)`, [O1, A, BR1, CUST, CASH]);
  const r = await one(`SELECT state, source, over_limit, decided_at FROM public.credit_confirmations WHERE order_id = $1`, [O1]);
  assert.deepEqual([r.state, r.source, r.over_limit, r.decided_at], ['awaiting', 'web', false, null]);
});
await ok('one row per sale (the order is the key); an order that does not exist is refused', async () => {
  await assert.rejects(() => db.query(`INSERT INTO public.credit_confirmations (order_id, business_id, amount) VALUES ($1, $2, 1)`, [O1, A]), /duplicate|unique|primary/i);
  await assert.rejects(() => db.query(`INSERT INTO public.credit_confirmations (order_id, business_id, amount) VALUES ($1, $2, 1)`, [id(0xdead), A]), /foreign key|violates/i);
});
await ok('born confirmed when approved at the sale (decided_by + decided_at); confirmed / disputed need decided_at', async () => {
  await db.query(`INSERT INTO public.credit_confirmations (order_id, business_id, branch_id, amount, state, approved_at_sale_by, decided_by, decided_at) VALUES ($1, $2, $3, 200, 'confirmed', $4, $4, now())`, [O2, A, BR1, MGR]);
  await assert.rejects(() => db.query(`INSERT INTO public.credit_confirmations (order_id, business_id, amount, state) VALUES ($1, $2, 1, 'confirmed')`, [O3, A]), /check|credit_confirmations_decided/i);
});
await ok('a dispute needs a reason (and at most 300 characters); unknown states and sources refused; amount never negative', async () => {
  await assert.rejects(() => db.query(`UPDATE public.credit_confirmations SET state = 'disputed', decided_at = now() WHERE order_id = $1`, [O1]), /check/i);
  await assert.rejects(() => db.query(`UPDATE public.credit_confirmations SET state = 'disputed', decided_at = now(), dispute_reason = '   ' WHERE order_id = $1`, [O1]), /check/i);
  await assert.rejects(() => db.query(`UPDATE public.credit_confirmations SET state = 'disputed', decided_at = now(), dispute_reason = $2 WHERE order_id = $1`, [O1, 'x'.repeat(301)]), /check/i);
  await assert.rejects(() => db.query(`UPDATE public.credit_confirmations SET state = 'maybe' WHERE order_id = $1`, [O1]), /check/i);
  await assert.rejects(() => db.query(`UPDATE public.credit_confirmations SET source = 'phone' WHERE order_id = $1`, [O1]), /check/i);
  await assert.rejects(() => db.query(`UPDATE public.credit_confirmations SET amount = -1 WHERE order_id = $1`, [O1]), /check/i);
  await db.query(`UPDATE public.credit_confirmations SET state = 'disputed', decided_at = now(), decided_by = $2, dispute_reason = 'Customer says not theirs' WHERE order_id = $1`, [O1, MGR]);
  assert.equal((await one(`SELECT state FROM public.credit_confirmations WHERE order_id = $1`, [O1])).state, 'disputed');
});
await ok('updated_at moves on a change', async () => {
  await db.query(`UPDATE public.credit_confirmations SET updated_at = '2026-01-01T00:00:00Z' WHERE order_id = $1`, [O2]);
  await db.query(`UPDATE public.credit_confirmations SET over_limit = true WHERE order_id = $1`, [O2]);
  const r = await one(`SELECT updated_at FROM public.credit_confirmations WHERE order_id = $1`, [O2]);
  assert.ok(new Date(r.updated_at).getTime() > Date.parse('2026-01-02T00:00:00Z'));
});
await ok('a sale removed takes its row; a person removed leaves the row (decided_by emptied)', async () => {
  await db.query(`INSERT INTO public.credit_confirmations (order_id, business_id, amount) VALUES ($1, $2, 10)`, [OGONE, A]);
  await db.query(`DELETE FROM public.orders WHERE id = $1`, [OGONE]);
  assert.equal(await one(`SELECT order_id FROM public.credit_confirmations WHERE order_id = $1`, [OGONE]), undefined);
  const GONE = id(0xa0d);
  await put('users', { id: GONE, business_id: A, name: 'Leaver', email: 'leaver@test' });
  await db.query(`UPDATE public.credit_confirmations SET decided_by = $2 WHERE order_id = $1`, [O1, GONE]);
  await db.query(`DELETE FROM public.users WHERE id = $1`, [GONE]);
  const r = await one(`SELECT decided_by, state FROM public.credit_confirmations WHERE order_id = $1`, [O1]);
  assert.deepEqual([r.decided_by, r.state], [null, 'disputed']);
});
await ok('RLS: a member of the business reads its rows, never another business’s; anon cannot read', async () => {
  await db.query(`INSERT INTO public.credit_confirmations (order_id, business_id, branch_id, amount) VALUES ($1, $2, $3, 70)`, [OB, B, BRB]);
  assert.equal((await one(`SELECT relrowsecurity FROM pg_class WHERE oid = 'public.credit_confirmations'::regclass`)).relrowsecurity, true);
  assert.equal((await one(`SELECT has_table_privilege('anon', 'public.credit_confirmations', 'SELECT') AS x`)).x, false);
  assert.equal((await one(`SELECT has_table_privilege('authenticated', 'public.credit_confirmations', 'UPDATE') AS x`)).x, false, 'writes go through the server');
  const MEMBER = id(0xa0a);
  await db.query(`INSERT INTO auth.users (id, email) VALUES ($1, 'member@test') ON CONFLICT DO NOTHING`, [MEMBER]);
  await put('users', { id: MEMBER, business_id: A, name: 'Member', email: 'member@test' });
  await db.exec(`GRANT USAGE ON SCHEMA auth TO authenticated; GRANT SELECT ON public.users TO authenticated;`);
  await db.exec(`ALTER TABLE public.users DISABLE ROW LEVEL SECURITY;`);
  try {
    await db.exec(`SET row_security = on; SET test.uid = '${MEMBER}'; SET ROLE authenticated;`);
    const seen = (await q(`SELECT business_id FROM public.credit_confirmations`)).map((r) => r.business_id);
    await db.exec(`RESET ROLE; RESET test.uid;`);
    assert.ok(seen.length >= 2 && seen.every((b) => b === A), `saw ${seen.join(', ')}`);
  } finally {
    await db.exec(`RESET ROLE;`);
    await db.exec(`ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;`);
  }
});
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
