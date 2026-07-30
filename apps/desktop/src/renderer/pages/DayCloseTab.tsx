/**
 * DayCloseTab — the manager's end-of-day cash sign-off for THIS till.
 *
 * This is the escape route for the trading-day gate. The gate refuses to open a
 * new day, or to sell, while the previous day is still open — so without this
 * screen a till would be stranded the first morning nobody closed it. The
 * enforcement and the way out have to ship together.
 *
 * BLIND BY DEFAULT
 *   Expected cash is hidden until the manager has entered their count. This is
 *   the second count of the day — each cashier already counted their own drawer
 *   at their own close — and two counts by two people is the entire point. A
 *   counter who can see the target can close a shortage to zero without ever
 *   deciding to; showing the figure first quietly converts a control into
 *   paperwork. It can still be revealed, because someone investigating a known
 *   discrepancy has a legitimate reason to look, but it is a deliberate act.
 *
 * UNCOUNTED DRAWERS ARE CALLED OUT
 *   A day containing a force-closed shift is not "balanced" whatever the
 *   arithmetic says, because nobody counted that drawer. It is surfaced as its
 *   own line rather than folded into the totals.
 */

import { useCallback, useEffect, useState } from 'react';
import { posApi } from '../lib/posApi';

interface Props { currency: string }

interface Conflict {
  id: string;
  cashier_name: string;
  business_date: string | null;
  notes: string | null;
}

interface Summary {
  day: { id: string; business_date: string };
  shifts: number;
  unreconciledShifts: number;
  expectedCash: number;
  countedCash: number;
  variance: number;
}

export default function DayCloseTab({ currency }: Props) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [gate, setGate] = useState<{ canTrade: boolean; reason?: string } | null>(null);
  const [isManager, setIsManager] = useState(false);
  const [counted, setCounted] = useState('');
  const [notes, setNotes] = useState('');
  const [showExpected, setShowExpected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [result, setResult] = useState<Summary | null>(null);
  const [conflicts, setConflicts] = useState<Conflict[]>([]);

  const [loadError, setLoadError] = useState('');

  // Four INDEPENDENT calls, deliberately not Promise.all.
  //
  // With Promise.all, one rejection skipped every setState and the screen fell
  // through to "No trading day is open on this till" — which is not just unhelpful
  // but WRONG: a day was open, we simply could not ask. A UI that reports absence
  // when it means failure sends someone hunting for a data problem that does not
  // exist. (That is exactly what happened: day:conflicts threw "no such table:
  // staff" and blanked the whole tab.)
  const load = useCallback(async () => {
    setLoadError('');
    const fail = (what: string) => (e: unknown) => {
      console.error(`[DayClose] ${what} failed:`, e);
      setLoadError(`Could not read ${what}. The figures below may be incomplete.`);
      return null;
    };

    const [s, g, m, c] = await Promise.all([
      posApi.day.summary().catch(fail('the day summary')),
      posApi.day.gate().catch(fail('the trading-day status')),
      posApi.day.isManager().catch(fail('your permissions')),
      posApi.day.conflicts().catch(fail('unsynced shifts')),
    ]);

    setSummary((s ?? null) as Summary | null);
    setGate(g);
    setIsManager(m === true);
    setConflicts(Array.isArray(c) ? c : []);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const money = (v: number) =>
    `${currency} ${v.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const handleClose = async () => {
    const amount = Number(counted);
    if (!Number.isFinite(amount) || amount < 0) { setMsg('Enter the cash you counted'); return; }
    setBusy(true); setMsg('');
    const res = await posApi.day.close(amount, notes.trim() || undefined);
    setBusy(false);
    if (!res.ok) { setMsg(res.error ?? 'Could not close the day'); return; }
    setResult(res.summary as Summary);
    setCounted(''); setNotes(''); setShowExpected(false);
    await load();
  };

  if (result) {
    const over = result.variance > 0;
    return (
      <div className="max-w-xl space-y-4">
        <h2 className="text-lg font-semibold text-white">Day closed</h2>
        <div className="bg-gray-800/50 rounded-lg p-4 space-y-2 text-sm">
          <Row label="Trading date" value={result.day.business_date} />
          <Row label="Counted" value={money(result.countedCash)} />
          <Row label="Expected" value={money(result.expectedCash)} />
          <div className="border-t border-gray-700 pt-2">
            <Row
              label="Variance"
              value={`${over ? '+' : ''}${money(result.variance)}`}
              className={Math.abs(result.variance) < 0.005 ? 'text-green-400'
                : over ? 'text-amber-400' : 'text-red-400'}
            />
          </div>
        </div>
        <button onClick={() => setResult(null)}
          className="text-xs text-gray-400 hover:text-white transition-colors">
          Back
        </button>
      </div>
    );
  }

  if (!summary) {
    return (
      <div className="max-w-xl space-y-3">
        <h2 className="text-lg font-semibold text-white">Close the day</h2>
        {loadError && (
          <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3">
            <p className="text-sm text-red-300">{loadError}</p>
          </div>
        )}
        <p className="text-sm text-gray-400">
          No trading day is open on this till. A day opens automatically when the
          first cashier opens a drawer.
        </p>
        {gate && !gate.canTrade && (
          <p className="text-sm text-amber-400">{gate.reason}</p>
        )}
      </div>
    );
  }

  const stale = gate && !gate.canTrade;

  return (
    <div className="max-w-xl space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-white">Close the day</h2>
        <p className="text-sm text-gray-400">
          Trading date <span className="text-white">{summary.day.business_date}</span> on this till.
        </p>
      </div>

      {loadError && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3">
          <p className="text-sm text-red-300">{loadError}</p>
        </div>
      )}

      {/* Shifts the server refused. Shown first because each one is a cashier who
          cannot open a drawer anywhere until it is resolved — more urgent than
          today's cash-up, and invisible everywhere else in the app. */}
      {conflicts.length > 0 && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 space-y-2">
          <p className="text-sm text-red-300 font-medium">
            {conflicts.length === 1 ? 'A shift could not sync' : `${conflicts.length} shifts could not sync`}
          </p>
          {conflicts.map(c => (
            <div key={c.id} className="text-xs text-red-300/80">
              <span className="text-red-200">{c.cashier_name}</span>
              {c.business_date && <span className="text-red-400/60"> · {c.business_date}</span>}
              <p className="text-red-400/70">
                This cashier has an open drawer on another till. Close that one and this will sync.
              </p>
            </div>
          ))}
        </div>
      )}

      {stale && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3">
          <p className="text-sm text-amber-300">{gate?.reason}</p>
          <p className="text-xs text-amber-400/70 mt-1">
            This till cannot sell until this day is closed.
          </p>
        </div>
      )}

      {!isManager && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3">
          <p className="text-sm text-red-300">
            Only a manager can close the trading day. Ask a manager to sign in with their PIN.
          </p>
        </div>
      )}

      <div className="bg-gray-800/50 rounded-lg p-4 space-y-2 text-sm">
        <Row label="Drawers on this day" value={String(summary.shifts)} />
        {summary.unreconciledShifts > 0 && (
          <Row
            label="Drawers nobody counted"
            value={String(summary.unreconciledShifts)}
            className="text-amber-400"
          />
        )}
        <Row label="Cashiers' counted total" value={money(summary.countedCash)} />
      </div>

      {summary.unreconciledShifts > 0 && (
        <p className="text-xs text-amber-400/80">
          {summary.unreconciledShifts === 1 ? 'One drawer was' : `${summary.unreconciledShifts} drawers were`}{' '}
          force-closed without a count, so the expected figure below is incomplete
          for {summary.unreconciledShifts === 1 ? 'it' : 'them'}.
        </p>
      )}

      <div className="space-y-2">
        <label className="block text-sm text-gray-300">Cash you counted</label>
        <input
          type="number" min={0} step="0.01" inputMode="decimal"
          value={counted}
          disabled={!isManager || busy}
          onChange={e => setCounted(e.target.value)}
          placeholder="0.00"
          className="w-40 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-white
                     disabled:opacity-50"
        />
        {/* Expected stays hidden until asked for. Counting to a known figure is
            how a shortage becomes a zero without anyone deciding to. */}
        {showExpected ? (
          <p className="text-xs text-gray-400">
            Expected {money(summary.expectedCash)}
            {counted !== '' && (
              <span className="ml-2 text-gray-500">
                → variance {money(Number(counted) - summary.expectedCash)}
              </span>
            )}
          </p>
        ) : (
          <button onClick={() => setShowExpected(true)}
            className="block text-xs text-gray-500 hover:text-gray-300 transition-colors">
            Show expected cash (count first)
          </button>
        )}
      </div>

      <div className="space-y-1">
        <label className="block text-sm text-gray-300">Notes</label>
        <textarea
          rows={2} value={notes} disabled={!isManager || busy}
          onChange={e => setNotes(e.target.value)}
          placeholder="Anything that explains a difference"
          className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm
                     disabled:opacity-50"
        />
      </div>

      {msg && <p className="text-sm text-red-400">{msg}</p>}

      <button
        onClick={handleClose}
        disabled={!isManager || busy || counted === ''}
        className="bg-green-600 hover:bg-green-500 disabled:bg-gray-700 disabled:text-gray-500
                   text-white rounded-lg px-4 py-2 text-sm font-medium transition-colors"
      >
        {busy ? 'Closing…' : 'Count verified — close the day'}
      </button>
    </div>
  );
}

function Row({ label, value, className = '' }: { label: string; value: string; className?: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-gray-400">{label}</span>
      <span className={`text-white ${className}`}>{value}</span>
    </div>
  );
}
