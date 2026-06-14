// Pure payment maths — no React, no Electron. Kept separate so the dryrun
// harness can exercise the exact code the till runs (see dryrun/payment-logic).
//
// Conventions: KES with cent precision; comparisons use a 1-cent epsilon so
// floating-point dust never blocks a sale.

export const EPSILON = 0.01;
export const round2 = (n: number) => Math.round(n * 100) / 100;

export type LegMethod = 'cash' | 'mpesa' | 'card';

export interface DraftLeg {
  method: LegMethod;
  amount: string;     // raw input; '' means "the remaining balance"
  tendered: string;   // cash only
  reference: string;  // mpesa/card only
}

// VAT-inclusive pricing: VAT is extracted from the post-discount goods total.
// Tips are not VATable.
export function computeTotals(subtotal: number, opts: {
  discountRaw: number;
  discountMode: 'amount' | 'percent';
  tipRaw: number;
  vatRate: number;
}) {
  const { discountRaw, discountMode, tipRaw, vatRate } = opts;
  const discountAmount = round2(
    discountMode === 'percent'
      ? subtotal * Math.min(Math.max(discountRaw, 0), 100) / 100
      : Math.min(Math.max(discountRaw, 0), subtotal)
  );
  const tipAmount = round2(Math.max(tipRaw, 0));
  const discountedSubtotal = round2(subtotal - discountAmount);
  const vatAmount = round2(discountedSubtotal - discountedSubtotal / (1 + vatRate / 100));
  const total = round2(discountedSubtotal + tipAmount);
  return { discountAmount, tipAmount, vatAmount, total };
}

// Resolves draft legs against the total due. A blank amount means "the
// remaining balance" (assigned to the FIRST blank leg), so the common
// single-payment flow needs zero typing and a 2-way split needs one number.
export function resolveLegs(legs: DraftLeg[], total: number) {
  let remaining = total;
  const out: { leg: DraftLeg; amount: number }[] = [];
  const blanks: number[] = [];
  legs.forEach((leg, i) => {
    const explicit = leg.amount.trim() !== '';
    const amt = explicit ? round2(Math.max(parseFloat(leg.amount) || 0, 0)) : 0;
    if (explicit) remaining = round2(remaining - amt);
    else blanks.push(i);
    out.push({ leg, amount: amt });
  });
  if (blanks.length > 0 && remaining > EPSILON) {
    out[blanks[0]].amount = round2(remaining);
    remaining = 0;
  }
  return { out, remaining: round2(remaining) };
}

// Final per-leg view with cash tendered/change resolved.
export function buildLegView(legs: DraftLeg[], total: number) {
  const resolved = resolveLegs(legs, total);
  const view = resolved.out.map(({ leg, amount }) => {
    const tendered = leg.method === 'cash' && leg.tendered.trim() !== ''
      ? round2(parseFloat(leg.tendered) || 0)
      : amount;
    return {
      ...leg,
      resolvedAmount: amount,
      resolvedTendered: tendered,
      change: round2(Math.max(0, tendered - amount)),
    };
  });
  const paidTotal = round2(view.reduce((s, l) => s + l.resolvedAmount, 0));
  const remaining = round2(total - paidTotal);
  const cashShort = view.some(l => l.method === 'cash' && l.resolvedTendered + EPSILON < l.resolvedAmount);
  const balanced = Math.abs(remaining) <= EPSILON && total > 0;
  const allPositive = view.every(l => l.resolvedAmount > 0);
  return { view, remaining, cashShort, balanced, allPositive };
}
