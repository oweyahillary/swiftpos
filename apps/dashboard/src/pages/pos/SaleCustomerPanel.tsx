/**
 * SaleCustomerPanel.tsx — A607: the customer for THIS sale on the web POS (the desktop's components/SaleCustomer.tsx, the
 * same rules: lib/customerDetails.ts).
 *
 *   - The cashier types the name, the phone and — when KRA eTIMS is on for the business — the KRA PIN (standard);
 *   - "Customer types it": this screen turned to the customer, a large form and nothing else (standard);
 *   - "Ask the customer": the form on the customer screen window (A606) over its BroadcastChannel — when this browser is set
 *     as "The customer screen is a touch screen" and the customer screen is showing. The web POS itself is the online
 *     licence, so the premium gate is met by being here.
 * What the customer typed comes back HERE (checked by the channel's publisher — only the typed fields) to accept or correct;
 * nothing is attached until "Use for this sale". "Save my details for next time" makes the customer's record (the loyalty
 * customer, as LoyaltyPanel's Add) and attaches it; without it the details serve this sale only (the PIN on the invoice,
 * the name on the receipt, the phone for the M-Pesa prompt). A typed number is masked for someone without customers.contacts.
 * Loaded on demand.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../lib/api';
import CustomerAskForm from '@zaptill/ui/CustomerAskForm';
import {
  CONSENT_LINE, SAVE_LABEL, consentPlan, kraPinError, phoneError, normaliseKenyanPhone, normaliseKraPin, maskTypedPhone,
  newAskId, cleanAnswer, secondScreenAsk, type CustomerAnswer, type SaleDetails,
} from '@zaptill/core/customerDetails';
import { customerScreenPublisher, customerScreenTouch, setCustomerScreenTouch } from '../../lib/customerScreenChannel';

export interface WebSaleBuyer {
  label: string;
  sale: SaleDetails & { customer_id?: string };
  stkPhone: string | null;
  masked?: boolean;
  /** A saved customer, attached as the loyalty customer (LoyaltyState). */
  loyalty?: unknown;
}

export default function SaleCustomerPanel({ total, currency, etimsEnabled, seesContacts, value, onDone, onClose }: {
  total: number; currency: string; etimsEnabled: boolean; seesContacts: boolean; value: WebSaleBuyer | null;
  onDone: (b: WebSaleBuyer | null) => void; onClose: () => void;
}) {
  const [name, setName] = useState(value?.sale.customer_name ?? '');
  const [phone, setPhone] = useState(value?.stkPhone ?? '');
  const [masked, setMasked] = useState(!!value?.masked);
  const [pin, setPin] = useState(value?.sale.buyer_kra_pin ?? '');
  const [save, setSave] = useState(false);
  const [touch, setTouch] = useState(customerScreenTouch());
  const [typesIt, setTypesIt] = useState(false);
  const [waiting, setWaiting] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const waitRef = useRef<string | null>(null);
  const local = useMemo(() => ({ id: newAskId(), purpose: 'details' as const, needPin: etimsEnabled, amount: total, currency }), [etimsEnabled, total, currency]);

  const fill = (a: CustomerAnswer, why: string) => {
    setName(a.name ?? ''); setPhone(a.phone ?? ''); setPin(a.kraPin ?? ''); setSave(a.save);
    setMasked(!!a.phone && !seesContacts); setNote(why); setError('');
  };
  useEffect(() => {
    const pub = customerScreenPublisher();
    if (!pub) return;
    const off = pub.onAnswer((a) => {
      if (a.id !== waitRef.current) return;
      waitRef.current = null; setWaiting(null);
      if (a.answer) fill(a.answer, 'The customer typed these — check them, then use them for this sale.');
      else setNote('The customer skipped it.');
    });
    return () => { off(); if (waitRef.current) pub.cancelAsk(waitRef.current); };
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  const gate = secondScreenAsk({ touch, licensed: true, open: !!customerScreenPublisher()?.showing() });
  const askScreen = () => {
    setNote(''); setError('');
    const pub = customerScreenPublisher();
    const a = pub?.ask({ id: newAskId(), purpose: 'details', needPin: etimsEnabled, amount: total, currency });
    if (!a) { setError('The customer screen could not ask.'); return; }
    waitRef.current = a.id; setWaiting(a.id);
  };
  const stopWaiting = () => { if (waitRef.current) customerScreenPublisher()?.cancelAsk(waitRef.current); waitRef.current = null; setWaiting(null); };

  const pErr = masked ? null : phoneError(phone, false);
  const kErr = etimsEnabled ? kraPinError(pin) : null;
  const use = async () => {
    if (pErr || kErr || busy) return;
    setBusy(true); setError('');
    try {
      const plan = consentPlan({ name, phone: normaliseKenyanPhone(phone), kraPin: etimsEnabled ? normaliseKraPin(pin) : null, save }, etimsEnabled);
      const sale: WebSaleBuyer['sale'] = { ...plan.sale };
      let loyalty: unknown;
      if (plan.saveCustomer) {
        try {
          const r = await api.post<{ customer: { id: string }; tier: unknown }>('/api/loyalty/customer', plan.saveCustomer);
          if (r?.customer?.id) { sale.customer_id = r.customer.id; loyalty = { customer: r.customer, tier: r.tier, pointsToRedeem: 0, discountAmount: 0 }; }
        } catch (e: any) {
          setError(`${e?.message ?? 'The customer could not be saved'} — untick "Save" to use the details for this sale only.`);
          return;
        }
      }
      const label = plan.sale.customer_name || (plan.sale.buyer_kra_pin ? `PIN ${plan.sale.buyer_kra_pin}` : plan.stkPhone ? 'Customer' : '');
      onDone(label ? { label, sale, stkPhone: plan.stkPhone, masked, loyalty } : null);
    } finally { setBusy(false); }
  };

  if (typesIt) {
    return <CustomerAskForm ask={local} skipLabel="Back to the cashier" style={{ zIndex: 9999 }}
      onSubmit={(v) => {
        const c = cleanAnswer(v, local);
        if ('errors' in c) return c.errors;
        setTypesIt(false); fill(c.value, 'The customer typed these — check them, then use them for this sale.');
        return null;
      }}
      onSkip={() => setTypesIt(false)} />;
  }
  const field = 'w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-white placeholder-gray-500';
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" data-testid="web-sale-customer">
      <div className="w-full max-w-sm space-y-3 rounded-xl border border-gray-700 bg-gray-900 p-5">
        <p className="text-base font-semibold text-white">Customer for this sale</p>
        {waiting ? (
          <div className="space-y-3 rounded-lg bg-gray-800 p-3 text-sm text-gray-200">
            <p>The customer is typing their details on the customer screen…</p>
            <button onClick={stopWaiting} className="text-xs text-action-400">Cancel — I will type them</button>
          </div>
        ) : (
          <>
            <input className={field} value={name} onChange={(e) => setName(e.target.value.slice(0, 60))} placeholder="Name" autoFocus />
            {masked ? (
              <div className="flex items-center justify-between rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-white">
                <span>{maskTypedPhone(phone)}</span>
                <button onClick={() => { setPhone(''); setMasked(false); }} className="text-xs text-action-400">Change</button>
              </div>
            ) : (
              <input className={field} value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Phone (07XX XXX XXX)" inputMode="tel" />
            )}
            {pErr && <p className="text-xs text-amber-400">{pErr}</p>}
            {etimsEnabled && <input className={field} value={pin} onChange={(e) => setPin(e.target.value.toUpperCase())} placeholder="KRA PIN (for a tax invoice, e.g. A123456789Z)" maxLength={13} />}
            {kErr && <p className="text-xs text-amber-400">{kErr}</p>}
            <label className="flex items-center gap-2 text-sm text-gray-200">
              <input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} /> {SAVE_LABEL}
            </label>
            <p className="text-xs text-gray-400">Tell the customer: "{CONSENT_LINE}"</p>
            <div className="flex flex-wrap gap-2">
              <button onClick={() => setTypesIt(true)} className="rounded-lg border border-gray-600 px-3 py-1.5 text-xs text-gray-200">Customer types it</button>
              {gate.allowed && <button onClick={askScreen} className="rounded-lg border border-gray-600 px-3 py-1.5 text-xs text-gray-200">Ask the customer</button>}
            </div>
            <label className="flex items-center gap-2 text-xs text-gray-400">
              <input type="checkbox" checked={touch} onChange={(e) => { setCustomerScreenTouch(e.target.checked); setTouch(e.target.checked); }} />
              The customer screen is a touch screen (this browser)
            </label>
          </>
        )}
        {note && <p className="text-xs text-gray-400">{note}</p>}
        {error && <p className="text-xs text-red-400">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          {value && <button onClick={() => onDone(null)} className="mr-auto rounded-lg px-3 py-2 text-sm text-gray-300">Remove</button>}
          <button onClick={() => { stopWaiting(); onClose(); }} className="rounded-lg px-3 py-2 text-sm text-gray-300">Cancel</button>
          <button onClick={use} disabled={busy || !!waiting || !!pErr || !!kErr}
            className="rounded-lg bg-action-500 px-4 py-2 text-sm font-semibold text-gray-950 disabled:opacity-40">{busy ? 'Saving…' : 'Use for this sale'}</button>
        </div>
      </div>
    </div>
  );
}
