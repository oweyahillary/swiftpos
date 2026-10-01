/**
 * test-migration-112.mjs — 0.6.28: public.kitchen_voids (sent items taken back). Against real Postgres (PGlite); the
 * migration file itself is RUN. Every assertion is awaited (the A305 lesson).
 *
 * MUTATIONS TO CONFIRM BITE: drop kitchen_voids_reason_check → "a reason we do not offer is refused" fails; drop
 * kitchen_voids_quantity_pos → "a void of nothing is refused" fails; drop the order_id ON DELETE SET NULL → "deleting
 * the order keeps the void" fails; drop ENABLE ROW LEVEL SECURITY → "row level security is on" fails.
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
const SQL = fs.readFileSync(path.join(ROOT, 'migrations/112_kitchen_voids.sql'), 'utf8');

let pass = 0, fail = 0;
const ok = async (n, fn) => { try { await fn(); pass++; console.log(`  ok   ${n}`); } catch (e) { fail++; console.log(`  FAIL ${n}\n         ${e.message}`); } };
const threw = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

const BIZ = '11111111-1111-4111-8111-111111111111';
const ORD = '44444444-4444-4444-8444-444444444444';

console.log('\nMigration 112 (kitchen voids) — PGlite\n');
await (async () => {
  const db = new PGlite();
  await db.exec(`
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$;
    CREATE TABLE public.schema_migrations (version text PRIMARY KEY, notes text, applied_at timestamptz DEFAULT now());
    CREATE TABLE public.businesses (id uuid PRIMARY KEY, owner_id uuid);
    CREATE TABLE public.orders (id uuid PRIMARY KEY, business_id uuid);
    INSERT INTO public.businesses VALUES ('${BIZ}', NULL);
    INSERT INTO public.orders VALUES ('${ORD}', '${BIZ}');
  `);
  await db.exec(SQL);
  const ins = (extra = '') => db.exec(`INSERT INTO public.kitchen_voids (business_id, order_number, product_name, quantity, unit_price, amount, reason${extra ? ', ' + extra.split('|')[0] : ''})
    VALUES ('${BIZ}', 'T1-100', 'Chicken', 1, 1000, 1000, 'changed_mind'${extra ? ', ' + extra.split('|')[1] : ''})`);

  await ok('a kitchen void is stored with its defaults (not cooked, now)', async () => {
    await ins();
    const r = await db.query(`SELECT cooked, created_at IS NOT NULL AS t FROM public.kitchen_voids`);
    assert.deepStrictEqual([r.rows[0].cooked, r.rows[0].t], [false, true]);
  });
  await ok('every reason the till and the web offer is admitted', async () => {
    for (const r of ['wrong_item', 'wrong_quantity', 'changed_mind', 'out_of_stock', 'kitchen_mistake']) {
      await db.exec(`INSERT INTO public.kitchen_voids (business_id, order_number, product_name, quantity, reason) VALUES ('${BIZ}', 'x', 'y', 1, '${r}')`);
    }
  });
  await ok('a reason we do not offer is refused', async () => {
    const e = await threw(() => db.exec(`INSERT INTO public.kitchen_voids (business_id, order_number, product_name, quantity, reason) VALUES ('${BIZ}', 'x', 'y', 1, 'because')`));
    assert.ok(e && /kitchen_voids_reason_check/.test(e.message), e?.message);
  });
  await ok('a void of nothing is refused', async () => {
    const e = await threw(() => db.exec(`INSERT INTO public.kitchen_voids (business_id, order_number, product_name, quantity, reason) VALUES ('${BIZ}', 'x', 'y', 0, 'wrong_item')`));
    assert.ok(e && /kitchen_voids_quantity_pos/.test(e.message), e?.message);
  });
  await ok('a negative amount is refused', async () => {
    const e = await threw(() => db.exec(`INSERT INTO public.kitchen_voids (business_id, order_number, product_name, quantity, amount, reason) VALUES ('${BIZ}', 'x', 'y', 1, -5, 'wrong_item')`));
    assert.ok(e && /kitchen_voids_amount_nonneg/.test(e.message), e?.message);
  });
  await ok('deleting the order keeps the void (order_id becomes NULL)', async () => {
    await ins(`order_id|'${ORD}'`);
    await db.exec(`DELETE FROM public.orders WHERE id='${ORD}'`);
    const r = await db.query(`SELECT COUNT(*)::int AS n FROM public.kitchen_voids WHERE order_number='T1-100' AND order_id IS NULL`);
    assert.strictEqual(r.rows[0].n, 2);
  });
  await ok('row level security is on, with the owner policy', async () => {
    const r = await db.query(`SELECT relrowsecurity FROM pg_class WHERE relname='kitchen_voids'`);
    assert.strictEqual(r.rows[0].relrowsecurity, true);
    const p = await db.query(`SELECT COUNT(*)::int AS n FROM pg_policies WHERE tablename='kitchen_voids' AND policyname='owner_all'`);
    assert.strictEqual(p.rows[0].n, 1);
  });
  await ok('idempotent: running 112 again changes nothing, one migration row', async () => {
    await db.exec(SQL);
    const r = await db.query(`SELECT count(*)::int AS n FROM public.schema_migrations WHERE version='112_kitchen_voids'`);
    assert.strictEqual(r.rows[0].n, 1);
    const k = await db.query(`SELECT count(*)::int AS n FROM public.kitchen_voids`);
    assert.strictEqual(k.rows[0].n, 7);
  });
})();

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
