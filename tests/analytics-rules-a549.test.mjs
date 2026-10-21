/**
 * analytics-rules-a549.test.mjs — A549: the pure rules of Analytics v1 (apps/server/src/lib/analyticsRules.ts), run
 * directly from the COMPILED server: the menu-engineering matrix at its edges, the heatmap slots, the money-leak flag,
 * credit totals, the period, and every insight rule (its sentence, type and severity, and the order they come in).
 *
 *   cd apps/server && npm run build && cd ../.. && node tests/analytics-rules-a549.test.mjs
 *
 * MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted — listed in the A549 report):
 *   - classifyMenu's popularity at 1/N (POPULARITY_FACTOR 1)      → "popular at exactly 70% of an even share" fails
 *   - the average margin unweighted (a plain mean of unit margins)  → "the margin line is quantity-weighted" fails
 *   - leakFlag without the FLAG_MIN_EVENTS check                    → "fewer than 5 events is never flagged" fails
 *   - buildInsights without the severity sort                       → "insights come high → medium → low" fails
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = process.env.SERVER_DIST || path.join(ROOT, 'apps/server/dist');
if (!fs.existsSync(path.join(DIST, 'lib/analyticsRules.js'))) { console.log('\nBuild the server first:\n  cd apps/server && npm run build\n'); process.exit(1); }
const require = createRequire(import.meta.url);
const R = require(path.join(DIST, 'lib/analyticsRules.js'));
let pass = 0, fail = 0;
const ok = (n, f) => { try { f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.stack?.split('\n').slice(0, 3).join('\n      ') ?? e.message}`); } };
const row = (name, qty, revenue, unit_cost) => ({ product_id: name, product_name: name, category_name: null, qty, revenue, unit_cost, cost_source: unit_cost === null ? null : 'product' });
const cls = (m) => Object.fromEntries(m.items.map((i) => [i.name, i.class]));
console.log('\nA549 — Analytics v1 rules\n');

ok('popular at exactly 70% of an even share (1/N × 0.7), not below', () => {
  // 4 items, 100 sold: an even share is 25; 70% of it is 17.5 → 17.5 is popular, 17.4 is not
  const m = R.classifyMenu([row('A', 17.5, 1750, 50), row('B', 17.4, 1740, 50), row('C', 40, 4000, 50), row('D', 25.1, 2510, 50)]);
  assert.equal(m.popularityThreshold, 0.175);
  assert.deepEqual(m.items.filter((i) => i.popular).map((i) => i.name).sort(), ['A', 'C', 'D']);
});
ok('the margin line is quantity-weighted; a margin equal to it is high', () => {
  // X: 90 sold at margin 10; Y: 10 sold at margin 110 → weighted 20 (a plain mean would be 60)
  const m = R.classifyMenu([row('X', 90, 90 * 30, 20), row('Y', 10, 10 * 130, 20), row('Z', 50, 50 * 40, 20)]);
  assert.equal(m.avgUnitMargin, 20, '(90×10 + 10×110 + 50×20) / 150');
  assert.deepEqual(cls(m), { X: 'plowhorse', Y: 'puzzle', Z: 'star' }, 'Z at exactly the average is high');
});
ok('the four classes and "no cost set" (not classified, but counted in N and the shares)', () => {
  const m = R.classifyMenu([row('Star', 50, 5000, 20), row('Plow', 50, 2500, 40), row('Puz', 2, 400, 50), row('Dog', 2, 100, 45), row('Free', 40, 400, null), row('Zero', 0, 0, 1)]);
  assert.deepEqual(cls(m), { Star: 'star', Plow: 'plowhorse', Free: 'no_cost', Puz: 'puzzle', Dog: 'dog' });
  assert.equal(m.totals.items, 5, 'nothing sold is not an item');
  assert.deepEqual(m.counts, { star: 1, plowhorse: 1, puzzle: 1, dog: 1, no_cost: 1 });
  assert.equal(m.items.find((i) => i.name === 'Free').unitMargin, null);
});
ok('no cost anywhere: no margin line, every item "no cost set"; menuWithoutCosts drops costs, margins and classes', () => {
  const m = R.classifyMenu([row('A', 3, 300, null), row('B', 1, 100, null)]);
  assert.equal(m.avgUnitMargin, null);
  assert.deepEqual(Object.values(cls(m)), ['no_cost', 'no_cost']);
  const h = R.menuWithoutCosts(R.classifyMenu([row('A', 3, 300, 10)]));
  assert.deepEqual([h.costsHidden, h.items[0].unitCost, h.items[0].unitMargin, h.items[0].class, h.totals.margin], [true, null, null, null, null]);
});

ok('the heatmap: ISO weekday rows (Monday first); 2-hour slots inside the trading hours; a closed day is never the quietest', () => {
  const h = R.summariseHeatmap([
    { dow: 1, hour: 12, revenue: 1000, orders: 10 }, { dow: 1, hour: 13, revenue: 800, orders: 8 }, { dow: 1, hour: 14, revenue: 100, orders: 1 },
    { dow: 2, hour: 12, revenue: 300, orders: 3 }, { dow: 2, hour: 14, revenue: 50, orders: 1 },
    { dow: 7, hour: 13, revenue: 20, orders: 1 },
  ]);
  assert.equal(h.revenue[0][12], 1000);
  assert.equal(h.revenue[6][13], 20, 'Sunday is the last row');
  assert.deepEqual(h.tradingHours, { from: 12, to: 14 });
  assert.deepEqual([h.busiest.label, h.busiest.revenue], ['Monday 12:00–14:00', 1800]);
  assert.deepEqual([h.quietest.label, h.quietest.revenue], ['Sunday 12:00–14:00', 20], 'Wednesday–Saturday did not trade');
  assert.equal(R.summariseHeatmap([]).busiest, null);
  assert.equal(R.summariseHeatmap([{ dow: 3, hour: 9, revenue: 5, orders: 1 }]).busiest.label, 'Wednesday 09:00–10:00', 'one trading hour: 1-hour slots');
});

ok('median: odd, even, none', () => {
  assert.equal(R.median([3, 1, 2]), 2);
  assert.equal(R.median([4, 1, 2, 3]), 2.5);
  assert.equal(R.median([]), null);
});
ok('fewer than 5 events is never flagged; 2× the median is (not 1.9×); a median of 0 flags any rate with 5 events', () => {
  assert.equal(R.leakFlag('void', 0.5, 4, 0.1), null);
  assert.deepEqual(R.leakFlag('void', 0.2, 5, 0.1), { kind: 'void', rate: 0.2, median: 0.1, multiple: 2, events: 5 });
  assert.equal(R.leakFlag('void', 0.19, 9, 0.1), null);
  assert.deepEqual(R.leakFlag('discount', 0.3, 6, 0), { kind: 'discount', rate: 0.3, median: 0, multiple: null, events: 6 });
  assert.equal(R.leakFlag('void', 0, 0, 0), null, 'nothing is not a leak');
  assert.equal(R.leakFlag('void', 0.5, 9, null), null);
});
ok('summariseLeaks: rates over the cashier\'s own orders, medians over named cashiers only, flagged first, totals from the days', () => {
  const z = { void_value: 0, item_voids: 0, item_void_value: 0, refunds: 0, refund_value: 0, discounts: 0, discount_value: 0, wastage: 0, wastage_value: 0, drawer_variance: 0, day_close_variance: 0 };
  const L = R.summariseLeaks([
    { ...z, by_cashier: true, cashier_id: 'a', day: null, orders: 20, voids: 1 },
    { ...z, by_cashier: true, cashier_id: 'b', day: null, orders: 20, voids: 2 },
    { ...z, by_cashier: true, cashier_id: 'c', day: null, orders: 20, voids: 6, item_voids: 2 },
    { ...z, by_cashier: true, cashier_id: null, day: null, orders: 50, voids: 40 },
    { ...z, by_cashier: false, cashier_id: null, day: '2026-10-02', orders: 60, voids: 9, day_close_variance: -100 },
    { ...z, by_cashier: false, cashier_id: null, day: '2026-10-01', orders: 50, voids: 40, day_close_variance: 30 },
  ], { a: 'Ann', b: 'Ben', c: 'Cy' });
  assert.equal(L.medians.voidRate, 0.1, 'the unattributed bucket is not a cashier');
  assert.equal(L.cashiers[0].name, 'Cy');
  assert.deepEqual(L.cashiers[0].flags.map((f) => [f.kind, f.multiple, f.events]), [['void', 4, 8]]);
  assert.equal(L.cashiers.find((c) => c.cashierId === null).name, 'Not attributed');
  assert.deepEqual(L.days.map((d) => d.day), ['2026-10-01', '2026-10-02']);
  assert.deepEqual([L.totals.dayCloseShort, L.totals.dayCloseOver, L.totals.voids], [-100, 30, 49]);
  const H = R.leaksWithoutWastageValue(L);
  assert.deepEqual([H.wastageHidden, H.totals.wastageValue, H.cashiers[0].wastageValue], [true, null, null]);
});

ok('credit totals: buckets, over 60 days (61–90 + 90+), disputed; the oldest debt first', () => {
  const c = R.summariseCredit([
    { customer_id: '1', customer_name: 'New', phone: null, balance: 100, owed: 100, d0_30: 100, d31_60: 0, d61_90: 0, d90_plus: 0, unaged: 0, oldest_at: null, disputed_count: 0, disputed_amount: 0 },
    { customer_id: '2', customer_name: 'Old', phone: null, balance: 900, owed: 900, d0_30: 0, d31_60: 100, d61_90: 300, d90_plus: 500, unaged: 0, oldest_at: null, disputed_count: 2, disputed_amount: 80 },
  ]);
  assert.deepEqual(c.over60, { amount: 800, customers: 1 });
  assert.deepEqual([c.totals.owed, c.totals.d61_90, c.totals.disputedCount, c.customers[0].name], [1000, 300, 2, 'Old']);
});

ok('the period: real dates, from ≤ to, at most 366 days; the default is the last 30 days', () => {
  assert.equal(R.rangeError('2026-01-01', '2026-12-31'), null, '365');
  assert.equal(R.rangeError('2024-01-01', '2024-12-31'), null, '366 (leap year)');
  assert.equal(R.rangeError('2025-12-30', '2026-12-31').code, 'RANGE_TOO_LONG', '367 days');
  assert.equal(R.rangeError('2026-02-29', '2026-03-01').code, 'BAD_RANGE');
  assert.equal(R.rangeError('2026-03-02', '2026-03-01').code, 'BAD_RANGE');
  assert.equal(R.rangeError('yesterday', '2026-03-01').code, 'BAD_RANGE');
  assert.deepEqual(R.defaultRange('2026-10-21'), { from: '2026-09-22', to: '2026-10-21' });
});

// ── insights ──
const menu = R.classifyMenu([row('Chicken wings', 100, 100 * 100, 80), row('Burger', 60, 60 * 200, 100), row('Rice', 50, 50 * 60, 10),
  row('Steak', 5, 5 * 900, 400), row('Salad', 3, 3 * 50, 45), row('Juice', 2, 200, null)]);
const heat = R.summariseHeatmap([{ dow: 1, hour: 12, revenue: 5000, orders: 20 }, { dow: 1, hour: 13, revenue: 4000, orders: 15 },
  { dow: 2, hour: 12, revenue: 300, orders: 2 }, { dow: 2, hour: 13, revenue: 100, orders: 1 }]);
const z = { void_value: 0, item_voids: 0, item_void_value: 0, refunds: 0, refund_value: 0, discounts: 0, discount_value: 0, wastage: 0, wastage_value: 0, drawer_variance: 0, day_close_variance: 0 };
const leaks = R.summariseLeaks([
  { ...z, by_cashier: true, cashier_id: 'x', day: null, orders: 100, voids: 31 },
  { ...z, by_cashier: true, cashier_id: 'y', day: null, orders: 100, voids: 10, discounts: 2 },
  { ...z, by_cashier: true, cashier_id: 'w', day: null, orders: 100, voids: 5, discounts: 1 },
  { ...z, by_cashier: false, cashier_id: null, day: '2026-10-01', orders: 300, voids: 46, wastage: 2, wastage_value: 900, day_close_variance: -1200 },
], { x: 'X', y: 'Y', w: 'W' });
const credit = R.summariseCredit([
  { customer_id: '1', customer_name: 'A', phone: null, balance: 30000, owed: 30000, d0_30: 0, d31_60: 0, d61_90: 10000, d90_plus: 20000, unaged: 0, oldest_at: null, disputed_count: 1, disputed_amount: 500 },
  { customer_id: '2', customer_name: 'B', phone: null, balance: 12000, owed: 12000, d0_30: 0, d31_60: 0, d61_90: 0, d90_plus: 12000, unaged: 0, oldest_at: null, disputed_count: 0, disputed_amount: 0 },
]);
const ins = R.buildInsights({ menu, heatmap: heat, leaks, credit });
const text = (id) => ins.find((i) => i.id === id)?.text;

ok('the Plowhorse sentence: a top 3 seller below the average margin, by how much', () => {
  // avg margin = (100×20 + 60×100 + 50×50 + 5×500 + 3×5) / 218 = 59.70; wings 20 → 39.70 below (KES 40)
  assert.equal(menu.avgUnitMargin, 59.7);
  assert.equal(text('menu.plowhorse.Chicken wings'), 'Chicken wings is a Plowhorse: top 3 seller but margin KES 40 below average – consider a small price rise');
  assert.equal(ins.find((i) => i.id === 'menu.plowhorse.Chicken wings').severity, 'medium');
});
ok('Puzzle, Dogs and no cost set', () => {
  assert.match(text('menu.puzzle.Steak'), /^Steak is a Puzzle: margin KES 440 above average but only 5 sold/);
  assert.match(text('menu.dogs'), /^1 item is a Dog \(low sales and low margin\) – consider reworking or dropping Salad$/);
  assert.match(text('menu.no_cost'), /^1 item sold has no cost set \(Juice\)/);
});
ok('the quietest and busiest slots', () => {
  assert.equal(text('timing.quietest'), 'Tuesday 12:00–14:00 is your quietest slot');
  assert.equal(text('timing.busiest'), 'Monday 12:00–14:00 is your busiest slot (KES 9,000 in the period)');
});
ok('a cashier flagged: "voided 3.1× the branch median"; a discount flag needs its own 5 events', () => {
  assert.equal(text('leaks.void.x'), 'Cashier X voided 3.1× the branch median this period (31 voids)');
  assert.equal(ins.find((i) => i.id === 'leaks.void.x').severity, 'high');
  assert.equal(ins.find((i) => i.id.startsWith('leaks.discount')), undefined);
});
ok('day closes short, and wastage as a share of sales', () => {
  assert.equal(text('leaks.day_close_short'), 'Day closes came up KES 1,200 short in total this period');
  assert.equal(text('leaks.wastage'), 'Wastage cost KES 900 this period (9.6% of sales)');
});
ok('credit: "KES 42,000 is over 60 days old on credit (2 customers)"; disputed sales', () => {
  assert.equal(text('credit.over60'), 'KES 42,000 is over 60 days old on credit (2 customers)');
  assert.equal(text('credit.disputed'), '1 disputed credit sale (KES 500) still needs resolving – void or refund what was wrong');
});
ok('insights come high → medium → low (leaks, credit, menu, timing within each), every one typed', () => {
  const order = ins.map((i) => ['high', 'medium', 'low'].indexOf(i.severity));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.deepEqual(ins.slice(0, 2).map((i) => i.id), ['leaks.void.x', 'credit.over60']);
  assert.ok(ins.length <= R.MAX_INSIGHTS);
});
ok('nothing to say: no sales, no leaks, no credit — no insights; costs hidden — no margin sentence', () => {
  assert.deepEqual(R.buildInsights({ menu: R.classifyMenu([]), heatmap: R.summariseHeatmap([]), leaks: R.summariseLeaks([], {}), credit: R.summariseCredit([]) }), []);
  const hidden = R.buildInsights({ menu: R.menuWithoutCosts(menu), heatmap: heat, leaks: R.leaksWithoutWastageValue(leaks), credit: null });
  assert.ok(!hidden.some((i) => i.type === 'menu' || i.id === 'leaks.wastage' || i.type === 'credit'));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
