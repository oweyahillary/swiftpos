// siblingDrawers.ts — other shifts open on the SAME till, closed with the till's count (A342, 2026-09-27).
//
// Owner, 2026-09-27: "if a shift is closed on the till it should also close the web" — and, asked how the web shift's cash
// is counted: "Till's count covers both". Since migration 107 a till can have two open drawers on the cloud: its own and one
// the web POS opened standing in as that till (A273). Physically it is ONE cash drawer, so when the TILL closes, the web's
// shift on that till closes with it: its expected cash is added to the till's, the cashier counts once, and the web shift is
// recorded as counted (inside the till's count) with no variance of its own.
//
// Pure (no Supabase import) so the rule runs in a test.

import { terminalKey } from './terminalKey';

export interface ShiftKeyRow {
  id: string; status: string;
  device_id?: string | null; terminal_code?: string | null; branch_id?: string | null;
  /** Migration 133: 'web' = opened by POST /api/shifts/open (the web POS); 'till' = pushed by a till (/api/sync/push). */
  opened_via?: string | null;
  business_day_id?: string | null;
  opened_at?: string | null;
}

const keyOf = (s: ShiftKeyRow) => terminalKey(s.device_id ?? '', s.terminal_code ?? '', s.branch_id ?? '');

/**
 * A web POS stand-in drawer (A273): opened on the web while covering a till. Marked since migration 133 (opened_via); a row
 * from before it (or a cloud without it) is told apart the way the backfill does — a till's own shift always names its
 * trading day (business_day_id, migration 41), a web shift never does.
 */
export function isWebStandIn(s: ShiftKeyRow): boolean {
  if (s.opened_via === 'web') return true;
  if (s.opened_via === 'till') return false;
  return !s.business_day_id;
}

/**
 * The shifts a till's count closes with it (A342), when the till closes `shift` at `closeAt`: the OTHER open shifts on the
 * same terminal that the WEB opened standing in for it, opened before the till's close. Never another of the till's own
 * shifts — its NEXT drawer, pushed by /sync/push before the old drawer's close reached the cloud, is live (P0-1: it used to
 * be closed with variance 0 and its cash counted into the old shift).
 */
export function siblingsOf<T extends ShiftKeyRow>(shift: ShiftKeyRow, open: T[], closeAt?: string | null): T[] {
  const k = keyOf(shift);
  const until = closeAt ? Date.parse(closeAt) : NaN;
  return open.filter((o) => {
    if (o.id === shift.id || o.status !== 'open' || keyOf(o) !== k || !isWebStandIn(o)) return false;
    if (Number.isFinite(until) && o.opened_at) {
      const opened = Date.parse(o.opened_at);
      if (Number.isFinite(opened) && opened >= until) return false;   // opened after the till's count: not in it
    }
    return true;
  });
}

export interface SiblingCash { id: string; opened_by_name: string | null; opened_at: string | null; expected: number }

/** What the till adds to its own expected cash, and what it shows the cashier. */
export function siblingSummary(rows: SiblingCash[]): { count: number; expected: number; shifts: SiblingCash[] } {
  return { count: rows.length, expected: rows.reduce((s, r) => s + Number(r.expected || 0), 0), shifts: rows };
}

/** The note written on a web shift the till's count closed. */
export function closedWithTillNote(tillLabel: string, tillShiftId: string): string {
  return `Closed with ${tillLabel}'s count (shift ${tillShiftId.slice(0, 8)}) — its cash was counted in that drawer.`;
}
