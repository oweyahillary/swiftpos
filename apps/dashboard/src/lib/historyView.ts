/**
 * historyView.ts — 0.6.27: History narrowed and ordered by payment method or order type (a prospect's request 6:
 * "Cashiers history should only show their sales and they can order it using payment method or type").
 *
 * Which sales a person may see is decided before this (the till's historyScope, the cloud's own-sales filter); this
 * only filters and orders what they already have. Used by the till's History and the web POS's Orders.
 *
 * ONE file: shared/historyView.ts, copied to the till and the web (scripts/check-shared-sync.mjs).
 */

export type HistorySort = 'time' | 'method' | 'type';

export interface HistoryOrder {
  created_at: string;
  order_type?: string | null;
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

/** The choices a filter offers — only what appears in the list. */
export function historyChoices<T extends HistoryOrder>(orders: T[]): { methods: string[]; types: string[] } {
  return {
    methods: [...new Set(orders.map(orderMethod))].sort(),
    types: [...new Set(orders.map(orderTypeKey))].sort(),
  };
}

/**
 * Filter by method and type ('' = all) and order: 'time' newest first; 'method' / 'type' grouped A→Z, newest first in
 * each group. Never changes the input.
 */
export function historyView<T extends HistoryOrder>(orders: T[], opts: { method?: string; type?: string; sort?: HistorySort }): T[] {
  const method = (opts.method ?? '').toLowerCase();
  const type = (opts.type ?? '').toLowerCase();
  const sort = opts.sort ?? 'time';
  const newest = (a: T, b: T) => String(b.created_at).localeCompare(String(a.created_at));
  const list = orders.filter((o) => (!method || orderMethod(o) === method) && (!type || orderTypeKey(o) === type));
  if (sort === 'method') return list.sort((a, b) => orderMethod(a).localeCompare(orderMethod(b)) || newest(a, b));
  if (sort === 'type') return list.sort((a, b) => orderTypeKey(a).localeCompare(orderTypeKey(b)) || newest(a, b));
  return list.sort(newest);
}
