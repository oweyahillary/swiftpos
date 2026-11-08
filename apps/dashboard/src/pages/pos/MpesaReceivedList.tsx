/**
 * MpesaReceivedList.tsx — A621: "Payments received" on the WEB POS's payment screen, under M-Pesa.
 *
 * Owner, 2026-11-02: "Some customers do not like giving out their number, they prefer paying to the till or paybill
 * directly; what the cashier gets is a notification of the payments done, then they match it to the bill." The branch's
 * payments of the last 30 minutes nobody has taken (GET /api/payments/c2b/recent) that pay this bill exactly (owner,
 * 2026-11-03: "show payments that match the bill only"); the cashier taps the customer's and the sale completes. Nothing
 * shows when the cloud says the list is not offered (no online licence, or notifications not switched on for the branch).
 * The web POS has no push channel: the list asks every few seconds while it is shown, sending back the cloud's stamp so an
 * unchanged list costs the cloud no database read.
 */
import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { RECEIVED_POLL_MS, paidAtLabel, paymentsForBill, receivedNotice, type ReceivedPayment } from '@zaptill/core/mpesaPayments';

interface RecentAnswer { offered: boolean; payments?: ReceivedPayment[]; unchanged?: boolean; stamp?: number }

interface Props {
  toPay: number;
  currency: string;
  /** The bill's own number (a table number) — a Paybill payment naming it is listed first. */
  billRef?: string | null;
  take: (p: ReceivedPayment) => Promise<{ payment: ReceivedPayment } | { error: string }>;
  /** The tapped payment pays the bill: the payment screen completes the sale with it. */
  onTaken: (p: ReceivedPayment) => void;
  disabled?: boolean;
}

function recentPath(toPay: number, billRef: string | null | undefined, stamp: number | null): string {
  const q = new URLSearchParams({ amount: String(toPay) });
  if (billRef) q.set('ref', billRef);
  if (stamp !== null) q.set('since', String(stamp));
  return `/api/payments/c2b/recent?${q.toString()}`;
}

export default function MpesaReceivedList({ toPay, currency, billRef, take, onTaken, disabled = false }: Props) {
  const [offered, setOffered] = useState(false);
  const [payments, setPayments] = useState<ReceivedPayment[]>([]);
  const [newest, setNewest] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const stamp = useRef<number | null>(null);
  const seen = useRef<Set<string> | null>(null);

  useEffect(() => {
    let live = true;
    stamp.current = null;   // another amount: the cloud sorts again
    // The notice "KES 1,080 received — JOHN — …" for a payment that arrived while this screen is open.
    const noteArrivals = (list: ReceivedPayment[]) => {
      const before = seen.current;
      const fresh = before ? list.find((p) => !before.has(p.trans_id)) : undefined;
      if (fresh) setNewest(receivedNotice(fresh, currency));
      seen.current = new Set(list.map((p) => p.trans_id));
    };
    const load = async () => {
      try {
        const r = await api.get<RecentAnswer>(recentPath(toPay, billRef, stamp.current));
        if (!live || r.unchanged) return;
        stamp.current = typeof r.stamp === 'number' ? r.stamp : null;
        const list = r.offered ? paymentsForBill(r.payments ?? [], toPay) : [];
        setOffered(r.offered === true);
        setPayments(list);
        noteArrivals(list);
      } catch { /* a dropped ask: the next one */ }
    };
    void load();
    const timer = setInterval(() => { void load(); }, RECEIVED_POLL_MS);
    return () => { live = false; clearInterval(timer); };
  }, [toPay, billRef, currency]);

  if (!offered) return null;
  const money = (n: number) => `${currency} ${n.toLocaleString('en-KE', { maximumFractionDigits: 2 })}`;

  const tap = async (p: ReceivedPayment) => {
    setError(''); setBusy(p.trans_id);
    const r = await take(p);
    setBusy(null);
    stamp.current = null;
    if ('payment' in r) { onTaken(r.payment); return; }
    setError(r.error);
    setPayments((list) => list.filter((x) => x.trans_id !== p.trans_id));
  };

  return (
    <div className="bg-gray-800/60 rounded-xl p-3 space-y-1.5 text-left" data-testid="c2b-panel">
      <p className="text-sm font-semibold text-gray-200">Payments received</p>
      {newest && <p className="text-xs text-action-400" data-testid="c2b-notice">📱 {newest}</p>}
      {payments.length === 0 && <p className="text-xs text-gray-400">No payment of {money(toPay)} yet — it shows here as it arrives.</p>}
      {payments.map((p) => (
        <button key={p.trans_id} type="button" onClick={() => void tap(p)} disabled={disabled || busy !== null} data-testid="c2b-payment"
          className="w-full flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-sm border border-action-500 bg-gray-900 disabled:opacity-40">
          <span className="text-white font-semibold">{money(p.amount)}</span>
          <span className="flex-1 truncate text-gray-300 text-left">{p.first_name ?? ''}</span>
          <span className="text-gray-500 text-xs">{paidAtLabel(p.paid_at)}</span>
          <span className="font-mono text-xs text-gray-300">{busy === p.trans_id ? 'Taking…' : p.trans_id}</span>
        </button>
      ))}
      {error && <p className="text-xs text-red-400" data-testid="c2b-error">{error}</p>}
    </div>
  );
}
