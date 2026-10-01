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
// matching a till's SALE by its idempotency_key too: the cloud gives every order its own
// id and keeps the till's local id as idempotency_key (routes/orders.ts, X-Idempotency-Key)
// — matching by id alone counted every till sale twice (owner, B5, 2026-09-27: 6,210 for
// 4,720). Floats and expenses keep the till's id (routes/sync.ts upserts onConflict id).
// with the SAME arithmetic the cloud's own close uses (routes/shifts.ts POST /:id/close):
//   cash = cash payments with status 'completed' or 'refunded' (refunds are negative
//          rows) on the shift's COMPLETED orders;
//   + float_in − float_out − expenses.
// So the till's figure and the cloud's recomputation agree once everything has synced.

export interface ForeignInput {
  orders:   Array<{ id: string; status: string; idempotency_key?: string | null }>;
  payments: Array<{ order_id: string; method: string; status: string; amount: number | string }>;
  floats:   Array<{ id: string; type: string; amount: number | string }>;
  expenses: Array<{ id: string; amount: number | string }>;
}
export interface Known { order_ids?: string[]; float_ids?: string[]; expense_ids?: string[] }
export interface ForeignCash { orders: number; cash_sales: number; float_in: number; float_out: number; expenses: number }

export function foreignCash(input: ForeignInput, known: Known): ForeignCash {
  const kO = new Set(known.order_ids ?? []), kF = new Set(known.float_ids ?? []), kE = new Set(known.expense_ids ?? []);
  const theirs = new Set(input.orders
    .filter((o) => o.status === 'completed' && !kO.has(o.id) && !(o.idempotency_key && kO.has(o.idempotency_key)))
    .map((o) => o.id));
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

// ── Stage 1 of cross-sync (2026-09-27): the web's sales themselves, not just their cash ──
// Owner: "what i sell on the web using the same till should appear on the till". The till
// downloads every sale on its drawer that it did not ring, and stores it under the CLOUD id —
// so it keeps sending that id back in foreign-cash's order_ids and nothing is counted twice.
// `own_ids` is only what the till RANG (its local ids = the cloud's idempotency_key); a sale it
// already downloaded is sent again on purpose, so a void or refund made on the web reaches it.
export interface CloudOrder {
  id: string; status: string; idempotency_key?: string | null; [k: string]: unknown;
  order_items?: Array<Record<string, unknown>>; payments?: Array<{ status: string } & Record<string, unknown>>;
}

/** Sales on the drawer that the till did not ring: completed or voided (open/held tabs are not sales yet). */
export function foreignOrders(orders: CloudOrder[], ownIds: string[]): CloudOrder[] {
  const own = new Set(ownIds);
  return orders
    .filter((o) => (o.status === 'completed' || o.status === 'voided')
      && !own.has(o.id) && !(o.idempotency_key && own.has(o.idempotency_key)))
    .map((o) => ({
      ...o,
      order_items: o.order_items ?? [],
      // The close's arithmetic: completed and refunded rows only (a pending M-Pesa push is not money).
      payments: (o.payments ?? []).filter((p) => p.status === 'completed' || p.status === 'refunded'),
    }));
}

// ── A336 follow-up (0.6.26): a void or refund made on the WEB of a sale the TILL rang ──
// Known limit of A359: the till downloads only sales it did not ring, so when a manager refunded or voided one of the
// till's OWN sales on the web, the cloud was right but the till's Z-report, shift and day close still counted it. The
// till already sends its own ids; this reports which of those were reversed on the cloud, so the till can apply it.
export interface OwnReversal {
  /** The till's own id for the sale (the cloud's idempotency_key). */
  local_id: string;
  status: 'completed' | 'voided';
  voided_at: string | null; void_reason: string | null;
  refunded_at: string | null; refunded_amount: number; refund_reason: string | null;
  /** The refund's money-out rows (negative amounts), by the cloud's own row id — applied once each. */
  refund_payments: Array<{ id: string; method: string; amount: number; created_at: string | null }>;
}

/** The till's own sales (matched by idempotency_key, or by id) that the cloud has voided or refunded. */
export function ownReversals(orders: CloudOrder[], ownIds: string[]): OwnReversal[] {
  const own = new Set(ownIds);
  const out: OwnReversal[] = [];
  for (const o of orders) {
    const localId = o.idempotency_key && own.has(o.idempotency_key) ? o.idempotency_key : own.has(o.id) ? o.id : null;
    if (!localId) continue;
    const refunded = Number((o as any).refunded_amount ?? 0) || 0;
    if (o.status !== 'voided' && !(refunded > 0)) continue;
    out.push({
      local_id: localId,
      status: o.status === 'voided' ? 'voided' : 'completed',
      voided_at: ((o as any).voided_at as string) ?? null,
      void_reason: ((o as any).void_reason as string) ?? null,
      refunded_at: ((o as any).refunded_at as string) ?? null,
      refunded_amount: refunded,
      refund_reason: ((o as any).refund_reason as string) ?? null,
      refund_payments: (o.payments ?? [])
        .filter((p) => p.status === 'refunded' && Number((p as any).amount) < 0)
        .map((p) => ({ id: String((p as any).id), method: String((p as any).method), amount: Number((p as any).amount),
          created_at: ((p as any).created_at as string) ?? null })),
    });
  }
  return out;
}
