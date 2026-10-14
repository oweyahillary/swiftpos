/**
 * OrderDetailPanel — A444: what is inside a past order, with Reprint and Void / Refund in the same place.
 *
 * Owner, 2026-10-11: "manager should be able to do a receipt reprint … void / refund an order … view items inside an
 * order". Opened from History (POS screen) and Manager › Orders (this till, or every till at the branch from the cloud).
 * The order comes from `order.detail` — this till's records first, else the cloud's. Reprint is for whoever History lets
 * reprint (a manager); Void / Refund for whoever may reverse a sale (`orders.void`), through the same VoidModal and
 * rules (the void window, the manager's PIN) as History.
 */
import { useEffect, useState } from 'react';
import { posApi } from '../lib/posApi';
import type { OrderDetail } from '../../shared/orderDetail';
import { reverseAction, VOID_WINDOW_MIN } from '../lib/voidRefund';
import VoidModal from './VoidModal';
import MethodDot from './MethodDot';

interface Props {
  orderId: string;
  currency: string;
  /** May this person void or refund (orders.void)? */
  canVoidRefund: boolean;
  windowMin?: number;
  onClose: () => void;
  /** A void or refund went through — the list behind reloads. */
  onChanged?: () => void;
}

const money = (currency: string, v: number) =>
  `${currency} ${Number(v).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function OrderDetailPanel({ orderId, currency, canVoidRefund, windowMin = VOID_WINDOW_MIN, onClose, onChanged }: Props) {
  const [detail, setDetail] = useState<OrderDetail | null>(null);
  const [canReprint, setCanReprint] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [printing, setPrinting] = useState(false);
  const [reversing, setReversing] = useState(false);

  const load = () => {
    setError('');
    posApi.order.detail(orderId)
      .then((r) => {
        if (!r.ok || !r.detail) { setError(r.error ?? 'Could not read this order.'); return; }
        setDetail(r.detail); setCanReprint(!!r.canReprint);
      })
      .catch((e) => setError(e?.message ?? 'Could not read this order.'));
  };
  useEffect(load, [orderId]);

  const reprint = async () => {
    if (!detail) return;
    setPrinting(true); setNote('');
    try {
      const r = await posApi.escpos.reprintReceiptForOrder(detail.id);
      setNote(r.ok ? `Receipt ${detail.order_number} sent to the printer (marked duplicate).` : (r.error ?? 'Could not reprint.'));
    } finally { setPrinting(false); }
  };

  const reverse = detail && canVoidRefund ? reverseAction(detail, Date.now(), windowMin) : null;
  const paid = detail ? detail.total + detail.tip_amount + (detail.delivery_free ? 0 : detail.delivery_fee) : 0;

  return (
    <>
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 animate-fade-in" onClick={onClose}>
      <div data-testid="order-detail" onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg max-h-[90vh] flex flex-col bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl animate-pop-in">
        <div className="flex items-start justify-between gap-3 px-5 pt-5 pb-3 border-b border-gray-800">
          <div className="min-w-0">
            <h2 className="text-white font-semibold text-lg font-mono">#{detail?.order_number ?? '…'}</h2>
            {detail && (
              <p className="text-xs text-gray-400 mt-0.5">
                {new Date(detail.created_at).toLocaleString('en-KE', { dateStyle: 'medium', timeStyle: 'short' })}
                {detail.cashier_name ? ` · ${detail.cashier_name}` : ''}
                {` · ${detail.order_type.replace(/_/g, ' ')}`}
                {detail.table_number ? ` · Table ${detail.table_number}` : ''}
                {detail.delivery_person ? ` · ${detail.delivery_person}` : ''}
              </p>
            )}
          </div>
          <button onClick={onClose} aria-label="Close" className="text-gray-400 hover:text-white text-xl leading-none px-1">×</button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4 text-sm">
          {error && <p className="text-red-300 bg-red-950/50 border border-red-800 rounded-lg px-3 py-2">{error}</p>}
          {!detail && !error && <p className="text-gray-400">Loading…</p>}
          {detail && (
            <>
              <div className="flex flex-wrap gap-1.5">
                <span data-testid="order-detail-status" className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                  detail.status === 'voided' ? 'bg-red-500/15 text-red-300' : 'bg-gray-700 text-gray-200'}`}>{detail.status}</span>
                {detail.refunded_amount > 0 && (
                  <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-amber-500/15 text-amber-300">
                    refunded {money(currency, detail.refunded_amount)}
                  </span>
                )}
                {detail.source === 'cloud' && <span className="text-xs px-2 py-0.5 rounded-full bg-blue-500/15 text-blue-300">from the cloud</span>}
              </div>

              <ul data-testid="order-detail-items" className="divide-y divide-gray-800 border border-gray-800 rounded-xl">
                {detail.items.length === 0 && <li className="px-3 py-3 text-gray-400">No items recorded on this order.</li>}
                {detail.items.map((l, i) => (
                  <li key={i} className="px-3 py-2.5 flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-white"><span className="tabular-nums text-gray-300">{l.quantity} ×</span> {l.name}</p>
                      {l.options.length > 0 && <p className="text-xs text-gray-400 mt-0.5">{l.options.join(' · ')}</p>}
                      {l.notes && <p className="text-xs text-amber-300/90 mt-0.5">Note: {l.notes}</p>}
                    </div>
                    <span className="tabular-nums text-gray-200 whitespace-nowrap">{money(currency, l.subtotal)}</span>
                  </li>
                ))}
              </ul>
              {detail.notes && <p className="text-xs text-amber-300/90">Order note: {detail.notes}</p>}

              <dl className="space-y-1 text-gray-300">
                {detail.offers.map((o, i) => <Row key={i} k={`Offer: ${o.name}`} v={`− ${money(currency, o.amount)}`} />)}
                {detail.discount_amount - detail.offers.reduce((t, o) => t + o.amount, 0) > 0.005 &&
                  <Row k="Discount" v={`− ${money(currency, detail.discount_amount - detail.offers.reduce((t, o) => t + o.amount, 0))}`} />}
                {detail.vat_amount > 0 && <Row k="VAT (included)" v={money(currency, detail.vat_amount)} />}
                {detail.ctl_amount > 0 && <Row k="Catering levy (included)" v={money(currency, detail.ctl_amount)} />}
                <Row k="Bill" v={money(currency, detail.total)} strong />
                {detail.tip_amount > 0 && <Row k="Tip" v={money(currency, detail.tip_amount)} />}
                {detail.delivery_fee > 0 && <Row k={detail.delivery_free ? 'Delivery (free — the shop pays)' : 'Delivery'} v={money(currency, detail.delivery_fee)} />}
                {paid !== detail.total && <Row k="Paid" v={money(currency, paid)} strong />}
              </dl>

              {detail.payments.length > 0 && (
                <div>
                  <p className="text-xs uppercase tracking-wide text-gray-500 mb-1">Payments</p>
                  <ul data-testid="order-detail-payments" className="space-y-1">
                    {detail.payments.map((p, i) => (
                      <li key={i} className="flex items-center justify-between text-gray-300">
                        <span className="capitalize"><MethodDot method={p.method} />{p.method.replace(/_/g, ' ')}
                          {p.reference ? <span className="text-xs text-gray-500"> · {p.reference}</span> : null}
                          {p.amount < 0 ? <span className="text-xs text-amber-300"> · refund</span> : null}</span>
                        <span className="tabular-nums">{money(currency, p.amount)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {detail.void_reason && <p className="text-xs text-red-300">Voided{detail.voided_by_name ? ` by ${detail.voided_by_name}` : ''}: {detail.void_reason}</p>}
              {detail.refund_reason && <p className="text-xs text-amber-300">Refund reason: {detail.refund_reason}</p>}
            </>
          )}
        </div>

        {detail && (canReprint || reverse) && (
          <div className="px-5 py-3 border-t border-gray-800 space-y-2">
            {note && <p data-testid="order-detail-note" className="text-xs text-gray-300">{note}</p>}
            <div className="flex gap-2 justify-end">
              {canReprint && detail.status === 'completed' && (
                <button data-testid="order-detail-reprint" onClick={reprint} disabled={printing}
                  className="px-3 py-2 rounded-lg border border-gray-600 text-gray-200 hover:border-gray-400 hover:text-white text-sm disabled:opacity-50">
                  {printing ? 'Printing…' : 'Reprint receipt'}
                </button>
              )}
              {reverse && (
                <button data-testid="order-detail-reverse" onClick={() => setReversing(true)}
                  className="px-3 py-2 rounded-lg border border-red-500/40 text-red-300 hover:border-red-400 hover:text-red-200 text-sm">
                  {reverse.label}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>

      {reversing && detail && (
        <VoidModal
          order={{ id: detail.id, order_number: detail.order_number, total: detail.total, created_at: detail.created_at,
                   payments: detail.payments.map((p) => ({ method: p.method, amount: p.amount })) }}
          currency={currency}
          windowMin={windowMin}
          onSuccess={() => { setReversing(false); load(); onChanged?.(); }}
          onClose={() => setReversing(false)}
        />
      )}
    </>
  );
}

function Row({ k, v, strong = false }: { k: string; v: string; strong?: boolean }) {
  return (
    <div className={`flex justify-between ${strong ? 'text-white font-semibold' : ''}`}>
      <dt>{k}</dt><dd className="tabular-nums">{v}</dd>
    </div>
  );
}
