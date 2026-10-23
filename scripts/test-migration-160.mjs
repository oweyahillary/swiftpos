/**
 * test-migration-160.mjs — A553: analytics_daily_sales (Analytics v2), run for real against the WHOLE schema (every
 * migration before 160 replayed into PGlite), on the A549 trading scenario (scripts/lib/analytics-pg.mjs) plus a few
 * sales with payments and a previous period.
 *
 *   - 160 runs twice, recorded once; the function is the service role's only (not anon / authenticated).
 *   - per business day: completed orders only (a voided one never), the branch, the business; East Africa Time — 21:30Z
 *     on 30 September is 1 October; the owner's cut-off moves a 01:30 sale to the night before.
 *   - per day and method: completed payments only (a failed one never); dated by the order.
 *
 * MUTATIONS TO CONFIRM BITE (checked by hand, 2026-10-21):
 *   - without AT TIME ZONE 'Africa/Nairobi'           → "East Africa Time" fails
 *   - without o.status = 'completed'                   → "completed orders only" fails
 *   - without p.status = 'completed'                   → "payments by method" fails
 *   - without the cut-off (c.cut)                      → "the day cut-off" fails
 */
import fs from 'node:fs'; import path from 'node:path';
import assert from 'node:assert'; import { fileURLToPath } from 'node:url';
import { openSchema, seedAnalytics, migrationSql } from './lib/analytics-pg.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = async (n, fn) => { try { await fn(); pass++; console.log(`  ok   ${n}`); } catch (e) { fail++; console.log(`  FAIL ${n}\n         ${e.message}`); } };
console.log('\nMigration 160 (analytics daily sales) — PGlite, every migration\n');

const pg = await openSchema({ through: 159 });
const { q, rpc, put } = pg;
const one = async (s, p = []) => (await q(s, p))[0];
const S = await seedAnalytics(pg);
// A553's additions: sales with payments in the period, and a previous period (10–30 September)
const sale = async (o, pays = []) => {
  const row = await put('orders', { business_id: S.A, branch_id: S.W, order_number: `D-${Math.random().toString(36).slice(2, 8)}`, status: 'completed', subtotal: o.total, discount_amount: 0, cashier_id: S.CATE, ...o });
  for (const [method, amount, status = 'completed'] of pays) await put('payments', { order_id: row.id, business_id: row.business_id, branch_id: row.branch_id, method, amount, status });
  return row.id;
};
await sale({ total: 1000, created_at: '2026-10-12T08:00:00Z' }, [['cash', 400], ['mpesa', 600], ['card', 1000, 'failed']]);
await sale({ total: 300, created_at: '2026-10-13T08:00:00Z' }, [['credit', 300]]);
await sale({ total: 200, created_at: '2026-10-13T09:00:00Z' }, [['glovo', 200]]);
await sale({ total: 700, branch_id: S.K, created_at: '2026-10-13T08:00:00Z' }, [['card', 700]]);
await sale({ total: 999, status: 'voided', created_at: '2026-10-13T08:00:00Z' }, [['cash', 999]]);
await sale({ total: 777, created_at: '2026-09-30T21:30:00Z' });   // 00:30 EAT on 1 October
await sale({ total: 250, created_at: '2026-09-30T20:30:00Z' });   // 23:30 EAT on 30 September
await sale({ total: 1000, created_at: '2026-09-15T09:00:00Z' });
await put('orders', { business_id: S.B, branch_id: S.BB, order_number: 'B-1', status: 'completed', subtotal: 5000, total: 5000, discount_amount: 0, created_at: '2026-10-13T08:00:00Z' });

await ok('160 runs (and again — idempotent), recorded once; the function is the service role\'s only', async () => {
  const sql = migrationSql(160);
  await pg.db.exec(sql); await pg.db.exec(sql);
  assert.equal(Number((await one(`SELECT count(*) AS n FROM public.schema_migrations WHERE version = '160_analytics_daily'`)).n), 1);
  const sig = (await one(`SELECT p.oid::regprocedure::text AS sig FROM pg_proc p WHERE p.proname = 'analytics_daily_sales'`)).sig;
  assert.equal((await one(`SELECT has_function_privilege('anon', $1, 'EXECUTE') AS x`, [sig])).x, false, 'anon');
  assert.equal((await one(`SELECT has_function_privilege('authenticated', $1, 'EXECUTE') AS x`, [sig])).x, false, 'authenticated');
  assert.equal((await one(`SELECT has_function_privilege('service_role', $1, 'EXECUTE') AS x`, [sig])).x, true, 'service_role');
});
await ok('the function is declared pending (or in the functions index) and named as the cloud calls it', async () => {
  const pending = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/schema-pending.json'), 'utf8')).pending ?? {};
  const live = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/functions-index.json'), 'utf8'));
  assert.ok(pending['160_analytics_daily.sql'] || live.analytics_daily_sales, '160 declared pending until it is run and the index refreshed');
  assert.ok(fs.readFileSync(path.join(ROOT, 'apps/server/src/routes/analytics.ts'), 'utf8').includes(`'analytics_daily_sales'`));
});

// the previous period and this one, Westlands, the day ending at midnight
const PREV_START = '2026-09-09T21:00:00.000Z';
const daily = async (branch, cutoff = 0, business = S.A) => {
  const { data, error } = await rpc('analytics_daily_sales', { p_business: business, p_branch: branch, p_from: PREV_START, p_to: S.END, p_cutoff: cutoff });
  assert.equal(error, null, error?.message);
  return data;
};
const day = (rows, d) => rows.find((r) => r.day === d && r.method === null);

await ok('per business day: completed orders only (never the voided), the branch, the business', async () => {
  const w = await daily(S.W);
  assert.deepEqual([day(w, '2026-10-19').revenue, day(w, '2026-10-19').orders], [5350, 7], 'the seven Westlands menu sales — not the voided 9,999, not Kilimani');
  assert.deepEqual([day(w, '2026-10-13').revenue, day(w, '2026-10-13').orders], [500, 2], 'not the voided 999, not Kilimani\'s 700, not business B');
  assert.deepEqual([day(w, '2026-10-16').revenue, day(w, '2026-10-16').orders], [1900, 19]);
  assert.equal(day(w, '2026-09-15').revenue, 1000, 'the previous period is in the same answer');
  assert.equal(day(w, '2026-09-01'), undefined, 'before the asked range');
  const all = await daily(null);
  assert.deepEqual([day(all, '2026-10-13').revenue, day(all, '2026-10-13').orders], [1200, 3], 'every branch: Kilimani too');
  assert.equal((await daily(null, 0, S.B)).filter((r) => r.method === null).reduce((s, r) => s + r.revenue, 0), 5200, 'business B sees only its own (the seed\'s 200 and this 5,000)');
});
await ok('East Africa Time: 21:30Z on 30 September is 1 October; 20:30Z is still 30 September', async () => {
  const w = await daily(S.W);
  assert.equal(day(w, '2026-10-01').revenue, 777);
  assert.equal(day(w, '2026-09-30').revenue, 250);
});
await ok('the day cut-off: the 01:30 EAT sale (Tue 22:30Z) is Wednesday at midnight, Tuesday with the day ending 02:00', async () => {
  assert.equal(day(await daily(S.W, 0), '2026-10-21')?.revenue, 500);
  const at2 = await daily(S.W, 120);
  assert.equal(day(at2, '2026-10-21'), undefined);
  assert.equal(day(at2, '2026-10-20')?.revenue, 500);
  assert.equal(day(at2, '2026-09-30').revenue, 250 + 777, 'the 00:30 sale on 1 October goes back to 30 September too');
});
await ok('payments by method: completed only (the failed card never), dated by the order', async () => {
  const w = await daily(S.W);
  const m = (d) => Object.fromEntries(w.filter((r) => r.day === d && r.method !== null).map((r) => [r.method, r.revenue]));
  assert.deepEqual(m('2026-10-12'), { cash: 400, mpesa: 600 });
  assert.deepEqual(m('2026-10-13'), { credit: 300, glovo: 200 }, 'Kilimani\'s card and the voided order\'s cash are out');
  assert.deepEqual(m('2026-10-19'), {}, 'sales without payment rows give no method rows');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
