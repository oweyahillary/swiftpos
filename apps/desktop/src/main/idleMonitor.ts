import { powerMonitor, BrowserWindow } from 'electron';
import { logLine } from './logFile';

/**
 * idleMonitor — the till locks itself when NOBODY IS THERE.
 *
 * ── WHY OS IDLE AND NOT APP ACTIVITY ─────────────────────────────────────────
 * `powerMonitor.getSystemIdleTime()` reports seconds since the last keyboard or
 * mouse input ANYWHERE on the machine — the same signal Windows uses to blank a
 * screen. That choice is the whole design, not an implementation detail:
 *
 *   * A cashier mid-sale is touching the machine, so idle is 0 and the timer
 *     cannot fire. "Never lock mid-transaction" is therefore true BY
 *     CONSTRUCTION rather than by a special case somebody has to remember.
 *   * Renderer mouse listeners would miss a cashier reading a long receipt,
 *     counting cash into the drawer, or working in another window, and would
 *     lock a till somebody is standing at. That is how lock fatigue starts, and
 *     staff answer lock fatigue with trivial or shared PINs — a net LOSS of
 *     security on a 4-6 digit PIN over bcrypt.
 *   * It is one source of truth. Per-window listeners drift the moment a new
 *     window is added.
 *
 * ── WHAT THE LOCK IS ─────────────────────────────────────────────────────────
 * A CURTAIN, not a reset. The renderer overlays the screen; nothing clears the
 * cart, the staff session, or anything in SQLite. PIN back in and the till is
 * exactly where it was, mid-cart, mid-anything. So "lock and lose the sale"
 * cannot happen — the case is designed out rather than handled.
 *
 * Unlock goes to the PIN PAD, never the owner sign-in. If a lock cleared the
 * staff session and the offline PIN cache were empty or expired, a shop with no
 * internet would lock itself out of its own till — register A17 arriving through
 * a door we built ourselves. The PIN pad reads `staff_pin_cache`, which works
 * offline for 14 days.
 *
 * ── WHAT SUPPRESSES IT ───────────────────────────────────────────────────────
 * Work in flight where nobody is touching the screen but the till is busy: an
 * M-Pesa STK push waiting on a callback, a print job spooling. Those hold the
 * lock off until they resolve — a curtain dropping over a payment the customer
 * is completing on their phone would read as a crash.
 */

/** Seconds of OS idle before each surface locks. Named so they can be tuned. */
export const IDLE_LIMITS = {
  /**
   * Manager screens: Close Day, Close Branch, Staff, Receipt, Printers — and
   * `settings.manage` currently also gates till revocation and eTIMS
   * registration (register A46). This is the real exposure on an unattended
   * till, so it is the shorter of the two.
   */
  manager: 5 * 60,
  /**
   * The POS screen sells. Worst case is a sale rung on the last cashier's PIN,
   * which matters less than the manager tools, and a longer window covers a
   * genuinely abandoned till without nagging a quiet afternoon shift.
   *
   * NOT 3 minutes: that is short enough to catch someone counting cash at the
   * drawer or reading a long receipt, and OS idle does not know the difference
   * between "away" and "not typing".
   */
  pos: 10 * 60,
} as const;

export type IdleSurface = keyof typeof IDLE_LIMITS;

/** How often we ask the OS. Cheap; 5s keeps the lock punctual without polling hard. */
const POLL_MS = 5_000;

let _timer: NodeJS.Timeout | null = null;
let _surface: IdleSurface | null = null;   // null = nothing lockable on screen
let _locked = false;
let _suppressions = 0;                     // >0 = work in flight, hold the lock

/**
 * Tell the monitor which surface is showing. Called from the renderer on every
 * state change, and with null for the PIN pad, owner login, install and tech
 * screens — locking a lock screen is meaningless.
 */
export function setIdleSurface(surface: IdleSurface | null): void {
  _surface = surface;
  if (surface === null) _locked = false;   // already at the PIN pad
}

/** Called when the user PINs back in. */
export function clearIdleLock(): void {
  _locked = false;
}

/**
 * Hold the lock off while something is genuinely in flight. Returns a release
 * function. A COUNTER, not a boolean: a spooling print job and an STK push can
 * overlap, and a boolean would let whichever finished first re-arm the lock
 * while the other was still running.
 */
export function suppressIdleLock(): () => void {
  _suppressions++;
  let released = false;
  return () => {
    if (released) return;   // idempotent — a double release must not go negative
    released = true;
    _suppressions--;
  };
}

/** Exposed for tests: the decision, with no Electron and no clock. */
export function shouldLock(
  idleSeconds: number,
  surface: IdleSurface | null,
  alreadyLocked: boolean,
  suppressions: number,
): boolean {
  if (surface === null) return false;      // PIN pad, login, install, tech
  if (alreadyLocked) return false;         // do not re-fire every poll
  if (suppressions > 0) return false;      // work in flight
  return idleSeconds >= IDLE_LIMITS[surface];
}

export function startIdleMonitor(): void {
  if (_timer) return;

  _timer = setInterval(() => {
    if (!shouldLock(powerMonitor.getSystemIdleTime(), _surface, _locked, _suppressions)) return;

    _locked = true;
    logLine('idle', `locked after ${IDLE_LIMITS[_surface!]}s idle on the ${_surface} screen`);

    for (const w of BrowserWindow.getAllWindows()) {
      w.webContents.send('idle:lock');
    }
  }, POLL_MS);
}

export function stopIdleMonitor(): void {
  if (_timer) { clearInterval(_timer); _timer = null; }
}
