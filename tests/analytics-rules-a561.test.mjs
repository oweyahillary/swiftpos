/**
 * analytics-rules-a561.test.mjs — A561: Analytics adds how fast stock goes, who comes back, what each sale really earns and
 * the items with no cost. Every new rule of apps/server/src/lib/analyticsRules.ts (compiled), run directly:
 *   - stock use: use a day, days left (one branch only), the wastage share, the change, the two top-10 lists;
 *   - "runs out in about 2 days — order now": under 3 days, used ≥ 5, a week of data, a week's worth to order; never the
 *     item A560's running-low card already names; ranked with the stock-out risks;
 *   - "You throw away 20% of …": 15% and 5 units at least;
 *   - customers: new and returning, the coverage note under 20%, regulars (≥ 4 visits in 90 days, about every two weeks),
 *     gone quiet (twice the gap and two weeks), the order-type mix by day or by week, the average bill;
 *   - costs: food cost and its movers, the thinnest margins, cost rises and what they cost a month, the items with no cost
 *     (10 and how many more), the food-cost, thin-margin and cost-rise cards and their thresholds;
 *   - the tiles' hooks; every table capped at 10; no generated text that says price, raise or re-price;
 *   - the page (chartMath.ts / chartPalette.ts, read as TypeScript): which tiles show, ?tab=, the arrow keys, days left in
 *     words, the order-type colours (categorical slots 1–4 in their fixed order).
 *
 *   cd apps/server && npm run build && cd ../.. && node tests/analytics-rules-a561.test.mjs
 *
 * MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted — listed in the A561 report):
 *   - recRunOut without the STOCK_OUT_MIN_USED floor                    → "run out" fails
 *   - summariseStockUse keeping a negative on-hand level                → "stock use" fails
 *   - lapsed without the two-week minimum                               → "regulars gone quiet" fails
 *   - recThinMargin without the 10-sold floor                           → "thin margin" fails
 *   - summariseStockUse not capping runOut at 10                        → "the 10-row caps" fails
 *   - recThinMargin saying "raise the price"                            → "no price wording" fails
 *   - buildRecommendations without the run-out / running-low de-dupe    → "run out" fails
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
const ok = (n, f) => { try { f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${String(e.stack ?? e.message).split('\n').slice(0, 6).join('\n      ')}`); } };
console.log('\nA561 — stock use, customers, costs, items without a cost\n');

const srow = (name, sold, wasted, onHand, extra = {}) => ({ kind: 'product', item_id: `id-${name}`, item_name: name, unit: null, by_piece: false, sold, wasted, prev_sold: 0, prev_wasted: 0, on_hand: onHand, ...extra });
const base = (extra) => ({ days: 30, costs: true, menu: null, heatmap: null, leaks: null, credit: null, times: null, ...extra });
const FROM = '2026-09-22', TO = '2026-10-21';

ok('stock use: use a day, days left at one branch, the wastage share, the change; none with every branch; a negative level unknown', () => {
  const s = R.summariseStockUse([srow('Tusker', 270, 30, 20, { prev_sold: 200, unit: 'bottles' }), srow('Milk', 40, 20, -3, { kind: 'ingredient' }), srow('Gone', 0, 0, 5, { prev_sold: 9 })], 30, true);
  const t = s.items.find((x) => x.name === 'Tusker');
  assert.deepEqual([t.used, t.perDay, t.daysLeft, t.wasteShare, t.change], [300, 10, 2, 0.1, 0.5]);
  const milk = s.items.find((x) => x.name === 'Milk');
  assert.deepEqual([milk.onHand, milk.daysLeft, milk.wasteShare, milk.kind], [null, null, 0.3333, 'ingredient'], 'a negative level: nobody counts it');
  assert.equal(s.items.find((x) => x.name === 'Gone').daysLeft, null, 'nothing used now: no days left');
  assert.deepEqual(s.runOut.map((x) => x.name), ['Tusker']);
  assert.deepEqual(s.wasted.map((x) => x.name), ['Milk', 'Tusker'], 'the biggest wasted share first');
  const all = R.summariseStockUse([srow('Tusker', 270, 30, 20)], 30, false, R.STOCK_NOTE_ALL);
  assert.deepEqual([all.items[0].onHand, all.items[0].daysLeft, all.runOut.length, all.note], [null, null, 0, R.STOCK_NOTE_ALL]);
  assert.match(all.covers, /^Covers items that track stock/);
});

ok('run out: under 3 days at the current rate, used ≥ 5, a week of data; a week\'s worth to order; ranked first', () => {
  const s = R.summariseStockUse([srow('Tusker lager', 297, 0, 20, { unit: 'bottles' }), srow('Mints', 4, 0, 0), srow('Rice', 30, 0, 300), srow('Gin', 30, 0, 3)], 30, true);
  const recs = R.recRunOut(base({ stockUse: s }));
  assert.deepEqual(recs.map((x) => x.title), ['Tusker lager runs out in about 2 days at your current rate — order now'],
    'Gin lasts exactly 3 days (not under); Mints used 4 (under the floor of 5); Rice 300 days');
  const t = recs[0];
  assert.equal(t.why, 'You have 20 bottles left and use about 9.9 a day (297 in 30 days).');
  assert.deepEqual(t.stock.items[0], { name: 'Tusker lager', qty: 80, onHand: 20, order: 60 }, '9.9 × 7 = 69.3, +10% = 76.2, up to 80');
  assert.deepEqual([t.impact, t.kind, t.evidence, t.warning], [null, 'stock_out', 'stock', false]);
  assert.equal(R.recRunOut(base({ days: 6, stockUse: R.summariseStockUse([srow('Tusker lager', 60, 0, 5)], 6, true) })).length, 0, 'under a week of data');
  assert.equal(R.recRunOut(base({ stockUse: R.summariseStockUse([srow('Tusker lager', 297, 0, 20)], 30, false) })).length, 0, 'every branch: no card');
  assert.equal(R.recRunOut(base({ stockUse: R.summariseStockUse([srow('Soda', 60, 0, 0)], 30, true) }))[0].title, 'Soda has run out — order now');
  // ranked with the stock-out risks, before a KES 90,000 credit card
  const ranked = R.rankRecommendations([{ id: 'c', kind: 'credit', impact: 90000, confidence: 'high' }, ...recs]);
  assert.equal(ranked[0].kind, 'stock_out');
  assert.equal(R.valueFound(recs).line, 'This period: 1 thing to act on — 1 item running low.', 'a run-out card counts as an item running low');
});

ok('run out: the de-dupe in buildRecommendations against a real running-low card', () => {
  // A560's running-low needs item × time; one item, Tusker, sells 10 a day and 40 on Fridays, 3 on hand
  const cells = []; for (let d = 1; d <= 7; d++) cells.push([d, 19, (d === 5 ? 40 : 10) * 4, (d === 5 ? 40 : 10) * 4 * 300]);
  const qty = cells.reduce((s, c) => s + c[2], 0);
  const times = R.summariseItemTimes([{ is_total: false, product_id: 'id-Tusker lager', product_name: 'Tusker lager', qty, revenue: qty * 300, cells },
    { is_total: true, product_id: null, product_name: null, qty, revenue: qty * 300, cells }], 0);
  const input = base({ days: 28, times, from: '2026-09-21', to: '2026-10-18', today: '2026-10-21', stock: [{ productId: 'id-Tusker lager', onHand: 3 }],
    stockUse: R.summariseStockUse([srow('Tusker lager', qty, 0, 3)], 28, true) });
  assert.equal(R.recRunningLow(input).length, 1);
  assert.equal(R.recRunOut(input).length, 1);
  const recs = R.buildRecommendations(input);
  assert.equal(recs.filter((x) => /Tusker/.test(x.title) && (x.kind === 'stock_low' || x.kind === 'stock_out')).length, 1, 'one card for the item');
  assert.equal(recs[0].kind, 'stock_low', 'A560\'s card (it knows the busy day) wins');
});

ok('wastage: 15% and 5 units at least, the worst first, a week of data; no KES', () => {
  const s = R.summariseStockUse([srow('Milk', 80, 20, 5, { unit: 'litres', kind: 'ingredient' }), srow('Bread', 30, 6, 5), srow('Rice', 96, 4, 9), srow('Ice', 2, 3, 1)], 30, true);
  const recs = R.recWastage(base({ stockUse: s }));
  assert.equal(recs.length, 1);
  assert.equal(recs[0].title, 'You throw away 20% of your Milk — order less at a time or check how it is stored');
  assert.equal(recs[0].why, '20 litres of the 100 used in 30 days went to wastage. Also high: Bread (17%).', 'Rice 4% is under 15%; Ice wasted 3 is under 5');
  assert.deepEqual([recs[0].impact, recs[0].evidence], [null, 'stock']);
  assert.equal(R.recWastage(base({ days: 5, stockUse: s })).length, 0);
});

// ── customers ────────────────────────────────────────────────────────────────
const prow = (which, orders, linked, customers, newCustomers, sales = orders * 1000, linkedSales = linked * 1500) =>
  ({ kind: 'period', which, orders, sales, linked_orders: linked, linked_sales: linkedSales, customers, new_customers: newCustomers });
const crow = (name, visits, spend, visits90, first90, last) => ({ kind: 'customer', customer_id: `c-${name}`, customer_name: name, phone: null, visits, spend, prev_visits: 0, visits_90: visits90, first_90: first90, last_visit: last });

ok('customers: new and returning against the previous period; the coverage note under 20%; the average bill against walk-ins', () => {
  const c = R.summariseCustomers([prow('now', 100, 15, 10, 4), prow('prev', 90, 10, 8, 4)], FROM, TO, TO);
  assert.deepEqual([c.now.customers, c.now.newCustomers, c.now.returning, c.prev.returning], [10, 4, 6, 4]);
  assert.deepEqual([c.change.customers, c.change.returning], [0.25, 0.5]);
  assert.deepEqual([c.coverage.share, c.coverage.low], [0.15, true]);
  assert.equal(c.coverage.note, 'Only 15% of your sales are linked to a customer, so these trends cover your account and loyalty customers only.');
  assert.deepEqual(c.avgBill, { customer: 1500, walkIn: 911.76 }, 'KES 22,500 over 15 bills; KES 77,500 over 85');
  const fine = R.summariseCustomers([prow('now', 100, 20, 10, 4)], FROM, TO, TO);
  assert.deepEqual([fine.coverage.low, fine.coverage.note], [false, null], '20% is enough');
});

ok('regulars gone quiet: ≥ 4 visits in 90 days about every two weeks; no visit for twice the gap and at least two weeks', () => {
  const rows = [
    crow('Wanjiku', 0, 0, 13, '2026-07-25', '2026-09-23'),   // every 5 days, 28 days ago → gone quiet
    crow('Otieno', 2, 4000, 6, '2026-08-01', '2026-10-01'),   // every 12 days, 20 days ago: under 24 → not yet
    crow('Akinyi', 0, 0, 3, '2026-08-01', '2026-08-21'),      // 3 visits: not a regular
    crow('Kamau', 0, 0, 4, '2026-07-25', '2026-09-24'),       // every 20.3 days: not a regular (over 15)
    crow('Njeri', 1, 900, 9, '2026-09-25', '2026-10-09'),     // every 1.75 days, 12 days ago: 2× gap passed but under two weeks
    crow('Brian', 2, 3000, 2, '2026-10-05', '2026-10-12'),
  ];
  const c = R.summariseCustomers([prow('now', 100, 30, 3, 1), ...rows], FROM, TO, TO);
  assert.deepEqual(c.lapsed.map((x) => [x.name, x.gap, x.daysSince]), [['Wanjiku', 5, 28]]);
  assert.equal(c.frequency.regulars, 3, 'Wanjiku, Otieno, Njeri');
  assert.deepEqual(c.top.map((x) => x.name), ['Otieno', 'Brian', 'Njeri'], 'by spend; only those who came this period');
  const card = R.recLapsed(base({ customers: c }));
  assert.equal(card[0].title, 'Wanjiku, a regular, has not been back in 28 days — call or message them');
  assert.equal(card[0].why, 'Wanjiku (usually every 5 days, last came 28 days ago).');
  // five gone quiet: the plural card, three named and "2 more"
  const many = R.summariseCustomers([prow('now', 100, 30, 3, 1), ...['A', 'B', 'C', 'D', 'E'].map((n, i) => crow(n, 0, 0, 10 - i, '2026-07-25', `2026-09-${String(20 - i).padStart(2, '0')}`))], FROM, TO, TO);
  const m = R.recLapsed(base({ customers: many }))[0];
  assert.equal(m.title, '5 regulars have not been back in over 4 weeks — call or message them', 'the least gone: 31 days');
  assert.match(m.why, /^A \(usually every \d+ days, last came 31 days ago\), B .*, C .* and 2 more\.$/);
  assert.deepEqual([m.impact, m.evidence], [null, 'customers']);
  assert.equal(R.recLapsed(base({ customers: R.customersWithheld(c) })).length, 0, 'withheld: no card');
});

ok('the order-type mix: by day up to 31 days, by 7-day blocks over; the groups; the average bill per bucket', () => {
  const rows = [prow('now', 4, 0, 0, 0), { kind: 'type', day: '2026-09-22', order_type: 'dine_in', orders: 3, sales: 3000 }, { kind: 'type', day: '2026-09-22', order_type: 'Take away', orders: 1, sales: 500 },
    { kind: 'type', day: '2026-10-21', order_type: 'retail', orders: 2, sales: 400 }, { kind: 'type', day: '2026-10-22', order_type: 'delivery', orders: 9, sales: 9 }];
  const c = R.summariseCustomers(rows, FROM, TO, TO);
  assert.equal(c.mix.length, 30);
  assert.deepEqual([c.mix[0].orders.dine_in, c.mix[0].orders.takeaway, c.mix[0].avgBill], [3, 1, 875]);
  assert.equal(c.mix[29].orders.other, 2, 'retail: counter and other');
  assert.ok(!c.mixTotals.some((x) => x.key === 'delivery'), 'a day outside the period is left out');
  const long = R.summariseCustomers(rows, '2026-07-24', TO, TO);
  assert.deepEqual([long.byWeek, long.mix.length], [true, 13]);
  assert.equal(R.orderTypeGroup('Dine-in'), 'dine_in');
});

// ── costs ─────────────────────────────────────────────────────────────────────
const mrow = (name, qty, price, cost) => ({ product_id: `id-${name}`, product_name: name, category_name: 'Food', qty, revenue: qty * price, unit_cost: cost, cost_source: cost === null ? null : 'product' });
const MENU = [mrow('Chips masala', 120, 200, 176), mrow('Nyama', 100, 1000, 500), mrow('Tea', 60, 80, 70), mrow('Soup', 4, 300, 290), mrow('Pilau', 90, 300, 120),
  ...Array.from({ length: 12 }, (_, k) => mrow(`Special ${k + 1}`, 10 + k, 500, null))];
const PREV = [mrow('Chips masala', 60, 200, 176), mrow('Nyama', 120, 1000, 500), mrow('Tea', 60, 80, 70), mrow('Pilau', 90, 300, 120)];
const WATCH = [
  { kind: 'ingredient', item_id: 'i-oil', item_name: 'Cooking oil', unit: 'ml', cost_start: 0.4, cost_end: 0.5, changes: 1, used_in: 2 },
  { kind: 'ingredient', item_id: 'i-salt', item_name: 'Salt', unit: 'g', cost_start: 0.1, cost_end: 0.102, changes: 1, used_in: 1 },
  { kind: 'ingredient', item_id: 'i-rice', item_name: 'Rice', unit: 'kg', cost_start: 150, cost_end: 120, changes: 1, used_in: 1 },
  { kind: 'product', item_id: 'id-Chips masala', item_name: 'Chips masala', delta: 10, cost_now: 176, names: ['i-oil'] },
  { kind: 'product', item_id: 'id-Chips masala', item_name: 'Chips masala', delta: 0.2, cost_now: 176, names: ['i-salt'] },
  { kind: 'top_ingredient', item_id: 'id-Chips masala', item_name: 'Cooking oil', cost_now: 50 },
  { kind: 'unsold_no_cost', changes: 23, names: ['Ghost'] },
];
const costsOf = (menuRows = MENU, prevRows = PREV, watch = WATCH) => R.buildCosts({ menu: R.classifyMenu(menuRows), menuPrev: R.classifyMenu(prevRows), watch, days: 30 });

ok('costs: food cost and its movers; the thinnest margins (sold ≥ 5); the items with no cost — 10 of 12 by sales, the share, the unsold', () => {
  const c = costsOf();
  assert.ok(c.foodCost.now > c.foodCost.prev, `${c.foodCost.now} > ${c.foodCost.prev}`);
  assert.equal(c.foodCost.movers[0].name, 'Chips masala', 'it doubled');
  assert.deepEqual(c.thin.map((x) => x.name), ['Chips masala', 'Tea', 'Nyama', 'Pilau'], 'Soup sold 4: left out');
  assert.deepEqual([c.thin[0].marginPct, c.thin[0].topIngredient], [0.12, 'Cooking oil']);
  assert.deepEqual([c.noCost.items.length, c.noCost.total, c.noCost.items[0].name], [10, 12, 'Special 12'], 'the most sold first');
  assert.deepEqual([c.noCost.unsold, c.noCost.unsoldNames], [23, ['Ghost']]);
  assert.ok(c.noCost.share > 0.3 && c.noCost.share < 0.4);
  assert.deepEqual(R.noCostShare(R.classifyMenu(MENU)).items, 12);
  assert.equal(R.noCostShare(R.menuWithoutCosts(R.classifyMenu(MENU))).share, null, 'never without costs');
});

ok('cost rises: up only, the change, the products and what each rise adds a month (per product and ingredient)', () => {
  const c = costsOf();
  assert.deepEqual(c.rises.map((x) => [x.name, x.change]), [['Cooking oil', 0.25], ['Salt', 0.02]], 'Rice went down: not a rise');
  assert.deepEqual(c.rises[0].products, [{ name: 'Chips masala', delta: 10, qty: 120, extra: 1200 }]);
  assert.equal(c.rises[0].extraMonth, 1200);
  assert.equal(c.rises[1].extraMonth, 24, 'Salt: 0.2 a serving × 120');
  const card = R.recCostRise(base({ costWatch: c }));
  assert.equal(card[0].title, 'Compare suppliers for Cooking oil: its cost rose 25%');
  assert.equal(card[0].why, 'Cooking oil went from KES 0.40 to KES 0.50 a ml this period; Chips masala now costs more to make.');
  assert.deepEqual([card[0].impact, card[0].impactPer, card[0].impactKind], [1200, 'month', 'recover']);
  assert.equal(R.recCostRise(base({ costWatch: costsOf(MENU, PREV, WATCH.filter((w) => w.item_id !== 'i-oil')) })).length, 0, 'Salt 2%: under 5%');
  assert.equal(R.recCostRise(base({ costs: false, costWatch: c })).length, 0, 'never without costs');
});

ok('thin margin: the best seller under 20% and sold ≥ 10, naming its biggest ingredient; no KES', () => {
  const c = costsOf();
  const input = base({ menu: R.classifyMenu(MENU), costWatch: c });
  const card = R.recThinMargin(input);
  assert.equal(card[0].title, 'Chips masala earns 12% — check the portion or the cooking oil cost');
  assert.equal(card[0].why, 'Of every KES 200 it sells for, KES 24 is left after its cost (120 sold in 30 days). Also thin: Tea (13%).');
  assert.equal(card[0].impact, null);
  // Tea alone, without a recipe: "what goes into it"; Soup (3%) sold 4 — never a card
  const tea = R.recThinMargin(base({ menu: R.classifyMenu(MENU), costWatch: { ...c, thin: c.thin.filter((x) => x.name !== 'Chips masala') } }));
  assert.equal(tea[0].title, 'Tea earns 13% — check the portion or what goes into it');
  const few = costsOf([mrow('Soup', 9, 300, 290), mrow('Nyama', 60, 1000, 500)]);
  assert.equal(R.recThinMargin(base({ menu: R.classifyMenu([mrow('Soup', 9, 300, 290), mrow('Nyama', 60, 1000, 500)]), costWatch: few })).length, 0, 'sold 9: under 10');
});

ok('food cost: a rise of 2 points or more, its movers, the estimate and what it assumes', () => {
  const c = costsOf();
  const card = R.recFoodCost(base({ menu: R.classifyMenu(MENU), costWatch: c }));
  assert.match(card[0].title, /^Your food cost rose from \d+% to \d+% — check the biggest movers$/);
  assert.match(card[0].why, /^The biggest movers are Chips masala/);
  assert.ok(card[0].impact > 0 && card[0].impactKind === 'recover');
  assert.match(card[0].assumption, /^If your food cost goes back to \d+% of what these items sell for\. Both periods use today's costs/);
  const flat = costsOf(MENU.filter((x) => x.unit_cost !== null), MENU.filter((x) => x.unit_cost !== null));
  assert.equal(R.recFoodCost(base({ menu: R.classifyMenu(MENU), costWatch: flat })).length, 0, 'no change: no card');
  assert.equal(R.recFoodCost(base({ costs: false, menu: R.classifyMenu(MENU), costWatch: c })).length, 0, 'never without costs');
});

ok('the 10-row caps: run out, wasted, top customers, thinnest margins, cost rises, items with no cost', () => {
  const s = R.summariseStockUse(Array.from({ length: 25 }, (_, k) => srow(`Item ${k}`, 30 + k, 5, 10)), 30, true);
  assert.deepEqual([s.runOut.length, s.runOutTotal, s.wasted.length, s.wastedTotal], [10, 25, 10, 25]);
  const cu = R.summariseCustomers([prow('now', 100, 50, 20, 5), ...Array.from({ length: 20 }, (_, k) => crow(`C${k}`, 1, 100 + k, 1, '2026-10-01', '2026-10-01'))], FROM, TO, TO);
  assert.equal(cu.top.length, 10);
  assert.equal(cu.top[0].name, 'C19');
  const big = costsOf(Array.from({ length: 15 }, (_, k) => mrow(`Dish ${k}`, 20, 100, 50 + k)), [], [
    ...Array.from({ length: 14 }, (_, k) => ({ kind: 'ingredient', item_id: `i${k}`, item_name: `Ing ${k}`, unit: null, cost_start: 10, cost_end: 11 + k, changes: 1, used_in: 1 })),
  ]);
  assert.deepEqual([big.thin.length, big.thinTotal, big.rises.length, big.risesTotal], [10, 15, 10, 14]);
});

ok('the tiles\' hooks: one live figure each, an alert where a card points, hidden where the person may not look', () => {
  const s = R.summariseStockUse([srow('Tusker lager', 297, 0, 20), srow('Gin', 30, 0, 5)], 30, true);
  const cu = R.summariseCustomers([prow('now', 100, 30, 3, 1), crow('Wanjiku', 0, 0, 13, '2026-07-25', '2026-09-23')], FROM, TO, TO);
  const menu = R.classifyMenu(MENU);
  const heat = R.summariseHeatmap([{ dow: 6, hour: 19, revenue: 9000, orders: 9 }, { dow: 6, hour: 20, revenue: 9000, orders: 9 }, { dow: 2, hour: 12, revenue: 100, orders: 1 }]);
  const credit = R.summariseCredit([{ customer_id: 'k', customer_name: 'County', phone: null, balance: 87400, owed: 87400, d0_30: 0, d31_60: 0, d61_90: 87400, d90_plus: 0, unaged: 0, oldest_at: null, disputed_count: 0, disputed_amount: 0 }]);
  const costWatch = costsOf();
  const input = { costs: true, seesCredit: true, menu, heatmap: heat, leaks: null, credit, stockUse: s, customers: cu, costWatch };
  const recs = R.buildRecommendations(base({ menu, stockUse: s, customers: cu, costWatch, credit }));
  const h = R.tileHooks({ ...input, recommendations: recs });
  assert.equal(h.menu.text, `${menu.counts.star} ${menu.counts.star === 1 ? 'star' : 'stars'} · ${menu.counts.dog} ${menu.counts.dog === 1 ? 'dog' : 'dogs'}`);
  assert.equal(h.heatmap.text, 'Busiest: Sat 19:00');
  assert.equal(h.leaks.text, 'Nobody flagged');
  assert.equal(h.credit.text, 'KES 87,400 over 60 days');
  assert.equal(h.stock.text, '2 items run out this week', 'Tusker 2 days, Gin 5');
  assert.equal(h.customers.text, '1 regular gone quiet');
  assert.equal(h.costs.text, '12 items have no cost');
  assert.deepEqual([h.stock.alert, h.customers.alert, h.credit.alert, h.leaks.alert], [true, true, true, false]);
  const plain = R.tileHooks({ ...input, costs: false, seesCredit: false, menu: null, itemsSold: 40, customers: R.customersWithheld(cu), costWatch: null, recommendations: [] });
  assert.deepEqual([plain.menu.text, plain.costs.hidden, plain.credit.hidden, plain.customers.text, plain.costs.alert], ['40 items sold', true, true, 'Order types and average bill', false]);
  const none = R.tileHooks({ costs: true, seesCredit: true, menu: null, heatmap: null, leaks: null, credit: null, stockUse: R.summariseStockUse([], 30, false, R.STOCK_NOTE_ALL), customers: null, costWatch: null, recommendations: [] });
  assert.deepEqual([none.menu.text, none.heatmap.text, none.stock.text, none.customers.text, none.costs.text], ['No items sold yet', 'No sales yet', 'No stock tracked', 'Who comes back', 'What each sale earns']);
});

ok('no price wording: no new title, reason, assumption or hook says price, raise or re-price (A560\'s scan, extended)', () => {
  const s = R.summariseStockUse([srow('Tusker lager', 297, 0, 20), srow('Milk', 80, 20, 5)], 30, true);
  const cu = R.summariseCustomers([prow('now', 100, 10, 3, 1), crow('Wanjiku', 0, 0, 13, '2026-07-25', '2026-09-23')], FROM, TO, TO);
  const menu = R.classifyMenu(MENU);
  const input = base({ menu, stockUse: s, customers: cu, costWatch: costsOf() });
  const every = [R.recRunOut, R.recWastage, R.recLapsed, R.recFoodCost, R.recThinMargin, R.recCostRise, R.recCostData].flatMap((f) => f(input));
  assert.deepEqual([...new Set(every.map((x) => x.kind))].sort(), ['cost', 'cost_rise', 'food_cost', 'lapsed', 'stock_out', 'thin_margin', 'wastage']);
  const hooks = R.tileHooks({ costs: true, seesCredit: true, menu, heatmap: null, leaks: null, credit: null, stockUse: s, customers: cu, costWatch: input.costWatch, recommendations: every });
  const texts = [...every.flatMap((x) => [x.title, x.why, x.assumption]), ...Object.values(hooks).map((x) => x.text), cu.coverage.note, s.covers, input.costWatch.historyNote, R.valueFound(R.buildRecommendations(input)).line].filter(Boolean);
  for (const t of texts) assert.ok(!/\bprices?\b|\brais(e|es|ing)\b|re-?pric|price rise/i.test(t), `price wording: ${t}`);
  assert.equal(every.find((x) => x.kind === 'cost').evidence, 'costs', 'the A558 missing-cost card opens the Costs tab');
  assert.equal(R.costText(0.4), 'KES 0.40');
  assert.equal(R.costText(150), 'KES 150');
});

ok('the page: which tiles show, ?tab= opens one, the arrow keys wrap, days left in words, the order-type colours', () => {
  const hooks = { credit: { text: '', alert: false, hidden: true }, costs: { text: '', alert: false, hidden: false } };
  assert.deepEqual(M.visibleAreas(hooks, false), ['menu', 'heatmap', 'leaks', 'stock', 'customers', 'costs'], 'credit hidden by the cloud');
  assert.deepEqual(M.visibleAreas(null, true), ['menu', 'heatmap', 'leaks', 'credit', 'stock', 'customers'], 'costs hidden for the role');
  const all = M.AREA_ORDER;
  assert.equal(M.areaFromQuery('?tab=stock&x=1', all), 'stock');
  assert.equal(M.areaFromQuery('?tab=costs', M.visibleAreas(null, true)), null, 'never an area the person may not open');
  assert.equal(M.areaFromQuery('?tab=nope', all), null);
  assert.deepEqual([M.nextArea(all, 'costs', 'ArrowRight'), M.nextArea(all, 'menu', 'ArrowLeft'), M.nextArea(all, 'leaks', 'Home'), M.nextArea(all, 'menu', 'End'), M.nextArea(all, 'stock', 'a')],
    ['menu', 'costs', 'menu', 'costs', 'stock']);
  assert.deepEqual([0, 0.4, 2.02, 1, 20, 100, null].map(M.daysLeftWords), ['out now', 'under a day', 'about 2 days', 'about 1 day', 'about 3 weeks', 'over 10 weeks', '—']);
  assert.deepEqual([M.changeCell(0.25, 10), M.changeCell(-0.1, 10), M.changeCell(null, 0), M.changeCell(0.001, 5)], ['+25%', '−10%', 'new', 'same']);
  for (const mode of ['light', 'dark']) {
    const pal = P.chartPalette(mode);
    assert.deepEqual(P.ORDER_TYPE_ORDER.map((k) => pal.orderTypes[k]), pal.categorical.slice(0, 4), `${mode}: slots 1–4 in order`);
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
