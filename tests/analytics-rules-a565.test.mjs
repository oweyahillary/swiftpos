/**
 * analytics-rules-a565.test.mjs — A565: Analytics suggests moving stock between branches and flags a branch that falls
 * behind. Every new rule of apps/server/src/lib/analyticsRules.ts (compiled), run directly:
 *   - who is short (under 3 days of cover, or under a week while selling ≥ 2× the other branches) and who has plenty (over
 *     30 days, or over 3× the median cover; ≥ 10 on hand; a branch that sold none counts);
 *   - the internal quantity never leaves the surplus branch under 14 days of its own sales; the minimum data (14 days,
 *     10 used, two branches);
 *   - the owner's correction ("it should be a recommendation so it should not show number"): titles and reasons in words —
 *     no digit except an "about N a day" rate — no quantity or KES on a card or a suggestion, and moves grouped (the same
 *     two branches, the same way: one card naming up to 3 items);
 *   - the ranking (with the stock-out risks, at most 3 move cards) and the de-dupe with the run-out card of the branch in
 *     view; the value line counts moves, never values them;
 *   - the branch comparison and the falling-branch card (its own previous period, 10 points worse than the rest, 30 bills
 *     before; a quiet month for everyone flags no branch); no price wording; the Branches tile hidden with one branch or
 *     for a viewer held to one; the page helpers (chartMath.ts read as TypeScript).
 *
 *   cd apps/server && npm run build && cd ../.. && node tests/analytics-rules-a565.test.mjs
 *
 * MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted — listed in the A565 report):
 *   - stockMoves without the MOVE_KEEP_DAYS floor (the surplus gives what it holds)   → "the floor" fails
 *   - shortsOf without the MOVE_MIN_USED floor                                       → "minimum data" fails
 *   - moveSuggestions not grouping (one card per item)                                → "grouping" fails
 *   - the why line naming the internal quantity ("consider moving 90")                → "grouping" and "de-dupe" fail
 *   - allRecommendations without the run-out de-dupe                                  → "de-dupe" fails
 *   - kindGroup without stock_move                                                    → "ranking" fails
 *   - compareBranches without the 10-point gap to the other branches                  → "branch comparison" fails
 *   - visibleAreas showing Branches without the cloud's hook                         → "the page" fails
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
console.log('\nA565 — stock between branches, the branch that falls behind\n');

const W = { id: 'b-w', name: 'Westlands' }, N = { id: 'b-n', name: 'Ngong Road' }, K = { id: 'b-k', name: 'Kilimani' };
const srow = (name, used, onHand, extra = {}) => ({ kind: 'product', item_id: `id-${name}`, item_name: name, unit: null, by_piece: false, sold: used, wasted: 0, prev_sold: 0, prev_wasted: 0, on_hand: onHand, ...extra });
const use = (rows, days = 30) => R.summariseStockUse(rows, days, true);
/** Tusker: Westlands sells 2 a day and holds 120 (60 days); Ngong Road sells 18 a day and has 10 left (under a day). */
const tusker = () => ({ [W.id]: use([srow('Tusker lager', 60, 120)]), [N.id]: use([srow('Tusker lager', 540, 10)]) });
const prices = { 'id-Tusker lager': 300, 'id-Chips': 150, 'id-Soda': 50, 'id-Mandazi': 20, 'id-Water': 60 };
const base = (extra) => ({ days: 30, costs: true, menu: null, heatmap: null, leaks: null, credit: null, times: null, ...extra });
/** Digits are allowed only in an "about N a day" rate (the owner's own example) — never a quantity, a stock count or KES. */
const numbersOutsideRate = (t) => t.replace(/about \d+ a day/g, '').match(/\d|KES/g);

ok('who is short and who has plenty: under 3 days, or under a week selling ≥ 2× the others; over 30 days or 3× the median', () => {
  const m = R.stockMoves({ days: 30, branches: [W, N], stock: tusker(), prices });
  assert.equal(m.length, 1);
  assert.deepEqual([m[0].from, m[0].to, m[0].name], ['Westlands', 'Ngong Road', 'Tusker lager']);
  assert.deepEqual([m[0].source.cover, m[0].target.cover], [60, 0.6]);
  // 5 days of cover: short only while selling ≥ 2× the other branches a day
  const fast = { [W.id]: use([srow('Gin', 60, 120)]), [N.id]: use([srow('Gin', 300, 50)]) };   // 10 a day vs 2 → fast, 5 days
  assert.equal(R.stockMoves({ days: 30, branches: [W, N], stock: fast }).length, 1, 'fast seller with 5 days');
  const even = { [W.id]: use([srow('Gin', 240, 400)]), [N.id]: use([srow('Gin', 300, 50)]) };  // 8 vs 10 a day: not fast
  assert.equal(R.stockMoves({ days: 30, branches: [W, N], stock: even }).length, 0, '5 days but not selling 2× the others');
  const three = { [W.id]: use([srow('Gin', 60, 120)]), [N.id]: use([srow('Gin', 90, 9)]) };    // exactly 3 days, 3 a day vs 2
  assert.equal(R.stockMoves({ days: 30, branches: [W, N], stock: three }).length, 0, 'exactly 3 days is not under 3; 1.5× is not fast');
  // the source: 25 days of cover is not plenty (not over 30, and the median cover is 12.8 → 3× = 38)
  const thin = { [W.id]: use([srow('Gin', 60, 50)]), [N.id]: use([srow('Gin', 540, 10)]) };
  assert.equal(R.stockMoves({ days: 30, branches: [W, N], stock: thin }).length, 0, '25 days is not plenty');
  // a branch that sold none and holds some is a source; under 10 on hand is not
  const idle = { [W.id]: use([srow('Gin', 0, 40, { prev_sold: 5 })]), [N.id]: use([srow('Gin', 540, 10)]) };
  assert.equal(R.stockMoves({ days: 30, branches: [W, N], stock: idle }).length, 1, 'none sold at Westlands');
  const few = { [W.id]: use([srow('Gin', 0, 9, { prev_sold: 5 })]), [N.id]: use([srow('Gin', 540, 10)]) };
  assert.equal(R.stockMoves({ days: 30, branches: [W, N], stock: few }).length, 0, 'under 10 on hand');
  // a level read elsewhere (the item not used there in either period) counts as a source
  const elsewhere = { [W.id]: use([]), [N.id]: use([srow('Gin', 540, 10)]) };
  assert.deepEqual(R.moveCandidates({ days: 30, branches: [W, N], stock: elsewhere }), [{ kind: 'product', itemId: 'id-Gin' }]);
  const lv = [{ kind: 'product', itemId: 'id-Gin', branchId: W.id, onHand: 80 }, { kind: 'product', itemId: 'id-Gin', branchId: K.id, onHand: -4 }];
  assert.equal(R.stockMoves({ days: 30, branches: [W, N, K], stock: elsewhere, levels: lv })[0].from, 'Westlands', 'a negative level is never a source');
});

ok('the floor: the internal quantity brings the short branch toward a week and never leaves the surplus under 14 days', () => {
  const [m] = R.stockMoves({ days: 30, branches: [W, N], stock: tusker(), prices });
  // need = 7 × 18 − 10 = 116 → 120 up; can spare = 120 − 14 × 2 = 92 → 90 down; the smaller
  assert.equal(m.qty, 90);
  assert.ok(120 - m.qty >= 14 * 2, 'Westlands keeps two weeks of its own sales');
  // a source with little to spare: 64 on hand, 2 a day (32 days) → spare 36 → 35
  const tight = R.stockMoves({ days: 30, branches: [W, N], stock: { [W.id]: use([srow('Tusker lager', 60, 64)]), [N.id]: use([srow('Tusker lager', 540, 10)]) } });
  assert.equal(tight[0].qty, 35);
  assert.ok(64 - tight[0].qty >= 28);
  // two short branches share one source: neither takes it under its floor
  const two = R.stockMoves({ days: 30, branches: [W, N, K], stock: { [W.id]: use([srow('Tusker lager', 60, 120)]), [N.id]: use([srow('Tusker lager', 540, 10)]), [K.id]: use([srow('Tusker lager', 300, 5)]) } });
  assert.ok(two.reduce((s, x) => s + x.qty, 0) <= 120 - 28, two.map((x) => x.qty).join(','));
  assert.equal(R.stepRound(116, true), 120);
  assert.equal(R.stepRound(92, false), 90);
  assert.equal(R.stepRound(17.2, true), 18);
});

ok('minimum data: two weeks, 10 used at the short branch, two branches', () => {
  assert.equal(R.stockMoves({ days: 13, branches: [W, N], stock: tusker() }).length, 0, '13 days');
  const quiet = { [W.id]: use([srow('Gin', 60, 120)]), [N.id]: use([srow('Gin', 9, 0)]) };
  assert.equal(R.stockMoves({ days: 30, branches: [W, N], stock: quiet }).length, 0, 'used 9 at the short branch');
  assert.equal(R.stockMoves({ days: 30, branches: [W], stock: tusker() }).length, 0, 'one branch');
  assert.deepEqual(R.recStockMoves(base({ days: 13, moves: R.stockMoves({ days: 30, branches: [W, N], stock: tusker() }) })), []);
});

ok('grouping: the same two branches the same way → one card naming up to 3 items; another pair, another card', () => {
  const stock = {
    [K.id]: use([srow('Chips', 30, 200), srow('Soda', 30, 300), srow('Mandazi', 30, 200), srow('Water', 30, 200)]),
    [N.id]: use([srow('Chips', 300, 5), srow('Soda', 300, 8), srow('Mandazi', 300, 6), srow('Water', 300, 4)]),
    [W.id]: use([srow('Tusker lager', 60, 120)]),
  };
  stock[N.id] = use([...stock[N.id].items.map((x) => srow(x.name, x.used, x.onHand)), srow('Tusker lager', 540, 10)]);
  const moves = R.stockMoves({ days: 30, branches: [K, N, W], stock, prices });
  assert.equal(moves.length, 5);
  const s = R.moveSuggestions(moves);
  assert.equal(s.length, 2, 'Kilimani → Ngong Road and Westlands → Ngong Road');
  const kn = s.find((x) => x.move.from === 'Kilimani');
  assert.equal(kn.move.items.length, 3, 'at most 3 named');
  assert.deepEqual(kn.move.items.map((x) => x.name), ['Chips', 'Water', 'Soda'], 'the best scored first');
  assert.equal(kn.title, 'Consider moving some stock from Kilimani to Ngong Road');
  assert.equal(kn.why, 'Chips, Water and Soda are moving slowly at Kilimani but sell fast at Ngong Road, where some are about to run out — consider moving some across.');
  const wn = s.find((x) => x.move.from === 'Westlands');
  assert.equal(wn.title, 'Consider moving some Tusker lager from Westlands to Ngong Road');
  assert.equal(wn.why, 'Tusker lager sells well at Ngong Road (about 18 a day) and is about to run out there, but sells slowly at Westlands, where you hold plenty — consider moving some to Ngong Road.');
  assert.equal(s[0].move.from, 'Westlands', 'ranked by what would otherwise run short × its average price');
  assert.deepEqual(R.moveSuggestions(moves, W.id).map((x) => x.move.from), ['Westlands'], 'the branch in view: only the moves touching it');
});

ok('no numbers: no quantity, stock count or KES in a movement title or reason (an "about N a day" rate only); no quantity sent', () => {
  const stock = { [W.id]: use([srow('Tusker lager', 60, 120), srow('Gin', 0, 50, { prev_sold: 4 })]), [N.id]: use([srow('Tusker lager', 540, 10), srow('Gin', 20, 1)]) };
  const moves = R.stockMoves({ days: 30, branches: [W, N], stock, prices });
  const recs = R.recStockMoves(base({ moves }));
  assert.ok(recs.length >= 1);
  for (const r of recs) {
    for (const t of [r.title, r.why]) assert.equal(numbersOutsideRate(t), null, `numbers in: ${t}`);
    assert.ok(!/\bprices?\b|\brais(e|es|ing)\b|re-?pric/i.test(`${r.title} ${r.why} ${r.assumption}`), r.title);
    assert.deepEqual([r.impact, r.impactKind, r.impactPer, r.stock, r.kind, r.evidence], [null, null, null, null, 'stock_move', 'branches']);
    assert.deepEqual(Object.keys(r.move).sort(), ['from', 'fromId', 'items', 'to', 'toId']);
    for (const it of r.move.items) assert.deepEqual(Object.keys(it).sort(), ['itemId', 'kind', 'name']);
    assert.ok(!JSON.stringify(r.move).match(/qty|quantity|onHand|cover/));
  }
  for (const s of R.moveSuggestions(moves)) assert.deepEqual(Object.keys(s).sort(), ['id', 'move', 'score', 'title', 'why'], 'the route drops score before sending');
  assert.match(recs[0].assumption, /how much to move is your call/);
});

ok('ranking: move cards with the stock-out risks, at most 3; the value line counts them, never values them', () => {
  const pairs = [['A', 'Ai'], ['B', 'Bi'], ['C', 'Ci'], ['D', 'Di']].map(([a]) => ({ id: `b-${a}`, name: `Branch ${a}` }));
  const hub = { id: 'b-hub', name: 'Hub' };
  const stock = { [hub.id]: use(pairs.map((p, k) => srow(`Item ${k}`, 30, 400))) };
  pairs.forEach((p, k) => { stock[p.id] = use([srow(`Item ${k}`, 300, 5)]); });
  const moves = R.stockMoves({ days: 30, branches: [hub, ...pairs], stock });
  const cards = R.recStockMoves(base({ moves }));
  assert.equal(cards.length, 3, 'four pairs, three cards');
  const credit = R.summariseCredit([{ customer_id: 'k', customer_name: 'County', phone: null, balance: 87400, owed: 87400, d0_30: 0, d31_60: 0, d61_90: 87400, d90_plus: 0, unaged: 0, oldest_at: null, disputed_count: 0, disputed_amount: 0 }]);
  const ranked = R.buildRecommendations(base({ moves, credit }));
  assert.deepEqual(ranked.slice(0, 3).map((x) => x.kind), ['stock_move', 'stock_move', 'stock_move'], 'before the credit card (which has KES)');
  const f = R.valueFound(ranked);
  assert.equal(f.moves, 3);
  assert.equal(f.line, 'This period: 4 things to act on — 3 stock moves between branches to consider and KES 87,400 of old credit to collect.');
  assert.deepEqual([f.monthly, f.atRisk], [0, 0]);
});

ok('de-dupe: a move into the branch in view replaces its run-out card for that item (merged); other branches keep theirs', () => {
  const moves = R.stockMoves({ days: 30, branches: [W, N], stock: tusker(), prices });
  const atN = use([srow('Tusker lager', 540, 10), srow('Rice', 300, 5)]);   // Rice runs out too, no move for it
  const recs = R.allRecommendations(base({ moves, stockUse: atN, branchInView: N.id }));
  assert.ok(!recs.some((x) => x.kind === 'stock_out' && /Tusker/.test(x.title)), 'the Tusker run-out card is replaced');
  assert.ok(recs.some((x) => x.kind === 'stock_out' && /Rice/.test(x.title)), 'Rice keeps its card');
  const mv = recs.find((x) => x.kind === 'stock_move');
  assert.match(mv.why, / If Westlands cannot spare enough, order the rest\.$/);
  assert.equal(numbersOutsideRate(mv.why), null);
  // without the move (or the branch in view elsewhere) the run-out card stays
  assert.ok(R.allRecommendations(base({ stockUse: atN, branchInView: N.id })).some((x) => x.kind === 'stock_out' && /Tusker/.test(x.title)));
  const atK = R.allRecommendations(base({ moves, stockUse: atN, branchInView: K.id }));
  assert.ok(!atK.some((x) => x.kind === 'stock_move'), 'a move not touching the branch in view is not shown there');
});

const day = (d, revenue, orders) => ({ day: d, method: null, revenue, orders });
/** `now` and `prev` sales spread over 30 days each (2026-09-22 .. 10-21, previous 08-23 .. 09-21). */
const series = (now, prev, ordersNow = 60, ordersPrev = 60) => {
  const out = [];
  for (let i = 0; i < 30; i++) {
    const a = new Date(Date.UTC(2026, 8, 22 + i)).toISOString().slice(0, 10), b = new Date(Date.UTC(2026, 7, 23 + i)).toISOString().slice(0, 10);
    out.push(day(a, now / 30, ordersNow / 30), day(b, prev / 30, ordersPrev / 30));
  }
  out.push({ day: '2026-10-01', method: 'cash', revenue: 999999, orders: 1 });   // a payment row: never counted
  return out;
};
const FROM = '2026-09-22', TO = '2026-10-21';

ok('branch comparison: its own previous period, 10 points worse than the rest, 30 bills before; a quiet month flags no one', () => {
  const c = R.compareBranches({ from: FROM, to: TO, branches: [W, N, K], margins: null,
    daily: { [W.id]: series(72000, 100000), [N.id]: series(220000, 200000), [K.id]: series(9000, 10000) } });
  const w = c.rows.find((r) => r.name === 'Westlands');
  assert.deepEqual([w.change, w.flagged, w.perDay, w.avgBill, w.tradingDays], [-0.28, true, 2400, 1200, 30]);
  assert.equal(w.reason, 'Sales fell 28% against the previous 30 days, while the other branches together sold 9.0% more.');
  assert.equal(c.rows.find((r) => r.name === 'Kilimani').flagged, false, 'a small kiosk down 10% is not flagged for being small');
  assert.deepEqual(c.rows.map((r) => r.name), ['Ngong Road', 'Westlands', 'Kilimani'], 'by sales');
  assert.deepEqual([c.marginHidden, w.margin], [true, null]);
  assert.deepEqual(c.underperforming.map((r) => r.name), ['Westlands']);
  // everyone down about a quarter: a quiet month, no branch singled out
  const quiet = R.compareBranches({ from: FROM, to: TO, branches: [W, N], margins: null, daily: { [W.id]: series(72000, 100000), [N.id]: series(150000, 200000) } });
  assert.deepEqual(quiet.underperforming, []);
  // under 30 bills before: nothing to compare against
  const few = R.compareBranches({ from: FROM, to: TO, branches: [W, N], margins: null, daily: { [W.id]: series(7200, 10000, 20, 29), [N.id]: series(220000, 200000) } });
  assert.deepEqual(few.underperforming, []);
  const withCosts = R.compareBranches({ from: FROM, to: TO, branches: [W, N], margins: { [W.id]: 0.55, [N.id]: null }, daily: { [W.id]: series(1, 1), [N.id]: series(1, 1) } });
  assert.deepEqual([withCosts.marginHidden, withCosts.rows.find((r) => r.id === W.id).margin], [false, 0.55]);
  const many = Array.from({ length: 12 }, (_, k) => ({ id: `x${k}`, name: `Branch ${String.fromCharCode(65 + k)}` }));
  const big = R.compareBranches({ from: FROM, to: TO, branches: many, margins: null, daily: {} });
  assert.deepEqual([big.rows.length, big.total], [10, 12]);
});

ok('the falling-branch card: in words with the stock moving slowly there; no KES, no price; the branch in view only', () => {
  const moves = R.stockMoves({ days: 30, branches: [W, N], stock: tusker(), prices });
  const bc = R.compareBranches({ from: FROM, to: TO, branches: [W, N], margins: null, moves, daily: { [W.id]: series(72000, 100000), [N.id]: series(220000, 200000) } });
  assert.equal(bc.rows.find((r) => r.id === W.id).slowOut, 1);
  const [card] = R.recBranchDrop(base({ branchCompare: bc, moves }));
  assert.equal(card.title, 'Sales at Westlands fell 28% against the previous 30 days');
  assert.equal(card.why, 'Sales fell 28% against the previous 30 days, while the other branches together sold 10% more. Its stock is moving slowly — some of it may sell faster at Ngong Road. Look at what sells when at Westlands to see which hours and items dropped.');
  assert.deepEqual([card.impact, card.branchId, card.evidence, card.kind], [null, W.id, 'branches', 'branch_drop']);
  assert.match(card.assumption, /never flagged for being small/);
  assert.deepEqual(R.recBranchDrop(base({ branchCompare: bc, branchInView: N.id })), [], 'Ngong Road in view: not about it');
  assert.deepEqual(R.recBranchDrop(base({ days: 13, branchCompare: bc })), []);
  const texts = [card.title, card.why, card.assumption, R.BRANCH_BASIS, R.MOVE_BASIS];
  for (const t of texts) assert.ok(!/\bprices?\b|\brais(e|es|ing)\b|re-?pric|price rise/i.test(t), `price wording: ${t}`);
});

ok('the Branches tile: hidden with one branch or a viewer held to one; its hook; a card points there', () => {
  const none = { costs: true, seesCredit: true, menu: null, heatmap: null, leaks: null, credit: null, stockUse: null, customers: null, costWatch: null, recommendations: [] };
  assert.equal(R.tileHooks(none).branches.hidden, true, 'no branch input: hidden');
  assert.equal(R.tileHooks({ ...none, branches: null }).branches.hidden, true);
  const moves = R.recStockMoves(base({ moves: R.stockMoves({ days: 30, branches: [W, N], stock: tusker(), prices }) }));
  const h = R.tileHooks({ ...none, branches: { count: 2, moves: 1, underperforming: [] }, recommendations: moves });
  assert.deepEqual([h.branches.hidden, h.branches.text, h.branches.alert, h.stock.alert], [false, '1 stock move to consider', true, false]);
  assert.equal(R.tileHooks({ ...none, branches: { count: 3, moves: 0, underperforming: [{ name: 'Westlands', change: -0.28 }] } }).branches.text, 'Westlands down 28%');
  assert.equal(R.tileHooks({ ...none, branches: { count: 3, moves: 0, underperforming: [] } }).branches.text, '3 branches compared');
});

ok('the page: Branches only with the cloud\'s hook; ?tab=branches; the arrow keys still wrap from costs', () => {
  assert.deepEqual(M.visibleAreas(null, false), ['menu', 'heatmap', 'leaks', 'credit', 'stock', 'customers', 'costs'], 'no hook: no Branches');
  assert.ok(!M.visibleAreas({ branches: { text: '', alert: false, hidden: true } }, false).includes('branches'), 'hidden by the cloud (a manager, one branch)');
  const seen = M.visibleAreas({ branches: { text: '1 stock move to consider', alert: true, hidden: false } }, false);
  assert.deepEqual(seen, ['menu', 'heatmap', 'leaks', 'credit', 'stock', 'branches', 'customers', 'costs']);
  assert.equal(M.areaFromQuery('?tab=branches', seen), 'branches');
  assert.equal(M.areaFromQuery('?tab=branches', M.visibleAreas(null, false)), null);
  assert.deepEqual([M.nextArea(M.AREA_ORDER, 'costs', 'ArrowRight'), M.nextArea(M.AREA_ORDER, 'stock', 'ArrowRight')], ['menu', 'branches']);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
