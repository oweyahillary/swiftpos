// resolveOrder.ts — A335 (2026-09-27): find a sale by the id the CALLER knows it by.
//
// The cloud gives every order its own id and keeps the till's local id as idempotency_key
// (routes/orders.ts, X-Idempotency-Key). The till voids and refunds by its local id, so a
// lookup by `id` alone never found a till's own sale ("Order not found"). The web knows the
// cloud id; the till knows its own — both resolve here, always inside the caller's business.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Minimal query surface, so the rule runs in a test without Supabase. */
export type OrderLookup = (column: 'id' | 'idempotency_key', value: string) => Promise<string | null>;

/** The cloud id for `ref`: its own id first, else the order whose idempotency_key it is; `ref` if neither. */
export async function resolveOrderId(ref: string, lookup: OrderLookup): Promise<string> {
  // A non-uuid would make Postgres reject the id comparison outright — go straight to the key.
  if (UUID.test(ref)) {
    const byId = await lookup('id', ref);
    if (byId) return byId;
  }
  return (await lookup('idempotency_key', ref)) ?? ref;
}
