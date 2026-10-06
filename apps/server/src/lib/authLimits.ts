/**
 * authLimits.ts — A415: which sign-in calls count towards the "too many attempts" limit.
 *
 * Owner, 2026-10-06: "i was getting errors that too many log in attempts on the web yet it was only one attempt".
 * Every call under /api/auth shared one counter per address (30 in 15 minutes), successful ones included — and a
 * till's background renewals (/refresh, /device-token) carry no Authorization header, so they were counted by the
 * shop's address. A till whose renewal was refused retried on every sync pass, used up the 30 in minutes, and the
 * owner signing in on the web from the same address was told "too many attempts" on the first try.
 *
 *   - Password, PIN and code attempts: only FAILED attempts count (a person signing in correctly is never limited).
 *   - A till's renewals have their own counter, per till — they can never use up a person's sign-in attempts. Not a
 *     brute-force door: a renewal needs a refresh token or a device secret, both far too long to guess.
 *
 * Pure, so the tests run this exact rule.
 */

/** The till's (and the dashboard's) background renewals — not a person typing a password, PIN or code. */
const RENEWALS = new Set(['/refresh', '/device-token', '/logout']);

/** `path` is relative to /api/auth (Express strips the mount). */
export function isRenewalPath(path: string): boolean {
  const p = String(path || '').split('?')[0].replace(/\/+$/, '') || '/';
  return RENEWALS.has(p);
}

/** A renewal's counter: the till's own id when it sends one, else the address. */
export function renewalKey(deviceId: string | undefined | null, ipKey: string): string {
  const d = String(deviceId ?? '').split(',')[0].trim();
  return d ? `renew:d:${d.slice(0, 64)}` : `renew:ip:${ipKey}`;
}

/** Renewals allowed per till per 15 minutes — far above a healthy till's few, low enough to stop a runaway loop. */
export const RENEWALS_PER_WINDOW = 120;
