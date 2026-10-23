/**
 * loss-alerts-a576.test.mjs — A576: loss-prevention alerts (the Watch list).
 *
 * Owner, 2026-10-23: unusual patterns per branch and per staff member over a day and over 7 days — voids after payment,
 * many voids or refunds against the others, big or frequent discounts, cash short or over, prices below the list, items
 * taken back from the kitchen, vehicles let out with no charge. A WARNING ONLY: plain words, never an accusation, never
 * "to recover"; at most 10; to the owner, partners and managers — never on the cashier's screen. And (the coordinator's
 * relay): "let us not forget other business in the tills … based on how they operate" — each business type gets the
 * detectors its data records, in its own words.
 *
 *   R  the rules (apps/server/src/lib/lossAlertRules.ts, compiled): the settings and their defaults and bounds; which kinds
 *      fit which business type and the words per type; every detector on fixtures per type — restaurant, retail, minimart,
 *      petrol, parking, other; the thresholds and the peer rule; on/off; the wording (no accusation, no "recover"); the cap
 *      of 10; who is told (never the person it is about, never a cashier, the branch, the owner's choices); when (once,
 *      today or yesterday only, a rolling alert not again within 7 days); the daily email's lines.
 *   J  the job (jobs/lossAlerts.ts) on an in-memory database: stored once per key (idempotent, the count grows), the owner's
 *      copy and the team copies, nobody twice, switched off → nothing.
 *   H  the routes over HTTP (the real routers): the watch list (reports.voids, the web only, a manager's branch, never an
 *      alert about the reader, at most 10), "looked into", the owner's settings (owner only, cleaned), the generic settings
 *      route refusing the key, the owner's bell without the team copies.
 *   W  no cashier surface: the till and the web POS never call /api/loss-alerts nor show a loss alert; the Watch list and the
 *      settings rendered (react-dom/server).
 *
 *   cd apps/server && npm run build && cd ../.. && node tests/loss-alerts-a576.test.mjs
 *
 * MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted — listed in the A576 report):
 *   - aboveOthers without "count > every other"                         → R "peer rule" fails
 *   - teamRecipients without the `p.id === alert.staff_id` skip          → R "never the person it is about" and J fail
 *   - toNotify without the "already notified" check                      → R "once" and J "idempotent" fail
 *   - detectLossAlerts without the kindsFor(type) filter                 → R "per type" (retail kitchen / parking) fails
 *   - topLoss slicing 11                                                 → R "cap of 10" fails
 *   - the "Worth a look." wording swapped for "KES to recover"           → R "wording" fails
 *   - GET /api/loss-alerts without the `staff_id === me` filter          → H "never an alert about the reader" fails
 *   - notifications forCaller without the owner's neq('loss_alert_team') → H "owner's bell" fails
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installMemDb } from './lib-memdb.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = process.env.SERVER_DIST || path.join(ROOT, 'apps/server/dist');
if (!fs.existsSync(path.join(DIST, 'lib/lossAlertRules.js'))) { console.log('\nBuild the server first:\n  cd apps/server && npm run build\n'); process.exit(1); }

process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
process.env.JWT_SECRET = randomBytes(24).toString('hex');
process.env.ADMIN_JWT_SECRET = randomBytes(24).toString('hex');
process.env.SUPABASE_JWT_SECRET ??= randomBytes(24).toString('hex');
const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const R = require(path.join(DIST, 'lib/lossAlertRules.js'));

let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${String(e.stack ?? e.message).split('\n').slice(0, 5).join('\n      ')}`); } };

// ── R. the rules ─────────────────────────────────────────────────────────────
console.log('\nR. the rules\n');
const T = '2026-10-23', Y = '2026-10-22';
const WEEK = Array.from({ length: 7 }, (_, i) => R.lossPrevDate(T, 6 - i));
const S = (over = {}) => ({ ...R.readLossSettings(null), ...over });
const people = new Map([['mary', 'Mary'], ['john', 'John'], ['ann', 'Ann'], ['otis', 'Otis']]);
const input = (type, over = {}) => ({
  businessType: type, currency: 'KES', today: T, days: [Y, T], week: WEEK,
  branches: new Map([['W', 'Westlands'], ['K', 'Kilimani']]), people,
  workers: ['mary', 'john', 'ann'].map((s) => ({ staff_id: s, branch_id: 'W', date: T })),
  voids: [], refunds: [], discounts: [], shifts: [], dayCloses: [], prices: [], kitchen: [], parking: [], ...over,
});
const v = (id, by, date = T, paid = true, branch = 'W') => ({ id, branch_id: branch, date, by, total: 500, paid });
const maryPaid = (n = 6) => [...Array.from({ length: n }, (_, i) => v(`m${i}`, 'mary')), v('j1', 'john')];
const msgs = (alerts) => alerts.map((a) => a.message);
const kinds = (alerts) => alerts.map((a) => a.kind);

await ok('settings: the defaults (all on, thresholds, everyone told, in the daily email); a bad or out-of-range value is its default; switches as false/"false"', () => {
  const d = R.readLossSettings(null);
  assert.equal(d.enabled, true);
  assert.ok(R.LOSS_KINDS.every((k) => d.kinds[k] === true));
  assert.deepEqual([d.paid_void_count, d.void_count, d.refund_count, d.peer_multiple, d.discount_percent, d.discount_amount,
    d.big_discount_count, d.discount_count, d.free_count, d.cash_tolerance, d.cash_repeat, d.price_count, d.kitchen_count, d.parking_count],
  [2, 3, 2, 3, 20, 1000, 2, 5, 2, 500, 3, 2, 3, 3]);
  assert.deepEqual(d.recipients, { owner: true, partners: true, managers: true });
  assert.equal(d.daily_email, true);
  const s = R.readLossSettings(JSON.stringify({ enabled: 'false', void_count: 0, cash_tolerance: '1,500', discount_percent: 150, kinds: { many_voids: false, nonsense: false }, recipients: { managers: 'false' }, extra: 1 }));
  assert.equal(s.enabled, false);
  assert.equal(s.void_count, 3, 'below the bound → default');
  assert.equal(s.cash_tolerance, 1500, 'a typed thousands separator is read');
  assert.equal(s.discount_percent, 20, 'above 100% → default');
  assert.equal(s.kinds.many_voids, false);
  assert.ok(!('nonsense' in s.kinds) && !('extra' in s));
  assert.deepEqual(s.recipients, { owner: true, partners: true, managers: false });
  assert.equal(R.cleanLossSettings('not json'), null);
  assert.equal(R.cleanLossSettings([1, 2]), null);
});

await ok('per type: which detectors fit — kitchen only at a restaurant or café, parking only at a car park; the rest everywhere', () => {
  const has = (t, k) => R.kindsFor(t).includes(k);
  for (const t of ['restaurant', 'cafe']) assert.ok(has(t, 'kitchen_removed') && !has(t, 'parking_no_charge'), t);
  for (const t of ['retail', 'minimart', 'petrol_station', 'other']) assert.ok(!has(t, 'kitchen_removed') && !has(t, 'parking_no_charge'), t);
  assert.ok(has('parking', 'parking_no_charge') && !has('parking', 'kitchen_removed'));
  for (const t of ['restaurant', 'retail', 'minimart', 'petrol_station', 'parking', 'other'])
    for (const k of ['paid_voids', 'many_voids', 'many_refunds', 'big_discounts', 'frequent_discounts', 'free_sales', 'cash_short', 'price_below_list'])
      assert.ok(has(t, k), `${t} ${k}`);
});

await ok('per type: the words — orders at a restaurant, sales at a shop, an attendant at a petrol station, tickets at a car park', () => {
  assert.deepEqual([R.lossWords('restaurant').orders, R.lossWords('cafe').orders, R.lossWords('retail').orders, R.lossWords('minimart').orders,
    R.lossWords('petrol_station').orders, R.lossWords('parking').orders, R.lossWords('other').orders],
  ['orders', 'orders', 'sales', 'sales', 'sales', 'tickets', 'sales']);
  assert.equal(R.lossWords('petrol_station').staff, 'attendant');
  assert.equal(R.lossWords('retail').staff, 'cashier');
  assert.match(R.kindLabel('free_sales', 'restaurant').label, /^Comps/);
  assert.match(R.kindLabel('paid_voids', 'retail').label, /^Sales voided after payment/);
  assert.match(R.kindLabel('many_voids', 'petrol_station').hint, /attendants/);
  // What the data does not record — per type, and never pretending.
  assert.ok(R.lossNeedsData('retail').some((t) => /no sale/i.test(t)));
  assert.ok(R.lossNeedsData('restaurant').some((t) => /table closed/i.test(t)));
  assert.ok(R.lossNeedsData('petrol_station').some((t) => /pump meters/i.test(t)));
  assert.ok(R.lossNeedsData('parking').some((t) => /who let a vehicle out/i.test(t)));
  assert.ok(R.lossNeedsData('minimart').some((t) => /removed from the basket/i.test(t)));
});

await ok('restaurant: "Mary voided 6 paid orders today (others: 0–1). Worth a look." — one line (not also "voided 6 orders"), linked to the voids list for that day, branch and person', () => {
  const a = R.detectLossAlerts(input('restaurant', { voids: maryPaid() }), S());
  assert.deepEqual(msgs(a), ['Mary voided 6 paid orders today (others: 0–1). Worth a look.']);
  assert.equal(a[0].link, '/dashboard/reports?from=2026-10-23&to=2026-10-23&branch=W&staff=mary&tab=voids');
  assert.deepEqual([a[0].staff_id, a[0].branch_id, a[0].count, a[0].peer_low, a[0].peer_high, a[0].period], ['mary', 'W', 6, 0, 1, 'day']);
});

await ok('restaurant: items taken back from the kitchen against the others ("2 already made"); comps worded as comps', () => {
  const k = (id, by, cooked) => ({ id, branch_id: 'W', date: T, by, cooked, amount: 300 });
  const a = R.detectLossAlerts(input('restaurant', {
    kitchen: [k('k1', 'john', true), k('k2', 'john', true), k('k3', 'john', false), k('k4', 'john', false), k('k5', 'ann', false)],
    discounts: [{ id: 'd1', branch_id: 'W', date: T, by: 'ann', subtotal: 800, manual: 800, total: 0 }, { id: 'd2', branch_id: 'W', date: T, by: 'ann', subtotal: 500, manual: 500, total: 0 }],
  }), S({ kinds: { ...S().kinds, big_discounts: false } }));
  assert.ok(msgs(a).includes('John took 4 items off orders after they went to the kitchen today (others: 0–1), 2 already made. Worth a look.'), msgs(a).join(' | '));
  assert.ok(msgs(a).includes('Ann rang up 2 comps (orders at no charge) today. Worth a look.'), msgs(a).join(' | '));
});

await ok('a comp is one line, not also a big discount (while comps are watched; with comps off it counts as a big discount)', () => {
  const comps = [{ id: 'd1', branch_id: 'W', date: T, by: 'ann', subtotal: 2400, manual: 2400, total: 0 }, { id: 'd2', branch_id: 'W', date: T, by: 'ann', subtotal: 1300, manual: 1300, total: 0 }];
  assert.deepEqual(kinds(R.detectLossAlerts(input('restaurant', { discounts: comps }), S())), ['free_sales']);
  assert.deepEqual(kinds(R.detectLossAlerts(input('restaurant', { discounts: comps }), S({ kinds: { ...S().kinds, free_sales: false } }))), ['big_discounts']);
});

await ok('retail and minimart: the same patterns in a shop\'s words (sales); no kitchen alert even when such rows exist; prices below the list', () => {
  for (const type of ['retail', 'minimart']) {
    const a = R.detectLossAlerts(input(type, {
      voids: maryPaid(),
      kitchen: [1, 2, 3, 4, 5].map((i) => ({ id: `k${i}`, branch_id: 'W', date: T, by: 'john', cooked: true, amount: 100 })),
      prices: [{ id: 'p1', branch_id: 'W', date: T, by: 'ann', difference: 150 }, { id: 'p2', branch_id: 'W', date: T, by: 'ann', difference: 300 }],
    }), S());
    assert.ok(msgs(a).includes('Mary voided 6 paid sales today (others: 0–1). Worth a look.'), `${type}: ${msgs(a).join(' | ')}`);
    assert.ok(!kinds(a).includes('kitchen_removed'), type);
    assert.ok(msgs(a).includes("2 of Ann's sales were priced below the price list today (KES 450 below in all). Often an old price on the till — worth a look."), msgs(a).join(' | '));
  }
});

await ok('retail: big discounts (percent or amount, preset discounts and offers aside) and frequent discounts against the others; refunds against the others', () => {
  const d = (id, by, subtotal, manual) => ({ id, branch_id: 'W', date: T, by, subtotal, manual, total: subtotal - manual });
  const a = R.detectLossAlerts(input('retail', {
    discounts: [d('a', 'ann', 1000, 300), d('b', 'ann', 10000, 1500), d('c', 'john', 1000, 100), d('z', 'john', 1000, 0)],
    refunds: [1, 2, 3].map((i) => ({ id: `r${i}`, branch_id: 'W', date: T, by: 'otis', amount: 200 })),
    workers: [...input('retail').workers, { staff_id: 'otis', branch_id: 'W', date: T }],
  }), S());
  assert.ok(msgs(a).includes('Ann gave 2 discounts of 20% or KES 1,000 or more today (largest KES 1,500). Worth a look.'), msgs(a).join(' | '));
  assert.ok(msgs(a).includes('Otis refunded 3 sales today (others: 0). Worth a look.'), msgs(a).join(' | '));
  // frequent: 5 typed-in discounts by Ann, 1 by John
  const many = [1, 2, 3, 4, 5].map((i) => d(`f${i}`, 'ann', 1000, 50));
  const b = R.detectLossAlerts(input('retail', { discounts: [...many, d('g', 'john', 1000, 50)] }), S());
  assert.ok(msgs(b).includes('Ann typed in 5 discounts today (others: 0–1). Worth a look.'), msgs(b).join(' | '));
});

await ok('petrol: an attendant\'s cash counted short beyond the tolerance; short again and again over 7 days; a day closed over', () => {
  const sh = (id, staff, date, difference) => ({ id, branch_id: 'W', staff_id: staff, date, difference });
  const a = R.detectLossAlerts(input('petrol_station', {
    shifts: [sh('s1', 'john', T, -1500), sh('s2', 'john', T, -200), sh('s3', 'ann', WEEK[1], -150), sh('s4', 'ann', WEEK[2], -300), sh('s5', 'ann', WEEK[3], -120), sh('s6', 'mary', T, 499)],
    dayCloses: [{ id: 'bd1', branch_id: 'K', date: Y, difference: 800 }],
  }), S());
  assert.ok(msgs(a).includes("John's cash at Westlands was counted KES 1,500 short today. Worth a look."), msgs(a).join(' | '));
  assert.ok(msgs(a).includes("Ann's cash at Westlands was short 3 times in the last 7 days (KES 570 in all). Worth a look."), msgs(a).join(' | '));
  assert.ok(msgs(a).includes('The day at Kilimani closed KES 800 over yesterday. Worth a look.'), msgs(a).join(' | '));
  assert.ok(!msgs(a).some((m) => m.startsWith('Mary')), 'KES 499 is within the KES 500 tolerance');
  // A retail drawer is a "drawer".
  const b = R.detectLossAlerts(input('retail', { shifts: [sh('s1', 'john', T, -1500)] }), S());
  assert.match(b[0].message, /^John's drawer at Westlands/);
});

await ok('parking: vehicles let out with no charge at a branch, against its usual days; nothing below the threshold or within the usual', () => {
  const p = (i, date, branch = 'W') => ({ id: `p${date}${i}`, branch_id: branch, date });
  const usual = [WEEK[0], WEEK[1], WEEK[2]].flatMap((d) => [p(1, d)]);
  const a = R.detectLossAlerts(input('parking', { parking: [...usual, ...[1, 2, 3, 4].map((i) => p(i, T))] }), S());
  assert.deepEqual(msgs(a), ['4 parked vehicles at Westlands left with no charge today (usual: 0–1 a day). Worth a look.']);
  const b = R.detectLossAlerts(input('parking', { parking: [1, 2].map((i) => p(i, T)) }), S());
  assert.equal(b.length, 0, 'below the threshold (3)');
  const busy = [WEEK[0], WEEK[1]].flatMap((d) => [1, 2, 3, 4, 5].map((i) => p(i, d)));
  const c = R.detectLossAlerts(input('parking', { parking: [...busy, ...[1, 2, 3, 4].map((i) => p(i, T))] }), S());
  assert.equal(c.length, 0, 'not above the usual days');
  // A restaurant never gets a parking alert, even with such rows.
  assert.equal(R.detectLossAlerts(input('restaurant', { parking: [1, 2, 3, 4].map((i) => p(i, T)) }), S()).length, 0);
});

await ok('other: the general detectors in a shop\'s words', () => {
  const a = R.detectLossAlerts(input('other', { voids: maryPaid() }), S());
  assert.deepEqual(msgs(a), ['Mary voided 6 paid sales today (others: 0–1). Worth a look.']);
});

await ok('thresholds: just below → nothing; the owner lowers it → the alert; the 7-day period needs twice the day\'s', () => {
  assert.equal(R.detectLossAlerts(input('retail', { voids: [v('a', 'mary'), v('j', 'john', T, false)] }), S()).length, 0, 'one paid void (threshold 2)');
  const a = R.detectLossAlerts(input('retail', { voids: [v('a', 'mary'), v('j', 'john', T, false)] }), S({ paid_void_count: 1 }));
  assert.deepEqual(kinds(a), ['paid_voids']);
  // Spread over the week: 3 on different days (never 2 in one day) → the week alert at 4 (2 × 2), not at 3.
  const spread = (n) => Array.from({ length: n }, (_, i) => v(`w${i}`, 'mary', WEEK[i], true));
  const wk = (n) => input('retail', { voids: spread(n), workers: WEEK.flatMap((d) => ['mary', 'john'].map((s) => ({ staff_id: s, branch_id: 'W', date: d }))) });
  assert.equal(R.detectLossAlerts(wk(3), S()).filter((x) => x.period === 'week').length, 0);
  const w4 = R.detectLossAlerts(wk(4), S()).filter((x) => x.period === 'week');
  assert.deepEqual(msgs(w4), ['Mary voided 4 paid sales in the last 7 days (others: 0). Worth a look.']);
});

await ok('the peer rule: above every other AND at least 3× their usual; with nobody else, twice the minimum', () => {
  assert.equal(R.aboveOthers(6, [0, 1], 3, 3), true);
  assert.equal(R.aboveOthers(6, [5, 1], 3, 3), false, 'not well above (5 is close)');
  assert.equal(R.aboveOthers(6, [6, 0], 3, 3), false, 'not above every other');
  assert.equal(R.aboveOthers(6, [0, 0, 6], 3, 3), false, 'one other did as many (their usual is 0): not singled out');
  assert.equal(R.aboveOthers(2, [0], 3, 3), false, 'below the minimum');
  assert.equal(R.aboveOthers(6, [], 3, 3), true);
  assert.equal(R.aboveOthers(5, [], 3, 3), false, 'alone: twice the minimum');
  // Everyone voids a lot (a busy night, a till problem): no one singled out.
  const all = ['mary', 'john', 'ann'].flatMap((s) => [1, 2, 3, 4, 5].map((i) => v(`${s}${i}`, s, T, false)));
  assert.equal(R.detectLossAlerts(input('restaurant', { voids: all }), S()).length, 0);
  // Nobody else worked: the words say so.
  const solo = R.detectLossAlerts(input('retail', { workers: [], voids: [1, 2, 3, 4, 5, 6].map((i) => v(`s${i}`, 'mary', T, false)) }), S());
  assert.deepEqual(msgs(solo), ['Mary voided 6 sales today (no one else worked at Westlands today). Worth a look.']);
});

await ok('on/off: a kind switched off is not detected; everything off when the owner switches the watch off', () => {
  const base = input('restaurant', { voids: maryPaid() });
  assert.equal(R.detectLossAlerts(base, S({ kinds: { ...S().kinds, paid_voids: false } })).map((a) => a.kind).join(), 'many_voids', 'then the plain voids line stands');
  assert.equal(R.detectLossAlerts(base, S({ kinds: { ...S().kinds, paid_voids: false, many_voids: false } })).length, 0);
  assert.equal(R.detectLossAlerts(base, S({ enabled: false })).length, 0);
});

/** Every pattern at once, for the wording and the cap. */
const everything = (type) => input(type, {
  voids: [...maryPaid(), ...[1, 2, 3, 4].map((i) => v(`x${i}`, 'otis', T, false))],
  refunds: [1, 2, 3].map((i) => ({ id: `r${i}`, branch_id: 'W', date: T, by: 'ann', amount: 100 })),
  discounts: [1, 2, 3, 4, 5].map((i) => ({ id: `d${i}`, branch_id: 'W', date: T, by: 'john', subtotal: 1000, manual: 1000, total: 0 })),
  shifts: [{ id: 's1', branch_id: 'W', staff_id: 'john', date: T, difference: -2000 }],
  dayCloses: [{ id: 'b1', branch_id: 'W', date: T, difference: -900 }],
  prices: [1, 2].map((i) => ({ id: `p${i}`, branch_id: 'W', date: T, by: 'otis', difference: 50 })),
  kitchen: [1, 2, 3, 4].map((i) => ({ id: `k${i}`, branch_id: 'W', date: T, by: 'ann', cooked: true, amount: 10 })),
  parking: [1, 2, 3, 4].map((i) => ({ id: `pk${i}`, branch_id: 'W', date: T })),
});

await ok('wording: plain words, "Worth a look", never an accusation, never "to recover" or "loss" — every type, every detector', () => {
  let n = 0;
  for (const type of ['restaurant', 'cafe', 'retail', 'minimart', 'petrol_station', 'parking', 'other']) {
    for (const a of R.detectLossAlerts(everything(type), S())) {
      n++;
      assert.doesNotMatch(a.message, R.LOSS_BANNED, `${type}: ${a.message}`);
      assert.doesNotMatch(a.message, /KES to recover|recover/i);
      assert.match(a.message, /[Ww]orth a look\.$/, a.message);
      assert.ok(a.message.length <= 600 && a.link.startsWith('/dashboard/'), a.message);
    }
    for (const k of R.kindsFor(type)) { const l = R.kindLabel(k, type); assert.doesNotMatch(`${l.label} ${l.hint}`, R.LOSS_BANNED, `${type} ${k}`); }
  }
  assert.ok(n > 40, `only ${n} messages checked`);
});

await ok('the cap: at most 10 on the list, in the email, and told per run — the most worth a look first', () => {
  const crowd = Array.from({ length: 15 }, (_, i) => `p${i}`);
  const many = input('retail', {
    people: new Map(crowd.map((p) => [p, p.toUpperCase()])),
    workers: crowd.map((s) => ({ staff_id: s, branch_id: 'W', date: T })),
    shifts: crowd.map((s, i) => ({ id: `s${i}`, branch_id: 'W', staff_id: s, date: T, difference: -(600 + i * 100) })),
  });
  const all = R.detectLossAlerts(many, S());
  assert.equal(all.length, 15);
  const top = R.topLoss(all);
  assert.equal(top.length, 10);
  assert.equal(R.LOSS_TOP, 10);
  assert.ok(top[0].message.startsWith("P14's drawer"), 'the biggest difference first');
  assert.equal(R.toNotify(all, [], T).length, 10);
  assert.equal(R.emailLines(all, new Map(), []).length, 10);
});

const P = (id, o = {}) => ({ id, ownerRole: false, partner: false, seesVoids: false, branches: [], ...o });
const team = [P('owner-row', { ownerRole: true, seesVoids: true }), P('max', { seesVoids: true, branches: ['W'] }), P('kim', { seesVoids: true, branches: ['K'] }),
  P('cate', { branches: ['W'] }), P('gm', { partner: true, seesVoids: true, branches: [] }), P('mary', { seesVoids: true, branches: ['W'] })];

await ok('who is told: the branch\'s managers (reports.voids) and partners — never the person it is about, never a cashier, never another branch\'s manager; the owner\'s choices', () => {
  const alert = { branch_id: 'W', staff_id: 'mary' };
  assert.deepEqual(R.teamRecipients(alert, team, S()).sort(), ['gm', 'max']);
  assert.deepEqual(R.teamRecipients({ branch_id: 'W', staff_id: 'max' }, team, S()).sort(), ['gm', 'mary'], 'a manager is never told about themselves');
  assert.deepEqual(R.teamRecipients(alert, team, S({ recipients: { owner: true, partners: false, managers: true } })), ['max']);
  assert.deepEqual(R.teamRecipients(alert, team, S({ recipients: { owner: true, partners: true, managers: false } })), ['gm']);
  assert.ok(!R.teamRecipients(alert, team, S()).includes('cate'), 'a cashier (no reports.voids) is never told');
  assert.ok(!R.teamRecipients(alert, team, S()).includes('owner-row'), 'the owner gets their own copy, not a team copy');
  assert.equal(R.ownerTold(alert, ['owner-row'], S()), true);
  assert.equal(R.ownerTold({ staff_id: 'owner-row' }, ['owner-row'], S()), false, 'not told about their own sign-in');
  assert.equal(R.ownerTold(alert, ['owner-row'], S({ recipients: { owner: false, partners: true, managers: true } })), false);
});

await ok('when: once per alert; a day alert only for today or yesterday; a rolling alert not again within 7 days', () => {
  const a = R.detectLossAlerts(input('retail', { voids: maryPaid() }), S());
  assert.equal(R.toNotify(a, [], T).length, 1);
  const told = [{ alert_key: a[0].key, kind: a[0].kind, period: 'day', branch_id: 'W', staff_id: 'mary', business_date: T, notified_at: '2026-10-23T10:00:00Z' }];
  assert.equal(R.toNotify(a, told, T).length, 0, 'never twice');
  const old = R.detectLossAlerts({ ...input('retail', { voids: maryPaid().map((x) => ({ ...x, date: Y })) }), today: T }, S());
  assert.equal(R.toNotify(old, [], R.lossPrevDate(T, -2)).length, 0, 'a day alert of 3 days ago is on the list, not rung');
  const wk = [{ key: 'many_voids:week:2026-10-23:W:mary', kind: 'many_voids', period: 'week', business_date: T, branch_id: 'W', staff_id: 'mary', score: 70, count: 8, message: 'x', link: '/dashboard/x' }];
  const toldWeek = [{ alert_key: 'many_voids:week:2026-10-20:W:mary', kind: 'many_voids', period: 'week', business_date: '2026-10-20', branch_id: 'W', staff_id: 'mary', notified_at: 'x' }];
  assert.equal(R.toNotify(wk, toldWeek, T).length, 0, 'the same rolling pattern, told 3 days ago');
  assert.equal(R.toNotify(wk, [{ ...toldWeek[0], business_date: '2026-10-15' }], T).length, 1, 'told 8 days ago: again');
});

await ok('a rolling alert says nothing new beside a day alert of that kind for that person', () => {
  const vv = [...Array.from({ length: 6 }, (_, i) => v(`m${i}`, 'mary')), ...Array.from({ length: 4 }, (_, i) => v(`n${i}`, 'mary', WEEK[i]))];
  const a = R.detectLossAlerts(input('retail', { voids: vv }), S());
  assert.deepEqual(a.map((x) => `${x.kind}/${x.period}`), ['paid_voids/day']);
});

await ok('the daily email: today\'s lines, at most 10, none about a person the email goes to', () => {
  const rows = [{ staff_id: 'mary', score: 90, business_date: T, count: 6, message: 'a' }, { staff_id: 'max', score: 80, business_date: T, count: 3, message: 'b' }, { staff_id: null, score: 70, business_date: T, count: 1, message: 'c' }];
  const out = R.emailLines(rows, new Map([['mary', 'mary@x.co'], ['max', 'Max@X.co']]), ['owner@x.co', 'max@x.co']);
  assert.deepEqual(out.map((r) => r.message), ['a', 'c']);
});

// ── J. the job ───────────────────────────────────────────────────────────────
console.log('\nJ. the job (in-memory database)\n');
const { supabase } = require(path.join(DIST, 'lib/supabase.js'));
const mem = installMemDb(supabase);
const AC = require(path.join(DIST, 'lib/authCache.js'));
const J = require(path.join(DIST, 'jobs/lossAlerts.js'));
const { businessDateEAT } = require(path.join(DIST, 'lib/businessDay.js'));
const warn = console.warn; console.warn = () => {};
const logErr = console.error; console.error = () => {};
const log = console.log;

const B = '11111111-1111-4111-8111-111111111111';
const W = '22222222-2222-4222-8222-222222222222', K = '33333333-2222-4222-8222-222222222222';
const OWNER = 'aaaaaaaa-0000-4000-8000-000000000001', MAX = 'aaaaaaaa-0000-4000-8000-000000000002', KIM = 'aaaaaaaa-0000-4000-8000-000000000003';
const CATE = 'aaaaaaaa-0000-4000-8000-000000000004', MARY = 'aaaaaaaa-0000-4000-8000-000000000005', JOHN = 'aaaaaaaa-0000-4000-8000-000000000006';
const GM = 'aaaaaaaa-0000-4000-8000-000000000007';
const role = (name, ...keys) => ({ name, role_permissions: keys.map((key) => ({ permissions: { key } })) });
const MGR = ['reports.voids', 'reports.overview', 'orders.view_all'];
// A fixed moment: midday (EAT) of today's business date — every fixture time falls on one business day whatever the clock.
const NOW = new Date(Date.parse(businessDateEAT(new Date(), 0) + 'T09:00:00Z'));
const TODAY = businessDateEAT(NOW, 0);
const ago = (min) => new Date(NOW.getTime() - min * 60_000).toISOString();
const BIZ = { id: B, owner_id: OWNER, name: 'Test Bar', type: 'restaurant', currency: 'KES', status: 'active' };
const reset = () => {
  AC._resetAuthCache?.();
  mem.fail = () => null; mem.calls = [];
  const user = (id, name, r, branches, email) => ({ id, name, email, status: 'active', business_id: B, permissions_version: 0, role_id: `role-${id}`,
    roles: r, user_branches: branches.map((b) => ({ branch_id: b })), user_permissions: [] });
  const order = (id, by, minAgo) => ({ id, business_id: B, branch_id: W, cashier_id: by, voided_by: by, status: 'voided', voided_at: ago(minAgo), created_at: ago(minAgo + 5), total: 700 });
  mem.db = {
    businesses: [BIZ],
    branches: [{ id: W, business_id: B, name: 'Westlands', status: 'active' }, { id: K, business_id: B, name: 'Kilimani', status: 'active' }],
    users: [user(OWNER, 'Owner', role('Admin'), [], 'owner@x.co'), user(MAX, 'Max', role('Manager', ...MGR), [W], 'max@x.co'),
      user(KIM, 'Kim', role('Manager', ...MGR), [K], 'kim@x.co'), user(CATE, 'Cate', role('Cashier', 'orders.create'), [W], 'cate@x.co'),
      user(MARY, 'Mary', role('Cashier', 'orders.create'), [W], null), user(JOHN, 'John', role('Cashier', 'orders.create'), [W], null),
      user(GM, 'Grace', role('General Manager', ...MGR), [W, K], 'grace@x.co')],
    business_settings: [{ id: 'bs-p', business_id: B, key: 'web_partners', value: { [GM]: { auth_user_id: 'auth-gm', status: 'active', granted_at: '2026-10-01' } } }],
    branch_settings: [],
    shifts: [MARY, JOHN, CATE].map((s, i) => ({ id: `sh-${i}`, business_id: B, branch_id: W, cashier_id: s, opened_at: ago(120), status: 'open' })),
    orders: [...[1, 2, 3, 4, 5, 6].map((i) => order(`o-m${i}`, MARY, 10 + i)), order('o-j1', JOHN, 30)],
    payments: [...[1, 2, 3, 4, 5, 6].map((i) => ({ id: `pay-${i}`, order_id: `o-m${i}`, business_id: B, amount: 700, status: 'completed', method: 'cash' })),
      { id: 'pay-j', order_id: 'o-j1', business_id: B, amount: 700, status: 'completed', method: 'cash' }],
    business_days: [], order_price_variances: [], kitchen_voids: [], parking_sessions: [],
    loss_alerts: [], notifications: [], audit_log: [], refresh_tokens: [], sync_versions: [], sync_changes: [], feature_flags: [],
    user_devices: [{ id: 'ud-1', business_id: B, device_id: 'dev-T1', status: 'approved', retired_at: null, branch_id: W, user_id: OWNER }],
  };
};

await ok('stored once per key, with the plain words; the owner\'s copy and the team copies (the branch manager, the partner) — not the cashier, not the other branch\'s manager, not Mary', async () => {
  reset();
  const r = await J.runLossAlertsForBusiness(BIZ, NOW);
  assert.deepEqual(r.stored.map((a) => a.kind), ['paid_voids']);
  assert.equal(mem.db.loss_alerts.length, 1);
  const row = mem.db.loss_alerts[0];
  assert.match(row.message, /^Mary voided 6 paid orders (today|yesterday) \(others: 0–1\)\. Worth a look\.$/);
  assert.equal(row.staff_id, MARY);
  assert.ok(row.notified_at, 'stamped once told');
  const n = mem.db.notifications;
  assert.deepEqual(n.filter((x) => x.type === 'loss_alert').map((x) => x.user_id), [OWNER]);
  assert.deepEqual(n.filter((x) => x.type === 'loss_alert_team').map((x) => x.user_id).sort(), [MAX, GM].sort());
  assert.ok(!n.some((x) => [CATE, KIM, MARY, JOHN].includes(x.user_id)));
  assert.ok(n.every((x) => x.branch_id === W && x.link.startsWith('/dashboard/reports?') && x.title === 'Worth a look: orders voided after payment'));
});

await ok('idempotent: run again → the same row, nobody told twice; one more void → the count grows on the same row, still told once', async () => {
  const before = mem.db.notifications.length;
  await J.runLossAlertsForBusiness(BIZ, NOW);
  assert.equal(mem.db.loss_alerts.length, 1);
  assert.equal(mem.db.notifications.length, before);
  mem.db.orders.push({ id: 'o-m7', business_id: B, branch_id: W, cashier_id: MARY, voided_by: MARY, status: 'voided', voided_at: ago(2), created_at: ago(8), total: 700 });
  mem.db.payments.push({ id: 'pay-7', order_id: 'o-m7', business_id: B, amount: 700, status: 'completed', method: 'cash' });
  await J.runLossAlertsForBusiness(BIZ, NOW);
  assert.equal(mem.db.loss_alerts.length, 1);
  assert.equal(mem.db.loss_alerts[0].count, 7);
  assert.match(mem.db.loss_alerts[0].message, /voided 7 paid orders/);
  assert.equal(mem.db.notifications.length, before);
});

await ok('a manager\'s own pattern: the manager is never told about themselves — the owner and the partner are', async () => {
  reset();
  for (const o of mem.db.orders) if (o.cashier_id === MARY) { o.cashier_id = MAX; o.voided_by = MAX; }
  mem.db.shifts.push({ id: 'sh-max', business_id: B, branch_id: W, cashier_id: MAX, opened_at: ago(100), status: 'open' });
  await J.runLossAlertsForBusiness(BIZ, NOW);
  const to = mem.db.notifications.map((x) => x.user_id).sort();
  assert.deepEqual(to, [OWNER, GM].sort());
});

await ok('switched off → nothing stored, nobody told; a kind off → not that kind; the owner off → no owner copy', async () => {
  reset();
  mem.db.business_settings.push({ id: 'bs-l', business_id: B, key: 'loss_alerts', value: { enabled: false } });
  const r = await J.runLossAlertsForBusiness(BIZ, NOW);
  assert.equal(r.stored.length + mem.db.loss_alerts.length + mem.db.notifications.length, 0);
  reset();
  mem.db.business_settings.push({ id: 'bs-l', business_id: B, key: 'loss_alerts', value: { kinds: { paid_voids: false }, recipients: { owner: false } } });
  await J.runLossAlertsForBusiness(BIZ, NOW);
  assert.deepEqual(mem.db.loss_alerts.map((a) => a.kind), ['many_voids']);
  assert.ok(!mem.db.notifications.some((x) => x.type === 'loss_alert'));
});

await ok('before migration 166 (no table): nothing written, nothing told, no error', async () => {
  reset();
  mem.fail = (table) => (table === 'loss_alerts' ? { message: 'relation "public.loss_alerts" does not exist', code: '42P01' } : null);
  const r = await J.runLossAlertsForBusiness(BIZ, NOW);
  assert.deepEqual([r.stored.length, r.notified.length, mem.db.notifications.length], [0, 0, 0]);
  mem.fail = () => null;
});

await ok('the daily email block: the day\'s lines (with the link), none about a recipient; \'\' when the email part is off', async () => {
  reset();
  const html = await J.lossEmailHtml(BIZ, ['owner@x.co'], NOW);
  {
    assert.match(html, /Worth a look/);
    assert.match(html, /Mary voided 6 paid orders today/);
    assert.match(html, /FOR INVESTIGATION/);
    assert.doesNotMatch(html.replace(/Loss prevention/g, ''), R.LOSS_BANNED, 'only the settings page\'s own name');
  }
  mem.db.business_settings.push({ id: 'bs-l', business_id: B, key: 'loss_alerts', value: { daily_email: false } });
  assert.equal(await J.lossEmailHtml(BIZ, ['owner@x.co'], NOW), '');
});

// ── H. the routes ────────────────────────────────────────────────────────────
console.log('\nH. the routes over HTTP\n');
const express = require('express');
const jwt = require('jsonwebtoken');
const app = express();
app.use(express.json());
app.use('/api', require(path.join(DIST, 'routes/index.js')).default);
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const port = server.address().port;
const sign = (p) => jwt.sign({ sessionId: 's', permissionsVersion: 0, businessId: B, isOwner: false, surface: 'dashboard', ...p }, process.env.JWT_SECRET, { expiresIn: '5m' });
const TK = {
  owner: sign({ userId: OWNER, isOwner: true, ownerLogin: true, branchId: null, permissionKeys: ['*'] }),
  max: sign({ userId: MAX, branchId: W, permissionKeys: MGR }),
  kim: sign({ userId: KIM, branchId: K, permissionKeys: MGR }),
  cate: sign({ userId: CATE, branchId: W, permissionKeys: ['orders.create'] }),
  maxTill: sign({ userId: MAX, branchId: W, permissionKeys: MGR, surface: 'desktop', pinSignIn: true }),
  till: sign({ userId: null, deviceId: 'dev-T1', till: true, branchId: W, permissionKeys: ['*'], surface: 'desktop' }),
};
const call = async (method, p, token, body) => {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* */ }
  return { status: r.status, body: json };
};
const alertRow = (i, over = {}) => ({ id: `cccccccc-0000-4000-8000-${String(i).padStart(12, '0')}`, business_id: B, branch_id: W, staff_id: JOHN,
  alert_key: `k${i}`, kind: 'many_voids', period: 'day', business_date: TODAY, count: 3 + i, score: 70 + i, peer_low: 0, peer_high: 1,
  message: `Row ${i}. Worth a look.`, link: '/dashboard/reports?tab=voids', notified_at: null, dismissed_at: null, ...over });

await ok('the watch list: the owner sees every branch, the most worth a look first, AT MOST 10 (and how many there are)', async () => {
  reset();
  mem.db.loss_alerts = [...Array.from({ length: 12 }, (_, i) => alertRow(i)), alertRow(20, { branch_id: K, score: 99 }),
    alertRow(21, { dismissed_at: ago(5), score: 100 })];
  const r = await call('GET', '/api/loss-alerts', TK.owner);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.alerts.length, 10);
  assert.equal(r.body.total, 13, 'dismissed ones out');
  assert.equal(r.body.alerts[0].message, 'Row 20. Worth a look.');
  assert.equal(r.body.alerts[0].branch_name, 'Kilimani');
  assert.equal(r.body.alerts[1].staff_name, 'John');
  assert.equal(r.body.alerts[1].label, 'Many voids by one person');
});

await ok('a manager sees their own branch only, and never an alert about themselves; a cashier, a till and a manager\'s till sign-in are refused', async () => {
  reset();
  mem.db.loss_alerts = [alertRow(1), alertRow(2, { branch_id: K }), alertRow(3, { staff_id: MAX, message: 'About Max. Worth a look.' })];
  const m = await call('GET', '/api/loss-alerts', TK.max);
  assert.equal(m.status, 200);
  assert.deepEqual(m.body.alerts.map((a) => a.message), ['Row 1. Worth a look.']);
  const k = await call('GET', '/api/loss-alerts', TK.kim);
  assert.deepEqual(k.body.alerts.map((a) => a.message), ['Row 2. Worth a look.']);
  assert.equal((await call('GET', '/api/loss-alerts', TK.cate)).status, 403, 'a cashier (no reports.voids)');
  assert.equal((await call('GET', '/api/loss-alerts', TK.till)).status, 403, 'the till itself');
  assert.equal((await call('GET', '/api/loss-alerts', TK.maxTill)).status, 403, 'a manager signed in at the till');
  assert.equal((await call('PATCH', `/api/loss-alerts/${alertRow(3).id}/dismiss`, TK.max, {})).status, 404, 'nor dismiss one about themselves');
});

await ok('"looked into": off the list, who and when kept; another branch\'s → 404', async () => {
  reset();
  mem.db.loss_alerts = [alertRow(1), alertRow(2, { branch_id: K })];
  assert.equal((await call('PATCH', `/api/loss-alerts/${alertRow(2).id}/dismiss`, TK.max, {})).status, 404);
  const r = await call('PATCH', `/api/loss-alerts/${alertRow(1).id}/dismiss`, TK.max, { note: 'Till froze, re-rang the orders' });
  assert.equal(r.status, 200);
  const row = mem.db.loss_alerts[0];
  assert.ok(row.dismissed_at);
  assert.equal(row.dismissed_by, MAX);
  assert.equal(row.dismiss_note, 'Till froze, re-rang the orders');
  assert.equal((await call('GET', '/api/loss-alerts', TK.max)).body.alerts.length, 0);
});

await ok('the owner\'s settings: owner only; saved cleaned; the kinds that fit the business (a restaurant: kitchen, no parking) and what is not recorded', async () => {
  reset();
  assert.equal((await call('GET', '/api/loss-alerts/settings', TK.max)).status, 403);
  assert.equal((await call('PUT', '/api/loss-alerts/settings', TK.max, { settings: { enabled: false } })).status, 403);
  const g = await call('GET', '/api/loss-alerts/settings', TK.owner);
  assert.equal(g.status, 200);
  assert.ok(g.body.kinds.some((k) => k.kind === 'kitchen_removed') && !g.body.kinds.some((k) => k.kind === 'parking_no_charge'));
  assert.ok(g.body.needs_data.some((t) => /no sale/i.test(t)));
  const p = await call('PUT', '/api/loss-alerts/settings', TK.owner, { settings: { enabled: true, void_count: 4, cash_tolerance: -5, kinds: { free_sales: false }, junk: 1 } });
  assert.equal(p.status, 200);
  const stored = mem.db.business_settings.find((r) => r.key === 'loss_alerts').value;
  assert.equal(stored.void_count, 4);
  assert.equal(stored.cash_tolerance, 500);
  assert.equal(stored.kinds.free_sales, false);
  assert.ok(!('junk' in stored));
  // The generic settings route never writes it (a manager with settings.business could otherwise change who is told).
  const gen = await call('POST', '/api/business/settings', TK.owner, { key: 'loss_alerts', value: { enabled: false } });
  assert.equal(gen.status, 403);
  assert.equal(gen.body.code, 'READ_ONLY_KEY');
});

await ok('the owner\'s bell: their own copy, not the team copies (no doubles; read-all leaves the managers\' unread)', async () => {
  reset();
  mem.db.notifications = [
    { id: 'n1', business_id: B, branch_id: W, user_id: OWNER, type: 'loss_alert', title: 't', message: 'm', link: null, read_at: null, created_at: ago(1) },
    { id: 'n2', business_id: B, branch_id: W, user_id: MAX, type: 'loss_alert_team', title: 't', message: 'm', link: null, read_at: null, created_at: ago(1) },
    { id: 'n3', business_id: B, branch_id: W, user_id: null, type: 'low_stock', title: 't', message: 'm', link: null, read_at: null, created_at: ago(1) },
  ];
  const r = await call('GET', '/api/notifications?limit=20', TK.owner);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.notifications.map((x) => x.id).sort(), ['n1', 'n3']);
  assert.equal((await call('PATCH', '/api/notifications/read-all', TK.owner, {})).status, 204);
  assert.equal(mem.db.notifications.find((x) => x.id === 'n2').read_at, null, 'the manager\'s copy stays unread');
});
server.close();
console.warn = warn; console.error = logErr;

// ── W. no cashier surface; the pages ─────────────────────────────────────────
log('\nW. no cashier surface; the pages\n');
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? (e.name === 'node_modules' ? [] : walk(path.join(dir, e.name))) : [path.join(dir, e.name)]);
await ok('the till (apps/desktop) and the web POS (pages/pos) never call /api/loss-alerts nor show a loss alert; the manager portal shows it behind reports.voids', () => {
  const files = [...walk(path.join(ROOT, 'apps/desktop/src')), ...walk(path.join(ROOT, 'apps/dashboard/src/pages/pos'))]
    .filter((f) => /\.(ts|tsx)$/.test(f));
  const hits = files.filter((f) => /loss-alerts|loss_alert|WatchList/i.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(hits.map((f) => path.relative(ROOT, f)), []);
  // The dashboard's nav shows the Watch list only with reports.voids; the route is the web's only (requireWebSurface).
  const layout = fs.readFileSync(path.join(ROOT, 'apps/dashboard/src/components/DashboardLayout.tsx'), 'utf8');
  assert.match(layout, /'\/dashboard\/watch-list':\s*\['reports\.voids'\]/);
  // The manager portal (/manager, a manager's own sign-in) shows it as a page gated by the same key — not the till's screen.
  const portal = fs.readFileSync(path.join(ROOT, 'apps/dashboard/src/pages/manager/ManagerDashboard.tsx'), 'utf8');
  assert.match(portal, /key: 'watch',[^\n]*permission: 'reports\.voids'/);
  assert.ok(portal.includes('<WatchListPanel client={posApi} isOwner={false} portal />'));
  const route = fs.readFileSync(path.join(ROOT, 'apps/server/src/routes/lossAlerts.ts'), 'utf8');
  assert.match(route, /router\.use\(requireWebSurface\)/);
});

const DASH = path.join(ROOT, 'apps/dashboard');
const dreq = createRequire(path.join(DASH, 'package.json'));
const bundleDir = fs.mkdtempSync(path.join(DASH, 'node_modules', '.a576-'));
try {
  const entry = path.join(bundleDir, 'entry.tsx');
  fs.writeFileSync(entry, `export { WatchListView } from '${path.join(DASH, 'src/pages/WatchListPage.tsx').replace(/\\/g, '/')}';
export { LossAlertsSettingsView } from '${path.join(DASH, 'src/pages/settings/LossAlertsTab.tsx').replace(/\\/g, '/')}';
export { MemoryRouter } from 'react-router-dom';\n`);
  dreq('esbuild').buildSync({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', outfile: path.join(bundleDir, 'out.mjs'),
    logLevel: 'silent', jsx: 'automatic', external: ['react', 'react-dom'], define: { 'import.meta.env': JSON.stringify({ VITE_SUPABASE_URL: 'http://127.0.0.1:9', VITE_SUPABASE_ANON_KEY: 'test-only', VITE_API_URL: '' }) } });
  // The pages' modules read the browser's location and storage when loaded (the api client); a minimal stand-in.
  const store = new Map();
  globalThis.window ??= { location: new URL('http://localhost:5173/dashboard'), addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; } };
  globalThis.localStorage ??= { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  globalThis.sessionStorage ??= globalThis.localStorage;
  const M = await import(pathToFileURL(path.join(bundleDir, 'out.mjs')).href);
  const React = dreq('react');
  const { renderToStaticMarkup } = dreq('react-dom/server');
  const h = React.createElement;
  const alerts = Array.from({ length: 12 }, (_, i) => ({ id: `a${i}`, kind: 'paid_voids', label: 'Orders voided after payment', period: 'day', business_date: '2026-10-23',
    branch_id: 'W', branch_name: 'Westlands', staff_id: 'm', staff_name: 'Mary', count: 6, amount: null, peer_low: 0, peer_high: 1,
    message: `Mary voided 6 paid orders today (others: 0–1). Worth a look. #${i}`, link: '/dashboard/reports?tab=voids&staff=m', notified_at: null }));
  await ok('the Watch list renders at most 10, numbered, each with "See the list" and "Looked into", and says it is a warning, not a finding', () => {
    const html = renderToStaticMarkup(h(M.MemoryRouter, null, h(M.WatchListView, { data: { alerts, total: 12, top: 10, ready: true }, isOwner: true, onDismiss() {} })));
    assert.equal((html.match(/data-testid="watch-item"/g) || []).length, 10);
    assert.equal((html.match(/See the list/g) || []).length, 10);
    assert.equal((html.match(/Looked into/g) || []).length, 10);
    assert.match(html, /not a finding/);
    assert.match(html, /Showing the 10 most worth a look of 12/);
    assert.match(html, /never the till/);
    // The manager portal: the owner dashboard's report links are not theirs — it names the portal's Reports instead.
    const portalHtml = renderToStaticMarkup(h(M.MemoryRouter, null, h(M.WatchListView, { data: { alerts, total: 12, top: 10, ready: true }, isOwner: false, portal: true, onDismiss() {} })));
    assert.equal((portalHtml.match(/See the list/g) || []).length, 0);
    assert.equal((portalHtml.match(/Looked into/g) || []).length, 10);
    assert.match(portalHtml, /Reports › Voids &amp; Exceptions/);
    assert.doesNotMatch(portalHtml, /settings\/business\/loss-alerts/, 'a manager is not sent to the owner\'s settings');
    assert.doesNotMatch(html.replace(/<[^>]+>/g, ' ').replace(/Loss prevention/g, ''), R.LOSS_BANNED, 'only the settings page\'s own name');
  });
  await ok('the settings render the kinds given (a car park\'s), their amounts, who is told and what is not recorded', () => {
    const d = R.readLossSettings(null);
    const view = { settings: d, defaults: d, limits: R.LOSS_LIMITS, business_type: 'parking',
      kinds: R.kindsFor('parking').map((k) => ({ kind: k, ...R.kindLabel(k, 'parking') })), needs_data: R.lossNeedsData('parking') };
    const html = renderToStaticMarkup(h(M.LossAlertsSettingsView, { view, value: d, onChange() {} }));
    assert.match(html, /data-testid="loss-kind-parking_no_charge"/);
    assert.doesNotMatch(html, /loss-kind-kitchen_removed/);
    assert.match(html, /Tickets voided after payment/);
    assert.match(html, /data-testid="loss-cash_tolerance"[^>]*value="500"|value="500"[^>]*data-testid="loss-cash_tolerance"/);
    assert.match(html, /Nobody is ever told about themselves/);
    assert.match(html, /Who let a vehicle out/);
  });
} finally { fs.rmSync(bundleDir, { recursive: true, force: true }); }

log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
