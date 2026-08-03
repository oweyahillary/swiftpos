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

// ── Shared shapes ────────────────────────────────────────────────────────────

export interface CloseDayPayload {
  business_date: string;      // the day being closed — refuses a mismatch
  counted_cash: number;       // the manager's count for THIS till
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

    // A date mismatch means the node and this till disagree about what day it
    // is — the exact split the drift warning exists for. Refusing names it;
    // closing the WRONG day would be the silent version.
    if (day.business_date !== payload.business_date) {
      return {
        ok: false,
        error: `This till's open trading day is ${day.business_date}, not ${payload.business_date}. ` +
               'Check the clocks before closing centrally.',
      };
    }

    const summary = closeDayInstructed(
      Number(payload.counted_cash),
      payload.notes,
      payload.closed_by_staff_id ?? null,
      payload.closed_by_name ?? null,
    );
    return { ok: true, summary };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Could not close the day on this till' };
  }
}

// ── Node side: instruction lifecycle ─────────────────────────────────────────

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
}

export function branchCloseOverview(): { business_date: string; tills: BranchCloseTillView[] } {
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
    tills.push({
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
  return { business_date: today, tills };
}
