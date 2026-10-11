/**
 * staffMethods.ts — A439 (owner, 2026-10-10: "on the web under this report [Reports › Staff Performance] can we add a
 * small feature which shows view payment method and list each payment method").
 *
 * A sale's kept money (after refunds — orderTax's net) shared out over the payment methods it was paid with, in
 * proportion to what each method took; a sale with no completed payment goes under 'unpaid'. Cash over-tendered (change
 * given) does not inflate cash: the shares are of what was paid, scaled to the kept total. Summed per cashier by the
 * staff route, so each cashier's methods add up to their revenue.
 */
export interface PaymentRow { method?: string | null; amount?: number | string | null; status?: string | null }

export function splitByMethod(kept: number, payments: PaymentRow[] | null | undefined): Record<string, number> {
  const parts = (payments ?? []).filter((p) => (p.status ?? 'completed') === 'completed' && Number(p.amount) > 0);
  const paid = parts.reduce((t, p) => t + Number(p.amount), 0);
  if (!parts.length || paid <= 0) return kept ? { unpaid: kept } : {};
  const out: Record<string, number> = {};
  for (const p of parts) {
    const m = String(p.method ?? '').trim().toLowerCase() || 'other';
    out[m] = (out[m] ?? 0) + kept * (Number(p.amount) / paid);
  }
  return out;
}

/** Adds one sale's split into a cashier's running totals. */
export function addMethods(into: Record<string, number>, add: Record<string, number>): void {
  for (const [m, v] of Object.entries(add)) into[m] = (into[m] ?? 0) + v;
}

/** The list the report sends: rounded to the cent, biggest first, zeros dropped. */
export function methodList(m: Record<string, number>): Array<{ method: string; amount: number }> {
  return Object.entries(m).map(([method, v]) => ({ method, amount: Math.round(v * 100) / 100 }))
    .filter((x) => x.amount !== 0).sort((a, b) => b.amount - a.amount);
}
