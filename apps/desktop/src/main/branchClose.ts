// branchClose.ts — Phase 4: central day close
// ─────────────────────────────────────────────────────────────────────────────
// One screen on the branch server closes every till's trading day. The design
// constraints, in order of importance:
//
//   1. Each till still OWNS its trading day. This is orchestration, not a
//      change of ownership: the node asks, the till closes itself. Node down →
//      every till closes at the till exactly as before.
//   2. PULL, never push. Peers run no server. The node queues an instruction;
//      the peer collects it on a short poll and acks the outcome. A till that
//      never acks is LISTED as unreachable — the screen closes what it can and
//      names what it could not, it never pretends.
//   3. The till is the cash authority. Counted cash is entered centrally (it is
//      the MANAGER'S count — the cashier's blind count already happened at each
//      shift close), but expected cash and variance are computed by the till
//      itself and returned in the ack. The node never does cash arithmetic on
//      its replicated copies, because those go stale after close (append-only;
//      updates are not re-offered until Phase 2 replicates mutations as events).
//   4. Idempotent execution. Instructions are re-offered until ACKED, so a peer
//      that crashes between collecting and executing gets the instruction
//      again — and a day it already closed acks success rather than failing or,
//      worse, double-closing.

import { randomUUID } from 'crypto';
import { getLocalDb } from './localDb';
import { getDeviceConfig } from './deviceConfig';
import {
  closeDayInstructed, getOpenDay, getDayCloseSummary, businessDateNow,
} from './dayService';
import { getOpenShift } from './syncEngine';
import { listPeers, forgetDeviceKey } from './nodeIngest';
import { computeZReport, expectedMethods, methodsToCount, confirmShift, type Confirmation } from './shiftService';   // A452
import { addFloatToShift, recordExpense, ownOpenShift } from './shiftService';   // A465
import { getPosFeatures } from './deviceConfig';   // A452

// ── Shared shapes ────────────────────────────────────────────────────────────

export interface CloseDayPayload {
  business_date: string;      // the branch server's trading date (A452: the server's date is final — an older open day closes too)
  /** The manager's count for THIS till; null (A452, Close Branch) = the day's confirmed shift counts — no second count. */
  counted_cash: number | null;
  notes?: string;
  closed_by_staff_id?: string | null;
  closed_by_name?: string | null;
}

export interface PeerDayState {
  business_date: string | null;   // open day on the till, if any
  day_open: boolean;
  open_drawer: { cashier_name: string | null } | null;
  drawers_on_day: number;
  cashiers_counted_total: number;
  app_version?: string;
  /** A452: the till's shifts of its open day (and the open one) — what the Close Branch screen shows and confirms.
   *  Absent from a till on an older build (the screen asks for its update). */
  shifts?: PeerShift[];
  /** A452: the till's own clock when it reported — the screen warns when it is off from the server's. */
  clock?: string;
  /** A465: the till's name and code (T1…) so the server's lists can name it. Absent from an older till. */
  terminal?: { code?: string | null; name?: string | null };
}

/** A452: one shift as its till reports it — its own books, never the server's replicated copies. */
export interface PeerShift {
  id: string;
  cashier_name: string;
  opened_at: string;
  closed_at: string | null;
  /** open · awaiting (closed, waiting for a manager) · confirmed · closed (nothing to confirm: force-closed, older) */
  state: 'open' | 'awaiting' | 'confirmed' | 'closed';
  orders: number;
  sales: number;
  /** Sales by payment method. */
  by_method: Record<string, number>;
  /** What the till expects per method (cash: float + cash sales ± floats − cash expenses). */
  expected: Record<string, number>;
  /** The methods a manager counts (cash first). */
  methods: string[];
  /** The cashier's own count — only when the owner shows it to managers ('confirm_shows_cashier_figures'). */
  declared: Record<string, number> | null;
  cash: { opening_float: number; cash_sales: number; float_in: number; float_out: number; expenses: number };
  confirmed?: { by_name: string | null; at: string; counted: Record<string, number> | null } | null;
}

/** A452: the shifts this till reports — the open day's, and the open drawer (never throws; a bad row is left out). */
export function ownShifts(): PeerShift[] {
  const db = getLocalDb();
  const day = getOpenDay();
  const own = getDeviceConfig()?.device_id ?? null;
  const rows = db.prepare(`
    SELECT s.id, s.status, s.opened_at, s.closed_at, s.declared_methods, s.confirmed_at, s.confirmed_methods,
           COALESCE(cu.name, s.confirmed_by) AS confirmed_by_name
      FROM shifts s LEFT JOIN users cu ON cu.id = s.confirmed_by
     -- own: the drawers THIS till holds (the server asks each till for its own).
     WHERE COALESCE(s.device_id,'') = COALESCE(?,'')
       AND (s.status = 'open' OR (? IS NOT NULL AND s.business_day_id = ?))
     ORDER BY s.opened_at
  `).all(own, day?.id ?? null, day?.id ?? null) as any[];
  const parse = (j: string | null) => { try { const v = j ? JSON.parse(j) : null; return v && typeof v === 'object' ? v as Record<string, number> : null; } catch { return null; } };
  const showCashier = getPosFeatures().confirm_shows_cashier_figures;
  const out: PeerShift[] = [];
  for (const r of rows) {
    try {
      const z = computeZReport(r.id);
      const declared = parse(r.declared_methods);
      const byMethod: Record<string, number> = {};
      for (const m of z.byMethod) byMethod[String(m.method).toLowerCase()] = (byMethod[String(m.method).toLowerCase()] ?? 0) + Number(m.amount || 0);
      const expected = r.status === 'open' ? { ...expectedMethods(r.id), cash: z.totals.expectedCash } : expectedMethods(r.id);
      out.push({
        id: r.id, cashier_name: z.shift.cashier_name, opened_at: r.opened_at, closed_at: r.closed_at,
        state: r.status === 'open' ? 'open' : r.confirmed_at ? 'confirmed' : declared ? 'awaiting' : 'closed',
        orders: z.totals.orderCount, sales: z.totals.grossSales, by_method: byMethod, expected,
        methods: methodsToCount(r.id, declared), declared: showCashier ? declared : null,
        cash: { opening_float: Number(z.shift.opening_float || 0), cash_sales: z.totals.cashSales, float_in: z.totals.floatIn,
          float_out: z.totals.floatOut, expenses: Number((z.totals as any).expenses ?? 0) },
        confirmed: r.confirmed_at ? { by_name: r.confirmed_by_name ?? null, at: r.confirmed_at, counted: parse(r.confirmed_methods) } : null,
      });
    } catch { /* a shift the report cannot read is left out, never the whole state */ }
  }
  return out;
}

/** A452: the cash of the day's shifts as the managers confirmed them (the cashier's count where none was confirmed). */
export function confirmedDayCash(): number {
  const day = getOpenDay();
  if (!day) return 0;
  const r = getLocalDb().prepare(`
    SELECT COALESCE(SUM(COALESCE(CAST(json_extract(confirmed_methods, '$.cash') AS REAL), closing_float, 0)), 0) AS n
      FROM shifts
     -- own: this till's drawers of its open day.
     WHERE business_day_id = ? AND status = 'closed' AND COALESCE(device_id,'') = COALESCE(?,'')
  `).get(day.id, getDeviceConfig()?.device_id ?? null) as { n: number };
  return Math.round(Number(r?.n ?? 0) * 100) / 100;
}

/** A452: the instruction to confirm one of this till's shifts — a manager on the branch server counted it. */
export interface ConfirmShiftPayload {
  shift_id: string;
  counts: Record<string, number>;
  reasons?: Record<string, string> | null;
  confirmer: { id: string; name: string | null };
}

/** A452: confirm one of this till's shifts as the branch server's manager asked. Never throws (the ack carries why). */
export function executeConfirmShift(payload: ConfirmShiftPayload): { ok: boolean; error?: string; summary?: Confirmation; already?: boolean } {
  try {
    const row = getLocalDb().prepare(`SELECT confirmed_at FROM shifts WHERE id = ? AND COALESCE(device_id,'') = COALESCE(?,'')`)
      .get(payload.shift_id, getDeviceConfig()?.device_id ?? null) as { confirmed_at: string | null } | undefined;
    if (row?.confirmed_at) return { ok: true, already: true };   // asked again after it was done: the state asked for exists
    const c = confirmShift(payload.shift_id, payload.confirmer, payload.counts, payload.reasons ?? null);
    return { ok: true, summary: c };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Could not confirm the shift on this till' };
  }
}

// ── Peer side: report own state, execute instructions ────────────────────────

/** What this till tells the node about itself on every instruction poll. */
export function ownDayState(): PeerDayState {
  const db = getLocalDb();
  const day = getOpenDay();
  const shift = getOpenShift();
  const summary = day ? getDayCloseSummary() : null;
  // shifts carries cashier_id, not a name — names live in users, pulled from
  // the server (same reasoning as getConflictedShifts, same join).
  let drawerName: string | null = null;
  if (shift?.cashier_id) {
    const u = db.prepare(`SELECT name FROM users WHERE id = ?`).get(shift.cashier_id) as { name?: string } | undefined;
    drawerName = u?.name ?? null;
  }
  return {
    business_date: day?.business_date ?? null,
    day_open: !!day,
    open_drawer: shift ? { cashier_name: drawerName } : null,
    drawers_on_day: summary?.shifts ?? 0,
    cashiers_counted_total: summary?.countedCash ?? 0,
    shifts: ownShifts(),              // A452
    clock: new Date().toISOString(),  // A452
    terminal: { code: getDeviceConfig()?.terminal_code ?? null, name: getDeviceConfig()?.device_name ?? null },   // A465
  };
}

// ── A465: cash in / out and expenses on any running shift, from the branch server ─────────────────────────────────────
// Owner, 2026-10-13: a manager on the branch server records a cash in, cash out or expense against ANY running shift of
// the branch. The server never writes the row: it queues an instruction and the till that holds the drawer records it
// in its OWN books (its device id) — so its Z-report, its push to the cloud and Close Branch all agree.

export interface ShiftMoneyPayload {
  /** The row's id, minted on the server: the instruction delivered twice records once. */
  row_id: string;
  shift_id: string;
  kind: 'float_in' | 'float_out' | 'expense';
  amount: number;
  reason?: string | null;
  description?: string | null;
  expense_category_id?: string | null;
  category_name?: string | null;
  payment_method?: string | null;
  approver: { id: string; name: string | null };
  recorded_by?: { id: string; name: string | null } | null;
}

export const SHIFT_MONEY_CLOSED = 'That shift is closed on this till — record it on the shift now open';

/** A465: record a server manager's cash in / out or expense on one of this till's open shifts. Never throws. */
export function executeShiftMoney(payload: ShiftMoneyPayload):
  { ok: boolean; error?: string; already?: boolean; summary?: { kind: string; amount: number; shift_id: string; expected_cash: number } } {
  try {
    const db = getLocalDb();
    const p = payload ?? ({} as ShiftMoneyPayload);
    if (!p.row_id || !p.shift_id) return { ok: false, error: 'The instruction is incomplete' };
    const had = db.prepare(`SELECT 1 FROM float_transactions WHERE id = ? UNION ALL SELECT 1 FROM expenses WHERE id = ?`).get(p.row_id, p.row_id);
    if (had) return { ok: true, already: true };   // delivered again after it was recorded
    if (p.kind !== 'float_in' && p.kind !== 'float_out' && p.kind !== 'expense') return { ok: false, error: `Unknown kind '${String(p.kind)}'` };
    const amount = Number(p.amount);
    if (!(amount > 0) || !Number.isFinite(amount)) return { ok: false, error: 'The amount must be more than zero' };
    if (!p.approver?.id) return { ok: false, error: 'No manager approved it' };
    if (!ownOpenShift(p.shift_id)) return { ok: false, error: SHIFT_MONEY_CLOSED };
    if (p.kind === 'expense') {
      const description = String(p.description ?? '').trim();
      if (!description) return { ok: false, error: 'An expense needs a description' };
      recordExpense({
        shiftId: p.shift_id, rowId: p.row_id, description, amount,
        expense_category_id: p.expense_category_id ?? null, category_name: p.category_name ?? null,
        payment_method: p.payment_method ?? 'cash', paid_by: p.recorded_by?.id ?? p.approver.id, approver: p.approver,
      });
    } else {
      addFloatToShift(p.shift_id, p.kind, amount, p.reason ?? null, p.approver, p.row_id);
    }
    const expected = computeZReport(p.shift_id).totals.expectedCash;
    return { ok: true, summary: { kind: p.kind, amount, shift_id: p.shift_id, expected_cash: expected } };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Could not record it on this till' };
  }
}

/** A465: queue one cash in / out or expense for a till (each row its own instruction — others pending are kept). */
export function createShiftMoneyInstruction(deviceId: string, payload: ShiftMoneyPayload, createdByStaffId: string | null): { id: number } {
  ensureInstructionUid();
  const r = getLocalDb().prepare(`INSERT INTO node_instructions (device_id, kind, payload, created_by, created_at, uid) VALUES (?, 'shift_money', ?, ?, ?, ?)`)
    .run(deviceId, JSON.stringify(payload), createdByStaffId, new Date().toISOString(), randomUUID());
  return { id: Number(r.lastInsertRowid) };
}

/** A465: withdraw a shift_money instruction the till has not picked up yet. True when one was removed. Once delivered the
 *  till may already have recorded it (its ack can lag) — withdrawing then would say "cancelled" for money on the books. */
export function cancelShiftMoneyInstruction(id: number): boolean {
  const r = getLocalDb().prepare(`DELETE FROM node_instructions WHERE id = ? AND kind = 'shift_money' AND status = 'pending' AND delivered_at IS NULL`).run(Number(id));
  return r.changes > 0;
}

/**
 * Execute a close_day instruction on this till. Never throws — the ack is the
 * error channel, because the manager standing at the node screen is the person
 * who can act on the reason, and a throw here would only reach a log nobody is
 * watching at 22:00.
 */
export function executeCloseDay(payload: CloseDayPayload):
  { ok: boolean; error?: string; summary?: unknown; already_closed?: boolean } {
  try {
    const day = getOpenDay();

    // Idempotency first: no open day, and the requested date is today-or-past →
    // a previous delivery (or a manager at the till) already closed it. That is
    // success, not failure — the state the instruction asked for exists.
    if (!day) {
      return { ok: true, already_closed: true };
    }
    // F11 (2026-10-14): a close for an EARLIER date than the day now open is stale — that day was closed and a new
    // one opened since (the instruction came round again, or waited in a till that was off). It used to close
    // whatever day was open: today's, mid-service. The state it asked for exists.
    if (payload?.business_date && day.business_date > payload.business_date) {
      return { ok: true, already_closed: true };
    }

    // A452 (owner, 2026-10-12: "when a branch is closed all tills reset to a new day and the server time is the final
    // time"): the server's close closes the day this till has open — yesterday's left open too (it used to refuse:
    // "This till's open trading day is 2026-10-11, not 2026-10-12. Check the clocks…"). The note says which day it was.
    const lateNote = day.business_date !== payload.business_date
      ? `Trading day ${day.business_date} closed with the branch's ${payload.business_date}.` : '';
    const notes = [payload.notes?.trim(), lateNote].filter(Boolean).join('\n') || undefined;
    // A452: no second count at Close Branch — the day's cash is what the managers confirmed shift by shift.
    const counted = payload.counted_cash === null || payload.counted_cash === undefined ? confirmedDayCash() : Number(payload.counted_cash);

    const summary = closeDayInstructed(
      counted,
      notes,
      payload.closed_by_staff_id ?? null,
      payload.closed_by_name ?? null,
    );
    return { ok: true, summary: { ...summary, closedDate: day.business_date } };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Could not close the day on this till' };
  }
}

// ── Node side: instruction lifecycle ─────────────────────────────────────────

/** A452: queue a shift confirmation for one peer (one live instruction per shift — a second replaces the first).
 *  P3 (2026-10-14): only one the till has NOT collected yet is replaced. One it already collected may be on its books
 *  (its ack can lag); replacing it would send a second, different count for the same shift — refused instead. */
export const CONFIRM_IN_FLIGHT = 'The till has already taken an earlier confirmation of this shift — wait for its answer (about 15 seconds).';
export function createConfirmInstruction(deviceId: string, payload: ConfirmShiftPayload, createdByStaffId: string | null): { id: number } {
  ensureInstructionUid();
  const db = getLocalDb();
  const inFlight = db.prepare(`SELECT id FROM node_instructions
               WHERE device_id = ? AND kind = 'confirm_shift' AND status = 'pending' AND delivered_at IS NOT NULL
                 AND json_extract(payload, '$.shift_id') = ?`).get(deviceId, payload.shift_id);
  if (inFlight) throw new Error(CONFIRM_IN_FLIGHT);
  db.prepare(`DELETE FROM node_instructions
               WHERE device_id = ? AND kind = 'confirm_shift' AND status = 'pending' AND delivered_at IS NULL
                 AND json_extract(payload, '$.shift_id') = ?`)
    .run(deviceId, payload.shift_id);
  const r = db.prepare(`INSERT INTO node_instructions (device_id, kind, payload, created_by, created_at, uid) VALUES (?, 'confirm_shift', ?, ?, ?, ?)`)
    .run(deviceId, JSON.stringify(payload), createdByStaffId, new Date().toISOString(), randomUUID());
  return { id: Number(r.lastInsertRowid) };
}

/** Queue a close for one peer. One live instruction per peer per day. */
export function createCloseInstruction(
  deviceId: string, payload: CloseDayPayload, createdByStaffId: string | null,
): { id: number } {
  ensureInstructionUid();
  const db = getLocalDb();

  // Replace any still-pending close for this peer rather than stacking them:
  // two pending instructions with two different counted amounts is a question
  // with two answers, and the peer would execute whichever it saw first.
  db.prepare(`DELETE FROM node_instructions
               WHERE device_id = ? AND kind = 'close_day' AND status = 'pending'`)
    .run(deviceId);

  const r = db.prepare(`
    INSERT INTO node_instructions (device_id, kind, payload, created_by, created_at, uid)
    VALUES (?, 'close_day', ?, ?, ?, ?)
  `).run(deviceId, JSON.stringify(payload), createdByStaffId, new Date().toISOString(), randomUUID());
  return { id: Number(r.lastInsertRowid) };
}

// ── F12: instruction uids (node-local column) ────────────────────────────────
// node_instructions.id is an AUTOINCREMENT integer, and a reinstalled server starts again at 1 — so a till holding an
// unacked "instruction 3" from the old server acked the NEW server's instruction 3, which may be another till's or
// another kind. Each instruction now also carries a random uid; a till acks by uid and its own device id. Added on
// first use (ALTER … ADD COLUMN, idempotent), like node_state: a server-only column, nothing replicated or pushed.
const uidReady = new WeakSet<object>();
export function ensureInstructionUid(): void {
  const db = getLocalDb();
  if (uidReady.has(db)) return;
  const cols = db.prepare(`PRAGMA table_info(node_instructions)`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'uid')) db.exec(`ALTER TABLE node_instructions ADD COLUMN uid TEXT`);
  db.exec(`CREATE INDEX IF NOT EXISTS node_instructions_uid_idx ON node_instructions (uid)`);
  uidReady.add(db);
}

/** F11: an instruction not answered within a day is withdrawn — a close or a count from yesterday is not today's. */
export const INSTRUCTION_TTL_MS = 24 * 3_600_000;

/**
 * Instructions a polling peer should act on. Marks delivered_at (visibility for
 * the manager screen) but keeps status 'pending' — only an ack retires it.
 */
export function collectInstructions(deviceId: string, nowMs: number = Date.now()): Array<{ id: number; uid: string | null; kind: string; payload: any }> {
  ensureInstructionUid();
  const db = getLocalDb();
  const now = new Date(nowMs).toISOString();
  // F11: older than a day and still unanswered → expired, never handed out again (the screen shows it as such).
  db.prepare(`UPDATE node_instructions SET status = 'expired', acked_at = ?, ack = ?
               WHERE device_id = ? AND status = 'pending' AND created_at < ?`)
    .run(now, JSON.stringify({ ok: false, error: 'Not answered within 24 hours — withdrawn' }), deviceId,
      new Date(nowMs - INSTRUCTION_TTL_MS).toISOString());
  const rows = db.prepare(`
    SELECT id, uid, kind, payload FROM node_instructions
     WHERE device_id = ? AND status = 'pending'
     ORDER BY id
  `).all(deviceId) as Array<{ id: number; uid: string | null; kind: string; payload: string }>;
  if (rows.length) {
    const mark = db.prepare(`UPDATE node_instructions SET delivered_at = COALESCE(delivered_at, ?), uid = COALESCE(uid, ?) WHERE id = ?`);
    for (const r of rows) { if (!r.uid) r.uid = randomUUID(); mark.run(now, r.uid, r.id); }
  }
  const out: Array<{ id: number; uid: string | null; kind: string; payload: any }> = [];
  for (const r of rows) {
    try { out.push({ id: r.id, uid: r.uid, kind: r.kind, payload: JSON.parse(r.payload) }); } catch { /* unreadable: left for the screen */ }
  }
  return out;
}

/**
 * A peer's verdict on an instruction.
 * F12: matched by uid when the till sends one, and always to the device that sends it when it says which — an ack can
 * no longer retire another till's instruction. A till on an older build sends only the number (matched as before).
 * Returns whether an instruction was retired.
 */
export function recordAck(instructionId: number | null, ack: { ok: boolean; error?: string; summary?: unknown },
  match: { deviceId?: string | null; uid?: string | null } = {}): boolean {
  ensureInstructionUid();
  const db = getLocalDb();
  const set = [ack.ok ? 'acked' : 'failed', JSON.stringify(ack), new Date().toISOString()];
  const dev = match.deviceId ? String(match.deviceId) : null;
  if (match.uid) {
    return db.prepare(`UPDATE node_instructions SET status = ?, ack = ?, acked_at = ?
                        WHERE uid = ? AND status = 'pending' AND (? IS NULL OR device_id = ?)`)
      .run(...set, String(match.uid), dev, dev).changes > 0;
  }
  if (!Number.isInteger(instructionId)) return false;
  return db.prepare(`UPDATE node_instructions SET status = ?, ack = ?, acked_at = ?
                      WHERE id = ? AND status = 'pending' AND (? IS NULL OR device_id = ?)`)
    .run(...set, instructionId, dev, dev).changes > 0;
}

/** P3: instructions answered (or withdrawn) more than `days` ago go. Returns how many. */
export function pruneNodeInstructions(days = 7): number {
  ensureInstructionUid();
  const cutoff = new Date(Date.now() - Math.max(1, days) * 86_400_000).toISOString();
  return getLocalDb().prepare(`DELETE FROM node_instructions
                                WHERE status IN ('acked', 'failed', 'expired') AND COALESCE(acked_at, created_at) < ?`).run(cutoff).changes;
}

// ── F4: tills the server no longer hears from ────────────────────────────────
// Close Branch listed every device ever seen (peer_cursors and node_peer_state are never pruned), and refused to close
// while any of them had not reported in two minutes — a till replaced last month blocked tonight's close for good.
// Now: a till not heard from in 7 days drops off the list; a manager can "Forget this till" at once; and a till whose
// last word was "my day is closed" never blocks a close. Forgetting keeps the replicated history (peer_cursors) —
// that is the branch's data — and drops only what the screen shows, its pending instructions and its device key.

export const TILL_AGE_OUT_MS = 7 * 86_400_000;

/** SQLite's datetime('now') ("2026-10-14 09:00:00", UTC) or an ISO stamp, as epoch ms. NaN when unreadable. */
function stampMs(s: string | null | undefined): number {
  if (!s) return NaN;
  const t = String(s);
  return Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(t) ? `${t.replace(' ', 'T')}Z` : t);
}

/** The manager's "Forget this till". Never the server itself. Returns whether there was anything to forget. */
export function forgetTill(deviceId: string): boolean {
  const id = String(deviceId ?? '');
  const own = getDeviceConfig()?.device_id ?? '';
  if (!id || id === own) return false;
  const db = getLocalDb();
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare(`INSERT OR REPLACE INTO maintenance_state (key, value, updated_at) VALUES (?, ?, ?)`).run(`forgotten_till:${id}`, now, now);
    db.prepare(`DELETE FROM node_peer_state WHERE device_id = ?`).run(id);
    db.prepare(`UPDATE node_instructions SET status = 'expired', acked_at = ?, ack = ? WHERE device_id = ? AND status = 'pending'`)
      .run(now, JSON.stringify({ ok: false, error: 'The till was forgotten on the branch server' }), id);
  })();
  try { forgetDeviceKey(id); } catch { /* no key table yet */ }
  return true;
}

/** Remember what a peer last said about itself, and when. */
export function recordPeerState(deviceId: string, state: unknown): void {
  const db = getLocalDb();
  db.prepare(`
    INSERT INTO node_peer_state (device_id, state, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(device_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at
  `).run(deviceId, JSON.stringify(state), new Date().toISOString());
}

// ── A458: the day's totals for the whole branch, by payment method ───────────
// Owner, 2026-10-12: "under close then close branch can we remove all the tills and maybe add fields which the manager
// confirms all payment method and they close rather than closing one till at a time" — and: "per shift remains, each
// shift has to be confirmed; the manager should do summation of each till and close using that as the total sales of
// the day". So: every shift is still confirmed on its own (its till records it); Close Branch adds them up per method
// from what each till REPORTED (its own books, never the server's replicated copies) and the manager confirms those
// totals before the branch closes.

export interface BranchMethodLine {
  method: string;
  /** Sales taken with this method, every shift of the day. */
  sales: number;
  /** What the tills expect for this method, every shift (cash: float + cash sales ± floats − cash expenses). */
  expected: number;
  /** The managers' confirmed counts, confirmed shifts only. */
  confirmed: number;
  /** Confirmed − expected, over the confirmed shifts (+ over, − short). */
  variance: number;
}
export interface BranchTotals {
  methods: BranchMethodLine[];
  total: Omit<BranchMethodLine, 'method'>;
  orders: number;
  shifts: { all: number; open: number; awaiting: number; confirmed: number; uncounted: number };
}

const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

/** A458: the day's totals per payment method over the shifts the tills reported. Cash first, then by name. */
export function branchMethodTotals(shifts: PeerShift[]): BranchTotals {
  const lines = new Map<string, BranchMethodLine>();
  const line = (m: string) => {
    let l = lines.get(m);
    if (!l) { l = { method: m, sales: 0, expected: 0, confirmed: 0, variance: 0 }; lines.set(m, l); }
    return l;
  };
  const count = { all: 0, open: 0, awaiting: 0, confirmed: 0, uncounted: 0 };
  let orders = 0;
  for (const s of shifts) {
    count.all++;
    orders += Number(s.orders) || 0;
    if (s.state === 'open') count.open++;
    else if (s.state === 'awaiting') count.awaiting++;
    else if (s.state === 'confirmed') count.confirmed++;
    else count.uncounted++;
    for (const [m, v] of Object.entries(s.by_method ?? {})) line(m).sales += Number(v) || 0;
    for (const [m, v] of Object.entries(s.expected ?? {})) line(m).expected += Number(v) || 0;
    const counted = s.state === 'confirmed' ? s.confirmed?.counted ?? null : null;
    if (counted) {
      const methods = new Set([...Object.keys(counted), ...Object.keys(s.expected ?? {})]);
      for (const m of methods) {
        const c = Number(counted[m] ?? 0) || 0;
        line(m).confirmed += c;
        line(m).variance += c - (Number(s.expected?.[m] ?? 0) || 0);
      }
    }
  }
  const methods = [...lines.values()]
    .map((l) => ({ method: l.method, sales: r2(l.sales), expected: r2(l.expected), confirmed: r2(l.confirmed), variance: r2(l.variance) }))
    .sort((a, b) => (a.method === 'cash' ? -1 : b.method === 'cash' ? 1 : a.method.localeCompare(b.method)));
  const sum = (k: 'sales' | 'expected' | 'confirmed' | 'variance') => r2(methods.reduce((a, l) => a + l[k], 0));
  return { methods, total: { sales: sum('sales'), expected: sum('expected'), confirmed: sum('confirmed'), variance: sum('variance') }, orders, shifts: count };
}

// ── Node side: what the manager screen renders ───────────────────────────────

export interface BranchCloseTillView {
  device_id: string;
  is_self: boolean;
  last_seen: string | null;       // null for self; ISO for peers — staleness is shown
  state: PeerDayState | null;     // peer-reported, or computed locally for self
  instruction: {
    id: number; status: string; created_at: string;
    delivered_at: string | null; acked_at: string | null;
    payload: CloseDayPayload; ack: any | null;
  } | null;                        // the latest close_day instruction today, any status
  /** A452: the latest confirm_shift instruction per shift (pending, acked or refused — with the till's reason). */
  confirms: Record<string, { status: string; error: string | null; created_at: string }>;
  /** A465: cash in / out and expenses sent from the server to this till (last 24 h), oldest first. */
  money: ShiftMoneyView[];
}

export interface ShiftMoneyView {
  id: number; status: string; error: string | null; created_at: string;
  shift_id: string; kind: ShiftMoneyPayload['kind']; amount: number; note: string | null;
}

export function branchCloseOverview(): { business_date: string; tills: BranchCloseTillView[]; totals: BranchTotals } {
  const db = getLocalDb();
  const own = getDeviceConfig()?.device_id ?? '';
  const today = businessDateNow();

  // F4: every device the server has heard of, with when it last did — and only the ones still worth listing.
  const heard = new Map<string, number>();
  const note = (id: string, at: number) => {
    if (!id) return;
    const t = Number.isFinite(at) ? at : -Infinity;
    heard.set(id, Math.max(heard.get(id) ?? -Infinity, t));
  };
  for (const p of listPeers()) note(p.device_id, stampMs(p.updated_at));
  for (const r of db.prepare(`SELECT device_id, updated_at FROM node_peer_state`).all() as any[]) note(String(r.device_id), stampMs(r.updated_at));
  const forgotten = new Map<string, number>();
  for (const r of db.prepare(`SELECT key, value FROM maintenance_state WHERE key LIKE 'forgotten_till:%'`).all() as any[]) {
    forgotten.set(String(r.key).slice('forgotten_till:'.length), stampMs(r.value));
  }
  const nowMs = Date.now();
  const deviceIds = new Set<string>();
  if (own) deviceIds.add(own);
  for (const [id, at] of heard) {
    if (id === own) continue;
    const gone = forgotten.get(id);
    if (gone !== undefined && !(at > gone)) continue;               // forgotten, and not heard from since
    if (!Number.isFinite(at) || nowMs - at > TILL_AGE_OUT_MS) continue;   // not heard from in 7 days
    deviceIds.add(id);
  }

  const latestInstruction = db.prepare(`
    SELECT id, status, created_at, delivered_at, acked_at, payload, ack
      FROM node_instructions
     WHERE device_id = ? AND kind = 'close_day'
     ORDER BY id DESC LIMIT 1
  `);
  const peerState = db.prepare(`SELECT state, updated_at FROM node_peer_state WHERE device_id = ?`);
  const confirmRows = db.prepare(`
    SELECT json_extract(payload, '$.shift_id') AS shift_id, status, ack, created_at
      FROM node_instructions WHERE device_id = ? AND kind = 'confirm_shift' ORDER BY id`);
  const moneyRows = db.prepare(`
    SELECT id, status, ack, payload, created_at FROM node_instructions
     WHERE device_id = ? AND kind = 'shift_money' AND created_at >= ? ORDER BY id`);
  const since = new Date(Date.now() - 24 * 3_600_000).toISOString();

  const tills: BranchCloseTillView[] = [];
  for (const id of deviceIds) {
    const isSelf = id === own;
    let state: PeerDayState | null = null;
    let lastSeen: string | null = null;
    if (isSelf) {
      state = ownDayState();
    } else {
      const row = peerState.get(id) as { state: string; updated_at: string } | undefined;
      if (row) { state = JSON.parse(row.state); lastSeen = row.updated_at; }
    }
    const ins = latestInstruction.get(id) as any | undefined;
    const confirms: BranchCloseTillView['confirms'] = {};
    for (const c of confirmRows.all(id) as any[]) {
      let error: string | null = null;
      try { error = c.ack ? (JSON.parse(c.ack).error ?? null) : null; } catch { /* none */ }
      confirms[String(c.shift_id)] = { status: c.status, error, created_at: c.created_at };
    }
    const money: ShiftMoneyView[] = [];
    for (const m of moneyRows.all(id, since) as any[]) {
      let error: string | null = null;
      let p: Partial<ShiftMoneyPayload> = {};
      try { error = m.ack ? (JSON.parse(m.ack).error ?? null) : null; } catch { /* none */ }
      try { p = JSON.parse(m.payload); } catch { /* none */ }
      money.push({ id: m.id, status: m.status, error, created_at: m.created_at, shift_id: String(p.shift_id ?? ''),
        kind: (p.kind ?? 'float_in') as ShiftMoneyPayload['kind'], amount: Number(p.amount ?? 0),
        note: (p.kind === 'expense' ? p.description : p.reason) ?? null });
    }
    tills.push({
      confirms,
      money,
      device_id: id,
      is_self: isSelf,
      last_seen: lastSeen,
      state,
      instruction: ins ? {
        id: ins.id, status: ins.status, created_at: ins.created_at,
        delivered_at: ins.delivered_at, acked_at: ins.acked_at,
        payload: JSON.parse(ins.payload),
        ack: ins.ack ? JSON.parse(ins.ack) : null,
      } : null,
    });
  }
  // Self first, then peers by device id — a stable order the eye can track
  // while statuses change under it.
  tills.sort((a, b) => (a.is_self === b.is_self) ? a.device_id.localeCompare(b.device_id) : (a.is_self ? -1 : 1));
  // A458: the day's totals over every shift the tills reported.
  const totals = branchMethodTotals(tills.flatMap((t) => (t.state?.shifts ?? []) as PeerShift[]));
  return { business_date: today, tills, totals };
}
