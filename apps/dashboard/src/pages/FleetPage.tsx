/**
 * FleetPage — is every terminal healthy right now?
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * Tills are updated by replacing an installer by hand, one machine at a time, so
 * the fleet drifts and nothing anywhere said which one was behind. `app_version`
 * has been recorded at sign-in since migration 36, but it was only ever visible
 * buried in the device-approval list, sorted by request date.
 *
 * ── THE COLUMN THAT MATTERS IS "LAST SYNC", NOT "LAST SEEN" ─────────────────
 * `last_seen_at` is written at sign-in. A till that signed in at 07:00 and has
 * silently failed to sync since 07:05 — network unplugged, or its queue wedged on
 * a rejected row — looks perfectly healthy by that measure. The first sign of
 * trouble is the day's takings arriving short in the cloud, hours later, with the
 * sales sitting on a machine nobody is looking at.
 *
 * So rows are ordered by silence, worst first, and never-synced sorts above
 * everything. The terminal needing attention should not be somewhere in the
 * middle of a list ordered by something else.
 *
 * ── WHY THE REQUIRED SCHEMA COMES FROM THE SERVER ───────────────────────────
 * The server echoes `requiredSchema` rather than the dashboard hardcoding it.
 * Hardcoded, the two would drift the moment one was deployed without the other,
 * and this screen would cheerfully report every till as current while
 * /api/sync/push was warning them all that they were behind.
 */

import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';

interface FleetDevice {
  id: string;
  deviceId: string | null;
  label: string | null;
  user: string | null;
  appVersion: string | null;
  schemaVersion: number | null;
  lastSeenAt: string | null;
  lastSyncAt: string | null;
  hoursSinceSync: number | null;
  hoursSinceSeen: number | null;
  // A184 Tier 1 — identity
  terminalCode: string | null;
  role: string | null;
  branchName: string | null;
  mac: string | null;
  // A184 Tier 2 — active session
  activeShift: { cashier: string | null; openedAt: string | null } | null;
  // A184 Tier 3 — retirement
  retiredAt: string | null;
}

interface FleetResponse {
  fleet: FleetDevice[];
  requiredSchema: number;
}

/**
 * Silence thresholds.
 *
 * 4 hours, not minutes: a till legitimately goes quiet over a slow afternoon or a
 * power cut, and an alarm that fires on every quiet hour is an alarm nobody reads.
 * 12 hours means it has missed a whole trading session.
 */
const WARN_HOURS = 4;
const ALERT_HOURS = 12;

function syncState(d: FleetDevice): { label: string; tone: 'ok' | 'warn' | 'alert' | 'unknown' } {
  if (d.lastSyncAt === null) return { label: 'never synced', tone: 'alert' };
  const h = d.hoursSinceSync ?? 0;
  if (h >= ALERT_HOURS) return { label: `${h}h ago`, tone: 'alert' };
  if (h >= WARN_HOURS) return { label: `${h}h ago`, tone: 'warn' };
  return { label: h < 1 ? 'just now' : `${h}h ago`, tone: 'ok' };
}

const TONE: Record<string, string> = {
  ok: 'text-green-600 dark:text-green-400',
  warn: 'text-amber-600 dark:text-amber-400',
  alert: 'text-red-600 dark:text-red-400',
  unknown: 'text-gray-400',
};

export default function FleetPage() {
  const [data, setData] = useState<FleetResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftLabel, setDraftLabel] = useState('');
  // A184 Tier 3 — toggle between live fleet and the retired archive.
  const [showRetired, setShowRetired] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const saveLabel = useCallback(async (id: string) => {
    const label = draftLabel.trim();
    try {
      await api.patch(`/api/devices/${id}/label`, { label });
      setData(prev => prev
        ? { ...prev, fleet: prev.fleet.map(f => f.id === id ? { ...f, label: label || null } : f) }
        : prev);
      setEditingId(null);
    } catch (e: any) {
      setError(e?.message ?? 'Could not rename the terminal');
    }
  }, [draftLabel]);

  // A184 Tier 3 — retire drops the row out of the current list; restore does the same
  // from the archive. Either way we remove it locally so the view stays accurate.
  const setRetired = useCallback(async (id: string, retire: boolean) => {
    setBusyId(id);
    setError('');
    try {
      await api.patch(`/api/devices/${id}/${retire ? 'retire' : 'unretire'}`, {});
      setData(prev => prev ? { ...prev, fleet: prev.fleet.filter(f => f.id !== id) } : prev);
    } catch (e: any) {
      setError(e?.message ?? (retire ? 'Could not retire the terminal' : 'Could not restore the terminal'));
    } finally {
      setBusyId(null);
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setData(await api.get<FleetResponse>(`/api/devices/fleet${showRetired ? '?retired=1' : ''}`));
    } catch (e: any) {
      // Say it failed. An empty table would read as "no terminals", which is the
      // reassuring answer and almost certainly the wrong one.
      setError(e?.message ?? 'Could not load the fleet');
    } finally {
      setLoading(false);
    }
  }, [showRetired]);

  useEffect(() => { void load(); }, [load]);

  const fleet = data?.fleet ?? [];
  const required = data?.requiredSchema ?? null;
  const behind = fleet.filter(d => required !== null && (d.schemaVersion ?? 0) < required);
  const silent = fleet.filter(d => d.lastSyncAt === null || (d.hoursSinceSync ?? 0) >= WARN_HOURS);

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-gray-900 dark:text-white">Terminals</h1>
          <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
            Which build each till is running, and when it last synced. Tills are
            updated by hand, so this is the only place that shows the fleet drifting.
          </p>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="text-xs px-3 py-1.5 rounded-lg border border-gray-300 dark:border-gray-700
                     text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800
                     disabled:opacity-50 transition-colors"
        >
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-900/20 p-3">
          <p className="text-sm text-red-700 dark:text-red-300">{error}</p>
        </div>
      )}

      {!loading && fleet.length > 0 && (silent.length > 0 || behind.length > 0) && (
        <div className="flex flex-wrap gap-3">
          {silent.length > 0 && (
            <div className="rounded-lg border border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-900/20 px-3 py-2">
              <p className="text-sm text-red-700 dark:text-red-300">
                <strong>{silent.length}</strong> terminal{silent.length === 1 ? '' : 's'} not syncing
              </p>
              <p className="text-xs text-red-600/80 dark:text-red-400/80">
                Sales may be sitting on the machine, uncounted in the cloud.
              </p>
            </div>
          )}
          {behind.length > 0 && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-900/20 px-3 py-2">
              <p className="text-sm text-amber-800 dark:text-amber-200">
                <strong>{behind.length}</strong> on an older schema
              </p>
              <p className="text-xs text-amber-700/80 dark:text-amber-300/80">
                Still trading — install the current build when convenient.
              </p>
            </div>
          )}
        </div>
      )}

      {/* A184 Tier 3 — switch between the live fleet and the retired archive. */}
      <div className="flex items-center gap-1 text-sm">
        <button
          onClick={() => setShowRetired(false)}
          className={`px-3 py-1 rounded-lg ${!showRetired ? 'bg-gray-900 text-white dark:bg-white dark:text-gray-900' : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'}`}
        >Live</button>
        <button
          onClick={() => setShowRetired(true)}
          className={`px-3 py-1 rounded-lg ${showRetired ? 'bg-gray-900 text-white dark:bg-white dark:text-gray-900' : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'}`}
        >Retired</button>
      </div>

      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : fleet.length === 0 ? (
        <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-8 text-center">
          <p className="text-sm text-gray-600 dark:text-gray-400">
            {showRetired
              ? 'No retired terminals. Retiring a dead till moves it here and out of the health view.'
              : 'No approved terminals yet. A till appears here once it has been approved and someone has signed in on it.'}
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-800">
              <tr>
                {['Terminal', 'On shift', 'App', 'Schema', 'Last sync', 'Last sign-in'].map(h => (
                  <th key={h} className="px-4 py-2.5 text-left text-xs font-medium text-gray-600 dark:text-gray-400">
                    {h}
                  </th>
                ))}
                <th key="actions" className="px-4 py-2.5 text-right text-xs font-medium text-gray-600 dark:text-gray-400"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
              {fleet.map(d => {
                const sync = syncState(d);
                const schemaBehind = required !== null && (d.schemaVersion ?? 0) < required;
                return (
                  <tr key={d.id} className="bg-white dark:bg-gray-900">
                    <td className="px-4 py-3">
                      {editingId === d.id ? (
                        <div className="flex items-center gap-1.5">
                          <input
                            value={draftLabel}
                            onChange={e => setDraftLabel(e.target.value)}
                            autoFocus
                            placeholder="e.g. Front counter"
                            onKeyDown={e => {
                              if (e.key === 'Enter') void saveLabel(d.id);
                              if (e.key === 'Escape') setEditingId(null);
                            }}
                            className="bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded px-2 py-1 text-sm text-gray-900 dark:text-white focus:outline-none focus:border-green-500 w-40"
                          />
                          <button onClick={() => void saveLabel(d.id)} className="text-green-500 hover:text-green-400 text-sm" title="Save">✓</button>
                          <button onClick={() => setEditingId(null)} className="text-gray-400 hover:text-gray-200 text-sm" title="Cancel">✕</button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2 group">
                          <span className="text-gray-900 dark:text-white">
                            {d.label ?? <span className="italic text-gray-400">unlabelled</span>}
                          </span>
                          <button
                            onClick={() => { setEditingId(d.id); setDraftLabel(d.label ?? ''); }}
                            className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-xs transition-opacity"
                            title="Rename terminal"
                          >✎</button>
                        </div>
                      )}
                      <div className="text-xs text-gray-400 font-mono">
                        {/* Truncated: the full id is a uuid and would push every
                            other column off screen. Enough to tell tills apart. */}
                        {d.terminalCode
                          ? <span className="font-sans font-medium text-gray-600 dark:text-gray-300">{d.terminalCode}</span>
                          : (d.deviceId ? d.deviceId.slice(0, 8) : 'no device id')}
                        {d.user && <span className="ml-2 font-sans">· {d.user}</span>}
                      </div>
                      {/* A184 Tier 1 — role · branch, and the MAC (the tell for a
                          reinstalled duplicate). MAC is blank until the A182 desktop
                          build ships and the till has reported it. */}
                      <div className="text-xs text-gray-400 mt-0.5">
                        {(d.role || d.branchName)
                          ? <>{d.role ?? '—'}{d.branchName ? ` · ${d.branchName}` : ''}</>
                          : null}
                      </div>
                      {d.mac && <div className="text-[11px] text-gray-400 font-mono">{d.mac}</div>}
                    </td>
                    <td className="px-4 py-3">
                      {/* A184 Tier 2 — who is on shift right now. */}
                      {d.activeShift ? (
                        <div className="flex items-center gap-1.5">
                          <span className="w-2 h-2 rounded-full bg-green-500 flex-shrink-0" title="Shift open" />
                          <span className="text-gray-700 dark:text-gray-300 text-sm">{d.activeShift.cashier ?? 'On shift'}</span>
                        </div>
                      ) : (
                        <span className="text-gray-400 text-sm">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-600 dark:text-gray-400 tabular-nums">
                      {d.appVersion ?? <span className="italic text-gray-400">not reported</span>}
                    </td>
                    <td className="px-4 py-3 tabular-nums">
                      {d.schemaVersion === null ? (
                        <span className="italic text-gray-400">not reported</span>
                      ) : (
                        <span className={schemaBehind ? TONE.warn : TONE.ok}>
                          {d.schemaVersion}
                          {schemaBehind && required !== null && (
                            <span className="text-xs text-gray-500"> / {required}</span>
                          )}
                        </span>
                      )}
                    </td>
                    <td className={`px-4 py-3 font-medium ${TONE[sync.tone]}`}>
                      {sync.label}
                      {d.lastSyncAt && (
                        <div className="text-xs text-gray-400 font-normal">
                          {new Date(d.lastSyncAt).toLocaleString('en-KE')}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-500 dark:text-gray-500">
                      {d.lastSeenAt
                        ? `${d.hoursSinceSeen}h ago`
                        : <span className="italic text-gray-400">never</span>}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {/* A184 Tier 3 — retire a dead till (reversible from the Retired tab). */}
                      {showRetired ? (
                        <button
                          onClick={() => void setRetired(d.id, false)}
                          disabled={busyId === d.id}
                          className="text-xs text-green-600 hover:text-green-500 disabled:opacity-40"
                        >{busyId === d.id ? '…' : 'Restore'}</button>
                      ) : (
                        <button
                          onClick={() => { if (confirm(`Retire ${d.label ?? d.terminalCode ?? 'this terminal'}? It leaves the health view but keeps its history. You can restore it later.`)) void setRetired(d.id, true); }}
                          disabled={busyId === d.id}
                          className="text-xs text-gray-400 hover:text-red-500 disabled:opacity-40"
                        >{busyId === d.id ? '…' : 'Retire'}</button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-gray-500 dark:text-gray-500">
        <strong>Last sync</strong> is when the terminal last pushed sales. It matters
        more than sign-in: a till can be signed in and trading while silently failing
        to sync, and nothing else in SwiftPOS would show it.
        Amber past {WARN_HOURS}h, red past {ALERT_HOURS}h.
      </p>
    </div>
  );
}
