/**
 * ShiftConfirmations — A365: a manager confirms cashiers' shifts from the dashboard, and sees who confirmed what.
 *
 * Owner, 2026-09-29: "the managers should confirm shift before closing the day … They can confirm anytime but
 * recommended the moment the cashier closes … They should recount incase the cashier submitted less than the amount …
 * on all payment method". A manager signed in here confirms as themselves (no PIN); the recount is BLIND — the
 * cashier's and the expected figures are shown only after it is saved.
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { methodName, methodsToCount, readAmounts, confirmationLabel } from '../lib/shiftConfirm';

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
}

const money = (v: number | null | undefined) =>
  `KES ${Number(v ?? 0).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-KE', { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const order = (codes: string[]) => [...codes].sort((a, b) => (a === 'cash' ? -1 : b === 'cash' ? 1 : a.localeCompare(b)));

/** Methods where the manager's recount differs from the cashier's declaration. */
export function mismatches(s: Pick<ClosedShift, 'declared_methods' | 'confirmed_methods'>): string[] {
  if (!s.declared_methods || !s.confirmed_methods) return [];
  const codes = new Set([...Object.keys(s.declared_methods), ...Object.keys(s.confirmed_methods)]);
  return order([...codes]).filter((m) => Math.round((s.declared_methods![m] ?? 0) * 100) !== Math.round((s.confirmed_methods![m] ?? 0) * 100));
}

export default function ShiftConfirmations() {
  const [shifts, setShifts] = useState<ClosedShift[]>([]);
  const [error, setError] = useState('');
  const [target, setTarget] = useState<ClosedShift | null>(null);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      setShifts(await api.get<ClosedShift[]>('/api/shifts?status=closed&limit=100'));
    } catch (e: any) {
      setError(e?.message ?? 'Could not load closed shifts');
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const awaiting = shifts.filter((s) => s.awaiting_confirmation);
  const confirmed = shifts.filter((s) => s.confirmed_at).slice(0, 20);

  const confirm = async () => {
    if (!target) return;
    const codes = methodsToCount(target.declared_methods);
    const r = readAmounts(inputs, codes);
    if (r.ok === false) { setMsg(`Enter the counted amount for: ${r.missing.map((m) => methodName(m)).join(', ')}.`); return; }
    setBusy(true); setMsg('');
    try {
      await api.post(`/api/shifts/${target.id}/confirm`, { confirmed_methods: r.map });
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
            <div key={s.id} className="flex items-center justify-between text-sm text-amber-900 dark:text-amber-100">
              <span>{s.cashier_name} · {s.terminal_code ?? 'Web'} · closed {when(s.closed_at)}</span>
              <button onClick={() => { setTarget(s); setInputs({}); setMsg(''); }} data-testid={`confirm-${s.id}`}
                className="px-3 py-1 rounded bg-gray-900 dark:bg-white text-white dark:text-gray-900 text-xs font-medium">Confirm</button>
            </div>
          ))}
        </div>
      )}

      {confirmed.length > 0 && (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-gray-500">
              <th className="py-1">Cashier</th><th>Closed</th><th>Confirmed by</th><th>Cash counted / expected</th><th>Differs from cashier</th>
            </tr>
          </thead>
          <tbody>
            {confirmed.map((s) => {
              const diff = mismatches(s);
              return (
                <tr key={s.id} className="border-t border-gray-100 dark:border-gray-800 text-gray-800 dark:text-gray-200">
                  <td className="py-1">{s.cashier_name}</td>
                  <td>{when(s.closed_at)}</td>
                  <td>{s.confirmer_name ?? '—'}{s.confirm_self ? <span className="ml-1 text-xs text-amber-600" data-testid="self-confirmed">(self-confirmed)</span> : null}</td>
                  <td>{money(s.confirmed_methods?.cash)} / {money(s.expected_methods?.cash)}</td>
                  <td className={diff.length ? 'text-red-600 dark:text-red-400 font-medium' : 'text-gray-400'}>
                    {diff.length ? diff.map((m) => `${methodName(m)}: ${money(s.declared_methods?.[m])} → ${money(s.confirmed_methods?.[m])}`).join('; ') : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {target && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
          <div className="bg-white dark:bg-gray-900 rounded-xl w-full max-w-md border border-gray-200 dark:border-gray-700 p-5 space-y-3">
            <h3 className="text-base font-semibold text-gray-900 dark:text-white">Confirm {target.cashier_name}'s shift</h3>
            <p className="text-xs text-gray-500">
              Count every payment method yourself — the drawer, the M-Pesa statement, the card machine's total — and enter
              what you find. The cashier's figures are shown after you save. {confirmationLabel({ status: 'awaiting' })}.
            </p>
            {methodsToCount(target.declared_methods).map((m) => (
              <div key={m}>
                <label className="block text-sm text-gray-700 dark:text-gray-300 mb-1">{methodName(m)} counted</label>
                <input type="number" min={0} step="0.01" inputMode="decimal" value={inputs[m] ?? ''} data-testid={`confirm-input-${m}`}
                  onChange={(e) => setInputs({ ...inputs, [m]: e.target.value })}
                  className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-950 px-3 py-2 text-sm text-gray-900 dark:text-white" />
              </div>
            ))}
            {msg && <p className="text-sm text-red-600 dark:text-red-400">{msg}</p>}
            <div className="flex gap-2 justify-end">
              <button onClick={() => setTarget(null)} disabled={busy} className="px-3 py-2 text-sm text-gray-600 dark:text-gray-400">Cancel</button>
              <button onClick={confirm} disabled={busy}
                className="px-4 py-2 text-sm rounded-lg bg-gray-900 dark:bg-white text-white dark:text-gray-900 font-medium">
                {busy ? 'Confirming…' : 'Confirm shift'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
