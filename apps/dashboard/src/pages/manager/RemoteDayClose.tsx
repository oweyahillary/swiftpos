/**
 * RemoteDayClose — A275, Option i.
 *
 * A manager who is NOT in the store closes a till's trading day remotely. This
 * screen lists tills with an OPEN business_day (business_days sync to the cloud),
 * and lets the manager queue a close: they enter the counted cash (relayed from
 * the cashier at the till) and the till, on its next cloud sync, computes its own
 * expected cash + variance, closes LOCALLY, and acks. The manager never closes
 * the cloud copy directly — the till stays the cash authority.
 *
 * The count is a real count made at the till, entered here by the manager. This
 * screen does not, and must not, close a day on estimated cash.
 */
import { useCallback, useEffect, useState } from 'react';
import { usePOSAuth } from '../../context/POSAuthContext';

interface Instruction {
  id: string;
  status: 'pending' | 'acked' | 'failed';
  created_at: string;
  delivered_at: string | null;
  acked_at: string | null;
  ack: { ok: boolean; error?: string | null; summary?: any } | null;
}
interface TillDay {
  device_id: string;
  label: string;
  business_date: string;
  opened_at: string | null;
  instruction: Instruction | null;
}

const fmt = (n: number, c: string) =>
  `${c} ${Number(n).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function statusLine(ins: Instruction | null): string {
  if (!ins) return '';
  if (ins.status === 'acked') {
    const v = ins.ack?.summary?.cash_variance;
    return typeof v === 'number' ? `Closed — variance ${v}` : 'Closed';
  }
  if (ins.status === 'failed') return `Failed — ${ins.ack?.error ?? 'the till refused'}`;
  return ins.delivered_at ? 'Delivered — waiting for the till to close' : 'Queued — waiting for the till to sync';
}

export default function RemoteDayClose({ currency }: { currency: string }) {
  const { posApi, hasPermission } = usePOSAuth();
  const allowed = hasPermission('shifts.force_close') || hasPermission('settings.manage');

  const [tills, setTills]     = useState<TillDay[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const [target, setTarget]   = useState<TillDay | null>(null);
  const [counted, setCounted] = useState('');
  const [notes, setNotes]     = useState('');
  const [busy, setBusy]       = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await posApi.get<{ tills: TillDay[] }>('/api/day-close/overview');
      setTills(r?.tills ?? []);
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

  const submit = async () => {
    if (!target) return;
    const amount = parseFloat(counted);
    if (isNaN(amount) || amount < 0) { setError('Enter the cash counted at the till (0 or more)'); return; }
    setBusy(true); setError('');
    try {
      await posApi.post('/api/day-close/instruct', {
        device_id:     target.device_id,
        business_date: target.business_date,
        counted_cash:  amount,
        notes:         notes.trim() || null,
      });
      setTarget(null); setCounted(''); setNotes('');
      await load();
    } catch (e: any) {
      setError(e?.message ?? 'Could not queue the close');
    } finally {
      setBusy(false);
    }
  };

  if (!allowed) return null;

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-gray-200">Remote day close</h3>
        <p className="text-xs text-gray-500">
          Close a till's trading day when you're not in the store. Enter the cash the cashier
          counted at the till; the till computes the variance and closes itself on its next sync.
        </p>
      </div>

      {error && <p className="text-xs text-red-400">{error}</p>}

      {loading ? (
        <p className="text-xs text-gray-500">Loading open trading days…</p>
      ) : tills.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-800 p-6 text-center text-xs text-gray-500">
          No open trading days. Every till's day is closed.
        </div>
      ) : (
        <div className="space-y-2">
          {tills.map((t) => (
            <div key={t.device_id} className="bg-gray-900 border border-gray-800 rounded-xl p-4 flex items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="text-sm text-gray-200 truncate">{t.label}</p>
                <p className="text-xs text-gray-500">Day {t.business_date}{statusLine(t.instruction) ? ` · ${statusLine(t.instruction)}` : ''}</p>
              </div>
              <button
                className="flex-shrink-0 px-3 py-2 rounded-lg text-xs font-semibold bg-amber-500/10 border border-amber-500/40 text-amber-300 disabled:opacity-50"
                disabled={t.instruction?.status === 'pending'}
                onClick={() => { setTarget(t); setCounted(''); setNotes(''); setError(''); }}
              >
                {t.instruction?.status === 'pending' ? 'Close pending…' : 'Close day'}
              </button>
            </div>
          ))}
        </div>
      )}

      {target && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-2xl p-6 max-w-md w-full">
            <h4 className="text-base font-semibold text-gray-100">Close {target.label} — day {target.business_date}</h4>
            <p className="text-xs text-gray-500 mt-1">
              Enter the cash counted <b>at the till</b>. The till will compute expected cash and variance
              and close its own day. Do not estimate — an uncounted close is worse than an open day.
            </p>
            <label className="block text-xs text-gray-400 mt-4 mb-1">Cash counted ({currency})</label>
            <input
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100"
              type="number" min="0" step="any" inputMode="decimal" placeholder="e.g. 12500"
              value={counted} onChange={(e) => setCounted(e.target.value)} autoFocus
            />
            <label className="block text-xs text-gray-400 mt-3 mb-1">Notes</label>
            <textarea
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100"
              rows={2} value={notes} onChange={(e) => setNotes(e.target.value)}
            />
            <div className="flex gap-3 mt-4">
              <button className="flex-1 px-3 py-2 rounded-lg text-sm bg-gray-800 text-gray-300" onClick={() => setTarget(null)} disabled={busy}>Cancel</button>
              <button className="flex-1 px-3 py-2 rounded-lg text-sm font-semibold bg-amber-500 text-black disabled:opacity-50" onClick={submit} disabled={busy}>
                {busy ? 'Queuing…' : 'Queue close'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
