/**
 * SaleCustomer.tsx — A607: the customer for THIS sale, from the POS's "+ Customer" (it replaces A595's New customer form and
 * keeps what it did: a customer saved with name, phone and KRA PIN).
 *
 * Owner, 2026-10-28: clients' details "captured by the cashier both on the main screen and the second screen".
 *   - The cashier types the name, the phone and — when KRA eTIMS is on for the business — the KRA PIN (standard);
 *   - or presses "Customer types it" (the screen turned to the customer: a large form and nothing else — standard);
 *   - or "Ask the customer" — the form on the customer screen (premium: the online licence, a touch screen, showing).
 * What the customer typed comes back HERE to accept or correct; nothing is attached to the sale until "Use for this sale".
 * Consent (customerDetails.ts consentPlan): "Save my details for next time" makes the customer's record (online, with the
 * person's own sign-in); without it the details serve this sale only — the PIN on the invoice, the name on the receipt, the
 * phone for the M-Pesa prompt alone. A number the customer typed is shown masked to someone without customers.contacts.
 * Loaded on demand (the POS's main chunk budget, lazy-load-a517).
 */
import { useEffect, useRef, useState } from 'react';
import { posApi } from '../lib/posApi';
import CustomerTypesIt from './CustomerTypesIt';
import {
  CONSENT_LINE, SAVE_LABEL, consentPlan, kraPinError, phoneError, normaliseKenyanPhone, normaliseKraPin, maskTypedPhone,
  newAskId, cleanName, type CustomerAnswer, type SaleDetails,
} from '@zaptill/core/customerDetails';

export interface SaleBuyer {
  /** What the POS's button shows ("Mary", "PIN A123…", "Customer"). */
  label: string;
  /** What the sale carries (customer_name / customer_phone / buyer_kra_pin / customer_id). */
  sale: SaleDetails & { customer_id?: string };
  /** The number the M-Pesa prompt goes to (or null). */
  stkPhone: string | null;
  /** The phone came from the customer and this person may not read it: shown masked. */
  masked?: boolean;
}

export default function SaleCustomer({ canSave, total, currency, value, onDone, onClose }: {
  canSave: boolean; total: number; currency: string; value: SaleBuyer | null;
  onDone: (b: SaleBuyer | null) => void; onClose: () => void;
}) {
  const [info, setInfo] = useState({ etimsEnabled: false, seesContacts: true });
  const [askable, setAskable] = useState<{ allowed: boolean; why: string | null }>({ allowed: false, why: null });
  const [name, setName] = useState(value?.sale.customer_name ?? '');
  const [phone, setPhone] = useState(value?.stkPhone ?? value?.sale.customer_phone ?? '');
  const [masked, setMasked] = useState(!!value?.masked);
  const [pin, setPin] = useState(value?.sale.buyer_kra_pin ?? '');
  const [save, setSave] = useState(false);
  const [typesIt, setTypesIt] = useState(false);
  const [waiting, setWaiting] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const waitRef = useRef<string | null>(null);
  const seesRef = useRef(true);   // read when an answer arrives (the listener is made once)

  useEffect(() => {
    posApi.customerDetails.saleInfo().then((i) => { seesRef.current = i.seesContacts; setInfo(i); }).catch(() => {});
    posApi.customerDisplay.askable().then(setAskable).catch(() => {});
    const off = posApi.customerDisplay.onAnswered((a) => {
      if (!a || a.id !== waitRef.current) return;
      waitRef.current = null; setWaiting(null);
      if (a.answer) fill(a.answer, 'The customer typed these — check them, then use them for this sale.');
      else setNote(a.cancelled ? 'The customer screen closed — type the details here.' : 'The customer skipped it.');
    });
    return () => { off(); if (waitRef.current) void posApi.customerDisplay.cancelAsk(waitRef.current).catch(() => {}); };
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  const fill = (a: CustomerAnswer, why: string) => {
    setName(a.name ?? ''); setPhone(a.phone ?? ''); setPin(a.kraPin ?? ''); setSave(a.save);
    setMasked(!!a.phone && !seesRef.current); setNote(why); setError('');
  };

  const askScreen = async () => {
    setNote(''); setError('');
    const id = newAskId();
    const r = await posApi.customerDisplay.ask({ id, purpose: 'details', needPin: info.etimsEnabled, amount: total, currency }).catch(() => null);
    if (!r || !r.ok) { setError(r && !r.ok ? r.why : 'The customer screen could not ask.'); return; }
    waitRef.current = id; setWaiting(id);
  };
  const stopWaiting = () => { if (waitRef.current) void posApi.customerDisplay.cancelAsk(waitRef.current).catch(() => {}); waitRef.current = null; setWaiting(null); };

  const pErr = masked ? null : phoneError(phone, false);
  const kErr = info.etimsEnabled ? kraPinError(pin) : null;
  const use = async () => {
    if (pErr || kErr || busy) return;
    setBusy(true); setError('');
    try {
      const plan = consentPlan({ name, phone: normaliseKenyanPhone(phone), kraPin: info.etimsEnabled ? normaliseKraPin(pin) : null, save }, info.etimsEnabled);
      const sale: SaleBuyer['sale'] = { ...plan.sale };
      if (plan.saveCustomer) {
        if (!canSave) { setError('Saving a customer needs the customers right — untick "Save" to use the details for this sale only.'); return; }
        try {
          const r = await posApi.order.createCustomer(plan.saveCustomer) as { customer?: { id?: unknown } };
          if (typeof r?.customer?.id === 'string') sale.customer_id = r.customer.id;
        } catch (e: any) {
          setError(`${e?.message ?? 'The customer could not be saved'} — untick "Save" to use the details for this sale only.`);
          return;
        }
      }
      const label = plan.sale.customer_name || (plan.sale.buyer_kra_pin ? `PIN ${plan.sale.buyer_kra_pin}` : plan.stkPhone ? 'Customer' : '');
      onDone(label ? { label, sale, stkPhone: plan.stkPhone, masked } : null);
    } finally { setBusy(false); }
  };

  const field = 'w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-white placeholder-gray-500';
  if (typesIt) {
    return <CustomerTypesIt purpose="details" needPin={info.etimsEnabled} amount={total} currency={currency}
      onDone={(a) => { setTypesIt(false); fill(a, 'The customer typed these — check them, then use them for this sale.'); }}
      onBack={() => setTypesIt(false)} />;
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" data-testid="sale-customer">
      <div className="w-full max-w-sm space-y-3 rounded-xl border border-gray-700 bg-gray-900 p-5">
        <p className="text-base font-semibold text-white">Customer for this sale</p>
        {waiting ? (
          <div className="space-y-3 rounded-lg bg-gray-800 p-3 text-sm text-gray-200" data-testid="sale-customer-waiting">
            <p>The customer is typing their details on the customer screen…</p>
            <button onClick={stopWaiting} className="text-xs text-action-400 hover:text-action-300">Cancel — I will type them</button>
          </div>
        ) : (
          <>
            <input className={field} value={name} onChange={(e) => setName(cleanName(e.target.value) + (/\s$/.test(e.target.value) ? ' ' : ''))} placeholder="Name" autoFocus />
            {masked ? (
              <div className="flex items-center justify-between rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-white" data-testid="sale-customer-masked">
                <span>{maskTypedPhone(phone)}</span>
                <button onClick={() => { setPhone(''); setMasked(false); }} className="text-xs text-action-400">Change</button>
              </div>
            ) : (
              <input className={field} value={phone}
                onChange={(e) => setPhone(e.target.value)} placeholder="Phone (07XX XXX XXX)" inputMode="tel" data-testid="sale-customer-phone" />
            )}
            {pErr && <p className="text-xs text-amber-400">{pErr}</p>}
            {info.etimsEnabled && (
              <input className={field} value={pin} onChange={(e) => setPin(e.target.value.toUpperCase())} placeholder="KRA PIN (for a tax invoice, e.g. A123456789Z)" maxLength={13} data-testid="sale-customer-pin" />
            )}
            {kErr && <p className="text-xs text-amber-400">{kErr}</p>}
            <label className="flex items-center gap-2 text-sm text-gray-200">
              <input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} data-testid="sale-customer-save" /> {SAVE_LABEL}
            </label>
            <p className="text-xs text-gray-400">Tell the customer: "{CONSENT_LINE}"</p>
            <div className="flex flex-wrap gap-2">
              <button onClick={() => setTypesIt(true)} className="rounded-lg border border-gray-600 px-3 py-1.5 text-xs text-gray-200 hover:text-white" data-testid="sale-customer-types">Customer types it</button>
              {askable.allowed && (
                <button onClick={askScreen} className="rounded-lg border border-gray-600 px-3 py-1.5 text-xs text-gray-200 hover:text-white" data-testid="sale-customer-ask">Ask the customer</button>
              )}
            </div>
          </>
        )}
        {note && <p className="text-xs text-sky-300">{note}</p>}
        {error && <p className="text-xs text-red-400">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          {value && <button onClick={() => onDone(null)} className="mr-auto rounded-lg px-3 py-2 text-sm text-gray-300 hover:text-white">Remove</button>}
          <button onClick={() => { stopWaiting(); onClose(); }} className="rounded-lg px-3 py-2 text-sm text-gray-300 hover:text-white">Cancel</button>
          <button onClick={use} disabled={busy || !!waiting || !!pErr || !!kErr}
            className="rounded-lg bg-action-500 px-4 py-2 text-sm font-semibold text-gray-950 disabled:opacity-40" data-testid="sale-customer-use">{busy ? 'Saving…' : 'Use for this sale'}</button>
        </div>
      </div>
    </div>
  );
}
