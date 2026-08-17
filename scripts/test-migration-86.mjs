/**
 * test-migration-86.mjs — payment_methods, against real Postgres (PGlite).
 *
 * WHAT THIS PINS (register A95 / #4)
 * ----------------------------------
 * Migration 86 creates payment_methods (custom methods per business). It must:
 *   - create the table with the expected columns and defaults;
 *   - enforce UNIQUE(business_id, code) — two "coop_card" in one business is a
 *     conflict, but the same code in a different business is fine;
 *   - be additive + idempotent (IF NOT EXISTS).
 * Proven by RUNNING it (A30/A62). Picked up by run-migration-tests.mjs.
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
const SQL  = fs.readFileSync(path.join(ROOT, 'migrations/86_payment_methods.sql'), 'utf8');

let passed = 0, failed = 0;
const ok = (name, fn) => {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n         ${e.message}`); }
};

async function fresh() {
  const db = new PGlite();
  // Minimal businesses table so the FK resolves.
  await db.exec(`
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
    CREATE TABLE public.businesses (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text, owner_id uuid);
    CREATE TABLE public.schema_migrations (
      version text PRIMARY KEY, notes text, applied_at timestamptz NOT NULL DEFAULT now()
    );
    INSERT INTO public.businesses (id, name) VALUES
      ('11111111-1111-1111-1111-111111111111', 'A'),
      ('22222222-2222-2222-2222-222222222222', 'B');
  `);
  return db;
}

const B1 = '11111111-1111-1111-1111-111111111111';
const B2 = '22222222-2222-2222-2222-222222222222';

console.log('\nmigration 86 — payment_methods\n');

console.log('1. table + columns + defaults');
{
  const db = await fresh();
  await db.exec(SQL);
  const cols = (await db.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name='payment_methods' ORDER BY column_name`
  )).rows.map(r => r.column_name);
  ok('has id, business_id, name, code, is_active, sort_order, created_at',
     () => ['id','business_id','name','code','is_active','sort_order','created_at'].forEach(c => assert.ok(cols.includes(c), `missing ${c}`)));

  await db.exec(`INSERT INTO public.payment_methods (business_id, name, code) VALUES ('${B1}', 'Coop Card', 'coop_card')`);
  const row = (await db.query(`SELECT is_active, sort_order FROM public.payment_methods WHERE code='coop_card'`)).rows[0];
  ok('is_active defaults true', () => assert.strictEqual(row.is_active, true));
  ok('sort_order defaults 0', () => assert.strictEqual(row.sort_order, 0));

  const rec = (await db.query(`SELECT count(*)::int AS n FROM schema_migrations WHERE version='86_payment_methods'`)).rows[0].n;
  ok('records itself', () => assert.strictEqual(rec, 1));
  await db.close();
}

console.log('\n2. UNIQUE(business_id, code)');
{
  const db = await fresh();
  await db.exec(SQL);
  await db.exec(`INSERT INTO public.payment_methods (business_id, name, code) VALUES ('${B1}', 'Coop Card', 'coop_card')`);

  let threw = false;
  try { await db.exec(`INSERT INTO public.payment_methods (business_id, name, code) VALUES ('${B1}', 'Coop', 'coop_card')`); }
  catch { threw = true; }
  ok('duplicate code in same business → rejected', () => assert.ok(threw));

  // same code, different business → allowed
  await db.exec(`INSERT INTO public.payment_methods (business_id, name, code) VALUES ('${B2}', 'Coop Card', 'coop_card')`);
  const n = (await db.query(`SELECT count(*)::int AS n FROM public.payment_methods WHERE code='coop_card'`)).rows[0].n;
  ok('same code in a different business → allowed', () => assert.strictEqual(n, 2));
  await db.close();
}

console.log('\n3. idempotent');
{
  const db = await fresh();
  await db.exec(SQL);
  await db.exec(SQL); // must not throw
  ok('second run is a no-op', () => assert.ok(true));
  await db.close();
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
