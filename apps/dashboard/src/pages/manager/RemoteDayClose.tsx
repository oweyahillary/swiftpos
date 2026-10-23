/**
 * RemoteDayClose — A275, Option i.
 *
 * A manager who is NOT in the store closes a till's trading day remotely. This
 * screen lists tills with an OPEN business_day (business_days sync to the cloud),
 * and lets the manager queue a close; the till, on its next cloud sync, computes its own
 * expected cash + variance, closes LOCALLY, and acks. The manager never closes
 * the cloud copy directly — the till stays the cash authority.
 *
 * A522 (owner, 2026-10-17: "nothing may wait on a till that is switched off"):
 *   • The count is OPTIONAL — left empty, the till closes on the cash its managers confirmed shift by shift (the
 *     confirmed shift counts). An off-site manager never invents a figure, and an empty box is never sent as 0.
 *   • Each till shows when it last synced; a close for one that is not recent asks for a tick ("its sales since then are
 *     not in this close; it applies this when it next connects"). The till hears it at its next beat (about 90 s).
 *   • A close the till cannot do yet (a drawer open, a shift not confirmed) shows "Waiting" with the reason — the till
 *     retries at every beat. A pending close can be withdrawn.
 *   • A retired till, or one silent for a day, can have its day closed as abandoned (its drawers force-closed uncounted).
 *   • The instruction shown is the one for THAT day (a close of yesterday never reads as today's).
 *   • Every approved till is listed with its last sync and when it collected a close.
 */
import { useCallback, useEffect, useState } from 'react';
import { usePOSAuth } from '../../context/POSAuthContext';
import { agoLabel, syncRecent } from '../../lib/tillSync';   // A522
import { CreditAwaitingNotice } from '../../components/CreditSalesToConfirm';   // A545

interface Instruction {
  id: string;
  status: 'pending' | 'acked' | 'failed' | 'cancelled';
  business_date?: string;
  created_at: string;
  delivered_at: string | null;
  acked_at: string | null;
  ack: { ok: boolean; error?: string | null; summary?: any; waiting?: boolean; code?: string; cancelled?: boolean } | null;
}
interface TillDay {
  device_id: string;
  label: string;
  business_date: string;
  opened_at: string | null;
  last_sync_at?: string | null;
  retired?: boolean;
  may_abandon?: boolean;
  instruction: Instruction | null;
}
interface TillRow { device_id: string; label: string; last_sync_at: string | null; open_day: string | null; delivered_at: string | null }
interface Overview { tills: TillDay[]; retired_open_days?: TillDay[]; devices?: TillRow[]; abandon_after_hours?: number }

function statusLine(ins: Instruction | null): string {
  if (!ins) return '';
  if (ins.status === 'acked') {
    const v = ins.ack?.summary?.cash_variance;
    return typeof v === 'number' ? `Closed — variance ${v}` : 'Closed';
  }
  if (ins.status === 'failed') return `Failed — ${ins.ack?.error ?? 'the till refused'}`;
  if (ins.status === 'cancelled') return 'Withdrawn';
  if (ins.ack?.waiting) return `Waiting — ${ins.ack.error ?? 'the till cannot close yet'} (it tries again at every sync)`;
  return ins.delivered_at ? 'Delivered — waiting for the till to close' : 'Queued — the till applies it when it next connects';
}

export default function RemoteDayClose({ currency }: { currency: string }) {
  const { posApi, hasPermission } = usePOSAuth();
  // A490: closing a till's day from here is shifts.close_day (the cloud's day-close instruct / overview).
  const allowed = hasPermission('shifts.close_day');

  const [tills, setTills]     = useState<TillDay[]>([]);
  const [retired, setRetired] = useState<TillDay[]>([]);
  const [devices, setDevices] = useState<TillRow[]>([]);
  const [silentHours, setSilentHours] = useState(24);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const [target, setTarget]   = useState<TillDay | null>(null);
  const [counted, setCounted] = useState('');
  const [notes, setNotes]     = useState('');
  const [behindOk, setBehindOk] = useState(false);
  const [busy, setBusy]       = useState(false);
  const [abandon, setAbandon] = useState<TillDay | null>(null);
  const [reason, setReason]   = useState('');
  const [abandonOk, setAbandonOk] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await posApi.get<{ tills: TillDay[] }>('/api/day-close/overview') as Overview;
      setTills(r?.tills ?? []);
      setRetired(r?.retired_open_days ?? []);
      setDevices(r?.devices ?? []);
      if (r?.abandon_after_hours) setSilentHours(r.abandon_after_hours);
      setError('');
    } catch (e: any) {
      setError(e?.message ?? 'Could not load open trading days');
    } finally {
      setLoading(false);
    }
  }, [posApi]);

  useEffect(() => {
    if (!allowed) { setLoading(false); return; }
    void load();
    const t = setInterval(() => { void load(); }, 15000); // reflect the till acking
    return () => clearInterval(t);
  }, [allowed, load]);

  const behind = !!target && !syncRecent(target.last_sync_at);

  const submit = async () => {
    if (!target) return;
    // A522: empty = the confirmed shift counts (null) — never 0.
    const typed = counted.trim();
    const amount = typed === '' ? null : parseFloat(typed);
    if (amount !== null && (isNaN(amount) || amount < 0)) { setError('Enter the cash counted at the till (0 or more), or leave it empty'); return; }
    if (behind && !behindOk) { setError('Tick that you understand the till’s sales since it last synced are not in this close.'); return; }
    setBusy(true); setError('');
    try {
      await posApi.post('/api/day-close/instruct', {
        device_id:     target.device_id,
        business_date: target.business_date,
        counted_cash:  amount,
        notes:         notes.trim() || null,
      });
      setTarget(null); setCounted(''); setNotes(''); setBehindOk(false);
      await load();
    } catch (e: any) {
      setError(e?.message ?? 'Could not queue the close');
    } finally {
      setBusy(false);
    }
  };

  const withdraw = async (t: TillDay) => {
    if (!t.instruction) return;
    setBusy(true); setError('');
    try {
      const r = await posApi.post<{ delivered?: boolean }>(`/api/day-close/${t.instruction.id}/cancel`, {});
      if (r?.delivered) setError(`${t.label} had already collected that close — it may still carry it out.`);
      await load();
    } catch (e: any) { setError(e?.message ?? 'Could not withdraw the close'); }
    finally { setBusy(false); }
  };

  const closeAbandoned = async () => {
    if (!abandon || !reason.trim() || !abandonOk) return;
    setBusy(true); setError('');
    try {
      await posApi.post('/api/day-close/abandon', { device_id: abandon.device_id, business_date: abandon.business_date, reason: reason.trim(), confirm: true });
      setAbandon(null); setReason(''); setAbandonOk(false);
      await load();
    } catch (e: any) { setError(e?.message ?? 'Could not close the day'); }
    finally { setBusy(false); }
  };

  if (!allowed) return null;

  const row = (t: TillDay) => {
    const pending = t.instruction?.status === 'pending';
    return (
      <div key={`${t.device_id}-${t.business_date}`} className="bg-gray-900 border border-gray-800 rounded-xl p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm text-gray-200 truncate">{t.label}{t.retired ? ' · retired' : ''}</p>
          <p className="text-xs text-gray-500">Day {t.business_date}{statusLine(t.instruction) ? ` · ${statusLine(t.instruction)}` : ''}</p>
          <p className={`text-xs ${syncRecent(t.last_sync_at) ? 'text-gray-500' : 'text-amber-400'}`} data-testid={`last-sync-${t.device_id}`}>
            Last synced {agoLabel(t.last_sync_at)}
          </p>
        </div>
        <div className="flex flex-wrap gap-2 sm:flex-shrink-0">
          {!t.retired && !pending && (
            <button className="px-3 py-2 rounded-lg text-xs font-semibold bg-amber-500/10 border border-amber-500/40 text-amber-300"
              onClick={() => { setTarget(t); setCounted(''); setNotes(''); setBehindOk(false); setError(''); }}>
              Close day
            </button>
          )}
          {pending && (
            <button className="px-3 py-2 rounded-lg text-xs bg-gray-800 border border-gray-700 text-gray-300 disabled:opacity-50" disabled={busy}
              onClick={() => void withdraw(t)} data-testid={`withdraw-${t.device_id}`}>
              Withdraw close
            </button>
          )}
          {t.may_abandon && (
            <button className="px-3 py-2 rounded-lg text-xs border border-red-500/50 text-red-400" data-testid={`abandon-${t.device_id}`}
              onClick={() => { setAbandon(t); setReason(''); setAbandonOk(false); setError(''); }}>
              Close as abandoned
            </button>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-gray-200">Remote day close</h3>
        <p className="text-xs text-gray-500">
          Close a till's trading day when you're not in the store. The till closes itself when it next syncs (about every
          90 seconds while it is on) — on the shift counts its managers confirmed, or on a count you enter.
        </p>
      </div>
      {/* A545: credit sales still waiting for a manager — said, never a block on closing (the owner: no deadlocks). */}
      <CreditAwaitingNotice client={posApi} />

      {error && <p className="text-xs text-red-400">{error}</p>}

      {loading ? (
        <p className="text-xs text-gray-500">Loading open trading days…</p>
      ) : tills.length === 0 && retired.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-800 p-6 text-center text-xs text-gray-500">
          No open trading days. Every till's day is closed.
        </div>
      ) : (
        <div className="space-y-2">
          {tills.map(row)}
          {retired.length > 0 && <p className="text-xs text-gray-500 pt-2">Retired tills with a day still open — they will never close it themselves:</p>}
          {retired.map(row)}
        </div>
      )}

      {devices.length > 0 && (
        <div className="text-xs text-gray-500" data-testid="all-tills">
          <p className="font-semibold text-gray-400 mb-1">Every till</p>
          {devices.map((d) => (
            <p key={d.device_id}>
              {d.label} · last synced <span className={syncRecent(d.last_sync_at) ? '' : 'text-amber-400'}>{agoLabel(d.last_sync_at)}</span>
              {d.open_day ? ` · day ${d.open_day} open` : ' · no open day'}
              {d.delivered_at ? ` · collected a close ${agoLabel(d.delivered_at)}` : ''}
            </p>
          ))}
        </div>
      )}

      {target && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-2xl p-6 max-w-md w-full max-h-[90vh] overflow-y-auto">
            <h4 className="text-base font-semibold text-gray-100">Close {target.label} — day {target.business_date}</h4>
            <p className="text-xs text-gray-500 mt-1">
              Leave the count empty to close on the shift counts the managers confirmed. Enter a count only if the cash was
              counted again <b>at the till</b> — never an estimate.
            </p>
            <label className="block text-xs text-gray-400 mt-4 mb-1">Cash counted ({currency}) — optional</label>
            <input
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100"
              type="number" min="0" step="any" inputMode="decimal" placeholder="Empty = the confirmed shift counts"
              value={counted} onChange={(e) => setCounted(e.target.value)} autoFocus
            />
            <label className="block text-xs text-gray-400 mt-3 mb-1">Notes</label>
            <textarea
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100"
              rows={2} value={notes} onChange={(e) => setNotes(e.target.value)}
            />
            {behind && (
              <label className="flex gap-2 items-start mt-3 text-xs text-amber-300" data-testid="behind-warning">
                <input type="checkbox" checked={behindOk} onChange={(e) => setBehindOk(e.target.checked)} className="mt-0.5" />
                <span>{target.label} last synced {agoLabel(target.last_sync_at)} — its sales since then are not on the web yet. It applies this close when it next connects.</span>
              </label>
            )}
            <div className="flex gap-3 mt-4">
              <button className="flex-1 px-3 py-2 rounded-lg text-sm bg-gray-800 text-gray-300" onClick={() => setTarget(null)} disabled={busy}>Cancel</button>
              <button className="flex-1 px-3 py-2 rounded-lg text-sm font-semibold bg-amber-500 text-black disabled:opacity-50" onClick={submit} disabled={busy || (behind && !behindOk)}>
                {busy ? 'Queuing…' : 'Queue close'}
              </button>
            </div>
          </div>
        </div>
      )}

      {abandon && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-2xl p-6 max-w-md w-full max-h-[90vh] overflow-y-auto" data-testid="abandon-dialog">
            <h4 className="text-base font-semibold text-gray-100">Close {abandon.label} — day {abandon.business_date} — as abandoned</h4>
            <p className="text-xs text-red-300 mt-2">
              {abandon.retired ? 'This till is retired.' : `This till has not synced for over ${silentHours} h (last ${agoLabel(abandon.last_sync_at)}).`}{' '}
              The day is closed on the web with what the web knows: its open drawers are force-closed <b>uncounted</b>, there is
              no cash count, and anything it sold after it last synced is not in this close. If the till comes back, it closes
              its own day too and its late sales are added.
            </p>
            <label className="block text-xs text-gray-400 mt-4 mb-1">Reason (required)</label>
            <textarea className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100" rows={2}
              value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. T2 broken, replaced by T4" />
            <label className="flex gap-2 items-start mt-3 text-xs text-amber-300">
              <input type="checkbox" checked={abandonOk} onChange={(e) => setAbandonOk(e.target.checked)} className="mt-0.5" />
              <span>I understand this till's unsent sales are not in this close.</span>
            </label>
            <div className="flex gap-3 mt-4">
              <button className="flex-1 px-3 py-2 rounded-lg text-sm bg-gray-800 text-gray-300" onClick={() => setAbandon(null)} disabled={busy}>Cancel</button>
              <button className="flex-1 px-3 py-2 rounded-lg text-sm font-semibold bg-red-500 text-white disabled:opacity-50"
                onClick={() => void closeAbandoned()} disabled={busy || !reason.trim() || !abandonOk}>
                {busy ? 'Closing…' : 'Close as abandoned'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
