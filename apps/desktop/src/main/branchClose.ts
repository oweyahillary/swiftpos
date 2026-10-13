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

import { getLocalDb } from './localDb';
import { getDeviceConfig } from './deviceConfig';
import {
  closeDayInstructed, getOpenDay, getDayCloseSummary, businessDateNow,
} from './dayService';
import { getOpenShift } from './syncEngine';
import { listPeers } from './nodeIngest';
import { computeZReport, expectedMethods, methodsToCount, confirmShift, type Confirmation } from './shiftService';   // A452
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
  };
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

/** A452: queue a shift confirmation for one peer (one live instruction per shift — a second replaces the first). */
export function createConfirmInstruction(deviceId: string, payload: ConfirmShiftPayload, createdByStaffId: string | null): { id: number } {
  const db = getLocalDb();
  db.prepare(`DELETE FROM node_instructions
               WHERE device_id = ? AND kind = 'confirm_shift' AND status = 'pending' AND json_extract(payload, '$.shift_id') = ?`)
    .run(deviceId, payload.shift_id);
  const r = db.prepare(`INSERT INTO node_instructions (device_id, kind, payload, created_by, created_at) VALUES (?, 'confirm_shift', ?, ?, ?)`)
    .run(deviceId, JSON.stringify(payload), createdByStaffId, new Date().toISOString());
  return { id: Number(r.lastInsertRowid) };
}

/** Queue a close for one peer. One live instruction per peer per day. */
export function createCloseInstruction(
  deviceId: string, payload: CloseDayPayload, createdByStaffId: string | null,
): { id: number } {
  const db = getLocalDb();

  // Replace any still-pending close for this peer rather than stacking them:
  // two pending instructions with two different counted amounts is a question
  // with two answers, and the peer would execute whichever it saw first.
  db.prepare(`DELETE FROM node_instructions
               WHERE device_id = ? AND kind = 'close_day' AND status = 'pending'`)
    .run(deviceId);

  const r = db.prepare(`
    INSERT INTO node_instructions (device_id, kind, payload, created_by, created_at)
    VALUES (?, 'close_day', ?, ?, ?)
  `).run(deviceId, JSON.stringify(payload), createdByStaffId, new Date().toISOString());
  return { id: Number(r.lastInsertRowid) };
}

/**
 * Instructions a polling peer should act on. Marks delivered_at (visibility for
 * the manager screen) but keeps status 'pending' — only an ack retires it.
 */
export function collectInstructions(deviceId: string): Array<{ id: number; kind: string; payload: any }> {
  const db = getLocalDb();
  const rows = db.prepare(`
    SELECT id, kind, payload FROM node_instructions
     WHERE device_id = ? AND status = 'pending'
     ORDER BY id
  `).all(deviceId) as Array<{ id: number; kind: string; payload: string }>;
  if (rows.length) {
    const now = new Date().toISOString();
    const mark = db.prepare(`UPDATE node_instructions SET delivered_at = COALESCE(delivered_at, ?) WHERE id = ?`);
    for (const r of rows) mark.run(now, r.id);
  }
  return rows.map(r => ({ id: r.id, kind: r.kind, payload: JSON.parse(r.payload) }));
}

/** A peer's verdict on an instruction. */
export function recordAck(instructionId: number, ack: { ok: boolean; error?: string; summary?: unknown }): void {
  const db = getLocalDb();
  db.prepare(`
    UPDATE node_instructions
       SET status = ?, ack = ?, acked_at = ?
     WHERE id = ? AND status = 'pending'
  `).run(ack.ok ? 'acked' : 'failed', JSON.stringify(ack), new Date().toISOString(), instructionId);
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
}

export function branchCloseOverview(): { business_date: string; tills: BranchCloseTillView[]; totals: BranchTotals } {
  const db = getLocalDb();
  const own = getDeviceConfig()?.device_id ?? '';
  const today = businessDateNow();

  const deviceIds = new Set<string>();
  if (own) deviceIds.add(own);
  for (const p of listPeers()) deviceIds.add(p.device_id);
  for (const r of db.prepare(`SELECT device_id FROM node_peer_state`).all() as any[]) {
    deviceIds.add(String(r.device_id));
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
    tills.push({
      confirms,
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
