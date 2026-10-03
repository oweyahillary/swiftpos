import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { cleanHistoryMethods } from '../../lib/cashierHistory';

// 0.6.37 (A387) — the payment methods a cashier's History shows (shared/cashierHistory.ts). Owner, 2026-10-03: "the
// manager selects what the cashier sees" — "based on payment method". Every box ticked = every method (saved as [], so
// a method added later shows too); at least one stays ticked. Used for the business (Settings › Business) and a branch's
// own (Branches › overrides).
const BUILT_IN = [
  { code: 'cash', name: 'Cash' },
  { code: 'mpesa', name: 'M-Pesa' },
  { code: 'card', name: 'Card' },
  { code: 'credit', name: 'Credit (customer account)' },
];

export default function HistoryMethodsPicker({ value, onChange, disabled = false }: {
  /** The stored setting (JSON text of a list; empty / '[]' = every method). */
  value: string | undefined;
  onChange: (methods: string[]) => void;
  disabled?: boolean;
}) {
  const [methods, setMethods] = useState(BUILT_IN);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    api.get<Array<{ code?: string; name: string }>>('/api/payment-methods').then((list) => {
      if (!live) return;
      const extra = (list ?? []).filter((m) => m?.code && !BUILT_IN.some((b) => b.code === String(m.code).toLowerCase()))
        .map((m) => ({ code: String(m.code).toLowerCase(), name: m.name }));
      setMethods([...BUILT_IN, ...extra]);
    }).catch(() => {});
    return () => { live = false; };
  }, []);

  const allowed = cleanHistoryMethods(value ?? null) ?? [];
  const shown = (code: string) => !allowed.length || allowed.includes(code);

  const toggle = (code: string) => {
    const ticked = methods.map((m) => m.code).filter(shown);
    const next = ticked.includes(code) ? ticked.filter((c) => c !== code) : [...ticked, code];
    if (!next.length) { setError('Leave at least one method ticked.'); return; }
    setError('');
    onChange(methods.every((m) => next.includes(m.code)) ? [] : next);
  };

  return (
    <div data-testid="history-methods-picker">
      <div className="grid sm:grid-cols-2 gap-2">
        {methods.map((m) => (
          <label key={m.code} className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
            <input type="checkbox" checked={shown(m.code)} disabled={disabled} onChange={() => toggle(m.code)} />
            {m.name}
          </label>
        ))}
      </div>
      <p className="text-xs mt-1.5 text-gray-500">
        {error ? <span className="text-red-400">{error}</span> : !allowed.length ? 'Every method is shown.' : `Shown: ${allowed.join(', ')}.`}
      </p>
    </div>
  );
}
