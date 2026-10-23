/**
 * test-migration-162.mjs — A561: analytics_stock_use, analytics_customers and analytics_cost_watch, run for real against
 * the WHOLE schema (every migration before 162 replayed into PGlite), on the A549 trading scenario plus A561's stock,
 * customer and cost rows (scripts/lib/analytics-pg.mjs seedA561).
 *
 *   - 162 runs twice, recorded once; each function is the service role's only (not anon / authenticated), STABLE;
 *   - stock use: what the sales took off, less a voided paid order put back (never another correction), plus wastage not
 *     voided, this period and the one before; tracked products only (never a recipe item, never one that does not track
 *     stock, never another business); ingredients through their sale movements; on hand only for ONE branch;
 *   - customers: new and returning per period, the order-type rows, a customer's visits / last visit / 90-day visits;
 *     without p_with_customers no customer row at all;
 *   - cost watch: an ingredient's cost at the start (a delivery before the period) and the end (an edit in it), the
 *     recipe product's change per serving (never a product with its own cost), the top ingredient, the active products
 *     with no cost that did not sell.
 *
 * MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted — listed in the A561 report):
 *   - without the "Void of Order" filter on corrections (every correction netted)   → "stock use" fails
 *   - without w.voided_at IS NULL                                                   → "stock use" fails
 *   - on hand read with every branch in view                                        → "on hand" fails
 *   - customer rows without p_with_customers                                        → "customers" fails
 */
import fs from 'node:fs'; import path from 'node:path';
import assert from 'node:assert'; import { fileURLToPath } from 'node:url';
import { openSchema, seedAnalytics, seedA561, migrationSql } from './lib/analytics-pg.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = async (n, fn) => { try { await fn(); pass++; console.log(`  ok   ${n}`); } catch (e) { fail++; console.log(`  FAIL ${n}\n         ${e.message}`); } };
console.log('\nMigration 162 (analytics stock use, customers, cost watch) — PGlite, every migration\n');

const pg = await openSchema({ through: 161 });
const { q, rpc } = pg;
const one = async (s, p = []) => (await q(s, p))[0];
const S = await seedAnalytics(pg);
const X = await seedA561(pg, S);
const FNS = ['analytics_stock_use', 'analytics_customers', 'analytics_cost_watch'];

await ok('162 runs (and again — idempotent), recorded once; each function is the service role\'s only and STABLE', async () => {
  const sql = migrationSql(162);
  await pg.db.exec(sql); await pg.db.exec(sql);
  assert.equal(Number((await one(`SELECT count(*) AS n FROM public.schema_migrations WHERE version = '162_analytics_stock_customers_costs'`)).n), 1);
  for (const fn of FNS) {
    const sig = (await one(`SELECT p.oid::regprocedure::text AS sig FROM pg_proc p WHERE p.proname = $1`, [fn])).sig;
    assert.equal((await one(`SELECT has_function_privilege('anon', $1, 'EXECUTE') AS x`, [sig])).x, false, `${fn} anon`);
    assert.equal((await one(`SELECT has_function_privilege('authenticated', $1, 'EXECUTE') AS x`, [sig])).x, false, `${fn} authenticated`);
    assert.equal((await one(`SELECT has_function_privilege('service_role', $1, 'EXECUTE') AS x`, [sig])).x, true, `${fn} service_role`);
    assert.equal((await one(`SELECT provolatile AS v FROM pg_proc WHERE proname = $1`, [fn])).v, 's', `${fn} STABLE`);
  }
});
await ok('the functions are declared pending (or in the functions index) and named as the cloud calls them', async () => {
  const pending = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/schema-pending.json'), 'utf8')).pending ?? {};
  const live = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/functions-index.json'), 'utf8'));
  assert.ok(pending['162_analytics_stock_customers_costs.sql'] || FNS.every((f) => live[f]), '162 declared pending until it is run and the index refreshed');
  const route = fs.readFileSync(path.join(ROOT, 'apps/server/src/routes/analytics.ts'), 'utf8');
  for (const f of FNS) assert.ok(route.includes(`'${f}'`), f);
});

const use = async (branch, business = S.A) => {
  const { data, error } = await rpc('analytics_stock_use', { p_business: business, p_branch: branch, p_from: S.START, p_to: S.END, p_prev_from: X.PREV_START, p_limit: 300 });
  assert.equal(error, null, error?.message);
  return data;
};
const item = (rows, name) => rows.find((r) => r.item_name === name);

await ok('stock use: sold less a voided paid order put back, plus wastage not voided; the previous period; tracked products only', async () => {
  const w = await use(S.W);
  const t = item(w, 'Tusker lager');
  assert.deepEqual([t.kind, t.sold, t.wasted, t.prev_sold, t.prev_wasted, t.unit], ['product', 204, 4, 100, 0, 'bottles'], '210 − 6 (the void; not the stock count\'s +5), 4 wasted (not the voided 9)');
  const eggs = item(w, 'Eggs');
  assert.deepEqual([eggs.sold, eggs.by_piece, eggs.unit], [12, true, 'pieces'], 'by the piece: the void\'s +1 is in units, not netted');
  const wing = item(w, 'Wing');
  assert.deepEqual([wing.kind, wing.sold, wing.wasted], ['ingredient', 40, 10], 'sale movements only (not the +300 adjustment)');
  assert.equal(item(w, 'Chicken wings'), undefined, 'a recipe item: its stock is the ingredients\'');
  assert.equal(item(w, 'Soda'), undefined, 'no stock tracking');
  assert.equal(item(w, 'Their beer'), undefined, 'another business');
  assert.equal(item(await use(S.K), 'Tusker lager').sold, 50, 'Kilimani\'s own');
  assert.equal(item(await use(null), 'Tusker lager').sold, 254, 'every branch');
});
await ok('on hand: the level at the ONE branch asked (pieces by the piece); none with every branch', async () => {
  const w = await use(S.W);
  assert.deepEqual([item(w, 'Tusker lager').on_hand, item(w, 'Eggs').on_hand, item(w, 'Wing').on_hand], [20, 30, 100]);
  assert.equal(item(await use(S.K), 'Tusker lager').on_hand, 500);
  assert.ok((await use(null)).every((r) => r.on_hand === null), 'stock is counted per branch');
});

const cust = async (withCustomers, branch = S.W) => {
  const { data, error } = await rpc('analytics_customers', { p_business: S.A, p_branch: branch, p_from: S.START, p_to: S.END, p_prev_from: X.PREV_START, p_cutoff: 0, p_with_customers: withCustomers, p_limit: 200 });
  assert.equal(error, null, error?.message);
  return data;
};
await ok('customers: new and returning per period; a customer\'s visits, last visit and 90-day visits', async () => {
  const rows = await cust(true);
  const now = rows.find((r) => r.kind === 'period' && r.which === 'now');
  const prev = rows.find((r) => r.kind === 'period' && r.which === 'prev');
  // now: Brian (new, 2), Acme (returning; also the awaiting-credit order), Paid Up (first order in October: new)
  assert.deepEqual([now.customers, now.new_customers], [3, 2]);
  assert.ok(now.linked_orders >= 5 && now.orders > now.linked_orders, 'most orders are walk-ins');
  assert.deepEqual([prev.customers, prev.new_customers], [2, 1], 'September: Wanjiku (from July, not new) and Acme (new then)');
  const wan = rows.find((r) => r.kind === 'customer' && r.customer_name === 'Wanjiku');
  assert.deepEqual([wan.visits, wan.last_visit, wan.prev_visits], [0, '2026-09-23', 3], 'gone quiet: no visit in October');
  assert.equal(wan.visits_90, 13, '23 July → 23 September, every 5 days, inside the 90 days to 21 October');
  const brian = rows.find((r) => r.kind === 'customer' && r.customer_name === 'Brian');
  assert.deepEqual([brian.visits, brian.spend], [2, 3000]);
  const types = rows.filter((r) => r.kind === 'type');
  assert.ok(types.some((r) => r.order_type === 'takeaway' && r.day === '2026-10-05'));
  assert.ok(types.some((r) => r.order_type === 'delivery'));
});
await ok('customers: without p_with_customers no customer row (and no name) — the mix stays', async () => {
  const rows = await cust(false);
  assert.equal(rows.filter((r) => r.kind === 'customer').length, 0);
  assert.ok(rows.some((r) => r.kind === 'type') && rows.some((r) => r.kind === 'period'));
  assert.ok(!JSON.stringify(rows).includes('Wanjiku'));
});

await ok('cost watch: the cost at the start (a delivery before) and the end (an edit in the period); the recipe products; no cost unsold', async () => {
  const { data: rows, error } = await rpc('analytics_cost_watch', { p_business: S.A, p_branch: S.W, p_from: S.START, p_to: S.END });
  assert.equal(error, null, error?.message);
  const oil = rows.find((r) => r.kind === 'ingredient' && r.item_name === 'Cooking oil');
  assert.deepEqual([oil.cost_start, oil.cost_end, oil.changes, oil.used_in, oil.unit], [0.4, 0.5, 1, 2, 'ml']);
  assert.equal(rows.filter((r) => r.kind === 'ingredient').length, 1, 'nothing else moved');
  const prods = rows.filter((r) => r.kind === 'product');
  assert.deepEqual(prods.map((r) => [r.item_name, r.delta, r.cost_now]), [['Chips masala', 10, 70]], '100 ml × 0.1; Fries has its own cost');
  assert.deepEqual(prods[0].names, [X.OIL]);
  assert.equal(rows.find((r) => r.kind === 'top_ingredient' && r.item_id === X.CHIPSM).item_name, 'Cooking oil', '50 of the 70');
  const unsold = rows.find((r) => r.kind === 'unsold_no_cost');
  assert.deepEqual([unsold.changes, unsold.names], [1, ['Ghost']], 'Soda sold; Old menu item is inactive');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
