/**
 * test-migration-163.mjs — A564: stock_transfer_requests (a branch asks another branch for an item), run for real against
 * the WHOLE schema (every migration before 163 replayed into PGlite).
 *
 * Owner, 2026-10-22: "add a feature where employees can search if items are in an inventory of another branch and the
 * manager can request for them".
 *
 *   - 163 runs twice, recorded once; the columns match scripts/schema-index.json; the updated_at trigger.
 *   - born requested; a quantity above 0; two different branches; a branch / product that does not exist refused.
 *   - decided (accepted / declined / cancelled) needs decided_at; a decline needs a reason (not blank, at most 300); the
 *     note at most 300; sent above 0 — fewer or MORE than asked allowed (both kept); unknown statuses refused.
 *   - the transfer it became: removed → the request stays (transfer_id emptied); a person removed → the name stays.
 *   - a branch or a product removed takes its requests.
 *   - RLS: a member reads their business's rows only; anon reads nothing; authenticated cannot write.
 *
 * MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted — listed in the A564 report):
 *   - stock_transfer_requests_reason removed                → "a decline needs a reason" fails
 *   - stock_transfer_requests_two_branches removed          → "two different branches" fails
 *   - ON DELETE SET NULL on transfer_id → CASCADE            → "the transfer removed: the request stays" fails
 *   - the policy USING (true)                               → "never another business's" fails
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
const THIS = '163_stock_transfer_requests.sql';
for (const f of files.filter((f) => num(f) < 163)) await db.exec(sanitize(fs.readFileSync(path.join(MIG, f), 'utf8')));

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
console.log('\nMigration 163 (stock_transfer_requests) — PGlite, every migration\n');
const id = (n) => `00000000-0000-0000-0000-${n.toString(16).padStart(12, '0')}`;
const A = id(0xa), B = id(0xb), W = id(0xa1), K = id(0xa2), BRB = id(0xb1), BRB2 = id(0xb2);
await put('businesses', { id: A, name: 'Test Bar', type: 'retail' });
await put('businesses', { id: B, name: 'Other', type: 'retail' });
await put('branches', { id: W, business_id: A, name: 'Westlands' });
await put('branches', { id: K, business_id: A, name: 'Kilimani' });
await put('branches', { id: BRB, business_id: B, name: 'Theirs' });
await put('branches', { id: BRB2, business_id: B, name: 'Theirs 2' });
const MAX = id(0xa0b), KIM = id(0xa0c);
await put('users', { id: MAX, business_id: A, name: 'Max', email: 'max@test' });
await put('users', { id: KIM, business_id: A, name: 'Kim', email: 'kim@test' });
const P1 = (await put('products', { business_id: A, name: 'Tusker lager' })).id;
const PB = (await put('products', { business_id: B, name: 'Theirs' })).id;
const ins = async (over = {}) => {
  const row = { business_id: A, from_branch_id: K, to_branch_id: W, product_id: P1, quantity: 6, ...over };
  const k = Object.keys(row);
  return (await db.query(`INSERT INTO public.stock_transfer_requests (${k.join(',')}) VALUES (${k.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`, k.map((x) => row[x]))).rows[0];
};

const sql = sanitize(fs.readFileSync(path.join(MIG, THIS), 'utf8'));
await ok('163 runs (and again — idempotent), recorded once; the updated_at trigger', async () => {
  await db.exec(sql); await db.exec(sql);
  assert.equal(Number((await one(`SELECT count(*) AS n FROM public.schema_migrations WHERE version = '163_stock_transfer_requests'`)).n), 1);
  const trg = (await q(`SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.stock_transfer_requests'::regclass AND NOT tgisinternal ORDER BY tgname`)).map((r) => r.tgname);
  assert.deepEqual(trg, ['stock_transfer_requests_set_updated_at']);
});
await ok('the columns match scripts/schema-index.json', async () => {
  const idx = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/schema-index.json'), 'utf8'));
  assert.ok(idx.stock_transfer_requests, 'stock_transfer_requests missing from schema-index.json');
  const cols = (await q(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'stock_transfer_requests'`)).map((r) => r.column_name).sort();
  assert.deepEqual(Object.keys(idx.stock_transfer_requests).sort(), cols);
});
let R1;
await ok('born requested (requested_at set, nothing decided)', async () => {
  R1 = await ins({ note: 'Weekend rush', requested_by: MAX, requested_by_name: 'Max' });
  assert.deepEqual([R1.status, R1.decided_at, R1.transfer_id], ['requested', null, null]);
  assert.ok(R1.requested_at && R1.id);
});
await ok('a quantity above 0; two different branches; a branch or product that does not exist refused', async () => {
  await assert.rejects(() => ins({ quantity: 0 }), /check/i);
  await assert.rejects(() => ins({ quantity: -1 }), /check/i);
  await assert.rejects(() => ins({ from_branch_id: W, to_branch_id: W }), /check|two_branches/i);
  await assert.rejects(() => ins({ from_branch_id: id(0xdead) }), /foreign key|violates/i);
  await assert.rejects(() => ins({ product_id: id(0xbeef) }), /foreign key|violates/i);
});
await ok('decided needs decided_at; a decline needs a reason (not blank, at most 300); a note at most 300; sent above 0 (more than asked allowed); unknown status refused', async () => {
  await assert.rejects(() => db.query(`UPDATE public.stock_transfer_requests SET status = 'accepted' WHERE id = $1`, [R1.id]), /check/i);
  await assert.rejects(() => db.query(`UPDATE public.stock_transfer_requests SET status = 'declined', decided_at = now() WHERE id = $1`, [R1.id]), /check/i);
  await assert.rejects(() => db.query(`UPDATE public.stock_transfer_requests SET status = 'declined', decided_at = now(), decline_reason = '  ' WHERE id = $1`, [R1.id]), /check/i);
  await assert.rejects(() => db.query(`UPDATE public.stock_transfer_requests SET status = 'declined', decided_at = now(), decline_reason = $2 WHERE id = $1`, [R1.id, 'x'.repeat(301)]), /check/i);
  await assert.rejects(() => ins({ note: 'x'.repeat(301) }), /check/i);
  await assert.rejects(() => db.query(`UPDATE public.stock_transfer_requests SET sent_quantity = 0 WHERE id = $1`, [R1.id]), /check/i);
  await db.query(`UPDATE public.stock_transfer_requests SET sent_quantity = 7 WHERE id = $1`, [R1.id]);   // more than the 6 asked: allowed
  await db.query(`UPDATE public.stock_transfer_requests SET sent_quantity = NULL WHERE id = $1`, [R1.id]);
  await assert.rejects(() => db.query(`UPDATE public.stock_transfer_requests SET status = 'maybe', decided_at = now() WHERE id = $1`, [R1.id]), /check/i);
  const d = await ins({ quantity: 2 });
  await db.query(`UPDATE public.stock_transfer_requests SET status = 'declined', decided_at = now(), decided_by = $2, decided_by_name = 'Kim', decline_reason = 'Need it' WHERE id = $1`, [d.id, KIM]);
  assert.equal((await one(`SELECT status FROM public.stock_transfer_requests WHERE id = $1`, [d.id])).status, 'declined');
});
await ok('updated_at moves on a change', async () => {
  await db.query(`UPDATE public.stock_transfer_requests SET updated_at = '2026-01-01T00:00:00Z' WHERE id = $1`, [R1.id]);
  await db.query(`UPDATE public.stock_transfer_requests SET note = 'Changed' WHERE id = $1`, [R1.id]);
  const r = await one(`SELECT updated_at FROM public.stock_transfer_requests WHERE id = $1`, [R1.id]);
  assert.ok(new Date(r.updated_at).getTime() > Date.parse('2026-01-02T00:00:00Z'));
});
await ok('accepted with the transfer it became; the transfer removed → the request stays (transfer_id emptied); a person removed → the name stays', async () => {
  const t = await put('stock_transfers', { business_id: A, from_branch_id: K, to_branch_id: W, transfer_number: 'TRF-0001', created_by: KIM });
  await db.query(`UPDATE public.stock_transfer_requests SET status = 'accepted', decided_at = now(), decided_by = $2, decided_by_name = 'Kim', sent_quantity = 6, transfer_id = $3 WHERE id = $1`, [R1.id, KIM, t.id]);
  await db.query(`DELETE FROM public.stock_transfers WHERE id = $1`, [t.id]);
  const r = await one(`SELECT status, transfer_id FROM public.stock_transfer_requests WHERE id = $1`, [R1.id]);
  assert.deepEqual([r.status, r.transfer_id], ['accepted', null]);
  const GONE = id(0xa0d);
  await put('users', { id: GONE, business_id: A, name: 'Leaver', email: 'leaver@test' });
  await db.query(`UPDATE public.stock_transfer_requests SET decided_by = $2, decided_by_name = 'Leaver' WHERE id = $1`, [R1.id, GONE]);
  await db.query(`DELETE FROM public.users WHERE id = $1`, [GONE]);
  const r2 = await one(`SELECT decided_by, decided_by_name, status FROM public.stock_transfer_requests WHERE id = $1`, [R1.id]);
  assert.deepEqual([r2.decided_by, r2.decided_by_name, r2.status], [null, 'Leaver', 'accepted']);
});
await ok('a branch or a product removed takes its requests', async () => {
  const P2 = (await put('products', { business_id: A, name: 'Gone' })).id;
  const g = await ins({ product_id: P2 });
  await db.query(`DELETE FROM public.products WHERE id = $1`, [P2]);
  assert.equal(await one(`SELECT id FROM public.stock_transfer_requests WHERE id = $1`, [g.id]), undefined);
  const KR = id(0xa3);
  await put('branches', { id: KR, business_id: A, name: 'Karen' });
  const h = await ins({ from_branch_id: KR });
  await db.query(`DELETE FROM public.branches WHERE id = $1`, [KR]);
  assert.equal(await one(`SELECT id FROM public.stock_transfer_requests WHERE id = $1`, [h.id]), undefined);
});
await ok('RLS: a member of the business reads its rows, never another business’s; anon cannot read; authenticated cannot write', async () => {
  await ins({ business_id: B, from_branch_id: BRB, to_branch_id: BRB2, product_id: PB });
  assert.equal((await one(`SELECT relrowsecurity FROM pg_class WHERE oid = 'public.stock_transfer_requests'::regclass`)).relrowsecurity, true);
  assert.equal((await one(`SELECT has_table_privilege('anon', 'public.stock_transfer_requests', 'SELECT') AS x`)).x, false);
  assert.equal((await one(`SELECT has_table_privilege('authenticated', 'public.stock_transfer_requests', 'INSERT') AS x`)).x, false, 'writes go through the server');
  const MEMBER = id(0xa0a);
  await db.query(`INSERT INTO auth.users (id, email) VALUES ($1, 'member@test') ON CONFLICT DO NOTHING`, [MEMBER]);
  await put('users', { id: MEMBER, business_id: A, name: 'Member', email: 'member@test' });
  await db.exec(`GRANT USAGE ON SCHEMA auth TO authenticated; GRANT SELECT ON public.users TO authenticated;`);
  await db.exec(`ALTER TABLE public.users DISABLE ROW LEVEL SECURITY;`);
  try {
    await db.exec(`SET row_security = on; SET test.uid = '${MEMBER}'; SET ROLE authenticated;`);
    const seen = (await q(`SELECT business_id FROM public.stock_transfer_requests`)).map((r) => r.business_id);
    await db.exec(`RESET ROLE; RESET test.uid;`);
    assert.ok(seen.length >= 2 && seen.every((b) => b === A), `saw ${seen.join(', ')}`);
  } finally {
    await db.exec(`RESET ROLE;`);
    await db.exec(`ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;`);
  }
});
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
