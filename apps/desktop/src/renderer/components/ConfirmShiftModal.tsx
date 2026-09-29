/**
 * ConfirmShiftModal — A365: a manager confirms a closed shift with a BLIND recount of every payment method, approved
 * with their own PIN. Neither the cashier's figures nor the expected ones are shown until it is saved — a counter who
 * can see the target closes a shortage to zero without deciding to (the same rule as the day close).
 */
import { useEffect, useState } from 'react';
import { posApi, type Confirmation } from '../lib/posApi';
import { methodName, readAmounts, confirmationLabel, type MethodOption } from '../../shared/shiftConfirm';
import MethodDot from './MethodDot';

interface Props {
  shiftId: string;
  cashierName: string;
  /** Codes to recount — the shift's declared methods (cash first). */
  methods: string[];
  currency: string;
  onDone: (c: Confirmation) => void;
  onClose: () => void;
}

export default function ConfirmShiftModal({ shiftId, cashierName, methods, currency, onDone, onClose }: Props) {
  const [options, setOptions] = useState<MethodOption[]>([]);
  const [pin, setPin] = useState('');
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<Confirmation | null>(null);
  // 0.6.23: a manager already signed in confirms as themselves — no PIN (owner: "do they need to key in their password?").
  const [signedInManager, setSignedInManager] = useState(false);
  const codes = [...new Set(['cash', ...methods.map((m) => m.toLowerCase())])];

  useEffect(() => {
    posApi.pos.paymentMethods().then(setOptions).catch(() => {});
    posApi.shift.canConfirm().then((v) => setSignedInManager(v === true)).catch(() => setSignedInManager(false));
  }, []);

  const money = (n: number) => `${currency} ${n.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const submit = async () => {
    const r = readAmounts(inputs, codes);
    if (r.ok === false) { setError(`Enter the counted amount for: ${r.missing.map((m) => methodName(m, options)).join(', ')}.`); return; }
    if (!signedInManager && !pin.trim()) { setError('Enter your manager PIN.'); return; }
    setBusy(true); setError('');
    try {
      const c = await posApi.shift.confirm(shiftId, signedInManager ? undefined : pin.trim(), r.map);
      setResult(c); setPin('');
    } catch (e: any) { setError(e?.message ?? 'Could not confirm the shift.'); }
    finally { setBusy(false); }
  };

  const inputCls = 'w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white placeholder-gray-400 focus:outline-none focus:border-action-500';

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center px-4 z-[60]" data-testid="confirm-shift">
      <div className="bg-gray-900 border border-gray-800 rounded-2xl w-full max-w-md max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800">
          <h2 className="text-white font-bold">{result ? 'Shift confirmed' : `Confirm ${cashierName}'s shift`}</h2>
          <button onClick={() => (result ? onDone(result) : onClose())} className="text-gray-300 hover:text-white">✕</button>
        </div>
        <div className="p-6 space-y-4 overflow-y-auto">
          {error && <p className="text-red-400 text-sm bg-red-400/10 border border-red-400/20 rounded-lg px-3 py-2">{error}</p>}

          {!result && (
            <>
              <p className="text-xs text-gray-400">
                Manager: count every payment method yourself — the drawer, the M-Pesa statement, the card machine's total —
                and enter what you find. The cashier's figures are shown after you save.
              </p>
              {codes.map((c) => (
                <div key={c}>
                  <label className="block text-xs text-gray-300 mb-1"><MethodDot method={c} />{methodName(c, options)} counted ({currency})</label>
                  <input type="number" inputMode="decimal" value={inputs[c] ?? ''} placeholder="0.00" className={inputCls}
                    data-testid={`confirm-${c}`}
                    onChange={(e) => setInputs({ ...inputs, [c]: e.target.value })} />
                </div>
              ))}
              {!signedInManager && (
                <div data-testid="confirm-pin">
                  <label className="block text-xs text-gray-300 mb-1">Manager PIN</label>
                  <input type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value)} className={inputCls} />
                </div>
              )}
              <button onClick={() => void submit()} disabled={busy}
                className="w-full bg-action-500 hover:bg-action-400 disabled:opacity-40 text-gray-950 font-bold rounded-xl py-2.5 text-sm">
                {busy ? 'Confirming…' : 'Confirm shift'}
              </button>
            </>
          )}

          {result && (
            <>
              <p className={`text-sm ${result.self ? 'text-amber-300' : 'text-gray-200'}`}>
                {confirmationLabel({ status: 'confirmed', confirmed_by_name: result.confirmed_by_name, confirmed_at: result.confirmed_at, self: result.self })}
              </p>
              <table className="w-full text-xs text-gray-300">
                <thead><tr className="text-gray-500"><th className="text-left">Method</th><th className="text-right">Cashier</th><th className="text-right">Counted</th><th className="text-right">Expected</th></tr></thead>
                <tbody>
                  {result.lines.map((l) => (
                    <tr key={l.method} className={l.mismatch ? 'text-amber-300' : ''} data-testid={`confirm-line-${l.method}`}>
                      <td><MethodDot method={l.method} />{methodName(l.method, options)}</td>
                      <td className="text-right">{money(l.declared ?? 0)}</td>
                      <td className="text-right">{money(l.confirmed ?? 0)}</td>
                      <td className="text-right">{money(l.expected ?? 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {result.lines.some((l) => l.mismatch) && (
                <p className="text-xs text-amber-300">Your count differs from the cashier's on the highlighted method(s).</p>
              )}
              {result.lines.filter((l) => Math.round((l.variance ?? 0) * 100) !== 0).map((l) => (
                <p key={l.method} className="text-xs text-red-300">
                  {methodName(l.method, options)}: {(l.variance ?? 0) > 0 ? 'over' : 'short'} {money(Math.abs(l.variance ?? 0))}
                </p>
              ))}
              <button onClick={() => onDone(result)} className="w-full bg-action-500 hover:bg-action-400 text-gray-950 font-bold rounded-xl py-2.5 text-sm">Done</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
