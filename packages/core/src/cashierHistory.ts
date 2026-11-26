/**
 * cashierHistory.ts — A387 / A627: which payment methods a CASHIER sees in History.
 *
 * Owner, 2026-10-03: "order history to only show manager allowed not all … based on payment method". A627 (owner,
 * 2026-11-26) made this a per-person RIGHT (`sales.history_all_payments`): a cashier who holds it (or a manager) sees
 * every method; without it, only cash. The old `cashier_history_methods` business/branch/till setting is gone.
 *
 * A sale is shown to a cashier when one of its payments is an allowed method; a split sale shows ONLY the allowed part
 * (the amount shown is what was paid by the allowed methods, never the whole bill). This is the pure filter the cloud
 * (GET /api/orders) and the till apply; the allowed list is `[]` (every method) or `['cash']` by the right.
 */

export interface HistoryPayment { method?: string | null; amount?: number | string | null; [k: string]: unknown }
export interface HistoryOrderLike { payments?: HistoryPayment[] | null; total?: number | string | null; [k: string]: unknown }

const methodOf = (p: HistoryPayment) => String(p?.method ?? '').trim().toLowerCase() || 'cash';
const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * A cashier's view of the sales: only those with a payment in `allowed`, each carrying only its allowed payments. A
 * split sale that keeps some legs gets `history_partial: true` and `history_shown_total` (the allowed legs' sum) — the
 * screen shows that amount, never the whole bill. `allowed` empty → the list unchanged (every method). A sale with no
 * payment rows counts as cash (as the till's History always has).
 */
export function cashierHistoryView<T extends HistoryOrderLike>(orders: T[], allowed: string[] | null | undefined):
  Array<T & { history_partial?: boolean; history_shown_total?: number }> {
  const allow = (allowed ?? []).map((m) => m.toLowerCase());
  if (!allow.length) return orders;
  const set = new Set(allow);
  const out: Array<T & { history_partial?: boolean; history_shown_total?: number }> = [];
  for (const o of orders) {
    const all = Array.isArray(o.payments) ? o.payments : [];
    // A zero leg (e.g. a cash row of 0 beside the M-Pesa that paid) is not a way the sale was paid.
    const paid = all.filter((p) => Number(p?.amount) > 0);
    const pays = paid.length ? paid : all;
    if (!pays.length) {
      if (set.has('cash')) out.push(o);
      continue;
    }
    const kept = pays.filter((p) => set.has(methodOf(p)));
    if (!kept.length) continue;
    if (kept.length === pays.length) { out.push(o); continue; }   // every way it was paid is allowed: the whole sale
    out.push({
      ...o,
      payments: kept,
      history_partial: true,
      history_shown_total: r2(kept.reduce((s, p) => s + (Number(p.amount) || 0), 0)),
    });
  }
  return out;
}
