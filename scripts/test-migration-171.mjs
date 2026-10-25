/**
 * test-migration-171.mjs — A582: "All my branches" — the ten analytics aggregates over a SET of branches (<name>_set,
 * p_branches uuid[]; the originals untouched), run for real against the WHOLE schema (every migration before 171 replayed into PGlite) on the Analytics scenario
 * (scripts/lib/analytics-pg.mjs: business A with Westlands W and Kilimani K; business B elsewhere) plus a THIRD branch of A,
 * V ("Vee branch"), seeded with distinctive data in every table an aggregate reads: a product only V sells ("Vee special"),
 * a cashier only V has (Vera), a voided order, a kitchen void, wastage, a drawer short, a day-close short, a credit customer
 * whose only debt is at V ("Vera Credit"), a disputed credit sale, stock movements, customers and pairs.
 *
 *   - 171 runs twice, recorded once; each _set function once, the service role's only and STABLE; the ten originals keep
 *     their one signature (nothing dropped, nothing overloaded);
 *   - the originals answer exactly as before 171 (one branch, every branch) — the owner's calls;
 *   - _set [W] answers as the original for W; [W, K] never carries anything of V (no product, cashier, customer, amount),
 *     and the additive figures are W's plus K's; a NULL or empty list is nothing (never every branch);
 *   - credit ageing's unaged part is never counted for a set; stock use's on-hand stays NULL for a set.
 *
 * MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted — listed in the A582 entry):
 *   - one filter left as every branch (money_leaks' wastage: `true`)          → "never V" fails
 *   - credit ageing's unaged part kept for a set                              → "unaged never for a set" fails
 *   - analytics_together_set without its REVOKE from anon                     → "the service role's only" fails
 */
import fs from 'node:fs'; import path from 'node:path';
import assert from 'node:assert'; import { fileURLToPath } from 'node:url';
import { openSchema, migrationSql, seedAnalytics, seedA561 } from './lib/analytics-pg.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = async (n, fn) => { try { await fn(); pass++; console.log(`  ok   ${n}`); } catch (e) { fail++; console.log(`  FAIL ${n}\n         ${e.message}`); } };
console.log('\nMigration 171 (analytics branch sets) — PGlite, every migration\n');

const pg = await openSchema({ through: 170 });
const { q, put, rpc } = pg;
const one = async (s, p = []) => (await q(s, p))[0];
const S = await seedAnalytics(pg);
const X = await seedA561(pg, S);

// ── V: the branch a partner of W and K must never see ────────────────────────────────────────────────────────────────
const uid = (n) => `00000000-0000-0000-0000-${n.toString(16).padStart(12, '0')}`;
const V = uid(0xa3), VERA = uid(0xc9), VEE = uid(0xdd);
await put('branches', { id: V, business_id: S.A, name: 'Vee branch' });
const E = uid(0xa4);   // a branch with nothing: what "nothing" looks like for each function
await put('branches', { id: E, business_id: S.A, name: 'Empty branch' });
await put('users', { id: VERA, business_id: S.A, name: 'Vera', email: 'vera@test' });
await put('products', { id: VEE, business_id: S.A, name: 'Vee special', base_price: 7777, cost_price: 1111, track_stock: true });
const MON15 = '2026-10-19T12:00:00Z';
let n = 0;
const vOrder = async (o, items) => {
  const row = await put('orders', { business_id: S.A, branch_id: V, order_number: `V-${++n}`, status: 'completed', subtotal: o.total, discount_amount: 0, cashier_id: VERA, created_at: MON15, ...o });
  for (const [pid, name, qty, sub] of items) await put('order_items', { order_id: row.id, product_id: pid, product_name: name, quantity: qty, unit_price: sub / qty, subtotal: sub });
  return row.id;
};
const VCUST = (await put('customers', { business_id: S.A, name: 'Vera Credit', phone: '0799', credit_limit: 9000, credit_balance: 5555 })).id;
for (let i = 0; i < 3; i++) await vOrder({ total: 7777 * 3, discount_amount: 77, customer_id: VCUST, order_type: 'dine_in' }, [[VEE, 'Vee special', 3, 7777 * 3], [S.SODA, 'Soda', 1, 50]]);
const VVOID = await vOrder({ total: 1234, status: 'voided' }, [[VEE, 'Vee special', 1, 1234]]);
await put('kitchen_voids', { business_id: S.A, branch_id: V, product_name: 'Vee special', quantity: 1, unit_price: 7777, amount: 7777, reason: 'changed_mind', cashier_id: VERA, created_at: '2026-10-17T09:00:00Z' });
await put('wastage_entries', { business_id: S.A, branch_id: V, ref: 'W-V1', item_kind: 'product', product_id: VEE, name: 'Vee special', quantity: 5, unit_cost: 1111, value: 5555, reason: 'spoiled', recorded_by: VERA, created_at: '2026-10-17T10:00:00Z' });
await put('shifts', { business_id: S.A, branch_id: V, cashier_id: VERA, opened_at: '2026-10-17T05:00:00Z', closed_at: '2026-10-17T15:00:00Z', status: 'closed', cash_variance: -999 });
await put('business_days', { business_id: S.A, branch_id: V, business_date: '2026-10-17', status: 'closed', cash_variance: -888 });
await put('customer_credit_transactions', { business_id: S.A, customer_id: VCUST, branch_id: V, type: 'charge', amount: 5555, balance_after: 5555, created_at: '2026-10-10T10:00:00Z' });
await put('credit_confirmations', { order_id: VVOID, business_id: S.A, branch_id: V, customer_id: VCUST, amount: 4444, state: 'disputed', decided_at: '2026-10-20T10:00:00Z', dispute_reason: 'Vee dispute' });
await put('stock_movements', { product_id: VEE, branch_id: V, movement_type: 'sale', quantity_change: -9, quantity_after: 0, created_at: '2026-10-15T10:00:00Z', notes: 'Order V-1', reference_type: 'order' });
await put('stock_levels', { product_id: VEE, branch_id: V, quantity: 44, qty_pieces: 0 });

const START = '2026-09-30T21:00:00.000Z', END = '2026-10-21T20:59:59.999Z', PREV = X.PREV_START, AS_OF = '2026-10-21T09:00:00.000Z';
const FNS = {
  analytics_menu_engineering: { p_from: START, p_to: END },
  analytics_sales_heatmap: { p_from: START, p_to: END },
  analytics_money_leaks: { p_from: START, p_to: END, p_cutoff: 0 },
  analytics_credit_ageing: { p_as_of: AS_OF },
  analytics_daily_sales: { p_from: START, p_to: END, p_cutoff: 0 },
  analytics_item_times: { p_from: START, p_to: END, p_cutoff: 0, p_limit: 100 },
  analytics_stock_use: { p_from: START, p_to: END, p_prev_from: PREV, p_limit: 300 },
  analytics_customers: { p_from: START, p_to: END, p_prev_from: PREV, p_cutoff: 0, p_with_customers: true, p_limit: 200 },
  analytics_cost_watch: { p_from: START, p_to: END },
  analytics_together: { p_from: START, p_to: END, p_limit: 100 },
};
const call = async (fn, scope) => {
  const set = 'p_branches' in scope;
  const { data, error } = await rpc(set ? `${fn}_set` : fn, { p_business: S.A, ...scope, ...FNS[fn] });
  assert.equal(error, null, `${fn}${set ? '_set' : ''}: ${error?.message}`);
  return data;
};
/** A stable form of a result: rows as sorted JSON (row order is not part of any function's answer). */
const norm = (rows) => rows.map((r) => JSON.stringify(Object.keys(r).sort().map((k) => [k, r[k]]))).sort();

// before 171: every function, for every branch and for all
const before = {};
for (const fn of Object.keys(FNS)) {
  before[fn] = {};
  for (const [label, b] of [['all', null], ['W', S.W], ['K', S.K], ['V', V]]) before[fn][label] = norm(await call(fn, { p_branch: b }));
}

const sigOf = async (name) => (await q(`SELECT p.oid::regprocedure::text AS sig FROM pg_proc p WHERE p.proname = $1`, [name])).map((r) => r.sig);
const originals = {};
for (const fn of Object.keys(FNS)) originals[fn] = await sigOf(fn);
await ok('171 runs (and again — idempotent), recorded once; each _set once, the service role\'s only and STABLE; the originals untouched', async () => {
  const sql = migrationSql(171);
  await pg.db.exec(sql); await pg.db.exec(sql);
  assert.equal(Number((await one(`SELECT count(*) AS n FROM public.schema_migrations WHERE version = '171_analytics_branch_sets'`)).n), 1);
  for (const fn of Object.keys(FNS)) {
    assert.equal(originals[fn].length, 1, fn);
    assert.deepEqual(await sigOf(fn), originals[fn], `${fn}: the original keeps its one signature`);
    const procs = await q(`SELECT p.oid::regprocedure::text AS sig, p.provolatile AS v FROM pg_proc p WHERE p.proname = $1`, [`${fn}_set`]);
    assert.equal(procs.length, 1, `${fn}_set: one function — got ${procs.map((p) => p.sig).join(' | ')}`);
    assert.ok(/\(uuid, ?uuid\[\]/.test(procs[0].sig), `${fn}_set: (business, branches, …) — ${procs[0].sig}`);
    assert.equal(procs[0].v, 's', `${fn} STABLE`);
    assert.equal((await one(`SELECT has_function_privilege('anon', $1, 'EXECUTE') AS x`, [procs[0].sig])).x, false, `${fn} anon`);
    assert.equal((await one(`SELECT has_function_privilege('authenticated', $1, 'EXECUTE') AS x`, [procs[0].sig])).x, false, `${fn} authenticated`);
    assert.equal((await one(`SELECT has_function_privilege('service_role', $1, 'EXECUTE') AS x`, [procs[0].sig])).x, true, `${fn} service_role`);
  }
});
await ok('declared pending (or in the functions index) and sent by the cloud only for a set', async () => {
  const pending = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/schema-pending.json'), 'utf8')).pending ?? {};
  assert.ok(pending['171_analytics_branch_sets.sql'], '171 declared pending until it is run');
  const src = fs.readFileSync(path.join(ROOT, 'apps/server/src/routes/analytics.ts'), 'utf8');
  assert.ok(src.includes('p_branches: c.branches') && src.includes('`${fn}_set`'), 'the cloud calls the _set twin with p_branches');
});
await ok('the originals answer exactly as before 171 — one branch, and every branch', async () => {
  for (const fn of Object.keys(FNS)) {
    for (const [label, b] of [['all', null], ['W', S.W], ['K', S.K], ['V', V]]) {
      assert.deepEqual(norm(await call(fn, { p_branch: b })), before[fn][label], `${fn} ${label}`);
    }
  }
});
await ok('_set [W] answers as the original for W (stock use: no on-hand for a set)', async () => {
  for (const fn of Object.keys(FNS)) {
    const got = await call(fn, { p_branches: [S.W] });
    if (fn === 'analytics_stock_use') {
      assert.ok(got.every((r) => r.on_hand === null), 'on-hand NULL for a set');
      const strip = (rows) => rows.map((r) => ({ ...r, on_hand: null }));
      assert.deepEqual(norm(strip(got)), norm(strip(before[fn].W.map((s) => Object.fromEntries(JSON.parse(s))))), fn);
      continue;
    }
    assert.deepEqual(norm(got), before[fn].W, fn);
  }
});
await ok('never V: [W, K] carries no product, cashier, customer, branch or amount of V — in any of the ten', async () => {
  const marks = [V, VERA, VEE, VCUST, 'Vee special', 'Vera', 'Vera Credit', 'Vee dispute'];
  for (const fn of Object.keys(FNS)) {
    const text = JSON.stringify(await call(fn, { p_branches: [S.W, S.K] }));
    for (const m of marks) assert.ok(!text.includes(m), `${fn} carries ${m}`);
    // and every branch (the owner's) does carry V somewhere it can — the scenario is real
  }
  const leaks = await call('analytics_money_leaks', { p_branches: [S.W, S.K] });
  const sum = (rows, k) => rows.filter((r) => r.by_cashier).reduce((a, r) => a + Number(r[k] ?? 0), 0);
  const leaksAll = await call('analytics_money_leaks', { p_branch: null });
  assert.ok(sum(leaksAll, 'wastage_value') > sum(leaks, 'wastage_value'), 'every branch holds V\'s wastage');
  assert.equal(sum(leaks, 'drawer_variance') + -999, sum(leaksAll, 'drawer_variance'), 'only V\'s drawer short is left out');
  assert.ok(JSON.stringify(await call('analytics_menu_engineering', { p_branch: null })).includes('Vee special'), 'every branch sells it');
});
await ok('the additive figures: [W, K] is W plus K (daily sales, heatmap, menu quantities, leaks orders)', async () => {
  const tot = (rows, k) => rows.reduce((a, r) => a + Number(r[k] ?? 0), 0);
  const parse = (label, fn) => before[fn][label].map((s) => Object.fromEntries(JSON.parse(s)));
  for (const [fn, k] of [['analytics_daily_sales', 'revenue'], ['analytics_sales_heatmap', 'revenue'], ['analytics_menu_engineering', 'qty'], ['analytics_menu_engineering', 'revenue']]) {
    const set = await call(fn, { p_branches: [S.W, S.K] });
    assert.equal(Math.round(tot(set, k) * 100), Math.round((tot(parse('W', fn), k) + tot(parse('K', fn), k)) * 100), `${fn} ${k}`);
  }
  const lk = (rows) => rows.filter((r) => r.by_cashier).reduce((a, r) => a + Number(r.orders), 0);
  assert.equal(lk(await call('analytics_money_leaks', { p_branches: [S.W, S.K] })),
    lk(parse('W', 'analytics_money_leaks')) + lk(parse('K', 'analytics_money_leaks')), 'leaks orders');
});
await ok('credit ageing: the unaged part (no branch) is never counted for a set; V\'s customer never listed', async () => {
  const set = await call('analytics_credit_ageing', { p_branches: [S.W, S.K] });
  assert.ok(set.every((r) => Number(r.unaged) === 0), 'unaged 0 for a set');
  assert.ok(!set.some((r) => r.customer_id === VCUST));
  const all = await call('analytics_credit_ageing', { p_branch: null });
  assert.ok(all.some((r) => r.customer_id === VCUST), 'every branch lists Vera Credit');
  assert.ok(all.some((r) => Number(r.unaged) > 0), 'every branch keeps the unaged part (Old Account)');
});
await ok('a set of one other branch: [V] alone is V\'s; an empty list and NULL carry nothing (never every branch)', async () => {
  assert.deepEqual(norm(await call('analytics_daily_sales', { p_branches: [V] })), before.analytics_daily_sales.V);
  for (const fn of Object.keys(FNS)) {
    // nothing = what the original answers for a branch with no trade (cost watch still lists the business's ingredient
    // cost moves — they belong to no branch — as it does for any one branch)
    const nothing = norm((await call(fn, { p_branch: E })).map((r) => (fn === 'analytics_stock_use' ? { ...r, on_hand: null } : r)));
    for (const empty of [[], null]) assert.deepEqual(norm(await call(fn, { p_branches: empty })), nothing, `${fn} ${JSON.stringify(empty)}`);
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
