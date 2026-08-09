/**
 * orderTax — one correct way to turn a set of orders into reportable figures.
 *
 * TWO BUGS this module exists to end, both of the same species: a report should
 * state what HAPPENED, read from the columns the sale wrote, not recompute the
 * numbers from a formula that drifts from the till.
 *
 * ── BUG 1: REFUNDS COUNTED AT FULL VALUE ─────────────────────────────────────
 * A refund deliberately leaves status = 'completed' and records refunded_amount
 * (the baseline schema comment says so: "The order stays completed — the sale
 * happened"). Every reducer in reports.ts filters on status = 'completed' and
 * reads `total`, so a fully refunded 1,000 order still counts as 1,000 of sales
 * and its VAT still counts as output tax. Only reports-daily read the refund
 * columns. The tax report is the one that matters: it overstated output VAT by
 * the refunded amount, in the direction a revenue authority notices.
 *
 * The fix is not to hide refunded orders — the gross sale is real and belongs in
 * gross. It is to subtract what was returned. netTotal = total - refunded_amount,
 * and VAT/CTL are reduced in the same proportion, because a partial refund
 * returns a slice of the whole inclusive price, tax included.
 *
 * ── BUG 2: THE LEVY DERIVED INSTEAD OF READ ──────────────────────────────────
 * The tax report computed ctl = (total - vat_amount) * ctlRate. But at sale time
 * (payment.ts) VAT and CTL are BOTH charged on the same net:
 *     net = total / (1 + (vat+ctl)/100);  vat = net*vatRate;  ctl = net*ctlRate
 * so total - vat = net*(1 + ctlRate), and multiplying THAT by ctlRate overstates
 * the levy by net*ctlRate². orders.ctl_amount already holds the figure the sale
 * charged and eTIMS transmitted. Read it.
 *
 * Everything here works in integer-safe number space but never adds a string to
 * a number — Number() guards every column, because PostgREST returns numeric as
 * a string (the same species as the stock-corruption bug).
 */

export interface OrderTaxRow {
  total: string | number;
  vat_amount?: string | number | null;
  ctl_amount?: string | number | null;
  refunded_amount?: string | number | null;
  refunded_at?: string | null;
}

const n = (v: unknown): number => Number(v ?? 0) || 0;

/**
 * The fraction of an order that was NOT refunded. 1 for an untouched order, 0
 * for a full refund, in between for a partial. Guards against a refund larger
 * than the total (bad data) producing a negative weight.
 */
export function keptFraction(o: OrderTaxRow): number {
  const total = n(o.total);
  if (total <= 0) return 0;
  const refunded = Math.min(Math.max(n(o.refunded_amount), 0), total);
  return (total - refunded) / total;
}

export interface OrderTaxFigures {
  /** total, before any refund. The sale happened; it belongs in gross. */
  gross: number;
  /** what was handed back. */
  refunded: number;
  /** gross - refunded. The revenue actually retained. */
  net: number;
  /** vat_amount reduced by the refunded fraction. */
  vat: number;
  /** ctl_amount (READ, not derived) reduced by the refunded fraction. */
  ctl: number;
  /** net-of-tax sales: net - vat - ctl. */
  netOfTax: number;
  wasRefunded: boolean;
}

/** One order → its refund-adjusted, stored-value figures. */
export function orderTax(o: OrderTaxRow): OrderTaxFigures {
  const gross = n(o.total);
  const refunded = Math.min(Math.max(n(o.refunded_amount), 0), gross);
  const keep = keptFraction(o);
  const vat = n(o.vat_amount) * keep;
  const ctl = n(o.ctl_amount) * keep;
  const net = gross - refunded;
  return {
    gross,
    refunded,
    net,
    vat,
    ctl,
    netOfTax: net - vat - ctl,
    wasRefunded: !!o.refunded_at || refunded > 0,
  };
}

/** A set of orders → summed figures. The one place reports should get totals. */
export function sumOrderTax(orders: OrderTaxRow[]): OrderTaxFigures & { count: number; refundedCount: number } {
  const acc = { gross: 0, refunded: 0, net: 0, vat: 0, ctl: 0, netOfTax: 0, count: 0, refundedCount: 0, wasRefunded: false };
  for (const o of orders) {
    const f = orderTax(o);
    acc.gross += f.gross;
    acc.refunded += f.refunded;
    acc.net += f.net;
    acc.vat += f.vat;
    acc.ctl += f.ctl;
    acc.netOfTax += f.netOfTax;
    acc.count += 1;
    if (f.wasRefunded) acc.refundedCount += 1;
  }
  return acc;
}
