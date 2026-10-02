/**
 * voidRefund.ts — A355 (2026-09-28): the till's rules for reversing a sale from History.
 *
 * Owner, on v0.6.17 (M4): "i cant find where a manager refunds". The History list labelled the only way in "Void" and
 * REMOVED it 30 minutes after the sale (`ageMin <= 30`), so a sale older than that could not be refunded from the till
 * at all — although the window behind it was built to open straight in refund mode for exactly those sales. And every
 * signed-in person saw the button (`canVoid = true`), cashiers included, to be refused by the cloud afterwards.
 *
 * Now: a completed, not-yet-refunded sale gets "Void / Refund" inside the 30-minute void window and "Refund" after it;
 * only people whose permissions allow voids and refunds (`orders.void`, or '*') see it — the owner's rule (A336):
 * voids and refunds by owner / manager, cashiers neither. Web POS sales on this till's drawer (origin 'web') are treated
 * the same (A336 stage 2): their local id IS the cloud id, which the cloud's void/refund resolve directly.
 *
 * Pure, so the test runs these exact rules.
 */

/** The default void window. 0.6.30: the owner sets the real one (shared/reversalRules.ts; `pos.reversalRules()`). */
export const VOID_WINDOW_MIN = 30;

export interface HistoryOrder {
  status?: string | null;
  created_at: string;
  total?: number | string | null;
  refunded_amount?: number | string | null;
}

/** Minutes since the sale, whole minutes, never negative (a clock a little ahead must not look like the future). */
export function ageMinutes(order: Pick<HistoryOrder, 'created_at'>, nowMs: number = Date.now()): number {
  const t = new Date(order.created_at).getTime();
  return Number.isFinite(t) ? Math.max(0, Math.floor((nowMs - t) / 60000)) : 0;
}

/** Already refunded — the cloud refuses a second refund of the same sale. */
export function isRefunded(order: HistoryOrder): boolean {
  return Number(order.refunded_amount ?? 0) > 0;
}

/** The History button for a sale: null = none (not completed, or already refunded). */
export function reverseAction(order: HistoryOrder, nowMs: number = Date.now(), windowMin: number = VOID_WINDOW_MIN):
  { label: 'Void / Refund' | 'Refund'; mode: 'void' | 'refund' } | null {
  if (order.status !== 'completed' || isRefunded(order)) return null;
  return ageMinutes(order, nowMs) <= windowMin
    ? { label: 'Void / Refund', mode: 'void' }
    : { label: 'Refund', mode: 'refund' };
}

/** May this signed-in person void or refund? Owner '*' or the `orders.void` permission (managers by default). */
export function mayVoidRefund(staff: { permissions?: Record<string, unknown> | null } | null | undefined): boolean {
  const p = (staff?.permissions ?? {}) as Record<string, unknown>;
  return p['*'] === true || p['orders.void'] === true;
}

/**
 * What the void/refund window says when the cloud refuses. The cloud's own words are shown (they name the problem —
 * a wrong PIN, a missing permission, an already-refunded sale); before, anything mentioning "PIN" or "supervisor" was
 * replaced by "Invalid supervisor PIN", which hid "No override PIN configured" and the permission message alike.
 * Returns the message and whether the PIN box should be cleared.
 */
export function reverseErrorMessage(raw: string | null | undefined, fallback: string): { message: string; clearPin: boolean } {
  const msg = String(raw ?? '').trim() || fallback;
  const clearPin = /INVALID_APPROVER_PIN|PIN was not recognised|invalid .*pin|pin .*invalid/i.test(msg);
  return { message: msg, clearPin };
}

/** 0.6.30: the refusal says the void window has closed (the cloud's or the till's offline words) — switch to refund. */
export function isWindowClosed(raw: string | null | undefined): boolean {
  return /VOID_WINDOW|voided within|void window/i.test(String(raw ?? ''));
}
