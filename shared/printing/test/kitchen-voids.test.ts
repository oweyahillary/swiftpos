/**
 * kitchen-voids.test.ts — 0.6.28: the Z-report's KITCHEN VOIDS block, and the VOID banner on a kitchen ticket.
 *
 * Owner, 2026-10-01: a sent order could be cancelled after the customer paid in cash. Every item taken back after it
 * was sent is on the paper the owner reads: what, why, made or not, who approved — and the kitchen's ticket says VOID.
 *
 * MUTATION-CHECKED: the block dropped → "the voids are listed" fails; the made total dropped → "…and what was already
 * made" fails; the VOID banner dropped from production tickets → "the kitchen ticket says VOID" fails.
 */
import assert from 'node:assert';
import { renderTicket, renderShiftReport, toPreview, kitchenPreset, type PrintContext, type BusinessConfig, type Order } from '../src/index';

let passed = 0, failed = 0;
const ok = (n: string, f: () => void) => { try { f(); passed++; console.log(`PASS  ${n}`); } catch (e: any) { failed++; console.log(`FAIL  ${n}\n      ${e.message}`); } };

const Z = {
  businessName: 'B Foods', currencyCode: 'KES', cashierName: 'Amy', shiftRef: 'abc', openedAt: new Date('2026-10-01T06:00:00Z'),
  closedAt: new Date('2026-10-01T15:00:00Z'), status: 'closed',
  byMethod: [{ method: 'cash', orders: 1, amount: 100000 }], orderCount: 1, grossSales: 100000, voidCount: 0,
  openingFloat: 0, cashSales: 100000, floatIn: 0, floatOut: 0, expectedCash: 100000, printedAt: new Date('2026-10-01T15:00:05Z'),
};
const z = (r: any) => toPreview(renderShiftReport({ ...Z, ...r }, 80)).split('\n').map((l) => l.trim());

ok('the voids are listed: each line, the total', () => {
  const p = z({ kitchenVoids: { lines: [
    { description: '1x Chicken — Customer changed their mind; made; approved Mary', amount: 100000 },
    { description: '1x Soda — Wrong item punched', amount: 30000 },
  ], total: 130000, madeTotal: 100000 } });
  assert.ok(p.some((l) => /^KITCHEN VOIDS \(2\)$/.test(l)), p.join('\n'));
  assert.ok(p.some((l) => /^1x Chicken - Customer changed their mind; made;/.test(l)), p.join('\n'));
  assert.ok(p.some((l) => /1x Soda - Wrong item punched\s+KES 300\.00$/.test(l)), p.join('\n'));
  assert.ok(p.some((l) => /^Total voided\s+KES 1,300\.00$/.test(l)), p.join('\n'));
});
ok('…and what was already made (the food wasted)', () => {
  const p = z({ kitchenVoids: { lines: [{ description: '1x Chicken — Kitchen mistake; made', amount: 100000 }], total: 100000, madeTotal: 100000 } });
  assert.ok(p.some((l) => /^Of which already made\s+KES 1,000\.00$/.test(l)), p.join('\n'));
});
ok('no voids → no block (as before)', () => {
  const p = z({});
  assert.ok(!p.some((l) => /KITCHEN VOIDS/.test(l)));
});

const ORDER = {
  billNumber: 'T1-9', orderType: 'takeaway', cashierName: 'Amy', soldAt: new Date('2026-10-01T09:00:00Z'),
  lines: [{ name: 'Chicken', quantity: 1, unitPrice: 100000, lineTotal: 100000, units: [], stationIds: ['k'] }],
  payments: [], changeGiven: 0, total: 100000, kotCount: 1,
} as unknown as Order;
ok('the kitchen ticket says VOID for a kitchen void', () => {
  const p = toPreview(renderTicket({ order: ORDER, business: { name: 'B Foods', currencyCode: 'KES' } as BusinessConfig,
    station: kitchenPreset('k', 'Kitchen'), voided: { at: new Date(), by: 'Mary', reason: 'Customer changed their mind' } } as PrintContext),
    { showMargins: false }).split('\n').map((l) => l.trim());
  assert.ok(p.some((l) => /^VOID$/.test(l.replace(/\s+/g, ' ').trim()) || /V\s*O\s*I\s*D/.test(l)), p.join('\n'));
  assert.ok(p.some((l) => /CHICKEN/.test(l)), p.join('\n'));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
