/**
 * confirmReasons.ts — 0.6.27: the manager's reason where their count differs from the cashier's (a prospect's request 8).
 *
 * Owner, 2026-09-30: "When confirming shift the manager should see what the cashier added on inputed on the methods of
 * payment used, if the manager finds it less or more there should be a text box to add reason" · "the manager should not
 * edit … they key in their own value … the only difference is we are making cashiers input visible to the manager and
 * adding a reason text box".
 *
 * With the client's 'confirm_shows_cashier_figures' switch on: the manager sees the cashier's figure per method, keys in
 * their own count (never editing the cashier's), and must give a reason for every method where the two differ.
 *
 * ONE file: shared/confirmReasons.ts, copied to the till, the web and the cloud (scripts/check-shared-sync.mjs).
 */

export const REASON_MAX = 200;

const cents = (n: unknown) => Math.round((Number(n) || 0) * 100);

/**
 * The methods that need a reason: every method the manager counted differently from the cashier's declaration (a
 * method the cashier did not declare counts as 0). No declaration at all (a shift closed before A365) → none.
 */
export function reasonsNeeded(declared: Record<string, number> | null | undefined, counted: Record<string, number>): string[] {
  if (!declared) return [];
  return Object.keys(counted ?? {})
    .filter((m) => cents(counted[m]) !== cents(declared[m] ?? 0))
    .sort((a, b) => (a === 'cash' ? -1 : b === 'cash' ? 1 : a.localeCompare(b)));
}

/** The reasons as stored: only for `needed` methods, trimmed, spaces squeezed, cut to REASON_MAX. None → null. */
export function cleanReasons(raw: unknown, needed: string[]): Record<string, string> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: Record<string, string> = {};
  for (const m of needed) {
    const v = String((raw as Record<string, unknown>)[m] ?? '').replace(/\s+/g, ' ').trim().slice(0, REASON_MAX).trim();
    if (v) out[m] = v;
  }
  return Object.keys(out).length ? out : null;
}

/** The needed methods still without a reason. */
export function missingReasons(needed: string[], reasons: Record<string, string> | null | undefined): string[] {
  return needed.filter((m) => !String(reasons?.[m] ?? '').trim());
}
