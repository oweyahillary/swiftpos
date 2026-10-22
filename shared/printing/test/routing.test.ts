/**
 * Characterization test for the shared routing module (A249, print-parity Ph2).
 * Pins the behaviour lifted from the desktop's escposBridge so the extraction —
 * and any future edit — provably keeps the same routing decisions.
 */
import assert from 'node:assert';
import {
  idsByKind, stationsForCategory, toUnits, isExcludedFromKitchen, describeFromText,
  type CategoryRouting, type StationIds,
} from '../src/routing';

let pass = 0, fail = 0;
const ok = (n: string, f: () => void) => { try { f(); pass++; console.log('PASS ' + n); } catch (e: any) { fail++; console.log('FAIL ' + n + '\n   ' + e.message); } };

const ids: StationIds = { kitchen: ['k1'], dispatch: ['d1'] };
const routing: CategoryRouting = { byCategory: { catFood: ['k1'], catDrink: ['d1'] }, kitchenCategories: new Set(['catFoodK']) };

ok('idsByKind groups by kind', () => {
  assert.deepEqual(idsByKind([{ id: 'k1', kind: 'kitchen' } as any, { id: 'd1', kind: 'dispatch' } as any]), { kitchen: ['k1'], dispatch: ['d1'] });
});
ok('no category -> dispatch', () => assert.deepEqual(stationsForCategory(null, ids, routing), ['d1']));
ok('configured category wins', () => assert.deepEqual(stationsForCategory('catFood', ids, routing), ['k1']));
ok('unconfigured + is_kitchen -> kitchen', () => assert.deepEqual(stationsForCategory('catFoodK', ids, routing), ['k1']));
ok('unconfigured + not kitchen -> dispatch', () => assert.deepEqual(stationsForCategory('catX', ids, routing), ['d1']));
ok('combo components route on own category', () => {
  const u = toUnits({ product: { id: 'c', name: 'Combo' }, comboComponents: [{ name: 'Chicken', quantity: 1, category_id: 'catFood' }, { name: 'Soda', quantity: 1, category_id: 'catDrink' }] }, ids, ids.dispatch, routing);
  assert.equal(u.length, 2); assert.deepEqual(u[0].stationIds, ['k1']); assert.deepEqual(u[1].stationIds, ['d1']);
});
ok('variant attaches to first component', () => {
  const u = toUnits({ product: { id: 'c', name: 'Combo' }, comboComponents: [{ name: 'Chicken', quantity: 1, category_id: 'catFood' }], selectedVariants: [{ groupName: 'Spice', optionName: 'hot' }] }, ids, ids.dispatch, routing);
  assert.equal(u[0].attributes[0].option, 'hot'); assert.equal(u[0].chosen, true);
});
ok('plain product + variant synthesises a unit', () => {
  const u = toUnits({ product: { id: 'p', name: 'Burger' }, selectedVariants: [{ groupName: 'Size', optionName: 'Large' }] }, ids, ids.kitchen, routing);
  assert.equal(u.length, 1); assert.equal(u[0].name, 'Burger'); assert.deepEqual(u[0].stationIds, ['k1']);
});
ok("A559: a modifier routes to the line's stations + dispatch", () => {
  const u = toUnits({ product: { id: 'p', name: 'Wings' }, selectedModifiers: [{ name: 'BBQ Sauce', price: 50 }] }, ids, ids.kitchen, routing);
  assert.deepEqual(u[u.length - 1].stationIds, ['k1', 'd1']); assert.equal(u[u.length - 1].priceDelta, 5000);
  assert.equal(u[u.length - 1].modifier, true);
  // A dispatch-only line: its extra is on dispatch once, not twice.
  assert.deepEqual(toUnits({ product: { id: 's', name: 'Soda' }, selectedModifiers: [{ name: 'Ice' }] }, ids, ids.dispatch, routing)[0].stationIds, ['d1']);
});
ok("A559: a combo's modifier follows the combo LINE's routing, not a component's", () => {
  const combo = { product: { id: 'c', name: 'Combo' }, comboComponents: [{ name: 'Chicken', quantity: 1, category_id: 'catFood' }, { name: 'Soda', quantity: 1, category_id: 'catDrink' }],
    selectedModifiers: [{ optionName: 'Extra Cheese' }] };
  const k = toUnits(combo, ids, ids.kitchen, routing);
  assert.deepEqual(k[2].stationIds, ['k1', 'd1']); assert.equal(k[2].modifier, true);
  assert.equal(k[0].modifier, undefined, 'a component is not a modifier');
  assert.deepEqual(toUnits(combo, ids, ids.dispatch, routing)[2].stationIds, ['d1']);
});
ok("A555: a till's modifier ({ optionName }) prints like the web's ({ name })", () => {
  const u = toUnits({ product: { id: 'p', name: 'Wings' }, selectedModifiers: [{ optionName: 'Extra Cheese', price: 50 }] }, ids, ids.kitchen, routing);
  const m = u[u.length - 1];
  assert.equal(m.name, 'Extra Cheese'); assert.deepEqual(m.stationIds, ['k1', 'd1']); assert.equal(m.priceDelta, 5000);   // A559: + the kitchen
  assert.equal(toUnits({ product: { id: 'p', name: 'Wings' }, selectedModifiers: [{ optionName: '  ', price: 0 }] }, ids, ids.kitchen, routing)
    .some((x) => x.name.trim() === ''), false, 'a blank name still prints nothing');
});
ok('description fallback, but not prose', () => {
  assert.deepEqual(describeFromText('chicken + fries + soda'), ['chicken', 'fries', 'soda']);
  assert.deepEqual(describeFromText('Our famous crispy chicken, marinated for 24 hours.'), []);
});
ok('exclusions match whole words only', () => {
  assert.equal(isExcludedFromKitchen('Soda 1.25L', ['soda']), true);
  assert.equal(isExcludedFromKitchen('Sodalite Special', ['soda']), false);
});

console.log(`\n${fail ? '== ' + fail + ' FAILED ==' : 'all green'} (${pass} passed)`);
process.exit(fail ? 1 : 0);
