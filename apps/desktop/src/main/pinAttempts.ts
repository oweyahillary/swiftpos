/**
 * pinAttempts.ts — A494: ONE limiter for every PIN this till checks itself.
 *
 * The cloud limits wrong PINs per till; the till's own checks (its staff list — branch_staff — and its saved sign-ins —
 * staff_pin_cache, the bcrypt hashes) had no limit at all: offline, or through a refused till session, a person at the
 * till could try every 4-digit PIN at the sign-in pad, the lock screen, the update bar or a manager-PIN prompt, as fast as
 * bcrypt answers. Every local PIN check now asks here first (assertPinAllowed) and reports a wrong PIN (recordPinFailure).
 *
 * The rule: 5 wrong PINs (each counted until 15 minutes pass without one) lock every PIN check on this till for 1 minute;
 * each further lockout within the hour doubles it (2, 4, 8 … up to 15 minutes). A right PIN does not clear the count — a
 * person who knows their own PIN must not be able to reset the counter between guesses at someone else's.
 *
 * Kept in maintenance_state, so closing and reopening the app does not reset it. Never throws on a storage error (a till
 * that cannot write the counter still checks PINs — failing open here only loses the limit, never the sale).
 */
import type Database from 'better-sqlite3';
import { getLocalDb } from './localDb';

export const PIN_MAX_FAILURES = 5;
export const PIN_BASE_LOCK_MS = 60_000;
export const PIN_MAX_LOCK_MS = 15 * 60_000;
/** A wrong PIN older than this (with none since) no longer counts. */
export const PIN_FAILURE_WINDOW_MS = 15 * 60_000;
/** A lockout older than this no longer makes the next one longer. */
export const PIN_LEVEL_RESET_MS = 60 * 60_000;

const KEY = 'pin_attempts';

export interface PinAttemptState {
  failures: number;
  lastFailureAt: number;
  /** How many lockouts in a row (the next one is BASE × 2^level). */
  level: number;
  lockedUntil: number;
  lastLockAt: number;
}

const EMPTY: PinAttemptState = { failures: 0, lastFailureAt: 0, level: 0, lockedUntil: 0, lastLockAt: 0 };

function read(db: Database.Database): PinAttemptState {
  try {
    const row = db.prepare(`SELECT value FROM maintenance_state WHERE key = ?`).get(KEY) as { value?: string } | undefined;
    if (!row?.value) return { ...EMPTY };
    const v = JSON.parse(row.value);
    const n = (x: unknown) => (Number.isFinite(Number(x)) ? Number(x) : 0);
    return { failures: n(v.failures), lastFailureAt: n(v.lastFailureAt), level: n(v.level), lockedUntil: n(v.lockedUntil), lastLockAt: n(v.lastLockAt) };
  } catch { return { ...EMPTY }; }
}

function write(db: Database.Database, s: PinAttemptState): void {
  try {
    db.prepare(`INSERT INTO maintenance_state (key, value, updated_at) VALUES (?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .run(KEY, JSON.stringify(s), new Date().toISOString());
  } catch { /* the limit is lost, the PIN check is not */ }
}

/** The message a locked till shows (the same wherever the PIN was typed). */
export function pinLockedMessage(ms: number): string {
  const s = Math.max(1, Math.ceil(ms / 1000));
  const when = s >= 90 ? `${Math.ceil(s / 60)} minutes` : `${s} seconds`;
  return `Too many wrong PINs on this till. Try again in ${when}.`;
}

/** The cloud answered "too many tries" (429) — never checked on the till instead (that would undo the cloud's limit). */
export const PIN_CLOUD_BUSY = 'Too many PIN attempts. Try again shortly.';

/** How long PIN checks stay locked (0 = not locked). */
export function pinLockRemaining(now: number = Date.now(), db: Database.Database = getLocalDb()): number {
  const s = read(db);
  return s.lockedUntil > now ? s.lockedUntil - now : 0;
}

/** Throws the locked message while PIN checks are locked. Called before every local PIN check. */
export function assertPinAllowed(now: number = Date.now(), db: Database.Database = getLocalDb()): void {
  const left = pinLockRemaining(now, db);
  if (left > 0) throw new Error(pinLockedMessage(left));
}

/** A wrong PIN (or a PIN that does not allow what was asked). Returns the lockout it started, in ms (0 = none). */
export function recordPinFailure(now: number = Date.now(), db: Database.Database = getLocalDb()): number {
  const s = read(db);
  if (s.lastFailureAt && now - s.lastFailureAt > PIN_FAILURE_WINDOW_MS) s.failures = 0;
  if (s.lastLockAt && now - s.lastLockAt > PIN_LEVEL_RESET_MS) s.level = 0;
  s.failures += 1;
  s.lastFailureAt = now;
  let lock = 0;
  if (s.failures >= PIN_MAX_FAILURES) {
    lock = Math.min(PIN_MAX_LOCK_MS, PIN_BASE_LOCK_MS * 2 ** s.level);
    s.level += 1;
    s.lockedUntil = now + lock;
    s.lastLockAt = now;
    s.failures = 0;
  }
  write(db, s);
  return lock;
}

/**
 * A504: a right PIN clears the count of wrong ones (a lockout already running still runs to its end). Without it, the
 * ordinary typos of a busy shift added up across cashiers until the till locked everyone out of selling. Safe: only
 * someone who already knows a real PIN can clear it.
 */
export function notePinSuccess(db: Database.Database = getLocalDb()): void {
  const s = read(db);
  if (!s.failures) return;
  s.failures = 0;
  write(db, s);
}

/** For the technician (and tests): clear the limiter. */
export function resetPinAttempts(db: Database.Database = getLocalDb()): void {
  write(db, { ...EMPTY });
}
