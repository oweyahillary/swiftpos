/**
 * lateRows.ts — A522: a sale, cash in / out or expense that reaches the cloud AFTER its drawer was closed.
 *
 * Owner, 2026-10-17: "check if anything will break or fail to respond because a till has not responded". A drawer closed
 * (counted or force-closed) on the web while its till was off froze its expected cash; the till's offline sales, pay-outs
 * and expenses arrived later and were never added — a phantom over / short nobody could explain. They are never refused
 * (a till's sale is never lost, A462), so this is the one place that puts the drawer's figures right when they land:
 *
 *   expected_cash   recomputed from what the cloud now holds (the same formula as the close, computeExpectedCash), plus
 *                   the cash of any web stand-in drawer the till's count covered when it closed (A342 — closed at the
 *                   same moment, noted "Closed with T1's count (shift xxxxxxxx)").
 *   cash_variance   the count minus the new expected — only where there was a count (a force-closed drawer stays NULL).
 *   expected_methods.cash   the same, so a manager's confirmation reads against the real figure.
 *   notes           "Late rows after close: …" with the old and the new expected cash.
 *
 * The owner is told when the difference moves. Called from the order push (routes/orders.ts) and the drawer sync push
 * (routes/sync.ts). Never throws: putting figures right must not fail the sale or the sync that brought it.
 */
import { supabase } from './supabase';
import { computeExpectedCash } from '../routes/shifts';
import { notifyOwner, kes } from './ownerNotice';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const r2 = (n: number) => Math.round(n * 100) / 100;

export interface LateSettle { id: string; before: number | null; after: number; variance: number | null }

/** The note added to a drawer whose figures moved (exported for the tests). */
export function lateNote(what: string, before: number | null, after: number): string {
  return `Late rows after close: ${what} reached the cloud after this drawer was closed — expected cash ${before === null ? 'was not set' : `moved from ${r2(before)}`} to ${r2(after)}.`;
}

export async function settleLateRows(businessId: string, shiftIds: Array<string | null | undefined>, what: string): Promise<LateSettle[]> {
  const out: LateSettle[] = [];
  const ids = [...new Set(shiftIds.filter((x): x is string => typeof x === 'string' && UUID.test(x)))];
  for (const id of ids) {
    try {
      const { data: shift, error } = await supabase.from('shifts').select('*').eq('id', id).eq('business_id', businessId).maybeSingle();
      if (error || !shift) continue;
      const s = shift as Record<string, any>;
      if (s.status === 'open') continue;   // an open drawer computes its figures when it closes

      // A342: a web stand-in drawer the till's count covered was closed at the same moment with that count's note.
      let siblingCash = 0;
      if (s.closed_at && s.close_method === 'counted') {
        const { data: sibs } = await supabase.from('shifts').select('id, expected_cash, notes, closed_at')
          .eq('business_id', businessId).eq('closed_at', s.closed_at).neq('id', id);
        for (const x of (sibs ?? []) as Array<{ expected_cash: number | string | null; notes: string | null }>) {
          if (String(x.notes ?? '').includes(`(shift ${id.slice(0, 8)})`)) siblingCash += Number(x.expected_cash) || 0;
        }
      }
      const after = r2((await computeExpectedCash(id, Number(s.opening_float) || 0)) + siblingCash);
      const before = s.expected_cash === null || s.expected_cash === undefined ? null : r2(Number(s.expected_cash));
      if (before !== null && Math.round(before * 100) === Math.round(after * 100)) continue;   // nothing moved

      const counted = s.closing_float === null || s.closing_float === undefined ? null : Number(s.closing_float);
      const variance = counted === null ? null : r2(counted - after);
      const patch: Record<string, unknown> = {
        expected_cash: after,
        cash_variance: variance,
        notes: [s.notes, lateNote(what, before, after)].filter(Boolean).join('\n'),
      };
      if (s.expected_methods && typeof s.expected_methods === 'object') patch.expected_methods = { ...s.expected_methods, cash: after };
      const { error: upErr } = await supabase.from('shifts').update(patch).eq('id', id).eq('business_id', businessId).neq('status', 'open');
      if (upErr) { console.error('[lateRows] drawer not updated', id, upErr.message); continue; }
      out.push({ id, before, after, variance });

      const oldVariance = s.cash_variance === null || s.cash_variance === undefined ? null : r2(Number(s.cash_variance));
      if (variance !== null && variance !== oldVariance) {
        const till = s.terminal_code || 'A till';
        await notifyOwner(businessId, s.branch_id ?? null, 'late_rows_after_close',
          `${till}: a closed drawer's difference changed`,
          `${till} sent ${what} after its drawer (shift ${id.slice(0, 8)}) was closed. Expected cash is now ${kes(after)} (was ${before === null ? 'not set' : kes(before)}); ` +
          `the difference is now ${kes(variance)} (was ${oldVariance === null ? 'not set' : kes(oldVariance)}).`);
      }
    } catch (e) {
      console.error('[lateRows] could not settle', id, (e as Error)?.message ?? e);
    }
  }
  return out;
}
