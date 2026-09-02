/**
 * test-migration-92.mjs — user_devices.device_secret_hash, against real Postgres (PGlite).
 *
 * WHAT THIS PINS (register A164 / SCOPE-node-authority Phase 1)
 * ------------------------------------------------------------
 * Migration 92 adds nullable device_secret_hash + device_secret_set_at to
 * user_devices so a till can recover its own session (POST /api/auth/device-token)
 * without an owner re-login. It must:
 *   - add both columns;
 *   - be ADDITIVE — leave existing rows intact, both columns NULL;
 *   - be idempotent (ADD COLUMN IF NOT EXISTS) — a second run is a no-op;
 *   - record itself in schema_migrations.
 *
 * Proven by RUNNING it (A30/A62). Picked up by run-migration-tests.mjs's glob.
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
const SQL  = fs.readFileSync(path.join(ROOT, 'migrations/92_device_grant_secret.sql'), 'utf8');

let passed = 0, failed = 0;
const ok = (name, fn) => {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n         ${e.message}`); }
};

async function fresh() {
  const db = new PGlite();
  await db.exec(`
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

console.log('\nmigration 92 — user_devices.device_secret_hash\n');

console.log('1. adds both columns, additive + records itself');
{
  const db = await fresh();
  const before = await cols(db);
  ok('device_secret_hash absent before', () => assert.ok(!before.includes('device_secret_hash')));
  const rowsBefore = (await db.query(`SELECT count(*)::int AS n FROM user_devices`)).rows[0].n;

  await db.exec(SQL);

  const after = await cols(db);
  ok('device_secret_hash present after', () => assert.ok(after.includes('device_secret_hash')));
  ok('device_secret_set_at present after', () => assert.ok(after.includes('device_secret_set_at')));

  const rowsAfter = (await db.query(`SELECT count(*)::int AS n FROM user_devices`)).rows[0].n;
  ok('row count unchanged (additive, no drop)', () => assert.strictEqual(rowsBefore, rowsAfter));

  const nulls = (await db.query(`SELECT count(*)::int AS n FROM user_devices WHERE device_secret_hash IS NULL`)).rows[0].n;
  ok('existing row has device_secret_hash NULL', () => assert.strictEqual(nulls, rowsAfter));

  const existing = (await db.query(`SELECT count(*)::int AS n FROM user_devices WHERE device_id='dev-1' AND status='approved'`)).rows[0].n;
  ok('existing row data intact', () => assert.strictEqual(existing, 1));

  const rec = (await db.query(`SELECT count(*)::int AS n FROM schema_migrations WHERE version='92_device_grant_secret'`)).rows[0].n;
  ok('records itself in schema_migrations', () => assert.strictEqual(rec, 1));
  await db.close();
}

console.log('\n2. idempotent — a second run is a no-op');
{
  const db = await fresh();
  await db.exec(SQL);
  await db.exec(SQL);   // must not throw
  const after = await cols(db);
  ok('still exactly one device_secret_hash column', () => assert.strictEqual(after.filter(c => c === 'device_secret_hash').length, 1));
  const rec = (await db.query(`SELECT count(*)::int AS n FROM schema_migrations WHERE version='92_device_grant_secret'`)).rows[0].n;
  ok('schema_migrations still has exactly one row for 92', () => assert.strictEqual(rec, 1));
  await db.close();
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
