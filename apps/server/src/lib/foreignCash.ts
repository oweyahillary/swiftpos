// foreignCash.ts — the cash a till's drawer took that the TILL cannot see (A334, 2026-09-26).
//
// Pure (no Supabase import) so the rule runs in a test.
//
// A drawer can be shared across surfaces: the web POS joins a till's open drawer
// (A273 follow-up), and a till joins a drawer the web opened (A334). Sales rung on
// the web live only in the cloud, so the till's own close — computed from its local
// orders, floats and expenses (the till is the cash authority) — would leave them out
// and report a false surplus. Owner decision 2026-09-26: the close INCLUDES them.
//
// The till sends the ids it already holds; this sums everything else on the shift,
// with the SAME arithmetic the cloud's own close uses (routes/shifts.ts POST /:id/close):
//   cash = cash payments with status 'completed' or 'refunded' (refunds are negative
//          rows) on the shift's COMPLETED orders;
//   + float_in − float_out − expenses.
// So the till's figure and the cloud's recomputation agree once everything has synced.

export interface ForeignInput {
  orders:   Array<{ id: string; status: string }>;
  payments: Array<{ order_id: string; method: string; status: string; amount: number | string }>;
  floats:   Array<{ id: string; type: string; amount: number | string }>;
  expenses: Array<{ id: string; amount: number | string }>;
}
export interface Known { order_ids?: string[]; float_ids?: string[]; expense_ids?: string[] }
export interface ForeignCash { orders: number; cash_sales: number; float_in: number; float_out: number; expenses: number }

export function foreignCash(input: ForeignInput, known: Known): ForeignCash {
  const kO = new Set(known.order_ids ?? []), kF = new Set(known.float_ids ?? []), kE = new Set(known.expense_ids ?? []);
  const theirs = new Set(input.orders.filter((o) => o.status === 'completed' && !kO.has(o.id)).map((o) => o.id));
  const cash = input.payments
    .filter((p) => theirs.has(p.order_id) && p.method === 'cash' && (p.status === 'completed' || p.status === 'refunded'))
    .reduce((s, p) => s + Number(p.amount), 0);
  const fl = input.floats.filter((f) => !kF.has(f.id));
  const sum = (xs: Array<{ amount: number | string }>) => xs.reduce((s, x) => s + Number(x.amount), 0);
  return {
    orders:     theirs.size,
    cash_sales: cash,
    float_in:   sum(fl.filter((f) => f.type === 'float_in')),
    float_out:  sum(fl.filter((f) => f.type === 'float_out')),
    expenses:   sum(input.expenses.filter((e) => !kE.has(e.id))),
  };
}

/** The same cash, as the change it makes to expected cash. */
export function foreignExpected(f: ForeignCash): number {
  return f.cash_sales + f.float_in - f.float_out - f.expenses;
}
