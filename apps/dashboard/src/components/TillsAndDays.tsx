/**
 * TillsAndDays — A523: every till of the business, its open trading day and drawers, and what waits for it — with the
 * actions that close them from the cloud.
 *
 * Owner, 2026-10-17: "I don't want this back and forth, clients not being able to do simple tasks day to day operations,
 * to make it worse there is no location on the cloud where I can close day as the owner or tech support remote force
 * close." One screen per till: name / code, branch, version, when it last synced, its open day, its open drawers (who,
 * since when, float, expected so far when the viewer may see figures), the shifts waiting for a manager, the closes
 * waiting for it (and why), retired / silent flags. Actions — each asks for a short reason, a tick when the till is
 * silent (its sales since are not on the web yet), and is recorded:
 *   • Close day — on the confirmed shift counts, or a count entered; it takes effect on the web AT ONCE and the till
 *     adopts it when it connects. A drawer still open refuses, unless "force-close the open drawer first" is ticked.
 *   • Force-close drawer (uncounted), or close it with a count.
 *   • Withdraw a stuck close; close a retired / silent till's day as abandoned.
 * Used by the owner (pages/TillsDaysPage, every branch), the manager portal (their branch — shifts.close_day /
 * shifts.force_close) — cloud: routes/tills-days.ts — and, as its own card, the admin portal.
 */
import { useCallback, useEffect, useState } from 'react';
import { money, dateTime } from '../lib/format';
import { agoLabel, syncRecent } from '../lib/tillSync';
import { CreditAwaitingNotice } from './CreditSalesToConfirm';   // A545

interface Client { get: <T>(p: string) => Promise<T>; post: <T>(p: string, body?: unknown) => Promise<T> }

interface Drawer { id: string; cashier_name: string; opened_at: string; opening_float: number; expected_cash: number | null }
interface Awaiting { id: string; cashier_name: string; closed_at: string | null }
interface Waiting { id: string; business_date: string; created_at: string; delivered_at: string | null; waiting: boolean; code: string | null; error: string | null; cloud_closed: boolean; reason: string | null }
interface Till {
  device_id: string; label: string; branch_id: string | null; branch_name: string | null; app_version: string | null; last_sync_at: string | null;
  silent: boolean; long_silent: boolean; retired: boolean; on_fleet: boolean; may_abandon: boolean;
  open_days: Array<{ id: string; business_date: string; opened_at: string | null }>;
  open_drawers: Drawer[]; awaiting: Awaiting[]; pending: Waiting[];
}
interface Overview { tills: Till[]; may: { close_day: boolean; force_close: boolean }; sees_figures: boolean; abandon_after_hours: number }

type Action =
  | { kind: 'close_day'; till: Till; date: string }
  | { kind: 'drawer'; till: Till; drawer: Drawer; counted: boolean }
  | { kind: 'cancel'; till: Till; waiting: Waiting }
  | { kind: 'abandon'; till: Till; date: string };

const WAIT_CODE: Record<string, string> = {
  DRAWER_OPEN: 'a drawer is still open on the POS',
  SHIFTS_UNCONFIRMED: 'a shift on the POS waits for a manager’s confirmation',
};

function waitingLine(w: Waiting): string {
  if (w.cloud_closed) return `Day ${w.business_date} closed on the web — the POS adopts it when it next connects${w.delivered_at ? ' (it has collected it)' : ''}.`;
  if (w.waiting) return `Close of ${w.business_date} waiting — ${w.code && WAIT_CODE[w.code] ? WAIT_CODE[w.code] : (w.error ?? 'the POS cannot close yet')}; it tries again at every sync.`;
  return `Close of ${w.business_date} queued ${agoLabel(w.created_at)} — ${w.delivered_at ? 'collected, waiting for the POS' : 'the POS applies it when it next connects'}.`;
}

export default function TillsAndDays({ client, currency, base = '/api/tills-days', heading = true }:
  { client: Client; currency: string; base?: string; heading?: boolean }) {
  const [ov, setOv] = useState<Overview | null>(null);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const [act, setAct] = useState<Action | null>(null);
  const [reason, setReason] = useState('');
  const [count, setCount] = useState('');
  const [silentOk, setSilentOk] = useState(false);
  const [forceOk, setForceOk] = useState(false);
  const [abandonOk, setAbandonOk] = useState(false);
  const [askForce, setAskForce] = useState(false);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setOv(await client.get<Overview>(`${base}/overview`)); setError(''); }
    catch (e: any) { setError(e?.message ?? 'Could not load the points of sale'); }
  }, [client, base]);
  useEffect(() => {
    void load();
    const t = setInterval(() => { void load(); }, 20_000);   // the till answering shows within a beat
    return () => clearInterval(t);
  }, [load]);

  const open = (a: Action) => {
    setAct(a); setReason(''); setCount(''); setSilentOk(false); setForceOk(false); setAbandonOk(false); setMsg('');
    setAskForce(a.kind === 'close_day' && a.till.open_drawers.length > 0);
  };

  const submit = async () => {
    if (!act) return;
    if (!reason.trim()) { setMsg('Say why — a short reason is kept with it.'); return; }
    const silent = act.till.silent && act.kind !== 'cancel' && act.kind !== 'abandon';
    if (silent && !silentOk) { setMsg('Tick that you understand the POS’s sales since it last synced are not in this yet.'); return; }
    const typed = count.trim();
    const amount = typed === '' ? null : Number(typed);
    if (amount !== null && (!Number.isFinite(amount) || amount < 0)) { setMsg('The count must be 0 or more — or leave it empty.'); return; }
    if (act.kind === 'drawer' && act.counted && amount === null) { setMsg('Enter the cash counted in the drawer.'); return; }
    setBusy(true); setMsg('');
    try {
      if (act.kind === 'close_day') {
        await client.post(`${base}/close-day`, { device_id: act.till.device_id, business_date: act.date, counted_cash: amount, reason: reason.trim(),
          silent_ok: silentOk, force_drawers: forceOk });
        setDone(`${act.till.label}: day ${act.date} closed on the web. The POS adopts it when it next connects.`);
      } else if (act.kind === 'drawer') {
        await client.post(`${base}/close-drawer`, { shift_id: act.drawer.id, counted_cash: act.counted ? amount : null, reason: reason.trim(), silent_ok: silentOk });
        setDone(`${act.drawer.cashier_name}'s drawer on ${act.till.label} ${act.counted ? 'closed with your count' : 'force-closed (uncounted)'}.`);
      } else if (act.kind === 'cancel') {
        const r = await client.post<{ delivered?: boolean }>(`${base}/instructions/${act.waiting.id}/cancel`, { reason: reason.trim() });
        setDone(`Close withdrawn${r?.delivered ? ' — the POS had already collected it and may still carry it out' : ''}.`);
      } else {
        if (!abandonOk) { setMsg('Tick that you understand the POS’s unsent sales are not in this close.'); setBusy(false); return; }
        await client.post(`${base}/abandon`, { device_id: act.till.device_id, business_date: act.date, reason: reason.trim(), confirm: true });
        setDone(`${act.till.label}: day ${act.date} closed as abandoned.`);
      }
      setAct(null);
      await load();
    } catch (e: any) {
      if (e?.code === 'DRAWER_OPEN') { setAskForce(true); setMsg(e?.message ?? 'A drawer is still open.'); }
      else setMsg(e?.message ?? 'That did not go through.');
    } finally { setBusy(false); }
  };

  const tills = ov?.tills ?? [];
  const byBranch = new Map<string, Till[]>();
  for (const t of tills) {
    const k = t.branch_name ?? 'No branch';
    byBranch.set(k, [...(byBranch.get(k) ?? []), t]);
  }
  const btn = 'px-3 py-1.5 rounded-lg text-xs font-semibold border disabled:opacity-40';

  return (
    <div className="space-y-4" data-testid="tills-and-days">
      {heading && (
        <div>
          <h3 className="text-sm font-semibold text-gray-200">Tills &amp; days</h3>
          <p className="text-xs text-gray-500">
            Every POS, its open trading day and drawers. Close a day or a drawer from here — it takes effect on the web at once
            and the POS adopts it when it next connects (about every 90 seconds while it is on). A POS locks only when there
            is money to count; an old day with nothing left to count closes itself.
          </p>
        </div>
      )}
      {/* A545: credit sales still waiting for a manager — said, never a block on closing (the owner: no deadlocks). */}
      <CreditAwaitingNotice client={client} />
      {error && <p className="text-xs text-red-400">{error}</p>}
      {done && <p className="text-xs text-action-400" data-testid="td-done">{done}</p>}
      {!ov && !error && <p className="text-xs text-gray-500">Loading tills…</p>}
      {ov && tills.length === 0 && <p className="text-xs text-gray-500">No points of sale yet.</p>}

      {[...byBranch.entries()].map(([branch, list]) => (
        <div key={branch} className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wider text-gray-500">{branch}</p>
          {list.map((t) => (
            <div key={t.device_id} className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-2" data-testid={`till-${t.device_id}`}>
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="text-sm font-semibold text-gray-100">{t.label}</span>
                <span className="text-xs text-gray-500">{t.app_version ? `v${t.app_version}` : 'version not known'}</span>
                <span className={`text-xs ${syncRecent(t.last_sync_at) ? 'text-gray-500' : 'text-amber-400'}`}>last synced {agoLabel(t.last_sync_at)}</span>
                {t.retired && <span className="text-xs text-red-400">retired</span>}
                {!t.retired && t.long_silent && <span className="text-xs text-red-400">silent over {ov?.abandon_after_hours ?? 24} h</span>}
                {!t.on_fleet && <span className="text-xs text-amber-400">not on the fleet list</span>}
              </div>

              {t.open_days.length === 0 && t.open_drawers.length === 0 && <p className="text-xs text-gray-500">No open trading day.</p>}
              {t.open_days.map((d) => (
                <div key={d.id} className="flex flex-wrap items-center gap-2 justify-between">
                  <p className="text-xs text-gray-300">Trading day <b>{d.business_date}</b> open{d.opened_at ? ` since ${dateTime(d.opened_at)}` : ''}</p>
                  <div className="flex flex-wrap gap-2">
                    {ov?.may.close_day && !t.retired && !t.pending.some((w) => w.cloud_closed && w.business_date === d.business_date) && (
                      <button className={`${btn} border-amber-500/50 text-amber-300`} data-testid={`td-close-day-${t.device_id}`} onClick={() => open({ kind: 'close_day', till: t, date: d.business_date })}>Close day</button>
                    )}
                    {ov?.may.close_day && t.may_abandon && (
                      <button className={`${btn} border-red-500/50 text-red-400`} data-testid={`td-abandon-${t.device_id}`} onClick={() => open({ kind: 'abandon', till: t, date: d.business_date })}>Close as abandoned</button>
                    )}
                  </div>
                </div>
              ))}

              {t.open_drawers.map((s) => (
                <div key={s.id} className="flex flex-wrap items-center gap-2 justify-between border-t border-gray-800 pt-2">
                  <p className="text-xs text-gray-300">
                    Drawer open — <b>{s.cashier_name}</b> since {dateTime(s.opened_at)} · float {money(s.opening_float, currency)}
                    {ov?.sees_figures && s.expected_cash !== null ? <> · expected so far <b>{money(s.expected_cash, currency)}</b></> : null}
                  </p>
                  {ov?.may.force_close && (
                    <div className="flex flex-wrap gap-2">
                      <button className={`${btn} border-gray-600 text-gray-200`} data-testid={`td-count-${s.id}`} onClick={() => open({ kind: 'drawer', till: t, drawer: s, counted: true })}>Close with count</button>
                      <button className={`${btn} border-red-500/50 text-red-400`} data-testid={`td-force-${s.id}`} onClick={() => open({ kind: 'drawer', till: t, drawer: s, counted: false })}>Force-close</button>
                    </div>
                  )}
                </div>
              ))}

              {t.awaiting.length > 0 && (
                <p className="text-xs text-amber-300 border-t border-gray-800 pt-2">
                  Waiting for a manager’s confirmation: {t.awaiting.map((a) => `${a.cashier_name}${a.closed_at ? ` (closed ${dateTime(a.closed_at)})` : ''}`).join(', ')} —
                  confirm them under Open drawers › Shifts to confirm before closing the day.
                </p>
              )}

              {t.pending.map((w) => (
                <div key={w.id} className="flex flex-wrap items-center gap-2 justify-between border-t border-gray-800 pt-2">
                  <p className={`text-xs ${w.waiting ? 'text-amber-300' : 'text-gray-400'}`}>{waitingLine(w)}{w.reason ? ` Reason: ${w.reason}.` : ''}</p>
                  {ov?.may.close_day && !w.cloud_closed && (
                    <button className={`${btn} border-gray-600 text-gray-300`} data-testid={`td-cancel-${w.id}`} onClick={() => open({ kind: 'cancel', till: t, waiting: w })}>Withdraw</button>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
      ))}

      {act && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-2xl p-6 max-w-md w-full max-h-[90vh] overflow-y-auto space-y-3" data-testid="td-dialog">
            <h4 className="text-base font-semibold text-gray-100">
              {act.kind === 'close_day' && `Close ${act.till.label} — day ${act.date}`}
              {act.kind === 'drawer' && `${act.counted ? 'Close with a count' : 'Force-close'}: ${act.drawer.cashier_name}’s drawer on ${act.till.label}`}
              {act.kind === 'cancel' && `Withdraw the close of ${act.waiting.business_date} on ${act.till.label}`}
              {act.kind === 'abandon' && `Close ${act.till.label} — day ${act.date} — as abandoned`}
            </h4>
            <p className="text-xs text-gray-400">
              {act.kind === 'close_day' && 'It closes on the web now, on the cash the managers confirmed shift by shift — or on a count you enter (only one made at the POS, never an estimate). The POS adopts it when it next connects; anything it sold offline is added to its drawers when it arrives.'}
              {act.kind === 'drawer' && (act.counted
                ? 'Enter the cash counted in the drawer. It closes counted, under your name; the POS closes it too when it next connects.'
                : 'It is recorded as never counted — no closing count and no difference (not zero). Use it only when nobody can count the drawer.')}
              {act.kind === 'cancel' && 'The POS will not carry it out (unless it already collected it).'}
              {act.kind === 'abandon' && `For a POS that is retired or silent over ${ov?.abandon_after_hours ?? 24} h: its open drawers are force-closed uncounted and the day closed with what the web knows. If it comes back it closes its own day too.`}
            </p>
            {act.kind === 'drawer' && ov?.sees_figures && act.drawer.expected_cash !== null && (
              <p className="text-xs text-gray-300">Expected in the drawer so far: <b>{money(act.drawer.expected_cash, currency)}</b></p>
            )}
            {(act.kind === 'close_day' || (act.kind === 'drawer' && act.counted)) && (
              <>
                <label className="block text-xs text-gray-400">Cash counted ({currency}){act.kind === 'close_day' ? ' — optional' : ''}</label>
                <input className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100" type="number" min="0" step="any" inputMode="decimal"
                  placeholder={act.kind === 'close_day' ? 'Empty = the confirmed shift counts' : ''} value={count} onChange={(e) => setCount(e.target.value)} data-testid="td-count" />
              </>
            )}
            <label className="block text-xs text-gray-400">Reason (required)</label>
            <textarea className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100" rows={2} maxLength={300}
              value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. T2 was off all night, cashier gone home" data-testid="td-reason" />
            {act.till.silent && act.kind !== 'cancel' && act.kind !== 'abandon' && (
              <label className="flex gap-2 items-start text-xs text-amber-300" data-testid="td-silent">
                <input type="checkbox" checked={silentOk} onChange={(e) => setSilentOk(e.target.checked)} className="mt-0.5" />
                <span>{act.till.label} last synced {agoLabel(act.till.last_sync_at)} — its sales since then are not on the web yet; it applies this when it next connects.</span>
              </label>
            )}
            {act.kind === 'close_day' && askForce && (
              <label className="flex gap-2 items-start text-xs text-red-300" data-testid="td-force-drawers">
                <input type="checkbox" checked={forceOk} onChange={(e) => setForceOk(e.target.checked)} className="mt-0.5" />
                <span>Force-close the open drawer{act.till.open_drawers.length === 1 ? '' : 's'} first ({act.till.open_drawers.map((d) => d.cashier_name).join(', ') || 'on the POS'}) — recorded uncounted.</span>
              </label>
            )}
            {act.kind === 'abandon' && (
              <label className="flex gap-2 items-start text-xs text-amber-300">
                <input type="checkbox" checked={abandonOk} onChange={(e) => setAbandonOk(e.target.checked)} className="mt-0.5" />
                <span>I understand this till’s unsent sales are not in this close.</span>
              </label>
            )}
            {msg && <p className="text-xs text-red-400">{msg}</p>}
            <div className="flex gap-3">
              <button className="flex-1 px-3 py-2 rounded-lg text-sm bg-gray-800 text-gray-300" onClick={() => setAct(null)} disabled={busy}>Cancel</button>
              <button className="flex-1 px-3 py-2 rounded-lg text-sm font-semibold bg-amber-500 text-black disabled:opacity-40" data-testid="td-submit"
                onClick={() => void submit()} disabled={busy || !reason.trim()}>
                {busy ? 'Working…' : act.kind === 'close_day' ? 'Close the day' : act.kind === 'drawer' ? (act.counted ? 'Close with this count' : 'Force-close as uncounted') : act.kind === 'cancel' ? 'Withdraw' : 'Close as abandoned'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
