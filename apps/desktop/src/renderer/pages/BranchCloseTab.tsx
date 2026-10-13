/**
 * BranchCloseTab — close the branch from the branch server (Phase 4; A452 rebuilt it around the shifts).
 *
 * Owner, 2026-10-12: "I thought it would show running shifts per till like the shift report, and when a cashier closes a
 * shift the manager gets a confirm shift just like on the till; the manager can click on a till and get its sales; when
 * all shifts are closed and confirmed they get a Close branch; when a branch is closed all tills reset to a new day and
 * the server time is the final time." And: "while confirming a shift let the manager see what the system holds … so he
 * can get the variance before confirming."
 *
 * WHAT THE MANAGER SEES
 *   One card per till, with its shifts of the day as that till reports them (every 15 s — its own books, never the
 *   server's replicated copies): who, when, sales and orders; open a shift for its sales by method and what the till
 *   expects. A closed shift waiting for a manager is confirmed here: what the system expects beside each count, the
 *   variance as it is typed. The till records the confirmation itself (an instruction it collects within ~15 s).
 *   Close branch is offered once every till has reported, no drawer is open and nothing waits for a manager — each
 *   till then closes its day with its confirmed counts (no second count), a till still on yesterday's day included.
 *
 * IT NEVER PRETENDS. A till not heard from, on an older version, refusing, or still answering is shown as such.
 */

import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { posApi, type BranchPeerShift } from '../lib/posApi';
import { methodName, type MethodOption } from '../../shared/shiftConfirm';
import MethodDot from '../components/MethodDot';

interface Props { currency: string }

type Overview = Extract<Awaited<ReturnType<typeof posApi.branchClose.overview>>, { tills: any }>;
type TillView = Overview['tills'][number];

const STALE_MS = 120_000;
const tillLabel = (t: { is_self: boolean; device_id: string }) => (t.is_self ? 'This terminal (branch server)' : `Terminal ${t.device_id.slice(0, 8)}`);

export default function BranchCloseTab({ currency }: Props) {
  const [ov, setOv] = useState<Overview | null>(null);
  const [err, setErr] = useState('');
  const [role, setRole] = useState<string | null>(null);
  const [options, setOptions] = useState<MethodOption[]>([]);
  const [open, setOpen] = useState<string | null>(null);          // the shift whose details are shown
  const [confirming, setConfirming] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const [closeMsg, setCloseMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [showTills, setShowTills] = useState(false);   // A458: the per-till detail, on request
  const [totalsOk, setTotalsOk] = useState(false);     // A458: the manager ticked the day's totals
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
    posApi.pos.paymentMethods().then(o => { if (alive.current) setOptions(o); }).catch(() => {});
    void load();
    // 5 s while this screen is open: the tills report every 15 s, and the manager is standing here watching.
    const t = setInterval(() => { void load(); }, 5_000);
    return () => { alive.current = false; clearInterval(t); };
  }, [load]);

  const money = (v: number) => `${currency} ${Number(v || 0).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const time = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit' }) : '');
  const ageOf = (iso: string | null): { label: string; stale: boolean } => {
    if (!iso) return { label: 'never', stale: true };
    const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
    if (s < 45) return { label: `${s}s ago`, stale: false };
    if (s < 3600) return { label: `${Math.floor(s / 60)}m ago`, stale: s * 1000 > STALE_MS };
    return { label: `${Math.floor(s / 3600)}h ago`, stale: true };
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

  // What stands between the branch and its close — the same checks the server makes when Close branch is pressed.
  const blockers: string[] = [];
  for (const t of ov.tills) {
    const st = t.state;
    if (!st) { blockers.push(`${tillLabel(t)} has never reported in`); continue; }
    if (!t.is_self && ageOf(t.last_seen).stale) blockers.push(`${tillLabel(t)} has not been heard from in the last 2 minutes`);
    if (!st.shifts) blockers.push(`${tillLabel(t)} needs the update to close from here`);
    if (st.open_drawer) blockers.push(`${tillLabel(t)}: ${st.open_drawer.cashier_name ?? 'a cashier'}'s drawer is still open`);
    const waiting = (st.shifts ?? []).filter(s => s.state === 'awaiting').length;
    if (waiting) blockers.push(`${tillLabel(t)}: ${waiting} shift${waiting === 1 ? '' : 's'} to confirm`);
  }
  const dayOpen = ov.tills.filter(t => t.state?.day_open);
  const closedTills = ov.tills.filter(t => !t.state?.day_open || (t.instruction?.status === 'acked' && t.instruction.ack?.ok));
  const waitingClose = ov.tills.filter(t => t.instruction?.status === 'pending');
  const refusedClose = ov.tills.filter(t => t.instruction?.status === 'failed');
  const allShifts = ov.tills.flatMap(t => t.state?.shifts ?? []);
  const branchSales = allShifts.reduce((a, s) => a + s.sales, 0);
  const branchOrders = allShifts.reduce((a, s) => a + s.orders, 0);

  const closeBranch = async () => {
    setClosing(true); setCloseMsg(null);
    try {
      const r = await posApi.branchClose.closeBranch(undefined, totalsOk);   // A458
      if (!r.ok) setCloseMsg({ ok: false, text: r.error ?? (r.results ?? []).filter(x => !x.ok).map(x => `${x.device_id.slice(0, 8)}: ${x.error}`).join('; ') ?? 'Could not close the branch.' });
      else setCloseMsg({ ok: true, text: (r.results ?? []).some(x => x.sent) ? 'Closing — each till answers within ~15 seconds.' : 'The branch is closed.' });
      await load();
    } finally { setClosing(false); }
  };

  // A458: every shift waiting for a manager, across the tills — confirmed here one by one (the till records it).
  const toConfirm = ov.tills.flatMap(t => (t.state?.shifts ?? []).filter(s => s.state === 'awaiting').map(s => ({ t, s })));
  const T = ov.totals;

  return (
    <div className="p-6 space-y-4 max-w-4xl" data-testid="branch-close">
      <div>
        <h2 className="text-lg font-semibold text-gray-100">Close the branch</h2>
        <p className="text-sm text-gray-400">
          Server date <span className="text-gray-200 font-medium">{ov.business_date}</span> — the server's date is final.
          Confirm each cashier's shift, then check the day's totals below — every till's confirmed shifts added up by
          payment method — tick them and close: every till closes its day and starts the next.
        </p>
      </div>

      {/* A458: the day's totals for the whole branch, by payment method */}
      <div className="bg-gray-800/60 border border-gray-700 rounded-lg p-4 space-y-2" data-testid="branch-totals">
        <div className="flex flex-wrap justify-between gap-2">
          <span className="text-gray-100 font-medium">The day's totals — all tills</span>
          <span className="text-xs text-gray-400">{T.orders} order{T.orders === 1 ? '' : 's'} · {T.shifts.all} shift{T.shifts.all === 1 ? '' : 's'} · {T.shifts.confirmed} confirmed</span>
        </div>
        {T.methods.length === 0 ? (
          <p className="text-xs text-gray-400">No sales on any till yet today.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-gray-500 text-left">
                <th className="font-normal pb-1">Method</th><th className="font-normal pb-1 text-right">Sales</th>
                <th className="font-normal pb-1 text-right">Expected</th><th className="font-normal pb-1 text-right">Confirmed</th>
                <th className="font-normal pb-1 text-right">Variance</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-700/60">
              {T.methods.map(l => (
                <tr key={l.method} data-testid={`total-${l.method}`}>
                  <td className="py-1.5 text-gray-100 whitespace-nowrap"><MethodDot method={l.method} />{methodName(l.method, options)}</td>
                  <td className="py-1.5 text-right text-gray-300 tabular-nums">{money(l.sales)}</td>
                  <td className="py-1.5 text-right text-gray-300 tabular-nums">{money(l.expected)}</td>
                  <td className="py-1.5 text-right text-gray-100 font-medium tabular-nums">{money(l.confirmed)}</td>
                  <td className={`py-1.5 text-right tabular-nums ${Math.abs(l.variance) < 0.005 ? 'text-gray-300' : l.variance > 0 ? 'text-amber-300' : 'text-red-300'}`}>
                    {Math.abs(l.variance) < 0.005 ? 'balanced' : `${l.variance > 0 ? 'over' : 'short'} ${money(Math.abs(l.variance))}`}
                  </td>
                </tr>
              ))}
              <tr className="font-semibold" data-testid="total-all">
                <td className="py-1.5 text-gray-100">Total</td>
                <td className="py-1.5 text-right text-gray-100 tabular-nums">{money(T.total.sales)}</td>
                <td className="py-1.5 text-right text-gray-100 tabular-nums">{money(T.total.expected)}</td>
                <td className="py-1.5 text-right text-gray-100 tabular-nums">{money(T.total.confirmed)}</td>
                <td className={`py-1.5 text-right tabular-nums ${Math.abs(T.total.variance) < 0.005 ? 'text-gray-300' : T.total.variance > 0 ? 'text-amber-300' : 'text-red-300'}`}>
                  {Math.abs(T.total.variance) < 0.005 ? 'balanced' : `${T.total.variance > 0 ? 'over' : 'short'} ${money(Math.abs(T.total.variance))}`}
                </td>
              </tr>
            </tbody>
          </table>
        )}
        <p className="text-xs text-gray-500">Expected includes each drawer's float and cash paid in or out. Confirmed is what the managers counted at each shift's confirmation.</p>
        {(T.shifts.open > 0 || T.shifts.awaiting > 0) && (
          <p className="text-xs text-amber-300">Not final yet: {[T.shifts.open ? `${T.shifts.open} shift${T.shifts.open === 1 ? '' : 's'} still open` : '', T.shifts.awaiting ? `${T.shifts.awaiting} to confirm` : ''].filter(Boolean).join(', ')}.</p>
        )}
        {T.shifts.uncounted > 0 && (
          <p className="text-xs text-gray-400">{T.shifts.uncounted} shift{T.shifts.uncounted === 1 ? ' was' : 's were'} closed without a manager's count (force-closed or older) — in Sales and Expected, not in Confirmed.</p>
        )}
      </div>

      {/* A458: the shifts waiting for a manager — confirmed one by one, as before */}
      {toConfirm.length > 0 && (
        <div className="bg-gray-800/60 border border-amber-600/40 rounded-lg p-4 space-y-2" data-testid="to-confirm">
          <p className="text-gray-100 font-medium">Shifts to confirm ({toConfirm.length})</p>
          {toConfirm.map(({ t, s }) => {
            const c = t.confirms?.[s.id];
            return (
              <div key={s.id} className="border-t border-gray-700/60 pt-2">
                <div className="flex flex-wrap items-center gap-3 text-sm cursor-pointer" onClick={() => setOpen(open === s.id ? null : s.id)} data-testid={`shift-${s.id}`}>
                  <span className="text-gray-100">{s.cashier_name}</span>
                  <span className="text-xs text-gray-400">{tillLabel(t)} · {time(s.opened_at)} – {s.closed_at ? time(s.closed_at) : 'now'}</span>
                  <ShiftBadge s={s} pending={c?.status === 'pending'} />
                  <span className="ml-auto text-gray-100 font-medium tabular-nums">{money(s.sales)}</span>
                  <span className="text-xs text-gray-400">{open === s.id ? 'Hide' : 'Details'}</span>
                </div>
                {c?.status === 'failed' && c.error && <p className="text-xs text-red-300">The till did not take the confirmation: {c.error}</p>}
                {open === s.id && (
                  <div className="pt-2">
                    <ShiftDetails s={s} money={money} options={options} />
                    {c?.status !== 'pending' && (
                      confirming === s.id
                        ? <ConfirmHere till={t} s={s} money={money} options={options} currency={currency}
                            onDone={() => { setConfirming(null); void load(); }} onCancel={() => setConfirming(null)} />
                        : <button data-testid={`confirm-${s.id}`} onClick={() => setConfirming(s.id)}
                            className="mt-2 px-3 py-1.5 rounded-md bg-action-500 hover:bg-action-400 text-gray-950 text-sm font-semibold">
                            Confirm this shift
                          </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* A458: the per-till detail, hidden unless asked for */}
      <button data-testid="show-tills" onClick={() => setShowTills(!showTills)} className="text-sm text-action-300 hover:text-action-200">
        {showTills ? 'Hide tills' : `Show tills (${ov.tills.length})`}
      </button>
      {showTills && (<>
        {ov.tills.map(t => {
          const age = ageOf(t.is_self ? new Date().toISOString() : t.last_seen);
          const st = t.state;
          const ins = t.instruction;
          const closedNow = ins?.status === 'acked' && ins.ack?.ok;
          const behindDay = st?.day_open && st.business_date && st.business_date !== ov.business_date;
          const skewMin = st?.clock && t.last_seen ? Math.round((new Date(st.clock).getTime() - new Date(t.last_seen).getTime()) / 60_000) : 0;
          return (
            <div key={t.device_id} className="bg-gray-800/60 border border-gray-700 rounded-lg p-4 space-y-3" data-testid={`till-${t.device_id}`}>
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-gray-100 font-medium">{tillLabel(t)}</span>
                {!t.is_self && (
                  <span className={`text-xs ${age.stale ? 'text-amber-400' : 'text-gray-500'}`}>
                    last seen {age.label}{age.stale ? ' — figures may be stale' : ''}
                  </span>
                )}
                {st && !st.day_open && <span className="text-xs px-2 py-0.5 rounded bg-gray-600/30 text-gray-300 border border-gray-600/50">day closed</span>}
                {closedNow && <span className="text-xs px-2 py-0.5 rounded bg-action-600/20 text-action-300 border border-action-600/40">closed with the branch</span>}
                {ins?.status === 'pending' && <span className="text-xs px-2 py-0.5 rounded bg-amber-600/20 text-amber-300 border border-amber-600/40">closing — waiting for the till…</span>}
                {ins?.status === 'failed' && <span className="text-xs px-2 py-0.5 rounded bg-red-600/20 text-red-300 border border-red-600/40">refused</span>}
              </div>

              {!st && <p className="text-xs text-amber-400/80">This till has never reported in. It shows here once it is on and reaches the server.</p>}
              {behindDay && (
                <p className="text-xs text-amber-300" data-testid="behind-day">
                  Its trading day {st!.business_date} is still open — it closes with the branch, and the till starts {ov.business_date}.
                </p>
              )}
              {Math.abs(skewMin) >= 5 && (
                <p className="text-xs text-amber-300">This till's clock is {Math.abs(skewMin)} min {skewMin > 0 ? 'ahead of' : 'behind'} the server — set it right; the server's time counts.</p>
              )}
              {st && !st.shifts && (
                <p className="text-xs text-amber-300">This till is on an older version — update it to see and confirm its shifts here.</p>
              )}
              {ins?.status === 'failed' && ins.ack?.error && <p className="text-xs text-red-300">{ins.ack.error}</p>}

              {st?.shifts && st.shifts.length === 0 && st.day_open && <p className="text-xs text-gray-400">No shifts on this till today.</p>}
              {st?.shifts && st.shifts.length > 0 && (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-gray-500 text-left">
                      <th className="font-normal pb-1">Cashier</th><th className="font-normal pb-1">Shift</th>
                      <th className="font-normal pb-1">Status</th><th className="font-normal pb-1 text-right">Orders</th>
                      <th className="font-normal pb-1 text-right">Sales</th><th />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-700/60">
                    {st.shifts.map(s => {
                      const c = t.confirms?.[s.id];
                      return (
                        <Fragment key={s.id}>
                          <tr className="cursor-pointer hover:bg-gray-700/30" onClick={() => setOpen(open === s.id ? null : s.id)} data-testid={`shift-${s.id}`}>
                            <td className="py-2 text-gray-100">{s.cashier_name}</td>
                            <td className="py-2 text-gray-400 text-xs">{time(s.opened_at)} – {s.closed_at ? time(s.closed_at) : 'now'}</td>
                            <td className="py-2"><ShiftBadge s={s} pending={c?.status === 'pending'} /></td>
                            <td className="py-2 text-right text-gray-300 tabular-nums">{s.orders}</td>
                            <td className="py-2 text-right text-gray-100 font-medium tabular-nums">{money(s.sales)}</td>
                            <td className="py-2 text-right text-xs text-gray-400 pl-2">{open === s.id ? 'Hide' : 'Details'}</td>
                          </tr>
                          {c?.status === 'failed' && c.error && (
                            <tr><td colSpan={6} className="pb-2 text-xs text-red-300">The till did not take the confirmation: {c.error}</td></tr>
                          )}
                          {open === s.id && (
                            <tr><td colSpan={6} className="pb-3">
                              <ShiftDetails s={s} money={money} options={options} />
                              {s.state === 'awaiting' && c?.status !== 'pending' && (
                                confirming === s.id
                                  ? <ConfirmHere till={t} s={s} money={money} options={options} currency={currency}
                                      onDone={() => { setConfirming(null); void load(); }} onCancel={() => setConfirming(null)} />
                                  : <button data-testid={`confirm-${s.id}`} onClick={() => setConfirming(s.id)}
                                      className="mt-2 px-3 py-1.5 rounded-md bg-action-500 hover:bg-action-400 text-gray-950 text-sm font-semibold">
                                      Confirm this shift
                                    </button>
                              )}
                            </td></tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              )}

              {closedNow && ins?.ack?.summary && (
                <p className="text-xs text-gray-400">
                  Day {ins.ack.summary.closedDate ?? ''} closed · counted {money(ins.ack.summary.countedCash ?? 0)} · expected {money(ins.ack.summary.expectedCash ?? 0)} ·{' '}
                  <span className={Math.abs(ins.ack.summary.variance ?? 0) < 0.005 ? 'text-gray-200' : 'text-amber-300'}>variance {money(ins.ack.summary.variance ?? 0)}</span>
                </p>
              )}
            </div>
          );
        })}

      </>)}

      <div className="bg-gray-800/60 border border-gray-700 rounded-lg p-4 space-y-2 text-sm" data-testid="close-branch">
        <div className="flex justify-between text-gray-300">
          <span>Tills with their day closed</span>
          <span>{closedTills.length} of {ov.tills.length}</span>
        </div>
        {blockers.length > 0 ? (
          <div className="text-xs text-amber-300 space-y-0.5" data-testid="close-blockers">
            <p className="text-gray-300">Before the branch can close:</p>
            {blockers.map(b => <p key={b}>· {b}</p>)}
          </div>
        ) : dayOpen.length === 0 ? (
          <p className="text-xs text-gray-400">Every till's day is closed. Each starts {ov.business_date === '' ? 'the next day' : 'the next trading day'} at its next sale.</p>
        ) : (
          <p className="text-xs text-gray-300">Every shift is closed and confirmed. Closing the branch closes each till's day with its confirmed counts — the totals above.</p>
        )}
        {waitingClose.length > 0 && <p className="text-xs text-amber-300">Waiting on {waitingClose.length} till{waitingClose.length === 1 ? '' : 's'} to answer.</p>}
        {refusedClose.length > 0 && <p className="text-xs text-red-300">{refusedClose.length} till{refusedClose.length === 1 ? '' : 's'} refused — the reason is on its card.</p>}
        {/* A458: the manager confirms the day's totals (the confirmed shifts added up, per payment method) */}
        {blockers.length === 0 && dayOpen.length > 0 && (
          <label className="flex items-start gap-2 text-sm text-gray-200 pt-1" data-testid="totals-confirm">
            <input type="checkbox" className="mt-0.5" checked={totalsOk} onChange={(e) => setTotalsOk(e.target.checked)} />
            <span>I have checked the day's totals by payment method above — {money(ov.totals.total.confirmed)} confirmed — and they are the day's takings.</span>
          </label>
        )}
        {closeMsg && <p className={`text-xs ${closeMsg.ok ? 'text-gray-200' : 'text-red-300'}`}>{closeMsg.text}</p>}
        <button data-testid="close-branch-btn" onClick={() => void closeBranch()}
          disabled={closing || !totalsOk || blockers.length > 0 || dayOpen.length === 0 || waitingClose.length > 0}
          className="w-full mt-1 px-4 py-2.5 rounded-lg bg-action-500 hover:bg-action-400 text-gray-950 font-bold disabled:opacity-40">
          {closing ? 'Closing…' : 'Close branch'}
        </button>
      </div>
    </div>
  );
}

function ShiftBadge({ s, pending }: { s: BranchPeerShift; pending: boolean }) {
  const [cls, text] = pending ? ['bg-amber-600/20 text-amber-300 border-amber-600/40', 'confirming…']
    : s.state === 'open' ? ['bg-action-600/20 text-action-300 border-action-600/40', 'open']
    : s.state === 'awaiting' ? ['bg-amber-600/20 text-amber-300 border-amber-600/40', 'to confirm']
    : s.state === 'confirmed' ? ['bg-gray-600/30 text-gray-200 border-gray-500/50', 'confirmed']
    : ['bg-gray-600/30 text-gray-300 border-gray-600/50', 'closed'];
  return <span className={`text-xs px-2 py-0.5 rounded border ${cls}`}>{text}</span>;
}

/** A shift's sales by method and what its till expects — the shift report, compact. */
function ShiftDetails({ s, money, options }: { s: BranchPeerShift; money: (n: number) => string; options: MethodOption[] }) {
  const methods = [...new Set([...Object.keys(s.by_method), ...Object.keys(s.expected)])].sort((a, b) => (a === 'cash' ? -1 : b === 'cash' ? 1 : a.localeCompare(b)));
  return (
    <div className="bg-gray-900/60 border border-gray-700 rounded-md p-3 space-y-2" data-testid={`details-${s.id}`}>
      <table className="w-full text-xs">
        <thead><tr className="text-gray-500"><th className="text-left font-normal">Method</th><th className="text-right font-normal">Sales</th><th className="text-right font-normal">Expected</th>
          {s.confirmed?.counted && <th className="text-right font-normal">Confirmed</th>}</tr></thead>
        <tbody>
          {methods.map(m => (
            <tr key={m} className="text-gray-200">
              <td className="py-0.5"><MethodDot method={m} />{methodName(m, options)}</td>
              <td className="py-0.5 text-right tabular-nums">{money(s.by_method[m] ?? 0)}</td>
              <td className="py-0.5 text-right tabular-nums">{money(s.expected[m] ?? 0)}</td>
              {s.confirmed?.counted && <td className="py-0.5 text-right tabular-nums">{money(s.confirmed.counted[m] ?? 0)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-xs text-gray-400">
        Cash expected {money(s.expected.cash ?? 0)} = float {money(s.cash.opening_float)} + cash sales {money(s.cash.cash_sales)}
        {s.cash.float_in ? ` + float in ${money(s.cash.float_in)}` : ''}{s.cash.float_out ? ` − paid out ${money(s.cash.float_out)}` : ''}
        {s.cash.expenses ? ` − expenses ${money(s.cash.expenses)}` : ''}
      </p>
      {s.confirmed && <p className="text-xs text-gray-300">Confirmed by {s.confirmed.by_name ?? 'a manager'} at {new Date(s.confirmed.at).toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit' })}.</p>}
    </div>
  );
}

/** Confirm a closed shift from the server: the till's expected figure beside each count, the variance as typed. */
function ConfirmHere({ till, s, money, options, currency, onDone, onCancel }: {
  till: TillView; s: BranchPeerShift; money: (n: number) => string; options: MethodOption[]; currency: string;
  onDone: () => void; onCancel: () => void;
}) {
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const codes = s.methods.length ? s.methods : ['cash'];
  const inputCls = 'w-full bg-gray-800 border border-gray-700 rounded-md px-2 py-1 text-white text-sm focus:outline-none focus:border-action-500';

  const submit = async () => {
    const counts: Record<string, number> = {};
    const missing: string[] = [];
    for (const c of codes) {
      const v = (inputs[c] ?? '').trim();
      if (v === '' || !Number.isFinite(Number(v)) || Number(v) < 0) missing.push(methodName(c, options)); else counts[c] = Number(v);
    }
    if (missing.length) { setError(`Enter what you counted for: ${missing.join(', ')}.`); return; }
    if (s.declared) {
      const need = codes.filter(c => Math.round((counts[c] - (s.declared?.[c] ?? 0)) * 100) !== 0 && !(reasons[c] ?? '').trim());
      if (need.length) { setError(`Give a reason where your count differs from the cashier's: ${need.map(c => methodName(c, options)).join(', ')}.`); return; }
    }
    setBusy(true); setError('');
    try {
      const clean = Object.fromEntries(Object.entries(reasons).filter(([, v]) => v.trim()));
      const r = await posApi.branchClose.confirmShift(till.device_id, s.id, counts, Object.keys(clean).length ? clean : undefined);
      if (!r.ok) { setError(r.error ?? 'Could not confirm the shift.'); return; }
      onDone();
    } finally { setBusy(false); }
  };

  return (
    <div className="mt-2 bg-gray-900/80 border border-action-600/40 rounded-md p-3 space-y-2" data-testid={`confirm-form-${s.id}`}>
      <p className="text-xs text-gray-300">Count each method — the drawer, the M-Pesa statement, the card machine's total. What the system expects is beside it; the difference shows as you type.</p>
      {error && <p className="text-xs text-red-300">{error}</p>}
      <table className="w-full text-sm">
        <thead><tr className="text-xs text-gray-500 text-left">
          <th className="font-normal">Method</th><th className="font-normal text-right pr-2">Expected</th>
          {s.declared && <th className="font-normal text-right pr-2">Cashier</th>}
          <th className="font-normal">Counted ({currency})</th><th className="font-normal text-right">Variance</th>
        </tr></thead>
        <tbody>
          {codes.map(c => {
            const exp = Number(s.expected[c] ?? 0);
            const typed = inputs[c] ?? '';
            const v = typed.trim() !== '' && Number.isFinite(Number(typed)) ? Math.round((Number(typed) - exp) * 100) / 100 : null;
            const differsFromCashier = !!s.declared && typed.trim() !== '' && Math.round((Number(typed) - (s.declared[c] ?? 0)) * 100) !== 0;
            return (
              <Fragment key={c}>
                <tr>
                  <td className="py-1 text-gray-200 whitespace-nowrap"><MethodDot method={c} />{methodName(c, options)}</td>
                  <td className="py-1 pr-2 text-right text-gray-200 tabular-nums" data-testid={`expected-${c}`}>{money(exp)}</td>
                  {s.declared && <td className="py-1 pr-2 text-right text-gray-300 tabular-nums">{money(s.declared[c] ?? 0)}</td>}
                  <td className="py-1 w-36"><input type="number" inputMode="decimal" value={typed} placeholder="0.00" className={inputCls}
                    data-testid={`count-${c}`} onWheel={(e) => (e.target as HTMLInputElement).blur()} onChange={(e) => setInputs({ ...inputs, [c]: e.target.value })} /></td>
                  <td data-testid={`variance-${c}`} className={`py-1 pl-2 text-right tabular-nums whitespace-nowrap ${v === null ? 'text-gray-500' : v === 0 ? 'text-gray-300' : v > 0 ? 'text-amber-300' : 'text-red-300'}`}>
                    {v === null ? '—' : v === 0 ? 'balanced' : `${v > 0 ? 'over' : 'short'} ${money(Math.abs(v))}`}
                  </td>
                </tr>
                {(differsFromCashier || (v !== null && v !== 0)) && (
                  <tr><td colSpan={s.declared ? 5 : 4} className="pb-1">
                    <input type="text" maxLength={200} value={reasons[c] ?? ''} placeholder={differsFromCashier ? 'Reason — your count differs from the cashier\'s' : 'Note on the difference (optional)'}
                      className={inputCls + ' border-amber-500/50'} onChange={(e) => setReasons({ ...reasons, [c]: e.target.value })} />
                  </td></tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      <div className="flex gap-2">
        <button onClick={() => void submit()} disabled={busy} data-testid={`confirm-send-${s.id}`}
          className="px-3 py-1.5 rounded-md bg-action-500 hover:bg-action-400 text-gray-950 text-sm font-semibold disabled:opacity-40">
          {busy ? 'Confirming…' : 'Confirm shift'}
        </button>
        <button onClick={onCancel} className="px-3 py-1.5 rounded-md border border-gray-600 text-gray-200 text-sm">Cancel</button>
      </div>
    </div>
  );
}
