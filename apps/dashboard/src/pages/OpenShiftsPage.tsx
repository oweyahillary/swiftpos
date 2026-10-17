/**
 * OpenShiftsPage — release a drawer stranded on a terminal that has died.
 *
 * ── WHY THIS PAGE EXISTS ────────────────────────────────────────────────────
 * Migration 42 enforces one open shift per cashier, business-wide. That is the
 * right accounting rule, but it created a failure mode:
 *
 *   1. A cashier opens a drawer on till 2 and trades.
 *   2. Till 2 dies — dead PSU, dead screen, Windows will not boot. Its shift row
 *      stays 'open', locally and in the cloud.
 *   3. She moves to till 3 and is refused: "You already have an open shift".
 *
 * Clearing it means force-closing that shift, and forceCloseShift() runs on the
 * machine holding it — the dead one. The server endpoint existed but nothing
 * called it, so the only remedy was editing the database by hand. A five-minute
 * hardware fault became a day-long outage for that cashier, on every till.
 *
 * It compounds too: the dead till's trading DAY is also left open, and a day close
 * refuses while a drawer on it is open. So the till stays blocked after repair
 * until the drawer is cleared — the thing that could not be reached.
 *
 * This lives in the dashboard rather than on a till precisely because it has to
 * work when the terminal is a paperweight.
 *
 * ── WHY IT IS DELIBERATELY AWKWARD ──────────────────────────────────────────
 * A one-click force-close would get used instead of counting drawers, and the
 * variance data would quietly become fiction. So: a reason is mandatory, the
 * expected cash is shown before confirming so the manager knows what they are
 * signing off as uncounted, and the shift stays permanently flagged
 * 'closed_unreconciled' — never 'closed'. It also surfaces in the day-close
 * summary as a drawer nobody counted.
 *
 * There is no time-based auto-release, and that is a decision rather than an
 * omission. Closing drawers on a schedule would record reconciliations nobody
 * performed, which is the one thing this whole design refuses to do.
 */

import { useCallback, useEffect, useState, Fragment } from 'react';
import { DESK, useRowMore, ViewMore, MoreRow } from '../components/RowMore';   // A464
import { api } from '../lib/api';
import Toast from '../components/Toast';
import ShiftConfirmations from '../components/ShiftConfirmations';
import CountedCloseModal from '../components/CountedCloseModal';   // A462
import { useToast } from '../hooks/useToast';
import { money, dateTime } from '../lib/format';
import { useBusiness } from '../context/BusinessContext';
import Pager, { usePageSize } from '../components/Pager';   // A475
import { paginate } from '../lib/paginate';
import { agoLabel, syncRecent, tillBehindLine } from '../lib/tillSync';   // A522

interface OpenShift {
  id: string;
  cashier_id: string;
  cashier_name: string;
  branch_id: string;
  opened_at: string;
  opening_float: number;
  status: string;
  terminal_code: string | null;
  device_id: string | null;
  /** A522: when this drawer's till last synced (null: never, or not a till). */
  till_last_sync_at?: string | null;
  /** Computed live by the server. Null when it could not be determined. */
  expected_cash_live: number | null;
}


function hoursOpen(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 3_600_000);
}

export default function OpenShiftsPage() {
  const currency = useBusiness().business?.currency ?? 'KES';
  const [shifts, setShifts] = useState<OpenShift[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [target, setTarget] = useState<OpenShift | null>(null);
  const [reason, setReason] = useState('');
  const [behindOk, setBehindOk] = useState(false);   // A522: the till has not synced lately — ticked before a force-close
  const [busy, setBusy] = useState(false);
  const [counting, setCounting] = useState<OpenShift | null>(null);   // A462: close with a count
  const [confirmKey, setConfirmKey] = useState(0);
  const { toast, showToast } = useToast();
  const more = useRowMore();   // A464: a phone shows Cashier, Expected cash and the actions

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setShifts(await api.get<OpenShift[]>('/api/shifts?status=open&limit=100'));
    } catch (e: any) {
      // Say it failed. An empty list here would read as "no stranded drawers",
      // which is the reassuring answer and possibly the wrong one.
      setError(e?.message ?? 'Could not load open shifts');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  // A475: the open drawers (up to 100) in pages (25 / 50 / 100, remembered in this browser); a release keeps the page
  // (clamped).
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = usePageSize('swiftpos.pageSize.openDrawers');
  const paged = paginate(shifts, page, pageSize);
  useEffect(() => { if (paged.page !== page) setPage(paged.page); }, [paged.page, page]);

  // A522: force-closing for a till that has not synced lately — its sales since are not in it (it adds them when back).
  const forceBehind = target?.device_id ? tillBehindLine(target.terminal_code ?? 'The till', target.till_last_sync_at ?? null) : null;

  const forceClose = async () => {
    if (!target) return;
    if (!reason.trim()) return;   // button is disabled, but never trust only that
    if (forceBehind && !behindOk) return;   // A522
    setBusy(true);
    try {
      await api.post(`/api/shifts/${target.id}/force-close`, { reason: reason.trim() });
      showToast('Drawer released. Recorded as uncounted.', 'success');
      setTarget(null);
      setReason('');
      await load();
    } catch (e: any) {
      showToast(e?.message ?? 'Could not force-close this shift', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="p-4 sm:p-6 space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-gray-900 dark:text-white">Open drawers</h1>
        <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
          Every shift currently open across the business. Use this to release a drawer
          stranded on a terminal that has failed — a cashier cannot open another
          drawer anywhere while one is still open.
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-900/20 p-3">
          <p className="text-sm text-red-700 dark:text-red-300">{error}</p>
        </div>
      )}

      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : shifts.length === 0 ? (
        <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-4 sm:p-8 text-center">
          <p className="text-sm text-gray-600 dark:text-gray-400">
            No drawers are open. Nothing to release.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 dark:bg-gray-800">
                <tr>
                  {['Cashier', 'Till', 'Opened', 'Opening float', 'Expected cash', ''].map(h => (
                    <th key={h} className={`px-4 py-2.5 text-left text-xs font-medium text-gray-600 dark:text-gray-400 ${['Till', 'Opened', 'Opening float'].includes(h) ? DESK : ''}`}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                {paged.items.map(s => {
                  const hrs = hoursOpen(s.opened_at);
                  // 18h matches STALE_SHIFT_HOURS on the till, so the two surfaces
                  // agree about when a drawer has stopped being plausible.
                  const stale = hrs >= 18;
                  return (
                    <Fragment key={s.id}>
                    <tr className="bg-white dark:bg-gray-900">
                      <td className="px-4 py-3 text-gray-900 dark:text-white">{s.cashier_name}
                        <ViewMore open={more.isOpen(String(s.id))} onClick={() => more.toggle(String(s.id))} />
                      </td>
                      <td className={`px-4 py-3 text-gray-600 dark:text-gray-400 ${DESK}`}>
                        {s.terminal_code ?? s.device_id ?? <span className="italic text-gray-400">unknown</span>}
                        {s.device_id && <div className={`text-xs ${syncRecent(s.till_last_sync_at) ? 'text-gray-400' : 'text-amber-600 dark:text-amber-400'}`} data-testid={`till-sync-${s.id}`}>synced {agoLabel(s.till_last_sync_at)}</div>}
                      </td>
                      <td className={`px-4 py-3 ${DESK}`}>
                        <span className={stale ? 'text-amber-600 dark:text-amber-400 font-medium' : 'text-gray-600 dark:text-gray-400'}>
                          {hrs}h ago
                        </span>
                        <div className="text-xs text-gray-400">{dateTime(s.opened_at)}</div>
                      </td>
                      <td className={`px-4 py-3 text-gray-600 dark:text-gray-400 tabular-nums ${DESK}`}>
                        {money(Number(s.opening_float), currency, { blank: 'unavailable' })}
                      </td>
                      <td className="px-4 py-3 font-medium text-gray-900 dark:text-white tabular-nums">
                        {money(s.expected_cash_live, currency, { blank: 'unavailable' })}
                      </td>
                      <td className="px-4 py-3 text-right whitespace-nowrap">
                        <button data-testid={`count-close-${s.id}`} onClick={() => setCounting(s)}
                          className="mr-2 text-xs px-3 py-1.5 rounded-md border border-swift/50 text-swift-text hover:bg-swift/10 transition-colors">
                          Close with count
                        </button>
                        <button
                          onClick={() => { setTarget(s); setReason(''); setBehindOk(false); }}
                          className="text-xs px-3 py-1.5 rounded-md border border-red-300 text-red-700
                                     hover:bg-red-50 dark:border-red-800 dark:text-red-400
                                     dark:hover:bg-red-900/20 transition-colors"
                        >
                          Force close
                        </button>
                      </td>
                    </tr>
                    <MoreRow open={more.isOpen(String(s.id))} colSpan={3} items={[
                      ['Till', s.terminal_code ?? s.device_id ?? <span className="italic text-gray-400">unknown</span>],
                      ['Opened', <>
                        <span className={stale ? 'text-amber-600 dark:text-amber-400 font-medium' : 'text-gray-600 dark:text-gray-400'}>
                          {hrs}h ago
                        </span>
                        <div className="text-xs text-gray-400">{dateTime(s.opened_at)}</div>
                      </>],
                      ['Opening float', <span className="tabular-nums">{money(Number(s.opening_float), currency, { blank: 'unavailable' })}</span>],
                    ]} />
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          <Pager paged={paged} noun="drawers" onPage={setPage} onSize={n => { setPageSize(n); setPage(1); }} />
        </div>
      )}

      <p className="text-xs text-gray-500 dark:text-gray-500">
        Force-closing records the drawer as <strong>uncounted</strong> — no closing
        float and no variance, because nobody counted it. Only use it when the
        terminal cannot be reached. If the till still works, count the drawer there — or use
        <strong> Close with count</strong>: you count each method here and it closes counted, under your name.
      </p>

      {/* A365: shifts awaiting a manager's check, and who confirmed what. A462: what each method expects is shown. */}
      <ShiftConfirmations key={confirmKey} currency={currency} />

      {counting && (
        <CountedCloseModal client={api as any} shift={counting} currency={currency}
          onCancel={() => setCounting(null)}
          onDone={() => { setCounting(null); setConfirmKey((k) => k + 1); showToast('Closed with your count — confirm it below.', 'success'); void load(); }} />
      )}

      {/* Confirmation. Shows the figure being written off, and will not proceed
          without a reason: an unexplained hole in the cash record is worse than
          the open shift it replaces. */}
      {target && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
          <div className="bg-white dark:bg-gray-900 rounded-xl w-full max-w-md border border-gray-200 dark:border-gray-700 max-h-[90vh] overflow-y-auto">
            <div className="px-5 pt-5 pb-3 border-b border-gray-200 dark:border-gray-700">
              <h2 className="text-base font-semibold text-gray-900 dark:text-white">
                Force close {target.cashier_name}'s drawer
              </h2>
              <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                {target.terminal_code ?? 'Unknown till'} · open {hoursOpen(target.opened_at)}h
              </p>
            </div>

            <div className="px-5 py-4 space-y-3">
              <div className="rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 p-3">
                <p className="text-sm text-amber-800 dark:text-amber-200">
                  Expected in the drawer: <strong>{money(target.expected_cash_live, currency, { blank: 'unavailable' })}</strong>
                </p>
                <p className="text-xs text-amber-700 dark:text-amber-300 mt-1">
                  This will be recorded as never counted. The variance stays blank —
                  not zero — because no one verified it.
                </p>
              </div>

              <div>
                <label className="block text-sm text-gray-700 dark:text-gray-300 mb-1">
                  Reason <span className="text-red-500">*</span>
                </label>
                <textarea
                  rows={2}
                  value={reason}
                  onChange={e => setReason(e.target.value)}
                  placeholder="e.g. Till 2 power supply failed, cash secured in safe"
                  className="w-full rounded-lg border border-gray-300 dark:border-gray-700
                             bg-white dark:bg-gray-950 px-3 py-2 text-sm
                             text-gray-900 dark:text-white"
                />
                {forceBehind && (
                  <label className="flex gap-2 items-start mt-3 text-xs text-amber-700 dark:text-amber-300" data-testid="force-behind">
                    <input type="checkbox" checked={behindOk} onChange={e => setBehindOk(e.target.checked)} className="mt-0.5" />
                    <span>{forceBehind}</span>
                  </label>
                )}
                <p className="text-xs text-gray-500 mt-1">
                  Recorded against the shift permanently. This is the only explanation
                  anyone auditing the day will have.
                </p>
              </div>
            </div>

            <div className="px-5 pb-5 flex gap-2 justify-end">
              <button
                onClick={() => { setTarget(null); setReason(''); }}
                disabled={busy}
                className="px-3 py-2 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900
                           dark:hover:text-white transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={forceClose}
                disabled={busy || !reason.trim() || (!!forceBehind && !behindOk)}
                className="px-4 py-2 text-sm rounded-lg bg-red-600 hover:bg-red-500
                           disabled:bg-gray-300 dark:disabled:bg-gray-700 disabled:text-gray-500
                           text-white font-medium transition-colors"
              >
                {busy ? 'Releasing…' : 'Force close as uncounted'}
              </button>
            </div>
          </div>
        </div>
      )}

      <Toast toast={toast} />
    </div>
  );
}
