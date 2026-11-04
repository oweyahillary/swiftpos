/**
 * MpesaArrivedNotice.tsx — A621: "KES 1,080 received — JOHN — QJK7XT3L5P" on the POS when a customer pays the branch's
 * Till number or Paybill. The cloud rings this POS (main/ipc/mpesaC2b.ts — the online licence only); the notice stays a
 * few seconds and the cashier taps the payment on the payment screen. A POS behind a branch server hears no ring: it sees
 * the payment in the payment screen's list instead.
 */
import { useEffect, useState } from 'react';
import { posApi } from '../lib/posApi';
import { receivedNotice } from '../../shared/mpesaPayments';

const SHOW_MS = 10_000;
const MAX_SHOWN = 3;

export default function MpesaArrivedNotice({ currency }: { currency: string }) {
  const [notices, setNotices] = useState<Array<{ id: string; text: string }>>([]);

  useEffect(() => posApi.mpesa.onReceivedArrived((p) => {
    const notice = { id: p.trans_id, text: receivedNotice(p, currency) };
    setNotices((list) => [notice, ...list.filter((n) => n.id !== notice.id)].slice(0, MAX_SHOWN));
    setTimeout(() => setNotices((list) => list.filter((n) => n.id !== notice.id)), SHOW_MS);
  }), [currency]);

  if (!notices.length) return null;
  return (
    <div className="fixed top-3 right-3 z-40 space-y-2" data-testid="c2b-notices">
      {notices.map((n) => (
        <div key={n.id} className="rounded-lg border border-action-500/60 bg-gray-900 px-3 py-2 text-sm font-semibold text-white shadow-lg">
          📱 {n.text}
        </div>
      ))}
    </div>
  );
}
