/**
 * transferRequests.ts — A564: the pure rules behind "find an item in another branch's stock and ask for it".
 *
 * Owner, 2026-10-22: "add a feature where employees can search if items are in an inventory of another branch and the
 * manager can request for them".
 *
 * The routes are in routes/stock.ts (GET /other-branches, /requests …). What a request may become:
 *
 *   requested ──accept (the sending branch)──▶ accepted   a stock transfer created and despatched (the existing flow)
 *       │──────decline (the sending branch, why)──▶ declined
 *       └──────cancel (the asking branch)─────────▶ cancelled
 *
 * Pure (no database), so the tests run these exact rules.
 */

export const REQUEST_STATUSES = ['requested', 'accepted', 'declined', 'cancelled'] as const;
export type RequestStatus = typeof REQUEST_STATUSES[number];

/** The longest a search may be, and the fewest letters it needs (a product id needs none). */
export const SEARCH_MAX = 60;
export const SEARCH_MIN = 2;
/** At most this many products per answer (the default, and the most a caller may ask for). */
export const LOOKUP_DEFAULT = 20;
export const LOOKUP_MAX = 50;
/** The most one request may ask for, and the longest note / reason. */
export const QUANTITY_MAX = 100000;
export const NOTE_MAX = 300;

/**
 * The search as the database is asked it: trimmed, inner spaces collapsed, and without the characters a PostgREST
 * filter or a LIKE pattern gives a meaning to (% _ , ( ) * \ " ') — "50% off" searches for "50 off", never "anything".
 */
export function searchTerm(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[%_,()*\\"']/g, ' ').replace(/\s+/g, ' ').trim().slice(0, SEARCH_MAX);
}

/** How many products to answer with: the default, at least 1, at most LOOKUP_MAX. */
export function lookupLimit(raw: unknown): number {
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n > 0 ? Math.min(n, LOOKUP_MAX) : LOOKUP_DEFAULT;
}

/** A quantity asked for or sent: a number above 0 and at most QUANTITY_MAX (3 decimals, as the column), else null. */
export function requestQuantity(raw: unknown): number | null {
  const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : typeof raw === 'number' ? raw : NaN;
  if (!Number.isFinite(n) || n <= 0 || n > QUANTITY_MAX) return null;
  return Math.round(n * 1000) / 1000;
}

/** A note or a reason: trimmed, at most NOTE_MAX characters; empty → null. */
export function cleanNote(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.trim().slice(0, NOTE_MAX);
  return t ? t : null;
}

/** Which branch must act for each step: the sending branch accepts and declines, the asking branch cancels. */
export function actingBranch(step: 'accept' | 'decline' | 'cancel', r: { from_branch_id: string; to_branch_id: string }): string {
  return step === 'cancel' ? r.to_branch_id : r.from_branch_id;
}

/** What a step makes of a request still waiting; anything else is already decided (409). */
export function nextStatus(step: 'accept' | 'decline' | 'cancel'): RequestStatus {
  return step === 'accept' ? 'accepted' : step === 'decline' ? 'declined' : 'cancelled';
}

/** The words for a request no longer waiting. */
export function decidedMessage(status: string): string {
  if (status === 'accepted') return 'This request was already accepted — the stock is on its way as a transfer.';
  if (status === 'declined') return 'This request was already declined.';
  if (status === 'cancelled') return 'This request was cancelled by the branch that asked.';
  return 'This request is no longer waiting.';
}
