/**
 * A367 (0.6.24) — notes on an item and on the whole order reach the paper.
 *
 * Owner, 2026-09-30: "can we add notes in the order maybe if a customer wants a mixture of 3 normal and 2 spicy chicken
 * pieces or they want exta cheese if it pizza or no salt etc".
 *
 * The kitchen ticket prints the order's note under the header and each line's note under the dish, one row per line
 * the cashier typed; the receipt prints the same. A ticket with no notes is byte-identical to before (bytes --check).
 *
 * Run: tsc -p tsconfig.test.json && node test-dist/test/order-notes.test.js
 *
 * MUTATIONS TO CONFIRM BITE: the kitchen's order note dropped → "kitchen: order note" fails; the flat-dish note dropped
 * again (the `continue` before it) → "one row per typed line" fails; the line note printed as one run-on row (noteRows not splitting) → "one row per typed line" fails; the receipt's order note dropped →
 * "receipt: order note" fails.
 */
import assert from 'node:assert';
import { renderTicket, toPreview, kitchenPreset, receiptPreset } from '../src/index';
import type { BusinessConfig, OrderLine } from '../src/types';

let pass = 0, fail = 0;
const ok = (n: string, f: () => void) => { try { f(); pass++; console.log('PASS ' + n); } catch (e: any) { fail++; console.log('FAIL ' + n + '\n   ' + e.message); } };

const business = { name: 'B FOODS', currencyCode: 'KES', vatRate: 16, ctlRate: 0 } as BusinessConfig;
const line = (name: string, quantity: number, note?: string): OrderLine =>
  ({ name, quantity, stationIds: ['kitchen'], unitPrice: 10000, lineTotal: 10000 * quantity, units: [], note });
const order = (lines: OrderLine[], note?: string) => ({
  billNumber: '1001', orderType: 'takeaway' as const, cashierName: 'Test',
  soldAt: new Date(2026, 8, 30, 12, 0, 0), lines, payments: [], changeGiven: 0,
  total: lines.reduce((a, l) => a + l.lineTotal, 0), kotCount: 1, note,
});
const kitchen = (o: ReturnType<typeof order>) => toPreview(renderTicket({ order: o, business, station: kitchenPreset('kitchen', 'Kitchen') }));
const receipt = (o: ReturnType<typeof order>) => toPreview(renderTicket({ order: o, business, station: receiptPreset('receipt', 'Receipt') }));

const withNotes = order([line('Chicken Piece', 5, '3 normal\n2 spicy'), line('Pizza', 1, 'Extra cheese'), line('Chips', 1)],
  'Deliver to gate B');

ok('kitchen: order note under the header, before the first dish', () => {
  const t = kitchen(withNotes);
  assert.match(t, /NOTE: Deliver to gate B/);
  assert.ok(t.indexOf('NOTE: Deliver to gate B') < t.indexOf('CHICKEN PIECE'), t);
});
ok('kitchen: one row per typed line, under its own dish', () => {
  const t = kitchen(withNotes);
  assert.match(t, /\n\s+\*\* 3 normal\n\s+\*\* 2 spicy\n/);
  assert.ok(t.indexOf('** 2 spicy') < t.indexOf('PIZZA'), 'the chicken note is not under the pizza');
  assert.ok(t.indexOf('** Extra cheese') > t.indexOf('PIZZA'));
});
ok('kitchen: a dish with no note prints no note row', () => {
  const t = kitchen(withNotes);
  const chips = t.slice(t.indexOf('CHIPS'));
  assert.doesNotMatch(chips, /\*\*/);
});
ok('kitchen: a combo (a line with parts) prints its note under the parts', () => {
  const combo: OrderLine = { ...line('3PC Combo', 1, 'No salt'),
    units: [{ name: '3PC Chicken', quantity: 1, priceDelta: 0, attributes: [], stationIds: ['kitchen'] } as any] };
  const t = kitchen(order([combo]));
  assert.ok(t.indexOf('** No salt') > t.indexOf('3PC Chicken'), t);
});
ok('receipt: order note and line notes', () => {
  const t = receipt(withNotes);
  assert.match(t, /Note: Deliver to gate B/);
  assert.match(t, /\*\* 3 normal\n\s+\*\* 2 spicy/);
  assert.match(t, /\*\* Extra cheese/);
});
ok('no notes → nothing about notes on either paper', () => {
  const plain = order([line('Chips', 1)]);
  assert.doesNotMatch(kitchen(plain), /NOTE|\*\*/);
  assert.doesNotMatch(receipt(plain), /Note:|\*\*/);
});
ok('a blank note (only spaces / new lines) prints nothing', () => {
  const blank = order([line('Chips', 1, '  \n ')], ' \n');
  assert.doesNotMatch(kitchen(blank), /NOTE|\*\*/);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
