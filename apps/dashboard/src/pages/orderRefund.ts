// A195 — detect a refunded order from data the owner Orders list already receives.
//
// A refund keeps the order status 'completed' on purpose (migration 37: the sale
// stayed on the books; VAT/levy were charged and remain owed) and records the
// reversal as a payment leg with status 'refunded' and a negative amount
// (apps/server/src/routes/orders.ts, POST /:id/refund). `GET /api/orders` already
// selects `payments ( method, amount, status )`, so the client can tell a refunded
// sale from a clean one with NO server change — the signal is a refunded payment leg.
//
// Refunds are full-only (the handler rejects partials), so there is deliberately no
// "partially refunded" state to detect here.
export function isRefunded(payments: { status?: string }[] | null | undefined): boolean {
  return Array.isArray(payments) && payments.some((p) => p?.status === 'refunded');
}
