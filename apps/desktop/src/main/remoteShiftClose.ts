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
  /** A521 (#9): the web's own figures, recorded as the web's (the till keeps its own expected — keepOwnExpected). */
  web_expected_cash?: number | null; web_cash_variance?: number | null;
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
      web_expected_cash: num(c.expected_cash), web_cash_variance: forced ? null : num(c.cash_variance),
      note: `Shift ${what} on the web${who ? ` by ${who}` : ''}${reason ? ` — ${reason}` : ''}.`,
      message: `This shift was ${what} on the web${who ? ` by ${who}` : ''}${reason ? ` (${reason})` : ''}. Open a new shift to keep selling.`,
    });
  }
  return out;
}

/**
 * A521 (#9): the till adopts the web's close of its drawer but keeps ITS OWN expected cash (recomputed from its own rows —
 * the cloud's figure was computed from what the cloud had, and is stale for a till that was off with sales unsent). The
 * variance is the counted cash against the till's own figure; the web's expected and variance are kept as the web's, in
 * the note. `own` null (the till could not compute it) → the web's figures, as before.
 */
export function keepOwnExpected(c: LocalClose, own: number | null): LocalClose {
  if (own === null || !Number.isFinite(own)) return c;
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const ownExpected = r2(own);
  const variance = c.closing_float === null ? null : r2(c.closing_float - ownExpected);
  const webSaid = c.web_expected_cash !== null && c.web_expected_cash !== undefined && r2(c.web_expected_cash) !== ownExpected
    ? ` The web's figures: expected ${r2(c.web_expected_cash)}${c.web_cash_variance === null || c.web_cash_variance === undefined ? '' : `, variance ${r2(c.web_cash_variance)}`}; this till expects ${ownExpected} (its own books).`
    : '';
  return { ...c, expected_cash: ownExpected, cash_variance: variance, note: `${c.note}${webSaid}` };
}
