/**
 * abandonTill.ts — A522: close a dead or retired till's open trading day on the cloud, with what the cloud knows.
 *
 * Owner, 2026-10-17: "check if anything will break or fail to respond because a till has not responded … even Pollo
 * restaurant had the same issue". A till that is retired, or has not synced for ABANDON_SILENT_HOURS, never answers a
 * remote Close Day: its open day sat in Remote Day Close for ever ("Close pending…"), the watchdog alert dropped after a
 * few days and the test-data clear was refused over it. A manager (shifts.close_day) or the owner may now close it as
 * abandoned, after a warning — the one place the cloud writes a day close itself (the relay never does, A275):
 *
 *   • every drawer of that till still open on the cloud is FORCE-CLOSED, as POST /api/shifts/:id/force-close does it:
 *     closed_unreconciled, close_method forced, expected cash computed, no count and no difference (NULL, never 0);
 *   • each open day of the till is closed: no count (NULL), expected cash = what its drawers expected, the note says who,
 *     why, and that sales the till made after it last synced are not in it;
 *   • a close instruction (counted_cash NULL — its confirmed shift counts) is left pending for the till: if it ever comes
 *     back, it closes its own day too (and its late sales put the drawers right, lib/lateRows.ts).
 */
import { supabase } from './supabase';
import { computeExpectedCash } from '../routes/shifts';

export interface AbandonResult { days: Array<{ id: string; business_date: string }>; shifts: string[]; expected: number }

export async function abandonTillDays(o: {
  businessId: string; deviceId: string; branchId: string | null; userId: string | null; userName: string | null;
  reason: string; till: string; lastSyncAt: string | null; businessDate?: string | null;
}): Promise<AbandonResult> {
  const now = new Date().toISOString();
  let daysQ = supabase.from('business_days').select('id, business_date, notes, branch_id')
    .eq('business_id', o.businessId).eq('device_id', o.deviceId).eq('status', 'open');
  if (o.businessDate) daysQ = daysQ.eq('business_date', o.businessDate);
  const { data: days, error: dErr } = await daysQ;
  if (dErr) throw new Error(`open days: ${dErr.message}`);
  const dayRows = (days ?? []) as Array<{ id: string; business_date: string; notes: string | null; branch_id: string | null }>;

  // The till's drawers still open on the cloud — its own, and any other on those days.
  const { data: own, error: sErr } = await supabase.from('shifts').select('id, opening_float, notes, business_day_id')
    .eq('business_id', o.businessId).eq('device_id', o.deviceId).eq('status', 'open');
  if (sErr) throw new Error(`open drawers: ${sErr.message}`);
  const open = new Map<string, { id: string; opening_float: number | string | null; notes: string | null }>();
  for (const s of (own ?? []) as any[]) open.set(s.id, s);
  for (const d of dayRows) {
    const { data: more } = await supabase.from('shifts').select('id, opening_float, notes, business_day_id')
      .eq('business_id', o.businessId).eq('business_day_id', d.id).eq('status', 'open');
    for (const s of (more ?? []) as any[]) open.set(s.id, s);
  }

  const since = o.lastSyncAt ? `it last synced ${o.lastSyncAt.slice(0, 16).replace('T', ' ')} UTC` : 'it never synced';
  const closedShifts: string[] = [];
  for (const s of open.values()) {
    const expected = await computeExpectedCash(s.id, Number(s.opening_float) || 0);   // throws on a failed read — nothing half-done
    const { data: done, error } = await supabase.from('shifts').update({
      status: 'closed_unreconciled', close_method: 'forced', closed_at: now, closed_by: o.userId,
      expected_cash: expected, closing_float: null, cash_variance: null,
      notes: [s.notes, `Force-closed by manager: ${o.reason} (POS ${o.till} closed as abandoned — ${since}).`].filter(Boolean).join('\n'),
    }).eq('id', s.id).eq('business_id', o.businessId).eq('status', 'open').select('id').maybeSingle();
    if (error) throw new Error(`force-close ${s.id}: ${error.message}`);
    if (done) closedShifts.push(s.id);
  }

  const out: AbandonResult = { days: [], shifts: closedShifts, expected: 0 };
  for (const d of dayRows) {
    const { data: drawers } = await supabase.from('shifts').select('expected_cash').eq('business_id', o.businessId).eq('business_day_id', d.id);
    const expected = Math.round(((drawers ?? []) as Array<{ expected_cash: number | string | null }>)
      .reduce((n, x) => n + (Number(x.expected_cash) || 0), 0) * 100) / 100;
    const note = `Closed as abandoned on the web${o.userName ? ` by ${o.userName}` : ''}: ${o.reason}. POS ${o.till} did not answer — ${since}; ` +
      'anything it sold after that is not in this close. Uncounted: no cash count, no difference. If the POS comes back it closes its own day too.';
    const { data: closed, error } = await supabase.from('business_days').update({
      status: 'closed', closed_at: now, closed_by: o.userId, counted_cash: null, expected_cash: expected, cash_variance: null,
      notes: [d.notes, note].filter(Boolean).join('\n'), updated_at: now,
    }).eq('id', d.id).eq('business_id', o.businessId).eq('status', 'open').select('id').maybeSingle();
    if (error) throw new Error(`close day ${d.business_date}: ${error.message}`);
    if (!closed) continue;
    out.days.push({ id: d.id, business_date: d.business_date });
    out.expected += expected;

    // Queued for the till, should it come back: it closes its own day on its confirmed counts (never a made-up one).
    const { data: live } = await supabase.from('day_close_instructions').select('id')
      .eq('business_id', o.businessId).eq('device_id', o.deviceId).eq('business_date', d.business_date).eq('status', 'pending').maybeSingle();
    if (!live) {
      const { error: insErr } = await supabase.from('day_close_instructions').insert({
        business_id: o.businessId, branch_id: d.branch_id ?? o.branchId, device_id: o.deviceId, business_date: d.business_date,
        payload: { business_date: d.business_date, counted_cash: null, notes: `Closed as abandoned on the web: ${o.reason}`,
                   closed_by_staff_id: o.userId, closed_by_name: o.userName,
                   // A523: the web already closed this day — the till adopts it (one close: lib/tillsDays.ts
                   // mergeCloudClosedDays keeps the till's push from reopening it, and its own close refines the figures).
                   wait_for_till: true, cloud_closed: { at: now, by_name: o.userName, counted_cash: null, expected_cash: expected, abandoned: true } },
        status: 'pending', created_by: o.userId,
      });
      if (insErr) console.error('[abandonTill] the instruction for the till was not queued:', insErr.message);
    }
  }
  out.expected = Math.round(out.expected * 100) / 100;
  return out;
}
