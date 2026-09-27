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
}

const keyOf = (s: ShiftKeyRow) => terminalKey(s.device_id ?? '', s.terminal_code ?? '', s.branch_id ?? '');

/** The OTHER open shifts on the same terminal as `shift` (never the shift itself, never a closed one). */
export function siblingsOf<T extends ShiftKeyRow>(shift: ShiftKeyRow, open: T[]): T[] {
  const k = keyOf(shift);
  return open.filter((o) => o.id !== shift.id && o.status === 'open' && keyOf(o) === k);
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
