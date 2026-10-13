/**
 * shift-report-cashier-copy.test.ts — A454: the cashier's copy printed at a blind shift close.
 *
 * Owner, 2026-10-12: "remove reconciliation from Zreport printed by the cashier during shift closing, it should only show
 * payment method and any other details needed they should not know the variance". The till passes `cashierCopy` with what
 * the cashier declared; the paper shows that, their expenses / pay-outs / kitchen voids — and no sales, expected or variance.
 *
 * MUTATION-CHECKED: drop the `if (r.cashierCopy) return renderCashierCopy(…)` line → "no reconciliation" goes red.
 */
import assert from 'node:assert';
import { renderShiftReport, toPreview } from '../src/index';

let passed = 0, failed = 0;
const ok = (n: string, f: () => void) => { try { f(); passed++; console.log(`PASS  ${n}`); } catch (e: any) { failed++; console.log(`FAIL  ${n}\n      ${e.message}`); } };

const base = {
  businessName: 'Your Business', currencyCode: 'KES', cashierName: 'Amina', shiftRef: '6425f8ed',
  openedAt: new Date('2026-10-12T06:55:40Z'), closedAt: new Date('2026-10-12T15:00:00Z'), status: 'closed',
  byMethod: [{ method: 'cash', orders: 9, amount: 1239000 }, { method: 'mpesa', orders: 4, amount: 455000 }],
  orderCount: 13, grossSales: 1694000, voidCount: 0,
  openingFloat: 300000, cashSales: 1239000, floatIn: 0, floatOut: 0, expectedCash: 1539000, countedCash: 1530000, variance: -9000,
  expenseLines: [{ description: 'Transport — boda · Cash', amount: 20000 }],
  kitchenVoids: { lines: [{ description: '1 x Wings (made) — customer left', amount: 45000 }], total: 45000, madeTotal: 45000 },
  printedAt: new Date('2026-10-12T15:00:05Z'),
};
const copy = { declared: [{ method: 'cash', amount: 1530000 }, { method: 'mpesa', amount: 455000 }] };
const text = (r: any, w: 58 | 80) => toPreview(renderShiftReport(r, w));

for (const w of [80, 58] as const) {
  ok(`${w}mm: the cashier's copy shows what they declared per method and the total`, () => {
    const t = text({ ...base, cashierCopy: copy }, w);
    assert.match(t, /SHIFT CLOSE - CASHIER COPY/);
    assert.match(t, /YOUR COUNT/);
    assert.match(t, /Cash\s+KES 15,300\.00/);
    assert.match(t, /M-PESA\s+KES 4,550\.00/);
    assert.match(t, /Total declared\s+KES 19,850\.00/);
  });
  ok(`${w}mm: no reconciliation — no sales, expected cash or variance on the cashier's paper`, () => {
    const t = text({ ...base, cashierCopy: copy }, w);
    for (const banned of [/RECONCILIATION/, /Expected/i, /Variance/i, /SALES BY METHOD/, /Gross sales/, /16,940\.00/, /15,390\.00/, /-90\.00|90\.00/]) {
      assert.doesNotMatch(t, banned, `${banned} printed:\n${t}`);
    }
  });
  ok(`${w}mm: …but the expenses, kitchen voids and the manager check are there`, () => {
    const t = text({ ...base, cashierCopy: copy }, w).replace(/\s+/g, ' ');
    assert.ok(t.includes('Transport - boda'), t);   // the printer's character set: — → -, · dropped
    assert.ok(t.includes('KITCHEN VOIDS (1)'), t);
    assert.ok(t.includes('AWAITING MANAGER CHECK'), t);
  });
}
ok('without cashierCopy the full Z-report is exactly as before (a manager\'s close)', () => {
  const t = text({ ...base }, 80);
  assert.match(t, /CASH RECONCILIATION/);
  assert.match(t, /Variance \(short\)/);
  assert.equal(text({ ...base, cashierCopy: null }, 80), t);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
