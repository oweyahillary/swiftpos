/**
 * test-migration-90.mjs — re-admit 'delivery' to orders.order_type, against real
 * Postgres (PGlite).
 *
 * WHAT THIS PINS (register A129)
 * ------------------------------
 * Before migration 90 the cloud `orders_order_type_check` (narrowed by migration
 * 58) admits only dine_in|takeaway|retail|parking_session|fuel_sale, so a delivery
 * order — a live POS/Zod value — fails INSERT with 23514 and never syncs. After
 * migration 90, delivery inserts cleanly, while genuinely invalid values ('',
 * 'aggregator', 'nonsense') are still rejected. Idempotent.
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
const SQL  = fs.readFileSync(path.join(ROOT, 'migrations/90_order_type_delivery_check.sql'), 'utf8');

let passed = 0, failed = 0;
const ok = (name, fn) => {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n         ${e.message}`); }
};

// The post-58 orders table: order_type CHECK without 'delivery'. Minimal columns.
async function fresh() {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE public.orders (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      order_type character varying(20) NOT NULL DEFAULT 'retail',
      CONSTRAINT orders_order_type_check CHECK (order_type = ANY (ARRAY[
        'dine_in'::character varying, 'takeaway'::character varying,
        'retail'::character varying, 'parking_session'::character varying,
        'fuel_sale'::character varying]))
    );
    CREATE TABLE public.schema_migrations (
      version text PRIMARY KEY, notes text, applied_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  return db;
}

const insert = async (db, t) => db.query(`INSERT INTO public.orders (order_type) VALUES ($1)`, [t]);
const rejects = async (db, t) => {
  try { await insert(db, t); return null; }
  catch (e) { return e.code || e.message; }
};

console.log('\nmigration 90 — re-admit delivery to orders.order_type\n');

console.log('0. baseline (pre-migration) proves the bug');
{
  const db = await fresh();
  const code = await rejects(db, 'delivery');
  ok('A: delivery REJECTED before migration (23514)', () => assert.strictEqual(code, '23514'));
  await insert(db, 'dine_in');
  ok('B: dine_in accepted before migration', () => assert.ok(true));
  await db.close();
}

console.log('\n1. after migration, delivery is admitted');
{
  const db = await fresh();
  await db.exec(SQL);
  await insert(db, 'delivery');
  ok('A: delivery accepted after migration', () => assert.ok(true));
  for (const t of ['dine_in', 'takeaway', 'retail', 'parking_session', 'fuel_sale']) {
    await insert(db, t);
  }
  ok('B: all five prior types still accepted', () => assert.ok(true));
  await db.close();
}

console.log('\n2. genuinely invalid values are still rejected (not a blanket loosen)');
{
  const db = await fresh();
  await db.exec(SQL);
  const empty = await rejects(db, '');
  const aggr  = await rejects(db, 'aggregator');
  const junk  = await rejects(db, 'nonsense');
  ok('A: empty string rejected', () => assert.strictEqual(!!empty, true));
  ok('B: aggregator rejected (not written by any path — A130)', () => assert.strictEqual(!!aggr, true));
  ok('C: nonsense rejected', () => assert.strictEqual(!!junk, true));
  await db.close();
}

console.log('\n3. idempotent — second run changes nothing');
{
  const db = await fresh();
  await db.exec(SQL);
  await db.exec(SQL);
  await insert(db, 'delivery');
  ok('delivery still accepted after re-run', () => assert.ok(true));
  const still = await rejects(db, 'nonsense');
  ok('nonsense still rejected after re-run', () => assert.ok(still));
  await db.close();
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
