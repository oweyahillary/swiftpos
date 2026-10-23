/**
 * analytics-rules-a553.test.mjs — A553 (Analytics v2): the pure transforms, run directly.
 *   - the cloud (apps/server/src/lib/analyticsRules.ts, compiled): the previous period, the period-over-period change,
 *     the payment-method groups, the gross margin, buildOverview's edges;
 *   - the page (apps/dashboard/src/pages/analytics/chartMath.ts and chartPalette.ts, read as TypeScript by Node's type
 *     stripping): the KPI change badge (direction × whether up is good), the heatmap folds, the top items, the leak parts,
 *     and the palette mapping (fixed order, both modes, distinct series, the credit buckets green → red, the ramp).
 *
 *   cd apps/server && npm run build && cd ../.. && node tests/analytics-rules-a553.test.mjs
 *
 * MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted — listed in the A553 report):
 *   - deltaOf ignoring upIsGood (good = up)                      → "the change badge" fails
 *   - the payments palette reusing one colour for two methods    → "the palette" fails
 *   - pctChange dividing by `now`                                 → "pctChange" fails
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Node 24 strips TypeScript types by default; an older 22 needs the flag — run again with it once if the import fails.
if (!process.execArgv.includes('--experimental-strip-types') && Number(process.versions.node.split('.')[0]) < 23) {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url)], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = process.env.SERVER_DIST || path.join(ROOT, 'apps/server/dist');
if (!fs.existsSync(path.join(DIST, 'lib/analyticsRules.js'))) { console.log('\nBuild the server first:\n  cd apps/server && npm run build\n'); process.exit(1); }
const require = createRequire(import.meta.url);
const R = require(path.join(DIST, 'lib/analyticsRules.js'));
const M = await import(pathToFileURL(path.join(ROOT, 'apps/dashboard/src/pages/analytics/chartMath.ts')).href);
const P = await import(pathToFileURL(path.join(ROOT, 'apps/dashboard/src/pages/analytics/chartPalette.ts')).href);

let pass = 0, fail = 0;
const ok = (n, f) => { try { f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${String(e.message).split('\n').slice(0, 12).join('\n      ')}`); } };
console.log('\nA553 — Analytics v2 pure transforms\n');

// ── the cloud ──
ok('previousPeriod: the same number of days, ending the day before (across a month and a year end)', () => {
  assert.deepEqual(R.previousPeriod('2026-10-01', '2026-10-21'), { from: '2026-09-10', to: '2026-09-30' });
  assert.deepEqual(R.previousPeriod('2026-10-21', '2026-10-21'), { from: '2026-10-20', to: '2026-10-20' });
  assert.deepEqual(R.previousPeriod('2026-01-01', '2026-01-31'), { from: '2025-12-01', to: '2025-12-31' });
  assert.deepEqual(R.previousPeriod('2024-03-01', '2024-03-07'), { from: '2024-02-23', to: '2024-02-29' }, 'a leap day');
  assert.deepEqual(R.datesIn('2026-10-30', '2026-11-02'), ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
});
ok('pctChange: (now − prev) / prev; null with nothing before', () => {
  assert.equal(R.pctChange(150, 100), 0.5);
  assert.equal(R.pctChange(50, 100), -0.5);
  assert.equal(R.pctChange(100, 100), 0);
  assert.equal(R.pctChange(1, 3), -0.6667);
  assert.equal(R.pctChange(100, 0), null);
  assert.equal(R.pctChange(NaN, 1), null);
});
ok('methodGroup: cash · M-Pesa · card · on account · other (methods are free text)', () => {
  assert.equal(R.methodGroup('cash'), 'cash');
  assert.equal(R.methodGroup('MPESA'), 'mpesa');
  assert.equal(R.methodGroup('m-pesa'), 'mpesa');
  assert.equal(R.methodGroup('mpesa_till'), 'mpesa');
  assert.equal(R.methodGroup('card'), 'card');
  assert.equal(R.methodGroup('visa'), 'card');
  assert.equal(R.methodGroup('credit'), 'account');
  assert.equal(R.methodGroup('glovo'), 'other');
  assert.equal(R.methodGroup('room_charge'), 'other');
  assert.equal(R.methodGroup(null), 'other');
});
ok('grossMarginPct: the margin over the revenue of the costed items; null when costs are hidden or none has a cost', () => {
  const m = R.classifyMenu([
    { product_id: 'a', product_name: 'A', category_name: null, qty: 10, revenue: 1000, unit_cost: 40, cost_source: 'product' },
    { product_id: 'b', product_name: 'B', category_name: null, qty: 5, revenue: 500, unit_cost: null, cost_source: null },
  ]);
  assert.equal(R.grossMarginPct(m), 0.6, '600 on the 1,000 of A; B has no cost and is not in the base');
  assert.equal(R.grossMarginPct(R.menuWithoutCosts(m)), null);
  assert.equal(R.grossMarginPct(R.classifyMenu([])), null);
  assert.equal(R.grossMarginPct(null), null);
});
ok('buildOverview: no sales at all — the days are there at 0, nothing to compare, an empty mix', () => {
  const leaks = R.summariseLeaks([], {});
  const o = R.buildOverview({ from: '2026-10-01', to: '2026-10-07', daily: [], leaksNow: leaks, leaksPrev: leaks, menuNow: null, menuPrev: null, costs: true });
  assert.equal(o.days.length, 7);
  assert.deepEqual(o.days[0], { day: '2026-10-01', revenue: 0, orders: 0, avgBill: null, atRisk: 0, prevDay: '2026-09-24', prevRevenue: 0, prevOrders: 0 });
  assert.deepEqual(o.kpis.revenue, { value: 0, prev: 0, change: null });
  assert.deepEqual(o.kpis.avgBill, { value: null, prev: null, change: null });
  assert.deepEqual(o.kpis.margin, { value: null, prev: null, change: null });
  assert.deepEqual(o.paymentMix, []);
  const hidden = R.buildOverview({ from: '2026-10-01', to: '2026-10-07', daily: [], leaksNow: leaks, leaksPrev: leaks, menuNow: null, menuPrev: null, costs: false });
  assert.equal(hidden.kpis.margin, null);
  assert.equal(hidden.atRiskParts.wastage, null);
});
ok('moneyAtRisk: voids + kitchen voids + refunds + discounts + wastage (none when withheld)', () => {
  assert.equal(R.moneyAtRisk({ voidValue: 100, itemVoidValue: 20, refundValue: 30, discountValue: 5, wastageValue: 45 }), 200);
  assert.equal(R.moneyAtRisk({ voidValue: 100, itemVoidValue: 20, refundValue: 30, discountValue: 5, wastageValue: null }), 155);
});

// ── the page ──
ok('the change badge: ▲ / ▼ with the size; good or bad by whether up is good; flat under half a percent; none without', () => {
  assert.deepEqual(M.deltaOf(0.123, { upIsGood: true }), { direction: 'up', text: '▲ 12.3%', good: true });
  assert.deepEqual(M.deltaOf(-0.2, { upIsGood: true }), { direction: 'down', text: '▼ 20.0%', good: false });
  assert.deepEqual(M.deltaOf(0.2, { upIsGood: false }), { direction: 'up', text: '▲ 20.0%', good: false }, 'more money at risk is bad');
  assert.deepEqual(M.deltaOf(-0.2, { upIsGood: false }), { direction: 'down', text: '▼ 20.0%', good: true });
  assert.equal(M.deltaOf(0.004, { upIsGood: true }).direction, 'flat');
  assert.equal(M.deltaOf(null, { upIsGood: true }).direction, 'none');
  assert.equal(M.deltaOf(8.9976, { upIsGood: true }).text, '▲ 900%');
  assert.deepEqual(M.deltaOf(0.042, { upIsGood: true, points: true }), { direction: 'up', text: '▲ 4.2 pts', good: true });
});
ok('the heatmap folds: by hour inside the trading hours, by weekday Monday first', () => {
  const rev = Array.from({ length: 7 }, () => Array(24).fill(0)), ord = Array.from({ length: 7 }, () => Array(24).fill(0));
  rev[0][12] = 100; ord[0][12] = 2; rev[6][12] = 50; ord[6][12] = 1; rev[2][9] = 30; ord[2][9] = 1;
  const h = M.byHour(rev, ord, { from: 9, to: 12 });
  assert.deepEqual(h.map((x) => [x.label, x.revenue, x.orders]), [['09:00', 30, 1], ['10:00', 0, 0], ['11:00', 0, 0], ['12:00', 150, 3]]);
  assert.deepEqual(M.byHour(rev, ord, null), []);
  const w = M.byWeekday(rev, ord);
  assert.deepEqual(w.map((x) => [x.day, x.revenue]), [['Mon', 100], ['Tue', 0], ['Wed', 30], ['Thu', 0], ['Fri', 0], ['Sat', 0], ['Sun', 50]]);
});
ok('top items, leak parts, shares, compact ticks', () => {
  const rows = [{ name: 'b', r: 5 }, { name: 'a', r: 5 }, { name: 'c', r: 9 }, { name: 'z', r: 0 }];
  assert.deepEqual(M.topBy(rows, (x) => x.r, 2).map((x) => x.name), ['c', 'a'], 'biggest first, ties by name, nothing at 0');
  assert.deepEqual(M.leakParts({ voidValue: 10, itemVoidValue: 5, refundValue: 3, discountValue: 2, wastageValue: null }), { voids: 15, refunds: 3, discounts: 2, wastage: 0 });
  assert.deepEqual(M.shares([{ value: 3 }, { value: 1 }, { value: 0 }]).map((x) => x.share), [0.75, 0.25]);
  assert.deepEqual([M.compact(950), M.compact(1200), M.compact(34000), M.compact(1500000)], ['950', '1.2K', '34K', '1.5M']);
  assert.equal(M.dayLabel('2026-10-21'), '21 Oct');
});
ok('the palette: both modes, the fixed order, every series its own colour, buckets green → red, the ramp one way', () => {
  const L = P.chartPalette('light'), D = P.chartPalette('dark');
  assert.notEqual(L.surface, D.surface);
  for (const p of [L, D]) {
    const hex = /^#[0-9a-f]{6}$/;
    for (const group of [p.classes, p.leaks, p.payments, p.buckets]) {
      const v = Object.values(group);
      assert.ok(v.every((c) => hex.test(c)), JSON.stringify(group));
      assert.equal(new Set(v).size, v.length, `distinct within a group: ${JSON.stringify(group)}`);
    }
    assert.deepEqual(Object.values(p.payments), p.categorical, 'payments take slots 1–5 in order');
    assert.deepEqual(Object.values(p.leaks), p.categorical.slice(0, 4), 'leak types take slots 1–4 in order');
    assert.equal(p.accent, p.categorical[0]);
    assert.deepEqual(Object.values(p.buckets), ['#0ca30c', '#fab219', '#ec835a', '#d03b3b'], 'the status colours, good → critical');
    assert.equal(P.heatColour(p, 0, 100), null, 'no sales: no colour');
    assert.equal(P.heatColour(p, 100, 100), p.ramp.at(-1), 'the busiest: the far end');
    assert.notEqual(P.heatColour(p, 1, 100), p.ramp[0], 'a slow hour is still a step in');
  }
  // light runs pale → dark; dark from near the surface up to the light end (the lightness rises for "more")
  const lum = (h) => { const n = parseInt(h.slice(1), 16); return 0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255); };
  const mono = (r, down) => r.every((c, i) => i === 0 || (down ? lum(c) < lum(r[i - 1]) : lum(c) > lum(r[i - 1])));
  assert.ok(mono(L.ramp, true), 'light: darker = more');
  assert.ok(mono(D.ramp, false), 'dark: lighter = more');
  assert.deepEqual(Object.keys(P.CLASS_SHAPE).sort(), [...P.CLASS_ORDER].sort());
  assert.equal(new Set(Object.values(P.CLASS_SHAPE)).size, 5, 'each class its own marker shape (colour is never alone)');
  assert.equal(P.chartPalette('nonsense'), D, 'an unknown mode falls back to dark (the dashboard default)');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
