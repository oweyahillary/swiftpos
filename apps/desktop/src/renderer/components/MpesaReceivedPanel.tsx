/**
 * MpesaReceivedPanel.tsx — A621: "Payments received" under an M-Pesa leg on the DESKTOP POS's payment screen.
 *
 * Owner, 2026-11-02: "Some customers do not like giving out their number, they prefer paying to the till or paybill
 * directly; what the cashier gets is a notification of the payments done, then they match it to the bill." The branch's
 * payments of the last 30 minutes nobody has taken (main/mpesaC2b.ts) that pay this leg exactly (owner, 2026-11-03: "show
 * payments that match the bill only"); the cashier taps the customer's and the sale completes. Shown only with the online
 * licence, online, and notifications switched on for the branch — otherwise nothing here, and the code is typed by hand.
 *
 * The panel owns the payment it took for its leg: it gives it back when the leg's code no longer names it (typed over),
 * and when it closes unsold (the leg removed, another method picked, the payment screen closed). A sale going through
 * closes the payment screen while `placing` is still true — then the payment stays this sale's until the order reaches the
 * cloud and marks it used. Everything lives here, loaded on demand: the payment screen is in the POS's main chunk.
 * Asks every few seconds while shown, and at once when the cloud rings.
 */
import { useEffect, useRef, useState } from 'react';
import { posApi } from '../lib/posApi';
import { RECEIVED_POLL_MS, claimRefusalText, newSaleRef, paidAtLabel, paymentsForBill, type ReceivedPayment } from '../../shared/mpesaPayments';

interface Props {
  /** What this M-Pesa leg is to collect. */
  toPay: number;
  currency: string;
  /** The leg's M-Pesa code now (tapped here, or typed). */
  reference: string;
  /** The sale is being charged — closing now is a sale, not a back-out. */
  placing: boolean;
  /** The tapped payment's code — it pays the leg, so the payment screen completes the sale — or '' when taken off. */
  onCode: (code: string) => void;
}

export default function MpesaReceivedPanel({ toPay, currency, reference, placing, onCode }: Props) {
  const [offered, setOffered] = useState(false);
  const [payments, setPayments] = useState<ReceivedPayment[]>([]);
  const [taken, setTaken] = useState<ReceivedPayment | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const saleRef = useRef(newSaleRef()).current;
  const latest = useRef({ taken, placing });
  latest.current = { taken, placing };

  const giveBack = (p: ReceivedPayment) => { void posApi.mpesa.receivedRelease({ trans_id: p.trans_id, sale_ref: saleRef }).catch(() => {}); };

  useEffect(() => {
    let live = true;
    const load = () => posApi.mpesa.receivedList({ amount: toPay }).then((r) => {
      if (!live) return;
      setOffered(r.offered === true);
      setPayments(paymentsForBill(r.payments ?? [], toPay));
    }).catch(() => {});
    void load();
    const timer = setInterval(load, RECEIVED_POLL_MS);
    const off = posApi.mpesa.onReceivedArrived(() => { void load(); });
    return () => { live = false; clearInterval(timer); off(); };
  }, [toPay]);

  // The code typed over: the payment is no longer on the bill.
  useEffect(() => {
    if (taken && reference !== taken.trans_id) { giveBack(taken); setTaken(null); }
  }, [reference]);   // eslint-disable-line react-hooks/exhaustive-deps

  // Closed unsold: the payment goes back to every POS's list.
  useEffect(() => () => {
    const { taken: held, placing: selling } = latest.current;
    if (held && !selling) giveBack(held);
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  if (!offered && !taken) return null;
  const money = (n: number) => `${currency} ${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

  const tap = async (p: ReceivedPayment) => {
    setError(''); setBusy(p.trans_id);
    const r = await posApi.mpesa.receivedClaim({ trans_id: p.trans_id, sale_ref: saleRef })
      .catch(() => ({ ok: false as const, error: 'The payment could not be taken.' }));
    setBusy(null);
    if ('payment' in r) {
      if (taken) giveBack(taken);
      setTaken(r.payment);
      onCode(r.payment.trans_id);
      return;
    }
    setError(claimRefusalText('code' in r ? r.code : undefined, r.error));
    setPayments((list) => list.filter((x) => x.trans_id !== p.trans_id));
  };
  const takeOff = () => {
    if (taken) giveBack(taken);
    setTaken(null);
    onCode('');
  };

  if (taken) {
    return (
      <div className="flex items-center justify-between rounded-lg bg-gray-800/70 p-2 text-sm" data-testid="c2b-taken">
        <span className="text-white">✓ {money(taken.amount)}{taken.first_name ? ` — ${taken.first_name}` : ''} — <span className="font-mono">{taken.trans_id}</span></span>
        <button onClick={takeOff} className="text-xs text-action-400">Take off</button>
      </div>
    );
  }
  return (
    <div className="space-y-1.5 rounded-lg bg-gray-800/70 p-2" data-testid="c2b-panel">
      <p className="text-xs font-semibold text-gray-200">Payments received</p>
      {payments.length === 0 && <p className="text-xs text-gray-400">No payment of {money(toPay)} yet — it shows here as it arrives.</p>}
      {payments.map((p) => (
        <button key={p.trans_id} onClick={() => void tap(p)} disabled={busy !== null} data-testid="c2b-payment"
          className="w-full flex items-center justify-between gap-2 rounded-lg px-3 py-1.5 text-left text-sm border border-action-500 bg-gray-800 disabled:opacity-40">
          <span className="text-white font-semibold">{money(p.amount)}</span>
          <span className="flex-1 truncate text-gray-300">{p.first_name ?? ''}</span>
          <span className="text-gray-400 text-xs">{paidAtLabel(p.paid_at)}</span>
          <span className="font-mono text-xs text-gray-300">{busy === p.trans_id ? 'Taking…' : p.trans_id}</span>
        </button>
      ))}
      {error && <p className="text-xs text-red-400" data-testid="c2b-error">{error}</p>}
    </div>
  );
}
