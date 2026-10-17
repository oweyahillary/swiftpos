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
 *
 * A465 (owner, 2026-10-13): every drawer open at the branch is listed with Cash in / out and Expense — a manager here
 * records money on ANY running shift. The till that holds the drawer records it on its own books (~15 s); until then it
 * shows as waiting for the till (and can be withdrawn), then recorded, or refused with the till's reason.
 */

import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { posApi, type BranchPeerShift, type ShiftMoneyView } from '../lib/posApi';
import { methodLabel } from '../../shared/paymentCatalogue';   // A465
import { methodName, cashLines, type MethodOption } from '../../shared/shiftConfirm';
import MethodDot from '../components/MethodDot';
import ShiftPanel from './ShiftPanel';   // A520: the server's own drawer closes here, with the shift close everyone knows

interface Props { currency: string; businessName?: string }

type Overview = Extract<Awaited<ReturnType<typeof posApi.branchClose.overview>>, { tills: any }>;
type TillView = Overview['tills'][number];

const STALE_MS = 120_000;
// A465: a till that reports its name / code is named by it; an older till keeps "Terminal xxxxxxxx" (the same names as
// main/branchClose.ts tillLabel, which writes the blockers — A520).
const tillLabel = (t: { is_self: boolean; device_id: string; state?: { terminal?: { code?: string | null; name?: string | null } } | null }) => {
  if (t.is_self) return 'This terminal (branch server)';
  const n = t.state?.terminal?.name?.trim(); const c = t.state?.terminal?.code?.trim();
  return n && c ? `${n} (${c})` : n || (c ? `Till ${c}` : `Terminal ${t.device_id.slice(0, 8)}`);
};

export default function BranchCloseTab({ currency, businessName }: Props) {
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
  const [moneyFor, setMoneyFor] = useState<{ t: TillView; s: BranchPeerShift; mode: 'float' | 'expense' } | null>(null);   // A465
  const [moneyMsg, setMoneyMsg] = useState('');   // A465
  const [ownShift, setOwnShift] = useState(false);   // A520: this terminal's own shift, closed here first
  const [withoutOk, setWithoutOk] = useState<Set<string>>(new Set());   // A521: tills with money the manager closes without
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

  // What stands between the branch and its close. A520: computed by the branch server itself (branchClose.ts
  // assessBranchClose), the very rule Close branch applies, so the screen and the button never disagree. A till not
  // heard from holds the close only when its last report shows a drawer open or a shift to confirm; otherwise it is
  // "not connected" and its day closes when it next connects.
  const allBlockers: string[] = ov.close?.blockers ?? [];
  const held = ov.close?.held ?? [];
  const heldIds = new Set(held.map(h => h.device_id));
  const selfDrawer = ov.close?.self_drawer ?? null;
  // A521 (#1): another till's money no longer stops the whole branch — the manager ticks its warning and closes without
  // it (the server applies the same rule: unresolvedBlockers). This terminal's own lines can never be ticked.
  const without = ov.close?.without ?? [];
  const ticked = without.filter(w => withoutOk.has(w.device_id));
  const tickedLines = new Set(ticked.flatMap(w => w.lines));
  const blockers = allBlockers.filter(b => !tickedLines.has(b));
  // A close left for a till that is off waits for it (no 24-h expiry) — it never holds tonight's close either.
  // A521: nor one left for a till the branch closed without (its money waits there): pending, wait_for_till.
  const waitsForTill = (t: TillView) => t.instruction?.status === 'pending' && t.instruction.payload?.wait_for_till === true
    && (ageOf(t.last_seen).stale || t.instruction.ack?.wait === true);
  // Days still to close: a till that is off and already holds a close waiting for it is not one of them.
  const dayOpen = ov.tills.filter(t => t.state?.day_open && !waitsForTill(t));
  const closedTills = ov.tills.filter(t => !t.state?.day_open || (t.instruction?.status === 'acked' && t.instruction.ack?.ok));
  // A521 (#2): shown, never a reason to hold the button — a till that answers late is asked again by the next close.
  const waitingClose = ov.tills.filter(t => t.instruction?.status === 'pending' && !waitsForTill(t));
  const waitingConnect = ov.tills.filter(t => waitsForTill(t) && !heldIds.has(t.device_id));
  const refusedClose = ov.tills.filter(t => t.instruction?.status === 'failed');
  const allShifts = ov.tills.flatMap(t => t.state?.shifts ?? []);
  const branchSales = allShifts.reduce((a, s) => a + s.sales, 0);
  const branchOrders = allShifts.reduce((a, s) => a + s.orders, 0);

  const closeBranch = async () => {
    setClosing(true); setCloseMsg(null);
    try {
      const r = await posApi.branchClose.closeBranch(undefined, totalsOk, ticked.map(w => w.device_id));   // A458, A521
      if (!r.ok) setCloseMsg({ ok: false, text: r.error ?? (r.results ?? []).filter(x => !x.ok).map(x => `${x.device_id.slice(0, 8)}: ${x.error}`).join('; ') ?? 'Could not close the branch.' });
      else {
        const later = (r.results ?? []).filter(x => x.held && !x.without).length;   // A520
        const wo = (r.results ?? []).filter(x => x.without).length;                  // A521
        const live = (r.results ?? []).some(x => x.sent && !x.held);
        setCloseMsg({ ok: true, text: [live ? 'Closing — each till answers within ~15 seconds.' : 'The branch is closed.',
          later ? `${later} till${later === 1 ? ' is' : 's are'} not connected — ${later === 1 ? 'its day closes when it next connects' : 'their days close when they next connect'}.` : '',
          wo ? `Closed without ${ticked.map(w => w.label).join(', ')} — ${wo === 1 ? 'its day closes' : 'their days close'} when ${wo === 1 ? 'its' : 'their'} money is closed and confirmed.` : ''].filter(Boolean).join(' ') });
        setWithoutOk(new Set());
      }
      await load();
    } finally { setClosing(false); }
  };

  // A465: every drawer open at the branch — a manager here records cash in / out or an expense on it (server only).
  const isServer = role === 'node' || role === 'office';
  const openDrawers = ov.tills.flatMap(t => (t.state?.shifts ?? []).filter(s => s.state === 'open').map(s => ({ t, s })));
  // A521 (#3): two ways off this list. "Hide from Close Branch" — a till only off for a while: it keeps its key and comes
  // back the moment it reports. "Revoke this till" (F4's "Forget") — a till gone for good: its key goes, and it is
  // refused until it joins this server again (Find my server on the till, allowed here).
  const hide = async (t: TillView) => {
    const r = await posApi.branchClose.hideTill(t.device_id).catch(() => ({ ok: false, error: 'Could not hide it.' }));
    setCloseMsg(r.ok ? { ok: true, text: `${tillLabel(t)} hidden — it shows here again when it next reports.` } : { ok: false, text: r.error ?? 'Could not hide it.' });
    await load();
  };
  const revoke = async (t: TillView) => {
    if (!window.confirm(`Revoke ${tillLabel(t)}? Its device key is removed: it can no longer reach this branch server — no sales, no staff list, no instructions — until it joins again (on that till: Find my server, then allow it here). Its sales stay in the branch's records. If it is only switched off for a while, Cancel and use Hide instead.`)) return;
    const r = await posApi.branchClose.forgetTill(t.device_id).catch(() => ({ ok: false, error: 'Could not revoke it.' }));
    setCloseMsg(r.ok ? { ok: true, text: `${tillLabel(t)} revoked — it must join this server again to reconnect.` } : { ok: false, text: r.error ?? 'Could not revoke it.' });
    await load();
  };
  const cancelMoney = async (id: number) => {
    const r = await posApi.branchClose.cancelShiftMoney(id).catch(() => ({ ok: false, error: 'Could not withdraw it.' }));
    setMoneyMsg(r.ok ? 'Withdrawn — the till will not record it.' : (r.error ?? 'Could not withdraw it.'));
    await load();
  };

  // A458: every shift waiting for a manager, across the tills — confirmed here one by one (the till records it).
  const toConfirm = ov.tills.flatMap(t => (t.state?.shifts ?? []).filter(s => s.state === 'awaiting').map(s => ({ t, s })));
  // A520: confirmed shifts opened at a float of 0 whose cash counted over — the likeliest reason for an "over" equal to a float.
  const floatOver = ov.tills.flatMap(t => (t.state?.shifts ?? [])
    .filter(s => s.state === 'confirmed' && Number(s.cash?.opening_float ?? 0) === 0 && !!s.confirmed?.counted)
    .map(s => ({ t, s, over: Math.round((Number(s.confirmed?.counted?.cash ?? 0) - Number(s.expected.cash ?? 0)) * 100) / 100 }))
    .filter(x => x.over > 0));
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
        {/* A520 (KRUNCH: cash "over" by exactly 3 x the 2,500 float): Expected adds each shift's OWN opening float, once;
            Confirmed is what was counted. A shift opened at a float of 0 while the last shift's float stayed in the drawer
            counts over by that float — named here so nobody hunts for a double count that is not there. */}
        {floatOver.length > 0 && (
          <p className="text-xs text-amber-300" data-testid="float-over">
            {floatOver.map(({ t, s, over }) => `${s.cashier_name} on ${tillLabel(t)} opened with a float of 0 and counted ${money(over)} over`).join('; ')} —
            was the last shift's float left in the drawer? Each shift's Details shows its float.
          </p>
        )}
        {T.shifts.uncounted > 0 && (
          <p className="text-xs text-gray-400">{T.shifts.uncounted} shift{T.shifts.uncounted === 1 ? ' was' : 's were'} closed without a manager's count (force-closed or older) — in Sales and Expected, not in Confirmed.</p>
        )}
      </div>

      {/* A520: the branch server used as a till — its own drawer closes first (the shift close every cashier knows), then
          its shift is confirmed like any till's, and Close branch closes the server's day with the branch. */}
      {selfDrawer && (
        <div className="bg-amber-500/10 border border-amber-500/40 rounded-lg p-4 space-y-2" data-testid="self-drawer">
          <p className="text-gray-100 font-medium">This terminal: close its shift first</p>
          <p className="text-xs text-gray-300">
            {selfDrawer.cashier_name ? `${selfDrawer.cashier_name}'s drawer is open on this terminal.` : 'A drawer is open on this terminal.'} Close
            the shift (count the drawer), confirm it below, then close the branch — this terminal's day closes with it.
          </p>
          <button data-testid="close-own-shift" onClick={() => setOwnShift(true)}
            className="px-3 py-1.5 rounded-md bg-action-500 hover:bg-action-400 text-gray-950 text-sm font-semibold">
            Close this terminal's shift
          </button>
        </div>
      )}
      {ownShift && (
        <ShiftPanel business={{ name: businessName ?? '', currency }} onClose={() => { setOwnShift(false); void load(); }}
          onShiftChange={() => { void load(); }} />
      )}

      {/* A465: the drawers open now — cash in / out and expenses on any of them, recorded by the till that holds it */}
      {isServer && openDrawers.length > 0 && (
        <div className="bg-gray-800/60 border border-gray-700 rounded-lg p-4 space-y-2" data-testid="open-drawers">
          <p className="text-gray-100 font-medium">Drawers open now ({openDrawers.length})</p>
          <p className="text-xs text-gray-400">Record cash in, cash out or an expense on any drawer. The till that holds it records it within about 15 seconds.</p>
          {moneyMsg && <p className="text-xs text-gray-300">{moneyMsg}</p>}
          {openDrawers.map(({ t, s }) => {
            const age = ageOf(t.is_self ? new Date().toISOString() : t.last_seen);
            const items = (t.money ?? []).filter(m => m.shift_id === s.id);
            return (
              <div key={s.id} className="border-t border-gray-700/60 pt-2 space-y-1" data-testid={`drawer-${s.id}`}>
                <div className="flex flex-wrap items-center gap-3 text-sm">
                  <span className="text-gray-100">{s.cashier_name}</span>
                  <span className="text-xs text-gray-400">{tillLabel(t)} · opened {time(s.opened_at)}</span>
                  {!t.is_self && age.stale && <span className="text-xs text-amber-400">last seen {age.label}</span>}
                  <span className="ml-auto text-xs text-gray-400">Cash expected <span className="text-gray-100 font-medium tabular-nums">{money(s.expected.cash ?? 0)}</span></span>
                </div>
                <div className="flex gap-2">
                  <button data-testid={`drawer-float-${s.id}`} onClick={() => { setMoneyMsg(''); setMoneyFor({ t, s, mode: 'float' }); }}
                    className="px-3 py-1.5 rounded-md border border-gray-600 text-gray-200 hover:bg-gray-700/40 text-sm">Cash in / out</button>
                  <button data-testid={`drawer-expense-${s.id}`} onClick={() => { setMoneyMsg(''); setMoneyFor({ t, s, mode: 'expense' }); }}
                    className="px-3 py-1.5 rounded-md border border-gray-600 text-gray-200 hover:bg-gray-700/40 text-sm">Expense</button>
                </div>
                {items.map(m => <MoneyLine key={m.id} m={m} money={money} onCancel={() => void cancelMoney(m.id)} />)}
              </div>
            );
          })}
        </div>
      )}
      {moneyFor && (
        <ShiftMoneyModal till={moneyFor.t} s={moneyFor.s} mode={moneyFor.mode} label={tillLabel(moneyFor.t)} money={money} currency={currency}
          options={options} time={time} onCancel={() => setMoneyFor(null)}
          onDone={(msg) => { setMoneyFor(null); setMoneyMsg(msg); void load(); }} />
      )}

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
                            onDone={(msg) => { setConfirming(null); if (msg) setCloseMsg({ ok: true, text: msg }); void load(); }} onCancel={() => setConfirming(null)} />
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
                {!t.is_self && age.stale && isServer && (<>
                  <button data-testid={`hide-${t.device_id}`} onClick={() => void hide(t)}
                    className="text-xs px-2 py-0.5 rounded border border-gray-600 text-gray-300 hover:bg-gray-700/40">Hide from Close Branch</button>
                  <button data-testid={`revoke-${t.device_id}`} onClick={() => void revoke(t)}
                    className="text-xs px-2 py-0.5 rounded border border-red-700/60 text-red-300 hover:bg-red-900/30">Revoke this till</button>
                </>)}
                {st && !st.day_open && <span className="text-xs px-2 py-0.5 rounded bg-gray-600/30 text-gray-300 border border-gray-600/50">day closed</span>}
                {closedNow && <span className="text-xs px-2 py-0.5 rounded bg-action-600/20 text-action-300 border border-action-600/40">closed with the branch</span>}
                {ins?.status === 'pending' && (ins.ack?.wait === true
                  ? <span className="text-xs px-2 py-0.5 rounded bg-gray-600/30 text-gray-200 border border-gray-500/50" data-testid="closes-after-money">closed without it — its day closes when its money is closed and confirmed</span>
                  : waitsForTill(t)
                  ? <span className="text-xs px-2 py-0.5 rounded bg-gray-600/30 text-gray-200 border border-gray-500/50" data-testid="closes-on-connect">not connected — its day closes when it next connects</span>
                  : <span className="text-xs px-2 py-0.5 rounded bg-amber-600/20 text-amber-300 border border-amber-600/40">closing — waiting for the till…</span>)}
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
                                      onDone={(msg) => { setConfirming(null); if (msg) setCloseMsg({ ok: true, text: msg }); void load(); }} onCancel={() => setConfirming(null)} />
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
        {/* A521 (#1): another till's money — the manager may close the branch without it, with the warning ticked */}
        {without.length > 0 && (
          <div className="text-xs space-y-1.5 pt-1" data-testid="close-without">
            <p className="text-gray-300">Or close the branch without these tills — this terminal and every other till close tonight:</p>
            {without.map(w => (
              <label key={w.device_id} className="flex items-start gap-2 text-amber-200" data-testid={`without-${w.device_id}`}>
                <input type="checkbox" className="mt-0.5" checked={withoutOk.has(w.device_id)}
                  onChange={(e) => setWithoutOk(prev => { const n = new Set(prev); if (e.target.checked) n.add(w.device_id); else n.delete(w.device_id); return n; })} />
                <span>{w.warning}.</span>
              </label>
            ))}
          </div>
        )}
        {/* A520: tills that are off and need nobody — they no longer hold the close */}
        {(held.length > 0 || waitingConnect.length > 0) && (
          <div className="text-xs text-gray-300 space-y-0.5" data-testid="held-tills">
            {held.map(h => <p key={h.device_id}>· {h.label} — {h.note ?? `not connected; its day${h.business_date ? ` (${h.business_date})` : ''} closes when it next connects`}</p>)}
            {waitingConnect.map(t => <p key={t.device_id}>· {tillLabel(t)} — {t.instruction?.ack?.wait ? 'closed without it; its day closes when its money is closed and confirmed' : 'not connected; its day closes when it next connects'}</p>)}
          </div>
        )}
        {waitingClose.length > 0 && <p className="text-xs text-amber-300">Waiting on {waitingClose.length} till{waitingClose.length === 1 ? '' : 's'} to answer (Close branch still closes the rest).</p>}
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
          disabled={closing || !totalsOk || blockers.length > 0 || dayOpen.length === 0}
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
  onDone: (msg?: string) => void; onCancel: () => void;   // A521: msg — "the till is not connected — this applies when it reconnects"
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
      onDone(r.queued_offline ? `Confirmation saved. ${r.message ?? ""}`.trim() : undefined);
    } finally { setBusy(false); }
  };

  return (
    <div className="mt-2 bg-gray-900/80 border border-action-600/40 rounded-md p-3 space-y-2" data-testid={`confirm-form-${s.id}`}>
      <p className="text-xs text-gray-300">Count each method — the drawer, the M-Pesa statement, the card machine's total. What the system expects is beside it; the difference shows as you type.</p>
      {error && <p className="text-xs text-red-300">{error}</p>}
      {/* A527 (owner, 2026-10-17): the cash in four lines — the float, cash sold, the two together and what the cashier
          keyed in. A till before 1.0.19 does not send the cashier's figure (nor the declaration, unless the owner shows
          it): that line is left out rather than read as "not keyed in". */}
      {(() => {
        const keyed = s.cash.cashier !== undefined ? s.cash.cashier : s.declared ? (s.declared.cash ?? null) : undefined;
        const other = Math.round((s.cash.float_in - s.cash.float_out - s.cash.expenses) * 100) / 100;
        const fl = s.cash.opening_float, sold = s.cash.cash_sales;
        const lines = cashLines({ opening_float: fl, cash_sales: sold, float_plus_sales: Math.round((fl + sold) * 100) / 100, other,
          expected: Number(s.expected.cash ?? 0), cashier: keyed ?? null }).filter((l) => l.key !== 'cashier' || keyed !== undefined);
        return (
          <div className="bg-gray-800/60 rounded-md px-3 py-2 text-sm" data-testid={`confirm-cash-${s.id}`}>
            {lines.map((l) => (
              <div key={l.key} data-testid={`confirm-cash-${l.key}`}
                className={`flex justify-between gap-3 py-0.5 ${l.key === 'cashier' ? 'border-t border-gray-700 mt-1 pt-1.5' : ''}`}>
                <span className={l.strong ? 'text-white font-medium' : 'text-gray-300'}>{l.label}</span>
                <span className={`tabular-nums ${l.strong ? 'text-white font-semibold' : 'text-gray-100'}`}>{l.amount == null ? 'not keyed in' : money(l.amount)}</span>
              </div>
            ))}
          </div>
        );
      })()}
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

/** A465: one cash in / out or expense sent to a till — waiting, recorded, or refused with the till's reason. */
function MoneyLine({ m, money, onCancel }: { m: ShiftMoneyView; money: (n: number) => string; onCancel: () => void }) {
  const what = m.kind === 'expense' ? 'expense' : m.kind === 'float_in' ? 'cash in' : 'cash out';
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs" data-testid={`money-${m.id}`}>
      <span className="text-gray-200 tabular-nums">{money(m.amount)} {what}{m.note ? ` — ${m.note}` : ''}</span>
      {m.status === 'pending' && <>
        <span className="text-amber-300">{m.delivered_at ? 'the till has it — recording' : 'waiting for the till'}</span>
        {!m.delivered_at && <button onClick={onCancel} className="text-gray-400 hover:text-gray-200 underline">Cancel</button>}
      </>}
      {m.status === 'acked' && <span className="text-gray-400">recorded</span>}
      {m.status === 'failed' && <span className="text-red-300">refused: {m.error ?? 'the till did not say why'}</span>}
    </div>
  );
}

/** A465: cash in / out or an expense on one open drawer — the till that holds it records it. */
function ShiftMoneyModal({ till, s, mode, label, money, currency, options, time, onCancel, onDone }: {
  till: TillView; s: BranchPeerShift; mode: 'float' | 'expense'; label: string; money: (n: number) => string; currency: string;
  options: MethodOption[]; time: (iso: string | null) => string; onCancel: () => void; onDone: (msg: string) => void;
}) {
  const [type, setType] = useState<'float_in' | 'float_out'>('float_in');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [desc, setDesc] = useState('');
  const [catId, setCatId] = useState('');
  const [method, setMethod] = useState('cash');
  const [categories, setCategories] = useState<{ id: string; name: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const methods = [...new Set(['cash', 'mpesa', 'card', ...options.map(o => String(o.code).toLowerCase())])];
  const inputCls = 'w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-400 focus:outline-none focus:border-action-500';

  useEffect(() => {
    if (mode === 'expense') posApi.expense.categories().then(setCategories).catch(() => {});
  }, [mode]);

  const save = async () => {
    if (!(Number(amount) > 0)) { setError('Enter an amount greater than zero.'); return; }
    if (mode === 'expense' && !desc.trim()) { setError('Description is required.'); return; }
    setBusy(true); setError('');
    try {
      const r = await posApi.branchClose.shiftMoney(mode === 'float'
        ? { device_id: till.device_id, shift_id: s.id, kind: type, amount: Number(amount), reason: reason.trim() || undefined }
        : { device_id: till.device_id, shift_id: s.id, kind: 'expense', amount: Number(amount), description: desc.trim(),
            expense_category_id: catId || undefined, category_name: categories.find(c => c.id === catId)?.name, payment_method: method });
      if (!r.ok) { setError(r.error ?? 'Could not record it.'); return; }
      // A521: to a till that is off it waits for it — said so (r.message: "the till is not connected — this applies when it reconnects").
      onDone(r.direct ? 'Recorded on this terminal\'s drawer.' : r.queued_offline ? `Saved. ${r.message ?? ''}`.trim() : 'Sent — the till records it within about 15 seconds.');
    } catch (e: any) { setError(e?.message ?? 'Could not record it.'); }
    finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center px-4 z-[60] animate-fade-in" data-testid="shift-money-modal">
      <div className="bg-gray-900 border border-gray-800 rounded-2xl w-full max-w-md max-h-[90vh] flex flex-col animate-pop-in">
        <div className="flex items-start justify-between px-6 py-4 border-b border-gray-800">
          <div>
            <h2 className="text-white font-bold">{mode === 'float' ? 'Cash in / out' : 'Expense'}</h2>
            <p className="text-xs text-gray-400" data-testid="shift-money-drawer">
              {label} · {s.cashier_name} · opened {time(s.opened_at)} · cash expected {money(s.expected.cash ?? 0)}
            </p>
          </div>
          <button onClick={onCancel} className="text-gray-300 hover:text-white">✕</button>
        </div>
        <div className="p-6 space-y-3 overflow-y-auto">
          {error && <p className="text-red-300 text-sm bg-red-400/10 border border-red-400/20 rounded-lg px-3 py-2">{error}</p>}
          {mode === 'float' ? (<>
            <div className="flex gap-2">
              {(['float_in', 'float_out'] as const).map(k => (
                <button key={k} onClick={() => setType(k)} data-testid={`shift-money-${k}`}
                  className={`flex-1 px-3 py-2 rounded-lg text-sm border ${type === k ? 'bg-action-500 border-action-500 text-gray-950 font-semibold' : 'border-gray-600 text-gray-200'}`}>
                  {k === 'float_in' ? 'Cash in' : 'Cash out'}
                </button>
              ))}
            </div>
            <label className="block space-y-1">
              <span className="text-xs text-gray-400">Amount ({currency})</span>
              <input className={inputCls} type="number" min="0" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </label>
            <label className="block space-y-1">
              <span className="text-xs text-gray-400">Reason</span>
              <input className={inputCls} value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} placeholder={type === 'float_in' ? 'e.g. Change top-up' : 'e.g. Banked'} />
            </label>
          </>) : (<>
            <label className="block space-y-1">
              <span className="text-xs text-gray-400">Type</span>
              <select className={inputCls} value={catId} onChange={(e) => setCatId(e.target.value)}>
                <option value="">No type</option>
                {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
            <label className="block space-y-1">
              <span className="text-xs text-gray-400">Description</span>
              <input className={inputCls} value={desc} maxLength={200} onChange={(e) => setDesc(e.target.value)} placeholder="e.g. Gas refill" />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block space-y-1">
                <span className="text-xs text-gray-400">Amount ({currency})</span>
                <input className={inputCls} type="number" min="0" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
              </label>
              <label className="block space-y-1">
                <span className="text-xs text-gray-400">Paid with</span>
                <select className={inputCls} value={method} onChange={(e) => setMethod(e.target.value)}>
                  {methods.map(m => <option key={m} value={m}>{methodLabel(m)}</option>)}
                </select>
              </label>
            </div>
            <p className="text-xs text-gray-400">{method === 'cash' ? 'Cash comes out of this drawer — its expected cash goes down.' : 'Not cash — the drawer is not affected.'}</p>
          </>)}
          <div className="flex gap-2 pt-1">
            <button data-testid="shift-money-save" onClick={() => void save()} disabled={busy}
              className="px-4 py-2 rounded-lg bg-action-500 hover:bg-action-400 text-gray-950 text-sm font-semibold disabled:opacity-50">
              {busy ? 'Saving…' : 'Save'}
            </button>
            <button onClick={onCancel} disabled={busy} className="px-4 py-2 rounded-lg border border-gray-600 text-gray-200 text-sm">Cancel</button>
          </div>
        </div>
      </div>
    </div>
  );
}
