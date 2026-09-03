/**
 * test-migration-97.mjs — user_devices.retired_at / retired_by, against real Postgres (PGlite).
 *
 * WHAT THIS PINS (register A184 Tier 3)
 * -------------------------------------
 * Migration 97 adds nullable retired_at + retired_by to user_devices so an owner
 * can retire a dead terminal (it leaves the fleet view + not-syncing banner but
 * keeps its history). It must:
 *   - add both columns;
 *   - be ADDITIVE — leave existing rows intact, both columns NULL;
 *   - create the partial index used by the fleet query;
 *   - be idempotent (ADD COLUMN / CREATE INDEX IF NOT EXISTS) — a second run is a no-op;
 *   - record itself in schema_migrations.
 *
 * Proven by RUNNING it. Picked up by run-migration-tests.mjs's glob.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let PGlite;
try {
  ({ PGlite } = require('@electric-sql/pglite'));
} catch {
  console.error('\n@electric-sql/pglite is not installed — this suite cannot run.\n');
  process.exit(1);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SQL  = fs.readFileSync(path.join(ROOT, 'migrations/97_user_devices_retire.sql'), 'utf8');

let passed = 0, failed = 0;
const ok = (name, fn) => {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n         ${e.message}`); }
};

async function fresh() {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE public.users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text
    );
    CREATE TABLE public.user_devices (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL,
      business_id uuid NOT NULL,
      device_id text,
      branch_id uuid,
      status text NOT NULL DEFAULT 'pending',
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE public.schema_migrations (
      version text PRIMARY KEY, notes text, applied_at timestamptz NOT NULL DEFAULT now()
    );
    INSERT INTO public.user_devices (user_id, business_id, device_id, status)
    VALUES (gen_random_uuid(), gen_random_uuid(), 'dev-1', 'approved');
  `);
  return db;
}

const cols = async (db) => (await db.query(
  `SELECT column_name FROM information_schema.columns
   WHERE table_name='user_devices' ORDER BY column_name`)).rows.map(r => r.column_name);

console.log('\nmigration 97 — user_devices.retired_at / retired_by\n');

console.log('1. adds both columns, additive + records itself');
{
  const db = await fresh();
  const before = await cols(db);
  ok('retired_at absent before', () => assert.ok(!before.includes('retired_at')));
  const rowsBefore = (await db.query(`SELECT count(*)::int AS n FROM user_devices`)).rows[0].n;

  await db.exec(SQL);

  const after = await cols(db);
  ok('retired_at present after', () => assert.ok(after.includes('retired_at')));
  ok('retired_by present after', () => assert.ok(after.includes('retired_by')));

  const rowsAfter = (await db.query(`SELECT count(*)::int AS n FROM user_devices`)).rows[0].n;
  ok('row count unchanged (additive, no drop)', () => assert.strictEqual(rowsBefore, rowsAfter));

  const nulls = (await db.query(`SELECT count(*)::int AS n FROM user_devices WHERE retired_at IS NULL`)).rows[0].n;
  ok('existing row is live (retired_at NULL)', () => assert.strictEqual(nulls, rowsAfter));

  const existing = (await db.query(`SELECT count(*)::int AS n FROM user_devices WHERE device_id='dev-1' AND status='approved'`)).rows[0].n;
  ok('existing row data intact', () => assert.strictEqual(existing, 1));

  const idx = (await db.query(`SELECT count(*)::int AS n FROM pg_indexes WHERE indexname='user_devices_business_live_idx'`)).rows[0].n;
  ok('partial live index created', () => assert.strictEqual(idx, 1));

  const rec = (await db.query(`SELECT count(*)::int AS n FROM schema_migrations WHERE version='97_user_devices_retire'`)).rows[0].n;
  ok('records itself in schema_migrations', () => assert.strictEqual(rec, 1));
  await db.close();
}

console.log('\n2. the retire round-trips (retire then un-retire)');
{
  const db = await fresh();
  await db.exec(SQL);
  const u = (await db.query(`INSERT INTO users (name) VALUES ('Owner') RETURNING id`)).rows[0].id;
  await db.query(`UPDATE user_devices SET retired_at = now(), retired_by = $1 WHERE device_id='dev-1'`, [u]);
  let live = (await db.query(`SELECT count(*)::int AS n FROM user_devices WHERE retired_at IS NULL`)).rows[0].n;
  ok('retired row leaves the live set', () => assert.strictEqual(live, 0));
  await db.query(`UPDATE user_devices SET retired_at = NULL, retired_by = NULL WHERE device_id='dev-1'`);
  live = (await db.query(`SELECT count(*)::int AS n FROM user_devices WHERE retired_at IS NULL`)).rows[0].n;
  ok('un-retire returns it to live (reversible)', () => assert.strictEqual(live, 1));
  await db.close();
}

console.log('\n3. idempotent — a second run is a no-op');
{
  const db = await fresh();
  await db.exec(SQL);
  await db.exec(SQL);   // must not throw
  const after = await cols(db);
  ok('still exactly one retired_at column', () => assert.strictEqual(after.filter(c => c === 'retired_at').length, 1));
  const rec = (await db.query(`SELECT count(*)::int AS n FROM schema_migrations WHERE version='97_user_devices_retire'`)).rows[0].n;
  ok('schema_migrations still has exactly one row for 97', () => assert.strictEqual(rec, 1));
  await db.close();
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
