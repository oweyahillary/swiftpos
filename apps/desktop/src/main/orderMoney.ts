/**
 * orderMoney.ts — A349 (2026-09-28): the till's ONE rule for turning stored orders into reportable money, the local
 * mirror of the cloud's lib/orderTax.ts (so the till's Overview, Z-report, Daily Sales Report and CSV agree with the
 * dashboard to the cent).
 *
 * Owner, before 0.6.16: "make sure everything especially money math and reporting they have to be spot on".
 *
 * A refund leaves the order 'completed' and records refunded_amount; `total` is never reduced. Reports therefore:
 *   gross     = total                      (the sale happened)
 *   refunded  = refunded_amount, clamped to [0, total]
 *   net       = gross − refunded           (revenue actually kept)
 *   VAT / CTL = the STORED vat_amount / ctl_amount × kept fraction   (a partial refund returns a slice of the
 *               tax-inclusive price, tax included — never re-derived from a rate)
 * Before this, the till's reports read vat/ctl at full value after a refund: a fully refunded bill still counted its
 * whole VAT and CTL, so "net sales" (gross − refunds − VAT − CTL) went negative.
 */

/** SQL: the fraction of an order NOT refunded — 1 untouched, 0 fully refunded; 0 for a zero/negative total. */
export function keptSql(alias = ''): string {
  const a = alias ? `${alias}.` : '';
  return `(CASE WHEN ${a}total > 0 THEN (${a}total - MIN(MAX(COALESCE(${a}refunded_amount, 0), 0), ${a}total)) * 1.0 / ${a}total ELSE 0 END)`;
}

/** SQL: the refunded amount, clamped to [0, total] (bad data never makes a negative refund or one above the bill). */
export function refundedSql(alias = ''): string {
  const a = alias ? `${alias}.` : '';
  return `MIN(MAX(COALESCE(${a}refunded_amount, 0), 0), MAX(${a}total, 0))`;
}

/** SQL: VAT kept (stored vat_amount × kept fraction). */
export function vatKeptSql(alias = ''): string {
  const a = alias ? `${alias}.` : '';
  return `(COALESCE(${a}vat_amount, 0) * ${keptSql(alias)})`;
}

/** SQL: CTL kept (stored ctl_amount × kept fraction). */
export function ctlKeptSql(alias = ''): string {
  const a = alias ? `${alias}.` : '';
  return `(COALESCE(${a}ctl_amount, 0) * ${keptSql(alias)})`;
}

/** Money for display and totals: 2 dp, no float noise (635.5899999 → 635.59). */
export const money2 = (n: number): number => Math.round((Number(n) || 0) * 100) / 100;
