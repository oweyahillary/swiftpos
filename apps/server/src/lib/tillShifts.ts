// tillShifts.ts — which of a branch's tills has an OPEN drawer, and who opened it.
//
// Pure (no Supabase import) so the rule runs in a test. GET /api/shifts/terminals/open
// feeds it the branch's open shifts; the web POS merges the answer with the till list
// (GET /api/shifts/terminals) and then (A273 follow-up, 2026-09-26):
//   - joins the till whose drawer the signed-in cashier opened — no picker, no float;
//   - otherwise lists every till as "open — Jane, since 09:02" or closed, and joining
//     an open till never asks for an opening float (the 2026-09-15 target finding).
//
// A shift belongs to a till by device_id — the first thing terminalKey() keys on, and
// what the web adopts as x-device-id. With more than one open shift on a till (a state
// /open refuses to create, but old data may hold) the NEWEST wins: it is the one
// GET /api/shifts/current returns, so the web joins the drawer it will then sell into.

export interface TillRow { device_id: string; terminal_code: string | null; device_label: string | null }
export interface OpenShiftRow {
  id: string; device_id: string | null; opened_at: string;
  opened_by?: string | null; cashier_id?: string | null;
}
export interface TillOpenShift { id: string; opened_at: string; opened_by: string | null; opened_by_name: string | null }

export function attachOpenShifts<T extends TillRow>(
  tills: T[], openShifts: OpenShiftRow[], nameById: Record<string, string>,
): Array<T & { open_shift: TillOpenShift | null }> {
  const newest = new Map<string, OpenShiftRow>();
  for (const s of openShifts) {
    if (!s.device_id) continue;
    const cur = newest.get(s.device_id);
    if (!cur || s.opened_at > cur.opened_at) newest.set(s.device_id, s);
  }
  return tills.map((t) => {
    const s = newest.get(t.device_id);
    if (!s) return { ...t, open_shift: null };
    const who = s.opened_by ?? s.cashier_id ?? null;
    return { ...t, open_shift: { id: s.id, opened_at: s.opened_at, opened_by: who, opened_by_name: who ? (nameById[who] ?? null) : null } };
  });
}

/** The branch's open drawers, ONE per till (the newest), as { device_id, open_shift }. */
export function openDrawersByTill(openShifts: OpenShiftRow[], nameById: Record<string, string>): Array<{ device_id: string; open_shift: TillOpenShift }> {
  const ids = [...new Set(openShifts.map((s) => s.device_id).filter((d): d is string => !!d))];
  return attachOpenShifts(ids.map((device_id) => ({ device_id, terminal_code: null, device_label: null })), openShifts, nameById)
    .map((t) => ({ device_id: t.device_id, open_shift: t.open_shift as TillOpenShift }));
}

