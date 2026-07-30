/**
 * ReportRangeBar — date range + CSV export, shared by every report tab.
 *
 * ONE COMPONENT ON PURPOSE
 *   The printer settings existed twice and drifted, so the calibration ticket sat
 *   on a screen nobody used while the screen managers actually open never got it.
 *   Range selection and export are going on several tabs; sharing the control is
 *   what stops the same thing happening again.
 *
 * IT ALWAYS SHOWS WHAT THE FIGURES COVER
 *   A till holds only its own orders — only the aggregation node holds the whole
 *   branch. A manager reading a week's total off till 2 and treating it as the
 *   shop's takings would be wrong by whatever tills 1 and 3 sold, with nothing on
 *   screen to suggest anything was missing. So the scope line is not optional
 *   chrome; it is the thing that makes a partial report safe to use.
 */

import { useEffect, useState } from 'react';
import { posApi } from '../lib/posApi';
import type { ReportRangeArg } from '../lib/posApi';

type Preset = NonNullable<ReportRangeArg['preset']>;

const PRESETS: { key: Preset; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'last7', label: '7 days' },
  { key: 'last30', label: '30 days' },
  { key: 'month', label: 'This month' },
  { key: 'custom', label: 'Custom' },
];

interface Props {
  value: ReportRangeArg;
  onChange: (range: ReportRangeArg) => void;
  /** Omit to hide the CSV button (e.g. on a live Z-report). */
  exportKind?: 'sales' | 'orders' | 'products';
  /** Show the Daily Sales Report (.xlsx) button — the incumbent's layout. */
  showDailyReport?: boolean;
}

export default function ReportRangeBar({ value, onChange, exportKind, showDailyReport }: Props) {
  const [scope, setScope] = useState<{ scopeLabel: string; coversBranch: boolean; earliestOrder: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    posApi.manager.reportScope()
      .then(s => setScope(s))
      .catch(() => setScope(null));   // scope is informational; never block the report
  }, []);

  const preset = value.preset ?? 'today';
  const today = new Date().toISOString().slice(0, 10);

  const download = async () => {
    if (!exportKind) return;
    setBusy(true);
    setMsg('');
    try {
      const res = await posApi.manager.exportCsv({ kind: exportKind, ...value });
      // Cancelling the save dialog returns ok:false with no error. That is a
      // normal outcome and must stay silent — an error toast for "I changed my
      // mind" teaches people to ignore error toasts.
      if (res.ok && res.path) setMsg(`Saved to ${res.path}`);
      else if (res.error) setMsg(res.error);
    } catch (err: any) {
      setMsg(err?.message ?? 'Could not export');
    } finally {
      setBusy(false);
    }
  };

  const dailyReport = async () => {
    setBusy(true);
    setMsg('');
    try {
      const res = await posApi.manager.dailyReport(value);
      if (res.ok && res.path) setMsg(`Saved to ${res.path}`);
      else if (res.error) setMsg(res.error);
    } catch (err: any) {
      setMsg(err?.message ?? 'Could not export');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-gray-800/40 border border-gray-700 rounded-xl px-3 py-2.5 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg overflow-hidden border border-gray-700">
          {PRESETS.map(p => (
            <button
              key={p.key}
              onClick={() => onChange({ ...value, preset: p.key })}
              className={`px-2.5 py-1.5 text-xs transition-colors ${
                preset === p.key ? 'bg-green-500/10 text-green-400' : 'bg-gray-800 text-gray-400 hover:text-white'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>

        {preset === 'custom' && (
          <div className="flex items-center gap-1.5">
            <input
              type="date" max={today}
              value={value.from ?? today}
              onChange={e => onChange({ ...value, preset: 'custom', from: e.target.value })}
              className="bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-white"
            />
            <span className="text-xs text-gray-500">to</span>
            <input
              type="date" max={today}
              value={value.to ?? today}
              onChange={e => onChange({ ...value, preset: 'custom', to: e.target.value })}
              className="bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-white"
            />
          </div>
        )}

        <div className="ml-auto flex items-center gap-2">
          {showDailyReport && (
            <button
              onClick={dailyReport}
              disabled={busy}
              className="flex items-center gap-1.5 text-xs text-white bg-green-600/80
                         hover:bg-green-600 rounded-lg px-3 py-1.5 disabled:opacity-50
                         transition-colors"
            >
              {busy ? 'Saving…' : '⭳ Daily Sales Report (Excel)'}
            </button>
          )}
          {exportKind && (
            <button
              onClick={download}
              disabled={busy}
              className="flex items-center gap-1.5 text-xs text-gray-200 hover:text-white
                         border border-gray-600 hover:border-gray-500 rounded-lg px-3 py-1.5
                         disabled:opacity-50 transition-colors"
            >
              {busy ? 'Saving…' : '⭳ CSV'}
            </button>
          )}
        </div>
      </div>

      {/* Scope. Amber when this is one till's data, because that is the case a
          manager can misread as the whole shop. */}
      {scope && (
        <p className={`text-[11px] ${scope.coversBranch ? 'text-gray-500' : 'text-amber-400/80'}`}>
          {scope.coversBranch ? '✓ ' : '⚠ '}{scope.scopeLabel}
          {scope.earliestOrder && (
            <span className="text-gray-600">
              {' '}· local data from {scope.earliestOrder.slice(0, 10)}
            </span>
          )}
        </p>
      )}

      {msg && <p className="text-[11px] text-gray-300 break-all">{msg}</p>}
    </div>
  );
}
