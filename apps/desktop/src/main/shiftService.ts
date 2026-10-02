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
import { getDeviceConfig, canSell, getPosFeatures } from './deviceConfig';
import { checkStaleDay, ensureDayOpen } from './dayService';
import { v4 as uuid } from 'uuid';
import { refundedSql, vatKeptSql, ctlKeptSql, money2 } from './orderMoney';
import { nonCashExpenses, expenseLabel } from './expenseMethod';
import { reasonsNeeded, cleanReasons, missingReasons } from './confirmReasons';
import { kitchenVoidsForShift, type KitchenVoidLine } from './kitchenService';
import type { KitchenVoidSummary } from './kitchenLines';

/**
 * A334 (2026-09-26): cash on a SHARED drawer that this till does not hold — sales, floats and
 * expenses rung on the web POS standing in for this till (the cloud's POST /api/shifts/:id/foreign-cash,
 * same arithmetic as its own close). Owner: the till's close INCLUDES them. Added to the till's own
 * figures; never replaces them, so offline the till still closes on what it knows.
 */
export interface ForeignCash {
  orders: number; cash_sales: number; float_in: number; float_out: number; expenses: number;
  /** A342: OTHER shifts open on this same till (the web standing in as it). The till's count covers them: their expected
   *  cash is added to this drawer's, and the cloud closes them with this close. Absent from an older cloud. */
  siblings?: { count: number; expected: number; shifts?: Array<{ id: string; opened_by_name: string | null; opened_at: string | null; expected: number }> } | null;
}

/** The order / float / expense ids this till holds for a shift — what it tells the cloud it already knows. */
export function localShiftIds(shiftId: string): { order_ids: string[]; float_ids: string[]; expense_ids: string[] } {
  const db = getLocalDb();
  const col = (sql: string) => (db.prepare(sql).all(shiftId) as { id: string }[]).map((r) => r.id);
  return {
    order_ids:   col(`SELECT id FROM orders WHERE shift_id=?`),
    float_ids:   col(`SELECT id FROM float_transactions WHERE shift_id=?`),
    expense_ids: col(`SELECT id FROM expenses WHERE shift_id=?`),
  };
}

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
    /** A349: refunded on this shift's orders (already out of the drawer as negative payment rows), sales kept, the
     *  taxes on them (reduced by any refund — the cloud's rule), whether CTL is levied, and tips (in the payments, not
     *  revenue). Optional so an older caller or a stored report still renders. */
    refunds?: number;
    netSales?: number;
    vat?: number;
    ctl?: number;
    ctlLevied?: boolean;
    tips?: number;
    voidCount: number;
    cashSales: number;
    floatIn: number;
    floatOut: number;
    expectedCash: number;
    /** A334: cash rung on this drawer from another surface (the web POS) — already inside the figures above.
     *  null = not asked (offline / no answer): the figures are this till's own only. */
    foreign?: ForeignCash | null;
    /** Cross-sync stage 1: the web POS's sales on this drawer that are DOWNLOADED onto the till (orders.origin 'web') —
     *  already inside every figure above, like this till's own; reported so the panel can still say what the web rang. */
    webSales?: { orders: number; cash_sales: number };
    /** 0.6.11: cash PAID OUT of this drawer as expenses — already taken off expectedCash; shown so the
     *  reconciliation adds up on paper (float + sales + in − out − expenses = expected). Includes the web's. */
    expenses: number;
    /** 0.6.27: expenses paid by another method (M-Pesa…), per method — NOT out of the drawer; they come off that
     *  method's expected total. This till's own. */
    expensesByMethod?: Record<string, number>;
    /** 0.6.27: delivery fees customers paid on top of their bills (in the payments, not sales), and the part of
     *  floatOut that paid riders their fees in cash (this till's own pay-outs, net of any put back by a void). */
    deliveryFees?: number;
    riderPayouts?: number;
    /** 0.6.27: pay-ins that put a voided delivery's fee back (inside floatIn; shown with the riders' line). */
    riderReturned?: number;
  };
  /** 0.6.11: this till's expense lines on the shift (newest last), for the report's EXPENSES section.
   *  0.6.27: `label` is what the report prints — the expense TYPE first, then the description, then the method when
   *  not cash; `payment_method` how it was paid. */
  expenseLines: { description: string; amount: number; created_at: string; paid_by_name: string | null;
                  label?: string; category_name?: string | null; payment_method?: string }[];
  /** A363 (owner: "add the note on the zreport"): what of this shift is not yet on the cloud — its sales still queued
   *  or failed, and whether the cloud refused the drawer itself. Optional so an older caller or a stored report renders. */
  notBackedUp?: { sales: number; drawerRefused: boolean };
  /** 0.6.28: items taken back after they were sent to the kitchen on this shift — the lines and their sums. Optional
   *  so an older caller or a stored report still renders. */
  kitchenVoids?: { summary: KitchenVoidSummary; lines: KitchenVoidLine[] };
  /** A365: the manager's confirmation — awaiting, or who/when/self and the per-method lines. null = closed before A365. */
  confirmation?: {
    status: 'awaiting' | 'confirmed';
    confirmed_by_name?: string | null; confirmed_at?: string; self?: boolean;
    /** 0.6.23: awaiting — what the manager recounts (names only). */
    methods?: string[];
    lines: { method: string; declared: number | null; expected: number | null; confirmed: number | null; variance: number | null; mismatch: boolean }[];
  } | null;
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
export function computeZReport(shiftId: string, foreign: ForeignCash | null = null): ZReport {
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

  const f = foreign;   // A334: the web's part of a shared drawer, added to this till's own
  const cashSales = (byMethod.find(m => m.method === 'cash')?.amount ?? 0) + (f ? Number(f.cash_sales) : 0);

  const floats = db.prepare(`
    SELECT type, COALESCE(SUM(amount), 0) AS amt FROM float_transactions WHERE shift_id=? GROUP BY type
  `).all(shiftId) as { type: string; amt: number }[];
  const floatIn  = (floats.find(x => x.type === 'float_in')?.amt  ?? 0) + (f ? Number(f.float_in) : 0);
  const floatOut = (floats.find(x => x.type === 'float_out')?.amt ?? 0) + (f ? Number(f.float_out) : 0);

  // A349: refunds, the taxes (reduced by the refunded share — the cloud's rule) and tips, so the Z-report states the
  // shift's money in full. Cash reconciliation is unchanged: refunds already leave the drawer as negative payment rows.
  const agg = db.prepare(`
    SELECT COUNT(*) AS orderCount, COALESCE(SUM(total), 0) AS grossSales,
           COALESCE(SUM(${refundedSql()}), 0) AS refunds,
           COALESCE(SUM(${vatKeptSql()}), 0) AS vat,
           COALESCE(SUM(${ctlKeptSql()}), 0) AS ctl,
           COALESCE(SUM(COALESCE(tip_amount, 0)), 0) AS tips
    FROM orders WHERE shift_id=? AND status != 'voided'
  `).get(shiftId) as { orderCount: number; grossSales: number; refunds: number; vat: number; ctl: number; tips: number };

  const voids = db.prepare(`
    SELECT COUNT(*) AS c FROM orders WHERE shift_id=? AND status='voided'
  `).get(shiftId) as { c: number };

  // 0.6.27: delivery fees (pass-through) and what the drawer paid riders — why cash is lower and M-Pesa higher.
  const deliveryFees = (db.prepare(`
    SELECT COALESCE(SUM(COALESCE(delivery_fee, 0)), 0) AS n FROM orders WHERE shift_id=? AND status != 'voided'
  `).get(shiftId) as { n: number }).n;
  const rider = db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN type='float_out' THEN amount ELSE 0 END), 0) AS paid,
           COALESCE(SUM(CASE WHEN type='float_in'  THEN amount ELSE 0 END), 0) AS back
      FROM float_transactions WHERE shift_id=? AND order_id IS NOT NULL
  `).get(shiftId) as { paid: number; back: number };

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
  // 0.6.27: only a CASH expense leaves the drawer (NULL = recorded before 59 = cash); one paid by M-Pesa comes off
  // M-Pesa's expected total instead (expectedMethods). The web's (f.expenses) is cash only — the cloud's rule.
  const expensesOut = ((db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS amt FROM expenses
     WHERE shift_id = ? AND COALESCE(NULLIF(LOWER(TRIM(payment_method)), ''), 'cash') = 'cash'
  `).get(shiftId) as { amt: number } | undefined)?.amt ?? 0) + (f ? Number(f.expenses) : 0);
  const expensesByMethod = nonCashExpenses(db.prepare(
    `SELECT amount, payment_method FROM expenses WHERE shift_id = ?`).all(shiftId) as { amount: number; payment_method: string | null }[]);

  // A342: the web's own shift on this till, counted in the same drawer (owner: "Till's count covers both").
  const siblingExpected = f?.siblings ? Number(f.siblings.expected) || 0 : 0;
  const expectedCash =
    Number(shift.opening_float) + cashSales + floatIn - floatOut - Number(expensesOut) + siblingExpected;

  // 0.6.11: the lines behind expensesOut (this till's own; a web expense is in the total via `foreign`).
  // 0.6.27 (request 9): the report shows the expense TYPE, not only the description.
  const methodNames = new Map((db.prepare(`SELECT code, name FROM payment_methods`).all() as { code: string; name: string }[])
    .map((m) => [String(m.code).toLowerCase(), m.name]));
  const expenseLines = (db.prepare(`
    SELECT e.description, e.amount, e.created_at, u.name AS paid_by_name, e.expense_type_name AS category_name,
           COALESCE(NULLIF(LOWER(TRIM(e.payment_method)), ''), 'cash') AS payment_method
      FROM expenses e LEFT JOIN users u ON u.id = e.paid_by
     WHERE e.shift_id = ? ORDER BY e.created_at
  `).all(shiftId) as { description: string; amount: number; created_at: string; paid_by_name: string | null;
                       category_name: string | null; payment_method: string }[])
    .map((x) => ({ ...x, amount: Number(x.amount),
                   label: expenseLabel(x.category_name, x.description, x.payment_method, methodNames.get(x.payment_method) ?? null) }));

  // A363: what of this shift has not reached the cloud yet — shown on the report so a close never hides it.
  const notBackedUp = {
    sales: (db.prepare(`
      SELECT COUNT(*) AS n FROM sync_queue q JOIN orders o ON o.id = q.order_id
       WHERE o.shift_id = ? AND q.status IN ('pending', 'failed')
    `).get(shiftId) as { n: number }).n,
    drawerRefused: shift.sync_status === 'conflict',
  };

  // Cross-sync stage 1: the web's sales held on the till (downloaded) — already in the sums above.
  const webHeld = db.prepare(`
    SELECT COUNT(DISTINCT o.id) AS orders,
           COALESCE(SUM(CASE WHEN p.method = 'cash' THEN p.amount ELSE 0 END), 0) AS cash_sales
      FROM orders o LEFT JOIN payments p ON p.order_id = o.id
     WHERE o.shift_id = ? AND o.origin = 'web' AND o.status != 'voided'
  `).get(shiftId) as { orders: number; cash_sales: number };

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
    notBackedUp,
    confirmation: shift.status === 'open' ? null : shiftConfirmation(shift),
    totals: {
      orderCount: agg.orderCount + (f ? Number(f.orders) : 0),
      grossSales: Number(agg.grossSales),
      // A349 (this till's own orders, and web sales already downloaded onto it).
      refunds:    money2(Number(agg.refunds)),
      netSales:   money2(Number(agg.grossSales) - Number(agg.refunds)),
      vat:        money2(Number(agg.vat)),
      ctl:        money2(Number(agg.ctl)),
      ctlLevied:  Number(getDeviceConfig()?.ctl_rate ?? 0) > 0 || Number(agg.ctl) > 0,
      tips:       money2(Number(agg.tips)),
      voidCount: voids.c,
      cashSales,
      floatIn,
      floatOut,
      expectedCash,
      foreign: f,
      webSales: webHeld,
      expenses: Number(expensesOut),
      expensesByMethod,
      deliveryFees: money2(Number(deliveryFees)),
      riderPayouts: money2(Number(rider.paid)),
      riderReturned: money2(Number(rider.back)),
    },
    expenseLines,
    kitchenVoids: kitchenVoidsForShift(shiftId),   // 0.6.28
    businessName: session.business_name,
    currency: session.currency ?? 'KES',
  };
}

// Close the open shift with a counted cash amount. Mirrors the server: requires
// a note when the count doesn't match expected cash.
/**
 * A366 (0.6.24) — who may close a shift. Owner, 2026-09-30: "only the shift owner can close the shift not any other
 * cashier, maybe the manager should be able to close it". The cashier who opened it (cashier_id / opened_by), or a
 * manager (the same rule that may confirm a shift). Another cashier signed in on the till may sell, pay in/out and record
 * expenses on the drawer, but not count it out.
 */
export function shiftCloseRights(shift: { cashier_id?: string | null; opened_by?: string | null } | null):
  { allowed: boolean; ownerName: string | null } {
  if (!shift) return { allowed: false, ownerName: null };
  const db = getLocalDb();
  const ownerId = shift.cashier_id ?? shift.opened_by ?? null;
  const ownerName = ownerId ? ((db.prepare(`SELECT name FROM users WHERE id=?`).get(ownerId) as { name?: string } | undefined)?.name ?? null) : null;
  const st = db.prepare(`SELECT staff_id, staff_name, role_name, permissions FROM staff_session WHERE id=1`).get() as
    { staff_id: string; staff_name: string; role_name: string | null; permissions: string | null } | undefined;
  if (!st?.staff_id) return { allowed: false, ownerName };
  const isOwner = st.staff_id === shift.cashier_id || st.staff_id === shift.opened_by;
  return { allowed: isOwner || isShiftManager(st.role_name, st.permissions), ownerName: ownerName ?? (isOwner ? st.staff_name : null) };
}

/**
 * 0.6.27 — what the signed-in person's History shows (prospect's requests 6 and 7, per client in the admin portal):
 * 'cashier_own_history' → a cashier sees only the sales they rang; 'cashier_no_reprint' → a cashier has no Reprint in
 * History. A manager (the shift-manager rule) always sees every sale and may reprint. Nobody signed in → own-only
 * with nobody to match, i.e. nothing, when the switch is on.
 */
export interface HistoryScope { staffId: string | null; manager: boolean; ownOnly: boolean; canReprint: boolean }
/** The signed-in person, and whether they are a manager for shift purposes (isShiftManager). */
function signedIn(): { staffId: string | null; manager: boolean } {
  const st = getLocalDb().prepare(`SELECT staff_id, role_name, permissions FROM staff_session WHERE id=1`).get() as
    { staff_id: string | null; role_name: string | null; permissions: string | null } | undefined;
  return { staffId: st?.staff_id ?? null, manager: !!st?.staff_id && isShiftManager(st.role_name, st.permissions) };
}
export function historyScope(): HistoryScope {
  const f = getPosFeatures();
  const { staffId, manager } = signedIn();
  return {
    staffId,
    manager,
    ownOnly: f.cashier_own_history && !manager,
    canReprint: !(f.cashier_no_reprint && !manager),
  };
}

/**
 * 0.6.27 (the prospect's request 1): 'blind_shift_close' — a CASHIER closing a shift does not see the amount sold, the
 * per-method totals or expected cash; only a box for each method used. A manager closing sees everything. The close
 * then needs no variance note from the cashier (they cannot see one); the manager explains it at confirmation.
 */
export function blindClose(): boolean {
  return getPosFeatures().blind_shift_close && !signedIn().manager;
}

/**
 * The report a blind close may show: who, when, which methods to count, the cashier's own expenses and the manager's
 * confirmation status — every sales and cash figure taken out (not merely hidden on the screen).
 */
export function blindReport(z: ZReport): ZReport & { blind: true; declareMethods: string[] } {
  const declareMethods = [...new Set(z.byMethod
    .filter((m) => String(m.method).toLowerCase() !== 'cash' && Math.round(Number(m.amount) * 100) !== 0)
    .map((m) => String(m.method).toLowerCase()))].sort((a, b) => a.localeCompare(b));
  const zero = (n: unknown) => (n == null ? n : 0);
  return {
    ...z,
    blind: true,
    declareMethods,
    shift: { ...z.shift, expected_cash: 0, cash_variance: null },
    byMethod: z.byMethod.map((m) => ({ ...m, amount: 0, orders: 0 })),
    totals: {
      ...z.totals,
      orderCount: 0, grossSales: 0, refunds: zero(z.totals.refunds) as number, netSales: zero(z.totals.netSales) as number,
      vat: zero(z.totals.vat) as number, ctl: zero(z.totals.ctl) as number, tips: zero(z.totals.tips) as number,
      cashSales: 0, expectedCash: 0, foreign: z.totals.foreign ? { ...z.totals.foreign, orders: 0, cash_sales: 0 } : z.totals.foreign,
      webSales: z.totals.webSales ? { orders: 0, cash_sales: 0 } : z.totals.webSales,
      deliveryFees: zero(z.totals.deliveryFees) as number,
    },
    confirmation: z.confirmation ? { ...z.confirmation, lines: z.confirmation.lines.map((l) => ({ ...l, expected: null, variance: null })) } : z.confirmation,
  };
}

/** A manager for shift purposes (close someone else's shift, confirm a shift) — the cloud's mayConfirm rule. */
export function isShiftManager(roleName: string | null | undefined, permissionsJson: string | Record<string, unknown> | null | undefined): boolean {
  if (['owner', 'admin', 'manager', 'supervisor', 'branch_manager'].includes(String(roleName ?? '').toLowerCase())) return true;
  let p: Record<string, unknown> = {};
  try { p = typeof permissionsJson === 'string' ? JSON.parse(permissionsJson || '{}') : (permissionsJson ?? {}); } catch { p = {}; }
  return p['*'] === true || p['orders.void'] === true || p['shifts.manage'] === true || p['settings.manage'] === true;
}

export function closeShift(closing_float: number, notes?: string, foreign: ForeignCash | null = null,
                           declared: Record<string, number> | null = null): ZReport {
  const db = getLocalDb();
  const shift = getOpenShift();
  if (!shift) throw new Error('No open shift to close');
  // A366: only the cashier who opened it, or a manager.
  const rights = shiftCloseRights(shift);
  if (!rights.allowed) {
    const err: any = new Error(`Only ${rights.ownerName ?? 'the cashier who opened this shift'} or a manager can close this shift.`);
    err.code = 'SHIFT_NOT_YOURS';
    throw err;
  }
  if (closing_float === undefined || closing_float === null) throw new Error('closing_float is required');

  const pre = computeZReport(shift.id, foreign);   // A334: a shared drawer's web cash included
  const expectedCash = pre.totals.expectedCash;
  const variance = Number(closing_float) - expectedCash;

  // 0.6.27: not on a blind close — the cashier cannot see the variance; the manager explains it at confirmation.
  if (Math.round(variance * 100) !== 0 && !(notes && notes.trim()) && !blindClose()) {
    const err: any = new Error('A note is required to close a shift with a cash variance');
    err.variance = variance;
    err.expected_cash = expectedCash;
    throw err;
  }

  // A365: the cashier declares every method; cash is always the counted drawer. The shift then awaits a manager.
  const declaredMap = declared ? { ...(cleanMethods(declared) ?? {}), cash: money2(Number(closing_float)) } : null;

  const now = new Date().toISOString();
  db.prepare(`
    UPDATE shifts SET
      status='closed', closed_at=?, closing_float=?, expected_cash=?, cash_variance=?,
      notes=?, close_method='counted', closed_by=?, sync_status='pending', declared_methods=?
    WHERE id=?
  `).run(now, Number(closing_float), expectedCash, variance, notes ?? null,
         sessionInfo().staff?.staff_id ?? null, declaredMap ? JSON.stringify(declaredMap) : null, shift.id);
  // Phase 2b: the close is a fact other tills need — without it, every replica
  // of this drawer stays 'open' forever (the staleness the Close Branch screen
  // currently papers over with live polling).
  emitEvent('shift_closed', shift.id, {
    status: 'closed', closed_at: now, closing_float: Number(closing_float),
    expected_cash: expectedCash, cash_variance: variance, notes: notes ?? null,
    close_method: 'counted', closed_by: sessionInfo().staff?.staff_id ?? null,
  });

  return computeZReport(shift.id, foreign);
}

// ── A365 (2026-09-29): a manager confirms every shift, on every payment method ────────────────────────────────────
//
// Owner: "the managers should confirm shift before closing the day … it should block … They should recount incase the
// cashier submitted less than the amount … on all payment method not just mpesa"; a manager's own shift: "allowed,
// flagged". The cashier declares every method at End Shift (closeShift above); a manager recounts every method BLIND,
// now or later, with their PIN (verified by the caller — ipcHandlers shift:confirm). The till's figures are kept; the
// confirmation reaches the cloud through POST /api/shifts/:id/confirm (syncEngine pushShiftConfirmations).

export type MethodMap = Record<string, number>;

/** A clean method map (codes trimmed + lower-case, amounts ≥ 0 to the cent), or null. Same rule as the cloud's. */
export function cleanMethods(input: unknown): MethodMap | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const out: MethodMap = {};
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length === 0 || entries.length > 30) return null;
  for (const [k, v] of entries) {
    const code = String(k).trim().toLowerCase();
    const n = Number(v);
    if (!code || code.length > 40 || v === null || v === '' || !Number.isFinite(n) || n < 0) return null;
    out[code] = money2(n);
  }
  return out;
}

const parseMap = (json: string | null | undefined): MethodMap | null => {
  if (!json) return null;
  try { return cleanMethods(JSON.parse(json)); } catch { return null; }
};

export interface ConfirmLine {
  method: string; declared: number | null; expected: number | null; confirmed: number | null;
  variance: number | null; mismatch: boolean;
  /** 0.6.27: the manager's reason where their count differs from the cashier's. */
  reason?: string | null;
}

/** One line per method: cash first. variance = confirmed − expected; mismatch = the recount differs from the declaration. */
export function confirmLines(declared: MethodMap | null, expected: MethodMap | null, confirmed: MethodMap | null,
                             reasons: Record<string, string> | null = null): ConfirmLine[] {
  const codes = new Set<string>([...Object.keys(declared ?? {}), ...Object.keys(expected ?? {}), ...Object.keys(confirmed ?? {})]);
  return [...codes].sort((a, b) => (a === 'cash' ? -1 : b === 'cash' ? 1 : a.localeCompare(b))).map((m) => {
    const d = declared ? (declared[m] ?? 0) : null;
    const e = expected ? (expected[m] ?? 0) : null;
    const c = confirmed ? (confirmed[m] ?? 0) : null;
    return { method: m, declared: d, expected: e, confirmed: c,
      variance: c !== null && e !== null ? money2(c - e) : null,
      mismatch: d !== null && c !== null && Math.round(d * 100) !== Math.round(c * 100),
      ...(reasons?.[m] ? { reason: reasons[m] } : {}) };
  });
}

/** What this till recorded per method on a closed shift: cash = the stored expected cash; the rest from its payments. */
export function expectedMethods(shiftId: string): MethodMap {
  const db = getLocalDb();
  const shift = db.prepare(`SELECT expected_cash FROM shifts WHERE id=?`).get(shiftId) as { expected_cash: number | null } | undefined;
  const rows = db.prepare(`
    SELECT p.method AS method, COALESCE(SUM(p.amount), 0) AS amount
      FROM payments p JOIN orders o ON o.id = p.order_id
     WHERE o.shift_id = ? AND o.status != 'voided'
     GROUP BY p.method
  `).all(shiftId) as { method: string; amount: number }[];
  const out: MethodMap = {};
  for (const r of rows) {
    const m = String(r.method ?? '').trim().toLowerCase();
    if (m && m !== 'cash') out[m] = money2((out[m] ?? 0) + Number(r.amount));
  }
  // 0.6.27: an expense paid by M-Pesa (or another method) comes off that method's expected total — the statement shows
  // the money going out. (A cash expense is already inside expected cash.)
  const spent = nonCashExpenses(db.prepare(`SELECT amount, payment_method FROM expenses WHERE shift_id = ?`).all(shiftId) as
    { amount: number; payment_method: string | null }[]);
  for (const [m, v] of Object.entries(spent)) out[m] = money2((out[m] ?? 0) - v);
  out.cash = money2(Number(shift?.expected_cash ?? computeZReport(shiftId).totals.expectedCash));
  return out;
}

export interface AwaitingShift {
  id: string; cashier_id: string | null; cashier_name: string; opened_at: string; closed_at: string | null;
  business_day_id: string | null; methods: string[];
}

/**
 * This till's shifts awaiting a manager: closed with a declaration (A365), not yet confirmed. Shifts closed before
 * A365 (no declaration) and force-closed ones never wait. `dayId` narrows to one trading day.
 */
export function awaitingConfirmation(dayId?: string | null): AwaitingShift[] {
  const db = getLocalDb();
  const rows = db.prepare(`
    SELECT s.id, s.cashier_id, s.opened_at, s.closed_at, s.business_day_id, s.declared_methods,
           COALESCE(u.name, 'Cashier') AS cashier_name
      FROM shifts s LEFT JOIN users u ON u.id = s.cashier_id
     -- own: a manager confirms the drawers THIS till holds.
     WHERE s.status = 'closed' AND s.declared_methods IS NOT NULL AND s.confirmed_at IS NULL
       AND COALESCE(s.device_id,'') = COALESCE(?,'')
       AND (? IS NULL OR s.business_day_id = ?)
     ORDER BY s.closed_at ASC
  `).all(getDeviceConfig()?.device_id ?? null, dayId ?? null, dayId ?? null) as any[];
  return rows.map((r) => ({
    id: r.id, cashier_id: r.cashier_id, cashier_name: r.cashier_name, opened_at: r.opened_at, closed_at: r.closed_at,
    business_day_id: r.business_day_id, methods: methodsToCount(r.id, parseMap(r.declared_methods)),
  }));
}

/**
 * What a manager recounts on a shift: cash, every method the cashier declared money on, and every method this till
 * recorded money on (0.6.23 — owner: a method at 0 does not appear). Names only; the recount stays blind.
 */
export function methodsToCount(shiftId: string, declared: MethodMap | null): string[] {
  const set = new Set<string>();
  for (const [m, v] of Object.entries(declared ?? {})) if (m !== 'cash' && Math.round(v * 100) !== 0) set.add(m);
  for (const [m, v] of Object.entries(expectedMethods(shiftId))) if (m !== 'cash' && Math.round(v * 100) !== 0) set.add(m);
  return ['cash', ...[...set].sort((a, b) => a.localeCompare(b))];
}

export interface Confirmation {
  shift_id: string; confirmed_by: string; confirmed_by_name: string | null; confirmed_at: string; self: boolean;
  lines: ConfirmLine[];
}

/**
 * Record a manager's blind recount of a closed shift. `confirmer` is the person whose PIN the caller verified and
 * whose right to confirm it checked. Refuses: an open shift, another till's shift, a second confirmation, a recount
 * missing any declared method.
 */
export function confirmShift(shiftId: string, confirmer: { id: string; name: string | null }, counts: unknown,
                             reasonsIn: unknown = null): Confirmation {
  const db = getLocalDb();
  const shift = db.prepare(`SELECT * FROM shifts WHERE id=?`).get(shiftId) as any;
  if (!shift || (shift.device_id ?? '') !== (getDeviceConfig()?.device_id ?? '')) throw new Error('Shift not found on this till');
  if (shift.status === 'open') throw new Error('The cashier has not closed this shift yet.');
  if (shift.confirmed_at) throw new Error('This shift is already confirmed.');
  const given = cleanMethods(counts);
  if (!given) throw new Error('Enter the counted amount for every payment method.');
  const declared = parseMap(shift.declared_methods);
  // 0.6.23: the manager counts what was shown (cash + methods with money on them); a declared method not shown is 0.
  const missing = methodsToCount(shiftId, declared).filter((m) => !(m in given)).sort();
  if (missing.length) throw new Error(`Enter the counted amount for: ${missing.join(', ')}.`);
  const recount: MethodMap = { ...Object.fromEntries(Object.keys(declared ?? {}).map((m) => [m, 0])), ...given };
  // 0.6.27: with 'confirm_shows_cashier_figures', every method counted differently from the cashier needs a reason.
  const needed = reasonsNeeded(declared, recount);
  const reasons = cleanReasons(reasonsIn, needed);
  if (getPosFeatures().confirm_shows_cashier_figures) {
    const missing = missingReasons(needed, reasons);
    if (missing.length) throw new Error(`Give a reason where your count differs from the cashier's: ${missing.join(', ')}.`);
  }

  const expected = expectedMethods(shiftId);
  const self = confirmer.id === shift.cashier_id || confirmer.id === shift.opened_by;
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE shifts SET confirmed_methods=?, expected_methods=?, confirmed_by=?, confirmed_at=?, confirm_self=?,
                      confirm_reasons=?, confirm_sync='pending'
     WHERE id=? AND confirmed_at IS NULL
  `).run(JSON.stringify(recount), JSON.stringify(expected), confirmer.id, now, self ? 1 : 0,
         reasons ? JSON.stringify(reasons) : null, shiftId);
  return { shift_id: shiftId, confirmed_by: confirmer.id, confirmed_by_name: confirmer.name, confirmed_at: now, self,
           lines: confirmLines(declared, expected, recount, reasons) };
}

/** The Z-report's confirmation block: awaiting, confirmed (who, when, self, lines), or null (closed before A365). */
export function shiftConfirmation(shift: any): ZReport['confirmation'] {
  const declared = parseMap(shift.declared_methods);
  if (!declared && !shift.confirmed_at) return null;
  if (!shift.confirmed_at) return { status: 'awaiting', methods: methodsToCount(shift.id, declared), lines: confirmLines(declared, null, null) };
  const who = shift.confirmed_by
    ? (getLocalDb().prepare(`SELECT name FROM users WHERE id=?`).get(shift.confirmed_by) as { name?: string } | undefined)?.name ?? null
    : null;
  return {
    status: 'confirmed', confirmed_by_name: who, confirmed_at: shift.confirmed_at, self: !!shift.confirm_self,
    lines: confirmLines(declared, parseMap(shift.expected_methods), parseMap(shift.confirmed_methods), parseReasons(shift.confirm_reasons)),
  };
}

/** 0.6.27: stored reasons ({"cash": "…"}), or null. */
function parseReasons(json: string | null | undefined): Record<string, string> | null {
  if (!json) return null;
  try { const v = JSON.parse(json); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { return null; }
}

/**
 * 0.6.27: what the confirm screen may show. With 'confirm_shows_cashier_figures' the manager sees the cashier's figure
 * per method (and must give a reason where their count differs); without it the recount stays blind (A365).
 */
export function confirmView(shiftId: string): { showCashier: boolean; declared: MethodMap | null } {
  const showCashier = getPosFeatures().confirm_shows_cashier_figures;
  if (!showCashier) return { showCashier: false, declared: null };
  const row = getLocalDb().prepare(`SELECT declared_methods FROM shifts WHERE id=?`).get(shiftId) as { declared_methods: string | null } | undefined;
  return { showCashier: true, declared: parseMap(row?.declared_methods ?? null) };
}

/**
 * A334 (2026-09-26): take a drawer the web POS opened AS THIS TILL into the local database, so the
 * till sells into it instead of offering to open a second one — which the cloud refuses on sync
 * (duplicate_open_shift: one open drawer per terminal, migration 63). Called at an ONLINE sign-in with
 * the cloud's GET /api/shifts/current for this till.
 *
 * Same id as the cloud row (no second drawer), attached to THIS till's trading day (ensureDayOpen),
 * and left 'pending' so the next push records that day on the cloud row — the push only ever writes
 * open-shift fields and never reopens a closed one (routes/sync.ts). Nothing is adopted when this till
 * already has an open drawer, the cloud shift is another terminal's or not open, this machine cannot
 * sell, or its previous day is still unclosed (the day gate owns that screen).
 *
 * Returns the adopted row, or null.
 */
export function adoptCloudShift(cloud: any): any | null {
  if (!cloud || cloud.status !== 'open' || !cloud.id) return null;
  const cfg = getDeviceConfig();
  if (!cfg?.device_id || cloud.device_id !== cfg.device_id) return null;
  if (!canSell(cfg.device_role)) return null;
  if (getOpenShift()) return null;
  const db = getLocalDb();
  if (db.prepare(`SELECT 1 FROM shifts WHERE id=?`).get(cloud.id)) return null;   // known here already (e.g. closed locally)
  if (!checkStaleDay().canTrade) return null;

  const { session, staff } = sessionInfo();
  if (!staff?.staff_id) return null;
  const day = ensureDayOpen(staff.staff_id);
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO shifts (id, business_id, branch_id, cashier_id, opened_at, status, opening_float,
                        created_at, sync_status, business_day_id, business_date,
                        device_id, terminal_code, drawer_label, opened_by)
    VALUES (?, ?, ?, ?, ?, 'open', ?, ?, 'pending', ?, ?, ?, ?, ?, ?)
  `).run(cloud.id, session.business_id, cloud.branch_id ?? staff.branch_id,
         cloud.cashier_id ?? cloud.opened_by ?? staff.staff_id, cloud.opened_at ?? now,
         Number(cloud.opening_float) || 0, now, day.id, day.business_date,
         cfg.device_id, cfg.terminal_code ?? cloud.terminal_code ?? null,
         cloud.drawer_label ?? null, cloud.opened_by ?? cloud.cashier_id ?? null);
  return db.prepare(`SELECT * FROM shifts WHERE id=?`).get(cloud.id);
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

export function currentShiftReport(foreign: ForeignCash | null = null): ZReport | null {
  const shift = getOpenShift();
  if (!shift) return null;
  return computeZReport(shift.id, foreign);
}

/** 0.6.11: one row per shift for the "previous shift reports" list. */
export interface ShiftSummary {
  id: string; status: string; opened_at: string; closed_at: string | null;
  cashier_name: string | null; expected_cash: number | null; cash_variance: number | null;
}

/**
 * This till's shifts, newest first — the open one (if any) and the closed ones, so a manager can reopen and
 * print a past Z-report. Owner (2026-09-27): "I should be able to print previous shift reports".
 */
export function listShifts(limit = 60): ShiftSummary[] {
  const db = getLocalDb();
  return db.prepare(`
    SELECT s.id, s.status, s.opened_at, s.closed_at, u.name AS cashier_name, s.expected_cash, s.cash_variance
      FROM shifts s LEFT JOIN users u ON u.id = s.cashier_id
     -- own: a till reprints the drawers IT ran; a peer's shifts are that till's to report.
     WHERE COALESCE(s.device_id,'') = COALESCE(?,'')
     ORDER BY s.opened_at DESC
     LIMIT ?
  `).all(getDeviceConfig()?.device_id ?? null, Math.max(1, Math.min(500, Math.floor(limit)))) as ShiftSummary[];
}

/** 0.6.11: expenses paid out on this till in a date range — the manager's Expenses screen. */
export interface ExpenseRow {
  id: string; description: string; amount: number; created_at: string; shift_id: string | null;
  paid_by_name: string | null; expense_category_id: string | null; sync_status: string;
}
export function listExpenses(from: string, to: string): { rows: ExpenseRow[]; total: number } {
  const db = getLocalDb();
  const rows = (db.prepare(`
    SELECT e.id, e.description, e.amount, e.created_at, e.shift_id, u.name AS paid_by_name,
           e.expense_category_id, e.sync_status
      FROM expenses e LEFT JOIN users u ON u.id = e.paid_by
     -- own: the cash this till's drawers paid out; another till's expenses are on its own screen.
     WHERE COALESCE(e.device_id,'') = COALESCE(?,'')
       AND e.created_at >= ? AND e.created_at <= ?
     ORDER BY e.created_at DESC
  `).all(getDeviceConfig()?.device_id ?? null, from, to) as ExpenseRow[]).map((r) => ({ ...r, amount: Number(r.amount) }));
  return { rows, total: rows.reduce((a, r) => a + r.amount, 0) };
}
