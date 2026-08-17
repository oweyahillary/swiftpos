// dayService — the trading day, per till.
//
// Two levels of cash custody:
//
//   business_days  one row per TILL per trading date. Opens implicitly when the
//                  first cashier opens a drawer that date; closes ONLY when a
//                  manager counts the cash.
//   shifts         a cashier's own drawer session inside a day. Several per till
//                  per day as staff hand over. Cashier opens and closes their
//                  own — no manager needed.
//
// WHY THE DAY IS KEYED ON THE TILL, NOT THE BRANCH
//   Each terminal has its own SQLite database and only ORDERS cross the branch
//   LAN. Drawer state never leaves the machine that owns it, so one till cannot
//   observe another's. A branch-wide day would have to be read from the
//   aggregation node — itself just a till PC — and if it were switched off, all
//   three tills would refuse to sell. That is an outage, not a control. The
//   drawer is also the thing being reconciled, so the till is the right grain.
//
// WHY ENFORCEMENT IS LOCAL
//   The gate has to work at 06:00 with the internet down. So the local database
//   is the authority and the server is a backstop at sync, not the other way
//   round.
//
// WHAT THIS DELIBERATELY WILL NOT DO
//   It never closes a day or a drawer on its own, and never writes a zero
//   variance. A count nobody made is a fabricated reconciliation, which is worse
//   than none: an open day is visibly wrong, a fake close is invisibly wrong and
//   its zero variance is the number somebody will later rely on.

import { emitEvent } from './nodeIngest';
import { getLocalDb } from './localDb';
import { getOpenShift } from './syncEngine';
import { getDeviceConfig } from './deviceConfig';
import { v4 as uuid } from 'uuid';

/** Same rule as the renderer's hasManagerRights (App.tsx) so the two agree. */
const MANAGER_ROLES = ['manager', 'supervisor', 'admin', 'branch_manager'];

// 24-hour operation grace (A104): hours after midnight a continuous business may
// keep trading with an unclosed prior day, behind a reminder, before the till
// hard-locks. Owner's call — long enough to close the drawer during handover,
// short enough that "confirm the cash" still means today.
const GRACE_HOURS = 2;

export interface BusinessDay {
  id: string;
  business_id: string;
  branch_id: string;
  device_id: string | null;
  terminal_code: string | null;
  business_date: string;
  opened_at: string;
  opened_by: string | null;
  closed_at: string | null;
  closed_by: string | null;
  status: 'open' | 'closed';
  counted_cash: number | null;
  expected_cash: number | null;
  cash_variance: number | null;
  notes: string | null;
}

/**
 * Today's trading date at THIS till, as YYYY-MM-DD.
 *
 * Local time from the machine's own clock, deliberately — not UTC. The terminal
 * is physically in the shop, so it is the authority on which trading day a sale
 * belongs to. Using UTC would roll the day over at 03:00 Nairobi and split a
 * late evening's takings across two days.
 */
export function businessDateNow(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function deviceIdentity() {
  const cfg = getDeviceConfig();
  return {
    device_id: cfg?.device_id ?? null,
    terminal_code: cfg?.terminal_code ?? null,
  };
}

function staffSession() {
  const db = getLocalDb();
  return db.prepare(
    `SELECT staff_id, staff_name, role_name, permissions, branch_id FROM staff_session WHERE id=1`,
  ).get() as
    | { staff_id: string; staff_name: string; role_name: string | null; permissions: string; branch_id: string }
    | undefined;
}

/**
 * Does the signed-in user carry manager rights?
 *
 * Read from the CACHED staff_session, which is written at PIN login. That makes
 * it work offline — unlike auth:verifyPin, which is a network call and also
 * replaces the session, so it cannot be used to authorise an action mid-shift.
 *
 * Enforced here in the main process, not by hiding a button: a control that only
 * exists in the UI is a suggestion.
 */
export function isManager(): boolean {
  const s = staffSession();
  if (!s) return false;
  if (MANAGER_ROLES.includes((s.role_name ?? '').toLowerCase())) return true;
  try {
    const perms = JSON.parse(s.permissions || '{}') as Record<string, unknown>;
    return perms['*'] === true || perms['settings.manage'] === true;
  } catch {
    return false;   // malformed permissions must not grant rights
  }
}

/** The till's currently open trading day, whatever date it belongs to. */
export function getOpenDay(): BusinessDay | null {
  const db = getLocalDb();
  const { device_id } = deviceIdentity();
  return db.prepare(`
    SELECT * FROM business_days
     WHERE status = 'open' AND COALESCE(device_id,'') = COALESCE(?,'')
     ORDER BY business_date ASC LIMIT 1
  `).get(device_id) as BusinessDay | undefined ?? null;
}

export interface DayGate {
  /** True when this till may trade right now. */
  canTrade: boolean;
  /** Set when it may not. Written for a cashier, not a developer. */
  reason?: string;
  /** True when only a manager can clear the obstruction. */
  needsManager?: boolean;
  /** The stale day, when that is what is blocking. */
  staleDay?: BusinessDay;
  /**
   * 24-hour operation (A104): an unclosed prior day inside the grace window.
   * The till keeps trading; the renderer shows this as an amber reminder, not
   * the red hard block. A manager must still close the day before the grace ends.
   */
  staleGrace?: string;
  /**
   * Distinguishes "nobody has opened a drawer" from "a manager must clear
   * yesterday". Both stop a sale, but the cashier's next action is completely
   * different — open your own drawer, or go and find a manager — and the first
   * release reported only the stale-day case. A cashier with no drawer open
   * therefore saw nothing at all, rang up a full basket, and met the refusal for
   * the first time at payment.
   */
  needsShift?: boolean;
}

/**
 * May this till trade?
 *
 * Two obstructions, reported separately because they need different actions:
 *
 *   needsManager — the PREVIOUS day was never closed. Selling now would post
 *                  today's takings against yesterday's drawer, which is the exact
 *                  harm the day close exists to prevent. Manager only.
 *   needsShift   — no drawer is open on this till. The cashier clears this
 *                  themselves by opening one with a counted float.
 */
export function checkDayGate(): DayGate {
  const today = businessDateNow();
  const open = getOpenDay();
  let graceReason: string | undefined;

  if (open && open.business_date < today) {
    // 24-hour / continuous operation (A104): keep the hard lock — cash must be
    // confirmed before a day closes — but a round-the-clock branch cannot be
    // stopped dead the instant the date rolls over. Give a GRACE_HOURS window
    // from midnight during which the till keeps trading behind a reminder; after
    // it, the hard lock stands and only a manager can clear it. A non-continuous
    // business locks immediately, as before.
    const startOfToday = new Date(`${today}T00:00:00`).getTime();
    const graceUntil = startOfToday + GRACE_HOURS * 60 * 60 * 1000;
    const inGrace = getDeviceConfig()?.continuous_operation === true && Date.now() < graceUntil;

    if (!inGrace) {
      return {
        canTrade: false,
        needsManager: true,
        staleDay: open,
        reason:
          `Trading day ${open.business_date} was never closed on this till. ` +
          `A manager must count the cash and close it before ${today} can start.`,
      };
    }
    const g = new Date(graceUntil);
    const pad = (n: number) => String(n).padStart(2, '0');
    graceReason =
      `Trading day ${open.business_date} still needs closing. A manager must count ` +
      `the cash and close it by ${pad(g.getHours())}:${pad(g.getMinutes())} — the till keeps running until then.`;
  }

  if (!getOpenShift()) {
    return {
      canTrade: false,
      needsShift: true,
      staleGrace: graceReason,
      reason: 'No drawer is open. Open a shift with its counted float to start selling.',
    };
  }

  return { canTrade: true, staleGrace: graceReason };
}

/**
 * Open today's day if it is not already open, and return it.
 *
 * Called from openShift, so the day appears when the first cashier takes a
 * drawer. There is no separate "open the day" button: an extra step at 06:00
 * that a cashier can forget is a step that gets worked around, and the day has
 * no meaning independent of a drawer being open.
 */
/**
 * The manager-only obstruction, on its own.
 *
 * Separate from checkDayGate because that now also reports "no drawer open" —
 * and opening a drawer is precisely what ensureDayOpen and openShift are doing.
 * Consulting the full gate there would refuse to open the shift that clears it.
 */
export function checkStaleDay(): DayGate {
  const gate = checkDayGate();
  return gate.needsManager ? gate : { canTrade: true };
}

export function ensureDayOpen(openedByStaffId?: string | null): BusinessDay {
  const gate = checkStaleDay();
  if (!gate.canTrade) throw new Error(gate.reason ?? 'This till cannot trade yet');

  const existing = getOpenDay();
  if (existing) return existing;

  const db = getLocalDb();
  const session = db.prepare(`SELECT business_id FROM session WHERE id=1`).get() as { business_id: string } | undefined;
  const staff = staffSession();
  if (!session) throw new Error('Not signed in');
  if (!staff) throw new Error('No cashier — sign in with a PIN first');

  const { device_id, terminal_code } = deviceIdentity();
  const id = uuid();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO business_days
      (id, business_id, branch_id, device_id, terminal_code, business_date,
       opened_at, opened_by, status, created_at, sync_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, 'pending')
  `).run(id, session.business_id, staff.branch_id, device_id, terminal_code,
         businessDateNow(), now, openedByStaffId ?? staff.staff_id, now);

  return db.prepare(`SELECT * FROM business_days WHERE id=?`).get(id) as BusinessDay;
}

export interface ConflictedShift {
  id: string;
  cashier_name: string;
  business_date: string | null;
  notes: string | null;
}

/**
 * Shifts the server refused and no retry will fix.
 *
 * Currently one cause: the cashier already holds an open drawer on another till,
 * so shifts_one_open_per_cashier (migration 42) rejected this one. Parked as
 * sync_status='conflict' rather than left pending, because retrying every pass
 * would loop forever and bury the real error in the sync log.
 *
 * Surfaced to the manager because only a manager can resolve it — by closing the
 * other drawer, on the till that holds it or from the dashboard.
 */
export function getConflictedShifts(): ConflictedShift[] {
  const db = getLocalDb();
  return db.prepare(`
    SELECT s.id, s.business_date, s.notes,
           COALESCE(st.name, 'Unknown cashier') AS cashier_name
      FROM shifts s
      -- own: drives THIS till's Close Day screen. A branch-wide version is a
      -- manager view and belongs in managerReports, not here.
      -- users, NOT staff: there is no local staff table, only staff_session (one
      -- row for whoever is signed in). Cashier names live in users, pulled down
      -- from the server. Joining staff threw "no such table", which rejected
      -- day:conflicts and blanked the entire Close Day screen.
      LEFT JOIN users st ON st.id = s.cashier_id
     WHERE s.sync_status = 'conflict'
       AND COALESCE(s.device_id,'') = COALESCE(?,'')
     ORDER BY s.opened_at DESC
  `).all(deviceIdentity().device_id ?? null) as ConflictedShift[];
}

/**
 * Re-arm a conflicted shift for sync — the shift itself, its trading day, and
 * its float/expense rows, as one family.
 *
 * The sync engine deliberately never retries 'conflict' rows: an automatic
 * retry of an identical payload is the C7 loop. But some refusals have an
 * EXTERNAL cause that clears later — the live one: a cashier's open drawer on
 * another till (migration 42), refused on the 30th, drawer since closed. With
 * no re-offer path the shift is parked forever, and the conflict card's promise
 * that "this will sync" was a promise nothing kept.
 *
 * Manual-by-a-manager is what makes this safe where automatic was not: each
 * press is one attempt, and if the cause still holds, the server refuses again
 * and the row simply returns to 'conflict' with the fresh reason — no loop.
 */
export function retryConflictedShift(shiftId: string): { rearmed: number } {
  const db = getLocalDb();
  const { device_id } = deviceIdentity();

  // own: only this till's parked rows are its to re-offer. A keyed id is not
  // enough by itself — on a node, re-arming a PEER's conflicted shift would
  // make this till push somebody else's drawer from the wrong device.
  const shift = db.prepare(`
    SELECT id, business_day_id FROM shifts
     WHERE id = ? AND sync_status = 'conflict'
       AND COALESCE(device_id,'') = COALESCE(?,'')
  `).get(shiftId, device_id) as { id: string; business_day_id: string | null } | undefined;
  if (!shift) throw new Error('No conflicted shift with that id on this till');

  let rearmed = 0;
  db.transaction(() => {
    rearmed += db.prepare(`UPDATE shifts SET sync_status='pending' WHERE id = ?`).run(shift.id).changes;
    // The family travels together: a refused shift usually took its floats and
    // expenses down with it, and its day can be parked on the same cause.
    rearmed += db.prepare(`UPDATE float_transactions SET sync_status='pending'
                            WHERE shift_id = ? AND sync_status='conflict'`).run(shift.id).changes;
    rearmed += db.prepare(`UPDATE expenses SET sync_status='pending'
                            WHERE shift_id = ? AND sync_status='conflict'`).run(shift.id).changes;
    if (shift.business_day_id) {
      rearmed += db.prepare(`UPDATE business_days SET sync_status='pending'
                              WHERE id = ? AND sync_status='conflict'`).run(shift.business_day_id).changes;
    }
  })();
  return { rearmed };
}

export interface DayCloseSummary {
  day: BusinessDay;
  shifts: number;
  /** Shifts that ended without anyone counting the drawer. */
  unreconciledShifts: number;
  expectedCash: number;
  countedCash: number;
  variance: number;
}

/**
 * What the manager should see before closing the day.
 *
 * expected_cash is the sum of the day's own shift reconciliations. That stays
 * correct however drawers moved between tills, because each shift was counted in
 * and counted out — the episode is self-contained. Forced closes are counted and
 * reported separately: a day containing an uncounted drawer is not "balanced",
 * whatever the arithmetic says.
 */
export function getDayCloseSummary(): DayCloseSummary | null {
  const db = getLocalDb();
  const day = getOpenDay();
  if (!day) return null;

  const rows = db.prepare(`
    SELECT status, expected_cash, closing_float
      FROM shifts
     WHERE business_day_id = ?
  `).all(day.id) as { status: string; expected_cash: number | null; closing_float: number | null }[];

  const expectedCash = rows.reduce((s, r) => s + (r.expected_cash ?? 0), 0);
  const countedCash = rows.reduce((s, r) => s + (r.closing_float ?? 0), 0);

  return {
    day,
    shifts: rows.length,
    unreconciledShifts: rows.filter(r => r.status === 'closed_unreconciled').length,
    expectedCash,
    countedCash,
    variance: countedCash - expectedCash,
  };
}

/**
 * Close the trading day. MANAGER ONLY.
 *
 * countedCash is the manager's own count — the SECOND count of the day, since
 * each cashier already counted their drawer at their own close. Two counts by
 * two people is the whole point: a single counter who can see the expected
 * figure can quietly close a shortage to zero.
 *
 * Refuses while any drawer on the day is still open. Closing a day over a live
 * drawer would leave takings attributed to a day already signed off.
 */
export function closeDay(countedCash: number, notes?: string): DayCloseSummary {
  if (!isManager()) {
    throw new Error('Only a manager can close the trading day. Ask a manager to sign in.');
  }
  return closeDayCore(countedCash, notes, staffSession()?.staff_id ?? null);
}

/**
 * The central-close variant (Phase 4). Identical body EXCEPT the local
 * isManager() check: a peer executing this at 22:00 may have a cashier signed
 * in or be locked, and the authority is the INSTRUCTION — created by a manager
 * on the branch server, carried over the node-secret channel. closed_by records
 * that manager, and the notes say the close was central, so the audit reads the
 * truth: who decided, and that it was not decided at this keyboard.
 *
 * Everything else is deliberately unchanged — in particular the open-drawer
 * refusal, which is what turns into the honest "T2: a drawer is still open
 * (Eugene)" line on the manager's screen.
 */
export function closeDayInstructed(
  countedCash: number, notes: string | undefined,
  closedByStaffId: string | null, closedByName: string | null,
): DayCloseSummary {
  const centralNote = `Closed centrally from the branch server${closedByName ? ` by ${closedByName}` : ''}.`;
  const combined = notes && notes.trim() ? `${notes.trim()}\n${centralNote}` : centralNote;
  return closeDayCore(countedCash, combined, closedByStaffId);
}

function closeDayCore(countedCash: number, notes: string | undefined, closedByStaffId: string | null): DayCloseSummary {
  if (!Number.isFinite(countedCash) || countedCash < 0) {
    throw new Error('Enter the cash you counted before closing the day');
  }

  const db = getLocalDb();
  const day = getOpenDay();
  if (!day) throw new Error('No open trading day on this till');

  const liveShift = getOpenShift();
  if (liveShift) {
    throw new Error(
      'A drawer is still open on this till. Every shift must be closed before the day can be.',
    );
  }

  const summary = getDayCloseSummary();
  if (!summary) throw new Error('No open trading day on this till');

  const now = new Date().toISOString();
  const variance = countedCash - summary.expectedCash;

  db.prepare(`
    UPDATE business_days
       SET status='closed', closed_at=?, closed_by=?,
           counted_cash=?, expected_cash=?, cash_variance=?,
           notes = CASE WHEN ? IS NULL OR ? = '' THEN notes
                        ELSE TRIM(COALESCE(notes,'') || char(10) || ?) END,
           sync_status='pending'
     WHERE id=?
  `).run(now, closedByStaffId, countedCash, summary.expectedCash, variance,
         notes ?? null, notes ?? null, notes ?? null, day.id);
  // Phase 2b: the day close is a fact for the branch. Replicas of this trading
  // day stop reading 'open' forever, and the Close Branch screen's per-till
  // day state stops depending solely on the live poll.
  emitEvent('day_closed', day.id, {
    status: 'closed', closed_at: now, closed_by: closedByStaffId,
    counted_cash: countedCash, expected_cash: summary.expectedCash,
    cash_variance: variance, notes: notes ?? null,
  });

  return {
    ...summary,
    day: db.prepare(`SELECT * FROM business_days WHERE id=?`).get(day.id) as BusinessDay,
    countedCash,
    variance,
  };
}

/**
 * Guard for anything that records a sale. Throws when the till may not trade.
 *
 * Called from order creation rather than the UI, because the UI is not where the
 * rule can be enforced: before this, createLocalOrder stamped shift_id as null
 * when no shift was open and sold anyway, so a cashier could trade an entire day
 * having never opened a drawer.
 */
export function assertCanSell(): { shiftId: string; businessDayId: string | null } {
  const gate = checkDayGate();
  if (!gate.canTrade) throw new Error(gate.reason ?? 'This till cannot trade yet');

  const shift = getOpenShift();
  if (!shift) {
    throw new Error('No drawer is open. Open a shift with its counted float before selling.');
  }

  return { shiftId: shift.id, businessDayId: shift.business_day_id ?? null };
}
