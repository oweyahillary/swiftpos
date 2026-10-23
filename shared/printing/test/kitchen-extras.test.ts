/**
 * kitchen-extras.test — A559: an extra (a modifier) prints on the KITCHEN ticket too, under its dish.
 *
 * Owner, 2026-10-22, after testing 1.0.20: "yes let it print in the kitchen receipt too, and notes also since some can
 * only be done by the chef".
 *
 * toUnits (routing.ts) sent every modifier to dispatch only; a modifier now goes where its LINE goes and to dispatch.
 * On a production ticket it prints as "+ Extra Cheese" under the dish; it is not a dish of its own — it never makes a
 * line print on a ticket (the line's own routing does) and it is not counted in "items to cook". Cart lines are built the
 * way the till and the web build them (toUnits + stripKitchenIfExcluded on the line and on each unit, as
 * escposBridge.printSale and printRouted do).
 *
 * Run: tsc -p tsconfig.test.json && node test-dist/test/kitchen-extras.test.js
 *
 * MUTATIONS TO CONFIRM BITE (each made, seen red, reverted): the modifier routed to ids.dispatch only again → "the extra
 * under the dish" and the count fail; lineEarnsPlace without the `modifier` exclusion (the old rule) → "a soda's extra
 * does not take the soda to the kitchen" fails; the count adding every visible unit (extras too) → "counted once" fails;
 * the "+ " dropped → "+ Extra Cheese" fails.
 */
import assert from 'node:assert';
import { renderTicket, toPreview, kitchenPreset, dispatchPreset, receiptPreset, hasPrintableContent } from '../src/index';
import type { BusinessConfig, OrderLine } from '../src/types';
import { toUnits, stationsForCategory, kitchenExclusionTerms, stripKitchenIfExcluded, type CategoryRouting, type RoutableLine,
  type StationIds } from '../src/routing';

let pass = 0, fail = 0;
const ok = (n: string, f: () => void) => { try { f(); pass++; console.log('PASS ' + n); } catch (e: any) { fail++; console.log('FAIL ' + n + '\n   ' + e.message); } };

const ids: StationIds = { kitchen: ['st-k'], dispatch: ['st-d'] };
// c-food is cooked; c-drinks is (wrongly, as some clients have it) flagged for the kitchen too — the drinks rule keeps it off.
const routing: CategoryRouting = { byCategory: { 'c-food': ['st-k'] }, kitchenCategories: new Set(['c-drinks']) };
const terms = kitchenExclusionTerms([]);
const business = { name: 'B FOODS', currencyCode: 'KES', vatRate: 16, ctlRate: 0 } as BusinessConfig;

type Cart = RoutableLine & { quantity: number; price: number; notes?: string };
/** As escposBridge.printSale builds a line. */
const lineOf = (l: Cart): OrderLine => {
  const lineIds = stationsForCategory(l.product.category_id, ids, routing);
  return {
    name: l.product.name, quantity: l.quantity, unitPrice: l.price * 100, lineTotal: l.price * 100 * l.quantity,
    stationIds: stripKitchenIfExcluded(l.product.name, lineIds, ids, terms),
    units: toUnits(l, ids, lineIds, routing).map(u => ({ ...u, stationIds: stripKitchenIfExcluded(u.name, u.stationIds, ids, terms) })),
    note: l.notes,
  };
};
const order = (cart: Cart[], note?: string) => {
  const lines = cart.map(lineOf);
  return { billNumber: 'T1-2001', orderType: 'takeaway' as const, cashierName: 'Cate', soldAt: new Date(2026, 9, 22, 13, 5, 0),
    lines, payments: [], changeGiven: 0, total: lines.reduce((a, l) => a + l.lineTotal, 0), kotCount: 1, note };
};
const K = kitchenPreset('st-k', 'Kitchen');
const D = dispatchPreset('st-d', 'Dispatch');
const R = receiptPreset('st-r', 'Till');
const paper = (o: ReturnType<typeof order>, station = K) => toPreview(renderTicket({ order: o, business, station }));
const rows = (t: string) => t.split('\n').map(r => r.replace(/^\|/, '').replace(/\|\s*$/, '').replace(/\s+$/, ''));

// The till's shape: VariantModal hands { optionName, price } for an extra (A555), not { name }.
const wings: Cart = { product: { id: 'p-wings', name: 'Wings', category_id: 'c-food' }, quantity: 1, price: 600,
  selectedModifiers: [{ optionName: 'Extra Cheese', price: 50 }], notes: 'Well done' };
const burger: Cart = { product: { id: 'p-burger', name: 'Chicken Burger', category_id: 'c-food' }, quantity: 2, price: 450,
  selectedVariants: [{ groupName: 'Spice', optionName: 'Spicy' }], selectedModifiers: [{ optionName: 'Extra Cheese', price: 50 }, { name: 'No Onions' }] };
const soda: Cart = { product: { id: 'p-soda', name: 'Soda 500ml', category_id: 'c-drinks' }, quantity: 1, price: 120,
  selectedModifiers: [{ optionName: 'Ice' }] };
const combo: Cart = { product: { id: 'p-combo', name: '3PC Chicken Combo', category_id: 'c-food' }, quantity: 1, price: 890,
  comboComponents: [{ name: '3PC Chicken', quantity: 1, category_id: 'c-food' }, { name: 'Soda 1.25L', quantity: 1, is_kitchen: false }],
  selectedModifiers: [{ optionName: 'Extra Gravy' }, { optionName: 'BBQ Sauce' }] };

const full = order([wings, burger, soda, combo], 'Allergy: nuts');
const k = paper(full);
console.log(k);

ok("the kitchen ticket: the till's extra ({ optionName }) under the dish, as \"+ Extra Cheese\"", () => {
  const r = rows(k);
  const at = r.indexOf('1   WINGS');
  assert.ok(at >= 0, k);
  assert.equal(r[at + 1], '      + Extra Cheese');
});
ok('a dish with a variant and two extras: the variant on its row, each extra on its own row under it', () => {
  const r = rows(k);
  const at = r.indexOf('2   CHICKEN BURGER - SPICY');
  assert.ok(at >= 0, k);
  assert.deepEqual(r.slice(at + 1, at + 3), ['      + Extra Cheese', '      + No Onions']);
});
ok("a combo's extra follows the combo line (the kitchen here); a sauce extra stays off the kitchen (A358)", () => {
  const r = rows(k);
  const at = r.indexOf('1   3PC CHICKEN COMBO');
  assert.ok(at >= 0, k);
  assert.deepEqual(r.slice(at + 1, at + 3), ['      3PC Chicken', '      + Extra Gravy']);
  assert.ok(!k.includes('BBQ Sauce') && !k.includes('Soda 1.25L'), k);
});
ok("a soda's extra does not take the soda to the kitchen (the drinks rule, A276)", () => {
  assert.ok(!/SODA 500ML/.test(k) && !/\+ Ice/.test(k), k);
  assert.equal(hasPrintableContent({ order: order([soda]), business, station: K }), false, 'no kitchen ticket for a soda with ice');
});
ok('the notes reach the kitchen: the order note first, the line note under its dish after the extra', () => {
  const r = rows(k);
  assert.ok(r.indexOf('NOTE: Allergy: nuts') >= 0 && r.indexOf('NOTE: Allergy: nuts') < r.indexOf('1   WINGS'), k);
  assert.equal(r[r.indexOf('1   WINGS') + 2], '      ** Well done');
});
ok('the extras are counted once with their dish: 3 items to cook (Wings, the Burger line, 3PC Chicken)', () => {
  // Wings 1 + Burger 1 (its variant unit) + combo 1 (3PC Chicken) = 3; extras add nothing.
  assert.ok(rows(k).some(t => t.trim() === '3 items to cook'), k);
});
ok('a kitchen dish sold with only an extra stays on the kitchen ticket (it was dropped: its one unit went to dispatch)', () => {
  const t = paper(order([{ ...wings, notes: undefined }]));
  assert.ok(rows(t).includes('1   WINGS') && rows(t).includes('      + Extra Cheese') && rows(t).some(x => x.trim() === '1 items to cook'), t);
});
ok('the dispatch ticket: every extra, sauce and ice too, still with the packer', () => {
  const d = paper(full, D);
  for (const x of ['+ Extra Cheese', '+ No Onions', '+ Ice', '+ Extra Gravy', '+ BBQ Sauce']) assert.ok(d.includes(x), `${x}\n${d}`);
  assert.ok(rows(d).some(t => t.trim() === '4 bags'), d);
});
ok('the receipt is unchanged: the extra a plain sub-row with its price, no "+"', () => {
  const r = paper(full, R);
  assert.ok(/ {2}Extra Cheese/.test(r) && !r.includes('+ Extra'), r);
});

console.log(`\n${fail ? '== ' + fail + ' FAILED ==' : 'all green'} (${pass} passed)`);
process.exit(fail ? 1 : 0);
