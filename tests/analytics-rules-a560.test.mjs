/**
 * analytics-rules-a560.test.mjs — A560: Analytics suggests what to stock, never a price rise; a cashier's voids are a
 * warning only. Every new rule of apps/server/src/lib/analyticsRules.ts (compiled), run directly:
 *   - the weekday counts and the suggested quantity (the typical day + 10%, rounded up);
 *   - "Stock up for Friday": the 1.5× uplift threshold, the 10-unit minimum, two of the weekday at least, two weeks;
 *   - "Running low": with and without stock levels, the horizon to the next busy day (today, later, none), the minimum
 *     shortfall, the sales at risk;
 *   - the week at a glance (each weekday's top 3 and its typical sales);
 *   - the slow movers (four weeks at least, never when half the list is slow, never a Dog the rework card names);
 *   - the ranking (stock-out risks first, then stocking up, then the rest; at most 7);
 *   - voids and discounts a warning with no estimate, out of the value line; the value line itself;
 *   - no generated text anywhere that says price, raise or re-price.
 *
 *   cd apps/server && npm run build && cd ../.. && node tests/analytics-rules-a560.test.mjs
 *
 * MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted — listed in the A560 report):
 *   - isBusyDay without the STOCK_UP_MIN_QTY floor                    → "the busy day" fails
 *   - isBusyDay without the 1.5× uplift                                → "the busy day" fails
 *   - stockQty without the 10% buffer                                  → "stockQty" fails
 *   - recRunningLow ignoring what is on hand (treated as 0)            → "running low" fails
 *   - recSlowMovers without the SLOW_MIN_DAYS guard                    → "slow movers" fails
 *   - valueFound counting a warning's estimate                         → "voids and discounts" fails
 *   - rankRecommendations without the stock groups                     → "the ranking" fails
 *   - the Plowhorse insight back to "consider a small price rise"     → "no price wording" fails
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
const ok = (n, f) => { try { f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${String(e.stack ?? e.message).split('\n').slice(0, 6).join('\n      ')}`); } };
console.log('\nA560 — Analytics: what to stock, never a price rise, voids a warning\n');

// ── the scenario: 28 days, Monday 21 September to Sunday 18 October 2026 — four of every weekday ─────────────────────
const FROM = '2026-09-21', TO = '2026-10-18';
// typical sales per weekday (Monday … Sunday) and what each sells for; the period holds 4 of each weekday
const PLAN = {
  Tusker: { price: 300, day: [10, 10, 10, 10, 40, 20, 10] },   // average day 15.71: Friday 40 is busy, Saturday 20 is not
  Nyama: { price: 1000, day: [5, 5, 5, 5, 15, 15, 5] },        // average 7.86: Friday and Saturday busy (15 ≥ 11.79)
  Chips: { price: 200, day: [9, 9, 9, 9, 9, 30, 9] },          // average 12: Saturday busy
  Tea: { price: 50, day: [12, 12, 12, 12, 12, 12, 12] },       // never busy
  Mints: { price: 20, day: [1, 1, 1, 1, 1, 1, 1] },            // tiny
};
const irow = (name, { price, day }, weeks = 4) => {
  const cells = day.map((q, d) => [d + 1, 19, q * weeks, q * weeks * price]).filter((c) => c[2] > 0);
  return { is_total: false, product_id: `id-${name}`, product_name: name, qty: cells.reduce((s, c) => s + c[2], 0), revenue: cells.reduce((s, c) => s + c[3], 0), cells };
};
const totalOf = (rows) => {
  const m = new Map();
  for (const c of rows.flatMap((r) => r.cells)) { const k = `${c[0]}|${c[1]}`; const t = m.get(k) ?? [c[0], c[1], 0, 0]; t[2] += c[2]; t[3] += c[3]; m.set(k, t); }
  return { is_total: true, product_id: null, product_name: null, qty: [...m.values()].reduce((s, c) => s + c[2], 0), revenue: [...m.values()].reduce((s, c) => s + c[3], 0), cells: [...m.values()] };
};
const ITEMS = Object.entries(PLAN).map(([n, p]) => irow(n, p));
const times = R.summariseItemTimes([...ITEMS, totalOf(ITEMS)], 0);
const base = { days: 28, costs: false, menu: null, heatmap: null, leaks: null, credit: null, times, from: FROM, to: TO };
const at = (today, stock) => ({ ...base, today, stock });

ok('weekdayOf and weekdayCounts: the business weekday (0 = Monday) and how many of each a period holds', () => {
  assert.equal(R.weekdayOf('2026-10-01'), 3, '1 October 2026 is a Thursday');
  assert.equal(R.weekdayOf('2026-09-21'), 0);
  assert.equal(R.weekdayOf('2026-10-18'), 6);
  assert.deepEqual(R.weekdayCounts(FROM, TO), [4, 4, 4, 4, 4, 4, 4]);
  assert.deepEqual(R.weekdayCounts('2026-10-01', '2026-10-21'), [3, 3, 3, 3, 3, 3, 3]);
  assert.deepEqual(R.weekdayCounts('2026-10-19', '2026-10-21'), [1, 1, 1, 0, 0, 0, 0]);
  assert.deepEqual(times.weekdays, [37, 37, 37, 37, 77, 78, 37].map((x) => x * 4), 'the total row per weekday');
});

ok('stockQty: the typical day + 10%, rounded UP — to 1 under 20, to 5 under 100, else to 10', () => {
  assert.equal(R.stockQty(120), 140, '132 → 140');
  assert.equal(R.stockQty(40), 45, '44 → 45');
  assert.equal(R.stockQty(15), 17, '16.5 → 17');
  assert.equal(R.stockQty(10), 11);
  assert.equal(R.stockQty(95), 110, '104.5 → 110');
  assert.equal(R.stockQty(50), 55, 'exactly 55 stays 55');
  assert.equal(R.stockQty(0), 0);
  assert.equal(R.stockQty(-4), 0);
});

ok('the busy day: at least 1.5× the average day, at least 10 units, at least two of that weekday', () => {
  const p = (x, avg) => ({ productId: 'p', name: 'P', avgPrice: 1, perDay: [x, 0, 0, 0, 0, 0, 0], avgDay: avg });
  const four = [4, 4, 4, 4, 4, 4, 4];
  assert.equal(R.isBusyDay(p(15, 10), 0, four), true, 'exactly 1.5×');
  assert.equal(R.isBusyDay(p(14.9, 10), 0, four), false, '1.49×');
  assert.equal(R.isBusyDay(p(9.9, 4), 0, four), false, 'over 1.5× but under 10 units');
  assert.equal(R.isBusyDay(p(10, 4), 0, four), true, '10 units');
  assert.equal(R.isBusyDay(p(30, 10), 0, [1, 4, 4, 4, 4, 4, 4]), false, 'one Monday in the period is not a pattern');
  assert.equal(R.isBusyDay(p(30, 0), 0, four), false);
  const prof = Object.fromEntries(R.weekdayProfiles(times, R.weekdayCounts(FROM, TO)).map((x) => [x.name, x]));
  assert.equal(Math.round(prof.Tusker.avgDay * 100) / 100, 15.71);
  assert.deepEqual(prof.Tusker.perDay, [10, 10, 10, 10, 40, 20, 10]);
  assert.equal(prof.Tusker.avgPrice, 300);
});

ok('stock up for a day: one card per busy weekday (the two with the most extra sales), the top 3 named, units not KES', () => {
  const r = R.recStockUp(base);
  assert.deepEqual(r.map((x) => x.title), ['Stock up for Friday: Tusker and 1 more', 'Stock up for Saturday: Chips and 1 more']);
  assert.equal(r[0].why, 'Fridays: you sell about 40 Tusker (vs 16 on an average day) and 15 Nyama (vs 8).');
  assert.deepEqual(r[0].stock, { by: 'Friday', items: [{ name: 'Tusker', qty: 45 }, { name: 'Nyama', qty: 17 }] });
  assert.equal(r[1].why, 'Saturdays: you sell about 30 Chips (vs 12 on an average day) and 15 Nyama (vs 8).');
  assert.deepEqual(r[1].stock.items, [{ name: 'Chips', qty: 35 }, { name: 'Nyama', qty: 17 }]);
  assert.deepEqual([r[0].impact, r[0].impactKind, r[0].kind, r[0].evidence, r[0].confidence], [null, null, 'stock_up', 'times', 'high']);
  assert.equal(r[0].assumption, 'The average Friday in this period (4 of them), plus 10% so a busier one does not run you out, rounded up.');
  // one item alone: its quantity in the title
  const solo = R.summariseItemTimes([irow('Tusker', PLAN.Tusker), irow('Tea', PLAN.Tea), totalOf([irow('Tusker', PLAN.Tusker), irow('Tea', PLAN.Tea)])], 0);
  assert.deepEqual(R.recStockUp({ ...base, times: solo }).map((x) => x.title), ['Stock up for Friday: 45 Tusker']);
  // two of each weekday: still enough, at "Good evidence"
  const two = R.summariseItemTimes([irow('Tusker', PLAN.Tusker, 2), totalOf([irow('Tusker', PLAN.Tusker, 2)])], 0);
  const r2 = R.recStockUp({ ...base, days: 14, from: '2026-10-05', to: '2026-10-18', times: two });
  assert.deepEqual([r2[0].title, r2[0].confidence], ['Stock up for Friday: 45 Tusker', 'medium']);
  assert.deepEqual(R.recStockUp({ ...base, days: 13, from: '2026-10-06', to: '2026-10-18', times: two }), [], 'under two weeks: no stock advice');
  assert.deepEqual(R.recStockUp({ ...base, from: undefined }), [], 'no period: no weekday counts');
  assert.deepEqual(R.recStockUp({ ...base, times: null }), []);
});

ok('running low: on hand below what sells to the end of the next busy day — order up to it + 10%; KES = sales at risk', () => {
  const S = (o) => Object.entries(o).map(([n, q]) => ({ productId: `id-${n}`, onHand: q }));
  // Wednesday 21 October: Tusker's next busy day is Friday (Wed 10 + Thu 10 + Fri 40 = 60)
  const [r] = R.recRunningLow(at('2026-10-21', S({ Tusker: 40, Nyama: 100, Chips: 70, Tea: 50, Mints: 10 })));
  assert.equal(r.title, 'Order about 30 more Tusker before Friday');
  assert.equal(r.why, 'You have 40 Tusker; a normal Friday sells about 40, and from today to the end of Friday about 60.');
  assert.deepEqual(r.stock, { by: 'Friday', items: [{ name: 'Tusker', qty: 70, onHand: 40, order: 30 }] });
  assert.deepEqual([r.impact, r.impactPer, r.impactKind, r.kind, r.warning], [(60 - 40) * 300, 'once', 'at_risk', 'stock_low', false]);
  assert.match(r.assumption, /sales at risk, not profit\)\.$/);
  // Friday itself
  const [f] = R.recRunningLow(at('2026-10-16', S({ Tusker: 12 })));
  assert.equal(f.title, 'Order about 33 more Tusker today');
  assert.equal(f.why, 'You have 12 Tusker; a normal Friday (today) sells about 40.');
  assert.deepEqual(R.recRunningLow(at('2026-10-16', S({ Tusker: 40 }))), [], 'on hand covers a normal Friday');
  // no busy day ahead: today and tomorrow
  const [t] = R.recRunningLow(at('2026-10-21', S({ Tea: 5 })));
  assert.equal(t.title, 'Order about 25 more Tea');
  assert.equal(t.why, 'You have 5 Tea; you usually sell about 24 today and tomorrow.');
  assert.equal(t.stock.by, 'tomorrow');
  assert.deepEqual(R.recRunningLow(at('2026-10-21', S({ Mints: 1 }))), [], 'needs 3, has 1: under the 3-unit shortfall');
  assert.deepEqual(R.recRunningLow(at('2026-10-21', S({ Tea: -3 }))), [], 'a negative level is nobody counting');
  // without stock levels: none
  assert.deepEqual(R.recRunningLow(at('2026-10-21', null)), []);
  assert.deepEqual(R.recRunningLow(at('2026-10-21', [])), []);
  assert.deepEqual(R.recRunningLow({ ...at(undefined, S({ Tusker: 0 })) }), [], 'no today: no horizon');
  // at most two, the most at risk first
  const many = R.recRunningLow(at('2026-10-21', S({ Tusker: 0, Nyama: 0, Chips: 0, Tea: 0 })));
  assert.deepEqual(many.map((x) => x.stock.items[0].name), ['Nyama', 'Tusker'], 'Nyama 25 × 1,000 then Tusker 60 × 300');
});

ok('the week at a glance: each weekday the period holds, its top 3 and their typical sales', () => {
  const w = R.weekPlan(times, FROM, TO);
  assert.equal(w.length, 7);
  assert.deepEqual(w[4], { dow: 4, day: 'Friday', count: 4, top: [{ productId: 'id-Tusker', name: 'Tusker', qty: 40 }, { productId: 'id-Nyama', name: 'Nyama', qty: 15 }, { productId: 'id-Tea', name: 'Tea', qty: 12 }] });
  assert.deepEqual(w[0].top.map((x) => [x.name, x.qty]), [['Tea', 12], ['Tusker', 10], ['Chips', 9]]);
  assert.ok(w.every((d) => d.top.length <= 3));
  assert.deepEqual(R.weekPlan(times, '2026-10-19', '2026-10-21').map((d) => [d.day, d.count]), [['Monday', 1], ['Tuesday', 1], ['Wednesday', 1]]);
  assert.deepEqual(R.weekPlan(null, FROM, TO), []);
});

// a menu for the slow movers: 28 days, under 2 a week = under 8 sold
const mrow = (name, qty, price, cost) => ({ product_id: `id-${name}`, product_name: name, category_name: null, qty, revenue: qty * price, unit_cost: cost, cost_source: 'product' });
const SLOW_MENU = [mrow('Tusker', 400, 300, 200), mrow('Nyama', 200, 1000, 500), mrow('Chips', 300, 200, 60), mrow('Tea', 300, 50, 10),
  mrow('Soda', 200, 80, 50), mrow('Cake', 8, 400, 150), mrow('Soup', 3, 300, 280), mrow('Fish', 7, 1500, 400)];
ok('slow movers: under 2 a week over four weeks at least; never when half the list is slow; never a Dog already named', () => {
  const menu = R.classifyMenu(SLOW_MENU);
  const [r] = R.recSlowMovers({ ...base, menu });
  assert.equal(r.title, 'Stock less of 2 slow sellers');
  assert.equal(r.why, 'Soup (3) and Fish (7) sold in 28 days — under 2 a week each. Consider stocking less, or dropping them.', 'Cake sold 8: 2 a week, not under');
  assert.deepEqual([r.impact, r.kind, r.evidence, r.confidence], [null, 'slow', 'menu', 'medium']);
  assert.deepEqual(R.recSlowMovers({ ...base, menu, days: 27 }), [], 'under four weeks: never "stock less"');
  assert.equal(R.recSlowMovers({ ...base, menu, days: 56 })[0].confidence, 'high');
  // with costs, Soup is a Dog the rework card names — the slow movers leave it out
  const soupDog = R.classifyMenu(SLOW_MENU);
  assert.equal(soupDog.items.find((x) => x.name === 'Soup').class, 'dog');
  const withCosts = { ...base, costs: true, menu: soupDog };
  assert.deepEqual(R.recRework(withCosts).map((x) => x.title), ['Rework or drop Soup']);
  assert.deepEqual(R.recSlowMovers(withCosts).map((x) => [x.title, x.why]), [['Stock less of Fish', 'Fish (7) sold in 28 days — under 2 a week. Consider stocking less, or dropping it.']]);
  // half the list slow: a quiet business, not a slow item
  const quiet = R.classifyMenu([...SLOW_MENU.slice(0, 4), mrow('A', 2, 100, 50), mrow('B', 2, 100, 50), mrow('C', 2, 100, 50), mrow('D', 2, 100, 50)]);
  assert.deepEqual(R.recSlowMovers({ ...base, menu: quiet }), []);
  // no menu (costs withheld): what sells when, only when it holds every product
  const tail = [irow('Tusker', PLAN.Tusker), irow('Nyama', PLAN.Nyama), irow('Chips', PLAN.Chips), irow('Tea', PLAN.Tea), irow('Mints', PLAN.Mints), irow('Gum', { price: 10, day: [1, 0, 0, 0, 0, 0, 0] })];
  const full = R.summariseItemTimes([...tail, totalOf(tail)], 0);
  const [t] = R.recSlowMovers({ ...base, times: full });
  assert.deepEqual([t.title, t.evidence], ['Stock less of Gum', 'times']);
  const cut = R.summariseItemTimes([...tail, totalOf(tail)], 0, 6);
  assert.equal(cut.limited, true);
  assert.deepEqual(R.recSlowMovers({ ...base, times: cut }), [], 'only the best sellers were sent: the tail is unknown');
});

// money leaks: Otieno voids 20 of 100 and discounts 10 of 80 against medians of 2%
const lrow = (id, orders, voids, voidValue, discounts = 0, discountValue = 0) => ({ by_cashier: true, cashier_id: id, day: null, orders, voids, void_value: voidValue, item_voids: 0, item_void_value: 0, refunds: 0, refund_value: 0, discounts, discount_value: discountValue, wastage: 0, wastage_value: 0, drawer_variance: 0, day_close_variance: 0 });
const leaks = R.summariseLeaks([lrow('a', 100, 2, 2000, 2, 400), lrow('b', 100, 2, 2000, 2, 400), lrow('v', 100, 20, 20000, 10, 5000)], { a: 'Amina', b: 'Baraka', v: 'Otieno' });

ok('voids and discounts: a warning to look into — no estimate, never in the value line', () => {
  const r = R.recLeaks({ ...base, leaks });
  assert.deepEqual(r.map((x) => x.title), ["Check Otieno's voids", "Check Otieno's discounts"]);
  assert.equal(r[0].why, '20 voids (KES 20,000) in 28 days — 10.0× the branch median rate. Worth a look; a void before payment is not always a loss.');
  assert.equal(r[1].why, '10 discounts (KES 5,000) in 28 days — 6.1× the branch median rate. Worth a look; some discounts are offers you approved.');
  for (const x of r) assert.deepEqual([x.impact, x.impactPer, x.impactKind, x.warning, x.stock], [null, null, null, true, null]);
  const v = R.valueFound(r);
  assert.deepEqual([v.monthly, v.once, v.atRisk, v.count, v.warnings], [0, 0, 0, 0, 2]);
  assert.equal(v.line, 'This period: 2 things to act on — 2 warnings to look into.');
  // even a warning that somehow carried a figure is not counted
  const forced = R.valueFound([{ ...r[0], impact: 5000, impactPer: 'month', impactKind: 'recover' }]);
  assert.equal(forced.monthly, 0);
});

ok('the value line: the busy days, the items running low (sales at risk), old credit, the monthly ideas, the warnings', () => {
  const crow = (id, name, d61, owed) => ({ customer_id: id, customer_name: name, phone: null, balance: owed, owed, d0_30: owed - d61, d31_60: 0, d61_90: d61, d90_plus: 0, unaged: 0, oldest_at: null, disputed_count: 0, disputed_amount: 0 });
  const credit = R.summariseCredit([crow('k1', 'County Office', 30000, 40000)]);
  const recs = R.buildRecommendations({ ...at('2026-10-21', [{ productId: 'id-Tusker', onHand: 40 }]), leaks, credit });
  const v = R.valueFound(recs);
  assert.equal(v.line, 'This period: 6 things to act on — stock up for 2 busy days, 1 item running low (about KES 6,000 of sales at risk if it runs out), KES 30,000 of old credit to collect and 2 warnings to look into.');
  assert.deepEqual([v.stockDays, v.lowItems, v.atRisk, v.once, v.monthly], [2, 1, 6000, 30000, 0]);
});

ok('the ranking: stock-out risks first, then stocking up for a day, then the rest by the KES at stake; at most 7', () => {
  const crow = { customer_id: 'k1', customer_name: 'County Office', phone: null, balance: 90000, owed: 90000, d0_30: 0, d31_60: 0, d61_90: 90000, d90_plus: 0, unaged: 0, oldest_at: null, disputed_count: 0, disputed_amount: 0 };
  const recs = R.buildRecommendations({ ...at('2026-10-21', [{ productId: 'id-Tusker', onHand: 0 }, { productId: 'id-Tea', onHand: 0 }]), leaks, credit: R.summariseCredit([crow]), menu: R.classifyMenu(SLOW_MENU) });
  assert.deepEqual(recs.map((x) => x.kind), ['stock_low', 'stock_low', 'stock_up', 'stock_up', 'credit', 'leak', 'leak'],
    'KES 90,000 of credit still comes after a KES 18,000 stock-out risk; the slow movers fall off the cap of 7');
  const r = R.rankRecommendations([
    { id: 'c', kind: 'credit', impact: 90000, confidence: 'high' }, { id: 'u', kind: 'stock_up', impact: null, confidence: 'medium' },
    { id: 'l', kind: 'stock_low', impact: 10, confidence: 'medium' }, { id: 'w', kind: 'leak', impact: null, confidence: 'high' },
  ]);
  assert.deepEqual(r.map((x) => x.id), ['l', 'u', 'c', 'w']);
  // a warning (no estimate) keeps the last place of "the rest" when the KES cards would push it off
  const crowd = [...Array.from({ length: 7 }, (_, k) => ({ id: `g${k}`, kind: 'promote', impact: 1000 - k, confidence: 'low' })),
    { id: 'w', kind: 'leak', impact: null, confidence: 'high', warning: true }];
  assert.deepEqual(R.rankRecommendations(crowd).map((x) => x.id), ['g0', 'g1', 'g2', 'g3', 'g4', 'g5', 'w']);
  const stocky = [...Array.from({ length: 7 }, (_, k) => ({ id: `s${k}`, kind: 'stock_up', impact: null, confidence: 'high' })),
    { id: 'w', kind: 'leak', impact: null, confidence: 'high', warning: true }];
  assert.ok(!R.rankRecommendations(stocky).some((x) => x.id === 'w'), 'never in place of a stock card');
});

ok('no price wording: no generated title, reason, assumption, value line, insight or summary says price, raise or re-price', () => {
  // the A558 scenario's menu (two Plowhorses), a full week, credit, flagged cashiers, stock levels — every rule that can fire
  const menu = R.classifyMenu([mrow('Tusker', 300, 300, 250), mrow('Nyama', 200, 1000, 500), mrow('Chips', 150, 200, 50), mrow('Fish', 30, 1200, 400),
    mrow('Soup', 20, 300, 280), { ...mrow('Special', 60, 500, null), unit_cost: null, cost_source: null }, mrow('Cake', 5, 400, 150), mrow('Gum', 3, 50, 10)]);
  assert.ok(menu.items.filter((x) => x.class === 'plowhorse').length >= 2, 'Plowhorses present');
  const heatRows = [];
  for (let dow = 1; dow <= 7; dow++) for (let h = 10; h <= 22; h++) heatRows.push({ dow, hour: h, revenue: dow === 5 && h >= 18 && h <= 20 ? 10000 : dow === 2 && (h === 15 || h === 16) ? 100 : 1000, orders: 2 });
  const heatmap = R.summariseHeatmap(heatRows);
  const credit = R.summariseCredit([{ customer_id: 'k1', customer_name: 'County Office', phone: null, balance: 40000, owed: 40000, d0_30: 10000, d31_60: 0, d61_90: 30000, d90_plus: 0, unaged: 0, oldest_at: null, disputed_count: 1, disputed_amount: 500 }]);
  const input = { ...at('2026-10-21', [{ productId: 'id-Tusker', onHand: 3 }, { productId: 'id-Tea', onHand: 2 }]), costs: true, menu, heatmap, leaks, credit };
  const every = [R.recRunningLow, R.recStockUp, R.recSlowMovers, R.recPromote, R.recRework, R.recStaffing, R.recQuietSlot, R.recLeaks, R.recDayClose, R.recCredit, R.recCostData]
    .flatMap((f) => f(input));
  assert.ok(new Set(every.map((x) => x.kind)).size >= 9, `most rules fired: ${[...new Set(every.map((x) => x.kind))]}`);
  const recs = R.buildRecommendations(input);
  const found = R.valueFound(recs);
  const insights = R.buildInsights({ menu, heatmap, leaks, credit });
  assert.ok(insights.some((x) => x.id.startsWith('menu.plowhorse')), 'the Plowhorse insight is there');
  const kpi = (value, change) => ({ value, prev: null, change });
  const summary = R.buildSummary({ from: FROM, to: TO, today: '2026-10-21', recommendations: recs,
    overview: { kpis: { revenue: kpi(500000, 0.1), orders: kpi(900, 0.02), avgBill: kpi(3021, 0.08), margin: kpi(0.5, 0.02), atRisk: kpi(4000, 0.2) }, wastageHidden: false } });
  const texts = [
    ...every.flatMap((x) => [x.title, x.why, x.assumption, ...(x.stock ? x.stock.items.map((s) => s.name) : [])]),
    found.line, ...insights.map((x) => x.text), summary.good, summary.worry,
  ].filter(Boolean);
  for (const t of texts) assert.ok(!/\bprices?\b|\brais(e|es|ing)\b|re-?pric|price rise/i.test(t), `price wording: ${t}`);
  assert.ok(insights.find((x) => x.id.startsWith('menu.plowhorse')).text.endsWith('– check the recipe cost or portion, or pair it with a higher-margin item'));
  assert.equal(R.recPriceRise, undefined, 'the rule is gone');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
