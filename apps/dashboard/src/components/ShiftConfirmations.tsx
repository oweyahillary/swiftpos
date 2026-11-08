/**
 * ShiftConfirmations — A365: a manager confirms cashiers' shifts from the dashboard, and sees who confirmed what.
 *
 * Owner, 2026-09-29: "the managers should confirm shift before closing the day … They can confirm anytime but
 * recommended the moment the cashier closes … They should recount incase the cashier submitted less than the amount …
 * on all payment method". A manager signed in here confirms as themselves (no PIN).
 * A462 (owner, 2026-10-13: "let the manager see what the system holds … the variance before confirming" — A452 on the
 * till; now the web too): the expected figure per method and the difference as typed. Used on the owner's Open drawers
 * page and (A462) the manager's Shifts tab — `client` is whichever sign-in the page holds.
 */
import { useCallback, useEffect, useState, Fragment } from 'react';
import { DESK, useRowMore, ViewMore, MoreRow } from './RowMore';   // A464
import { api } from '../lib/api';
import { methodName, methodsToCount, readAmounts, confirmationLabel, cashLines, type CashBreakdown } from '@zaptill/core/shiftConfirm';
import { reasonsNeeded, missingReasons, REASON_MAX } from '@zaptill/core/confirmReasons';
import { money, dateTime } from '../lib/format';

interface ClosedShift {
  id: string;
  cashier_name: string;
  terminal_code: string | null;
  opened_at: string;
  closed_at: string | null;
  declared_methods: Record<string, number> | null;
  expected_methods: Record<string, number> | null;
  confirmed_methods: Record<string, number> | null;
  confirmed_at: string | null;
  confirmer_name: string | null;
  confirm_self: boolean;
  awaiting_confirmation: boolean;
  confirm_reasons?: Record<string, string> | null;   // 0.6.27
}

const order = (codes: string[]) => [...codes].sort((a, b) => (a === 'cash' ? -1 : b === 'cash' ? 1 : a.localeCompare(b)));

/** Methods where the manager's recount differs from the cashier's declaration. */
export function mismatches(s: Pick<ClosedShift, 'declared_methods' | 'confirmed_methods'>): string[] {
  if (!s.declared_methods || !s.confirmed_methods) return [];
  const codes = new Set([...Object.keys(s.declared_methods), ...Object.keys(s.confirmed_methods)]);
  return order([...codes]).filter((m) => Math.round((s.declared_methods![m] ?? 0) * 100) !== Math.round((s.confirmed_methods![m] ?? 0) * 100));
}

interface Client { get: <T>(p: string) => Promise<T>; post: <T>(p: string, body?: unknown) => Promise<T> }

export default function ShiftConfirmations({ client = api as unknown as Client, currency = 'KES' }: { client?: Client; currency?: string } = {}) {
  const [shifts, setShifts] = useState<ClosedShift[]>([]);
  const more = useRowMore();   // A464: the confirmed list on a phone shows Cashier and Cash counted / expected
  const [error, setError] = useState('');
  const [target, setTarget] = useState<ClosedShift | null>(null);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  // 0.6.27 ('confirm_shows_cashier_figures'): the cashier's figures beside the boxes, and a reason where they differ.
  const [view, setView] = useState<{ showCashier: boolean; declared: Record<string, number> | null; expected?: Record<string, number> | null; cash?: CashBreakdown | null }>({ showCashier: false, declared: null });
  const [reasons, setReasons] = useState<Record<string, string>>({});
  useEffect(() => {
    setView({ showCashier: false, declared: null }); setReasons({});
    if (!target) return;
    client.get<{ showCashier: boolean; declared: Record<string, number> | null; expected?: Record<string, number> | null; cash?: CashBreakdown | null }>(`/api/shifts/${target.id}/confirm-view`)
      .then(setView).catch(() => {});
  }, [target, client]);
  const showExpected = !!view.expected;   // A462: the cloud sends them to a manager / the owner only

  const load = useCallback(async () => {
    setError('');
    try {
      setShifts(await client.get<ClosedShift[]>('/api/shifts?status=closed&limit=100'));
    } catch (e: any) {
      setError(e?.message ?? 'Could not load closed shifts');
    }
  }, [client]);
  useEffect(() => { void load(); }, [load]);

  const awaiting = shifts.filter((s) => s.awaiting_confirmation);
  const confirmed = shifts.filter((s) => s.confirmed_at).slice(0, 20);

  const confirm = async () => {
    if (!target) return;
    const codes = methodsToCount(target.declared_methods);
    const r = readAmounts(inputs, codes);
    if (r.ok === false) { setMsg(`Enter the counted amount for: ${r.missing.map((m) => methodName(m)).join(', ')}.`); return; }
    if (view.showCashier) {
      const missing = missingReasons(reasonsNeeded(view.declared, r.map), reasons);
      if (missing.length) { setMsg(`Give a reason where your count differs from the cashier's: ${missing.map((m) => methodName(m)).join(', ')}.`); return; }
    }
    setBusy(true); setMsg('');
    try {
      await client.post(`/api/shifts/${target.id}/confirm`, { confirmed_methods: r.map, ...(view.showCashier ? { confirm_reasons: reasons } : {}) });
      setTarget(null); setInputs({});
      await load();
    } catch (e: any) {
      setMsg(e?.message ?? 'Could not confirm this shift');
    } finally { setBusy(false); }
  };

  return (
    <div className="space-y-3" data-testid="shift-confirmations">
      <h2 className="text-base font-semibold text-gray-900 dark:text-white">Shift confirmations</h2>
      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      {awaiting.length === 0 ? (
        <p className="text-sm text-gray-500">No shift is waiting for a manager's check.</p>
      ) : (
        <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 p-3 space-y-2">
          <p className="text-sm font-medium text-amber-800 dark:text-amber-200">
            {awaiting.length === 1 ? '1 shift awaits' : `${awaiting.length} shifts await`} a manager's check
          </p>
          {awaiting.map((s) => (
            <div key={s.id} className="flex flex-wrap items-center justify-between gap-2 text-sm text-amber-900 dark:text-amber-100">
              <span>{s.cashier_name} · {s.terminal_code ?? 'Web'} · closed {dateTime(s.closed_at)}</span>
              <button onClick={() => { setTarget(s); setInputs({}); setMsg(''); }} data-testid={`confirm-${s.id}`}
                className="px-3 py-1 rounded bg-gray-900 dark:bg-white text-white dark:text-gray-900 text-xs font-medium">Confirm</button>
            </div>
          ))}
        </div>
      )}

      {confirmed.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500">
                <th className="py-1">Cashier</th><th className={DESK}>Closed</th><th className={DESK}>Confirmed by</th><th>Cash counted / expected</th><th className={DESK}>Differs from cashier</th>
              </tr>
            </thead>
            <tbody>
              {confirmed.map((s) => {
                const diff = mismatches(s);
                const diffText = diff.length ? diff.map((m) => `${methodName(m)}: ${money(s.declared_methods?.[m], currency)} → ${money(s.confirmed_methods?.[m], currency)}`
                        + (s.confirm_reasons?.[m] ? ` (${s.confirm_reasons[m]})` : '')).join('; ') : '—';
                const diffTone = diff.length ? 'text-red-600 dark:text-red-400 font-medium' : 'text-gray-400';
                return (
                  <Fragment key={s.id}>
                  <tr className="border-t border-gray-100 dark:border-gray-800 text-gray-800 dark:text-gray-200">
                    <td className="py-1">{s.cashier_name}
                      <ViewMore open={more.isOpen(String(s.id))} onClick={() => more.toggle(String(s.id))} />
                    </td>
                    <td className={DESK}>{dateTime(s.closed_at)}</td>
                    <td className={DESK}>{s.confirmer_name ?? '—'}{s.confirm_self ? <span className="ml-1 text-xs text-amber-600" data-testid="self-confirmed">(self-confirmed)</span> : null}</td>
                    <td>{money(s.confirmed_methods?.cash, currency)} / {money(s.expected_methods?.cash, currency)}</td>
                    <td className={`${diffTone} ${DESK}`}>
                      {diffText}
                    </td>
                  </tr>
                  <MoreRow open={more.isOpen(String(s.id))} colSpan={2} items={[
                    ['Closed', dateTime(s.closed_at)],
                    ['Confirmed by', <>{s.confirmer_name ?? '—'}{s.confirm_self ? <span className="ml-1 text-xs text-amber-600">(self-confirmed)</span> : null}</>],
                    ['Differs from cashier', <span className={diffTone}>{diffText}</span>],
                  ]} />
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {target && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4 animate-fade-in">
          <div className="bg-white dark:bg-gray-900 rounded-xl w-full max-w-lg border border-gray-200 dark:border-gray-700 p-5 space-y-3 max-h-[90vh] overflow-y-auto animate-pop-in">
            <h3 className="text-base font-semibold text-gray-900 dark:text-white">Confirm {target.cashier_name}'s shift</h3>
            <p className="text-xs text-gray-500">
              {showExpected
                ? 'Count every payment method — the drawer, the M-Pesa statement, the card machine\'s total. What the system expects is beside each; the difference shows as you type.'
                : view.showCashier
                ? 'Count every payment method yourself and enter what you find beside the cashier\'s figure. Where they differ, say why.'
                : 'Count every payment method yourself — the drawer, the M-Pesa statement, the card machine\'s total — and enter what you find. The cashier\'s figures are shown after you save.'}
              {' '}{confirmationLabel({ status: 'awaiting' })}.
            </p>
            {/* 0.6.29 (owner): one table — who, when, and per method the cashier's figure, the manager's own count
                (the confirm or the dispute) and the reason where they differ. */}
            <div className="grid grid-cols-2 gap-x-3 text-xs text-gray-600 dark:text-gray-300" data-testid="confirm-head">
              <span className="text-gray-500">Cashier</span><span className="text-right">{target.cashier_name}</span>
              <span className="text-gray-500">Shift</span><span className="text-right">{dateTime(target.opened_at)} – {dateTime(target.closed_at)}</span>
            </div>
            {/* A527 (owner, 2026-10-17): the cash in four lines — the float, cash sold, the two together and what the
                cashier keyed in (with cash in/out and the drawer's expected when there was any). Managers only. */}
            {view.cash && (
              <div className="rounded-lg bg-gray-50 dark:bg-gray-800/60 px-3 py-2 text-sm" data-testid="confirm-cash">
                {cashLines(view.cash).map((l) => (
                  <div key={l.key} data-testid={`confirm-cash-${l.key}`}
                    className={`flex justify-between gap-3 py-0.5 ${l.key === 'cashier' ? 'border-t border-gray-200 dark:border-gray-700 mt-1 pt-1.5' : ''}`}>
                    <span className={l.strong ? 'font-medium text-gray-900 dark:text-white' : 'text-gray-600 dark:text-gray-300'}>{l.label}</span>
                    <span className={`tabular-nums ${l.strong ? 'font-semibold text-gray-900 dark:text-white' : 'text-gray-800 dark:text-gray-100'}`}>
                      {l.amount == null ? 'not keyed in' : money(l.amount, currency)}</span>
                  </div>
                ))}
              </div>
            )}
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="confirm-table">
                <thead>
                  <tr className="text-xs text-gray-500 text-left">
                    <th className="font-normal pb-1">Method</th>
                    {showExpected && <th className="font-normal pb-1 text-right pr-2">Expected</th>}
                    {view.showCashier && <th className="font-normal pb-1 text-right pr-2">Cashier</th>}
                    <th className="font-normal pb-1">Manager</th>
                    {showExpected && <th className="font-normal pb-1 text-right">Difference</th>}
                  </tr>
                </thead>
                <tbody>
                  {methodsToCount(target.declared_methods).map((m) => {
                    const cashierSaid = view.showCashier && view.declared ? (view.declared[m] ?? 0) : null;
                    const typed = inputs[m] ?? '';
                    const differs = cashierSaid !== null && typed.trim() !== '' && Math.round(Number(typed) * 100) !== Math.round(cashierSaid * 100);
                    const exp = showExpected ? Number(view.expected?.[m] ?? 0) : null;
                    const v = exp !== null && typed.trim() !== '' && Number.isFinite(Number(typed)) ? Math.round((Number(typed) - exp) * 100) / 100 : null;
                    return [
                      <tr key={m}>
                        <td className="py-1 text-gray-800 dark:text-gray-200 whitespace-nowrap">{methodName(m)}</td>
                        {showExpected && (
                          <td className="py-1 pr-2 text-right text-gray-700 dark:text-gray-200 tabular-nums" data-testid={`expected-${m}`}>{money(exp ?? 0, currency)}</td>
                        )}
                        {view.showCashier && (
                          <td className="py-1 pr-2 text-right text-gray-600 dark:text-gray-300 tabular-nums" data-testid={`cashier-${m}`}>{money(cashierSaid ?? 0, currency)}</td>
                        )}
                        <td className="py-1">
                          <input type="number" min={0} step="0.01" inputMode="decimal" value={typed} data-testid={`confirm-input-${m}`}
                            onChange={(e) => setInputs({ ...inputs, [m]: e.target.value })} onWheel={(e) => (e.target as HTMLInputElement).blur()}
                            className={`w-full rounded-lg border ${differs ? 'border-amber-400' : 'border-gray-300 dark:border-gray-700'} bg-white dark:bg-gray-950 px-3 py-2 text-sm text-gray-900 dark:text-white`} />
                        </td>
                        {showExpected && (
                          <td data-testid={`variance-${m}`} className={`py-1 pl-2 text-right tabular-nums whitespace-nowrap ${v === null ? 'text-gray-400' : v === 0 ? 'text-gray-600 dark:text-gray-300' : v > 0 ? 'text-amber-600 dark:text-amber-300' : 'text-red-600 dark:text-red-400'}`}>
                            {v === null ? '—' : v === 0 ? 'balanced' : `${v > 0 ? 'over' : 'short'} ${money(Math.abs(v), currency)}`}
                          </td>
                        )}
                      </tr>,
                      differs && (
                        <tr key={`${m}-reason`}>
                          <td colSpan={2 + (view.showCashier ? 1 : 0) + (showExpected ? 2 : 0)} className="pb-2">
                            <input type="text" maxLength={REASON_MAX} value={reasons[m] ?? ''} data-testid={`reason-${m}`}
                              placeholder={`Reason — ${methodName(m)} is ${Number(typed) > (cashierSaid ?? 0) ? 'more' : 'less'} than the cashier's`}
                              onChange={(e) => setReasons({ ...reasons, [m]: e.target.value })}
                              className="w-full rounded-lg border border-amber-400 bg-white dark:bg-gray-950 px-3 py-2 text-sm text-gray-900 dark:text-white" />
                          </td>
                        </tr>
                      ),
                    ];
                  })}
                </tbody>
              </table>
            </div>
            {msg && <p className="text-sm text-red-600 dark:text-red-400">{msg}</p>}
            <div className="flex gap-2 justify-end">
              <button onClick={() => setTarget(null)} disabled={busy} className="px-3 py-2 text-sm text-gray-600 dark:text-gray-400">Cancel</button>
              <button onClick={confirm} disabled={busy}
                className="px-4 py-2 text-sm rounded-lg bg-gray-900 dark:bg-white text-white dark:text-gray-900 font-medium">
                {busy && <span className="spin-dot" aria-hidden />}
                {busy ? 'Confirming…' : 'Confirm shift'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
