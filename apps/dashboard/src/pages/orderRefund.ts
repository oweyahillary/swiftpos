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

/**
 * A359 (2026-09-28): may this order be refunded from the web POS / manager dashboard order list? Owner, on v0.6.18:
 * "no refund option in orders or order history" (POS Menu → Orders and the manager dashboard's Orders both render
 * POSOrderHistoryTab, which only reprinted). A completed sale, not already refunded, by someone holding orders.void;
 * the cloud (POST /api/orders/:id/refund) decides the rest and asks a manager's own PIN (A355).
 */
export function canRefundOrder(
  order: { status?: string; payments?: { status?: string }[] | null },
  mayVoid: boolean,
): boolean {
  return mayVoid && order.status === 'completed' && !isRefunded(order.payments);
}

/** The reasons offered — the till's refund list (VoidModal), so both surfaces record the same words. */
export const REFUND_REASONS = ['Item returned', 'Wrong order given', 'Quality complaint', 'Charged twice', 'Order not delivered', 'Other'];
