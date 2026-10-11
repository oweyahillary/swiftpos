/**
 * cashierShiftSales — A416 (owner, 2026-10-09: "where is the feature for waiter seeing total sales on the shift while
 * closing? can we add it to the managers/owners side which can be toggled on and off at will but by default is off?").
 *
 *   cashier_sees_shift_sales   "true" — a cashier closing a shift sees their shift's sales (the total kept after
 *                              refunds, and the number of orders). Anything else, or unset = OFF (the default).
 *
 * The business default (business_settings) or the branch's own (branch_settings) — the branch's wins, as every
 * overridable setting. The count stays blind either way: expected cash, the per-method figures and the difference are
 * never shown to a cashier (0.6.29, A365) — the manager's confirmation would lose its point.
 */
import { supabase } from './supabase';

export const CASHIER_SEES_SHIFT_SALES_KEY = 'cashier_sees_shift_sales';

/** "true" / true → on; anything else → off. */
export function cleanSeesSales(raw: unknown): boolean {
  return raw === true || String(raw ?? '').trim().toLowerCase() === 'true';
}

/**
 * A418 (owner, 2026-10-09: "allow cashiers to filter their sales and it gives them a subtotal using the current filter";
 * 2026-10-09: "one should be on for the other to be active"):
 *   cashier_history_totals     "true" — a cashier's History shows the total of what the filters show. Works only while
 *                              cashier_sees_shift_sales is on (cashierHistoryTotals checks both). Off by default.
 */
export const CASHIER_HISTORY_TOTALS_KEY = 'cashier_history_totals';

/** One switch at a branch: the branch's own value wins; else the business default; else off. */
async function branchSwitch(businessId: string, branchId: string | null | undefined, key: string): Promise<boolean> {
  if (branchId) {
    const { data: own } = await supabase.from('branch_settings').select('value')
      .eq('business_id', businessId).eq('branch_id', branchId).eq('key', key).maybeSingle();
    if (own) return cleanSeesSales((own as { value: unknown }).value);
  }
  const { data } = await supabase.from('business_settings').select('value')
    .eq('business_id', businessId).eq('key', key).maybeSingle();
  return cleanSeesSales((data as { value: unknown } | null)?.value);
}

/** Is it on at this branch? The branch's own value wins; else the business default; else off. */
export async function cashierSeesShiftSales(businessId: string, branchId: string | null | undefined): Promise<boolean> {
  return branchSwitch(businessId, branchId, CASHIER_SEES_SHIFT_SALES_KEY);
}

/** A418: may a cashier see the History total? Only while A416 is on too — "one should be on for the other". */
export async function cashierHistoryTotals(businessId: string, branchId: string | null | undefined): Promise<boolean> {
  return (await cashierSeesShiftSales(businessId, branchId)) && (await branchSwitch(businessId, branchId, CASHIER_HISTORY_TOTALS_KEY));
}

/** A418: the effective value from the two raw settings (the till and pos/init) — both must be on. */
export function historyTotalsOn(seesSales: unknown, totals: unknown): boolean {
  return cleanSeesSales(seesSales) && cleanSeesSales(totals);
}

/**
 * A418: the History total — what the filters show: the orders, and the sales of the completed ones (kept after refunds;
 * a cashier's split sale counts only its allowed part, `history_shown_total`). Voided sales count as orders, not sales.
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
