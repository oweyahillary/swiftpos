// peerRelay.ts — A19 (register A162), node-side forward of peer sales to cloud.
//
// THE PROBLEM THIS SOLVES. A peer with no internet reaches the branch NODE over
// the LAN, so branch reports are right — but its own cloud `sync_queue` never
// drains and nothing else drains it, so the CLOUD (web dashboard, eTIMS, cloud
// loyalty, backup) never sees those sales (register A19). The node must forward
// them.
//
// WHY WE RELAY THE PEER'S OWN PAYLOAD, NOT A RECONSTRUCTED ONE. The cloud's
// /api/orders ALWAYS re-prices an order from its `items` against the current
// catalogue and stores THAT as the authoritative total (orders.ts, "Finding
// #19") — it does not trust a client total. Re-pricing needs each line's variant
// and modifier selections. But the node's replicated order lines carry no
// variants or modifiers (ORDER_ITEM_COLUMNS in nodeIngest.ts) — those tables do
// not cross the LAN. So a payload rebuilt from the node's own tables would be
// re-priced WITHOUT the paid modifiers and stored SHORT by every modifier charge,
// silently, on every affected order. The only faithful forward is the peer's
// original cloud payload, carried verbatim on the order row as `_relayPayload`.
//
// This module is PURE (no DB, no Electron) so the guards below are unit-testable.
// It only DECIDES what to relay; the enqueue itself lives in nodeIngest.

/** The cloud /api/orders payload the peer built for its own sync_queue. */
export interface RelayDecisionOk {
  ok: true;
  orderId: string;
  /** The payload to hand the node's sync_queue, verbatim but for a guaranteed
   *  idempotency_key === orderId. */
  payload: Record<string, any>;
}
export interface RelayDecisionSkip {
  ok: false;
  /** Why this order will NOT be forwarded. The order still lands on the node for
   *  branch reports; it just isn't relayed — the pre-A19 status quo, safe. */
  reason: string;
}
export type RelayDecision = RelayDecisionOk | RelayDecisionSkip;

const nonEmptyArray = (v: any): v is any[] => Array.isArray(v) && v.length > 0;

/** Context the cloud payload needs beyond the order body itself. */
export interface CloudOrderCtx {
  shiftId: string | null;
  deviceId: string | null;
  orderId: string;
  createdAt: string;
  /** A169 — the cashier who rang the sale (the signed-in staff's users.id, or
   *  the owner when no cashier is signed in). Carried so the cloud can credit
   *  the real cashier on an offline sale instead of the owner-token subject.
   *  MUST be the same value on the peer's direct push and the node's relay. */
  cashierId: string | null;
}

/**
 * Build the cloud /api/orders payload from a raw order payload + its context.
 *
 * SINGLE SOURCE OF TRUTH, and that matters for money. Two devices push the same
 * order to the cloud during the A19 rollout — the peer directly (its own
 * sync_queue) and the branch node (this relay) — and the cloud dedupes on
 * idempotency_key by returning the EXISTING row without updating it. So whichever
 * arrives first wins, and if the two payloads differed the cloud would keep an
 * arbitrary one. They must be byte-for-byte the same shape, so both the peer's
 * createLocalOrder and the node's forward build the payload HERE.
 *
 * `kot_sent` is a renderer-to-main hint with no cloud column (dropped). Payment
 * legs are marked 'completed' — the till is a manual-tender POS, every leg is
 * already confirmed, and leaving M-Pesa 'pending' makes the cloud await an STK
 * callback that never comes and report it "unaccounted" (A93).
 */
export function buildCloudOrderPayload(orderPayload: any, ctx: CloudOrderCtx): Record<string, any> {
  const src = orderPayload ?? {};
  const { kot_sent: _kotSent, ...rest } = src;
  const legs = nonEmptyArray(src.payments)
    ? src.payments
    : (src.payment && typeof src.payment === 'object') ? [src.payment] : [];
  return {
    ...rest,
    payments: (legs as any[]).map(l => ({ ...l, status: 'completed' })),
    shift_id: ctx.shiftId ?? null,
    device_id: ctx.deviceId ?? null,
    // A169 — the real cashier. The server trusts this over the owner-token
    // subject only when it validates against the branch roster (see cashier.ts).
    cashier_id: ctx.cashierId ?? null,
    _localOrderId: ctx.orderId,
    idempotency_key: ctx.orderId,
    created_at: ctx.createdAt,
  };
}

/**
 * Decide whether a freshly-applied peer ORDER row can be faithfully forwarded to
 * the cloud, and produce the payload to enqueue if so.
 *
 * Refuses (ok:false) rather than forwarding anything the cloud would reject
 * forever (a payload with no items / no payments 400s on every retry and parks
 * the sale) or anything that could dedupe against the WRONG cloud order (a
 * payload whose idempotency_key or device_id disagrees with the row it rode in
 * on has been re-stamped in transit and can no longer be attributed honestly —
 * the same integrity rule applyPeerRows enforces on the row's device_id).
 *
 * An OLD peer that sends no `_relayPayload` is refused here (not reconstructed) —
 * lossy reconstruction is exactly what this module exists to avoid. Such a peer
 * is the one D3 auto-update must reach; until then its sales reach the branch but
 * not the cloud, which is precisely today's behaviour, not a regression.
 */
export function buildPeerRelay(orderRow: any): RelayDecision {
  const orderId = orderRow?.id != null ? String(orderRow.id) : '';
  if (!orderId) return { ok: false, reason: 'order row has no id' };

  const p = orderRow?._relayPayload;
  if (!p || typeof p !== 'object' || Array.isArray(p)) {
    return { ok: false, reason: 'peer sent no _relayPayload (build older than A19) — not reconstructed, to avoid a lossy total' };
  }

  // Cloud-required fields (orders.ts rejects the POST with 400 otherwise).
  if (!p.branch_id) return { ok: false, reason: 'relay payload missing branch_id' };
  if (!p.order_number) return { ok: false, reason: 'relay payload missing order_number' };
  if (!nonEmptyArray(p.items)) {
    return { ok: false, reason: 'relay payload has no items — would 400 on the cloud forever' };
  }
  const hasLegs = nonEmptyArray(p.payments) || (p.payment && typeof p.payment === 'object');
  if (!hasLegs) {
    return { ok: false, reason: 'relay payload has no payments — would 400 on the cloud forever' };
  }

  // Attribution integrity. The idempotency key IS the identity of the cloud order
  // this becomes; if the payload names a different order than the row it rode in
  // on, forwarding it could collapse two different sales onto one cloud row.
  if (p.idempotency_key != null && String(p.idempotency_key) !== orderId) {
    return { ok: false, reason: `relay payload idempotency_key ${p.idempotency_key} does not match order id ${orderId}` };
  }
  // Same rule applyPeerRows applies to the row itself: the peer's device must own
  // the payload. A mismatch means it was re-stamped in transit.
  const rowDevice = orderRow?.device_id != null ? String(orderRow.device_id) : null;
  if (rowDevice && p.device_id != null && String(p.device_id) !== rowDevice) {
    return { ok: false, reason: `relay payload device_id ${p.device_id} does not match order device ${rowDevice}` };
  }

  // Faithful passthrough — the only change is to GUARANTEE the idempotency key is
  // the order id, so the node's push (X-Idempotency-Key = sync_queue.order_id)
  // and the payload body agree and the cloud dedupes a mixed peer/node window.
  const payload: Record<string, any> = { ...p, idempotency_key: orderId };
  return { ok: true, orderId, payload };
}
