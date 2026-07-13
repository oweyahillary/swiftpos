import { useMemo, useState } from 'react';
import { computeTotals, buildLegView, round2, EPSILON } from '../lib/payment';
import type { DraftLeg, LegMethod } from '../lib/payment';

// Payment modal — split tender + discount + tip.
//
// The main process (createLocalOrder) and the server (POST /api/orders) both
// already accept a `payments[]` array, discount_amount and tip_amount — this
// modal is the renderer finally catching up with that contract.
//
// All money maths lives in ../lib/payment.ts (pure, dryrun-testable).

export type { LegMethod };

export interface PaymentLeg {
  method: LegMethod;
  amount: number;
  amount_tendered: number;
  change_given: number;
  reference: string | null;
}

export interface PaymentResult {
  discountAmount: number;
  tipAmount: number;
  total: number;
  vatAmount: number;
  legs: PaymentLeg[];
}

interface Props {
  subtotal: number;       // VAT-inclusive cart subtotal
  vatRate: number;        // e.g. 16
  currency: string;
  placing: boolean;
  error: string;
  onConfirm: (result: PaymentResult) => void;
  onClose: () => void;
}

const METHOD_META: Record<LegMethod, { label: string; icon: string }> = {
  cash:  { label: 'Cash',   icon: '💵' },
  mpesa: { label: 'M-Pesa', icon: '📱' },
  card:  { label: 'Card',   icon: '💳' },
};

export default function PaymentModal({ subtotal, vatRate, currency, placing, error, onConfirm, onClose }: Props) {
  // ── Adjustments ─────────────────────────────────────────
  const [discountInput, setDiscountInput] = useState('');
  const [discountMode, setDiscountMode] = useState<'amount' | 'percent'>('amount');
  const [tipInput, setTipInput] = useState('');
  const [showAdjustments, setShowAdjustments] = useState(false);
  const [localError, setLocalError] = useState('');

  const discountRaw = parseFloat(discountInput) || 0;
  const { discountAmount, tipAmount, vatAmount, total } = useMemo(
    () => computeTotals(subtotal, { discountRaw, discountMode, tipRaw: parseFloat(tipInput) || 0, vatRate }),
    [subtotal, discountRaw, discountMode, tipInput, vatRate]
  );

  // ── Payment legs ────────────────────────────────────────
  // Single leg by default; "Split payment" adds more. A blank amount means
  // "the remaining balance", so the common flow needs zero typing.
  const [legs, setLegs] = useState<DraftLeg[]>([
    { method: 'cash', amount: '', tendered: '', reference: '' },
  ]);

  const { view: legView, remaining, cashShort, balanced, allPositive } = useMemo(
    () => buildLegView(legs, total),
    [legs, total]
  );

  const canConfirm = balanced && allPositive && !cashShort && !placing;

  const setLeg = (i: number, patch: Partial<DraftLeg>) =>
    setLegs(prev => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));

  const addLeg = () => {
    // Pin the current leg amounts so the new leg picks up the remainder
    setLegs(prev => {
      const pinned = prev.map((l, i) => ({
        ...l,
        amount: l.amount.trim() !== '' ? l.amount : String(legView[i]?.resolvedAmount || ''),
      }));
      const nextMethod: LegMethod = pinned.some(l => l.method === 'cash') ? 'mpesa' : 'cash';
      return [...pinned, { method: nextMethod, amount: '', tendered: '', reference: '' }];
    });
  };

  const removeLeg = (i: number) => setLegs(prev => prev.filter((_, idx) => idx !== i));

  const handleConfirm = () => {
    setLocalError('');
    if (!balanced) { setLocalError(`Payments must add up to ${currency} ${total.toLocaleString()}`); return; }
    if (cashShort) { setLocalError('Cash tendered is less than the cash amount due'); return; }
    onConfirm({
      discountAmount,
      tipAmount,
      total,
      vatAmount,
      legs: legView.map(l => ({
        method: l.method,
        amount: l.resolvedAmount,
        amount_tendered: l.method === 'cash' ? l.resolvedTendered : l.resolvedAmount,
        change_given: l.method === 'cash' ? l.change : 0,
        reference: l.method === 'mpesa' || l.method === 'card' ? (l.reference || null) : null,
      })),
    });
  };

  const fmt = (n: number) => `${currency} ${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 px-4">
      <div className="bg-gray-900 border border-gray-800 rounded-2xl w-full max-w-md p-6 space-y-4 max-h-[92vh] overflow-y-auto">
        <div className="flex items-center justify-between">
          <h2 className="text-white font-semibold text-lg">Payment</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-white transition-colors">✕</button>
        </div>

        {/* Totals */}
        <div className="bg-gray-800/60 rounded-xl px-4 py-3 space-y-1 text-sm">
          <div className="flex justify-between text-gray-400">
            <span>Subtotal</span><span>{fmt(subtotal)}</span>
          </div>
          {discountAmount > 0 && (
            <div className="flex justify-between text-amber-400">
              <span>Discount{discountMode === 'percent' ? ` (${discountRaw}%)` : ''}</span>
              <span>−{fmt(discountAmount)}</span>
            </div>
          )}
          {tipAmount > 0 && (
            <div className="flex justify-between text-gray-400">
              <span>Tip</span><span>{fmt(tipAmount)}</span>
            </div>
          )}
          <div className="flex justify-between text-gray-500 text-xs">
            <span>incl. VAT ({vatRate}%)</span><span>{fmt(vatAmount)}</span>
          </div>
          <div className="flex justify-between text-white font-bold text-xl pt-1 border-t border-gray-700">
            <span>Total due</span><span>{fmt(total)}</span>
          </div>
        </div>

        {/* Discount / tip */}
        <button
          onClick={() => setShowAdjustments(s => !s)}
          className="text-xs text-gray-500 hover:text-white transition-colors"
        >
          {showAdjustments ? '▾' : '▸'} Discount / tip
        </button>
        {showAdjustments && (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-gray-400 mb-1">Discount</label>
              <div className="flex">
                <input
                  type="number" min="0" value={discountInput}
                  onChange={e => setDiscountInput(e.target.value)}
                  placeholder="0"
                  className="w-full bg-gray-800 border border-gray-700 rounded-l-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-green-500"
                />
                <button
                  onClick={() => setDiscountMode(m => (m === 'amount' ? 'percent' : 'amount'))}
                  className="px-3 bg-gray-700 border border-l-0 border-gray-700 rounded-r-lg text-sm text-gray-300 hover:text-white"
                  title="Toggle amount / percent"
                >
                  {discountMode === 'amount' ? currency : '%'}
                </button>
              </div>
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Tip ({currency})</label>
              <input
                type="number" min="0" value={tipInput}
                onChange={e => setTipInput(e.target.value)}
                placeholder="0"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-green-500"
              />
            </div>
          </div>
        )}

        {/* Payment legs */}
        <div className="space-y-3">
          {legView.map((leg, i) => (
            <div key={i} className="bg-gray-800/40 border border-gray-800 rounded-xl p-3 space-y-3">
              <div className="flex items-center gap-2">
                <div className="grid grid-cols-3 gap-1.5 flex-1">
                  {(Object.keys(METHOD_META) as LegMethod[]).map(m => (
                    <button
                      key={m}
                      onClick={() => setLeg(i, { method: m })}
                      className={`py-2 rounded-lg text-xs font-medium border transition-colors ${leg.method === m ? 'bg-green-500/10 border-green-500 text-green-400' : 'bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-600'}`}
                    >
                      {METHOD_META[m].icon} {METHOD_META[m].label}
                    </button>
                  ))}
                </div>
                {legs.length > 1 && (
                  <button onClick={() => removeLeg(i)} className="text-gray-600 hover:text-red-400 transition-colors px-1">✕</button>
                )}
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Amount</label>
                  <input
                    type="number" min="0" value={legs[i].amount}
                    onChange={e => setLeg(i, { amount: e.target.value })}
                    placeholder={String(leg.resolvedAmount || total)}
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm font-semibold focus:outline-none focus:border-green-500"
                  />
                </div>
                {leg.method === 'cash' ? (
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Tendered</label>
                    <input
                      type="number" min="0" value={legs[i].tendered}
                      onChange={e => setLeg(i, { tendered: e.target.value })}
                      placeholder={String(leg.resolvedAmount)}
                      className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm font-semibold focus:outline-none focus:border-green-500"
                    />
                  </div>
                ) : (
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">
                      Reference <span className="text-gray-600">(optional)</span>
                    </label>
                    <input
                      type="text" value={legs[i].reference}
                      onChange={e => setLeg(i, { reference: leg.method === 'mpesa' ? e.target.value.toUpperCase() : e.target.value })}
                      placeholder={leg.method === 'mpesa' ? 'QHX4K2L9MP' : 'Txn ID'}
                      className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm font-mono focus:outline-none focus:border-green-500"
                    />
                  </div>
                )}
              </div>

              {leg.method === 'cash' && leg.change > 0 && (
                <div className="flex justify-between text-sm bg-gray-800 rounded-lg px-3 py-2">
                  <span className="text-gray-400">Change</span>
                  <span className="text-white font-semibold">{fmt(leg.change)}</span>
                </div>
              )}
            </div>
          ))}

          <div className="flex items-center justify-between">
            <button onClick={addLeg} className="text-xs text-green-400 hover:text-green-300 transition-colors font-medium">
              + Split payment
            </button>
            {Math.abs(remaining) > EPSILON && (
              <span className={`text-xs font-medium ${remaining > 0 ? 'text-amber-400' : 'text-red-400'}`}>
                {remaining > 0 ? `${fmt(remaining)} remaining` : `${fmt(Math.abs(remaining))} over`}
              </span>
            )}
          </div>
        </div>

        {(error || localError) && <p className="text-red-400 text-sm">{error || localError}</p>}

        <button
          onClick={handleConfirm}
          disabled={!canConfirm}
          className="w-full bg-green-500 hover:bg-green-400 disabled:opacity-40 disabled:cursor-not-allowed text-gray-950 font-bold rounded-xl py-3 transition-colors"
        >
          {placing ? 'Processing…' : `Charge ${fmt(total)}`}
        </button>
      </div>
    </div>
  );
}
