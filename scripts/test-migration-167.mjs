/**
 * test-migration-167.mjs — A577: items sold by weight keep their weight to the gram. Run for real against the WHOLE schema
 * (every migration before 167 replayed into PGlite).
 *
 * Owner, 2026-10-23 (approved): a weighed item is sold with its weight as the line's quantity (0.452 kg).
 *
 *   - before 167: order_items.quantity and stock_levels.quantity rounded 0.452 to 0.45 (the gap this migration closes).
 *   - 167 runs twice, recorded once.
 *   - every widened column holds three decimals (numeric(12,3)): order_items, stock_levels, stock_movements (both),
 *     stock_adjustments, stock_take_lines (both), grn_items.
 *   - values stored before it are kept exactly (0.45 stays 0.45, 12 stays 12).
 *   - a weighed sale end to end: the line keeps 0.452; adjust_product_stock (the cloud's atomic stock step) takes 0.452 off
 *     10 → 9.548 exactly; the movement log keeps -0.452 / 9.548; a refund (+0.452) puts it back to 10.000.
 *   - a fourth decimal is rounded to the gram (0.4525 → 0.453), never refused.
 *   - the products columns the feature uses already exist: sold_by ('weight' allowed), plu_code (unique per business), unit_label.
 *
 * MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted — listed in the A577 report):
 *   - order_items left out of 167                     → "three decimals" and "the line keeps 0.452" fail
 *   - stock_levels left out of 167                    → "three decimals" and "9.548 exactly" fail
 *   - stock_movements widened to numeric(12,2)        → "three decimals" and "the movement log" fail
 */
import fs from 'node:fs'; import path from 'node:path'; import { createRequire } from 'node:module';
import assert from 'node:assert'; import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
let PGlite;
try { ({ PGlite } = require('@electric-sql/pglite')); } catch { console.error('\n@electric-sql/pglite not installed — cannot run.\n'); process.exit(1); }
const MIG = path.join(ROOT, 'migrations');
const num = (f) => +f.split('_')[0];
const files = fs.readdirSync(MIG).filter(f => f.endsWith('.sql') && Number.isFinite(num(f))).sort((a, b) => num(a) - num(b) || a.localeCompare(b));
const BS = String.fromCharCode(92);
const sanitize = sql => sql.split('\n').filter(l => { const t = l.trim(); return !(t.startsWith(BS) || /^CREATE SCHEMA public;/i.test(t) || /set_config\('search_path'/i.test(t) || /^SET\s+search_path/i.test(t)); }).join('\n').replace(/uuid_generate_v4\(\)/gi, 'gen_random_uuid()');
const db = new PGlite();
await db.exec(`CREATE SCHEMA IF NOT EXISTS auth; CREATE SCHEMA IF NOT EXISTS extensions;
  DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN CREATE ROLE service_role; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text);
  CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
  CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT 'service_role'::text $$;
  CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT '{}'::jsonb $$;
  CREATE OR REPLACE FUNCTION extensions.uuid_generate_v4() RETURNS uuid LANGUAGE sql AS $$ SELECT gen_random_uuid() $$;
  CREATE OR REPLACE FUNCTION extensions.gen_random_uuid() RETURNS uuid LANGUAGE sql AS $$ SELECT gen_random_uuid() $$;
  CREATE OR REPLACE FUNCTION extensions.digest(text,text) RETURNS bytea LANGUAGE sql AS $$ SELECT sha256($1::bytea) $$;`);
await db.exec('SET search_path TO public, extensions, auth;');
const THIS = '167_weighed_quantities.sql';
for (const f of files.filter((f) => num(f) < 167)) await db.exec(sanitize(fs.readFileSync(path.join(MIG, f), 'utf8')));

let pass = 0, fail = 0;
const ok = async (n, fn) => { try { await fn(); pass++; console.log(`  ok   ${n}`); } catch (e) { fail++; console.log(`  FAIL ${n}\n         ${e.message}`); } };
const q = async (s, p = []) => (await db.query(s, p)).rows;
const one = async (s, p = []) => (await q(s, p))[0];
const colsOf = new Map();
const put = async (table, row) => {
  if (!colsOf.has(table)) colsOf.set(table, await q(`SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`, [table]));
  const full = { ...row };
  for (const c of colsOf.get(table)) {
    if (c.is_nullable === 'YES' || c.column_default !== null || c.column_name in full) continue;
    const t = c.data_type;
    full[c.column_name] = t === 'uuid' ? crypto.randomUUID() : /int|numeric|double|real/.test(t) ? 0 : t === 'boolean' ? false
      : /timestamp/.test(t) ? '2026-10-01T10:00:00Z' : t === 'date' ? '2026-10-01' : t === 'jsonb' || t === 'json' ? '{}' : t === 'ARRAY' ? '{}' : `x-${crypto.randomUUID().slice(0, 8)}`;
  }
  const k = Object.keys(full);
  return (await db.query(`INSERT INTO public.${table} (${k.join(',')}) VALUES (${k.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`, k.map((x) => full[x]))).rows[0];
};
const id = (n) => `00000000-0000-0000-0000-${n.toString(16).padStart(12, '0')}`;
const BIZ = id(0xa), BR = id(0xa1), BEEF = id(0xb1), SODA = id(0xb2);

console.log('\nMigration 167 (weighed quantities) — PGlite, every migration\n');
await put('businesses', { id: BIZ, name: 'Mama Mboga Mart', type: 'minimart' });
await put('branches', { id: BR, business_id: BIZ, name: 'Kasarani' });
await put('products', { id: BEEF, business_id: BIZ, name: 'Beef steak', base_price: 650, sold_by: 'weight', plu_code: '01234', unit_label: 'kg' });
await put('products', { id: SODA, business_id: BIZ, name: 'Soda 500ml', base_price: 80 });
const order = await put('orders', { business_id: BIZ, branch_id: BR, order_number: 'T1-0001', subtotal: 293.8, total: 293.8, vat_amount: 0 });
const OLD = await put('order_items', { order_id: order.id, product_id: SODA, product_name: 'Soda 500ml', unit_price: 80, quantity: 12, subtotal: 960 });

await ok('before 167: 0.452 was stored as 0.45 (the line and the stock) — the gap this closes', async () => {
  const it = await put('order_items', { order_id: order.id, product_id: BEEF, product_name: 'Beef steak', unit_price: 650, quantity: 0.452, subtotal: 293.8 });
  assert.equal(String(it.quantity), '0.45');
  await db.query(`DELETE FROM public.order_items WHERE id = $1`, [it.id]);
  await put('stock_levels', { product_id: BEEF, branch_id: BR, quantity: 0.45 });   // a level stored before 167
});

const sql = sanitize(fs.readFileSync(path.join(MIG, THIS), 'utf8'));
await ok('167 runs (and again — idempotent), recorded once', async () => {
  await db.exec(sql); await db.exec(sql);
  assert.equal(Number((await one(`SELECT count(*) AS n FROM public.schema_migrations WHERE version = '167_weighed_quantities'`)).n), 1);
});

const WIDE = [['order_items', 'quantity'], ['stock_levels', 'quantity'], ['stock_movements', 'quantity_change'], ['stock_movements', 'quantity_after'],
  ['stock_adjustments', 'quantity'], ['stock_take_lines', 'counted_qty'], ['stock_take_lines', 'expected_qty'], ['grn_items', 'quantity_received']];
await ok('three decimals on every quantity a weighed sale passes through (numeric(12,3))', async () => {
  for (const [t, c] of WIDE) {
    const r = await one(`SELECT numeric_precision AS p, numeric_scale AS s FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`, [t, c]);
    assert.deepEqual([t, c, Number(r?.p), Number(r?.s)], [t, c, 12, 3]);
  }
});
await ok('values stored before it are kept exactly (12 stays 12, 0.45 stays 0.45)', async () => {
  assert.equal(Number((await one(`SELECT quantity FROM public.order_items WHERE id = $1`, [OLD.id])).quantity), 12);
  assert.equal(String((await one(`SELECT quantity FROM public.stock_levels WHERE product_id = $1`, [BEEF])).quantity), '0.450');
});
await ok('a weighed sale: the line keeps 0.452', async () => {
  const it = await put('order_items', { order_id: order.id, product_id: BEEF, product_name: 'Beef steak', unit_price: 650, quantity: 0.452, subtotal: 293.8 });
  assert.equal(String(it.quantity), '0.452');
});
await ok('…the stock: adjust_product_stock takes 0.452 off 10 → 9.548 exactly; a refund puts it back to 10.000', async () => {
  await db.query(`UPDATE public.stock_levels SET quantity = 10 WHERE product_id = $1 AND branch_id = $2`, [BEEF, BR]);
  const after = await one(`SELECT quantity FROM public.adjust_product_stock($1, $2, $3)`, [BEEF, BR, -0.452]);
  assert.equal(String(after.quantity), '9.548');
  assert.equal(String((await one(`SELECT quantity FROM public.stock_levels WHERE product_id = $1 AND branch_id = $2`, [BEEF, BR])).quantity), '9.548');
  const back = await one(`SELECT quantity FROM public.adjust_product_stock($1, $2, $3)`, [BEEF, BR, 0.452]);
  assert.equal(String(back.quantity), '10.000');
});
await ok('…the movement log keeps -0.452 / 9.548', async () => {
  const m = await put('stock_movements', { product_id: BEEF, branch_id: BR, movement_type: 'sale', quantity_change: -0.452, quantity_after: 9.548 });
  assert.deepEqual([String(m.quantity_change), String(m.quantity_after)], ['-0.452', '9.548']);
});
await ok('a fourth decimal is rounded to the gram (0.4525 → 0.453), never refused', async () => {
  const it = await put('order_items', { order_id: order.id, product_id: BEEF, product_name: 'Beef steak', unit_price: 650, quantity: 0.4525, subtotal: 294.13 });
  assert.equal(String(it.quantity), '0.453');
});
await ok('the product columns the feature uses already exist: sold_by (weight allowed), plu_code (unique per business), unit_label', async () => {
  const p = await one(`SELECT sold_by, plu_code, unit_label FROM public.products WHERE id = $1`, [BEEF]);
  assert.deepEqual(p, { sold_by: 'weight', plu_code: '01234', unit_label: 'kg' });
  await assert.rejects(() => put('products', { business_id: BIZ, name: 'Other beef', base_price: 600, plu_code: '01234' }), /duplicate|unique/i);
  await assert.rejects(() => put('products', { business_id: BIZ, name: 'Bad', base_price: 1, sold_by: 'kilo' }), /check/i);
});
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
