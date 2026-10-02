import { useEffect, useState } from 'react';
import { posApi } from '../lib/posApi';
import {
  defaultReversalRules, windowLabel, MIN_VOID_WINDOW_MINUTES, MAX_VOID_WINDOW_MINUTES, type ReversalRules,
} from '../../shared/reversalRules';

// 0.6.30 (A336 stage 3) — Manager → Settings → Voids & refunds: the owner's rules (shared/reversalRules.ts).
// Owner, 2026-10-01: "we will let the owner decide the refund method in the managers setting which methods are allow".
// Everyone on the manager screen sees them; only the owner changes them (the cloud refuses anyone else). The same three
// are on the web (Settings › Business › Voids & refunds). 0.6.33: and the owner's free-delivery switch.
const BUILT_IN = [
  { code: 'cash', name: 'Cash' },
  { code: 'mpesa', name: 'M-Pesa' },
  { code: 'card', name: 'Card' },
  { code: 'credit', name: 'Credit (customer account)' },
];

export default function ReversalRulesPanel({ isOwner }: { isOwner: boolean }) {
  const [rules, setRules] = useState<ReversalRules>(defaultReversalRules());
  const [methods, setMethods] = useState(BUILT_IN);
  const [windowText, setWindowText] = useState(String(defaultReversalRules().voidWindowMinutes));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    posApi.pos.reversalRules().then((r) => { setRules(r); setWindowText(String(r.voidWindowMinutes)); }).catch(() => {});
    posApi.pos.paymentMethods().then((list) => {
      const extra = (list ?? []).filter((m) => m?.code && !BUILT_IN.some((b) => b.code === m.code))
        .map((m) => ({ code: String(m.code).toLowerCase(), name: m.name }));
      setMethods([...BUILT_IN, ...extra]);
    }).catch(() => {});
  }, []);

  const save = async (key: string, value: unknown, next: ReversalRules) => {
    if (!isOwner) return;
    const before = rules;
    setRules(next); setBusy(true); setError(''); setSaved(false);
    try {
      await posApi.manage.setReversalRule(key, value);
      setSaved(true); setTimeout(() => setSaved(false), 1500);
    } catch (e: any) {
      setRules(before);
      if (key === 'void_window_minutes') setWindowText(String(before.voidWindowMinutes));
      setError(e?.message ?? 'Could not save — this change needs a connection.');
    } finally { setBusy(false); }
  };

  const saveWindow = () => {
    const n = Number(windowText);
    if (!Number.isInteger(n) || n < MIN_VOID_WINDOW_MINUTES || n > MAX_VOID_WINDOW_MINUTES) {
      setError(`Enter whole minutes from ${MIN_VOID_WINDOW_MINUTES} to ${MAX_VOID_WINDOW_MINUTES}.`);
      setWindowText(String(rules.voidWindowMinutes));
      return;
    }
    if (n !== rules.voidWindowMinutes) void save('void_window_minutes', n, { ...rules, voidWindowMinutes: n });
  };

  const toggleMethod = (code: string) => {
    const list = rules.offlineRefundMethods.includes(code)
      ? rules.offlineRefundMethods.filter((m) => m !== code) : [...rules.offlineRefundMethods, code];
    void save('offline_refund_methods', list, { ...rules, offlineRefundMethods: list });
  };

  const web = rules.offlineReverseWebSales;
  const free = rules.freeDeliveryAllowed;   // 0.6.33
  const locked = !isOwner || busy;

  return (
    <div className="space-y-5" data-testid="reversal-rules">
      <div>
        <h3 className="text-white text-sm font-semibold">Voids &amp; refunds</h3>
        <p className="text-xs text-gray-400 mt-1">
          Managers and the owner void and refund — never cashiers. {isOwner
            ? 'These rules are yours; they apply on every till and on the web.'
            : 'Only the owner can change these rules.'}
        </p>
      </div>

      <div className="border border-gray-800 rounded-xl p-4">
        <p className="text-white text-sm font-medium">Void window</p>
        <p className="text-xs text-gray-400 mt-1">How long after a sale a manager may still void it; after that, refund. The owner may void at any time.</p>
        <div className="flex items-center gap-3 mt-3">
          <input
            type="number" inputMode="numeric" min={MIN_VOID_WINDOW_MINUTES} max={MAX_VOID_WINDOW_MINUTES}
            value={windowText} disabled={locked}
            onChange={(e) => setWindowText(e.target.value.replace(/\D/g, '').slice(0, 4))}
            onBlur={saveWindow}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            className="w-24 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm disabled:opacity-50"
            data-testid="till-void-window"
          />
          <span className="text-xs text-gray-400">minutes ({windowLabel(rules.voidWindowMinutes)}; default 30)</span>
        </div>
      </div>

      <div className="border border-gray-800 rounded-xl p-4">
        <p className="text-white text-sm font-medium">Refunds while the till is offline</p>
        <p className="text-xs text-gray-400 mt-1">
          A refund hands back each payment in the method it came in. Offline, a till refunds only a sale paid entirely in
          the methods ticked here; it sends the refund to the cloud when it reconnects.
        </p>
        <div className="grid gap-2 mt-3">
          {methods.map((m) => (
            <label key={m.code} className="flex items-center gap-3 text-sm text-gray-200">
              <input type="checkbox" className="w-4 h-4" disabled={locked}
                checked={rules.offlineRefundMethods.includes(m.code)} onChange={() => toggleMethod(m.code)} />
              {m.name}
            </label>
          ))}
        </div>
      </div>

      <div className="flex items-start justify-between gap-4 border border-gray-800 rounded-xl p-4">
        <div className="flex-1">
          <p className="text-white text-sm font-medium">Offline: also web sales on this till's drawer</p>
          <p className="text-xs text-gray-400 mt-1">Offline, a till voids and refunds only the sales it rang itself. On: also the web POS sales on its drawer.</p>
        </div>
        <button
          onClick={() => void save('offline_reverse_web_sales', !web, { ...rules, offlineReverseWebSales: !web })}
          disabled={locked} role="switch" aria-checked={web}
          className={`shrink-0 w-12 h-7 rounded-full transition-colors relative disabled:opacity-40 ${web ? 'bg-action-500' : 'bg-gray-700'}`}
        >
          <span className={`absolute top-1 w-5 h-5 rounded-full bg-white transition-all ${web ? 'left-6' : 'left-1'}`} />
        </button>
      </div>

      {/* 0.6.33: free delivery (owner, 2026-10-02) — with the client's delivery-fee switch, the cashier may leave the fee
          empty. The rider's name is still required. */}
      <div className="flex items-start justify-between gap-4 border border-gray-800 rounded-xl p-4" data-testid="free-delivery-rule">
        <div className="flex-1">
          <p className="text-white text-sm font-medium">Allow free delivery</p>
          <p className="text-xs text-gray-400 mt-1">On: a delivery may go with no fee — the cashier leaves the fee empty. The rider's name is still needed. Off: every delivery needs its fee.</p>
        </div>
        <button
          onClick={() => void save('delivery_free_allowed', !free, { ...rules, freeDeliveryAllowed: !free })}
          disabled={locked} role="switch" aria-checked={free} data-testid="till-free-delivery"
          className={`shrink-0 w-12 h-7 rounded-full transition-colors relative disabled:opacity-40 ${free ? 'bg-action-500' : 'bg-gray-700'}`}
        >
          <span className={`absolute top-1 w-5 h-5 rounded-full bg-white transition-all ${free ? 'left-6' : 'left-1'}`} />
        </button>
      </div>

      <div className="h-4">
        {error && <span className="text-xs text-red-400">{error}</span>}
        {saved && !error && <span className="text-xs text-gray-300">Saved</span>}
      </div>
    </div>
  );
}
