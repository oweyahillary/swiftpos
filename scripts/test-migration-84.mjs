/**
 * test-migration-84.mjs — refresh_tokens.replaced_by, against real Postgres (PGlite).
 *
 * WHAT THIS PINS (register A88 / D13)
 * -----------------------------------
 * Migration 84 adds a nullable `replaced_by uuid` to refresh_tokens so /refresh
 * can link a consumed token to its replacement. It must:
 *   - add the column;
 *   - be ADDITIVE — leave existing rows' data intact, replaced_by NULL;
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
const SQL  = fs.readFileSync(path.join(ROOT, 'migrations/84_refresh_token_replaced_by.sql'), 'utf8');

let passed = 0, failed = 0;
const ok = (name, fn) => {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n         ${e.message}`); }
};

async function fresh() {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE public.refresh_tokens (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      jti text NOT NULL,
      user_id uuid NOT NULL,
      business_id uuid NOT NULL,
      session_id text NOT NULL,
      revoked_at timestamptz,
      expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE public.schema_migrations (
      version text PRIMARY KEY, notes text, applied_at timestamptz NOT NULL DEFAULT now()
    );
    INSERT INTO public.refresh_tokens (jti, user_id, business_id, session_id, expires_at)
    VALUES ('h1', gen_random_uuid(), gen_random_uuid(), 's1', now() + interval '30 days');
  `);
  return db;
}

const cols = async (db) => (await db.query(
  `SELECT column_name FROM information_schema.columns
   WHERE table_name='refresh_tokens' ORDER BY column_name`)).rows.map(r => r.column_name);

console.log('\nmigration 84 — refresh_tokens.replaced_by\n');

console.log('1. adds the column, additive + records itself');
{
  const db = await fresh();
  const before = await cols(db);
  ok('replaced_by absent before migration', () => assert.ok(!before.includes('replaced_by')));
  const rowsBefore = (await db.query(`SELECT count(*)::int AS n FROM refresh_tokens`)).rows[0].n;

  await db.exec(SQL);

  const after = await cols(db);
  ok('replaced_by present after migration', () => assert.ok(after.includes('replaced_by')));

  const rowsAfter = (await db.query(`SELECT count(*)::int AS n FROM refresh_tokens`)).rows[0].n;
  ok('row count unchanged (additive, no backfill drop)', () => assert.strictEqual(rowsBefore, rowsAfter));

  const nulls = (await db.query(`SELECT count(*)::int AS n FROM refresh_tokens WHERE replaced_by IS NULL`)).rows[0].n;
  ok('existing row has replaced_by NULL', () => assert.strictEqual(nulls, rowsAfter));

  const rec = (await db.query(`SELECT count(*)::int AS n FROM schema_migrations WHERE version='84_refresh_token_replaced_by'`)).rows[0].n;
  ok('records itself in schema_migrations', () => assert.strictEqual(rec, 1));
  await db.close();
}

console.log('\n2. idempotent — second run is a no-op');
{
  const db = await fresh();
  await db.exec(SQL);
  await db.exec(SQL); // must not throw (ADD COLUMN IF NOT EXISTS + ON CONFLICT)
  const after = await cols(db);
  ok('replaced_by still present, no error on re-run', () => assert.ok(after.includes('replaced_by')));
  await db.close();
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
