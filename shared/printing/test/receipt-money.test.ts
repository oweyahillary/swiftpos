/**
 * receipt-money.test.ts — A349 (2026-09-28): the printed receipt's money with a DISCOUNT, a TIP, and with and without CTL.
 *
 * Owner, before 0.6.16: "make sure everything especially money math and reporting they have to be spot on … i dont want
 * surprices". Found: the renderer asserted that the lines summed to the order total, but the till passes the total AFTER a
 * discount — so every discounted sale's receipt threw, was caught as "non-blocking", and never printed. A tip was never
 * shown. A business without CTL printed "CTL (0%) 0.00".
 *
 * Worked example (VAT 16 %, CTL 2 %), the same arithmetic the sale stores (payment.ts / the cloud's taxSplit):
 *   lines 750 + 500 = 1,250 · discount 125 → bill 1,125 · net 1,125 / 1.18 = 953.39 · CTL 19.07 · VAT 152.54
 *   953.39 + 19.07 + 152.54 = 1,125.00 (round off 0) · tip 50 → PAY 1,175.00
 *
 * MUTATIONS TO CONFIRM BITE: splitTax back to `summed !== total` → sections 1–2 throw; tax on the undiscounted net →
 * "the taxes are on the discounted net" fails; the CTL guard removed → section 3 fails; PAY without the tip → section 2.
 */

import assert from 'node:assert';
import { renderTicket, toPreview, receiptPreset, splitTax, type PrintContext, type BusinessConfig, type Order } from '../src/index';

let passed = 0, failed = 0;
const ok = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n         ${(e as Error).message}`); }
};

const BIZ: BusinessConfig = { name: 'B Foods', currencyCode: 'KES', vatRate: 16, ctlRate: 2 } as BusinessConfig;
const line = (name: string, cents: number) => ({ name, quantity: 1, unitPrice: cents, lineTotal: cents, units: [], stationIds: ['receipt'] });
const ORDER: Order = {
  billNumber: 'T1-100', orderType: 'takeaway', cashierName: 'Amina', soldAt: new Date('2026-09-28T09:00:00Z'),
  lines: [line('Burger', 75000), line('Juice', 50000)] as any,
  payments: [{ label: 'CASH', amount: 117500 }], changeGiven: 0, total: 125000, kotCount: 0,
};
const paper = (o: Partial<Order>, b: Partial<BusinessConfig> = {}) => toPreview(renderTicket({
  order: { ...ORDER, ...o }, business: { ...BIZ, ...b } as BusinessConfig, station: receiptPreset('r', 'Till'),
} as PrintContext), { showMargins: false }).split('\n').map((l) => l.trim());
const val = (p: string[], label: string) => { const l = p.find((x) => x.startsWith(label)); return l ? l.slice(label.length).trim() : null; };

console.log('\nreceipt money (A349)\n');

console.log('1. the arithmetic');
ok('the taxes are on the discounted net — the same figures the sale stores', () => {
  const t = splitTax([75000, 50000], 112500, 16, 2, 12500);
  assert.deepEqual({ subtotal: t.subtotal, discount: t.discount, ctl: t.ctl, vat: t.vat, roundOff: t.roundOff },
    { subtotal: 95339, discount: 10593, ctl: 1907, vat: 15254, roundOff: 0 });
  // payment.ts: net = 1125/1.18; vat = round2(net*0.16) = 152.54; ctl = round2(net*0.02) = 19.07
  assert.equal(Math.round((1125 / 1.18) * 0.16 * 100), t.vat);
  assert.equal(Math.round((1125 / 1.18) * 0.02 * 100), t.ctl);
});
ok('no discount → exactly the old arithmetic (lines = total)', () => {
  const t = splitTax([75000, 50000], 125000, 16, 2);
  assert.equal(t.discount, 0); assert.equal(t.subtotal + t.ctl + t.vat + t.roundOff, 125000);
});
ok('lines that do not reconcile are still refused (a wrong receipt is worse than none)', () => {
  assert.throws(() => splitTax([75000, 50000], 112500, 16, 2), /less a discount|order total/);
  assert.throws(() => splitTax([75000, 50000], 112500, 16, 2, 10000));
});

console.log('2. a discounted, tipped sale prints');
ok('it prints (it used to throw) with the discount, the taxes, the total, the tip and PAY', () => {
  const p = paper({ total: 112500, discount: 12500, tip: 5000 });
  assert.equal(val(p, 'Discount:'), '-105.93');
  assert.equal(val(p, 'SubTotal:'), '953.39');
  assert.equal(val(p, 'CTL (2%)'), '19.07');
  assert.equal(val(p, 'VAT (16%)'), '152.54');
  assert.equal(val(p, 'Round Off:'), '0.00');
  assert.equal(val(p, 'Total:'), '1,125.00');
  assert.equal(val(p, 'Tip:'), '50.00');
  assert.ok(p.some((l) => l === 'PAY: KES 1,175.00'), p.join('\n'));
});
ok('the printed figures foot: SubTotal + CTL + VAT + Round Off = Total', () => {
  const p = paper({ total: 112500, discount: 12500 });
  const c = (s: string | null) => Math.round(Number(String(s).replace(/,/g, '')) * 100);
  assert.equal(c(val(p, 'SubTotal:')) + c(val(p, 'CTL (2%)')) + c(val(p, 'VAT (16%)')) + c(val(p, 'Round Off:')), c(val(p, 'Total:')));
});
ok('no discount and no tip → no Discount or Tip line, PAY = total', () => {
  const p = paper({});
  assert.equal(val(p, 'Discount:'), null); assert.equal(val(p, 'Tip:'), null);
  assert.ok(p.some((l) => l === 'PAY: KES 1,250.00'));
});

console.log('3. CTL only where it is levied');
ok('a business without CTL prints no CTL line; VAT on the VAT-only net', () => {
  const p = paper({}, { ctlRate: 0 });
  assert.ok(!p.some((l) => l.startsWith('CTL')), p.join('\n'));
  assert.equal(val(p, 'VAT (16%)'), '172.41');   // 1250 / 1.16 = 1077.59 → VAT 172.41
});
ok('a CTL business prints its CTL line', () => {
  assert.equal(val(paper({}), 'CTL (2%)'), '21.19');   // 1250 / 1.18 = 1059.32 → CTL 21.19
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
