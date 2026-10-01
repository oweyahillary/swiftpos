/**
 * delivery-and-expenses.test.ts — 0.6.27: the delivery fee on the receipt, and the Z-report's new lines (a prospect's
 * requests 3, 5 and 9: "cash will be 300 less but mpesa will be 300 more" — the paper says why).
 *
 * MUTATION-CHECKED: PAY without the fee → "PAY includes it" fails; the riders' line dropped → "why cash is lower" fails;
 * the not-from-the-drawer section dropped → "an M-Pesa expense is listed apart" fails.
 */
import assert from 'node:assert';
import { renderTicket, renderShiftReport, toPreview, receiptPreset, type PrintContext, type BusinessConfig, type Order } from '../src/index';

let passed = 0, failed = 0;
const ok = (n: string, f: () => void) => { try { f(); passed++; console.log(`PASS  ${n}`); } catch (e: any) { failed++; console.log(`FAIL  ${n}\n      ${e.message}`); } };

const BIZ = { name: 'B Foods', currencyCode: 'KES', vatRate: 16, ctlRate: 0 } as BusinessConfig;
const ORDER: Order = {
  billNumber: 'T1-7', orderType: 'delivery', cashierName: 'Amy', soldAt: new Date('2026-09-30T09:00:00Z'),
  deliveryPerson: 'Eugene',
  lines: [{ name: 'Chicken', quantity: 1, unitPrice: 100000, lineTotal: 100000, units: [], stationIds: ['receipt'] }] as any,
  payments: [{ label: 'MPESA', amount: 130000 }], changeGiven: 0, total: 100000, kotCount: 0,
} as Order;
const receipt = (o: Partial<Order>) => toPreview(renderTicket({
  order: { ...ORDER, ...o }, business: BIZ, station: receiptPreset('r', 'Till'),
} as PrintContext), { showMargins: false }).split('\n').map((l) => l.trim());

ok('the fee prints after the total, outside the taxes; PAY includes it (1,000 + 300 = 1,300)', () => {
  const p = receipt({ deliveryFee: 30000 });
  assert.ok(p.some((l) => /^Total:\s+1,000\.00$/.test(l)), p.join('\n'));
  assert.ok(p.some((l) => /^Delivery fee:\s+300\.00$/.test(l)), p.join('\n'));
  assert.ok(p.some((l) => /PAY: KES 1,300\.00/.test(l)), p.join('\n'));
});
ok('no fee → no line, PAY = the bill (as before)', () => {
  const p = receipt({});
  assert.ok(!p.some((l) => /Delivery fee/.test(l)));
  assert.ok(p.some((l) => /PAY: KES 1,000\.00/.test(l)));
});

const Z = {
  businessName: 'B Foods', currencyCode: 'KES', cashierName: 'Amy', shiftRef: 'abc', openedAt: new Date('2026-09-30T06:00:00Z'),
  closedAt: new Date('2026-09-30T15:00:00Z'), status: 'closed',
  byMethod: [{ method: 'mpesa', orders: 1, amount: 130000 }], orderCount: 1, grossSales: 100000, voidCount: 0,
  openingFloat: 100000, cashSales: 0, floatIn: 0, floatOut: 0, expectedCash: 50000, printedAt: new Date('2026-09-30T15:00:05Z'),
};
const z = (r: any) => toPreview(renderShiftReport({ ...Z, ...r }, 80)).split('\n').map((l) => l.trim());

ok('why cash is lower and M-Pesa higher: delivery fees in the payments, paid to riders from the drawer', () => {
  const p = z({ deliveryFees: 30000, riderPayouts: 30000, expenses: 20000 });
  assert.ok(p.some((l) => /^Delivery fees \(in payments\)\s+KES 300\.00$/.test(l)), p.join('\n'));
  assert.ok(p.some((l) => /^- Paid to riders\s+KES 300\.00$/.test(l)), p.join('\n'));
});
ok('an M-Pesa expense is listed apart — not from the drawer', () => {
  const p = z({ otherExpenses: [{ method: 'mpesa', amount: 120000 }] });
  const i = p.findIndex((l) => l === 'EXPENSES NOT FROM THE DRAWER');
  assert.ok(i >= 0 && /^- M-PESA\s+KES 1,200\.00$/.test(p[i + 1]), p.join('\n'));
});
ok('none of these → the report is exactly as before', () => {
  assert.equal(z({ deliveryFees: null, riderPayouts: null, otherExpenses: [] }).join('\n'), z({}).join('\n'));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
