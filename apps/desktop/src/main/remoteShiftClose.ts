/**
 * remoteShiftClose.ts — A401: a drawer closed on the web closes on the till too (pure; syncEngine does the I/O).
 *
 * Owner, 2026-10-05: "force close drawer on the web does not close desktop till it remains open". The till never asked
 * the cloud about its open shift, so a manager's force-close (or close) on the web left the till selling against a
 * shift the cloud had ended. On its ~20 s beat the till now sends the ids of its open shifts to GET /api/shifts/state;
 * every one the cloud reports closed is closed here the same way — status, figures and who — and marked synced, so
 * the till never pushes a second close over the cloud's.
 */

export interface CloudShiftState {
  id: string; status: string; closed_at: string | null; close_method: string | null; closed_by: string | null;
  closed_by_name?: string | null; closing_float: number | string | null; cash_variance: number | string | null;
  expected_cash: number | string | null; notes: string | null;
}

export interface LocalClose {
  id: string; status: 'closed' | 'closed_unreconciled'; closed_at: string; close_method: string;
  closed_by: string | null; closing_float: number | null; cash_variance: number | null; expected_cash: number | null;
  note: string;          // appended to the till's own notes
  message: string;       // what the cashier is told
}

const num = (v: unknown): number | null => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/** The cloud's word on this till's open shifts → the closes to make here. Still open, unknown or odd → nothing. */
export function closesToAdopt(openIds: string[], cloud: CloudShiftState[], now = new Date().toISOString()): LocalClose[] {
  const mine = new Set(openIds);
  const out: LocalClose[] = [];
  for (const c of cloud ?? []) {
    if (!c || !mine.has(c.id)) continue;
    if (c.status !== 'closed' && c.status !== 'closed_unreconciled') continue;
    const forced = c.status === 'closed_unreconciled' || c.close_method === 'forced';
    const who = (c.closed_by_name ?? '').trim();
    const reason = /Force-closed by manager: (.+)$/m.exec(c.notes ?? '')?.[1]?.trim() ?? '';
    const what = forced ? 'force-closed' : 'closed';
    out.push({
      id: c.id,
      status: forced ? 'closed_unreconciled' : 'closed',
      closed_at: c.closed_at || now,
      close_method: c.close_method || (forced ? 'forced' : 'web'),
      closed_by: c.closed_by ?? null,
      closing_float: forced ? null : num(c.closing_float),
      cash_variance: forced ? null : num(c.cash_variance),
      expected_cash: num(c.expected_cash),
      note: `Shift ${what} on the web${who ? ` by ${who}` : ''}${reason ? ` — ${reason}` : ''}.`,
      message: `This shift was ${what} on the web${who ? ` by ${who}` : ''}${reason ? ` (${reason})` : ''}. Open a new shift to keep selling.`,
    });
  }
  return out;
}
