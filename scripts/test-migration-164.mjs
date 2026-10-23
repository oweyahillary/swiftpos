/**
 * test-migration-164.mjs — A575: analytics_together ("What sells together"), run for real against the WHOLE schema
 * (every migration before 164 replayed into PGlite) on a small scenario of its own:
 *
 *   business A, branches W and K; business B elsewhere. Period 2026-10-01 .. 2026-10-21 (EAT).
 *   At W: 6 orders Wrap + Soda; 2 orders Wrap + Soda + Chips; 3 orders Wrap alone; 1 order Chips + Soda; one order with
 *   Wrap rung twice and Soda (counts once); one Wrap + a free Soda (subtotal 0 — not a pair); a voided Wrap + Soda; a Wrap +
 *   Soda before the period; a 30-product stock-up order holding Wrap and Soda (counts in the orders, no pair); a Petrol +
 *   Water order twice (fuel flagged). At K: 4 orders Wrap + Soda. Business B: 5 orders of its own Wrap + Soda.
 *
 *   - 164 runs twice, recorded once; the function is the service role's only (not anon / authenticated), STABLE;
 *   - the total row: orders with a priced product line, and those with two or more different products;
 *   - the pairs: together / each item's orders, a product rung twice once, a free line out, a voided order out, outside the
 *     period out, another business out, the big basket gives no pair, a pair seen once is not listed; the branch scope;
 *     the fuel flag; the limit.
 *
 * MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted — listed in the A575 report):
 *   - without coalesce(oi.subtotal, 0) > 0 (the free Soda counts)            → "pairs" fails
 *   - without the k.n BETWEEN 2 AND 25 cap (the stock-up order gives pairs)  → "pairs" fails
 *   - without o.status = 'completed'                                         → "pairs" fails
 *   - without the branch filter                                             → "branch scope" fails
 */
import fs from 'node:fs'; import path from 'node:path';
import assert from 'node:assert'; import { fileURLToPath } from 'node:url';
import { openSchema, migrationSql } from './lib/analytics-pg.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = async (n, fn) => { try { await fn(); pass++; console.log(`  ok   ${n}`); } catch (e) { fail++; console.log(`  FAIL ${n}\n         ${e.message}`); } };
console.log('\nMigration 164 (analytics what sells together) — PGlite, every migration\n');

const pg = await openSchema({ through: 163 });
const { q, put, rpc } = pg;
const one = async (s, p = []) => (await q(s, p))[0];

const uid = (n) => `00000000-0000-0000-0000-${n.toString(16).padStart(12, '0')}`;
const A = uid(0xa), B = uid(0xb), W = uid(0xa1), K = uid(0xa2), BB = uid(0xb1);
await put('businesses', { id: A, name: 'Wrap Shack', type: 'restaurant' });
await put('businesses', { id: B, name: 'Other', type: 'restaurant' });
await put('branches', { id: W, business_id: A, name: 'Westlands' });
await put('branches', { id: K, business_id: A, name: 'Kilimani' });
await put('branches', { id: BB, business_id: B, name: 'Theirs' });
const prod = async (biz, name, extra = {}) => (await put('products', { business_id: biz, name, base_price: 100, ...extra })).id;
const WRAP = await prod(A, 'Chicken Wrap'), SODA = await prod(A, 'Soda 500ml'), CHIPS = await prod(A, 'Chips');
const PETROL = await prod(A, 'Petrol', { is_fuel: true }), WATER = await prod(A, 'Water 1L');
const BWRAP = await prod(B, 'Wrap'), BSODA = await prod(B, 'Soda');
const FILLER = [];
for (let i = 0; i < 28; i++) FILLER.push(await prod(A, `Item ${i}`));

const IN = '2026-10-10T09:00:00Z';
let n = 0;
const order = async (lines, o = {}) => {
  n += 1;
  const row = await put('orders', { business_id: A, branch_id: W, order_number: `T-${n}`, status: 'completed', total: 100, subtotal: 100, discount_amount: 0, created_at: IN, ...o });
  for (const [pid, name, sub = 100] of lines) await put('order_items', { order_id: row.id, product_id: pid, product_name: name, quantity: 1, unit_price: sub, subtotal: sub });
};
const w = [WRAP, 'Chicken Wrap'], s = [SODA, 'Soda 500ml'], c = [CHIPS, 'Chips'];
for (let i = 0; i < 6; i++) await order([w, s]);
for (let i = 0; i < 2; i++) await order([w, s, c]);
for (let i = 0; i < 3; i++) await order([w]);
await order([c, s]);
await order([w, w, s]);                                        // Wrap rung twice: one order with Wrap
await order([w, [SODA, 'Soda 500ml', 0]]);                     // a free Soda: not a choice paid for
await order([w, s], { status: 'voided' });
await order([w, s], { created_at: '2026-09-20T09:00:00Z' });   // before the period
await order([w, s, ...FILLER.map((id, k) => [id, `Item ${k}`])]);   // 30 products: counts, gives no pair
for (let i = 0; i < 2; i++) await order([[PETROL, 'Petrol'], [WATER, 'Water 1L']]);
for (let i = 0; i < 4; i++) await order([w, s], { branch_id: K });
for (let i = 0; i < 5; i++) await order([[BWRAP, 'Wrap'], [BSODA, 'Soda']], { business_id: B, branch_id: BB });

const START = '2026-09-30T21:00:00.000Z', END = '2026-10-21T20:59:59.999Z';
const run = async (branch, limit = 100, business = A) => {
  const { data, error } = await rpc('analytics_together', { p_business: business, p_branch: branch, p_from: START, p_to: END, p_limit: limit });
  assert.equal(error, null, error?.message);
  return data;
};
const pairOf = (rows, x, y) => rows.find((r) => r.kind === 'pair' && ((r.a_id === x && r.b_id === y) || (r.a_id === y && r.b_id === x)));
const ordersOf = (r, id) => (r.a_id === id ? r.a_orders : r.b_orders);

await ok('164 runs (and again — idempotent), recorded once; the function is the service role\'s only and STABLE', async () => {
  const sql = migrationSql(164);
  await pg.db.exec(sql); await pg.db.exec(sql);
  assert.equal(Number((await one(`SELECT count(*) AS n FROM public.schema_migrations WHERE version = '164_analytics_together'`)).n), 1);
  const sig = (await one(`SELECT p.oid::regprocedure::text AS sig FROM pg_proc p WHERE p.proname = 'analytics_together'`)).sig;
  assert.equal((await one(`SELECT has_function_privilege('anon', $1, 'EXECUTE') AS x`, [sig])).x, false, 'anon');
  assert.equal((await one(`SELECT has_function_privilege('authenticated', $1, 'EXECUTE') AS x`, [sig])).x, false, 'authenticated');
  assert.equal((await one(`SELECT has_function_privilege('service_role', $1, 'EXECUTE') AS x`, [sig])).x, true, 'service_role');
  assert.equal((await one(`SELECT provolatile AS v FROM pg_proc WHERE proname = 'analytics_together'`)).v, 's', 'STABLE');
});
await ok('declared pending (or in the functions index) and named as the cloud calls it', async () => {
  const pending = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/schema-pending.json'), 'utf8')).pending ?? {};
  const live = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/functions-index.json'), 'utf8'));
  assert.ok(pending['164_analytics_together.sql'] || live.analytics_together, '164 declared pending until it is run and the index refreshed');
  assert.ok(fs.readFileSync(path.join(ROOT, 'apps/server/src/routes/analytics.ts'), 'utf8').includes("'analytics_together'"));
});

await ok('the total row: orders with a priced product line, and those with two or more different products', async () => {
  const t = (await run(W)).find((r) => r.kind === 'total');
  // W in the period, completed: 6 + 2 + 3 + 1 + 1 + 1 + 1 (stock-up) + 2 (petrol) = 17; one product only: the 3 Wraps and
  // the Wrap with a free Soda → 13 with two or more
  assert.deepEqual([t.orders, t.multi_orders], [17, 13]);
});
await ok('pairs: together and each item\'s orders; a product rung twice once; a free line, a void, another period, the big basket out', async () => {
  const rows = await run(W);
  const ws = pairOf(rows, WRAP, SODA);
  assert.equal(ws.together, 9, '6 + 2 + the twice-rung Wrap (not the free Soda, the void, September, the stock-up order)');
  assert.equal(ordersOf(ws, WRAP), 14, 'Wrap: 6 + 2 + 3 + twice-rung + free-Soda + stock-up');
  assert.equal(ordersOf(ws, SODA), 11, 'Soda: 6 + 2 + Chips&Soda + twice-rung + stock-up');
  assert.equal(pairOf(rows, CHIPS, SODA).together, 3);
  assert.equal(pairOf(rows, WRAP, CHIPS).together, 2);
  assert.ok(!rows.some((r) => FILLER.includes(r.a_id) || FILLER.includes(r.b_id)), 'the stock-up order gives no pair');
  assert.ok(!rows.some((r) => r.kind === 'pair' && (r.a_id === BWRAP || r.b_id === BWRAP)), 'another business');
  const pw = pairOf(rows, PETROL, WATER);
  assert.equal(pw.together, 2);
  assert.equal(pw.a_id === PETROL ? pw.a_fuel : pw.b_fuel, true, 'fuel flagged');
  assert.equal(pw.a_id === WATER ? pw.a_fuel : pw.b_fuel, false);
  assert.ok(rows.filter((r) => r.kind === 'pair').every((r) => r.a_id < r.b_id), 'each pair once');
  assert.ok(rows.every((r) => r.kind !== 'pair' || r.a_name && r.b_name), 'named');
});
await ok('branch scope: Kilimani its own; every branch adds them up', async () => {
  assert.equal(pairOf(await run(K), WRAP, SODA).together, 4);
  const all = await run(null);
  assert.equal(pairOf(all, WRAP, SODA).together, 13);
  assert.equal(all.find((r) => r.kind === 'total').orders, 21);
});
await ok('the limit: the pairs found together most', async () => {
  const rows = await run(W, 1);
  const pairs = rows.filter((r) => r.kind === 'pair');
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].together, 9, 'Wrap + Soda first');
  assert.equal(rows.filter((r) => r.kind === 'total').length, 1);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
