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

import { getLocalDb } from './localDb';
import { getOpenShift } from './syncEngine';
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
export function openShift(opening_float = 0): any {
  const db = getLocalDb();
  const existing = getOpenShift();
  if (existing) throw new Error('A shift is already open');

  const { session, staff } = sessionInfo();
  if (!staff?.staff_id) throw new Error('No cashier — sign in with a PIN first');

  const id = uuid();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO shifts (id, business_id, branch_id, cashier_id, opened_at, status, opening_float, created_at, sync_status)
    VALUES (?, ?, ?, ?, ?, 'open', ?, ?, 'pending')
  `).run(id, session.business_id, staff.branch_id, staff.staff_id, now, Number(opening_float) || 0, now);

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
  db.prepare(`
    INSERT INTO float_transactions (id, shift_id, branch_id, cashier_id, type, amount, reason, created_at, sync_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')
  `).run(id, shift.id, shift.branch_id, shift.cashier_id, type, Number(amount), reason ?? null, now);

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

  const expectedCash = Number(shift.opening_float) + cashSales + floatIn - floatOut;

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
      notes=?, sync_status='pending'
    WHERE id=?
  `).run(now, Number(closing_float), expectedCash, variance, notes ?? null, shift.id);

  return computeZReport(shift.id);
}

// Current open shift enriched with its live Z-report, or null if none open.
export function currentShiftReport(): ZReport | null {
  const shift = getOpenShift();
  if (!shift) return null;
  return computeZReport(shift.id);
}
