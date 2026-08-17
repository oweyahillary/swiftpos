/**
 * test-migration-80.mjs — dropping the dead public.sync_queue decoy (register D15).
 *
 * Proven by RUNNING it: create the table as 00_baseline defines it (PK, checks,
 * indexes), run the migration, and assert it is gone. Then run it a SECOND time
 * against a DB that no longer has it, to prove IF EXISTS makes it idempotent —
 * reading `IF EXISTS` and believing it is how a re-run aborts a whole batch.
 *
 * Run:  node scripts/test-migration-80.mjs
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
const SQL  = fs.readFileSync(path.join(ROOT, 'migrations/80_drop_dead_sync_queue.sql'), 'utf8');

let passed = 0, failed = 0;
const ok = (name, fn) => {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n         ${e.message}`); }
};

// The table exactly as 00_baseline creates it (PK, checks, indexes), plus the
// ledger the migration records itself in.
async function fresh({ withTable = true } = {}) {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE schema_migrations (version text PRIMARY KEY, notes text, applied_at timestamptz DEFAULT now());
  `);
  if (withTable) {
    await db.exec(`
      CREATE TABLE public.sync_queue (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        branch_id uuid NOT NULL,
        table_name varchar(100) NOT NULL,
        record_id uuid NOT NULL,
        operation varchar(10) NOT NULL,
        payload jsonb NOT NULL,
        status varchar(20) NOT NULL DEFAULT 'pending',
        retry_count integer NOT NULL DEFAULT 0,
        last_attempted_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT sync_queue_operation_check CHECK (operation IN ('insert','update','delete')),
        CONSTRAINT sync_queue_status_check CHECK (status IN ('pending','synced','failed'))
      );
      CREATE INDEX idx_sync_queue_branch ON public.sync_queue (branch_id);
      CREATE INDEX idx_sync_queue_status ON public.sync_queue (status);
    `);
  }
  return db;
}

const exists = async (db) => (await db.query(
  `SELECT to_regclass('public.sync_queue') IS NOT NULL AS present`)).rows[0].present;

console.log('\nmigration 80 — drop dead public.sync_queue\n');

// 1. Drops the table when present.
console.log('1. drops the decoy table');
{
  const db = await fresh({ withTable: true });
  const before = await exists(db);
  ok('sync_queue exists before the migration', () => assert.strictEqual(before, true));
  await db.exec(SQL);
  const after = await exists(db);
  ok('sync_queue is gone after the migration', () => assert.strictEqual(after, false));
  const rec = await db.query(`SELECT count(*)::int AS n FROM schema_migrations WHERE version='80_drop_dead_sync_queue'`);
  ok('records itself in schema_migrations', () => assert.strictEqual(rec.rows[0].n, 1));
  await db.close();
}

// 2. Idempotent — runs cleanly when the table is already absent.
console.log('\n2. idempotent — no error when already dropped');
{
  const db = await fresh({ withTable: false });
  let threw = false;
  try { await db.exec(SQL); } catch { threw = true; }
  ok('second-run shape does not throw (IF EXISTS)', () => assert.strictEqual(threw, false));
  const after = await exists(db);
  ok('sync_queue absent after a no-op run', () => assert.strictEqual(after, false));
  await db.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
