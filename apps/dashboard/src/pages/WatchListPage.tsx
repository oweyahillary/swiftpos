import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { usePermissions } from '../context/PermissionsContext';
import { useBranch } from '../context/BranchContext';

// A576 — the Watch list: loss-prevention alerts for the owner and managers (reports.voids), never on a till.
//
// Owner, 2026-10-23: voids and discounts are a WARNING ONLY, for investigation — never an accusation, never "KES to
// recover"; plain words; at most 10. The cloud works the alerts out every hour (jobs/lossAlerts.ts) and keeps the ten most
// worth a look; each says what happened, against the others, and links to the list behind it. "Looked into" takes one off.

export interface WatchAlert {
  id: string; kind: string; label: string; period: 'day' | 'week'; business_date: string;
  branch_id: string | null; branch_name: string; staff_id: string | null; staff_name: string;
  count: number; amount: number | null; peer_low: number | null; peer_high: number | null;
  message: string; link: string | null; notified_at: string | null;
}
export interface WatchList { alerts: WatchAlert[]; total: number; top: number; ready: boolean }

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function dayLabel(a: Pick<WatchAlert, 'period' | 'business_date'>): string {
  const [, m, d] = a.business_date.split('-').map(Number);
  return a.period === 'week' ? `7 days to ${d} ${MON[m - 1]}` : `${d} ${MON[m - 1]}`;
}

export function WatchListView({ data, isOwner, onDismiss, busy, portal = false }: {
  data: WatchList; isOwner: boolean; onDismiss?: (id: string) => void; busy?: string | null;
  /** The manager portal: the dashboard's report links are not theirs — the portal's Reports page is. */
  portal?: boolean;
}) {
  const shown = data.alerts.slice(0, data.top || 10);
  return (
    <div className="p-4 sm:p-6 w-full max-w-4xl" data-testid="watch-list">
      <div className="mb-5">
        <h1 className="text-xl font-semibold text-gray-900 dark:text-white">Watch list</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
          Unusual patterns from the last 7 days, most worth a look first. A warning to look into, not a finding — there is often
          a simple reason.
        </p>
      </div>

      {!data.ready && (
        <p className="text-sm text-amber-600 dark:text-amber-400" data-testid="watch-not-ready">
          The watch list starts once the cloud update (migration 166) is in place.
        </p>
      )}

      {data.ready && shown.length === 0 && (
        <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-6 text-sm text-gray-600 dark:text-gray-300" data-testid="watch-empty">
          Nothing unusual in the last 7 days.
        </div>
      )}

      {shown.length > 0 && (
        <ol className="space-y-3" data-testid="watch-items">
          {shown.map((a, i) => (
            <li key={a.id} className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-4 flex gap-4" data-testid="watch-item">
              <span className="flex-shrink-0 w-7 h-7 rounded-full bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300 text-sm font-semibold flex items-center justify-center">{i + 1}</span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-gray-500 dark:text-gray-400 mb-1">
                  <span className="font-medium text-gray-700 dark:text-gray-200">{a.label}</span>
                  <span aria-hidden="true">·</span><span>{dayLabel(a)}</span>
                  {a.branch_name && <><span aria-hidden="true">·</span><span>{a.branch_name}</span></>}
                </div>
                <p className="text-sm text-gray-900 dark:text-gray-100">{a.message}</p>
                <div className="mt-2 flex flex-wrap items-center gap-3">
                  {a.link && !portal && <Link to={a.link} className="text-sm font-medium text-swift-text hover:underline">See the list →</Link>}
                  {onDismiss && (
                    <button type="button" onClick={() => onDismiss(a.id)} disabled={busy === a.id}
                      className="text-sm text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 disabled:opacity-50">
                      {busy === a.id ? 'Saving…' : 'Looked into'}
                    </button>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}

      {data.total > shown.length && (
        <p className="text-xs text-gray-500 mt-3">Showing the {shown.length} most worth a look of {data.total}. Mark one looked into to see the next.</p>
      )}

      <p className="text-xs text-gray-500 dark:text-gray-400 mt-6">
        {isOwner
          ? <>Which patterns, the amounts and who is told: <Link to="/dashboard/settings/business/loss-alerts" className="text-swift-text hover:underline">Settings › Business › Loss prevention</Link>.</>
          : `The owner chooses which patterns are watched and who is told.${portal ? ' The lists behind them: Reports › Voids & Exceptions.' : ''}`}
        {' '}Only the owner and managers see this — never the till.
      </p>
    </div>
  );
}

/** The calls the list makes — the owner's dashboard client, or the manager portal's session (POSAuthContext posApi). */
export interface WatchClient {
  get: <T>(path: string) => Promise<T>;
  patch: <T>(path: string, body: unknown) => Promise<T>;
}

/**
 * The list with its loading and "Looked into" — no context hooks, so the manager portal (/manager, outside the dashboard's
 * providers) shows it with its own session: a manager who signs in there with reports.voids sees their branch's alerts.
 */
export function WatchListPanel({ client = api, isOwner, reloadKey, portal = false }: { client?: WatchClient; isOwner: boolean; reloadKey?: string | null; portal?: boolean }) {
  const [data, setData] = useState<WatchList | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  // The portal's client is a new object each render: read it through a ref, so loading never loops.
  const clientRef = useRef(client);
  clientRef.current = client;

  const load = useCallback(async () => {
    setError('');
    try { setData(await clientRef.current.get<WatchList>('/api/loss-alerts')); }
    catch (e: any) { setError(e?.message ?? 'Could not load the watch list'); }
  }, []);
  useEffect(() => { load(); }, [load, reloadKey]);

  const dismiss = async (id: string) => {
    setBusy(id);
    try { await clientRef.current.patch(`/api/loss-alerts/${id}/dismiss`, {}); await load(); }
    catch (e: any) { setError(e?.message ?? 'Could not save'); }
    finally { setBusy(null); }
  };

  if (error && !data) return <div className="p-6 text-sm text-red-500">{error}</div>;
  if (!data) return <div className="p-6 text-sm text-gray-500">Loading…</div>;
  return (
    <>
      {error && <div className="px-6 pt-4 text-sm text-red-500">{error}</div>}
      <WatchListView data={data} isOwner={isOwner} onDismiss={dismiss} busy={busy} portal={portal} />
    </>
  );
}

/** Dashboard › Watch list (the owner, partners): the branch picked reloads it. */
export default function WatchListPage() {
  const { isOwner } = usePermissions();
  const { activeBranchId } = useBranch();
  return <WatchListPanel isOwner={isOwner} reloadKey={activeBranchId} />;
}
