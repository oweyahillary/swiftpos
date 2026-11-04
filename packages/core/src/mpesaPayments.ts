/**
 * mpesaPayments.ts — A621: M-Pesa payment notifications on the POS — the rules both payment screens (desktop and web)
 * share. Pure: no imports, no network. One file, in packages/core (@zaptill/core/mpesaPayments).
 *
 * Owner, 2026-11-02: "Some customers do not like giving out their number, they prefer paying to the till or paybill
 * directly; what the cashier gets is a notification of the payments done, then they match it to the bill." The cashier
 * TAPS the payment — nothing is matched by amount alone. Owner, 2026-11-03: "show payments that match the bill only" —
 * a payment for more or less than the bill is never listed (the cashier types its code by hand if it is right).
 */

/** A payment as the cloud lists it (GET /api/payments/c2b/recent). */
export interface ReceivedPayment {
  trans_id:   string;
  amount:     number;
  first_name: string | null;
  bill_ref:   string | null;
  paid_at:    string;
}

/** How often an open payment screen with an M-Pesa leg asks for new payments (the cloud answers "unchanged" cheaply). */
export const RECEIVED_POLL_MS = 5_000;

/** Shillings are compared to the cent. */
const CENT = 0.005;

/**
 * Does this payment pay `bill` exactly? M-Pesa moves whole shillings, so a bill with cents is matched by its shillings
 * rounded up — what the M-Pesa prompt asks the customer for too.
 */
export function matchesBill(paymentAmount: number, bill: number): boolean {
  return Math.abs(paymentAmount - bill) < CENT || paymentAmount === Math.ceil(bill - CENT);
}

/** The payments a cashier may tap for `bill`: only those that pay it exactly. */
export function paymentsForBill<T extends Pick<ReceivedPayment, 'amount'>>(list: T[], bill: number): T[] {
  return list.filter((p) => matchesBill(p.amount, bill));
}

function shillings(n: number): string {
  return n.toLocaleString('en-KE', { maximumFractionDigits: 2 });
}

/** "KES 1,080 received — JOHN — QJK7XT3L5P" (no name: just the amount and the code). */
export function receivedNotice(p: Pick<ReceivedPayment, 'amount' | 'first_name' | 'trans_id'>, currency = 'KES'): string {
  const parts = [`${currency} ${shillings(p.amount)} received`];
  if (p.first_name) parts.push(p.first_name);
  parts.push(p.trans_id);
  return parts.join(' — ');
}

/** "14:05" — when the customer paid, in the POS's own clock. */
export function paidAtLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** This payment screen's own reference for a claim: a payment it takes is held for this sale until it closes. */
export function newSaleRef(now = Date.now()): string {
  return `PAY-${now.toString(36).toUpperCase()}-${Math.floor(Math.random() * 1296).toString(36).toUpperCase()}`;
}

/** The cloud's refusal of a tap, in the cashier's words. */
export function claimRefusalText(code: string | undefined, fallback: string | undefined): string {
  if (code === 'TAKEN') return 'Another POS has just taken that payment.';
  if (code === 'USED') return 'That payment is already on another sale.';
  return fallback || 'The payment could not be taken — try again, or type the code.';
}
