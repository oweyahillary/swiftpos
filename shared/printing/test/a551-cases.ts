/**
 * a551-cases — order lines with variants, built the way the till builds them (escposBridge.printSale → toUnits), for
 * A551's one-line variant (owner, 2026-10-21: "on items with variants assume chicken burger instead of writing `Chicken
 * burger` then `  Chicken burger spicy` why not write `Chicken burger - Spicy` we avoid 2 lines of the same item").
 *
 * Shared by variant-line.test.ts and sample.ts (SAMPLE-OUTPUT.txt), so the paper in the reference is the paper the tests read.
 */

import type { OrderLine } from '../src/index';
import { toUnits, stationsForCategory, type CategoryRouting, type RoutableLine, type StationIds } from '../src/routing';
import { KITCHEN, DISPATCH } from './fixture';

export const ids: StationIds = { kitchen: [KITCHEN], dispatch: [DISPATCH] };
export const routing: CategoryRouting = { byCategory: { 'cat-burgers': [KITCHEN, DISPATCH] }, kitchenCategories: new Set(['cat-burgers']) };

/** A cart line as POSPage hands it to the main process, plus its quantity and money (shillings). */
interface CartLine extends RoutableLine { quantity: number; lineTotal: number }

export const cart: CartLine[] = [
  // The owner's case: the variant repeats the product's name.
  { product: { id: 'p-cb', name: 'Chicken Burger', category_id: 'cat-burgers' }, quantity: 1, lineTotal: 650,
    selectedVariants: [{ groupName: 'Spice', optionName: 'Chicken Burger Spicy' }] },
  // An unrelated variant ("Large") and a modifier, which still prints as its own row.
  { product: { id: 'p-bb', name: 'Beef Burger', category_id: 'cat-burgers' }, quantity: 2, lineTotal: 1700,
    selectedVariants: [{ groupName: 'Size', optionName: 'Large' }], selectedModifiers: [{ name: 'Extra Cheese', price: 0 }] },
  // A long name and a long variant: the combined name wraps under itself, the quantity column kept (A547).
  { product: { id: 'p-gc', name: 'Grilled Chicken Burger Double Patty', category_id: 'cat-burgers' }, quantity: 1, lineTotal: 950,
    selectedVariants: [{ groupName: 'Spice', optionName: 'Grilled Chicken Burger Double Patty - Extra Hot Peri Peri' }] },
];

export function linesOf(c: CartLine[]): OrderLine[] {
  return c.map(l => {
    const lineStationIds = stationsForCategory(l.product.category_id, ids, routing);
    const cents = Math.round(l.lineTotal * 100);
    return {
      name: l.product.name, quantity: l.quantity, stationIds: lineStationIds,
      unitPrice: Math.round(cents / l.quantity), lineTotal: cents,
      units: toUnits(l, ids, lineStationIds, routing),
    };
  });
}

export const variantCases = (() => {
  const lines = linesOf(cart);
  return { lines, total: lines.reduce((a, l) => a + l.lineTotal, 0) };
})();
