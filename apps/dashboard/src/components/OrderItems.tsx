/**
 * OrderItems — A444: the items inside a past order (sizes, extras, notes), read from the cloud when the row is opened.
 *
 * Owner, 2026-10-11: "the manager should be able to view items inside an order". The owner's Orders page and the web
 * POS / manager dashboard order history showed only the bill and payments; GET /api/orders/:id already returns the lines.
 * The fetcher is the page's own client (the back office's `api`, the web POS's `posApi`), so each signs in as itself.
 */
import { useEffect, useState } from 'react';
import { detailFromCloud, type OrderDetail } from '@zaptill/core/orderDetail';
import { money } from '../lib/format';

interface Props {
  orderId: string;
  currency: string;
  get: <T>(path: string) => Promise<T>;
}


export default function OrderItems({ orderId, currency, get }: Props) {
  const [detail, setDetail] = useState<OrderDetail | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    setDetail(null); setError('');
    get<unknown>(`/api/orders/${orderId}`)
      .then((o) => { if (live) setDetail(detailFromCloud(o)); })
      .catch((e: any) => { if (live) setError(e?.message ?? 'Could not load the items.'); });
    return () => { live = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the client is the page's own; a new arrow each render must not refetch
  }, [orderId]);

  if (error) return <p className="text-xs text-red-300">{error}</p>;
  if (!detail) return <p className="text-xs text-gray-400">Loading items…</p>;
  return (
    <div data-testid="order-items" className="text-xs">
      {(detail.cashier_name || detail.table_number) && (
        <p className="text-gray-400 mb-1">
          {detail.cashier_name ? `Sold by ${detail.cashier_name}` : ''}
          {detail.table_number ? `${detail.cashier_name ? ' · ' : ''}Table ${detail.table_number}` : ''}
        </p>
      )}
      <ul className="divide-y divide-gray-800 border border-gray-800 rounded-lg">
        {detail.items.length === 0 && <li className="px-3 py-2 text-gray-400">No items recorded on this order.</li>}
        {detail.items.map((l, i) => (
          <li key={i} className="px-3 py-1.5 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <span className="text-gray-100"><span className="tabular-nums text-gray-400">{l.quantity} ×</span> {l.name}</span>
              {l.options.length > 0 && <div className="text-gray-400">{l.options.join(' · ')}</div>}
              {l.notes && <div className="text-amber-300/90">Note: {l.notes}</div>}
            </div>
            <span className="tabular-nums text-gray-200 whitespace-nowrap">{money(l.subtotal, currency)}</span>
          </li>
        ))}
      </ul>
      {detail.notes && <p className="text-amber-300/90 mt-1">Order note: {detail.notes}</p>}
      {detail.void_reason && <p className="text-red-300 mt-1">Voided{detail.voided_by_name ? ` by ${detail.voided_by_name}` : ''}: {detail.void_reason}</p>}
      {detail.refund_reason && <p className="text-amber-300 mt-1">Refund reason: {detail.refund_reason}</p>}
    </div>
  );
}
