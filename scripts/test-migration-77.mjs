/**
 * test-migration-77.mjs — atomic customer spend, proven by racing it.
 *
 * WHAT THIS PINS (register A55)
 * -----------------------------
 * orders.ts wrote customers.total_spent as SELECT-then-write-back in three
 * places. Two tills serving one customer at the same moment both read the old
 * value and both wrote their own total, so one sale silently vanished from
 * lifetime spend and from every RFM / CRM segment built on it.
 *
 * Section 2 does not assert that an UPDATE looks atomic — it RUNS the old shape
 * and the new shape under the same interleaving and shows the old one losing
 * money. An assertion that only reads the SQL would pass against the racy
 * version too, which is the whole failure mode this repository keeps finding.
 *
 * Run:  node scripts/test-migration-77.mjs
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
  console.error('\n@electric-sql/pglite is not installed — this suite cannot run.\n'
    + '  npm i --no-save @electric-sql/pglite\n');
  process.exit(1);
}

// fileURLToPath, not new URL(...).pathname — the latter yields /C:/... on
// Windows and path.resolve then prepends the drive again (register A33).
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SQL  = fs.readFileSync(path.join(ROOT, 'migrations/77_increment_customer_spend.sql'), 'utf8');

let passed = 0, failed = 0;
const ok = (name, fn) => {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n         ${e.message}`); }
};

async function fresh() {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE schema_migrations (version text PRIMARY KEY, notes text,
      applied_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE customers (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      total_spent numeric(12,2) NOT NULL DEFAULT 0,
      visit_count integer NOT NULL DEFAULT 0,
      loyalty_points integer NOT NULL DEFAULT 0,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.exec(SQL);
  const { rows } = await db.query(
    `INSERT INTO customers (name) VALUES ('Test') RETURNING id`);
  return { db, id: rows[0].id };
}

const spent = async (db, id) =>
  Number((await db.query(`SELECT total_spent FROM customers WHERE id=$1`, [id])).rows[0].total_spent);

console.log('\nmigration 77 — atomic customer spend\n');

// ── 1. It adds, subtracts and floors ───────────────────────────────────────
console.log('1. arithmetic');
{
  const { db, id } = await fresh();
  await db.query(`SELECT increment_customer_spend($1, $2)`, [id, 1500.00]);
  const one = await spent(db, id);
  ok('adds', () => assert.strictEqual(one, 1500));

  await db.query(`SELECT increment_customer_spend($1, $2)`, [id, 890.50]);
  const two = await spent(db, id);
  ok('adds again without string concatenation (1500 + 890.50 = 2390.50)',
     () => assert.strictEqual(two, 2390.5));

  await db.query(`SELECT increment_customer_spend($1, $2)`, [id, -390.5]);
  const three = await spent(db, id);
  ok('subtracts for a void', () => assert.strictEqual(three, 2000));

  await db.query(`SELECT increment_customer_spend($1, $2)`, [id, -99999]);
  const four = await spent(db, id);
  ok('floors at 0 rather than going negative', () => assert.strictEqual(four, 0));

  const vc = await db.query(`SELECT visit_count FROM customers WHERE id=$1`, [id]);
  ok('never touches visit_count (migration 67 precedent)',
     () => assert.strictEqual(vc.rows[0].visit_count, 0));
  await db.close();
}

// ── 2. THE RACE — run it, do not assert about it ───────────────────────────
console.log('\n2. the race the old code lost');
{
  // The OLD shape, reproduced exactly: read, compute in JS, write back. Two
  // "tills" interleave — both read before either writes.
  const { db, id } = await fresh();
  const read = async () =>
    Number((await db.query(`SELECT total_spent FROM customers WHERE id=$1`, [id])).rows[0].total_spent);

  const tillA = await read();          // both read 0 …
  const tillB = await read();
  await db.query(`UPDATE customers SET total_spent=$1 WHERE id=$2`, [tillA + 100, id]);
  await db.query(`UPDATE customers SET total_spent=$1 WHERE id=$2`, [tillB + 250, id]);
  const lost = await spent(db, id);

  ok('OLD read-modify-write loses a sale: 100 + 250 banked, 250 recorded',
     () => assert.strictEqual(lost, 250));
  ok('...and the money lost is real', () => assert.notStrictEqual(lost, 350));
  await db.close();
}
{
  // The NEW shape under the SAME interleaving: both deltas issued without
  // either reading first. Nothing to lose.
  const { db, id } = await fresh();
  await Promise.all([
    db.query(`SELECT increment_customer_spend($1, $2)`, [id, 100]),
    db.query(`SELECT increment_customer_spend($1, $2)`, [id, 250]),
  ]);
  const kept = await spent(db, id);
  ok('NEW atomic form keeps both: 350', () => assert.strictEqual(kept, 350));
}
{
  // Many concurrent increments — the shop-floor case, twenty tills at once.
  const { db, id } = await fresh();
  await Promise.all(Array.from({ length: 20 },
    () => db.query(`SELECT increment_customer_spend($1, $2)`, [id, 50])));
  const all = await spent(db, id);
  ok('20 concurrent increments of 50 all land (1000)',
     () => assert.strictEqual(all, 1000));
  await db.close();
}

// ── 3. adjust_customer_visits ──────────────────────────────────────────────
console.log('\n3. adjust_customer_visits — the void path\'s third column');
{
  const { db, id } = await fresh();
  await db.query(`UPDATE customers SET visit_count=3 WHERE id=$1`, [id]);
  await db.query(`SELECT adjust_customer_visits($1, $2)`, [id, -1]);
  const v = await db.query(`SELECT visit_count, total_spent FROM customers WHERE id=$1`, [id]);
  ok('decrements a visit', () => assert.strictEqual(v.rows[0].visit_count, 2));
  ok('and does NOT touch total_spent',
     () => assert.strictEqual(Number(v.rows[0].total_spent), 0));

  await db.query(`SELECT adjust_customer_visits($1, $2)`, [id, -99]);
  const f = await db.query(`SELECT visit_count FROM customers WHERE id=$1`, [id]);
  ok('floors at 0', () => assert.strictEqual(f.rows[0].visit_count, 0));
  await db.close();
}

// ── 4. Idempotent ──────────────────────────────────────────────────────────
console.log('\n4. re-runnable');
{
  const { db } = await fresh();
  await db.exec(SQL);   // CREATE OR REPLACE + ON CONFLICT
  const n = await db.query(
    `SELECT count(*)::int AS n FROM schema_migrations WHERE version='77_increment_customer_spend'`);
  ok('one ledger row after two runs', () => assert.strictEqual(n.rows[0].n, 1));
  await db.close();
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
