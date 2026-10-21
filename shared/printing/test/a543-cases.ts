/**
 * a543-cases — a long kitchen order, for A543's Font B kitchen ticket (owner, 2026-10-21: "change the font of the kitchen
 * printer, packing is okay" — chose "the printer's smaller Font B so long orders fit on less paper").
 *
 * Shared by kitchen-font.test.ts and sample.ts (SAMPLE-OUTPUT.txt's before/after and its paper estimate), so the order
 * the estimate is measured on is the one the tests read.
 */

import type { Order, OrderUnit, Document } from '../src/index';
import { KITCHEN, DISPATCH } from './fixture';

const BOTH = [KITCHEN, DISPATCH];
const unit = (name: string, opts: Partial<OrderUnit> = {}): OrderUnit => ({
  productId: `p-${name.toLowerCase().replace(/\W+/g, '-')}`, name, quantity: 1, portions: 1,
  priceDelta: 0, chosen: true, stationIds: BOTH, attributes: [], ...opts,
});

/** A busy table: long dish names, components, split spice, the cashier's notes. */
export const longOrder: Order = {
  billNumber: 'T1--6204',
  orderType: 'dine_in',
  tableNumber: '14',
  cashierName: 'Amina Wanjiru',
  soldAt: new Date(2026, 9, 21, 13, 5, 40),
  kotCount: 1,
  changeGiven: 0,
  total: 1010000,
  payments: [],
  note: 'Birthday table - bring the cake out with the mains, not before',
  lines: [
    { name: 'Family Feast Bucket 12PC With Two Large Sides', quantity: 1, unitPrice: 320000, lineTotal: 320000, stationIds: [],
      units: [
        unit('12PC Original Recipe Chicken', { portions: 12, chosen: false,
          attributes: [{ group: 'Spice', option: 'spicy', count: 6, priceDelta: 0 }, { group: 'Spice', option: 'normal', count: 6, priceDelta: 0 }] }),
        unit('Large Fries'), unit('Large Coleslaw With Extra Dressing On The Side'),
      ],
      note: 'Cut the chicken into small pieces for the kids' },
    { name: 'Grilled Tilapia Whole Fish Served With Ugali And Sukuma Wiki', quantity: 2, unitPrice: 120000, lineTotal: 240000,
      stationIds: [], units: [unit('Whole Tilapia', { chosen: false, attributes: [{ group: 'Cook', option: 'well done', count: 1, priceDelta: 0 }] }),
        unit('Ugali'), unit('Sukuma Wiki Fried With Onions And Tomatoes')] },
    { name: 'Beef Burger Double Patty Cheese', quantity: 3, unitPrice: 85000, lineTotal: 255000, stationIds: [],
      units: [unit('Double Beef Patty', { chosen: false }), unit('No Onions, Extra Pickles, Cheese Melted On Top'), unit('Medium Fries')] },
    { name: 'Chicken Wings 10PC Honey Barbecue Glaze', quantity: 2, unitPrice: 65000, lineTotal: 130000, stationIds: [],
      units: [unit('10PC Wings', { portions: 10, chosen: false, attributes: [{ group: 'Spice', option: 'spicy', count: 10, priceDelta: 0 }] })],
      note: 'Sauce separately' },
    { name: 'Vegetable Samosa', quantity: 6, unitPrice: 5000, lineTotal: 30000, stationIds: [KITCHEN], units: [] },
    { name: 'Mandazi Basket For The Table', quantity: 1, unitPrice: 35000, lineTotal: 35000, stationIds: [KITCHEN], units: [] },
  ],
};

/**
 * Paper a production ticket uses, in mm, at 203 dpi (8 dots/mm) — the method sample.ts uses for the receipt:
 *   a normal line advances the document's line spacing (ESC 3 n), else ESC 2 = 1/6" (~33.8 dots, 4.23 mm);
 *   a double-height line advances its glyph — 48 dots in Font A, 34 in Font B (at ESC 2, escpos.ts);
 *   the feed before the cut is that many lines at 1/6" (the spacing is back to the default by then).
 */
export function productionPaperMm(doc: Document, feedBeforeCut: number): number {
  const DOT = 25.4 / 203;
  const tallDots = doc.font === 'B' ? 34 : 48;
  let mm = 0;
  for (const b of doc.blocks) {
    if (b.kind === 'text') mm += (b.size === 'tall' || b.size === 'large' ? tallDots : (doc.lineSpacing ?? 34)) * DOT;
    else if (b.kind === 'feed') mm += b.lines * 34 * DOT;
  }
  return mm + feedBeforeCut * (25.4 / 6);
}
