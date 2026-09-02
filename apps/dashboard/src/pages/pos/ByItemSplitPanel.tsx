/**
 * ByItemSplitPanel — split ONE bill by assigning each line to a guest, then
 * collect one payment per guest, all summing to the FULL order total (A151,
 * Option A). Feeds the same proven path as EvenSplitPanel — PaymentModal's
 * handleSplitCharge → POST /pay with N legs — so it's one order, paid in full,
 * no sub-orders.
 *
 * Allocation: a guest's raw share is the sum of their assigned line totals. If
 * the raw shares don't already sum to the order total (VAT/discount/tip make
 * line totals differ from what is charged), every share is scaled
 * proportionally so the legs reconcile to the total exactly — the server rejects
 * any set that doesn't (|legSum − total| > 0.01 → 400), so a mis-allocation
 * fails safe (the sale errors) rather than under-collecting.
 */

import { useState } from 'react';
import type { PaymentLeg, PaymentMethod } from './SplitPaymentPanel';

const round2 = (x: number) => Math.round(x * 100) / 100;
const uid = () => Math.random().toString(36).slice(2, 8);
const fmt = (a: number, c: string) =>
  `${c} ${a.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const METHODS: { id: PaymentMethod; label: string; icon: string }[] = [
  { id: 'cash',  label: 'Cash',   icon: '💵' },
  { id: 'mpesa', label: 'M-Pesa', icon: '📱' },
  { id: 'card',  label: 'Card',   icon: '💳' },
];

export interface SplitLineItem {
  name: string;
  qty: number;
  amount: number;   // line total (unitPrice * qty + modifiers)
}

interface Props {
  items: SplitLineItem[];
  total: number;
  currency: string;
  onConfirm: (legs: PaymentLeg[]) => void;
  onCancel?: () => void;
  mpesaEnabled?: boolean;
  maxGuests?: number;
}

export default function ByItemSplitPanel({
  items, total, currency, onConfirm, onCancel, mpesaEnabled = true, maxGuests = 6,
}: Props) {
  const [guests, setGuests] = useState(2);
  // assign[i] = guest index (0-based) the item is on. Default everything to guest 1.
  const [assign, setAssign] = useState<number[]>(() => items.map(() => 0));
  const [meta, setMeta] = useState<{ method: PaymentMethod; reference: string }[]>(
    () => Array.from({ length: 2 }, () => ({ method: 'cash', reference: '' })),
  );

  const methods = METHODS.filter(m => m.id !== 'mpesa' || mpesaEnabled);

  function setGuestCount(next: number) {
    const n = Math.max(2, Math.min(maxGuests, next));
    setGuests(n);
    setMeta(prev => {
      const out = prev.slice(0, n);
      while (out.length < n) out.push({ method: 'cash', reference: '' });
      return out;
    });
    // Any items assigned to a now-removed guest fall back to guest 1.
    setAssign(prev => prev.map(g => (g >= n ? 0 : g)));
  }

  // Raw per-guest sums from assigned line totals, then scaled to reconcile to the
  // order total exactly (VAT/discount/tip aware).
  const rawByGuest = Array.from({ length: guests }, (_, g) =>
    items.reduce((s, it, i) => (assign[i] === g ? s + it.amount : s), 0));
  const rawSum = round2(rawByGuest.reduce((s, r) => s + r, 0));

  const scaled = rawByGuest.map(r => (rawSum > 0 ? round2((total * r) / rawSum) : 0));
  // Push any rounding delta onto the first guest that has money, so legs === total.
  const delta = round2(total - scaled.reduce((s, a) => s + a, 0));
  const firstNonZero = scaled.findIndex(a => a > 0);
  if (firstNonZero >= 0) scaled[firstNonZero] = round2(scaled[firstNonZero] + delta);

  const nonEmpty = scaled.filter(a => a > 0).length;
  const sum = round2(scaled.reduce((s, a) => s + a, 0));
  const canConfirm = nonEmpty >= 2 && Math.abs(sum - total) < 0.01;

  function charge() {
    if (!canConfirm) return;
    const legs: PaymentLeg[] = [];
    scaled.forEach((amount, g) => {
      if (amount <= 0) return;   // skip guests with no items
      legs.push({
        id:        uid(),
        method:    meta[g]?.method ?? 'cash',
        amount,
        reference: meta[g]?.method === 'mpesa' ? (meta[g]?.reference || undefined) : undefined,
      });
    });
    onConfirm(legs);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-gray-400 text-sm">Guests</p>
        <div className="flex items-center gap-3">
          <button onClick={() => setGuestCount(guests - 1)} disabled={guests <= 2}
            className="w-8 h-8 rounded-lg bg-gray-800 text-white disabled:opacity-40">−</button>
          <span className="text-white font-semibold w-8 text-center">{guests}</span>
          <button onClick={() => setGuestCount(guests + 1)} disabled={guests >= maxGuests}
            className="w-8 h-8 rounded-lg bg-gray-800 text-white disabled:opacity-40">+</button>
        </div>
      </div>

      {/* Assign each line to a guest */}
      <div className="space-y-2 max-h-56 overflow-y-auto">
        {items.map((it, i) => (
          <div key={i} className="bg-gray-800/50 border border-gray-700 rounded-xl p-2.5">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-sm text-gray-200 truncate">{it.qty}× {it.name}</span>
              <span className="text-sm text-gray-400 flex-shrink-0 ml-2">{fmt(it.amount, currency)}</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {Array.from({ length: guests }, (_, g) => (
                <button key={g}
                  onClick={() => setAssign(prev => prev.map((x, idx) => idx === i ? g : x))}
                  className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition-colors ${
                    assign[i] === g
                      ? 'bg-green-500/10 border-green-500 text-green-400'
                      : 'bg-gray-800 border-gray-700 text-gray-500 hover:border-gray-600'
                  }`}>
                  G{g + 1}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Per-guest totals + method */}
      <div className="space-y-2">
        {scaled.map((amount, g) => (
          <div key={g} className={`rounded-xl p-3 border ${amount > 0 ? 'bg-gray-800/50 border-gray-700' : 'bg-gray-900/40 border-gray-800 opacity-50'}`}>
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm text-gray-300">Guest {g + 1}</span>
              <span className="text-sm font-semibold text-white">{fmt(amount, currency)}</span>
            </div>
            {amount > 0 && (
              <>
                <div className="grid grid-cols-3 gap-2">
                  {methods.map(m => (
                    <button key={m.id}
                      onClick={() => setMeta(prev => prev.map((x, idx) => idx === g ? { ...x, method: m.id } : x))}
                      className={`py-2 rounded-lg text-xs font-medium border transition-colors ${
                        (meta[g]?.method ?? 'cash') === m.id
                          ? 'bg-green-500/10 border-green-500 text-green-400'
                          : 'bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-600'
                      }`}>
                      {m.icon} {m.label}
                    </button>
                  ))}
                </div>
                {(meta[g]?.method ?? 'cash') === 'mpesa' && (
                  <input
                    value={meta[g]?.reference ?? ''}
                    onChange={e => setMeta(prev => prev.map((x, idx) => idx === g ? { ...x, reference: e.target.value } : x))}
                    placeholder="M-Pesa code (optional)"
                    className="mt-2 w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600"
                  />
                )}
              </>
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
        <button onClick={charge} disabled={!canConfirm}
          className="flex-[2] py-3 rounded-xl bg-green-600 text-white text-sm font-bold disabled:opacity-40">
          {canConfirm ? `Charge ${fmt(total, currency)}` : 'Assign items to ≥2 guests'}
        </button>
      </div>
    </div>
  );
}
