/**
 * test-migration-81.mjs — runs migration 81 against real PostgreSQL (PGlite) on
 * a minimal fixture, and proves the property the enrolment flow depends on:
 * a code is SINGLE-USE and EXPIRES. The redeem statement asserted here is the
 * exact atomic UPDATE the /enrol/redeem endpoint will run — so the burn is
 * proven at the layer that enforces it (the database), not in application code
 * that could forget the guard. Register D4.
 *
 * Picked up by run-migration-tests.mjs (glob), which is the CI entry point.
 */
import { PGlite } from '@electric-sql/pglite';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.resolve(HERE, '../migrations/81_device_enrolment_codes.sql');
const sql = fs.readFileSync(MIGRATION, 'utf8');

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name} — ${e.message}`); }
};

const db = new PGlite();

// ── Fixture: only what migration 81 references, plus a uuid_generate_v4 shim ──
// Production has uuid-ossp; PGlite does not bundle it, so map it to the built-in.
await db.exec(`
  CREATE OR REPLACE FUNCTION public.uuid_generate_v4() RETURNS uuid
    LANGUAGE sql AS $$ SELECT gen_random_uuid() $$;
  CREATE TABLE public.businesses (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text);
  CREATE TABLE public.branches   (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), business_id uuid, name text);
  CREATE TABLE public.users      (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text);
  CREATE TABLE public.schema_migrations (version text PRIMARY KEY, notes text, applied_at timestamptz DEFAULT now());
`);

const { rows: [biz] }    = await db.query(`INSERT INTO public.businesses (name) VALUES ('Acme') RETURNING id`);
const { rows: [branch] } = await db.query(`INSERT INTO public.branches (business_id, name) VALUES ($1,'Main') RETURNING id`, [biz.id]);
const { rows: [owner] }  = await db.query(`INSERT INTO public.users (email) VALUES ('o@acme.test') RETURNING id`);

// ── Apply the migration ──────────────────────────────────────────────────────
await db.exec(sql);

const exists = await db.query(
  `SELECT count(*)::int AS n FROM information_schema.tables
   WHERE table_schema='public' AND table_name='device_enrolment_codes'`);
ok('table device_enrolment_codes exists', () => assert.strictEqual(exists.rows[0].n, 1));
const relrls = await db.query(
  `SELECT relrowsecurity FROM pg_class WHERE relname='device_enrolment_codes'`);
ok('RLS is enabled', () => assert.strictEqual(relrls.rows[0].relrowsecurity, true));

const rec = await db.query(
  `SELECT count(*)::int AS n FROM public.schema_migrations WHERE version='81_device_enrolment_codes'`);
ok('records itself in schema_migrations', () => assert.strictEqual(rec.rows[0].n, 1));

// Re-runnable: applying twice must not error, and must not double-log.
await db.exec(sql);
const rec2 = await db.query(
  `SELECT count(*)::int AS n FROM public.schema_migrations WHERE version='81_device_enrolment_codes'`);
ok('migration is idempotent (re-runnable, single log row)', () => assert.strictEqual(rec2.rows[0].n, 1));

// ── Insert a live code and an expired code ───────────────────────────────────
const insert = `INSERT INTO public.device_enrolment_codes
  (business_id, branch_id, code_hash, created_by, expires_at)
  VALUES ($1,$2,$3,$4, now() + interval '1 hour') RETURNING id`;
await db.query(insert, [biz.id, branch.id, 'hash-live', owner.id]);
await db.query(
  `INSERT INTO public.device_enrolment_codes (business_id, code_hash, created_by, expires_at)
   VALUES ($1,'hash-expired',$2, now() - interval '1 minute')`, [biz.id, owner.id]);

// code_hash is UNIQUE — two codes cannot share a hash.
let dupThrew = false;
try { await db.query(insert, [biz.id, branch.id, 'hash-live', owner.id]); }
catch { dupThrew = true; }
ok('code_hash is UNIQUE', () => assert.ok(dupThrew, 'a duplicate code_hash was allowed'));

// FK integrity — a code for a non-existent business is rejected.
let fkThrew = false;
try { await db.query(insert, ['00000000-0000-0000-0000-000000000000', null, 'hash-x', owner.id]); }
catch { fkThrew = true; }
ok('business_id FK is enforced', () => assert.ok(fkThrew, 'a code referencing a missing business was allowed'));

// ── THE CORE: the atomic redeem the endpoint will run ────────────────────────
// A code is redeemable iff it is active AND unexpired; redeeming burns it.
const REDEEM = `UPDATE public.device_enrolment_codes
  SET status='redeemed', redeemed_at=now(), redeemed_device_id=$2
  WHERE code_hash=$1 AND status='active' AND expires_at > now()
  RETURNING id, business_id, branch_id`;

const first = await db.query(REDEEM, ['hash-live', 'device-A']);
ok('a live code redeems once (returns the row)', () =>
  assert.strictEqual(first.rows.length, 1));
ok('redeem returns the business + branch to bind', () => {
  assert.strictEqual(first.rows[0].business_id, biz.id);
  assert.strictEqual(first.rows[0].branch_id, branch.id);
});

const second = await db.query(REDEEM, ['hash-live', 'device-B']);
ok('the SAME code cannot be redeemed twice (single-use burn)', () =>
  assert.strictEqual(second.rows.length, 0));

const burned = await db.query(
  `SELECT status, redeemed_device_id FROM public.device_enrolment_codes WHERE code_hash='hash-live'`);
ok('a burned code keeps the FIRST device, not the second', () => {
  assert.strictEqual(burned.rows[0].status, 'redeemed');
  assert.strictEqual(burned.rows[0].redeemed_device_id, 'device-A');
});

const expired = await db.query(REDEEM, ['hash-expired', 'device-C']);
ok('an expired code does not redeem', () =>
  assert.strictEqual(expired.rows.length, 0));
const stillActive = await db.query(
  `SELECT status FROM public.device_enrolment_codes WHERE code_hash='hash-expired'`);
ok('an expired code is left untouched by a redeem attempt', () =>
  assert.strictEqual(stillActive.rows[0].status, 'active'));

const unknown = await db.query(REDEEM, ['no-such-hash', 'device-D']);
ok('an unknown code redeems nothing', () =>
  assert.strictEqual(unknown.rows.length, 0));

await db.close();
console.log(`\n${fail === 0
  ? `migration 81: all ${pass} checks passed — codes are single-use and expire.`
  : `migration 81: ${fail} FAILED (${pass} passed)`}`);
process.exit(fail === 0 ? 0 : 1);
