/**
 * test-migration-85.mjs — the manual-M-Pesa backfill, against real Postgres (PGlite).
 *
 * WHAT THIS PINS (register A93 / #3)
 * ----------------------------------
 * Migration 85 flips stuck manual M-Pesa legs (pending, no STK checkout id, old)
 * to 'completed', and must NOT touch STK legs (checkout id set), recent pending
 * legs (< 1h), or non-M-Pesa / already-completed legs. Idempotent.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let PGlite;
try { ({ PGlite } = require('@electric-sql/pglite')); }
catch { console.error('\n@electric-sql/pglite not installed.\n'); process.exit(1); }

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SQL  = fs.readFileSync(path.join(ROOT, 'migrations/85_complete_manual_mpesa.sql'), 'utf8');

let passed = 0, failed = 0;
const ok = (name, fn) => {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n         ${e.message}`); }
};

async function fresh() {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE public.payments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      method text NOT NULL,
      status text NOT NULL,
      mpesa_checkout_id text,
      created_at timestamptz NOT NULL
    );
    CREATE TABLE public.schema_migrations (
      version text PRIMARY KEY, notes text, applied_at timestamptz NOT NULL DEFAULT now()
    );
    INSERT INTO public.payments (method, status, mpesa_checkout_id, created_at) VALUES
      ('mpesa', 'pending',   NULL,      now() - interval '2 days'),
      ('mpesa', 'pending',   'ws_CO_1', now() - interval '2 days'),
      ('mpesa', 'pending',   NULL,      now() - interval '5 minutes'),
      ('mpesa', 'completed', NULL,      now() - interval '2 days'),
      ('cash',  'pending',   NULL,      now() - interval '2 days');
  `);
  return db;
}

const statusOf = async (db, where) =>
  (await db.query(`SELECT status FROM public.payments WHERE ${where}`)).rows[0]?.status;

console.log('\nmigration 85 — complete manual M-Pesa\n');

console.log('1. completes only the stuck manual leg');
{
  const db = await fresh();
  await db.exec(SQL);
  const a = await statusOf(db, `method='mpesa' AND mpesa_checkout_id IS NULL AND created_at < now() - interval '1 day'`);
  ok('A: old manual pending → completed', () => assert.strictEqual(a, 'completed'));
  const b = await statusOf(db, `mpesa_checkout_id='ws_CO_1'`);
  ok('B: STK pending (has checkout id) → still pending', () => assert.strictEqual(b, 'pending'));
  const c = await statusOf(db, `method='mpesa' AND mpesa_checkout_id IS NULL AND created_at > now() - interval '1 hour'`);
  ok('C: recent manual pending → still pending (in-flight guard)', () => assert.strictEqual(c, 'pending'));
  const e = await statusOf(db, `method='cash'`);
  ok('E: cash pending → untouched', () => assert.strictEqual(e, 'pending'));
  const rec = (await db.query(`SELECT count(*)::int AS n FROM schema_migrations WHERE version='85_complete_manual_mpesa'`)).rows[0].n;
  ok('records itself', () => assert.strictEqual(rec, 1));
  await db.close();
}

console.log('\n2. idempotent — second run changes nothing more');
{
  const db = await fresh();
  await db.exec(SQL);
  const first = (await db.query(`SELECT count(*)::int AS n FROM payments WHERE status='completed'`)).rows[0].n;
  await db.exec(SQL);
  const second = (await db.query(`SELECT count(*)::int AS n FROM payments WHERE status='completed'`)).rows[0].n;
  ok('completed count stable across re-run', () => assert.strictEqual(first, second));
  await db.close();
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
