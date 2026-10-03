import { useEffect, useState } from 'react';
import { posApi } from '../lib/posApi';

// 0.6.37 (A387) — Manager → Settings → What cashiers see in History (shared/cashierHistory.ts).
// Owner, 2026-10-03: "the manager selects what the cashier sees" — "based on payment method" — "They can only see
// allowed method eg mpesa, cash, card but never reprints a receipt". Every box ticked = every method (stored as [], so a
// method added later shows too). A split sale shows a cashier only its ticked part. The same choice is on the web
// (Settings › Business), and a branch may have its own (Branches › overrides).
const BUILT_IN = [
  { code: 'cash', name: 'Cash' },
  { code: 'mpesa', name: 'M-Pesa' },
  { code: 'card', name: 'Card' },
  { code: 'credit', name: 'Credit (customer account)' },
];

export default function CashierHistoryPanel({ canEdit }: { canEdit: boolean }) {
  const [methods, setMethods] = useState(BUILT_IN);
  const [allowed, setAllowed] = useState<string[]>([]);   // [] = every method
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    posApi.manage.getCashierHistoryMethods().then((r) => setAllowed(r?.methods ?? [])).catch(() => {});
    posApi.pos.paymentMethods().then((list) => {
      const extra = (list ?? []).filter((m) => m?.code && !BUILT_IN.some((b) => b.code === String(m.code).toLowerCase()))
        .map((m) => ({ code: String(m.code).toLowerCase(), name: m.name }));
      setMethods([...BUILT_IN, ...extra]);
    }).catch(() => {});
  }, []);

  const shown = (code: string) => !allowed.length || allowed.includes(code);

  const toggle = async (code: string) => {
    if (!canEdit || busy) return;
    const ticked = methods.map((m) => m.code).filter(shown);
    const nextTicked = ticked.includes(code) ? ticked.filter((c) => c !== code) : [...ticked, code];
    if (!nextTicked.length) { setError('Leave at least one method ticked.'); return; }
    const next = methods.every((m) => nextTicked.includes(m.code)) ? [] : nextTicked;
    const before = allowed;
    setAllowed(next); setBusy(true); setError(''); setSaved(false);
    try {
      await posApi.manage.setCashierHistoryMethods(next);
      setSaved(true); setTimeout(() => setSaved(false), 1500);
    } catch (e: any) {
      setAllowed(before);
      setError(e?.message ?? 'Could not save — this change needs a connection.');
    } finally { setBusy(false); }
  };

  return (
    <div className="space-y-3" data-testid="cashier-history-methods">
      <div>
        <h3 className="text-white text-sm font-semibold">What cashiers see in History</h3>
        <p className="text-xs text-gray-400 mt-1">
          A cashier's History shows only sales paid by the methods ticked here; a split sale shows only its ticked part.
          Cashiers never reprint a receipt. Managers and the owner always see every sale.
        </p>
      </div>
      <div className="border border-gray-800 rounded-xl p-4 grid gap-2">
        {methods.map((m) => (
          <label key={m.code} className="flex items-center gap-3 text-sm text-gray-200">
            <input type="checkbox" className="w-4 h-4" disabled={!canEdit || busy}
              checked={shown(m.code)} onChange={() => void toggle(m.code)} />
            {m.name}
          </label>
        ))}
      </div>
      <div className="h-4">
        {error && <span className="text-xs text-red-400">{error}</span>}
        {saved && !error && <span className="text-xs text-gray-300">Saved</span>}
        {!error && !saved && !allowed.length && <span className="text-xs text-gray-500">Every method is shown.</span>}
      </div>
    </div>
  );
}
