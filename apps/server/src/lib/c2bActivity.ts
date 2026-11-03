/**
 * c2bActivity.ts — A621: when each branch's list of M-Pesa payments last changed, kept in memory, so a POS asking "anything
 * new?" every few seconds while its payment screen is open costs no database read when nothing moved.
 *
 * Every change to the list goes through this server (a payment arriving, a POS taking or giving one back, an order using
 * one, the owner switching notifications), and each calls noteC2bChange. The POS sends back the stamp of its last answer;
 * nothing changed since → "unchanged", no read. This server runs one instance (WEB_CONCURRENCY=1, as lib/liveHub.ts); a
 * restart forgets the stamps, and a stamp from before the restart always reads as changed — one read, then quiet again.
 */
const STARTED_AT = Date.now();
const changedAt = new Map<string, number>();

export function noteC2bChange(branchId: string): void {
  changedAt.set(branchId, Date.now());
}

/** Has the branch's list changed at or after `since` (a stamp this server gave out)? Unknown or old stamps: yes. */
export function c2bChangedSince(branchId: string, since: number | null): boolean {
  if (since === null || !Number.isFinite(since) || since < STARTED_AT) return true;
  return (changedAt.get(branchId) ?? STARTED_AT) >= since;
}

/** "?since=1762000000000" → the stamp, or null. */
export function sinceParam(v: unknown): number | null {
  const n = Number(typeof v === 'string' ? v : NaN);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Test seam: forget every stamp. */
export function _resetC2bActivity(): void {
  changedAt.clear();
}
