/**
 * EvenSplitPanel — split ONE bill evenly among N people and collect N payments
 * that sum to the full total, then pay the single order in full (A151).
 *
 * Deliberately separate from SplitPaymentPanel: that panel splits the TENDER
 * (one leg per method, max 4) for a single payer. This splits among PEOPLE, so
 * it allows repeated methods and N legs. Both feed the same proven path —
 * PaymentModal.handleSplitCharge → POST /pay with legs that must sum to total —
 * so no sub-orders are created and the server's reconcile guard still applies.
 */

import { useState } from 'react';
import type { PaymentLeg, PaymentMethod } from './SplitPaymentPanel';

const round2 = (x: number) => Math.round(x * 100) / 100;
const uid = () => Math.random().toString(36).slice(2, 8);
const fmt = (a: number, c: string) =>
  `${c} ${a.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Credit is intentionally excluded from an even split among people: a credit leg
// is tied to the one attached customer's account, which does not map to "each
// person pays their share." Cash / M-Pesa / Card only.
const METHODS: { id: PaymentMethod; label: string; icon: string }[] = [
  { id: 'cash',  label: 'Cash',   icon: '💵' },
  { id: 'mpesa', label: 'M-Pesa', icon: '📱' },
  { id: 'card',  label: 'Card',   icon: '💳' },
];

interface Props {
  total: number;
  currency: string;
  onConfirm: (legs: PaymentLeg[]) => void;
  onCancel?: () => void;
  /** Hide M-Pesa when Daraja isn't configured. */
  mpesaEnabled?: boolean;
  maxWays?: number;
}

export default function EvenSplitPanel({
  total, currency, onConfirm, onCancel, mpesaEnabled = true, maxWays = 12,
}: Props) {
  const [n, setN] = useState(2);
  const [meta, setMeta] = useState<{ method: PaymentMethod; reference: string }[]>(
    () => Array.from({ length: 2 }, () => ({ method: 'cash', reference: '' })),
  );

  const methods = METHODS.filter(m => m.id !== 'mpesa' || mpesaEnabled);

  function setWays(next: number) {
    const clamped = Math.max(2, Math.min(maxWays, next));
    setN(clamped);
    setMeta(prev => {
      const out = prev.slice(0, clamped);
      while (out.length < clamped) out.push({ method: 'cash', reference: '' });
      return out;
    });
  }

  // Equal shares to 2dp; any rounding remainder lands on person 1 so the legs
  // sum to the total exactly (the server rejects a set that doesn't reconcile).
  const share     = Math.floor((total / n) * 100) / 100;
  const remainder = round2(total - share * n);
  const amounts   = Array.from({ length: n }, (_, i) => (i === 0 ? round2(share + remainder) : share));

  const sum       = round2(amounts.reduce((s, a) => s + a, 0));
  const canCharge = Math.abs(sum - total) < 0.01 && amounts.every(a => a > 0);

  function charge() {
    if (!canCharge) return;
    const legs: PaymentLeg[] = amounts.map((amount, i) => ({
      id:        uid(),
      method:    meta[i]?.method ?? 'cash',
      amount,
      reference: meta[i]?.method === 'mpesa' ? (meta[i]?.reference || undefined) : undefined,
    }));
    onConfirm(legs);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-gray-400 text-sm">Split evenly between</p>
        <div className="flex items-center gap-3">
          <button onClick={() => setWays(n - 1)} disabled={n <= 2}
            className="w-8 h-8 rounded-lg bg-gray-800 text-white disabled:opacity-40">−</button>
          <span className="text-white font-semibold w-8 text-center">{n}</span>
          <button onClick={() => setWays(n + 1)} disabled={n >= maxWays}
            className="w-8 h-8 rounded-lg bg-gray-800 text-white disabled:opacity-40">+</button>
        </div>
      </div>

      <p className="text-xs text-gray-500">
        {fmt(share, currency)} each
        {remainder > 0 ? ` · person 1 pays ${fmt(round2(share + remainder), currency)} (rounding)` : ''}
      </p>

      <div className="space-y-2">
        {amounts.map((amount, i) => (
          <div key={i} className="bg-gray-800/50 border border-gray-700 rounded-xl p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm text-gray-300">Person {i + 1}</span>
              <span className="text-sm font-semibold text-white">{fmt(amount, currency)}</span>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {methods.map(m => (
                <button key={m.id}
                  onClick={() => setMeta(prev => prev.map((x, idx) => idx === i ? { ...x, method: m.id } : x))}
                  className={`py-2 rounded-lg text-xs font-medium border transition-colors ${
                    (meta[i]?.method ?? 'cash') === m.id
                      ? 'bg-green-500/10 border-green-500 text-green-400'
                      : 'bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-600'
                  }`}>
                  {m.icon} {m.label}
                </button>
              ))}
            </div>
            {(meta[i]?.method ?? 'cash') === 'mpesa' && (
              <input
                value={meta[i]?.reference ?? ''}
                onChange={e => setMeta(prev => prev.map((x, idx) => idx === i ? { ...x, reference: e.target.value } : x))}
                placeholder="M-Pesa code (optional)"
                className="mt-2 w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600"
              />
            )}
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between pt-1">
        <span className="text-sm text-gray-400">Total</span>
        <span className="text-sm font-semibold text-white">{fmt(total, currency)}</span>
      </div>

      <div className="flex gap-2">
        {onCancel && (
          <button onClick={onCancel}
            className="flex-1 py-3 rounded-xl bg-gray-800 text-gray-300 text-sm font-medium">
            Cancel
          </button>
        )}
        <button onClick={charge} disabled={!canCharge}
          className="flex-[2] py-3 rounded-xl bg-green-600 text-white text-sm font-bold disabled:opacity-40">
          Charge {fmt(total, currency)} · {n} ways
        </button>
      </div>
    </div>
  );
}
