/**
 * cashierHistory.ts — 0.6.37 (A387): which payment methods a CASHIER sees in History; a cashier never reprints.
 *
 * Owner, 2026-10-03: "order history to only show manager allowed not all so the manager selects what the cashier sees"
 * — "based on payment method" — "They can only see allowed method eg mpesa, cash, card but never reprints a receipt".
 *
 *   cashier_history_methods   the methods a cashier's History shows (e.g. ["mpesa"]). Empty / unset = every method (as
 *                             before). Set by a manager (settings.manage) on the web (Settings) or on the till (Manager →
 *                             Settings); a branch may have its own (Branches › the branch › overrides).
 *
 * A sale is shown to a cashier when one of its payments is an allowed method; a split sale shows ONLY the allowed part
 * (the other legs, and the total, are not shown — the amount shown is what was paid by the allowed methods). A manager
 * and the owner see every sale, whole. Applied by the cloud (GET /api/orders — the web POS) and the till (its History).
 *
 * ONE file: shared/cashierHistory.ts, copied to the cloud, the till (main + renderer) and the web
 * (scripts/check-shared-sync.mjs).
 */

export const CASHIER_HISTORY_METHODS_KEY = 'cashier_history_methods';

/**
 * The stored or sent value → the allowed methods (lower-case codes), [] = every method. undefined = not a list of
 * method codes (refused). Accepts an array, JSON text of one, or "cash, mpesa".
 */
export function cleanHistoryMethods(raw: unknown): string[] | undefined {
  let v: unknown = raw;
  if (v === null || v === undefined) return [];
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return [];
    try { v = JSON.parse(s); } catch { v = s.split(','); }
    if (typeof v === 'string') v = v.split(',');
  }
  if (!Array.isArray(v)) return undefined;
  const out: string[] = [];
  for (const m of v) {
    const c = String(m ?? '').trim().toLowerCase();
    if (!c) continue;
    if (!/^[a-z0-9_-]{1,40}$/.test(c)) return undefined;
    if (!out.includes(c)) out.push(c);
  }
  return out.slice(0, 20);
}

/** What to store (JSON text of the list; "[]" = every method), or null when the value is not acceptable. */
export function historyMethodsSettingValue(raw: unknown): string | null {
  const m = cleanHistoryMethods(raw);
  return m === undefined ? null : JSON.stringify(m);
}

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
