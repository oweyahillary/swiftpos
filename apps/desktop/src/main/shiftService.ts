// Shift service — offline cash-up lifecycle, computed entirely from local SQLite.
//
// Mirrors the server's reconciliation math (apps/server/routes/shifts.ts) so the
// offline Z-report matches what the cloud would produce:
//
//   expected_cash = opening_float + cash_sales + float_in - float_out
//   cash_variance = counted (closing_float) - expected_cash
//
// Everything here works with no network. Shifts/float rows are written with
// sync_status='pending'; the push-up to the server is a separate concern (it
// needs FK-ordered sync + an idempotent server id) and is NOT wired here.

import { emitEvent } from './nodeIngest';
import { getLocalDb } from './localDb';
import { getOpenShift } from './syncEngine';
import { getDeviceConfig, canSell } from './deviceConfig';
import { checkStaleDay, ensureDayOpen } from './dayService';
import { v4 as uuid } from 'uuid';

export interface ZReport {
  shift: {
    id: string;
    opened_at: string;
    closed_at: string | null;
    status: string;
    cashier_id: string | null;
    cashier_name: string;
    opening_float: number;
    closing_float: number | null;
    expected_cash: number;
    cash_variance: number | null;
    notes: string | null;
  };
  byMethod: { method: string; amount: number; orders: number }[];
  totals: {
    orderCount: number;
    grossSales: number;
    voidCount: number;
    cashSales: number;
    floatIn: number;
    floatOut: number;
    expectedCash: number;
  };
  businessName: string;
  currency: string;
}

function sessionInfo() {
  const db = getLocalDb();
  const session = db.prepare(`SELECT business_id, business_name, currency FROM session WHERE id=1`).get() as any;
  if (!session) throw new Error('Not signed in');
  const staff = db.prepare(`SELECT staff_id, staff_name, branch_id FROM staff_session WHERE id=1`).get() as any;
  return { session, staff };
}

// Open a shift for the active cashier. Rejects if one is already open (mirrors
// the server's 409 guard).
/**
 * How long a shift may stay open before it is treated as forgotten.
 *
 * 18 hours, not 24: a shift opened at 08:00 and never closed is stale by 02:00
 * the following night, before the next day's opening cashier arrives to find
 * their sales landing on yesterday's reconciliation.
 */
const STALE_SHIFT_HOURS = 18;

export interface StaleShift {
  id: string;
  opened_at: string;
  hoursOpen: number;
  cashier_name: string;
  expectedCash: number;
  orders: number;
}

/**
 * Is a shift sitting open past the point of plausibility?
 *
 * Deliberately does NOT close it. Closing a shift records a COUNTED drawer, and
 * a count nobody made is not a reconciliation — it is a fabricated one, which is
 * worse than none because it looks fine. An open shift is visibly wrong; a fake
 * close is invisibly wrong, and the variance it reports as zero is the number
 * somebody will later rely on.
 *
 * So this reports, and a human decides. Either the drawer is counted late, or a
 * manager forces it closed and the record says plainly that nobody counted.
 */
export function getStaleShift(): StaleShift | null {
  const shift = getOpenShift();
  if (!shift) return null;

  const hoursOpen = (Date.now() - new Date(shift.opened_at).getTime()) / 3_600_000;
  if (hoursOpen < STALE_SHIFT_HOURS) return null;

  const z = computeZReport(shift.id);
  return {
    id: shift.id,
    opened_at: shift.opened_at,
    hoursOpen: Math.floor(hoursOpen),
    cashier_name: z.shift.cashier_name,
    expectedCash: z.totals.expectedCash,
    orders: z.totals.orderCount ?? 0,
  };
}

export function openShift(opening_float = 0, drawerLabel?: string | null): any {
  // Phase 3: an office machine has no drawer to open. Refused in MAIN, not
  // just hidden in the renderer — a hidden button is a suggestion, this is
  // the rule.
  if (!canSell(getDeviceConfig()?.device_role)) {
    throw new Error('This machine is a branch office/server — it has no cash drawer and cannot open a shift.');
  }
  const db = getLocalDb();

  // The trading-day gate first: a till whose previous day was never closed may
  // not start a new drawer, and only a manager can clear it. Checked before the
  // open-shift check so the message names the real obstacle rather than sending
  // the cashier to close a shift that is not the problem.
  const gate = checkStaleDay();
  if (!gate.canTrade) throw new Error(gate.reason ?? 'This till cannot trade yet');

  const existing = getOpenShift();
  if (existing) {
    // Name the obstacle. "A shift is already open" sent the next cashier looking
    // for a settings screen; whose shift it is and how old tells them what to do.
    const hours = Math.floor((Date.now() - new Date(existing.opened_at).getTime()) / 3_600_000);
    // `users`, not `staff` — there is no local staff table. This sat in the
    // "a shift is already open" path, so it would have thrown instead of showing
    // the message explaining which cashier to go and find.
    const who = (getLocalDb().prepare(`SELECT name FROM users WHERE id=?`).get(existing.cashier_id) as any)?.name;
    throw new Error(
      hours >= STALE_SHIFT_HOURS
        ? `${who ?? 'A cashier'}'s shift has been open ${hours} hours and must be closed before a new one starts.`
        : `A shift opened by ${who ?? 'another cashier'} is already running. Close it first.`,
    );
  }

  const { session, staff } = sessionInfo();
  if (!staff?.staff_id) throw new Error('No cashier — sign in with a PIN first');

  // Opens today's day if this is the first drawer of the date.
  const day = ensureDayOpen(staff.staff_id);

  const cfg = getDeviceConfig();
  const id = uuid();
  const now = new Date().toISOString();

  // opening_float is COUNTED at open and never carried over from the previous
  // shift on this till. Sites move physical drawers between terminals and we get
  // no say in it, so inferring cash from where a drawer sits would silently
  // poison the reconciliation the first time one moved.
  db.prepare(`
    INSERT INTO shifts (id, business_id, branch_id, cashier_id, opened_at, status, opening_float,
                        created_at, sync_status, business_day_id, business_date,
                        device_id, terminal_code, drawer_label, opened_by)
    VALUES (?, ?, ?, ?, ?, 'open', ?, ?, 'pending', ?, ?, ?, ?, ?, ?)
  `).run(id, session.business_id, staff.branch_id, staff.staff_id, now,
         Number(opening_float) || 0, now, day.id, day.business_date,
         cfg?.device_id ?? null, cfg?.terminal_code ?? null,
         drawerLabel?.trim() || null, staff.staff_id);

  return db.prepare(`SELECT * FROM shifts WHERE id=?`).get(id);
}

// Record a float_in / float_out movement on the open shift.
export function addFloat(type: 'float_in' | 'float_out', amount: number, reason?: string): any {
  const db = getLocalDb();
  if (type !== 'float_in' && type !== 'float_out') throw new Error('type must be float_in or float_out');
  if (!(Number(amount) > 0)) throw new Error('amount must be greater than zero');

  const shift = getOpenShift();
  if (!shift) throw new Error('No open shift');

  const id = uuid();
  const now = new Date().toISOString();
  // device_id is what makes this row THIS terminal's. Without it the row is
  // NULL-attributed, and "mine" is COALESCE(device_id,'') = COALESCE(own,'') —
  // so on any till that has been assigned a device_id, a NULL-attributed float
  // matches nothing and is never collected by the push. Drawer movements would
  // simply stop reaching the server, and the shift's expected cash would be
  // wrong by exactly the floats nobody could see.
  db.prepare(`
    INSERT INTO float_transactions (id, shift_id, branch_id, cashier_id, type, amount, reason, created_at, device_id, sync_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
  `).run(id, shift.id, shift.branch_id, shift.cashier_id, type, Number(amount), reason ?? null, now,
         getDeviceConfig()?.device_id ?? null);

  return db.prepare(`SELECT * FROM float_transactions WHERE id=?`).get(id);
}

// Compute the Z-report for a shift (open = live preview, closed = final figures).
export function computeZReport(shiftId: string): ZReport {
  const db = getLocalDb();
  const { session, staff } = sessionInfo();

  const shift = db.prepare(`SELECT * FROM shifts WHERE id=?`).get(shiftId) as any;
  if (!shift) throw new Error('Shift not found');

  // Cashier name: prefer the synced users table, fall back to the active staff
  // session name, finally a generic label (offline before users were pulled).
  const userRow = db.prepare(`SELECT name FROM users WHERE id=?`).get(shift.cashier_id) as any;
  const cashierName =
    userRow?.name ??
    (staff?.staff_id === shift.cashier_id ? staff?.staff_name : null) ??
    'Cashier';

  // Sales by payment method for this shift (voided orders excluded).
  const byMethod = db.prepare(`
    SELECT p.method AS method,
           COALESCE(SUM(p.amount), 0) AS amount,
           COUNT(DISTINCT o.id) AS orders
    FROM payments p
    JOIN orders o ON o.id = p.order_id
    WHERE o.shift_id = ? AND o.status != 'voided'
    GROUP BY p.method
  `).all(shiftId) as { method: string; amount: number; orders: number }[];

  const cashSales = byMethod.find(m => m.method === 'cash')?.amount ?? 0;

  const floats = db.prepare(`
    SELECT type, COALESCE(SUM(amount), 0) AS amt FROM float_transactions WHERE shift_id=? GROUP BY type
  `).all(shiftId) as { type: string; amt: number }[];
  const floatIn  = floats.find(f => f.type === 'float_in')?.amt  ?? 0;
  const floatOut = floats.find(f => f.type === 'float_out')?.amt ?? 0;

  const agg = db.prepare(`
    SELECT COUNT(*) AS orderCount, COALESCE(SUM(total), 0) AS grossSales
    FROM orders WHERE shift_id=? AND status != 'voided'
  `).get(shiftId) as { orderCount: number; grossSales: number };

  const voids = db.prepare(`
    SELECT COUNT(*) AS c FROM orders WHERE shift_id=? AND status='voided'
  `).get(shiftId) as { c: number };

  // Expenses PAID OUT OF THIS DRAWER.
  //
  // This was missing, and it made honesty look like theft. expense:create writes
  // only to `expenses` — it records no float_out — so cash left the drawer while
  // expected_cash did not move. A cashier who paid 500 for gas and recorded it
  // properly counted 500 short at close and was reported as 500 down, while one
  // who took the money and said nothing produced the identical variance. The
  // control actively punished the person doing the right thing.
  //
  // Fixed HERE rather than by making expense:create also write a float_out, for
  // two reasons: one place computes the truth, and a cashier who records both an
  // expense and a matching pay-out would otherwise be debited twice.
  const expensesOut = (db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS amt FROM expenses WHERE shift_id = ?
  `).get(shiftId) as { amt: number } | undefined)?.amt ?? 0;

  const expectedCash =
    Number(shift.opening_float) + cashSales + floatIn - floatOut - Number(expensesOut);

  return {
    shift: {
      id: shift.id,
      opened_at: shift.opened_at,
      closed_at: shift.closed_at ?? null,
      status: shift.status,
      cashier_id: shift.cashier_id,
      cashier_name: cashierName,
      opening_float: Number(shift.opening_float),
      closing_float: shift.closing_float ?? null,
      // For a closed shift use the stored expected_cash; for an open one show live.
      expected_cash: shift.status === 'closed' && shift.expected_cash != null
        ? Number(shift.expected_cash)
        : expectedCash,
      cash_variance: shift.cash_variance ?? null,
      notes: shift.notes ?? null,
    },
    byMethod,
    totals: {
      orderCount: agg.orderCount,
      grossSales: Number(agg.grossSales),
      voidCount: voids.c,
      cashSales,
      floatIn,
      floatOut,
      expectedCash,
    },
    businessName: session.business_name,
    currency: session.currency ?? 'KES',
  };
}

// Close the open shift with a counted cash amount. Mirrors the server: requires
// a note when the count doesn't match expected cash.
export function closeShift(closing_float: number, notes?: string): ZReport {
  const db = getLocalDb();
  const shift = getOpenShift();
  if (!shift) throw new Error('No open shift to close');
  if (closing_float === undefined || closing_float === null) throw new Error('closing_float is required');

  const pre = computeZReport(shift.id);
  const expectedCash = pre.totals.expectedCash;
  const variance = Number(closing_float) - expectedCash;

  if (Math.round(variance * 100) !== 0 && !(notes && notes.trim())) {
    const err: any = new Error('A note is required to close a shift with a cash variance');
    err.variance = variance;
    err.expected_cash = expectedCash;
    throw err;
  }

  const now = new Date().toISOString();
  db.prepare(`
    UPDATE shifts SET
      status='closed', closed_at=?, closing_float=?, expected_cash=?, cash_variance=?,
      notes=?, close_method='counted', closed_by=?, sync_status='pending'
    WHERE id=?
  `).run(now, Number(closing_float), expectedCash, variance, notes ?? null,
         sessionInfo().staff?.staff_id ?? null, shift.id);
  // Phase 2b: the close is a fact other tills need — without it, every replica
  // of this drawer stays 'open' forever (the staleness the Close Branch screen
  // currently papers over with live polling).
  emitEvent('shift_closed', shift.id, {
    status: 'closed', closed_at: now, closing_float: Number(closing_float),
    expected_cash: expectedCash, cash_variance: variance, notes: notes ?? null,
    close_method: 'counted', closed_by: sessionInfo().staff?.staff_id ?? null,
  });

  return computeZReport(shift.id);
}

// Current open shift enriched with its live Z-report, or null if none open.
/**
 * Ends a shift nobody closed, without inventing a cash count.
 *
 * The distinction from closeShift() is the whole point:
 *
 *   closeShift()       a human counted the drawer. closing_float is real,
 *                      cash_variance is meaningful, status 'closed'.
 *   forceCloseShift()  nobody counted. closing_float and cash_variance are
 *                      NULL — not zero — and the status is
 *                      'closed_unreconciled'.
 *
 * NULL rather than 0 matters more than it looks. A zero variance is a claim:
 * "we checked, and it balanced". Writing that when nobody looked corrupts every
 * report built on it, and it corrupts them invisibly — the number is there, it
 * looks fine, and it is a lie somebody will act on. NULL says "unknown", which
 * is the truth, and it makes the row impossible to average away.
 *
 * Requires a manager, and requires a reason. If a till is closed out without a
 * count, the record should say who decided that and why.
 */
export function forceCloseShift(reason: string, closedByStaffId?: string | null): ZReport {
  const db = getLocalDb();
  const shift = getOpenShift();
  if (!shift) throw new Error('No open shift to close');
  if (!reason || !reason.trim()) throw new Error('A reason is required to close a shift without counting the drawer');

  const pre = computeZReport(shift.id);
  const now = new Date().toISOString();
  const hours = Math.floor((Date.now() - new Date(shift.opened_at).getTime()) / 3_600_000);

  db.prepare(`
    UPDATE shifts SET
      status='closed_unreconciled', closed_at=?,
      closing_float=NULL, cash_variance=NULL, expected_cash=?,
      notes=?, close_method='forced', closed_by=?, sync_status='pending'
    WHERE id=?
  `).run(
    now,
    pre.totals.expectedCash,
    `FORCED CLOSE after ${hours}h without a drawer count — ${reason.trim()}`,
    closedByStaffId ?? sessionInfo().staff?.staff_id ?? null,
    shift.id,
  );
  // Phase 2b: a forced close replicates as what it is — closed_unreconciled,
  // no closing float — so a replica never dresses it up as a counted drawer.
  emitEvent('shift_closed', shift.id, {
    status: 'closed_unreconciled', closed_at: now,
    closing_float: null, cash_variance: null, expected_cash: pre.totals.expectedCash,
    notes: `FORCED CLOSE after ${hours}h without a drawer count — ${reason.trim()}`,
    close_method: 'forced',
    closed_by: closedByStaffId ?? sessionInfo().staff?.staff_id ?? null,
  });

  return computeZReport(shift.id);
}

export function currentShiftReport(): ZReport | null {
  const shift = getOpenShift();
  if (!shift) return null;
  return computeZReport(shift.id);
}
