/**
 * test-migration-158.mjs — A549: the four Analytics v1 aggregate functions, run for real against the WHOLE schema (every
 * migration before 158 replayed into PGlite), on one seeded trading scenario (scripts/lib/analytics-pg.mjs).
 *
 *   - 158 runs twice, recorded once; the four functions are the service role's only (not anon / authenticated).
 *   - menu engineering: completed orders only, the period, the branch and the business; the cost of one serving is the
 *     cost price, else the recipe, else (a combo) its items; no cost = NULL.
 *   - the heatmap buckets in East Africa Time: 22:30Z on a Tuesday is Wednesday 01:00.
 *   - money leaks: per cashier and per day (GROUPING SETS), voids / kitchen voids / refunds (by refund date) / discounts /
 *     wastage (voided entries out) / drawer and day-close over-short; the day cut-off moves a 01:30 sale to the night before.
 *   - credit ageing: the ledger balance, repayments oldest first (FIFO), the buckets; a balance older than the ledger is
 *     90+; one branch = its own open debits only; disputed sales from credit_confirmations; another business never.
 *
 * MUTATIONS TO CONFIRM BITE (checked by hand, 2026-10-21):
 *   - the heatmap without AT TIME ZONE 'Africa/Nairobi'           → "the heatmap buckets in East Africa Time" fails
 *   - open_parts allocating OLDEST first (ORDER BY created_at ASC) → "credit ageing … FIFO" fails
 *   - menu engineering without o.status = 'completed'             → "menu engineering counts completed orders" fails
 *   - money leaks without the cut-off (c.cut)                     → "the day cut-off" fails
 */
import fs from 'node:fs'; import path from 'node:path';
import assert from 'node:assert'; import { fileURLToPath } from 'node:url';
import { openSchema, seedAnalytics, migrationSql } from './lib/analytics-pg.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = async (n, fn) => { try { await fn(); pass++; console.log(`  ok   ${n}`); } catch (e) { fail++; console.log(`  FAIL ${n}\n         ${e.message}`); } };
console.log('\nMigration 158 (analytics aggregates) — PGlite, every migration\n');

const pg = await openSchema({ through: 157 });
const { q, rpc } = pg;
const one = async (s, p = []) => (await q(s, p))[0];
const S = await seedAnalytics(pg).catch(async (e) => { throw e; });

await ok('158 runs (and again — idempotent), recorded once; the four functions are the service role\'s only', async () => {
  const sql = migrationSql(158);
  await pg.db.exec(sql); await pg.db.exec(sql);
  assert.equal(Number((await one(`SELECT count(*) AS n FROM public.schema_migrations WHERE version = '158_analytics'`)).n), 1);
  for (const fn of ['analytics_menu_engineering', 'analytics_sales_heatmap', 'analytics_money_leaks', 'analytics_credit_ageing']) {
    const oid = (await one(`SELECT p.oid::regprocedure::text AS sig FROM pg_proc p WHERE p.proname = $1`, [fn])).sig;
    assert.equal((await one(`SELECT has_function_privilege('anon', $1, 'EXECUTE') AS x`, [oid])).x, false, `${fn}: anon`);
    assert.equal((await one(`SELECT has_function_privilege('authenticated', $1, 'EXECUTE') AS x`, [oid])).x, false, `${fn}: authenticated`);
    assert.equal((await one(`SELECT has_function_privilege('service_role', $1, 'EXECUTE') AS x`, [oid])).x, true, `${fn}: service_role`);
  }
});
await ok('every function is in the migration and named as the cloud calls it (functions-index or schema-pending)', async () => {
  const pending = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/schema-pending.json'), 'utf8')).pending ?? {};
  const live = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/functions-index.json'), 'utf8'));
  assert.ok(pending['158_analytics.sql'] || live.analytics_menu_engineering, '158 declared pending until it is run and the index refreshed');
  const route = fs.readFileSync(path.join(ROOT, 'apps/server/src/routes/analytics.ts'), 'utf8');
  for (const fn of ['analytics_menu_engineering', 'analytics_sales_heatmap', 'analytics_money_leaks', 'analytics_credit_ageing']) assert.ok(route.includes(`'${fn}'`), fn);
});

const span = (branch) => ({ p_business: S.A, p_branch: branch, p_from: S.START, p_to: S.END });
const byName = (rows) => Object.fromEntries(rows.map((r) => [r.product_name, r]));

await ok('menu engineering counts completed orders of the period, branch and business; the serving cost: cost price, recipe, combo, none', async () => {
  const { data, error } = await rpc('analytics_menu_engineering', span(S.W));
  assert.equal(error, null, error?.message);
  const m = byName(data);
  assert.deepEqual(Object.keys(m).sort(), ['Burger', 'Chicken wings', 'Chips', 'Family combo', 'Salad', 'Soda', 'Tea']);
  assert.deepEqual([m.Burger.qty, m.Burger.revenue, m.Burger.unit_cost, m.Burger.cost_source], [8, 1600, 100, 'product'], 'not the voided 50, not Kilimani, not September');
  assert.deepEqual([m['Chicken wings'].qty, m['Chicken wings'].unit_cost, m['Chicken wings'].cost_source], [20, 40, 'recipe']);
  assert.deepEqual([m['Family combo'].unit_cost, m['Family combo'].cost_source], [180, 'combo'], '100 + 2 × 40');
  assert.deepEqual([m.Soda.unit_cost, m.Soda.cost_source], [null, null]);
  const all = byName((await rpc('analytics_menu_engineering', span(null))).data);
  assert.equal(all.Burger.qty, 9, 'every branch: Kilimani\'s burger too — never business B\'s');
});
await ok('the heatmap buckets in East Africa Time: Tue 22:30Z is Wednesday 01:00; Mon 12:00Z is Monday 15:00', async () => {
  const { data } = await rpc('analytics_sales_heatmap', span(null));
  const cell = (d, h) => data.find((r) => r.dow === d && r.hour === h);
  assert.deepEqual([cell(3, 1)?.revenue, cell(3, 1)?.orders], [500, 1], 'Wednesday 01:00');
  assert.equal(cell(2, 22), undefined, 'nothing at Tuesday 22:00 (UTC)');
  assert.deepEqual([cell(1, 15)?.orders, cell(1, 15)?.revenue], [8, 5550], 'Monday 15:00: seven Westlands sales + Kilimani, never the voided one');
});
await ok('money leaks per cashier: voids, kitchen voids, refunds by refund date, discounts, wastage (not voided), drawer', async () => {
  const { data, error } = await rpc('analytics_money_leaks', { ...span(S.W), p_cutoff: 0 });
  assert.equal(error, null, error?.message);
  const c = (id) => data.find((r) => r.by_cashier && r.cashier_id === id);
  assert.deepEqual([c(S.VIC).orders, c(S.VIC).voids, c(S.VIC).void_value], [12, 6, 10499]);
  assert.deepEqual([c(S.DAN).orders, c(S.DAN).item_voids, c(S.DAN).item_void_value, c(S.DAN).drawer_variance], [5, 1, 200, -300]);
  assert.deepEqual([c(S.CATE).discounts, c(S.CATE).discount_value, c(S.CATE).refunds, c(S.CATE).refund_value], [1, 100, 1, 250]);
  assert.deepEqual([c(S.MGR).wastage, c(S.MGR).wastage_value], [1, 200], 'the voided wastage entry is out');
  const day = (d) => data.find((r) => !r.by_cashier && r.day === d);
  assert.equal(day('2026-10-18').refunds, 1, 'the refund counts on the day it was given');
  assert.equal(day('2026-10-17').day_close_variance, -450, 'Westlands\' day close only (Kilimani +50 is another branch)');
});
await ok('the day cut-off: a sale at 01:30 EAT is the night before with the day ending 02:00', async () => {
  const at0 = (await rpc('analytics_money_leaks', { ...span(S.W), p_cutoff: 0 })).data;
  const at2 = (await rpc('analytics_money_leaks', { ...span(S.W), p_cutoff: 120 })).data;
  assert.equal(at0.find((r) => !r.by_cashier && r.day === '2026-10-21')?.orders, 1);
  assert.equal(at2.find((r) => !r.by_cashier && r.day === '2026-10-21'), undefined);
  assert.equal(at2.find((r) => !r.by_cashier && r.day === '2026-10-20')?.orders, 1);
});
await ok('credit ageing: the ledger balance, repayments oldest first (FIFO); older than the ledger = 90+; disputed; never business B', async () => {
  const { data, error } = await rpc('analytics_credit_ageing', { p_business: S.A, p_branch: null, p_as_of: S.AS_OF });
  assert.equal(error, null, error?.message);
  const c = Object.fromEntries(data.map((r) => [r.customer_name, r]));
  assert.deepEqual(Object.keys(c).sort(), ['Acme Ltd', 'Old Account', 'Paid Up']);
  assert.deepEqual([c['Acme Ltd'].owed, c['Acme Ltd'].d0_30, c['Acme Ltd'].d31_60, c['Acme Ltd'].d61_90, c['Acme Ltd'].d90_plus], [700, 300, 300, 0, 100]);
  assert.deepEqual([c['Old Account'].owed, c['Old Account'].d0_30, c['Old Account'].d90_plus, c['Old Account'].unaged], [1000, 600, 400, 400]);
  assert.deepEqual([c['Paid Up'].owed, c['Paid Up'].disputed_count, c['Paid Up'].disputed_amount], [0, 1, 350]);
  assert.equal(c['Acme Ltd'].disputed_count, 0, 'an awaiting sale is not disputed');
});
await ok('credit ageing for one branch: only the open parts of that branch\'s debits (the unaged rest has no branch)', async () => {
  const w = Object.fromEntries((await rpc('analytics_credit_ageing', { p_business: S.A, p_branch: S.W, p_as_of: S.AS_OF })).data.map((r) => [r.customer_name, r]));
  assert.deepEqual([w['Acme Ltd'].owed, w['Acme Ltd'].d0_30, w['Acme Ltd'].d31_60, w['Acme Ltd'].d90_plus], [400, 0, 300, 100]);
  assert.deepEqual([w['Old Account'].owed, w['Old Account'].d90_plus], [600, 0]);
  const k = Object.fromEntries((await rpc('analytics_credit_ageing', { p_business: S.A, p_branch: S.K, p_as_of: S.AS_OF })).data.map((r) => [r.customer_name, r]));
  assert.deepEqual(Object.keys(k), ['Acme Ltd']);
  assert.equal(k['Acme Ltd'].d0_30, 300);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
