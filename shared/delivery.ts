/**
 * delivery.ts — 0.6.27: the rider and the delivery fee on a delivery order (a prospect's requests 2, 3 and 4).
 *
 * Owner, 2026-09-30: "On delivery orders add another field delivery fee, and make it mandatory the name and delivery
 * fee" · "delivery fee is usually paid by the client as an addition to the order amount. the person doing delivery is
 * paid in cash from cash sales so cash will be less than the amount in the system … assume the delivery fee is 300, cash
 * will be 300 less but mpesa will be 300 more" · "Update type field in history to include delivery persons name eg
 * Delivery - Eugene".
 *
 * Decided (owner): the fee is PASS-THROUGH — like a tip it is paid on top of the bill (in the payment legs) and is not
 * sales or VAT; the rider is paid it in CASH from the drawer, recorded automatically as a pay-out, so expected cash is
 * the fee lower while the method the customer paid with (M-Pesa) carries it. Rider + fee are required only when the
 * client has the 'delivery_fee' switch on (admin portal); without it a delivery works as before.
 *
 * ONE file: shared/delivery.ts, copied to the till, the web and the cloud (scripts/check-shared-sync.mjs).
 */

export const RIDER_MAX = 60;
export const DELIVERY_FEE_MAX = 100_000;

/** A rider's name as stored: trimmed, inner spaces squeezed, cut to RIDER_MAX. Empty → null. */
export function cleanRider(raw: unknown): string | null {
  if (raw == null) return null;
  const s = String(raw).replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, RIDER_MAX).trim() : null;
}

/** A delivery fee as stored: a number ≥ 0 with two decimals. Anything unreadable, negative or absurd → 0. */
export function cleanDeliveryFee(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(String(raw ?? '').replace(/,/g, '').trim());
  if (!Number.isFinite(n) || n <= 0 || n > DELIVERY_FEE_MAX) return 0;
  return Math.round(n * 100) / 100;
}

/**
 * Why a delivery order cannot be paid yet, or null when it can. Only with the switch on, and only for a delivery.
 * `fee` is what the cashier typed (text or number). The fee is required even on a FREE delivery (0.6.33): the rider is
 * still paid it — by the shop instead of the customer.
 */
export function deliveryProblem(featureOn: boolean, orderType: string | null | undefined, rider: unknown, fee: unknown): string | null {
  if (!featureOn || orderType !== 'delivery') return null;
  if (!cleanRider(rider)) return 'Enter the rider’s name for this delivery.';
  if (cleanDeliveryFee(fee) <= 0) return 'Enter the delivery fee for this delivery.';
  return null;
}

/**
 * 0.6.33 — FREE DELIVERY. Owner, 2026-10-02: "free delivery … the rider is still paid by the shop so delivery fee is a
 * must but the customer does not pay it". A free delivery keeps its fee (`delivery_fee` = what the rider is paid, in cash
 * from the drawer, as on every delivery) and is marked `delivery_free`; the customer's bill and payments leave the fee
 * out. Offered to the cashier only when the owner allows it (the 'delivery_free_allowed' rule, shared/reversalRules.ts).
 */

/** What the CUSTOMER pays for delivery: the fee, or 0 on a free delivery (the shop pays the rider). */
export function customerDeliveryFee(fee: unknown, free: unknown): number {
  return free === true || free === 1 || free === '1' || free === 'true' ? 0 : cleanDeliveryFee(fee);
}

/** Is this order a free delivery? Only a delivery with a fee can be one (the flag is ignored otherwise). */
export function isFreeDelivery(orderType: string | null | undefined, fee: unknown, free: unknown): boolean {
  return orderType === 'delivery' && cleanDeliveryFee(fee) > 0 && customerDeliveryFee(fee, free) === 0;
}

/**
 * 0.6.33: free delivery above an amount (the owner's 'delivery_free_over'). A delivery whose BILL (after discounts, before
 * any tip) reaches the threshold is free automatically — the shop pays the rider. null / 0 = off.
 */
export function autoFreeDelivery(billTotal: number, over: number | null | undefined): boolean {
  return over != null && over > 0 && Math.round((Number(billTotal) || 0) * 100) >= Math.round(over * 100);
}

/** 0.6.33 — one rider's deliveries in a shift: how many, the fees customers paid, the free ones the shop paid. */
export interface RiderLine { rider: string; deliveries: number; feesPaid: number; freeCount: number; freeFees: number }

/**
 * Riders summary (Z-report): one line per rider, from the shift's delivery orders (not voided), by name as typed
 * (cleaned; case-insensitive). Riders with the most deliveries first. A delivery with no rider is "No rider".
 */
export function riderSummary(orders: Array<{ delivery_person?: string | null; delivery_fee?: unknown; delivery_free?: unknown }>): RiderLine[] {
  const by = new Map<string, RiderLine>();
  for (const o of orders ?? []) {
    const name = cleanRider(o.delivery_person) ?? 'No rider';
    const key = name.toLowerCase();
    const line = by.get(key) ?? { rider: name, deliveries: 0, feesPaid: 0, freeCount: 0, freeFees: 0 };
    const fee = cleanDeliveryFee(o.delivery_fee);
    const free = fee > 0 && customerDeliveryFee(fee, o.delivery_free) === 0;
    line.deliveries += 1;
    if (free) { line.freeCount += 1; line.freeFees = Math.round((line.freeFees + fee) * 100) / 100; }
    else line.feesPaid = Math.round((line.feesPaid + fee) * 100) / 100;
    by.set(key, line);
  }
  return [...by.values()].sort((a, b) => b.deliveries - a.deliveries || a.rider.localeCompare(b.rider));
}

/** "Delivery — Eugene" for a delivery with a rider; otherwise the type in words ("Dine in", "Takeaway"). */
export function orderTypeLabel(orderType: string | null | undefined, rider?: string | null): string {
  const t = String(orderType || 'retail').replace(/_/g, ' ');
  const words = t.charAt(0).toUpperCase() + t.slice(1);
  const r = cleanRider(rider);
  return orderType === 'delivery' && r ? `${words} — ${r}` : words;
}

/** The pay-out's reason, recorded in the drawer when the rider is paid the fee in cash. */
export function riderPayoutReason(rider: string | null | undefined, orderNumber: string | null | undefined): string {
  return `Delivery fee — ${cleanRider(rider) ?? 'rider'}${orderNumber ? ` (#${orderNumber})` : ''}`;
}

/** What the customer pays in all: the bill, any tip, and the delivery fee on top (money2). */
export function amountDue(total: number, tip = 0, deliveryFee = 0): number {
  return Math.round(((Number(total) || 0) + (Number(tip) || 0) + (Number(deliveryFee) || 0)) * 100) / 100;
}
