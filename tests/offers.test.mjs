/**
 * offers.test.mjs — A445 (owner, 2026-10-11: "a manager can create an offer i.e runs on specific days or on a certain
 * duration" — % or amount off, special price, buy X get Y free, "buy one or buy 2 and get this for free", spend over X,
 * "a custom meal"; dates + days + hours; owner every branch, manager own branch; a manual discount on top within the cap).
 *
 *   node tests/offers.test.mjs
 *
 * RUNS the real packages/core/src/offers.ts on real carts, money checked to the cent; then pins the chain (the cloud's table and
 * check of a sale, the till's copy and cart, the web POS's cart, the receipt, both offer screens).
 *
 * MUTATIONS TO CONFIRM BITE: a unit taking two item offers (no `taken` check) → "one offer per item" fails; buy-get freeing
 * the dearest item → "the cheapest of each group is free" fails; the time window ignoring overnight → "past midnight"
 * fails; a meal applied when it costs more → "never makes a sale dearer" fails; the cloud trusting the till's claimed
 * amount → its pin fails.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [maj, min] = process.versions.node.split('.').map(Number);
if ((maj < 23 || (maj === 23 && min < 6)) && !process.env.OFFERS_TS) {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url)],
    { stdio: 'inherit', env: { ...process.env, OFFERS_TS: '1' } });
  process.exit(r.status ?? 1);
}
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const O = await import(pathToFileURL(path.join(ROOT, 'packages/core/src/offers.ts')).href);

let pass = 0, fail = 0;
const ok = (name, fn) => { try { fn(); console.log(`  ok   ${name}`); pass++; } catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; } };
const offer = (o) => { const r = O.cleanOffer({ id: o.id ?? o.name, ...o }); if (!r.ok) throw new Error(r.error); return r.offer; };

// The menu.
const BURGER = { product_id: 'burger', category_id: 'food', unit_price: 600 };
const PIZZA  = { product_id: 'pizza',  category_id: 'food', unit_price: 900 };
const FRIES  = { product_id: 'fries',  category_id: 'sides', unit_price: 200 };
const SODA   = { product_id: 'soda',   category_id: 'drinks', unit_price: 100 };
const BEER   = { product_id: 'beer',   category_id: 'drinks', unit_price: 300 };
const line = (item, quantity, key = item.product_id) => ({ key, ...item, quantity });
const at = (iso) => new Date(iso);   // the till's local clock (the test machine's)
const WED_5PM = at('2026-10-14T17:00:00');   // a Wednesday

console.log('\nEach kind of offer, on a real cart\n');
ok('% off a category: 20% off drinks', () => {
  const r = O.applyOffers([line(BURGER, 1), line(SODA, 2), line(BEER, 1)], [offer({ name: 'Drinks 20%', kind: 'percent_off', value: 20, applies_to: 'categories', category_ids: ['drinks'] })], { at: WED_5PM });
  assert.equal(r.total, 100);   // (100 + 100 + 300) × 20%
  assert.deepEqual(r.byLine, { soda: 40, beer: 60 });
  assert.equal(r.applied[0].name, 'Drinks 20%');
});
ok('amount off each item: 50 off each burger', () => {
  const r = O.applyOffers([line(BURGER, 3)], [offer({ name: 'Burger 50', kind: 'amount_off', value: 50, applies_to: 'products', product_ids: ['burger'] })], { at: WED_5PM });
  assert.equal(r.total, 150);
});
ok('special price: pizza at 700 (900 → 700 each)', () => {
  const r = O.applyOffers([line(PIZZA, 2)], [offer({ name: 'Pizza day', kind: 'special_price', value: 700, applies_to: 'products', product_ids: ['pizza'] })], { at: WED_5PM });
  assert.equal(r.total, 400);
});
ok('a special price above the menu price takes nothing off (never makes a sale dearer)', () => {
  const r = O.applyOffers([line(SODA, 1)], [offer({ name: 'Odd', kind: 'special_price', value: 150, applies_to: 'products', product_ids: ['soda'] })], { at: WED_5PM });
  assert.equal(r.total, 0); assert.deepEqual(r.applied, []);
});
ok('buy 2 get 1 free, same item: the cheapest of each group is free', () => {
  // 3 beers at 300 and 3 sodas at 100, "drinks: buy 2 get 1" → groups [300,300,300] [100,100,100] → 300 + 100 free.
  const r = O.applyOffers([line(BEER, 3), line(SODA, 3)], [offer({ name: 'B2G1', kind: 'buy_get', buy_qty: 2, get_qty: 1, applies_to: 'categories', category_ids: ['drinks'] })], { at: WED_5PM });
  assert.equal(r.total, 400);
});
ok('…in a mixed group the CHEAPEST is free (2 beers at 300 + 1 soda at 100 → the soda)', () => {
  const r = O.applyOffers([line(BEER, 2), line(SODA, 1)], [offer({ name: 'B2G1', kind: 'buy_get', buy_qty: 2, get_qty: 1, applies_to: 'categories', category_ids: ['drinks'] })], { at: WED_5PM });
  assert.equal(r.total, 100);
  assert.deepEqual(r.byLine, { soda: 100 });
});
ok('…a part group gets nothing (2 beers, buy 2 get 1 → nothing free)', () => {
  const r = O.applyOffers([line(BEER, 2)], [offer({ name: 'B2G1', kind: 'buy_get', buy_qty: 2, get_qty: 1, applies_to: 'products', product_ids: ['beer'] })], { at: WED_5PM });
  assert.equal(r.total, 0);
});
ok('buy 2 burgers, get a soda free (the soda must be in the cart)', () => {
  const o = offer({ name: 'Burger + soda', kind: 'buy_get', buy_qty: 2, get_qty: 1, get_product_id: 'soda', applies_to: 'products', product_ids: ['burger'] });
  assert.equal(O.applyOffers([line(BURGER, 2), line(SODA, 1)], [o], { at: WED_5PM }).total, 100);
  assert.equal(O.applyOffers([line(BURGER, 2)], [o], { at: WED_5PM }).total, 0, 'no soda in the cart, nothing free');
  assert.equal(O.applyOffers([line(BURGER, 4), line(SODA, 1)], [o], { at: WED_5PM }).total, 100, 'one soda: one free');
  assert.equal(O.applyOffers([line(BURGER, 5), line(SODA, 3)], [o], { at: WED_5PM }).total, 200, '5 burgers = 2 groups: 2 sodas free');
});
ok('buy 1 get 1: "buy one and get this for free"', () => {
  const r = O.applyOffers([line(PIZZA, 1), line(FRIES, 1)], [offer({ name: 'Pizza + fries', kind: 'buy_get', buy_qty: 1, get_qty: 1, get_product_id: 'fries', applies_to: 'products', product_ids: ['pizza'] })], { at: WED_5PM });
  assert.equal(r.total, 200);
  assert.deepEqual(r.byLine, { fries: 200 });
});
ok('spend over 2,000, get 10% off the bill', () => {
  const o = offer({ name: 'Spend 2000', kind: 'spend_get', min_spend: 2000, value: 10, spend_type: 'percent' });
  assert.equal(O.applyOffers([line(PIZZA, 2), line(BEER, 1)], [o], { at: WED_5PM }).total, 210);   // 2,100 × 10%
  assert.equal(O.applyOffers([line(PIZZA, 2)], [o], { at: WED_5PM }).total, 0, '1,800 is under 2,000');
});
ok('spend over X counts the bill AFTER item offers (no double benefit)', () => {
  const r = O.applyOffers([line(PIZZA, 3)], [
    offer({ name: 'Pizza day', kind: 'special_price', value: 600, applies_to: 'products', product_ids: ['pizza'] }),
    offer({ name: 'Spend 2000', kind: 'spend_get', min_spend: 2000, value: 200, spend_type: 'amount' }),
  ], { at: WED_5PM });
  assert.equal(r.total, 900);   // 3 × 300 off → 1,800 left, under 2,000: no spend reward
});
ok('a custom meal: burger + fries + soda for 750 (900 → 750)', () => {
  const meal = offer({ name: 'Burger meal', kind: 'meal', value: 750, meal_items: [
    { label: 'Burger', product_ids: ['burger'], qty: 1 }, { label: 'Side', category_ids: ['sides'], qty: 1 }, { label: 'Drink', category_ids: ['drinks'], qty: 1 }] });
  const r = O.applyOffers([line(BURGER, 1), line(FRIES, 1), line(SODA, 1)], [meal], { at: WED_5PM });
  assert.equal(r.total, 150);
  assert.equal(Object.values(r.byLine).reduce((s, v) => s + v, 0), 150, 'the saving spread over the meal\'s lines adds up');
  assert.equal(O.applyOffers([line(BURGER, 2), line(FRIES, 2), line(SODA, 1)], [meal], { at: WED_5PM }).total, 150, 'one drink: one meal');
  assert.equal(O.applyOffers([line(BURGER, 1), line(FRIES, 1)], [meal], { at: WED_5PM }).total, 0, 'no drink: no meal');
});
ok('…a meal never makes a sale dearer (meal price above the items)', () => {
  const meal = offer({ name: 'Bad meal', kind: 'meal', value: 500, meal_items: [{ label: 'Soda', product_ids: ['soda'], qty: 2 }] });
  assert.equal(O.applyOffers([line(SODA, 2)], [meal], { at: WED_5PM }).total, 0);
});
ok('…and a meal that saves nothing leaves its items free for other offers', () => {
  const meal = offer({ name: 'Bad meal', kind: 'meal', value: 500, meal_items: [{ label: 'Soda', product_ids: ['soda'], qty: 2 }] });
  const pct = offer({ name: 'Drinks 20%', kind: 'percent_off', value: 20, applies_to: 'categories', category_ids: ['drinks'] });
  assert.equal(O.applyOffers([line(SODA, 2)], [meal, pct], { at: WED_5PM }).total, 40);
});

console.log('\nOne offer per item, and the best one\n');
ok('one offer per item: a soda in a meal does not also take the drinks %', () => {
  const r = O.applyOffers([line(BURGER, 1), line(FRIES, 1), line(SODA, 2)], [
    offer({ name: 'Burger meal', kind: 'meal', value: 750, meal_items: [{ label: 'B', product_ids: ['burger'], qty: 1 }, { label: 'S', category_ids: ['sides'], qty: 1 }, { label: 'D', category_ids: ['drinks'], qty: 1 }] }),
    offer({ name: 'Drinks 20%', kind: 'percent_off', value: 20, applies_to: 'categories', category_ids: ['drinks'] }),
  ], { at: WED_5PM });
  assert.equal(r.total, 170);   // meal 150 + the second soda 20% (20)
});
ok('each item takes the BEST of the per-item offers, not all of them', () => {
  const r = O.applyOffers([line(BEER, 1)], [
    offer({ name: '10%', kind: 'percent_off', value: 10, applies_to: 'all' }),
    offer({ name: 'Beer 250', kind: 'special_price', value: 250, applies_to: 'products', product_ids: ['beer'] }),
  ], { at: WED_5PM });
  assert.equal(r.total, 50); assert.equal(r.applied.length, 1); assert.equal(r.applied[0].name, 'Beer 250');
});
ok('a weighed line (2.5 kg) takes a % off its whole amount', () => {
  const r = O.applyOffers([{ key: 'meat', product_id: 'meat', category_id: 'butchery', unit_price: 800, quantity: 2.5 }],
    [offer({ name: 'Meat 10%', kind: 'percent_off', value: 10, applies_to: 'categories', category_ids: ['butchery'] })], { at: WED_5PM });
  assert.equal(r.total, 200);
});

console.log('\nWhen an offer runs (the till\'s clock)\n');
const happy = offer({ name: 'Happy hour', kind: 'percent_off', value: 50, applies_to: 'categories', category_ids: ['drinks'],
  days: [1, 2, 3, 4, 5], start_time: '16:00', end_time: '19:00', start_date: '2026-10-01', end_date: '2026-10-31' });
ok('Mon–Fri 16:00–19:00 in October: Wednesday 17:00 yes', () => assert.equal(O.offerRunsAt(happy, WED_5PM, null), true));
ok('…19:00 no (the end is not included), 15:59 no', () => {
  assert.equal(O.offerRunsAt(happy, at('2026-10-14T19:00:00'), null), false);
  assert.equal(O.offerRunsAt(happy, at('2026-10-14T15:59:00'), null), false);
});
ok('…Saturday no, and 1 November no', () => {
  assert.equal(O.offerRunsAt(happy, at('2026-10-17T17:00:00'), null), false);
  assert.equal(O.offerRunsAt(happy, at('2026-11-02T17:00:00'), null), false);
});
ok('an overnight window (Fri 22:00–02:00): Saturday 01:00 belongs to Friday night', () => {
  const late = offer({ name: 'Late', kind: 'percent_off', value: 10, days: [5], start_time: '22:00', end_time: '02:00' });
  assert.equal(O.offerRunsAt(late, at('2026-10-16T23:30:00'), null), true);
  assert.equal(O.offerRunsAt(late, at('2026-10-17T01:00:00'), null), true);
  assert.equal(O.offerRunsAt(late, at('2026-10-17T23:30:00'), null), false, 'Saturday night is not Friday');
});
ok('a branch offer runs only at its branches; a switched-off offer never', () => {
  const b = offer({ name: 'Westlands', kind: 'percent_off', value: 10, branch_ids: ['br-w'] });
  assert.equal(O.offerRunsAt(b, WED_5PM, 'br-w'), true);
  assert.equal(O.offerRunsAt(b, WED_5PM, 'br-k'), false);
  assert.equal(O.offerRunsAt({ ...b, active: false }, WED_5PM, 'br-w'), false);
});
ok('applyOffers skips an offer that is not running, unless the cloud is re-checking a priced sale', () => {
  const cart = [line(SODA, 2)];
  assert.equal(O.applyOffers(cart, [happy], { at: at('2026-10-17T17:00:00') }).total, 0);
  assert.equal(O.applyOffers(cart, [happy], { at: at('2026-10-17T17:00:00'), ignoreTiming: true }).total, 100);
});

console.log('\nWhat a form may save\n');
ok('a name, a kind and a sensible value are required', () => {
  assert.equal(O.cleanOffer({ kind: 'percent_off', value: 10 }).ok, false);
  assert.equal(O.cleanOffer({ name: 'X', kind: 'percent_off', value: 120 }).ok, false);
  assert.equal(O.cleanOffer({ name: 'X', kind: 'buy_get', buy_qty: 2 }).ok, false);
  assert.equal(O.cleanOffer({ name: 'X', kind: 'meal', value: 500, meal_items: [] }).ok, false);
  assert.equal(O.cleanOffer({ name: 'X', kind: 'spend_get', value: 10, spend_type: 'percent' }).ok, false);
  assert.equal(O.cleanOffer({ name: 'X', kind: 'percent_off', value: 10, start_date: '2026-10-31', end_date: '2026-10-01' }).ok, false);
  assert.equal(O.cleanOffer({ name: 'X', kind: 'percent_off', value: 10, start_time: '16:00' }).ok, false);
});
ok('every day of the week is stored as "every day"', () => {
  assert.equal(offer({ name: 'X', kind: 'percent_off', value: 10, days: [0, 1, 2, 3, 4, 5, 6] }).days, null);
});
ok('the screens\' words', () => {
  assert.equal(O.offerWhenLabel(happy), 'Mon–Fri · 16:00–19:00 · 2026-10-01 to 2026-10-31');
  assert.equal(O.offerWhatLabel(offer({ name: 'x', kind: 'buy_get', buy_qty: 2, get_qty: 1, get_product_id: 'soda', applies_to: 'all' }), (id) => id === 'soda' ? 'Soda' : id), 'Buy 2 get 1 Soda free');
});

export { ok, read, ROOT, pass, fail };
if (!globalThis.__OFFERS_MORE) {
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}
