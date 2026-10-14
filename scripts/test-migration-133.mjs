/**
 * test-migration-133.mjs — cloud audit 2026-10-14: shifts.opened_via (P0-1) and order_price_variances (P0-2), run for real
 * against the WHOLE schema (every migration replayed into PGlite).
 *
 * Every migration before 133 is replayed, shifts are written the way a till and the web wrote them before 133, then 133
 * runs: the backfill marks a shift that names its trading day 'till' and one that does not 'web'; the column refuses any
 * other value; order_price_variances keeps one row per sale, its difference is always catalogue - till, it goes with its
 * order, RLS is on; 133 runs twice without error and records itself once.
 *
 * MUTATIONS TO CONFIRM BITE: the backfill's CASE reversed → "a till's shift is marked till" fails; the unique index on
 * order_id dropped → "one row per sale" fails; ON DELETE CASCADE dropped → "goes with its order" fails; the difference
 * CHECK dropped → "difference is always catalogue - till" fails.
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
const THIS = '133_shift_origin_price_variances.sql';
for (const f of files.filter((f) => num(f) < 133)) await db.exec(sanitize(fs.readFileSync(path.join(MIG, f), 'utf8')));

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

console.log('\nMigration 133 (shift origin, offline price differences) — PGlite, every migration\n');
const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const B = id(0xb1), BR = id(0xa1), U = id(0xe1), DAY = id(0xd1), TILL_SHIFT = id(0x51), WEB_SHIFT = id(0x52), O1 = id(0x71), O2 = id(0x72);
await put('businesses', { id: B, name: 'African Fries', type: 'restaurant' });
await put('branches', { id: BR, business_id: B, name: 'Westlands' });
await put('users', { id: U, business_id: B, name: 'Mary' });
await put('business_days', { id: DAY, business_id: B, branch_id: BR, device_id: 'dev-T1', business_date: '2026-10-14', opened_at: '2026-10-14T05:00:00Z', status: 'open' });
// Before 133: a till's shift (pushed, names its day) and a web shift (POST /shifts/open, no day), both open on T1.
await put('shifts', { id: TILL_SHIFT, business_id: B, branch_id: BR, cashier_id: U, opened_by: U, device_id: 'dev-T1', terminal_code: 'T1', business_day_id: DAY, status: 'open', opening_float: 1000, opened_at: '2026-10-14T05:00:00Z' });
await put('shifts', { id: WEB_SHIFT, business_id: B, branch_id: BR, cashier_id: U, opened_by: U, device_id: 'dev-T2', terminal_code: 'T2', business_day_id: null, status: 'open', opening_float: 0, opened_at: '2026-10-14T06:00:00Z' });

await db.exec(sanitize(fs.readFileSync(path.join(MIG, THIS), 'utf8')));
for (const f of files.filter((f) => num(f) > 133)) await db.exec(sanitize(fs.readFileSync(path.join(MIG, f), 'utf8')));   // any later migration still runs on top

await ok('backfill: a till\'s shift (names its trading day) is marked till; a web shift is marked web', async () => {
  assert.equal((await one(`SELECT opened_via FROM public.shifts WHERE id = $1`, [TILL_SHIFT])).opened_via, 'till');
  assert.equal((await one(`SELECT opened_via FROM public.shifts WHERE id = $1`, [WEB_SHIFT])).opened_via, 'web');
});
await ok('opened_via takes web, till or nothing — anything else is refused', async () => {
  await db.query(`UPDATE public.shifts SET opened_via = NULL WHERE id = $1`, [WEB_SHIFT]);
  await assert.rejects(db.query(`UPDATE public.shifts SET opened_via = 'phone' WHERE id = $1`, [WEB_SHIFT]), /opened_via/);
  await db.query(`UPDATE public.shifts SET opened_via = 'web' WHERE id = $1`, [WEB_SHIFT]);
});

await put('orders', { id: O1, business_id: B, branch_id: BR, order_number: 'T1-0001', total: 300, status: 'completed' });
await put('orders', { id: O2, business_id: B, branch_id: BR, order_number: 'T1-0002', total: 100, status: 'completed' });
const variance = (order, cat, till, extra = {}) => db.query(
  `INSERT INTO public.order_price_variances (business_id, branch_id, order_id, order_number, catalogue_total, till_total, difference, reason, suspicious, sold_at)
   VALUES ($1, $2, $3, 'T1', $4, $5, $6, $7, $8, '2026-10-14T09:00:00Z')`,
  [B, BR, order, cat, till, extra.difference ?? cat - till, extra.reason ?? 'price changed before sync', extra.suspicious ?? false]);
await ok('a price difference is recorded: catalogue 400, till 300, difference 100 (a loss)', async () => {
  await variance(O1, 400, 300);
  const r = await one(`SELECT difference, suspicious, created_at IS NOT NULL AS stamped FROM public.order_price_variances WHERE order_id = $1`, [O1]);
  assert.equal(Number(r.difference), 100); assert.equal(r.suspicious, false); assert.equal(r.stamped, true);
});
await ok('one row per sale (a retried sync can never count the same loss twice)', async () => {
  await assert.rejects(variance(O1, 400, 300), /duplicate key|unique/i);
});
await ok('the difference is always catalogue - till', async () => {
  await assert.rejects(variance(O2, 400, 100, { difference: 50 }), /difference/);
  await variance(O2, 400, 100, { suspicious: true });
});
await ok('it goes with its order (a test-data clear deletes the sale and its difference)', async () => {
  await db.query(`DELETE FROM public.orders WHERE id = $1`, [O2]);
  assert.equal(Number((await one(`SELECT count(*)::int AS n FROM public.order_price_variances WHERE order_id = $1`, [O2])).n), 0);
});
await ok('RLS is on for order_price_variances', async () => {
  assert.equal((await one(`SELECT relrowsecurity FROM pg_class WHERE relname = 'order_price_variances'`)).relrowsecurity, true);
});
await ok('133 runs twice without error, keeps the marks, and records itself once', async () => {
  await db.exec(sanitize(fs.readFileSync(path.join(MIG, THIS), 'utf8')));
  assert.equal(Number((await one(`SELECT count(*)::int AS n FROM public.schema_migrations WHERE version = '133_shift_origin_price_variances'`)).n), 1);
  assert.equal((await one(`SELECT opened_via FROM public.shifts WHERE id = $1`, [TILL_SHIFT])).opened_via, 'till');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
