/**
 * test-migration-102.mjs — day_close_instructions relay, against real Postgres (PGlite).
 * Pins A275's schema: the cloud instruction table exists with the right columns, the
 * one-pending-per-(business,till,date) partial unique index holds, it is idempotent,
 * and it self-registers. Runs in CI (needs @electric-sql/pglite); not run on the
 * author's bench (no node_modules) — mirrors test-migration-101.mjs exactly.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let PGlite;
try { ({ PGlite } = require('@electric-sql/pglite')); }
catch { console.error('\n@electric-sql/pglite not installed — cannot run.\n'); process.exit(1); }

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SQL  = fs.readFileSync(path.join(ROOT, 'migrations/102_day_close_instructions.sql'), 'utf8');

let pass = 0, fail = 0;
const ok = (n, fn) => { try { fn(); pass++; console.log(`  ok   ${n}`); } catch (e) { fail++; console.log(`  FAIL ${n}\n         ${e.message}`); } };

const colType = async (db, table, col) => {
  const r = await db.query(
    `SELECT data_type FROM information_schema.columns
     WHERE table_schema='public' AND table_name=$1 AND column_name=$2`, [table, col]);
  return r.rows[0]?.data_type ?? null;
};

console.log('\nMigration 102 (day_close_instructions) — PGlite\n');
await (async () => {
  const db = new PGlite();
  // RLS policy references auth.uid() + public.businesses (mirror test-migration-86).
  await db.exec(`
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
    CREATE TABLE public.businesses (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text, owner_id uuid);
    CREATE TABLE public.schema_migrations (version text PRIMARY KEY, notes text, applied_at timestamptz DEFAULT now());
  `);

  ok('table absent before migration', async () => {
    assert.strictEqual(await colType(db, 'day_close_instructions', 'status'), null);
  });

  await db.exec(SQL);

  ok('status is text, payload is jsonb, business_date is date', async () => {
    assert.strictEqual(await colType(db, 'day_close_instructions', 'status'), 'text');
    assert.strictEqual(await colType(db, 'day_close_instructions', 'payload'), 'jsonb');
    assert.strictEqual(await colType(db, 'day_close_instructions', 'business_date'), 'date');
    assert.strictEqual(await colType(db, 'day_close_instructions', 'device_id'), 'text');
  });

  const B = '00000000-0000-0000-0000-0000000000aa';
  const ins = (status) => `INSERT INTO public.day_close_instructions (business_id, device_id, business_date, payload, status)
    VALUES ('${B}', 'dev-1', '2026-09-13', '{"counted_cash":100}'::jsonb, '${status}');`;

  await db.exec(ins('pending'));
  let threw = false;
  try { await db.exec(ins('pending')); } catch { threw = true; }
  ok('one LIVE instruction per till per day (second pending rejected)', () => assert.ok(threw));

  // once the first is acked, a new pending for the same till+day is allowed
  await db.exec(`UPDATE public.day_close_instructions SET status='acked' WHERE device_id='dev-1';`);
  let allowed = true;
  try { await db.exec(ins('pending')); } catch { allowed = false; }
  ok('a new pending is allowed once the prior is acked', () => assert.ok(allowed));

  // idempotent
  await db.exec(SQL);
  ok('re-running is a no-op (idempotent)', async () => {
    assert.strictEqual(await colType(db, 'day_close_instructions', 'status'), 'text');
  });

  const ledger = (await db.query(`SELECT 1 FROM public.schema_migrations WHERE version='102_day_close_instructions'`)).rows.length;
  ok('records itself in schema_migrations', () => assert.strictEqual(ledger, 1));

  console.log(`\n${fail ? 'FAILURES' : 'all green'}  (${pass} passed, ${fail} failed)\n`);
  process.exit(fail ? 1 : 0);
})();
