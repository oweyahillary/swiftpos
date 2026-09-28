/**
 * A276 — a soda must not print on the KITCHEN ticket.
 *
 * Reproduces the live "B Foods / Mama Ngina" data confirmed from the cloud on
 * 2026-09-16: Soft Drinks category is_kitchen=false, no category_stations rows,
 * every soda product is_kitchen=false. The bug was reported as a STANDALONE soda
 * line appearing on the kitchen ticket alongside a spicy combo.
 *
 * This pins the whole chain the desktop runs — stationsForCategory + toUnits to
 * build the lines, then renderTicket for the kitchen and dispatch stations built
 * from the same kind-presets ipcHandlers applies (kitchen = includeUnits:'routed',
 * dispatch = includeUnits:'all'). No printer required: routing is decided before
 * anything reaches paper.
 *
 * Run: tsc -p tsconfig.test.json && node test-dist/test/a276-soda-routing.test.js
 */
import assert from 'node:assert';
import { stationsForCategory, toUnits, kitchenExclusionTerms, stripKitchenIfExcluded, isStandaloneSauce, type CategoryRouting, type StationIds } from '../src/routing';
import { renderTicket, toPreview, kitchenPreset, dispatchPreset } from '../src/index';
import type { BusinessConfig, OrderLine } from '../src/types';

let pass = 0, fail = 0;
const ok = (n: string, f: () => void) => { try { f(); pass++; console.log('PASS ' + n); } catch (e: any) { fail++; console.log('FAIL ' + n + '\n   ' + e.message); } };

// Synthetic stations exactly as apps/desktop ipcHandlers builds them when a
// business has no print_stations rows (the B Foods case).
const ids: StationIds = { kitchen: ['kitchen'], dispatch: ['dispatch'] };

const business: BusinessConfig = {
  name: 'B FOODS', currencyCode: 'KES', vatRate: 16, ctlRate: 2,
  thankYouMessage: 'Thank you', footerCredit: 'SwiftPOS',
} as BusinessConfig;

// Category ids from the live cloud query.
const SOFT_DRINKS = '8b0c8b2e-9909-490e-8438-69ac51fb3638';
const CHICKEN = 'cat-chicken';
const FRIES = 'cat-fries';

// Build the cart the way POSPage / printRouted hand it in.
function buildLines(routing: CategoryRouting): OrderLine[] {
  const cart = [
    // A spicy 3PC combo whose cooked components route to kitchen.
    { product: { id: 'combo', name: '3PC Combo' }, quantity: 1,
      comboComponents: [
        { name: '3PC Chicken', quantity: 1, category_id: CHICKEN },
        { name: 'Fries', quantity: 1, category_id: FRIES },
      ],
      selectedVariants: [{ groupName: 'Spice', optionName: 'Spicy' }] },
    // A STANDALONE bottled soda — the item under test.
    { product: { id: 'soda', name: 'Soda', category_id: SOFT_DRINKS }, quantity: 1 },
  ];
  return cart.map(item => {
    const cat = (item.product as any).category_id ?? null;
    const lineStationIds = stationsForCategory(cat, ids, routing);
    return {
      name: item.product.name, quantity: item.quantity,
      stationIds: lineStationIds, unitPrice: 0, lineTotal: 0,
      units: toUnits(item as any, ids, lineStationIds, routing),
    };
  });
}

const order = (lines: OrderLine[]) => ({
  billNumber: '1001', orderType: 'takeaway' as const, cashierName: 'Test',
  soldAt: new Date(2026, 8, 16, 12, 0, 0), lines, payments: [], changeGiven: 0, total: 0, kotCount: 0,
});

const kitchenText = (lines: OrderLine[]) =>
  toPreview(renderTicket({ order: order(lines), business, station: kitchenPreset('kitchen', 'Kitchen') }));
const dispatchText = (lines: OrderLine[]) =>
  toPreview(renderTicket({ order: order(lines), business, station: dispatchPreset('dispatch', 'Dispatch') }));

// ── The live B Foods routing: cooked categories are kitchen, drinks are not,
//    no category_stations configured. ───────────────────────────────────────
const liveRouting: CategoryRouting = {
  byCategory: {},
  kitchenCategories: new Set([CHICKEN, FRIES]), // Soft Drinks deliberately absent (is_kitchen=false)
};

ok('standalone soda routes to DISPATCH, not kitchen (line.stationIds)', () => {
  const lines = buildLines(liveRouting);
  const soda = lines.find(l => l.name === 'Soda')!;
  assert.deepEqual(soda.stationIds, ['dispatch'], 'soda line should route to dispatch');
});

ok('KITCHEN ticket does NOT contain the soda', () => {
  const t = kitchenText(buildLines(liveRouting));
  assert.ok(/CHICKEN/i.test(t), 'kitchen ticket should show the cooked chicken');
  assert.ok(!/SODA/i.test(t), 'kitchen ticket must NOT show SODA\n--- kitchen ticket ---\n' + t);
});

ok('DISPATCH ticket DOES contain the soda', () => {
  const t = dispatchText(buildLines(liveRouting));
  assert.ok(/SODA/i.test(t), 'dispatch ticket should show the soda\n--- dispatch ticket ---\n' + t);
});

// ── Mutation guard: prove the negative assertion above is real, not vacuous.
//    If the soda's category WERE a kitchen category (the misconfig suspected of
//    causing A276), the render must place it on the kitchen ticket. A test that
//    can't catch that failure isn't protecting anything (rule 23/24). ─────────
ok('MUTATION GUARD: soda in a kitchen category DOES reach the kitchen ticket', () => {
  const mutated: CategoryRouting = {
    byCategory: {},
    kitchenCategories: new Set([CHICKEN, FRIES, SOFT_DRINKS]), // drinks flipped to kitchen
  };
  const lines = buildLines(mutated);
  const soda = lines.find(l => l.name === 'Soda')!;
  assert.deepEqual(soda.stationIds, ['kitchen'], 'mutated soda line should route to kitchen');
  const t = kitchenText(lines);
  assert.ok(/SODA/i.test(t), 'with drinks flagged kitchen, the soda SHOULD appear — render can detect it');
});

// ── A276 FIX (2026-09-28): the whole-LINE drinks rule, exactly as escposBridge.printSale and printRouted now build
//    lines. The mutation guard above shows the old path: a soda in a kitchen-flagged category reached the kitchen,
//    because exclusions only ever touched a line's UNITS and a standalone soda has none. ────────────────────────────
function buildLinesFixed(routing: CategoryRouting, cart: any[], ownerTerms: string[] = []): OrderLine[] {
  const terms = kitchenExclusionTerms(ownerTerms);
  return cart.map(item => {
    const lineStationIds = stationsForCategory((item.product as any).category_id ?? null, ids, routing);
    return {
      name: item.product.name, quantity: item.quantity,
      stationIds: stripKitchenIfExcluded(item.product.name, lineStationIds, ids, terms),
      unitPrice: 0, lineTotal: 0,
      units: toUnits(item as any, ids, lineStationIds, routing)
        .map(u => ({ ...u, stationIds: stripKitchenIfExcluded(u.name, u.stationIds, ids, terms) })),
    };
  });
}
const drinksFlaggedKitchen: CategoryRouting = { byCategory: {}, kitchenCategories: new Set([CHICKEN, FRIES, SOFT_DRINKS]) };
const cartWithSoda = [
  { product: { id: 'combo', name: '3PC Combo' }, quantity: 1,
    comboComponents: [{ name: '3PC Chicken', quantity: 1, category_id: CHICKEN }, { name: 'Fries', quantity: 1, category_id: FRIES }],
    selectedVariants: [{ groupName: 'Spice', optionName: 'Spicy' }] },
  { product: { id: 'soda', name: 'Soda', category_id: SOFT_DRINKS }, quantity: 1 },
];

ok('FIX: a soda in a KITCHEN-flagged category still stays off the kitchen ticket (and reaches dispatch)', () => {
  const lines = buildLinesFixed(drinksFlaggedKitchen, cartWithSoda);
  assert.deepEqual(lines.find(l => l.name === 'Soda')!.stationIds, [], 'kitchen stripped from the soda line');
  const k = kitchenText(lines), d = dispatchText(lines);
  assert.ok(/CHICKEN/i.test(k) && !/SODA/i.test(k), 'kitchen: chicken yes, soda no\n' + k);
  assert.ok(/SODA/i.test(d), 'dispatch still packs the soda\n' + d);
});
ok('FIX: a soda MAPPED to the kitchen station (category_stations) stays off it too', () => {
  const mapped: CategoryRouting = { byCategory: { [SOFT_DRINKS]: ['kitchen'] }, kitchenCategories: new Set([CHICKEN, FRIES]) };
  assert.ok(!/SODA/i.test(kitchenText(buildLinesFixed(mapped, cartWithSoda))));
});
ok('FIX: named drinks (Coke 500ml, Minute Maid, Water) — lines and combo components — never on the kitchen', () => {
  const cart = [
    { product: { id: 'c1', name: 'Coke 500ml', category_id: CHICKEN }, quantity: 2 },
    { product: { id: 'c2', name: 'Minute Maid Mango', category_id: CHICKEN }, quantity: 1 },
    { product: { id: 'c3', name: 'Water 1L', category_id: CHICKEN }, quantity: 1 },
    { product: { id: 'cmb', name: 'Family Meal' }, quantity: 1,
      comboComponents: [{ name: '8PC Chicken', quantity: 1, category_id: CHICKEN }, { name: 'Fanta 2L', quantity: 1, is_kitchen: true }] },
  ];
  const k = kitchenText(buildLinesFixed(drinksFlaggedKitchen, cart));
  assert.ok(/8PC CHICKEN|8PC Chicken/i.test(k), k);
  assert.ok(!/COKE|MINUTE MAID|WATER|FANTA/i.test(k), 'no drink on the kitchen ticket\n' + k);
});
ok('SAFETY: a cooked dish named after its sauce stays ON the kitchen ticket (sauces are not a whole-line rule)', () => {
  const cart = [{ product: { id: 'w', name: 'Wings in BBQ Sauce', category_id: CHICKEN }, quantity: 1 }];
  const lines = buildLinesFixed(drinksFlaggedKitchen, cart);
  assert.deepEqual(lines[0].stationIds, ['kitchen']);
  assert.ok(/WINGS IN BBQ SAUCE/i.test(kitchenText(lines)));
});
ok('A358: a standalone sauce or dip (BBQ Sauce, Honey Mustard Sauce, Garlic Dip) goes to dispatch, never the kitchen', () => {
  const SAUCES = 'cat-sauces';
  const sauceRouting: CategoryRouting = { byCategory: {}, kitchenCategories: new Set([CHICKEN, SAUCES]) };
  const cart = [
    { product: { id: 'w', name: 'Wings Combo 8PC', category_id: CHICKEN }, quantity: 1 },
    { product: { id: 's1', name: 'BBQ Sauce', category_id: SAUCES }, quantity: 1 },
    { product: { id: 's2', name: 'Honey Mustard Sauce', category_id: SAUCES }, quantity: 2 },
    { product: { id: 's3', name: 'Garlic Dip', category_id: SAUCES }, quantity: 1 },
  ];
  const lines = buildLinesFixed(sauceRouting, cart);
  const k = kitchenText(lines), d = dispatchText(lines);
  assert.ok(/WINGS COMBO/i.test(k), k);
  assert.ok(!/BBQ SAUCE|HONEY MUSTARD|GARLIC DIP/i.test(k), 'no sauce on the kitchen ticket\n' + k);
  assert.ok(/BBQ SAUCE/i.test(d) && /HONEY MUSTARD SAUCE/i.test(d) && /GARLIC DIP/i.test(d), 'all on dispatch\n' + d);
});
ok('A358: isStandaloneSauce — the sauce itself yes; a dish named after its sauce no', () => {
  for (const n of ['BBQ Sauce', 'Honey Mustard Sauce', 'Sauce', 'Extra Sauces', 'Garlic Dip', 'Chilli dips']) assert.equal(isStandaloneSauce(n), true, n);
  for (const n of ['Wings in BBQ Sauce', 'Chicken with Pepper Sauce', 'Saucy Wings', 'Sauce Pot Chicken', 'Dipped Tenders', 'Soda']) assert.equal(isStandaloneSauce(n), false, n);
});
ok('the owner\'s own exclusion terms apply to whole lines as well (e.g. "shake")', () => {
  const cart = [{ product: { id: 's', name: 'Chocolate Shake', category_id: CHICKEN }, quantity: 1 }];
  assert.ok(/SHAKE/i.test(kitchenText(buildLinesFixed(drinksFlaggedKitchen, cart))), 'without the term it is cooked-category');
  assert.ok(!/SHAKE/i.test(kitchenText(buildLinesFixed(drinksFlaggedKitchen, cart, ['shake']))), 'with it, off the kitchen');
});

console.log(`\n${fail ? '== ' + fail + ' FAILED ==' : 'all green'} (${pass} passed)`);
process.exit(fail ? 1 : 0);
