/**
 * MpesaStkPanel.tsx — A607: the M-Pesa prompt on the DESKTOP POS's payment screen, under an M-Pesa leg.
 *
 * Shown only when the business's M-Pesa integration is set up and this POS is online (main/mpesaStk.ts offered — the cloud's
 * GET /api/mpesa/config); otherwise nothing here, and M-Pesa is taken as before (the till number / Paybill, the reference
 * typed by hand). The number: typed by the cashier, the one the customer gave for this sale, typed by the customer
 * ("Customer types it" on this screen) or on the customer screen ("Ask the customer" — premium). "Send M-Pesa prompt" →
 * both screens show "Waiting for M-Pesa… (check your phone)", then "Paid ✓" (the M-Pesa receipt fills the leg's
 * reference — the cashier still presses Charge) or "Not completed — try again / pay by till number".
 * Loaded on demand (the POS's main chunk budget).
 */
import { useEffect, useRef, useState } from 'react';
import { posApi } from '../lib/posApi';
import CustomerTypesIt from './CustomerTypesIt';
import { phoneError, maskTypedPhone, newAskId, stkWords, type StkStage } from '../../shared/customerDetails';

interface Stk { stage: StkStage; amount: number; currency: string; reason: string | null; mpesaRef: string | null }

export default function MpesaStkPanel({ amount, currency, phone: given, masked: givenMasked = false, onPaid }: {
  amount: number; currency: string; phone?: string | null; masked?: boolean; onPaid: (mpesaRef: string) => void;
}) {
  const [offered, setOffered] = useState(false);
  const [askable, setAskable] = useState(false);
  const [phone, setPhone] = useState(given ?? '');
  const [masked, setMasked] = useState(!!given && givenMasked);
  const [stk, setStk] = useState<Stk | null>(null);
  const [typesIt, setTypesIt] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState('');
  const askId = useRef<string | null>(null);
  const seesRef = useRef(true);
  const paidRef = useRef(false);

  useEffect(() => {
    let live = true;
    posApi.mpesa.stkOffered().then((r) => { if (live) setOffered(r.offered === true); }).catch(() => {});
    posApi.customerDisplay.askable().then((r) => { if (live) setAskable(r.allowed === true); }).catch(() => {});
    posApi.customerDetails.saleInfo().then((i) => { seesRef.current = i.seesContacts; }).catch(() => {});
    const offStk = posApi.mpesa.onStk((s: Stk) => {
      setStk(s);
      if (s?.stage === 'paid' && s.mpesaRef && !paidRef.current) { paidRef.current = true; onPaid(s.mpesaRef); }
    });
    const offAns = posApi.customerDisplay.onAnswered((a) => {
      if (!a || a.id !== askId.current) return;
      askId.current = null; setWaiting(false);
      if (a.answer?.phone) { setPhone(a.answer.phone); setMasked(!seesRef.current); }
    });
    return () => {
      live = false; offStk(); offAns();
      if (askId.current) void posApi.customerDisplay.cancelAsk(askId.current).catch(() => {});
      void posApi.mpesa.stkReset().catch(() => {});   // both screens back
    };
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  if (!offered) return null;
  const pErr = masked ? null : phoneError(phone, true);
  const busy = stk?.stage === 'sending' || stk?.stage === 'waiting';
  const send = async () => {
    setError('');
    if (pErr || busy || !(amount > 0)) { if (pErr) setError(pErr); return; }
    paidRef.current = false;
    await posApi.mpesa.stkStart({ phone, amount, currency, ref: `POS-${Date.now().toString(36).toUpperCase()}` }).catch((e: any) => setError(e?.message ?? 'The prompt could not be sent.'));
  };
  const askScreen = async () => {
    const id = newAskId();
    const r = await posApi.customerDisplay.ask({ id, purpose: 'mpesa', needPin: false, amount, currency }).catch(() => null);
    if (!r || !r.ok) { setError(r && !r.ok ? r.why : 'The customer screen could not ask.'); return; }
    askId.current = id; setWaiting(true);
  };

  if (typesIt) {
    return <CustomerTypesIt purpose="mpesa" needPin={false} amount={amount} currency={currency}
      onDone={(a) => { setTypesIt(false); if (a.phone) { setPhone(a.phone); setMasked(!seesRef.current); } }}
      onBack={() => setTypesIt(false)} />;
  }
  const words = stk && stk.stage !== 'idle' ? stkWords(stk.stage) : null;
  return (
    <div className="space-y-2 rounded-lg bg-gray-800/70 p-2" data-testid="stk-panel">
      <p className="text-xs font-semibold text-gray-200">M-Pesa prompt to the customer's phone</p>
      {masked ? (
        <div className="flex items-center justify-between text-sm text-white" data-testid="stk-masked">
          <span>{maskTypedPhone(phone)}</span>
          <button onClick={() => { setPhone(''); setMasked(false); }} className="text-xs text-action-400">Change</button>
        </div>
      ) : (
        <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="M-Pesa phone (07XX XXX XXX)" inputMode="tel" disabled={busy}
          className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-white" data-testid="stk-phone" />
      )}
      <div className="flex flex-wrap gap-2">
        <button onClick={send} disabled={busy || waiting} className="rounded-lg bg-action-500 px-3 py-1.5 text-xs font-semibold text-gray-950 disabled:opacity-40" data-testid="stk-send">
          {stk?.stage === 'failed' ? 'Try again' : 'Send M-Pesa prompt'}
        </button>
        {!busy && <button onClick={() => setTypesIt(true)} className="rounded-lg border border-gray-600 px-3 py-1.5 text-xs text-gray-200">Customer types it</button>}
        {!busy && askable && !waiting && <button onClick={askScreen} className="rounded-lg border border-gray-600 px-3 py-1.5 text-xs text-gray-200" data-testid="stk-ask">Ask the customer</button>}
      </div>
      {waiting && <p className="text-xs text-sky-300">The customer is typing their M-Pesa number on the customer screen…</p>}
      {words && (
        <p className={`text-sm font-semibold ${stk?.stage === 'paid' ? 'text-white' : stk?.stage === 'failed' ? 'text-red-400' : 'text-sky-300'}`} data-testid="stk-status">
          {words.title}{stk?.stage === 'paid' && stk.mpesaRef ? ` — ${stk.mpesaRef}` : ''}{stk?.stage === 'failed' && stk.reason ? ` (${stk.reason})` : ''}
        </p>
      )}
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
