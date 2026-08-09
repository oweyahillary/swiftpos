// Pure payment maths — no React, no Electron. Kept separate so the dryrun
// harness can exercise the exact code the till runs (see dryrun/payment-logic).
//
// Conventions: KES with cent precision; comparisons use a 1-cent epsilon so
// floating-point dust never blocks a sale.

export const EPSILON = 0.01;
export const round2 = (n: number) => Math.round(n * 100) / 100;

// Discount ceiling — MUST match capDiscount() in apps/server/src/routes/orders.ts.
//
// The server silently caps every manual discount at this percentage of subtotal
// and stores the capped figure. The till previously clamped only to 0–100%, so a
// cashier entering 25% took 25% off at the drawer and printed a receipt saying
// so, while the order landed in the database discounted by 10. The paper and the
// books then disagreed by the difference: the payment legs no longer summed to
// the order total (finding H1), and expected cash came back high, reporting a
// shortage that never happened — the same class of phantom variance A14 removed.
//
// The real rate arrives from the server on each catalogue pull. This constant is
// only the fallback for a till that has not synced yet, and is deliberately the
// server's own default so an unsynced till can never over-discount.
export const DEFAULT_MAX_DISCOUNT_PCT = 10;

// glovo settles to the business later and never touches the drawer, so it is a
// payment method rather than an order type. Cash reconciliation filters on
// method = 'cash' specifically, so adding one here cannot inflate expected cash.
export type LegMethod = 'cash' | 'mpesa' | 'card' | 'glovo';

export interface DraftLeg {
  method: LegMethod;
  amount: string;     // raw input; '' means "the remaining balance"
  tendered: string;   // cash only
  reference: string;  // mpesa/card/glovo — the aggregator's order reference
}

// VAT-inclusive pricing: VAT is extracted from the post-discount goods total.
// Tips are not VATable.
export function computeTotals(subtotal: number, opts: {
  discountRaw: number;
  discountMode: 'amount' | 'percent';
  tipRaw: number;
  vatRate: number;
  ctlRate?: number;        // Catering/Tourism Levy %. Omitted or 0 = not applicable.
  maxDiscountPct?: number; // Ceiling from the server; falls back to the shared default.
}) {
  const { discountRaw, discountMode, tipRaw, vatRate, ctlRate = 0,
          maxDiscountPct = DEFAULT_MAX_DISCOUNT_PCT } = opts;

  // Clamp to the SAME ceiling the server applies, so the receipt, the drawer and
  // the stored order can never describe three different discounts.
  const ceiling = round2(subtotal * (Math.max(0, maxDiscountPct) / 100));
  const asked = round2(
    discountMode === 'percent'
      ? subtotal * Math.min(Math.max(discountRaw, 0), 100) / 100
      : Math.min(Math.max(discountRaw, 0), subtotal)
  );
  const discountAmount = round2(Math.min(asked, ceiling, subtotal));
  // True when the cashier asked for more than policy allows. The modal surfaces
  // this rather than quietly charging a different number than was typed.
  const discountCapped = asked > discountAmount + EPSILON;
  const tipAmount = round2(Math.max(tipRaw, 0));
  const discountedSubtotal = round2(subtotal - discountAmount);
  // Prices are inclusive of BOTH taxes, so back the net out with the combined
  // rate and charge each on that net — VAT on the net, not on net-plus-CTL.
  // Mirrors recomputeOrderTotals on the server, which is authoritative; if these
  // ever diverge the customer's receipt would contradict the books.
  //   750 / 1.18 = 635.59 net → ctl 12.71, vat 101.69
  // ctlRate 0 collapses this to the previous VAT-only arithmetic exactly.
  const net = discountedSubtotal / (1 + (vatRate + ctlRate) / 100);
  const vatAmount = round2(net * (vatRate / 100));
  const ctlAmount = round2(net * (ctlRate / 100));
  // TWO DIFFERENT NUMBERS, AND THEY MUST NOT BE CONFLATED.
  //
  //   total     — the BILL. subtotal - discount. What the business recognises
  //               as the sale, what the VAT split is taken from, and what goes
  //               in orders.total. A tip is NOT part of it.
  //   amountDue — what the customer actually hands over: bill + tip. Payment
  //               legs sum to THIS.
  //
  // `total` used to include the tip. Three things went wrong at once:
  // locally subtotal - discount no longer equalled total so the till's own
  // books did not foot; the Z-report counted tips as sales revenue; and the
  // server (which computes total WITHOUT the tip) rejected the sync push, so a
  // paid and printed sale was retried five times and then parked as 'failed'.
  const total     = discountedSubtotal;
  const amountDue = round2(discountedSubtotal + tipAmount);
  return { discountAmount, tipAmount, vatAmount, ctlAmount, total, amountDue, discountCapped, maxDiscountPct };
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
