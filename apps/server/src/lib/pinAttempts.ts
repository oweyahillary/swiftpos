/**
 * pinAttempts.ts — A494: ONE limiter for every route that takes a PIN, and a per-account counter for the sign-ins.
 *
 * Before A494 the only brake on a PIN guess was the auth limiter (30 FAILED requests per 15 minutes) keyed on the
 * last 24 characters of whatever Authorization header the caller sent — a fresh made-up header was a fresh bucket — and
 * /api/staff/clock (which named whoever's PIN matched) had no brake at all beyond the general 600/minute.
 *
 *   PIN failures   per (business, the caller: their user id — or the till's device id — or, with neither, the IP).
 *                  PIN_MAX_FAILS within PIN_WINDOW_MS → every PIN from that caller is refused (429 PIN_LOCKED) for
 *                  PIN_LOCK_MS, the right PIN included (a lock that a right guess could pass is no lock).
 *   Account fails  per e-mail address (lower-cased) on /auth/login and /auth/pos-login, whoever asks from wherever:
 *                  ACCOUNT_MAX_FAILS within ACCOUNT_WINDOW_MS → 429 for ACCOUNT_LOCK_MS. An IP-keyed limit alone lets
 *                  an attacker with many addresses guess one person's PIN without end.
 *
 * In memory (one cloud process; a restart forgets — acceptable for a brake, and nothing is written per guess).
 * Pure apart from the clock, which the tests pass in.
 *
 * Other routes that take a PIN (an approver's PIN on a void / refund / drawer confirm — routes/orders.ts, shifts.ts):
 *
 *   const key = pinKey(req);
 *   if (pinLocked(key)) { res.status(429).json(PIN_LOCKED_BODY); return; }
 *   ... check the PIN ...
 *   if (!ok) { notePinFailure(key); res.status(401)...; return; }
 *   notePinSuccess(key);
 */

export const PIN_MAX_FAILS = 10;
export const PIN_WINDOW_MS = 15 * 60_000;
export const PIN_LOCK_MS = 15 * 60_000;
export const ACCOUNT_MAX_FAILS = 10;
export const ACCOUNT_WINDOW_MS = 15 * 60_000;
export const ACCOUNT_LOCK_MS = 15 * 60_000;

export const PIN_LOCKED_BODY = {
  error: 'Too many wrong PINs — PIN entry is paused for 15 minutes.',
  code: 'PIN_LOCKED',
} as const;
export const ACCOUNT_LOCKED_BODY = {
  error: 'Too many failed sign-ins for this account — try again in 15 minutes.',
  code: 'ACCOUNT_LOCKED',
} as const;

interface Entry { fails: number[]; lockedUntil: number }

export interface FailureCounter {
  locked(key: string, now?: number): boolean;
  /** Record a failure; returns true when this failure locked the key. */
  fail(key: string, now?: number): boolean;
  succeed(key: string): void;
  reset(): void;
  size(): number;
}

export function createFailureCounter(opts: { max: number; windowMs: number; lockMs: number; maxKeys?: number }): FailureCounter {
  const map = new Map<string, Entry>();
  const maxKeys = opts.maxKeys ?? 100_000;
  const prune = (now: number) => {
    if (map.size < maxKeys) return;
    for (const [k, e] of map) {
      if (e.lockedUntil <= now && !e.fails.some((t) => t > now - opts.windowMs)) map.delete(k);
    }
    // Still full (a flood of distinct keys): drop the oldest — a brake that grows without end is a way to stop the cloud.
    while (map.size >= maxKeys) { const first = map.keys().next().value; if (first === undefined) break; map.delete(first); }
  };
  return {
    locked(key, now = Date.now()) {
      const e = map.get(key);
      return !!e && e.lockedUntil > now;
    },
    fail(key, now = Date.now()) {
      prune(now);
      const e = map.get(key) ?? { fails: [], lockedUntil: 0 };
      e.fails = e.fails.filter((t) => t > now - opts.windowMs);
      e.fails.push(now);
      let lockedNow = false;
      if (e.fails.length >= opts.max) { e.lockedUntil = now + opts.lockMs; e.fails = []; lockedNow = true; }
      map.set(key, e);
      return lockedNow;
    },
    succeed(key) {
      const e = map.get(key);
      if (e && e.lockedUntil <= Date.now()) map.delete(key);
    },
    reset() { map.clear(); },
    size() { return map.size; },
  };
}

const pins = createFailureCounter({ max: PIN_MAX_FAILS, windowMs: PIN_WINDOW_MS, lockMs: PIN_LOCK_MS });
const accounts = createFailureCounter({ max: ACCOUNT_MAX_FAILS, windowMs: ACCOUNT_WINDOW_MS, lockMs: ACCOUNT_LOCK_MS });

/** Whose PIN guesses these are: the business and the caller (person, else the till, else the address). */
export function pinKey(req: { businessId?: string | null; userId?: string | null; deviceId?: string | null; isTill?: boolean; ip?: string | null }): string {
  const who = req.userId ? `u:${req.userId}` : req.isTill && req.deviceId ? `d:${req.deviceId}` : `ip:${req.ip ?? ''}`;
  return `${req.businessId ?? '-'}|${who}`;
}

export const pinLocked = (key: string, now?: number): boolean => pins.locked(key, now);
export const notePinFailure = (key: string, now?: number): boolean => pins.fail(key, now);
export const notePinSuccess = (key: string): void => pins.succeed(key);

const accountKey = (email: unknown): string => String(email ?? '').trim().toLowerCase();
export const accountLocked = (email: unknown, now?: number): boolean => accounts.locked(accountKey(email), now);
export const noteAccountFailure = (email: unknown, now?: number): boolean => accounts.fail(accountKey(email), now);
export const noteAccountSuccess = (email: unknown): void => accounts.succeed(accountKey(email));

/** Tests only. */
export function _resetAttempts(): void { pins.reset(); accounts.reset(); }
