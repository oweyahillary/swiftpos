import MethodDot from './MethodDot';
import { methodColour, methodSolid, methodTint } from '../../shared/paymentColours';
import { useMemo, useState } from 'react';
import { computeTotals, buildLegView, round2, EPSILON, DEFAULT_MAX_DISCOUNT_PCT } from '../lib/payment';
import type { DraftLeg, LegMethod } from '../lib/payment';
import { cleanDeliveryFee, amountDue as amountDueWithFee } from '../../shared/delivery';
import { enabledFromSetting, paymentButtons } from '../../shared/paymentCatalogue';   // A429
import type { AppliedOffer } from '../../shared/offers';   // A445

// Payment modal — split tender + discount + tip.
//
// The main process (createLocalOrder) and the server (POST /api/orders) both
// already accept a `payments[]` array, discount_amount and tip_amount — this
// modal is the renderer finally catching up with that contract.
//
// All money maths lives in ../lib/payment.ts (pure, dryrun-testable).

export type { LegMethod };

export interface PaymentLeg {
  method: string;
  amount: number;
  amount_tendered: number;
  change_given: number;
  reference: string | null;
}

export interface PaymentResult {
  /** The whole discount: the offers' + the manual one (orders.discount_amount). */
  discountAmount: number;
  /** A445: the part offers took off, and which (orders.offer_discount / orders.offers). */
  offerDiscount: number;
  offers: AppliedOffer[];
  tipAmount: number;
  /** The BILL — subtotal minus discount, excluding tip. Goes to orders.total. */
  total: number;
  /** What the customer paid: total + tipAmount (+ deliveryFee). The legs sum to this. */
  amountDue: number;
  /** 0.6.27: the delivery fee paid on top of the bill (pass-through to the rider; not sales). 0 = none. */
  deliveryFee: number;
  vatAmount: number;
  ctlAmount: number;
  legs: PaymentLeg[];
}

interface Props {
  subtotal: number;       // VAT-inclusive cart subtotal
  vatRate: number;        // e.g. 16
  ctlRate?: number;       // Catering/Tourism Levy %, 0 = not applicable
  // Discount ceiling the SERVER will enforce. Passed in so the till clamps to
  // the same number rather than printing a discount the books won't record.
  maxDiscountPct?: number;
  /** A490: may this person give a discount by hand (sales.discount)? Without it the Discount box is not offered (the
   *  main process refuses a sale carrying one). Offers still apply. Absent: allowed, as before. */
  allowDiscount?: boolean;
  currency: string;
  placing: boolean;
  error: string;
  // Custom tenders beyond the built-ins (A96), cached from the last pull so they
  // work offline. Rendered as extra method buttons; all are non-cash.
  customMethods?: { code: string; name: string }[];
  /** A429: the payment methods the branch takes (catalogue codes); null / absent = the catalogue's defaults. */
  enabledMethods?: string[] | null;
  /** 0.6.27: a delivery fee to collect on top of the bill ('delivery_fee' switch; 0 = none). */
  deliveryFee?: number;
  /** 0.6.27: who takes the order (shown beside the fee). */
  rider?: string | null;
  /** A445: the offers on this cart (applied by the cart, shared/offers.ts) — shown, and taken off before a manual discount. */
  offers?: AppliedOffer[];
  onConfirm: (result: PaymentResult) => void;
  onClose: () => void;
}

// A429: the buttons are the branch's switched-on methods from shared/paymentCatalogue.ts (Cash, M-Pesa, Card, Glovo
// until a manager changes them; Airtel Money, T-Kash, bank transfer, the delivery apps … when switched on), then the
// business's own methods (A96). Delivery apps (Glovo …) collect from the customer and settle later, so nothing enters
// the drawer: cash reconciliation filters on method = 'cash' specifically, so no other method can inflate expected cash.

export default function PaymentModal({ subtotal, vatRate, ctlRate = 0, maxDiscountPct = DEFAULT_MAX_DISCOUNT_PCT, allowDiscount = true, currency, placing, error, customMethods = [], enabledMethods = null, deliveryFee: feeIn = 0, rider = null, offers = [], onConfirm, onClose }: Props) {
  const buttons = useMemo(() => paymentButtons(enabledFromSetting(enabledMethods), customMethods, 'till'), [enabledMethods, customMethods]);
  // The first leg starts on cash when the branch takes cash, else on its first method.
  const firstMethod = buttons.some((b) => b.code === 'cash') ? 'cash' : (buttons[0]?.code ?? 'cash');
  // ── Adjustments ─────────────────────────────────────────
  const [discountInput, setDiscountInput] = useState('');
  const [discountMode, setDiscountMode] = useState<'amount' | 'percent'>('amount');
  const [tipInput, setTipInput] = useState('');
  const [showAdjustments, setShowAdjustments] = useState(false);
  const [localError, setLocalError] = useState('');

  const discountRaw = allowDiscount ? (parseFloat(discountInput) || 0) : 0;   // A490: no hand discount without sales.discount
  const offersOff = round2(offers.reduce((s, o) => s + o.amount, 0));
  const { discountAmount, offerDiscount, manualDiscount, tipAmount, vatAmount, ctlAmount, total, amountDue: billAndTip, discountCapped } = useMemo(
    () => computeTotals(subtotal, { discountRaw, discountMode, tipRaw: parseFloat(tipInput) || 0, vatRate, ctlRate, maxDiscountPct, offerDiscount: offersOff }),
    [subtotal, discountRaw, discountMode, tipInput, vatRate, ctlRate, maxDiscountPct, offersOff]
  );
  // 0.6.27: the delivery fee rides on top like the tip — in the legs, not in the bill (total) or its taxes.
  const deliveryFee = cleanDeliveryFee(feeIn);
  const amountDue = amountDueWithFee(billAndTip, 0, deliveryFee);

  // ── Payment legs ────────────────────────────────────────
  // Single leg by default; "Split payment" adds more. A blank amount means
  // "the remaining balance", so the common flow needs zero typing.
  const [legs, setLegs] = useState<DraftLeg[]>([
    { method: firstMethod, amount: '', tendered: '', reference: '' },
  ]);

  const { view: legView, remaining, cashShort, balanced, allPositive } = useMemo(
    () => buildLegView(legs, amountDue),
    [legs, amountDue]
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
      // The next leg: a method the branch takes that no leg uses yet (M-Pesa after cash, as before), else the first.
      const used = new Set(pinned.map(l => l.method));
      const order = ['cash', 'mpesa', ...buttons.map(b => b.code)];
      const nextMethod: string = order.find(c => !used.has(c) && buttons.some(b => b.code === c)) ?? buttons[0]?.code ?? 'cash';
      return [...pinned, { method: nextMethod, amount: '', tendered: '', reference: '' }];
    });
  };

  const removeLeg = (i: number) => setLegs(prev => prev.filter((_, idx) => idx !== i));

  const handleConfirm = () => {
    setLocalError('');
    if (!balanced) { setLocalError(`Payments must add up to ${currency} ${amountDue.toLocaleString()}`); return; }
    if (cashShort) { setLocalError('Cash tendered is less than the cash amount due'); return; }
    onConfirm({
      discountAmount,
      offerDiscount,
      offers: offerDiscount > 0 ? offers : [],
      tipAmount,
      total,
      amountDue,
      deliveryFee,
      vatAmount,
      ctlAmount,
      legs: legView.map(l => ({
        method: l.method,
        amount: l.resolvedAmount,
        amount_tendered: l.method === 'cash' ? l.resolvedTendered : l.resolvedAmount,
        change_given: l.method === 'cash' ? l.change : 0,
        reference: l.method !== 'cash' ? (l.reference || null) : null,
      })),
    });
  };

  const fmt = (n: number) => `${currency} ${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 px-4 animate-fade-in">
      <div className="bg-gray-900 border border-gray-800 rounded-2xl w-full max-w-md p-6 space-y-4 max-h-[92vh] overflow-y-auto animate-pop-in">
        <div className="flex items-center justify-between">
          <h2 className="text-white font-semibold text-lg">Payment</h2>
          <button onClick={onClose} className="text-gray-300 hover:text-white transition-colors">✕</button>
        </div>

        {/* Totals */}
        <div className="bg-gray-800/60 rounded-xl px-4 py-3 space-y-1 text-sm">
          <div className="flex justify-between text-gray-400">
            <span>Subtotal</span><span>{fmt(subtotal)}</span>
          </div>
          {/* A445: each offer by name, then the cashier's own discount. */}
          {offerDiscount > 0 && offers.map((o) => (
            <div key={o.offer_id} data-testid="payment-offer" className="flex justify-between text-amber-300">
              <span>Offer: {o.name}</span><span>−{fmt(o.amount)}</span>
            </div>
          ))}
          {manualDiscount > 0 && (
            <div className="flex justify-between text-amber-400">
              <span>Discount{discountMode === 'percent' ? ` (${discountRaw}%)` : ''}</span>
              <span>−{fmt(manualDiscount)}</span>
            </div>
          )}
          {tipAmount > 0 && (
            <div className="flex justify-between text-gray-400">
              <span>Tip</span><span>{fmt(tipAmount)}</span>
            </div>
          )}
          {deliveryFee > 0 && (
            <div className="flex justify-between text-gray-400" data-testid="pay-delivery-fee">
              <span>Delivery fee{rider ? ` — ${rider}` : ''}</span><span>{fmt(deliveryFee)}</span>
            </div>
          )}
          {ctlRate > 0 && (
            <div className="flex justify-between text-gray-300 text-xs">
              <span>incl. CTL ({ctlRate}%)</span><span>{fmt(ctlAmount)}</span>
            </div>
          )}
          {vatRate > 0 && (
            <div className="flex justify-between text-gray-300 text-xs">
              <span>incl. VAT ({vatRate}%)</span><span>{fmt(vatAmount)}</span>
            </div>
          )}
          <div className="flex justify-between text-white font-bold text-xl pt-1 border-t border-gray-700">
            <span>Total due</span><span>{fmt(amountDue)}</span>
          </div>
        </div>

        {/* Discount / tip */}
        <button
          onClick={() => setShowAdjustments(s => !s)}
          className="text-xs text-gray-300 hover:text-white transition-colors"
        >
          {showAdjustments ? '▾' : '▸'} {allowDiscount ? 'Discount / tip' : 'Tip'}
        </button>
        {showAdjustments && (
          <div className="grid grid-cols-2 gap-3">
            {allowDiscount && <div>
              <label className="block text-xs text-gray-400 mb-1">Discount</label>
              <div className="flex">
                <input
                  type="number" min="0" value={discountInput}
                  onChange={e => setDiscountInput(e.target.value)}
                  placeholder="0"
                  className="w-full bg-gray-800 border border-gray-700 rounded-l-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-action-500"
                />
                <button
                  onClick={() => setDiscountMode(m => (m === 'amount' ? 'percent' : 'amount'))}
                  className="px-3 bg-gray-700 border border-l-0 border-gray-700 rounded-r-lg text-sm text-gray-300 hover:text-white"
                  title="Toggle amount / percent"
                >
                  {discountMode === 'amount' ? currency : '%'}
                </button>
              </div>
              {/* The server caps this and stores the capped figure. Saying so
                  here is the difference between a cashier correcting the entry
                  and a drawer that reads short at close for reasons nobody can
                  reconstruct the next morning. */}
              {discountCapped && (
                <p className="text-xs text-amber-400 mt-1">
                  Capped at {maxDiscountPct}% — {fmt(manualDiscount)} applied. Ask a manager for more.
                </p>
              )}
            </div>}
            <div>
              <label className="block text-xs text-gray-400 mb-1">Tip ({currency})</label>
              <input
                type="number" min="0" value={tipInput}
                onChange={e => setTipInput(e.target.value)}
                placeholder="0"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-action-500"
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
                  {buttons.map(b => ({ code: b.code, label: b.name, icon: b.icon })).map(m => (
                    <button
                      key={m.code}
                      onClick={() => setLeg(i, { method: m.code })}
                      aria-pressed={leg.method === m.code}
                      className={`py-2 rounded-lg text-xs border transition-colors ${leg.method === m.code ? 'font-bold' : 'font-medium bg-gray-800 border-gray-700 text-gray-300 hover:border-gray-600'}`}
                      // A344: each method in its own colour. A430: the SELECTED one solid in it, white text, a halo and a ✓.
                      style={leg.method === m.code ? { backgroundColor: methodSolid(m.code), borderColor: methodSolid(m.code), color: '#ffffff', boxShadow: `0 0 0 3px ${methodTint(m.code, 0.45)}` } : { backgroundColor: methodTint(m.code), borderColor: methodColour(m.code).dot }}
                    >
                      {leg.method === m.code ? <span aria-hidden className="mr-1">✓</span> : <MethodDot method={m.code} />}{m.icon} {m.label}
                    </button>
                  ))}
                </div>
                {legs.length > 1 && (
                  <button onClick={() => removeLeg(i)} className="text-gray-400 hover:text-red-400 transition-colors px-1">✕</button>
                )}
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-xs text-gray-300 mb-1">Amount</label>
                  <input
                    type="number" min="0" value={legs[i].amount}
                    onChange={e => setLeg(i, { amount: e.target.value })}
                    placeholder={String(leg.resolvedAmount || amountDue)}
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm font-semibold focus:outline-none focus:border-action-500"
                  />
                </div>
                {leg.method === 'cash' ? (
                  <div>
                    <label className="block text-xs text-gray-300 mb-1">Tendered</label>
                    <input
                      type="number" min="0" value={legs[i].tendered}
                      onChange={e => setLeg(i, { tendered: e.target.value })}
                      placeholder={String(leg.resolvedAmount)}
                      className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm font-semibold focus:outline-none focus:border-action-500"
                    />
                  </div>
                ) : (
                  <div>
                    <label className="block text-xs text-gray-300 mb-1">
                      Reference <span className="text-gray-400">(optional)</span>
                    </label>
                    <input
                      type="text" value={legs[i].reference}
                      onChange={e => setLeg(i, { reference: leg.method === 'mpesa' ? e.target.value.toUpperCase() : e.target.value })}
                      placeholder={buttons.find(b => b.code === leg.method)?.reference ?? 'Txn ID'}
                      className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm font-mono focus:outline-none focus:border-action-500"
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
            <button onClick={addLeg} className="text-xs text-action-400 hover:text-action-300 transition-colors font-medium">
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
          className="w-full bg-action-500 hover:bg-action-400 disabled:opacity-40 disabled:cursor-not-allowed text-gray-950 font-bold rounded-xl py-3 transition-colors"
        >
          {placing && <span className="btn-spinner" aria-hidden="true" />}{placing ? 'Processing…' : `Charge ${fmt(amountDue)}`}
        </button>
      </div>
    </div>
  );
}
