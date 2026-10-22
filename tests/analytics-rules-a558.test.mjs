/**
 * analytics-rules-a558.test.mjs — A558 ("decisions made easy"): every pure rule, run directly.
 *   - the cloud (apps/server/src/lib/analyticsRules.ts, compiled): the dayparts and their EAT hour edges, what sells when
 *     (shares against the total row, the top 5 / top 3, the best daypart, the peak), EVERY recommendation rule — its
 *     thresholds, its minimum data, its impact maths, its sentence — the ranking, costs hidden, the value found, and the
 *     "How was this period?" summary;
 *   - the page (apps/dashboard/src/pages/analytics/chartMath.ts, read as TypeScript): the KPI change in words, the
 *     10-row cap, the margin "of every KES 100", one item's grid.
 *
 *   cd apps/server && npm run build && cd ../.. && node tests/analytics-rules-a558.test.mjs
 *
 * MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted — listed in the A558 report):
 *   - daypartOf: lunch from 12 instead of 11                         → "the dayparts" fails
 *   - summariseItemTimes sharing against the items sent, not the total row → "what sells when" fails
 *   - menuReady ignoring `costs`                                      → "costs hidden" fails
 *   - rankRecommendations without the cap of 7                       → "the ranking" fails
 *   - recLeaks with a KES estimate again                              → "money leaks" and "the value found" fail
 * A560 removed the price-rise rule (the owner: prices must stay competitive) and made a cashier's voids a warning; the
 * stock rules are tested in tests/analytics-rules-a560.test.mjs.
 *   - capRows returning every row                                      → "capRows" fails
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

let pass = 0, fail = 0;
const ok = (n, f) => { try { f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${String(e.stack ?? e.message).split('\n').slice(0, 6).join('\n      ')}`); } };
console.log('\nA558 — Analytics decisions: the rules\n');

// ── the scenario: 30 days ─────────────────────────────────────────────────────
// menu: Tusker and Chips are Plowhorses (popular, below the weighted average margin 231.29), Nyama a Star, Fish a
// Puzzle, Soup a Dog, Special has no cost. 760 items sold.
const mrow = (name, qty, price, cost) => ({ product_id: name, product_name: name, category_name: null, qty, revenue: qty * price, unit_cost: cost, cost_source: cost === null ? null : 'product' });
const MENU_ROWS = [mrow('Tusker', 300, 300, 250), mrow('Nyama', 200, 1000, 500), mrow('Chips', 150, 200, 50), mrow('Fish', 30, 1200, 400), mrow('Soup', 20, 300, 280), mrow('Special', 60, 500, null)];
const menu = R.classifyMenu(MENU_ROWS);
// busy times: every day 10:00–22:59 at 1,000 an hour (2 orders), Friday 18–21 at 10,000 an hour, Tuesday 15–17 at 100
const heatRows = [];
for (let dow = 1; dow <= 7; dow++) for (let h = 10; h <= 22; h++) {
  const rev = dow === 5 && h >= 18 && h <= 20 ? 10000 : dow === 2 && (h === 15 || h === 16) ? 100 : 1000;
  heatRows.push({ dow, hour: h, revenue: rev, orders: 2 });
}
const heatmap = R.summariseHeatmap(heatRows);
// money leaks: Vic voids 20 of 100 (KES 20,000) against a median rate of 2%; one day close 600 short
const lrow = (id, orders, voids, voidValue, extra = {}) => ({ by_cashier: true, cashier_id: id, day: null, orders, voids, void_value: voidValue, item_voids: 0, item_void_value: 0, refunds: 0, refund_value: 0, discounts: 0, discount_value: 0, wastage: 0, wastage_value: 0, drawer_variance: 0, day_close_variance: 0, ...extra });
const drow = (day, dcv) => ({ ...lrow(null, 10, 0, 0), by_cashier: false, day, day_close_variance: dcv });
const leaks = R.summariseLeaks([lrow('a', 100, 2, 2000), lrow('b', 100, 2, 2000), lrow('v', 100, 20, 20000), drow('2026-10-05', -600), drow('2026-10-06', 0)], { a: 'Amina', b: 'Baraka', v: 'Otieno' });
// credit: 52,000 over 60 days across four customers
const crow = (id, name, d61, d90, owed) => ({ customer_id: id, customer_name: name, phone: null, balance: owed, owed, d0_30: owed - d61 - d90, d31_60: 0, d61_90: d61, d90_plus: d90, unaged: 0, oldest_at: null, disputed_count: 0, disputed_amount: 0 });
const credit = R.summariseCredit([crow('k1', 'County Office', 22000, 8000, 40000), crow('k2', 'Safari Tours', 10000, 0, 30000), crow('k3', 'Peter', 0, 7000, 7000), crow('k4', 'Lakeview', 5000, 0, 9000), crow('k5', 'Paid up', 0, 0, 3000)]);
// what sells when (ISO weekdays): Fish mostly at Wednesday lunch; Friday evening Nyama and Tusker; a tail product not sent
const irow = (name, cells) => ({ is_total: false, product_id: name, product_name: name, qty: cells.reduce((s, c) => s + c[2], 0), revenue: cells.reduce((s, c) => s + c[3], 0), cells });
const ITEMS = [
  irow('Tusker', [[5, 19, 50, 15000], [3, 12, 10, 3000]]),
  irow('Nyama', [[5, 18, 30, 30000], [5, 19, 20, 20000], [3, 13, 5, 5000]]),
  irow('Chips', [[5, 20, 10, 2000], [3, 12, 30, 6000]]),
  irow('Fish', [[3, 12, 20, 24000], [5, 19, 10, 12000]]),
];
const TAIL = [[3, 12, 40, 4000], [1, 1, 5, 500]];   // a product past the limit — only in the total row
const allCells = new Map();
for (const c of [...ITEMS.flatMap((r) => r.cells), ...TAIL]) { const k = `${c[0]}|${c[1]}`; const t = allCells.get(k) ?? [c[0], c[1], 0, 0]; t[2] += c[2]; t[3] += c[3]; allCells.set(k, t); }
const TOTAL = { is_total: true, product_id: null, product_name: null, qty: [...allCells.values()].reduce((s, c) => s + c[2], 0), revenue: [...allCells.values()].reduce((s, c) => s + c[3], 0), cells: [...allCells.values()] };
const times = R.summariseItemTimes([...ITEMS, TOTAL], 0, 4);
const base = { days: 30, costs: true, menu, heatmap, leaks, credit, times };

// ── the dayparts ──────────────────────────────────────────────────────────────
ok('the dayparts: Morning 05–11, Lunch 11–15, Afternoon 15–18, Evening 18–22, Late 22–05; the cut-off pushes the morning later', () => {
  const at = (h, c = 0) => R.daypartOf(h, c);
  assert.deepEqual([4, 5, 10, 11, 14, 15, 17, 18, 21, 22, 23, 0].map((h) => at(h)),
    ['late', 'morning', 'morning', 'lunch', 'lunch', 'afternoon', 'afternoon', 'evening', 'evening', 'late', 'late', 'late']);
  assert.equal(R.morningStart(0), 5);
  assert.equal(R.morningStart(120), 5, 'a 02:00 cut-off is before 05:00 — no change');
  assert.equal(R.morningStart(360), 6);
  assert.equal(at(5, 360), 'late', 'with the day ending 06:00, 05:xx is still last night');
  assert.equal(at(6, 360), 'morning');
  assert.deepEqual(R.daypartsFor(360).map((d) => [d.key, d.from, d.to]), [['morning', 6, 11], ['lunch', 11, 15], ['afternoon', 15, 18], ['evening', 18, 22], ['late', 22, 6]]);
});

ok('what sells when: shares against the TOTAL row, the top 5 per daypart and top 3 per hour, the best daypart and the peak', () => {
  const lunch = times.dayparts.find((d) => d.key === 'lunch');
  // lunch: Tusker 10 + Nyama 5 + Chips 30 + Fish 20 + the tail 40 = 105
  assert.equal(lunch.qty, 105);
  assert.deepEqual(lunch.top.map((x) => [x.name, x.qty, x.share]), [['Chips', 30, 0.2857], ['Fish', 20, 0.1905], ['Tusker', 10, 0.0952], ['Nyama', 5, 0.0476]],
    'the tail is not named (not sent) but counts in the denominator');
  const late = times.dayparts.find((d) => d.key === 'late');
  assert.deepEqual([late.qty, late.top.length], [5, 0], 'the tail\'s 01:00 sale is Late; no item sent sold then');
  const fish = times.items.find((i) => i.name === 'Fish');
  assert.deepEqual([fish.bestDaypart, fish.bestDaypartShare], ['lunch', 0.6667]);
  assert.deepEqual(fish.peak, { dow: 2, day: 'Wednesday', hour: 12, qty: 20 }, 'ISO 3 is Wednesday (0 = Monday)');
  assert.deepEqual(fish.cells[0], [2, 12, 20, 24000]);
  const h19 = times.hours.find((h) => h.hour === 19);
  assert.deepEqual(h19.top.map((x) => x.name), ['Tusker', 'Nyama', 'Fish']);
  assert.deepEqual(times.hours.map((h) => h.hour), [12, 13, 18, 19, 20, 1], 'the day\'s order: from the morning round to the small hours');
  assert.equal(times.limited, true, '4 sent with a limit of 4');
  assert.equal(times.totals.qty, 230);
  assert.deepEqual(times.items.map((i) => i.name), ['Tusker', 'Nyama', 'Chips', 'Fish'], 'by quantity: 60, 55, 40, 30');
  const empty = R.summariseItemTimes([], 0);
  assert.deepEqual([empty.items.length, empty.hours.length, empty.dayparts.every((d) => d.qty === 0 && d.top.length === 0)], [0, 0, true]);
});

// ── the rules ─────────────────────────────────────────────────────────────────
ok('the scenario classifies as built (the matrix of A549)', () => {
  const cls = Object.fromEntries(menu.items.map((i) => [i.name, i.class]));
  assert.deepEqual(cls, { Tusker: 'plowhorse', Nyama: 'star', Chips: 'plowhorse', Special: 'no_cost', Fish: 'puzzle', Soup: 'dog' });
  assert.equal(menu.avgUnitMargin, 231.29);
});

ok('A560: no price rule — nothing suggests a price rise, and the Plowhorses get no card', () => {
  assert.equal(R.recPriceRise, undefined);
  assert.equal(R.suggestedRise, undefined);
  const recs = R.buildRecommendations(base);
  assert.ok(!recs.some((x) => x.kind === 'price'));
  assert.ok(!recs.some((x) => /Tusker|Chips/.test(x.title)), 'the two Plowhorses are not named in a title');
});

ok('promote: the best Puzzle at its best daypart; impact = margin × 20% more a month', () => {
  const [r] = R.recPromote(base);
  assert.equal(r.title, 'Feature Fish at lunch');
  assert.equal(r.impact, 800 * 30 * 0.2);
  assert.equal(r.why, 'It leaves KES 800 each — KES 569 more than your average — but only 30 sold in 30 days, 66.7% of them at lunch.'.replace('66.7%', '67%'));
  assert.equal(r.assumption, 'If featuring it lifts its sales by 20% (about 30 → 36 a month) at today\'s margin.');
  assert.equal(r.confidence, 'low');
  assert.equal(R.recPromote({ ...base, times: null })[0].title, 'Have staff suggest Fish', 'no item × time: no daypart named');
  const slow = R.classifyMenu(MENU_ROWS.map((x) => (x.product_name === 'Fish' ? { ...x, qty: 2, revenue: 2400 } : x)));
  assert.deepEqual(R.recPromote({ ...base, menu: slow }), [], 'fewer than 3 sold: not enough to say');
});

ok('drop or rework: the Dogs, two weeks at least, no KES estimate', () => {
  const [r] = R.recRework(base);
  assert.equal(r.title, 'Rework or drop Soup');
  assert.equal(r.impact, null);
  assert.equal(r.why, 'Soup sell little and earn little: 20 sold in 30 days, about KES 400 a month left after cost.');
  assert.deepEqual(R.recRework({ ...base, days: 13 }), [], 'under 14 days: never "drop it"');
});

ok('staffing: the busiest three hours (≥ 2× an even share) with what sells then; impact = 5% of those hours a month', () => {
  const [r] = R.recStaffing(base);
  assert.equal(r.title, 'Put an extra cashier on Friday 18:00–21:00');
  assert.equal(r.why, 'You take 25.8% of all your sales in those three hours (KES 30,000, 6 orders in 30 days) — most bought then: Nyama, Tusker and Chips; have them ready.'.replace('25.8%', '26%'));
  assert.equal(r.impact, 1500);
  const flat = R.summariseHeatmap(heatRows.map((x) => ({ ...x, revenue: 1000 })));
  assert.deepEqual(R.recStaffing({ ...base, heatmap: flat }), [], 'an even week: no rush to staff');
  const thin = R.summariseHeatmap(heatRows.map((x) => ({ ...x, orders: 1 })));
  assert.equal(thin.totalOrders, 91);
  assert.deepEqual(R.recStaffing({ ...base, heatmap: thin }), [], 'under 100 orders: not enough to say');
  assert.deepEqual(R.recStaffing({ ...base, days: 6 }), []);
});

ok('quiet slot: at most half a typical two hours; impact = a quarter of the gap a month', () => {
  const [r] = R.recQuietSlot(base);
  assert.equal(r.title, 'Try a happy-hour offer on Tuesday 15:00–17:00');
  assert.equal(r.why, 'It is your quietest time: KES 200 in 30 days, against KES 2,000 for a typical two hours.');
  assert.equal(r.impact, Math.round((2000 - 200) * 0.25));
  const mild = R.summariseHeatmap(heatRows.map((x) => (x.revenue === 100 ? { ...x, revenue: 600 } : x)));
  assert.deepEqual(R.recQuietSlot({ ...base, heatmap: mild }), [], '1,200 is more than half of 2,000: not quiet enough');
});

ok('money leaks (A560): a flagged cashier is a warning to look into — no KES estimate', () => {
  const [r] = R.recLeaks(base);
  assert.equal(r.title, "Check Otieno's voids");
  assert.equal(r.why, '20 voids (KES 20,000) in 30 days — 10.0× the branch median rate. Worth a look; a void before payment is not always a loss.');
  assert.deepEqual([r.impact, r.impactPer, r.impactKind, r.warning], [null, null, null, true]);
  assert.equal(r.assumption, 'A warning to look into, not money lost — no KES estimate.');
  assert.equal(r.confidence, 'high');
  assert.equal(R.recLeaks({ ...base, days: 60 })[0].impact, null);
  const calm = R.summariseLeaks([lrow('a', 100, 2, 2000), lrow('v', 100, 4, 4000), lrow('b', 100, 2, 2000)], {});
  assert.deepEqual(R.recLeaks({ ...base, leaks: calm }), [], '4 voids: under the 5-event floor');
});

ok('day close: KES 500 short at least; impact = the shortfall a month', () => {
  const [r] = R.recDayClose(base);
  assert.equal(r.impact, 600);
  assert.equal(r.why, 'The cash counted at day close was KES 600 short in all, on 1 day of 30.');
  const small = R.summariseLeaks([drow('2026-10-05', -499)], {});
  assert.deepEqual(R.recDayClose({ ...base, leaks: small }), []);
});

ok('credit: KES 1,000 over 60 days at least; the top names; counted once', () => {
  const [r] = R.recCredit(base);
  assert.equal(r.title, 'Chase KES 52,000 owed for over 60 days');
  assert.equal(r.why, 'County Office KES 30,000, Safari Tours KES 10,000, Peter KES 7,000 and 1 more — owed for more than two months.');
  assert.deepEqual([r.impact, r.impactPer, r.impactKind], [52000, 'once', 'collect']);
  assert.deepEqual(R.recCredit({ ...base, credit: null }), [], 'no customers.view: no credit rule');
  const little = R.summariseCredit([crow('k1', 'A', 999, 0, 999)]);
  assert.deepEqual(R.recCredit({ ...base, credit: little }), []);
});

ok('cost data: items sold (5 at least) with no cost set; no KES estimate', () => {
  const [r] = R.recCostData(base);
  assert.equal(r.title, 'Set a cost for Special');
  assert.equal(r.why, 'Special sold KES 30,000 in 30 days with no cost or recipe set, so the margin is unknown.');
  assert.equal(r.impact, null);
});

ok('the ranking: by the KES at stake (once or a month), no estimate last, at most 7', () => {
  const all = R.buildRecommendations(base);
  assert.deepEqual(all.map((x) => [x.kind, x.impact]), [
    ['credit', 52000], ['promote', 4800], ['staffing', 1500], ['day_close', 600], ['quiet', 450], ['leak', null], ['cost', null],
  ], 'A560: no price card; the void warning has no estimate (after every KES card, first of the rest on its strong evidence)');
  const r = R.rankRecommendations([
    { id: 'b', impact: null, confidence: 'high' }, { id: 'a', impact: 100, confidence: 'low' }, { id: 'c', impact: 100, confidence: 'high' }, { id: 'd', impact: 0, confidence: 'low' },
  ]);
  assert.deepEqual(r.map((x) => x.id), ['c', 'a', 'd', 'b'], 'ties by confidence; a null estimate after a zero one');
  const many = R.rankRecommendations(Array.from({ length: 12 }, (_, i) => ({ id: `x${i}`, impact: i, confidence: 'low' })));
  assert.equal(many.length, 7);
  assert.equal(many[0].id, 'x11');
});

ok('costs hidden (A490): no menu advice of any kind, and nothing that tells a margin', () => {
  const recs = R.buildRecommendations({ ...base, costs: false, menu: R.menuWithoutCosts(menu) });
  assert.deepEqual([...new Set(recs.map((x) => x.kind))].sort(), ['credit', 'day_close', 'leak', 'quiet', 'staffing']);
  const text = JSON.stringify(recs);
  for (const w of ['margin', 'Tusker by', 'Special', 'Soup', 'Fish']) assert.ok(!text.includes(w), w);
  assert.deepEqual(R.recPromote({ ...base, costs: false }), [], 'costs false, even with a full menu');
  assert.deepEqual(R.recCostData({ ...base, costs: false }), []);
  assert.deepEqual(R.recPromote({ ...base, menu: R.menuWithoutCosts(menu) }), []);
});

ok('the value found (A560): the gains and recoveries a month, the credit apart; no price rise and no voids in it', () => {
  const v = R.valueFound(R.buildRecommendations(base));
  assert.deepEqual(v, {
    monthly: 4800 + 1500 + 600 + 450, once: 52000, atRisk: 0, count: 5, actions: 7, stockDays: 0, lowItems: 0, warnings: 1, moves: 0,
    line: 'This period: 7 things to act on — KES 52,000 of old credit to collect, about KES 7,350 a month from the other ideas and 1 warning to look into.',
  });
  assert.deepEqual(R.valueFound([]), { monthly: 0, once: 0, atRisk: 0, count: 0, actions: 0, stockDays: 0, lowItems: 0, warnings: 0, moves: 0, line: null });
});

// ── the summary ───────────────────────────────────────────────────────────────
const kpi = (value, change) => ({ value, prev: null, change });
const ov = (k, wastageHidden = false) => ({ kpis: { revenue: kpi(2719071, 0.095), orders: kpi(900, 0.02), avgBill: kpi(3021, 0.01), margin: null, atRisk: kpi(40000, 0.02), ...k }, wastageHidden });
ok('the summary: good news first, then the biggest worry', () => {
  const recs = R.buildRecommendations(base);
  const s = R.buildSummary({ from: '2026-09-22', to: '2026-10-21', today: '2026-10-21', overview: ov({}), recommendations: recs });
  assert.equal(s.good, 'You sold KES 2,719,071 in the last 30 days — 9.5% more than the 30 days before.');
  assert.equal(s.worry, 'The biggest thing to act on: chase KES 52,000 owed for over 60 days.');
  assert.equal(s.tone, 'up');
  const down = R.buildSummary({ from: '2026-09-01', to: '2026-09-30', today: '2026-10-21', overview: ov({ revenue: kpi(900000, -0.041), avgBill: kpi(3200, 0.08) }), recommendations: recs });
  assert.equal(down.good, 'The average bill rose 8.0% to KES 3,200.', 'sales down: another good figure leads');
  assert.equal(down.worry, 'You sold KES 900,000 from 1 Sep to 30 Sep, 4.1% less than the 30 days before.');
  assert.equal(down.tone, 'down');
  const risk = R.buildSummary({ from: '2026-10-15', to: '2026-10-21', today: '2026-10-21', overview: ov({ revenue: kpi(100000, 0.001), atRisk: kpi(9000, 0.3) }, true), recommendations: [] });
  assert.equal(risk.good, 'You sold KES 100,000 in the last 7 days, about the same as the 7 days before.');
  assert.equal(risk.worry, 'Money lost to voids, refunds and discounts rose 30% to KES 9,000.', 'wastage hidden: not named');
  const none = R.buildSummary({ from: '2026-10-21', to: '2026-10-21', today: '2026-10-21', overview: ov({ revenue: kpi(0, null) }), recommendations: [] });
  assert.deepEqual([none.good, none.worry], ['No sales were recorded today.', null]);
});

// ── the page's words ──────────────────────────────────────────────────────────
ok('changeWords: a KPI\'s change in plain words, good or bad by whether up is good', () => {
  assert.deepEqual(M.changeWords(0.095, { upIsGood: true, compare: 'the 30 days before' }), { arrow: '▲', text: '9.5% more than the 30 days before', good: true });
  assert.deepEqual(M.changeWords(0.2, { upIsGood: false, compare: 'the 7 days before' }), { arrow: '▲', text: '20.0% more than the 7 days before', good: false }, 'money at risk up is bad');
  assert.deepEqual(M.changeWords(-0.04, { upIsGood: true, compare: 'x' }), { arrow: '▼', text: '4.0% less than x', good: false });
  assert.deepEqual(M.changeWords(0.021, { upIsGood: true, points: true, compare: 'x' }), { arrow: '▲', text: '2.1 points higher than x', good: true });
  assert.deepEqual(M.changeWords(0.004, { upIsGood: true, compare: 'x' }), { arrow: '', text: 'about the same as x', good: null });
  assert.deepEqual(M.changeWords(null, { upIsGood: true, compare: 'x' }), { arrow: '', text: 'no earlier figure to compare with', good: null });
  assert.equal(M.compareWords(1), 'the day before');
  assert.equal(M.compareWords(30), 'the 30 days before');
  assert.equal(M.per100(0.553), 55);
  assert.equal(M.per100(null), null);
});

ok('capRows: every analytics table shows its top 10 and says how many there were', () => {
  const rows = Array.from({ length: 37 }, (_, i) => i);
  assert.deepEqual(M.capRows(rows), { rows: rows.slice(0, 10), total: 37, capped: true });
  assert.deepEqual(M.capRows([1, 2]), { rows: [1, 2], total: 2, capped: false });
  assert.equal(M.capRows(rows, 10).rows.length, 10);
});

ok('itemGrid: one item\'s cells as a weekday × hour grid, its busiest cell and its hours', () => {
  const g = M.itemGrid([[2, 12, 20, 24000], [4, 19, 10, 12000], [9, 1, 5, 0]]);
  assert.equal(g.qty[2][12], 20);
  assert.deepEqual([g.max, g.hours, g.peak], [20, { from: 12, to: 19 }, { dow: 2, hour: 12, qty: 20 }], 'a bad weekday is skipped');
  assert.deepEqual(M.itemGrid([]).hours, null);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
