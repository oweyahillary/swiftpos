/**
 * cashierShiftSales — the History running-total calc for a cashier.
 *
 * A416/A418 made "a cashier sees their shift's sales / a running total in History" business switches; A627 (owner,
 * 2026-11-26) turned them into per-person RIGHTS (`shifts.see_shift_sales`, `sales.history_total`) and the switches are
 * gone. What remains here is the pure total the History shows when a cashier holds `sales.history_total`.
 */

/**
 * The History total — what the filters show: the orders, and the sales of the completed ones (kept after refunds; a
 * cashier's split sale counts only its allowed part, `history_shown_total`). Voided sales count as orders, not sales.
 * The till's own copy is shared/historyView.ts historyTotal — the same rule.
 */
export function historyTotal(rows: Array<{ status?: string | null; total?: unknown; refunded_amount?: unknown;
  history_partial?: boolean; history_shown_total?: unknown }>): { orders: number; sales: number } {
  let sales = 0;
  for (const o of rows) {
    if (o.status && o.status !== 'completed') continue;
    if (o.history_partial) { sales += Number(o.history_shown_total) || 0; continue; }
    const total = Number(o.total) || 0;
    sales += total - Math.min(Math.max(Number(o.refunded_amount) || 0, 0), Math.max(total, 0));
  }
  return { orders: rows.length, sales: Math.round(sales * 100) / 100 };
}
