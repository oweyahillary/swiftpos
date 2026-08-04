/**
 * BranchCloseTab — Phase 4: close every till's trading day from the branch server.
 *
 * WHAT THE MANAGER SEES
 *   One row per till: its reported day state (and how old that report is), a
 *   counted-cash field, and a Close button. Below, a roll-up of what has been
 *   counted so far. A till the node has not heard from recently is marked
 *   stale rather than hidden — a branch close that silently omits a terminal
 *   looks identical to a complete one, which is the failure this screen must
 *   never produce.
 *
 * WHAT THIS SCREEN DOES NOT DO
 *   - It shows no expected cash before a count is entered — same blind rule as
 *     the per-till Close Day screen, held harder here because a manager could
 *     otherwise read every till's target off one page.
 *   - It computes no cash figures itself. Counted cash goes to the till; the
 *     till answers with expected and variance from its own books. The node's
 *     replicated copies are not consulted for money.
 *   - It never pretends. A till that does not ack stays visibly "waiting"; a
 *     till that refuses shows the refusal verbatim ("a drawer is still open").
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { posApi } from '../lib/posApi';

interface Props { currency: string }

type Overview = Extract<Awaited<ReturnType<typeof posApi.branchClose.overview>>, { tills: any }>;
type TillView = Overview['tills'][number];

export default function BranchCloseTab({ currency }: Props) {
  const [ov, setOv] = useState<Overview | null>(null);
  const [err, setErr] = useState('');
  const [role, setRole] = useState<string | null>(null);
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [rowMsg, setRowMsg] = useState<Record<string, string>>({});
  const alive = useRef(true);

  const load = useCallback(async () => {
    const r = await posApi.branchClose.overview().catch(() => ({ error: 'Could not read the branch state' }));
    if (!alive.current) return;
    if ('error' in r) { setErr(r.error); return; }
    setErr('');
    setOv(r);
  }, []);

  useEffect(() => {
    alive.current = true;
    posApi.config.get().then(c => { if (alive.current) setRole(c?.device_role ?? 'till'); }).catch(() => setRole('till'));
    void load();
    // 5s while this screen is open: instructions resolve on the peers' 15s
    // poll, and the manager is standing here watching for exactly that.
    const t = setInterval(() => { void load(); }, 5_000);
    return () => { alive.current = false; clearInterval(t); };
  }, [load]);

  const money = (v: number) =>
    `${currency} ${Number(v || 0).toLocaleString('en-KE', { minimumFractionDigits: 2 })}`;

  const ageOf = (iso: string | null): { label: string; stale: boolean } => {
    if (!iso) return { label: 'never', stale: true };
    const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
    if (s < 45) return { label: `${s}s ago`, stale: false };
    if (s < 3600) return { label: `${Math.floor(s / 60)}m ago`, stale: s > 120 };
    return { label: `${Math.floor(s / 3600)}h ago`, stale: true };
  };

  const closeTill = async (t: TillView) => {
    const amount = Number(counts[t.device_id]);
    if (!Number.isFinite(amount) || amount < 0) {
      setRowMsg(m => ({ ...m, [t.device_id]: 'Enter the cash you counted for this till first.' }));
      return;
    }
    setBusy(t.device_id);
    setRowMsg(m => ({ ...m, [t.device_id]: '' }));
    try {
      const r = await posApi.branchClose.closeTill(t.device_id, amount, notes[t.device_id] || undefined);
      if (!r.ok) {
        setRowMsg(m => ({ ...m, [t.device_id]: r.error ?? 'Could not close this till.' }));
      } else if (r.self) {
        setRowMsg(m => ({ ...m, [t.device_id]: r.already_closed ? 'Already closed.' : 'Closed.' }));
      } else {
        setRowMsg(m => ({ ...m, [t.device_id]: 'Sent — waiting for the till (up to ~15s)…' }));
      }
      await load();
    } finally {
      setBusy(null);
    }
  };

  if (role !== null && role !== 'node' && role !== 'office') {
    return (
      <div className="p-6 text-sm text-gray-400">
        <p className="text-gray-300 font-medium">Close Branch lives on the branch server.</p>
        <p className="mt-1">This till is not the branch server. Use Close Day here for this till's own day,
          or run Close Branch on the server terminal.</p>
      </div>
    );
  }
  if (err) return <div className="p-6 text-sm text-red-300">{err}</div>;
  if (!ov) return <div className="p-6 text-sm text-gray-400">Loading…</div>;

  // The roll-up counts only what has actually been confirmed: acked closes and
  // the node's own close. Entered-but-unsent figures are not money yet.
  const closedTills = ov.tills.filter(t =>
    (t.instruction?.status === 'acked' && t.instruction.ack?.ok) ||
    (t.is_self && t.state && !t.state.day_open));
  const confirmedTotal = ov.tills.reduce((sum, t) => {
    const a = t.instruction?.status === 'acked' && t.instruction.ack?.ok ? t.instruction.payload.counted_cash : 0;
    return sum + a;
  }, 0);
  const waiting = ov.tills.filter(t => t.instruction?.status === 'pending');
  const failed  = ov.tills.filter(t => t.instruction?.status === 'failed');

  return (
    <div className="p-6 space-y-4 max-w-3xl">
      <div>
        <h2 className="text-lg font-semibold text-gray-100">Close the branch</h2>
        <p className="text-sm text-gray-400">Trading date <span className="text-gray-200 font-medium">{ov.business_date}</span>.
          Each till closes its own day; this screen asks them to, and reports exactly what happened.</p>
      </div>

      {ov.tills.map(t => {
        const age = ageOf(t.is_self ? new Date().toISOString() : t.last_seen);
        const ins = t.instruction;
        const closed = (ins?.status === 'acked' && ins.ack?.ok) || (t.is_self && t.state && !t.state.day_open);
        const ackSummary: any = ins?.ack?.summary ?? null;
        return (
          <div key={t.device_id} className="bg-gray-800/60 border border-gray-700 rounded-lg p-4 space-y-2">
            <div className="flex items-center gap-3">
              <span className="text-gray-100 font-medium">{t.is_self ? 'This terminal (branch server)' : `Terminal ${t.device_id.slice(0, 8)}`}</span>
              {!t.is_self && (
                <span className={`text-xs ${age.stale ? 'text-amber-400' : 'text-gray-500'}`}>
                  last seen {age.label}{age.stale ? ' — figures may be stale' : ''}
                </span>
              )}
              {closed && <span className="text-xs px-2 py-0.5 rounded bg-green-600/20 text-green-300 border border-green-600/40">day closed</span>}
              {ins?.status === 'pending' && <span className="text-xs px-2 py-0.5 rounded bg-blue-600/20 text-blue-300 border border-blue-600/40">waiting for till…</span>}
              {ins?.status === 'failed' && <span className="text-xs px-2 py-0.5 rounded bg-red-600/20 text-red-300 border border-red-600/40">refused</span>}
            </div>

            {t.state ? (
              <p className="text-xs text-gray-400">
                {t.state.day_open
                  ? <>Day {t.state.business_date} open · {t.state.drawers_on_day} drawer{t.state.drawers_on_day === 1 ? '' : 's'} closed,
                      cashiers counted {money(t.state.cashiers_counted_total)}
                      {t.state.open_drawer && <span className="text-amber-300"> · a drawer is still open{t.state.open_drawer.cashier_name ? ` (${t.state.open_drawer.cashier_name})` : ''}</span>}</>
                  : 'No open trading day.'}
              </p>
            ) : (
              <p className="text-xs text-amber-400/80">This till has never reported in. It cannot be closed from here until it does.</p>
            )}

            {ins?.status === 'failed' && ins.ack?.error && (
              <p className="text-xs text-red-300">{ins.ack.error}</p>
            )}
            {closed && ackSummary && (
              <p className="text-xs text-gray-400">
                Counted {money(ins!.payload.counted_cash)} · expected {money(ackSummary.expectedCash ?? 0)} ·{' '}
                <span className={Math.abs(ackSummary.variance ?? 0) < 0.005 ? 'text-green-300' : 'text-amber-300'}>
                  variance {money(ackSummary.variance ?? 0)}
                </span>
              </p>
            )}

            {!closed && t.state?.day_open && (
              <div className="flex items-center gap-2 pt-1">
                <input
                  type="number" min="0" step="0.01" placeholder="Cash you counted"
                  value={counts[t.device_id] ?? ''}
                  onChange={e => setCounts(m => ({ ...m, [t.device_id]: e.target.value }))}
                  className="bg-gray-900 border border-gray-600 rounded-md px-3 py-1.5 text-sm text-gray-100 w-44"
                />
                <input
                  type="text" placeholder="Notes (optional)"
                  value={notes[t.device_id] ?? ''}
                  onChange={e => setNotes(m => ({ ...m, [t.device_id]: e.target.value }))}
                  className="bg-gray-900 border border-gray-600 rounded-md px-3 py-1.5 text-sm text-gray-100 flex-1"
                />
                <button
                  onClick={() => closeTill(t)}
                  disabled={busy === t.device_id || ins?.status === 'pending'}
                  className="text-sm px-3 py-1.5 rounded-md bg-red-600 hover:bg-red-500 text-white transition-colors disabled:opacity-50 whitespace-nowrap"
                >
                  {busy === t.device_id ? 'Sending…' : 'Close this till'}
                </button>
              </div>
            )}
            {rowMsg[t.device_id] && <p className="text-xs text-gray-300">{rowMsg[t.device_id]}</p>}
          </div>
        );
      })}

      <div className="bg-gray-800/60 border border-gray-700 rounded-lg p-4 text-sm">
        <div className="flex justify-between text-gray-300">
          <span>Tills closed</span>
          <span>{closedTills.length} of {ov.tills.length}</span>
        </div>
        <div className="flex justify-between text-gray-300 mt-1">
          <span>Confirmed counted total (remote tills)</span>
          <span className="font-medium text-gray-100">{money(confirmedTotal)}</span>
        </div>
        {waiting.length > 0 && (
          <p className="text-xs text-blue-300 mt-2">Waiting on {waiting.length} till{waiting.length === 1 ? '' : 's'} to answer.</p>
        )}
        {failed.length > 0 && (
          <p className="text-xs text-red-300 mt-2">{failed.length} till{failed.length === 1 ? '' : 's'} refused — the reason is on the card. Fix it there, then close again.</p>
        )}
        {closedTills.length < ov.tills.length && waiting.length === 0 && failed.length === 0 && (
          <p className="text-xs text-gray-500 mt-2">The branch is closed only when every till above says so. A till that cannot be reached is closed at the till, exactly as before.</p>
        )}
      </div>
    </div>
  );
}
