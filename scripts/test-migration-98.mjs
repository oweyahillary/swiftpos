/**
 * test-migration-98.mjs — drop ingredients.current_stock (A12 Phase 6), against real Postgres (PGlite).
 *
 * Pins: the dead column is removed; existing ingredient rows survive with their
 * OTHER columns intact; the per-branch live stock table is untouched; idempotent;
 * self-registers. Proven by RUNNING it. Picked up by run-migration-tests.mjs.
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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SQL  = fs.readFileSync(path.join(ROOT, 'migrations/98_drop_ingredients_current_stock.sql'), 'utf8');

let passed = 0, failed = 0;
const ok = (n, fn) => { try { fn(); passed++; console.log(`  ok   ${n}`); } catch (e) { failed++; console.log(`  FAIL ${n}\n         ${e.message}`); } };

async function fresh() {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE public.ingredients (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      business_id uuid NOT NULL,
      name text NOT NULL,
      unit text,
      unit_cost numeric,
      current_stock numeric DEFAULT 0   -- the dead column this migration drops
    );
    CREATE TABLE public.ingredient_stock_levels (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      ingredient_id uuid NOT NULL,
      branch_id uuid NOT NULL,
      current_stock numeric DEFAULT 0   -- the LIVE column, must survive
    );
    CREATE TABLE public.schema_migrations (version text PRIMARY KEY, notes text, applied_at timestamptz DEFAULT now());
    INSERT INTO public.ingredients (business_id, name, unit, unit_cost, current_stock)
      VALUES (gen_random_uuid(), 'Flour', 'kg', 50, 999);
    INSERT INTO public.ingredient_stock_levels (ingredient_id, branch_id, current_stock)
      VALUES ((SELECT id FROM public.ingredients LIMIT 1), gen_random_uuid(), 42);
  `);
  return db;
}

const cols = async (db, t) => (await db.query(
  `SELECT column_name FROM information_schema.columns WHERE table_name=$1`, [t])).rows.map(r => r.column_name);

console.log('\nmigration 98 — drop ingredients.current_stock\n');

console.log('1. drops the dead column, keeps everything else');
{
  const db = await fresh();
  const before = await cols(db, 'ingredients');
  ok('ingredients.current_stock present before', () => assert.ok(before.includes('current_stock')));

  await db.exec(SQL);

  const after = await cols(db, 'ingredients');
  ok('ingredients.current_stock GONE after', () => assert.ok(!after.includes('current_stock')));
  ok('ingredients other columns intact', () => ['id','business_id','name','unit','unit_cost'].forEach(c => assert.ok(after.includes(c), c)));

  const row = (await db.query(`SELECT name, unit, unit_cost FROM ingredients WHERE name='Flour'`)).rows[0];
  ok('existing ingredient row survives', () => assert.strictEqual(row.name, 'Flour') || assert.strictEqual(Number(row.unit_cost), 50));

  const live = await cols(db, 'ingredient_stock_levels');
  ok('LIVE ingredient_stock_levels.current_stock untouched', () => assert.ok(live.includes('current_stock')));
  const lv = (await db.query(`SELECT current_stock FROM ingredient_stock_levels LIMIT 1`)).rows[0];
  ok('live per-branch stock value intact (42)', () => assert.strictEqual(Number(lv.current_stock), 42));

  const rec = (await db.query(`SELECT count(*)::int n FROM schema_migrations WHERE version='98_drop_ingredients_current_stock'`)).rows[0].n;
  ok('records itself in schema_migrations', () => assert.strictEqual(rec, 1));
  await db.close();
}

console.log('\n2. idempotent — a second run is a no-op');
{
  const db = await fresh();
  await db.exec(SQL);
  await db.exec(SQL);   // must not throw (DROP COLUMN IF EXISTS)
  const after = await cols(db, 'ingredients');
  ok('still no current_stock, no error', () => assert.ok(!after.includes('current_stock')));
  await db.close();
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
