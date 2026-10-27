/**
 * historyView.ts — 0.6.27: History narrowed and ordered by payment method or order type (a prospect's request 6:
 * "Cashiers history should only show their sales and they can order it using payment method or type").
 *
 * Which sales a person may see is decided before this (the till's historyScope, the cloud's own-sales filter); this
 * only filters and orders what they already have. Used by the till's History and the web POS's Orders.
 *
 * ONE file: shared/historyView.ts, copied to the till and the web (scripts/check-shared-sync.mjs).
 */

export type HistorySort = 'time' | 'method' | 'type' | 'cashier';

export interface HistoryOrder {
  created_at: string;
  order_type?: string | null;
  cashier_id?: string | null;     // A438: who rang the sale up (the person signed in, not the shift's owner)
  cashier_name?: string | null;
  payments?: Array<{ method?: string | null; amount?: number | string | null }> | null;
}

/** The method a sale is listed under: its first payment's ("split" when paid by more than one method). */
export function orderMethod(o: HistoryOrder): string {
  const ms = [...new Set((o.payments ?? [])
    .filter((p) => Number(p.amount ?? 0) > 0)
    .map((p) => String(p.method ?? '').trim().toLowerCase())
    .filter(Boolean))];
  if (ms.length > 1) return 'split';
  return ms[0] ?? String(o.payments?.[0]?.method ?? '—').toLowerCase();
}

export function orderTypeKey(o: HistoryOrder): string {
  return String(o.order_type || 'retail').toLowerCase();
}

/** A438: the cashier a sale is listed under — '' for a sale with no cashier recorded. */
export function orderCashierKey(o: HistoryOrder): string {
  return String(o.cashier_id ?? '');
}
export function orderCashierName(o: HistoryOrder): string {
  return (o.cashier_name ?? '').trim() || (o.cashier_id ? 'Unknown staff' : 'No cashier recorded');
}

/** The choices a filter offers — only what appears in the list. */
export function historyChoices<T extends HistoryOrder>(orders: T[]):
  { methods: string[]; types: string[]; cashiers: Array<{ id: string; name: string }> } {
  const cashiers = new Map<string, string>();
  for (const o of orders) if (!cashiers.has(orderCashierKey(o))) cashiers.set(orderCashierKey(o), orderCashierName(o));
  return {
    methods: [...new Set(orders.map(orderMethod))].sort(),
    types: [...new Set(orders.map(orderTypeKey))].sort(),
    cashiers: [...cashiers].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/**
 * Filter by method, type and cashier (each '' = all; A438 the cashier, combined with the others) and order: 'time'
 * newest first; 'method' / 'type' / 'cashier' grouped A→Z, newest first in each group. Never changes the input.
 */
export function historyView<T extends HistoryOrder>(orders: T[], opts: { method?: string; type?: string; cashier?: string; sort?: HistorySort }): T[] {
  const method = (opts.method ?? '').toLowerCase();
  const type = (opts.type ?? '').toLowerCase();
  const cashier = opts.cashier ?? '';
  const sort = opts.sort ?? 'time';
  const newest = (a: T, b: T) => String(b.created_at).localeCompare(String(a.created_at));
  const list = orders.filter((o) => (!method || orderMethod(o) === method) && (!type || orderTypeKey(o) === type)
    && (!cashier || orderCashierKey(o) === cashier));
  if (sort === 'method') return list.sort((a, b) => orderMethod(a).localeCompare(orderMethod(b)) || newest(a, b));
  if (sort === 'type') return list.sort((a, b) => orderTypeKey(a).localeCompare(orderTypeKey(b)) || newest(a, b));
  if (sort === 'cashier') return list.sort((a, b) => orderCashierName(a).localeCompare(orderCashierName(b)) || newest(a, b));
  return list.sort(newest);
}

/**
 * A418 (owner, 2026-10-09: "allow cashiers to filter their sales and it gives them a subtotal using the current filter …
 * even when they sort history"): the total of what the filters show — every order shown, and the sales of the completed
 * ones (kept after refunds; a cashier's split sale counts only its allowed part). Sorting never changes it. The cloud's
 * copy of the rule is server/src/lib/cashierShiftSales.ts historyTotal.
 */
export function historyTotal(orders: Array<{ status?: string | null; total?: number | string | null; refunded_amount?: number | string | null;
  history_partial?: boolean; history_shown_total?: number | string | null }>): { orders: number; sales: number } {
  let sales = 0;
  for (const o of orders) {
    if (o.status && o.status !== 'completed') continue;
    if (o.history_partial) { sales += Number(o.history_shown_total) || 0; continue; }
    const total = Number(o.total) || 0;
    sales += total - Math.min(Math.max(Number(o.refunded_amount) || 0, 0), Math.max(total, 0));
  }
  return { orders: orders.length, sales: Math.round(sales * 100) / 100 };
}

/**
 * A438 (owner, 2026-10-10: "cashier A opened a shift and sold; when cashier B logs into the till B continues selling on
 * A's shift, but the manager can't tell who sold what … the manager can add a filter by cashier and they get their
 * reports individually, with the payment method filter or as a separate filter"): each cashier's sales in what the
 * filters show — orders, sales (as historyTotal: completed ones, after refunds) and the money by payment method (a
 * split sale counts each part under its own method, refunds taken off pro rata). Biggest seller first.
 */
export function historyByCashier(orders: Array<HistoryOrder & { status?: string | null; total?: number | string | null;
  refunded_amount?: number | string | null }>): Array<{ id: string; name: string; orders: number; sales: number;
  methods: Array<{ method: string; amount: number }> }> {
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const by = new Map<string, { id: string; name: string; orders: number; sales: number; methods: Map<string, number> }>();
  for (const o of orders) {
    const id = orderCashierKey(o);
    const row = by.get(id) ?? { id, name: orderCashierName(o), orders: 0, sales: 0, methods: new Map<string, number>() };
    by.set(id, row);
    row.orders++;
    if (o.status && o.status !== 'completed') continue;
    const total = Number(o.total) || 0;
    const kept = total - Math.min(Math.max(Number(o.refunded_amount) || 0, 0), Math.max(total, 0));
    row.sales += kept;
    const parts = (o.payments ?? []).filter((p) => Number(p.amount ?? 0) > 0);
    const paid = parts.reduce((t, p) => t + Number(p.amount), 0);
    if (!parts.length || paid <= 0) {
      const m = orderMethod(o);
      row.methods.set(m, (row.methods.get(m) ?? 0) + kept);
      continue;
    }
    for (const p of parts) {
      const m = String(p.method ?? '').trim().toLowerCase() || '—';
      row.methods.set(m, (row.methods.get(m) ?? 0) + kept * (Number(p.amount) / paid));
    }
  }
  return [...by.values()]
    .map((r) => ({ id: r.id, name: r.name, orders: r.orders, sales: r2(r.sales),
      methods: [...r.methods].map(([method, amount]) => ({ method, amount: r2(amount) }))
        .filter((m) => m.amount !== 0).sort((a, b) => b.amount - a.amount) }))
    .sort((a, b) => b.sales - a.sales || a.name.localeCompare(b.name));
}
