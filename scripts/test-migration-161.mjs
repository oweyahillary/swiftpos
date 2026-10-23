/**
 * test-migration-161.mjs — A558: analytics_item_times ("what sells when"), run for real against the WHOLE schema (every
 * migration before 161 replayed into PGlite), on the A549 trading scenario (scripts/lib/analytics-pg.mjs) plus a few
 * order lines placed on the edges that matter.
 *
 *   - 161 runs twice, recorded once; the function is the service role's only (not anon / authenticated).
 *   - per product: completed orders only (the voided 50 burgers never), the branch, the business; a line with no
 *     product is kept under its own name; the best sellers first, at most `limit`, plus ONE total row of everything.
 *   - the cells: East Africa Time (07:59Z is 10:59, 08:00Z is 11:00); the weekday of the BUSINESS day — with the day
 *     ending 02:00, a Saturday 01:30 sale is Friday's.
 *
 * MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted — listed in the A558 report):
 *   - without AT TIME ZONE 'Africa/Nairobi' on the hour        → "East Africa Time" fails
 *   - the weekday without the cut-off (c.cut)                  → "the business weekday" fails
 *   - without o.status = 'completed'                           → "completed orders only" fails
 *   - the total row over the limited products only            → "the total row" fails
 */
import fs from 'node:fs'; import path from 'node:path';
import assert from 'node:assert'; import { fileURLToPath } from 'node:url';
import { openSchema, seedAnalytics, migrationSql } from './lib/analytics-pg.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = async (n, fn) => { try { await fn(); pass++; console.log(`  ok   ${n}`); } catch (e) { fail++; console.log(`  FAIL ${n}\n         ${e.message}`); } };
console.log('\nMigration 161 (analytics item times) — PGlite, every migration\n');

const pg = await openSchema({ through: 160 });
const { q, rpc, put } = pg;
const one = async (s, p = []) => (await q(s, p))[0];
const S = await seedAnalytics(pg);
const PILAU = (await put('products', { business_id: S.A, name: 'Pilau', base_price: 100, cost_price: 40 })).id;
const TUSKER = (await put('products', { business_id: S.A, name: 'Tusker', base_price: 300, cost_price: 190 })).id;
const sale = async (o, items) => {
  const row = await put('orders', { business_id: S.A, branch_id: S.W, order_number: `T-${Math.random().toString(36).slice(2, 8)}`, status: 'completed', subtotal: o.total ?? 0, discount_amount: 0, cashier_id: S.CATE, ...o });
  for (const [pid, name, qty, sub] of items) await put('order_items', { order_id: row.id, product_id: pid, product_name: name, quantity: qty, unit_price: sub / qty, subtotal: sub });
};
await sale({ total: 300, created_at: '2026-10-13T07:59:00Z' }, [[PILAU, 'Pilau', 3, 300]]);           // Tue 10:59 EAT — morning
await sale({ total: 400, created_at: '2026-10-13T08:00:00Z' }, [[PILAU, 'Pilau', 4, 400]]);           // Tue 11:00 EAT — lunch
await sale({ total: 1800, created_at: '2026-10-16T22:30:00Z' }, [[TUSKER, 'Tusker', 6, 1800]]);       // Sat 01:30 EAT — Friday's night with a 02:00 cut-off
await sale({ total: 900, status: 'voided', created_at: '2026-10-13T08:00:00Z' }, [[PILAU, 'Pilau', 9, 900]]);
await sale({ total: 200, created_at: '2026-10-13T09:00:00Z' }, [[null, 'Open food', 2, 200]]);        // a line with no product
await sale({ total: 500, branch_id: S.K, created_at: '2026-10-13T08:00:00Z' }, [[PILAU, 'Pilau', 5, 500]]);

await ok('161 runs (and again — idempotent), recorded once; the function is the service role\'s only', async () => {
  const sql = migrationSql(161);
  await pg.db.exec(sql); await pg.db.exec(sql);
  assert.equal(Number((await one(`SELECT count(*) AS n FROM public.schema_migrations WHERE version = '161_analytics_item_times'`)).n), 1);
  const sig = (await one(`SELECT p.oid::regprocedure::text AS sig FROM pg_proc p WHERE p.proname = 'analytics_item_times'`)).sig;
  assert.equal((await one(`SELECT has_function_privilege('anon', $1, 'EXECUTE') AS x`, [sig])).x, false, 'anon');
  assert.equal((await one(`SELECT has_function_privilege('authenticated', $1, 'EXECUTE') AS x`, [sig])).x, false, 'authenticated');
  assert.equal((await one(`SELECT has_function_privilege('service_role', $1, 'EXECUTE') AS x`, [sig])).x, true, 'service_role');
  assert.equal((await one(`SELECT provolatile AS v FROM pg_proc WHERE proname = 'analytics_item_times'`)).v, 's', 'STABLE');
});
await ok('the function is declared pending (or in the functions index) and named as the cloud calls it', async () => {
  const pending = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/schema-pending.json'), 'utf8')).pending ?? {};
  const live = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/functions-index.json'), 'utf8'));
  assert.ok(pending['161_analytics_item_times.sql'] || live.analytics_item_times, '161 declared pending until it is run and the index refreshed');
  assert.ok(fs.readFileSync(path.join(ROOT, 'apps/server/src/routes/analytics.ts'), 'utf8').includes(`'analytics_item_times'`));
});

const times = async (branch, cutoff = 0, limit = 100, business = S.A) => {
  const { data, error } = await rpc('analytics_item_times', { p_business: business, p_branch: branch, p_from: S.START, p_to: S.END, p_cutoff: cutoff, p_limit: limit });
  assert.equal(error, null, error?.message);
  return data;
};
const named = (rows, n) => rows.find((r) => !r.is_total && r.product_name === n);
const cell = (r, dow, hour) => (r?.cells ?? []).find((c) => c[0] === dow && c[1] === hour);

await ok('completed orders only (never the voided), the branch, the business; a line with no product keeps its name', async () => {
  const w = await times(S.W);
  assert.equal(Number(named(w, 'Pilau').qty), 7, '3 + 4 — not the voided 9, not Kilimani\'s 5');
  assert.equal(Number(named(w, 'Burger').qty), 8, 'not the voided 50, not Kilimani\'s 1, not business B, not September');
  assert.equal(Number(named(w, 'Open food').qty), 2);
  assert.equal(named(w, 'Open food').product_id, null);
  const all = await times(null);
  assert.equal(Number(named(all, 'Pilau').qty), 12, 'every branch: Kilimani too');
  const b = await times(null, 0, 100, S.B);
  assert.deepEqual(b.filter((r) => !r.is_total).map((r) => [r.product_name, Number(r.qty)]), [['Burger', 1]]);
});
await ok('East Africa Time: 07:59Z is Tuesday 10:59, 08:00Z is Tuesday 11:00; the menu sales are Monday 15:00', async () => {
  const w = await times(S.W);
  const p = named(w, 'Pilau');
  assert.deepEqual(cell(p, 2, 10).slice(2).map(Number), [3, 300]);
  assert.deepEqual(cell(p, 2, 11).slice(2).map(Number), [4, 400]);
  assert.equal(p.cells.length, 2);
  assert.deepEqual(cell(named(w, 'Chicken wings'), 1, 15).slice(2).map(Number), [20, 2000]);
});
await ok('the business weekday: a Saturday 01:30 sale is Saturday at midnight, Friday with the day ending 02:00 (the hour stays 01)', async () => {
  assert.ok(cell(named(await times(S.W, 0), 'Tusker'), 6, 1));
  const at2 = named(await times(S.W, 120), 'Tusker');
  assert.deepEqual(cell(at2, 5, 1).slice(2).map(Number), [6, 1800]);
  assert.equal(cell(at2, 6, 1), undefined);
});
await ok('the best sellers first, at most `limit`; the total row counts every product (the shares\' denominator)', async () => {
  const w = await times(S.W, 0, 2);
  const prods = w.filter((r) => !r.is_total);
  assert.deepEqual(prods.map((r) => r.product_name), ['Chicken wings', 'Burger'], 'by quantity: 20, 8');
  const tot = w.filter((r) => r.is_total);
  assert.equal(tot.length, 1);
  assert.equal(Number(tot[0].qty), 20 + 8 + 2 + 2 + 5 + 3 + 1 + 7 + 6 + 2, 'every product line in the period');
  assert.deepEqual(cell(tot[0], 1, 15).slice(2).map(Number), [41, 5350], 'Monday 15:00: the seven menu sales');
  assert.equal((await times(S.W, 0, 100)).filter((r) => !r.is_total).length, 10);
  const none = await rpc('analytics_item_times', { p_business: S.A, p_branch: S.W, p_from: '2020-01-01T00:00:00Z', p_to: '2020-01-02T00:00:00Z', p_cutoff: 0, p_limit: 100 });
  assert.deepEqual(none.data, [], 'no sale: no rows at all (no empty total)');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
