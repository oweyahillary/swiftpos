/**
 * branchStock.ts — A564: the rules of the Other branches page — the till and the web (pure, so the tests run them).
 *
 * Owner, 2026-10-22: a request carries the quantity the requester TYPES — a form may open with it blank (A565's analytics
 * links), so a blank one is never sent; the sending manager may change the quantity when accepting (fewer or more than
 * asked) and both are shown to the requester: "asked 30 · sent 20".
 */

/** Why this quantity cannot be asked for or sent, or null. Blank → "Enter how many". `held` caps a REQUEST only. */
export function quantityProblem(raw: string, held?: number | null, holder?: string): string | null {
  const t = String(raw ?? '').trim();
  if (!t) return 'Enter how many.';
  const v = Number(t);
  if (!Number.isFinite(v) || v <= 0) return 'Enter a quantity above 0.';
  if (held !== undefined && held !== null && v > Number(held)) return `${holder ?? 'That branch'} holds ${Number(held)}.`;
  return null;
}

/** "asked 30 · sent 20" once a request was sent with a changed quantity; "" otherwise. */
export function askedSent(r: { status: string; quantity: number; sent_quantity: number | null }): string {
  if (r.status !== 'accepted' || r.sent_quantity === null || r.sent_quantity === undefined) return '';
  return Number(r.sent_quantity) === Number(r.quantity) ? '' : `asked ${Number(r.quantity)} · sent ${Number(r.sent_quantity)}`;
}
