/**
 * dayCloseRules.ts — A522: the rules of the remote Close Day (routes/day-close.ts) when a till is off or slow.
 *
 * Owner, 2026-10-17: "check if anything will break or fail to respond because a till has not responded, I know not all
 * tills will run 24/7". Act on what is known; never wait on an absent till; queue the rest for when it reconnects.
 */

/** A till silent this long (or retired) may have its open day closed as abandoned from the web. */
export const ABANDON_SILENT_HOURS = 24;

/**
 * The till's refusals that mean "not yet", not "no": a drawer still open on it, or a shift counted offline that a manager
 * has not confirmed. The instruction stays pending with the reason shown — the till tries it again at every beat, and it
 * closes as soon as the drawer is closed / the shift confirmed. The till sends the reason as text (branchClose.ts
 * executeCloseDay → dayService closeDayCore); a code when it sends one (A521: `code`). Anything else is a real refusal.
 */
export type WaitingCode = 'DRAWER_OPEN' | 'SHIFTS_UNCONFIRMED';
export function waitingCode(ack: { code?: unknown; error?: unknown } | null | undefined): WaitingCode | null {
  const code = String(ack?.code ?? '').trim().toUpperCase();
  if (code === 'DRAWER_OPEN' || code === 'SHIFTS_UNCONFIRMED') return code;
  const text = String(ack?.error ?? '');
  if (/drawer is still open/i.test(text)) return 'DRAWER_OPEN';
  if (/must be confirmed by a manager before the day can close/i.test(text)) return 'SHIFTS_UNCONFIRMED';
  return null;
}

/** Hours since a till last synced (Infinity when it never did). */
export function silentHours(lastSyncAt: string | null | undefined, now: Date = new Date()): number {
  const t = lastSyncAt ? Date.parse(lastSyncAt) : NaN;
  return Number.isFinite(t) ? Math.max(0, (now.getTime() - t) / 3_600_000) : Infinity;
}

/** May this till's open day be closed as abandoned (retired, or silent for ABANDON_SILENT_HOURS)? */
export function mayAbandon(dev: { retired_at?: string | null; last_sync_at?: string | null } | null | undefined, now: Date = new Date()): boolean {
  if (!dev) return true;   // not on the fleet at all: nothing will ever answer for it
  return !!dev.retired_at || silentHours(dev.last_sync_at, now) >= ABANDON_SILENT_HOURS;
}
