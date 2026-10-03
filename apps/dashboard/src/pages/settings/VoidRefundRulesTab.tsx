import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import {
  parseReversalRules, defaultReversalRules, windowLabel, type ReversalRules,
  MIN_VOID_WINDOW_MINUTES, MAX_VOID_WINDOW_MINUTES, MAX_FREE_DELIVERY_OVER,
} from '../../lib/reversalRules';

// Settings › Business › Voids & refunds — 0.6.30 (A336 stage 3). The owner's rules (lib/reversalRules.ts):
//   • the void window — how long after a sale a manager may still void it (default 30 minutes; the owner always may);
//   • which payment methods a till may refund while it cannot reach the cloud (default cash);
//   • whether, offline, a till may also reverse the web sales on its drawer (default: its own sales only).
//   • 0.6.33: whether the cashier may mark a delivery FREE (the shop pays the rider; the customer pays no fee).
// The same are on the till (Manager → Settings, signed in as the owner). Only the owner can change them — the
// cloud refuses anyone else (routes/business.ts).

interface PaymentMethod { code: string; name: string; is_active?: boolean }

const BUILT_IN: Array<{ code: string; name: string }> = [
  { code: 'cash', name: 'Cash' },
  { code: 'mpesa', name: 'M-Pesa' },
  { code: 'card', name: 'Card' },
  { code: 'credit', name: 'Credit (customer account)' },
];

export default function VoidRefundRulesTab() {
  const [rules, setRules]     = useState<ReversalRules>(defaultReversalRules());
  const [methods, setMethods] = useState(BUILT_IN);
  const [windowText, setWindowText] = useState(String(defaultReversalRules().voidWindowMinutes));
  const [overText, setOverText] = useState('');   // 0.6.33: free delivery from this bill amount
  const [loading, setLoading] = useState(true);
  const [toast, setToast]     = useState('');

  function showToast(msg: string) { setToast(msg); setTimeout(() => setToast(''), 3500); }

  useEffect(() => {
    let live = true;
    Promise.all([
      api.get<Array<{ key: string; value: unknown }>>('/api/business/settings'),
      api.get<PaymentMethod[]>('/api/payment-methods').catch(() => [] as PaymentMethod[]),
    ]).then(([kv, custom]) => {
      if (!live) return;
      const r = parseReversalRules(kv ?? []);
      setRules(r);
      setWindowText(String(r.voidWindowMinutes));
      setOverText(r.freeDeliveryOver ? String(r.freeDeliveryOver) : '');
      const extra = (custom ?? [])
        .filter((m) => m?.code && m.is_active !== false && !BUILT_IN.some((b) => b.code === m.code))
        .map((m) => ({ code: String(m.code).toLowerCase(), name: m.name }));
      setMethods([...BUILT_IN, ...extra]);
    }).catch(() => { if (live) showToast('Could not load the void and refund rules'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, []);

  async function save(key: string, value: unknown, next: ReversalRules) {
    const before = rules;
    setRules(next);
    try {
      await api.post('/api/business/settings', { key, value });
      showToast('Saved');
    } catch (e) {
      setRules(before);
      showToast(e instanceof Error ? e.message : 'Could not save');
    }
  }

  function saveWindow() {
    const n = Number(windowText);
    if (!Number.isInteger(n) || n < MIN_VOID_WINDOW_MINUTES || n > MAX_VOID_WINDOW_MINUTES) {
      showToast(`Enter whole minutes from ${MIN_VOID_WINDOW_MINUTES} to ${MAX_VOID_WINDOW_MINUTES}`);
      setWindowText(String(rules.voidWindowMinutes));
      return;
    }
    if (n === rules.voidWindowMinutes) return;
    void save('void_window_minutes', n, { ...rules, voidWindowMinutes: n });
  }

  function toggleMethod(code: string) {
    const on = rules.offlineRefundMethods.includes(code);
    const list = on ? rules.offlineRefundMethods.filter((m) => m !== code) : [...rules.offlineRefundMethods, code];
    void save('offline_refund_methods', list, { ...rules, offlineRefundMethods: list });
  }

  if (loading) return <div className="p-6 text-gray-500 text-sm">Loading…</div>;

  const web = rules.offlineReverseWebSales;
  const free = rules.freeDeliveryAllowed;   // 0.6.33
  function saveOver() {   // 0.6.33: empty = off
    const t = overText.trim();
    const n = t === '' ? 0 : Number(t);
    if (!Number.isFinite(n) || n < 0 || n > MAX_FREE_DELIVERY_OVER) {
      showToast(`Enter an amount up to ${MAX_FREE_DELIVERY_OVER.toLocaleString()}, or leave it empty`);
      setOverText(rules.freeDeliveryOver ? String(rules.freeDeliveryOver) : '');
      return;
    }
    if ((n || null) === rules.freeDeliveryOver) return;
    void save('delivery_free_over', n, { ...rules, freeDeliveryOver: n || null });
  }

  return (
    <div className="p-6 max-w-2xl space-y-8" data-testid="void-refund-rules">
      {toast && (
        <div className="fixed bottom-6 right-6 bg-gray-800 border border-gray-700 text-white px-5 py-2.5 rounded-lg font-semibold z-50 shadow-lg">{toast}</div>
      )}

      <p className="text-sm text-gray-400">
        Voids and refunds are done by managers and by you — never by cashiers. These rules are yours: only the owner
        can change them, here or on a till (Manager → Settings).
      </p>

      {/* ── Void window ── */}
      <section>
        <h3 className="text-white font-semibold">Void window</h3>
        <p className="text-gray-500 text-sm mt-0.5 mb-4">
          How long after a sale a manager may still void it. After that it can only be refunded. You can void at any time.
        </p>
        <div className="flex items-center gap-3">
          <input
            type="number" inputMode="numeric" min={MIN_VOID_WINDOW_MINUTES} max={MAX_VOID_WINDOW_MINUTES}
            value={windowText}
            onChange={(e) => setWindowText(e.target.value.replace(/\D/g, '').slice(0, 4))}
            onBlur={saveWindow}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            className="w-28 bg-gray-950 border border-gray-800 rounded-lg px-3.5 py-2.5 text-white text-sm focus:outline-none focus:border-swift"
            data-testid="void-window-minutes"
          />
          <span className="text-sm text-gray-400">minutes ({windowLabel(rules.voidWindowMinutes)} now; default 30)</span>
        </div>
      </section>

      <div className="border-t border-gray-800" />

      {/* ── Offline refunds ── */}
      <section>
        <h3 className="text-white font-semibold">Refunds while a till is offline</h3>
        <p className="text-gray-500 text-sm mt-0.5 mb-4">
          A refund hands back each payment in the method it came in. When a till cannot reach the internet it can only
          refund a sale paid entirely in the methods you tick — the rest wait until it is back online. The refund is sent
          to the cloud, with the approving manager, as soon as the till reconnects.
        </p>
        <div className="grid gap-2">
          {methods.map((m) => {
            const on = rules.offlineRefundMethods.includes(m.code);
            return (
              <label key={m.code} className="flex items-center gap-3 text-sm text-gray-200 cursor-pointer">
                <input type="checkbox" checked={on} onChange={() => toggleMethod(m.code)} className="w-4 h-4"
                  data-testid={`offline-method-${m.code}`} />
                {m.name}
              </label>
            );
          })}
        </div>
        {rules.offlineRefundMethods.length === 0 && (
          <p className="text-xs text-amber-400 mt-2">Nothing ticked — a till cannot refund anything while it is offline.</p>
        )}
      </section>

      <div className="border-t border-gray-800" />

      {/* ── Offline scope ── */}
      <section>
        <div className="flex items-center justify-between gap-4">
          <div>
            <h3 className="text-white font-semibold">Offline: also web sales on the till's drawer</h3>
            <p className="text-gray-500 text-sm mt-0.5">
              Offline, a till voids and refunds only the sales it rang itself. Turn this on to let it also reverse the web
              POS sales it holds on its drawer.
            </p>
          </div>
          <button
            onClick={() => void save('offline_reverse_web_sales', !web, { ...rules, offlineReverseWebSales: !web })}
            className={`w-11 h-6 rounded-full transition-colors relative flex-shrink-0 ${web ? 'bg-swift-strong' : 'bg-gray-700'}`}
            aria-pressed={web}
            data-testid="offline-web-sales"
          >
            <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all ${web ? 'left-5' : 'left-0.5'}`} />
          </button>
        </div>
      </section>

      <div className="border-t border-gray-800" />

      {/* ── 0.6.33: free delivery (owner, 2026-10-02) ── */}
      <section>
        <div className="flex items-center justify-between gap-4">
          <div>
            <h3 className="text-white font-semibold">Allow free delivery</h3>
            <p className="text-gray-500 text-sm mt-0.5">
              When your deliveries carry a fee, turn this on to let the cashier tick <b>Free delivery</b> — on the tills and
              the web POS. The cashier still enters the fee and the rider is still paid it from the drawer; the customer
              pays none of it (the shop does). Off: the customer always pays the fee.
            </p>
          </div>
          <button
            onClick={() => void save('delivery_free_allowed', !free, { ...rules, freeDeliveryAllowed: !free })}
            className={`w-11 h-6 rounded-full transition-colors relative flex-shrink-0 ${free ? 'bg-swift-strong' : 'bg-gray-700'}`}
            aria-pressed={free}
            data-testid="free-delivery"
          >
            <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all ${free ? 'left-5' : 'left-0.5'}`} />
          </button>
        </div>
        {/* 0.6.33: automatic free delivery from a bill amount. */}
        <div className="mt-5">
          <h3 className="text-white font-semibold">Free delivery from a bill of</h3>
          <p className="text-gray-500 text-sm mt-0.5 mb-3">
            A delivery whose bill reaches this amount is free automatically — the customer pays no fee and the rider is
            still paid it from the drawer. Leave empty for none.
          </p>
          <input
            type="number" inputMode="decimal" min={0} value={overText} placeholder="None"
            onChange={(e) => setOverText(e.target.value)}
            onBlur={saveOver}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            className="w-40 bg-gray-950 border border-gray-800 rounded-lg px-3.5 py-2.5 text-white text-sm focus:outline-none focus:border-swift"
            data-testid="free-delivery-over"
          />
        </div>
      </section>
    </div>
  );
}
