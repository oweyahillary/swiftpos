/**
 * ManagerShiftTab — the manager's shift oversight for their branch.
 *
 * On the WEB the end-of-day unit is the SHIFT (drawer session), not a trading day:
 * `business_days` are a desktop/offline construct the till manages and syncs up, so
 * there is no web "close day" gate. The manager's shift actions here are:
 *   • see every OPEN shift at the branch (who, which till, since when, expected cash), and
 *   • release a STRANDED drawer via force-close (reason required; recorded uncounted),
 *     gated on shifts.force_close (managers hold it; owner uses OpenShiftsPage).
 * Normal cash-counted close stays on the till's own End Shift (the person who counts
 * the drawer closes it) — a manager force-close is deliberately marked uncounted.
 */
import { useCallback, useEffect, useState } from 'react';
import { printShiftReport } from '../../lib/printShiftReport';
import { usePOSAuth } from '../../context/POSAuthContext';
import RemoteDayClose from './RemoteDayClose';
import ShiftConfirmations from '../../components/ShiftConfirmations';   // A462: the manager confirms on the web too
import CountedCloseModal from '../../components/CountedCloseModal';     // A462: close someone else's drawer WITH a count
import { money } from '../../lib/format';

interface OpenShift {
  id: string;
  cashier_name: string;
  opened_at: string;
  opening_float: number;
  terminal_code: string | null;
  expected_cash_live: number | null;
}

export default function ManagerShiftTab({ currency }: { currency: string }) {
  const { posApi, hasPermission } = usePOSAuth();
  const canForceClose = hasPermission('shifts.force_close');
  // A462: a manager closes another person's drawer counted and confirms shifts — A490: shifts.confirm (the cloud's
  // own rule; it was orders.void / settings.manage, which stood for it).
  const canCountClose = hasPermission('shifts.confirm');
  // A490: a drawer's expected cash (and its shift report, which shows it) is reports.shifts or shifts.confirm.
  const seesExpected = hasPermission('reports.shifts') || canCountClose;
  const [counting, setCounting] = useState<OpenShift | null>(null);
  const [confirmKey, setConfirmKey] = useState(0);

  const [shifts, setShifts]   = useState<OpenShift[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const [target, setTarget]   = useState<OpenShift | null>(null);
  const [reason, setReason]   = useState('');
  const [busy, setBusy]       = useState(false);
  const [reportId, setReportId] = useState<string | null>(null);
  const [reportMsg, setReportMsg] = useState<{ id: string; text: string } | null>(null);

  const since = (iso: string) => {
    const h = Math.floor((Date.now() - new Date(iso).getTime()) / 3_600_000);
    return h < 1 ? 'under 1h' : `${h}h`;
  };

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      setShifts(await posApi.get<OpenShift[]>('/api/shifts?status=open&limit=100'));
    } catch (e: any) {
      setError(e?.message ?? 'Could not load shifts');
    } finally { setLoading(false); }
  }, [posApi]);
  useEffect(() => { void load(); }, [load]);

  const forceClose = async () => {
    if (!target || !reason.trim()) return;
    setBusy(true); setError('');
    try {
      await posApi.post(`/api/shifts/${target.id}/force-close`, { reason: reason.trim() });
      setTarget(null); setReason('');
      await load();
    } catch (e: any) {
      setError(e?.message ?? 'Could not force-close this shift');
    } finally { setBusy(false); }
  };

  return (
    <div className="p-6 space-y-5">
      <div>
        <h2 className="text-white text-lg font-semibold">Shifts</h2>
        <p className="text-gray-500 text-sm">Open drawers at your branch. A cashier closes their own drawer; a manager can close one <strong className="text-gray-300">with a count</strong> (each method, beside what it expects). Force-close (uncounted) only releases a drawer nobody can count.</p>
      </div>
      {error && <p className="text-red-400 text-sm">{error}</p>}

      {loading ? <p className="text-gray-500 text-sm">Loading…</p>
        : shifts.length === 0 ? (
          <div className="rounded-xl border border-dashed border-gray-800 p-8 text-center">
            <p className="text-gray-500 text-sm">No open shifts at your branch.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {shifts.map(s => (
              <div key={s.id}>
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 sm:gap-4">
                <div className="min-w-0">
                  <p className="text-white text-sm font-medium">{s.cashier_name}{s.terminal_code ? ` · ${s.terminal_code}` : ''}</p>
                  <p className="text-gray-500 text-xs">open {since(s.opened_at)} · float {money(s.opening_float, currency, { blank: 'unavailable' })}{seesExpected && <> · expected {money(s.expected_cash_live, currency, { blank: 'unavailable' })}</>}</p>
                </div>
                <div className="sm:flex-shrink-0 flex flex-wrap items-center gap-2">
                  {seesExpected && <button
                    onClick={async () => {
                      setReportId(s.id); setReportMsg(null);
                      const res = await printShiftReport(s.id);
                      setReportMsg({ id: s.id, text: res.message }); setReportId(null);
                    }}
                    disabled={reportId === s.id}
                    className="text-xs font-medium px-3 py-1.5 rounded-lg border border-swift/50 text-swift-text hover:bg-swift/10 transition-colors disabled:opacity-50">
                    {reportId === s.id ? 'Printing…' : 'Shift report'}
                  </button>}
                  {canCountClose && (
                    <button data-testid={`count-close-${s.id}`} onClick={() => setCounting(s)}
                      className="text-xs font-medium px-3 py-1.5 rounded-lg border border-swift/50 text-swift-text hover:bg-swift/10 transition-colors">
                      Close with count
                    </button>
                  )}
                  {canForceClose && (
                    <button onClick={() => { setTarget(s); setReason(''); }}
                      className="text-xs font-medium px-3 py-1.5 rounded-lg border border-red-500/50 text-red-400 hover:bg-red-500/10 transition-colors">
                      Force-close
                    </button>
                  )}
                </div>
              </div>
              {reportMsg?.id === s.id && (
                <p className="text-xs text-gray-500 mt-1 ml-1">{reportMsg.text}</p>
              )}
              </div>
            ))}
          </div>
        )}

      {/* A462: the shifts waiting for a manager's check — confirmed here, with what each method expects. */}
      {canCountClose && (
        <div className="pt-4 border-t border-gray-800">
          <ShiftConfirmations key={confirmKey} client={posApi as any} currency={currency} />
        </div>
      )}

      {counting && (
        <CountedCloseModal client={posApi as any} shift={counting} currency={currency}
          onCancel={() => setCounting(null)} onDone={() => { setCounting(null); setConfirmKey((k) => k + 1); void load(); }} />
      )}

      {/* A275 — remote day close for managers who aren't in the store. */}
      <div className="pt-4 border-t border-gray-800">
        <RemoteDayClose currency={currency} />
      </div>

      {target && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-2xl p-6 max-w-md w-full">
            <h3 className="text-white font-semibold">Force-close {target.cashier_name}’s drawer?</h3>
            <p className="text-gray-400 text-sm mt-1 mb-4">This records the drawer as <strong className="text-gray-200">uncounted</strong> — no closing count is taken. Use it only when the till is unreachable. A reason is required.</p>
            <textarea value={reason} onChange={e => setReason(e.target.value)}
              placeholder="e.g. till T2 crashed and won't restart"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-red-500" rows={3} />
            <div className="flex gap-3 mt-4">
              <button onClick={() => setTarget(null)} className="flex-1 bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm py-2.5 rounded-lg transition-colors">Cancel</button>
              <button onClick={() => void forceClose()} disabled={busy || !reason.trim()}
                className="flex-1 bg-red-500 hover:bg-red-400 disabled:opacity-40 text-white font-semibold text-sm py-2.5 rounded-lg transition-colors">
                {busy ? 'Closing…' : 'Force-close (uncounted)'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
