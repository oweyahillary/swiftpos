/**
 * POSOrderHistoryTab
 * Paginated, searchable order list scoped to the cashier's branch.
 * Tap an order to expand its line items and payment detail.
 * Permission required: orders.view_all
 */

import MethodDot from '../../components/MethodDot';
import { useState, useEffect, useCallback } from 'react';
import { usePOSAuth } from '../../context/POSAuthContext';
import { reprintOrderReceipt } from '../../lib/reprintReceipt';
import { canRefundOrder, isRefunded, REFUND_REASONS } from '../orderRefund';
import { historyView, orderMethod, type HistorySort } from '../../lib/historyView';
import { orderTypeLabel } from '../../lib/delivery';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Payment { method: string; amount: number; status: string; }
interface Order {
  id: string;
  order_number: string;
  order_type: string;
  status: string;
  subtotal: number;
  total: number;
  discount_amount: number;
  customer_name: string | null;
  created_at: string;
  payments: Payment[];
  delivery_person?: string | null;   // 0.6.27
  delivery_fee?: number | null;      // 0.6.27
  tip_amount?: number | null;        // 0.6.29
}
/** 0.6.27: own_only — the cloud narrowed the list to this cashier's sales; can_reprint — Reprint is offered. */
interface OrdersResponse { orders: Order[]; total: number; own_only?: boolean; can_reprint?: boolean; }

// 0.6.27: the types a filter offers (the cloud filters; the list is paged).
const TYPE_CHOICES = ['dine_in', 'takeaway', 'delivery', 'retail'];
const METHOD_CHOICES = ['cash', 'mpesa', 'card'];

// ── Helpers ───────────────────────────────────────────────────────────────────

const fmt = (n: number, currency: string) =>
  `${currency} ${Number(n).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const fmtTime = (iso: string) =>
  new Date(iso).toLocaleString('en-KE', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

const METHOD_ICON: Record<string, string> = { cash: '💵', mpesa: '📱', card: '💳' };
const STATUS_COLOR: Record<string, string> = {
  completed: '#22c55e', voided: '#ef4444', pending: '#f59e0b',
};

const PAGE_SIZE = 20;
/** 0.6.29: what the customer paid — the bill, any tip and any delivery fee (the payments add up to this). */
const paidOf = (o: { total: number; tip_amount?: number | null; delivery_fee?: number | null }) =>
  Number(o.total) + Number(o.tip_amount ?? 0) + Number(o.delivery_fee ?? 0);

// ── Component ─────────────────────────────────────────────────────────────────

export default function POSOrderHistoryTab({ currency }: { currency: string }) {
  const { posApi, session, hasPermission } = usePOSAuth();
  // A359: refund from this list (web POS → Orders, manager dashboard → Orders) — orders.void holders only; the cloud
  // asks a manager's (or the owner's) own PIN and records who approved (A355).
  const mayVoid = hasPermission('orders.void');
  const [refunding, setRefunding]     = useState<string | null>(null);   // order id with the refund form open
  const [refundReason, setRefundReason] = useState('');
  const [refundOther, setRefundOther] = useState('');
  const [refundPin, setRefundPin]     = useState('');
  const [refundBusy, setRefundBusy]   = useState(false);
  const [refundMsg, setRefundMsg]     = useState<{ id: string; text: string; ok: boolean } | null>(null);

  const submitRefund = async (order: Order) => {
    const reason = (refundReason === 'Other' ? refundOther : refundReason).trim();
    if (!reason) { setRefundMsg({ id: order.id, text: 'A reason is required.', ok: false }); return; }
    if (!refundPin.trim()) { setRefundMsg({ id: order.id, text: 'A manager PIN is required to refund.', ok: false }); return; }
    setRefundBusy(true); setRefundMsg(null);
    try {
      await posApi.post(`/api/orders/${order.id}/refund`, { reason, override_pin: refundPin.trim() });
      setRefunding(null); setRefundReason(''); setRefundOther(''); setRefundPin('');
      setRefundMsg({ id: order.id, text: `Refunded ${fmt(order.total, currency)} — hand it back in the tender it came in.`, ok: true });
      await load(page);
    } catch (e: any) {
      // The cloud's own words (a wrong PIN, a missing permission, already refunded).
      setRefundMsg({ id: order.id, text: e?.message ?? 'Refund failed', ok: false });
      setRefundPin('');
    } finally { setRefundBusy(false); }
  };

  const [orders, setOrders]       = useState<Order[]>([]);
  const [total, setTotal]         = useState(0);
  const [page, setPage]           = useState(1);
  const [search, setSearch]       = useState('');
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState('');
  const [expanded, setExpanded]   = useState<string | null>(null);
  const [reprintingId, setReprintingId] = useState<string | null>(null);
  const [reprintMsg, setReprintMsg] = useState<{ id: string; text: string } | null>(null);
  // 0.6.27: filters (sent to the cloud), the order of the page, and what the cloud allows this person.
  const [typeFilter, setTypeFilter]     = useState('');
  const [methodFilter, setMethodFilter] = useState('');
  const [sortBy, setSortBy]             = useState<HistorySort>('time');
  const [ownOnly, setOwnOnly]           = useState(false);
  const [canReprint, setCanReprint]     = useState(true);

  const load = useCallback(async (p = 1, q = search, t = typeFilter, m = methodFilter) => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String((p - 1) * PAGE_SIZE),
      });
      // 0.6.29 (owner): "it should show everything of the days sales" — today's (from local midnight), page by page.
      const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
      params.set('date_from', midnight.toISOString());
      if (q) params.set('search', q);
      if (t) params.set('order_type', t);
      if (m) params.set('method', m);
      if (session?.branchId) params.set('branch_id', session.branchId);

      const res = await posApi.get<OrdersResponse>(`/api/orders?${params}`);
      setOrders(res.orders ?? []);
      setTotal(res.total ?? 0);
      setOwnOnly(res.own_only === true);
      setCanReprint(res.can_reprint !== false);
      setPage(p);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load orders');
    } finally {
      setLoading(false);
    }
  }, [posApi, session, search, typeFilter, methodFilter]);

  useEffect(() => { load(1); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    load(1, search);
  };

  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <div style={s.root}>
      {/* Search */}
      <form style={s.searchRow} onSubmit={handleSearch}>
        <input
          style={s.searchInput}
          placeholder="Order # …"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <button style={s.searchBtn} type="submit">Search</button>
      </form>

      {/* 0.6.27: narrow by type or payment (the cloud filters), order this page by time, payment or type. */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginBottom: 8, fontSize: 12 }} data-testid="history-filters">
        <select style={s.searchInput} value={typeFilter} data-testid="history-type"
          onChange={e => { setTypeFilter(e.target.value); void load(1, search, e.target.value, methodFilter); }}>
          <option value="">All types</option>
          {TYPE_CHOICES.map(t => <option key={t} value={t}>{orderTypeLabel(t)}</option>)}
        </select>
        <select style={s.searchInput} value={methodFilter} data-testid="history-method"
          onChange={e => { setMethodFilter(e.target.value); void load(1, search, typeFilter, e.target.value); }}>
          <option value="">All payments</option>
          {METHOD_CHOICES.map(m => <option key={m} value={m}>{m}</option>)}
        </select>
        <select style={s.searchInput} value={sortBy} data-testid="history-sort" onChange={e => setSortBy(e.target.value as HistorySort)}>
          <option value="time">Order by time</option>
          <option value="method">Order by payment</option>
          <option value="type">Order by type</option>
        </select>
        {ownOnly && <span style={{ color: '#94a3b8' }}>Your sales only</span>}
      </div>

      {error && <p style={s.error}>{error}</p>}

      {loading && <div style={s.center}><span style={s.spinner} /></div>}

      {!loading && orders.length === 0 && (
        <p style={s.empty}>No orders found.</p>
      )}

      {/* Order list */}
      <div style={s.list}>
        {historyView(orders, { sort: sortBy }).map(order => {
          const isOpen = expanded === order.id;
          const method = orderMethod(order);
          return (
            <div key={order.id} style={s.card}>
              {/* Row */}
              <button style={s.cardHeader} onClick={() => setExpanded(isOpen ? null : order.id)}>
                <div style={s.cardLeft}>
                  <span style={s.orderNum}>#{order.order_number}</span>
                  <span style={s.orderMeta}>
                    {fmtTime(order.created_at)}
                    {` · ${orderTypeLabel(order.order_type, order.delivery_person)}`}
                    {order.customer_name ? ` · ${order.customer_name}` : ''}
                  </span>
                </div>
                <div style={s.cardRight}>
                  <span style={s.methodBadge}><MethodDot method={method} />{METHOD_ICON[method] ?? '💰'} {method}</span>
                  <span style={{ ...s.statusDot, color: STATUS_COLOR[order.status] ?? '#94a3b8' }}>
                    ●
                  </span>
                  {isRefunded(order.payments) && <span style={s.refundedBadge}>refunded</span>}
                  {/* 0.6.29 (owner, D2): what the customer PAID — the bill + tip + delivery fee (the fee was hidden). */}
                  <span style={s.total} data-testid="history-paid">{fmt(paidOf(order), currency)}{Number(order.delivery_fee ?? 0) > 0 ? ` (incl. delivery ${fmt(Number(order.delivery_fee), currency)})` : ''}</span>
                  <span style={s.chevron}>{isOpen ? '▲' : '▼'}</span>
                </div>
              </button>

              {/* Expanded detail */}
              {isOpen && (
                <div style={s.detail}>
                  <div style={s.detailRow}>
                    <span style={s.detailLabel}>Type</span>
                    <span style={s.detailVal}>{orderTypeLabel(order.order_type, order.delivery_person)}</span>
                  </div>
                  <div style={s.detailRow}>
                    <span style={s.detailLabel}>Subtotal</span>
                    <span style={s.detailVal}>{fmt(order.subtotal, currency)}</span>
                  </div>
                  {Number(order.discount_amount) > 0 && (
                    <div style={s.detailRow}>
                      <span style={s.detailLabel}>Discount</span>
                      <span style={{ ...s.detailVal, color: '#f59e0b' }}>−{fmt(order.discount_amount, currency)}</span>
                    </div>
                  )}
                  <div style={{ ...s.detailRow, borderTop: '1px solid #1e293b', paddingTop: 6, marginTop: 4 }}>
                    <span style={{ ...s.detailLabel, fontWeight: 700, color: '#f1f5f9' }}>Total</span>
                    <span style={{ ...s.detailVal, fontWeight: 700, color: '#22c55e' }}>{fmt(order.total, currency)}</span>
                  </div>
                  {order.payments.map((p, i) => (
                    <div key={i} style={{ ...s.detailRow, marginTop: 2 }}>
                      <span style={s.detailLabel}><MethodDot method={p.method} />{METHOD_ICON[p.method] ?? '💰'} {p.method}</span>
                      <span style={s.detailVal}>{fmt(p.amount, currency)}</span>
                    </div>
                  ))}
                  {canReprint && <button
                    onClick={async (e) => {
                      e.stopPropagation();
                      setReprintingId(order.id); setReprintMsg(null);
                      const res = await reprintOrderReceipt(order.id);
                      setReprintMsg({ id: order.id, text: res.message }); setReprintingId(null);
                    }}
                    disabled={reprintingId === order.id}
                    style={{ marginTop: 10, padding: '6px 12px', fontSize: 12, fontWeight: 600,
                      borderRadius: 8, border: '1px solid rgb(var(--act-fill, 59 130 246) / 0.4)', color: 'rgb(var(--act-text, 96 165 250))',
                      background: 'transparent', cursor: 'pointer', opacity: reprintingId === order.id ? 0.5 : 1 }}
                  >{reprintingId === order.id ? 'Printing…' : 'Reprint receipt'}</button>}
                  {reprintMsg?.id === order.id && (
                    <div style={{ marginTop: 6, fontSize: 11, color: '#94a3b8' }}>{reprintMsg.text}</div>
                  )}
                  {/* A359: Refund (orders.void; completed, not refunded). */}
                  {canRefundOrder(order, mayVoid) && refunding !== order.id && (
                    <button
                      onClick={(e) => { e.stopPropagation(); setRefunding(order.id); setRefundReason(''); setRefundOther(''); setRefundPin(''); setRefundMsg(null); }}
                      style={s.refundBtn}
                    >Refund</button>
                  )}
                  {refunding === order.id && (
                    <div style={s.refundForm} onClick={e => e.stopPropagation()}>
                      <div style={{ fontSize: 12, color: '#cbd5e1', marginBottom: 6 }}>
                        Refund {fmt(order.total, currency)} — the sale stays on the books; only the money goes back.
                      </div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
                        {REFUND_REASONS.map(r => (
                          <button key={r} type="button" onClick={() => setRefundReason(r)}
                            style={{ ...s.reasonBtn, ...(refundReason === r ? s.reasonOn : {}) }}>{r}</button>
                        ))}
                      </div>
                      {refundReason === 'Other' && (
                        <input style={{ ...s.searchInput, width: '100%', marginBottom: 6 }} placeholder="Reason"
                          value={refundOther} onChange={e => setRefundOther(e.target.value)} />
                      )}
                      <input type="password" inputMode="numeric" maxLength={6} placeholder="Manager or owner PIN"
                        style={{ ...s.searchInput, width: '100%', marginBottom: 6, letterSpacing: 4 }}
                        value={refundPin} onChange={e => setRefundPin(e.target.value.replace(/\D/g, '').slice(0, 6))} />
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button type="button" disabled={refundBusy} onClick={() => void submitRefund(order)}
                          style={{ ...s.refundBtn, marginTop: 0, opacity: refundBusy ? 0.5 : 1 }}>
                          {refundBusy ? 'Refunding…' : `Refund ${fmt(order.total, currency)}`}
                        </button>
                        <button type="button" disabled={refundBusy} onClick={() => setRefunding(null)} style={s.searchBtn}>Cancel</button>
                      </div>
                    </div>
                  )}
                  {refundMsg?.id === order.id && (
                    <div style={{ marginTop: 6, fontSize: 12, color: refundMsg.ok ? '#94a3b8' : '#fca5a5' }}>{refundMsg.text}</div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div style={s.pagination}>
          <button
            style={{ ...s.pageBtn, opacity: page === 1 ? 0.4 : 1 }}
            disabled={page === 1}
            onClick={() => load(page - 1)}
          >← Prev</button>
          <span style={s.pageInfo}>{page} / {totalPages}</span>
          <button
            style={{ ...s.pageBtn, opacity: page >= totalPages ? 0.4 : 1 }}
            disabled={page >= totalPages}
            onClick={() => load(page + 1)}
          >Next →</button>
        </div>
      )}
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  root:        { paddingBottom: 24 },
  searchRow:   { display: 'flex', gap: 8, marginBottom: 12 },
  searchInput: {
    flex: 1, padding: '8px 12px', background: '#0f172a', border: '1px solid #334155',
    borderRadius: 7, color: '#f1f5f9', fontSize: 13, outline: 'none',
  },
  searchBtn: {
    padding: '8px 16px', background: '#334155', border: 'none', borderRadius: 7,
    color: '#94a3b8', fontWeight: 600, fontSize: 13, cursor: 'pointer',
  },
  error:   { color: '#fca5a5', fontSize: 13, margin: '8px 0' },
  center:  { display: 'flex', justifyContent: 'center', padding: 24 },
  spinner: {
    display: 'inline-block', width: 22, height: 22,
    border: '2px solid #334155', borderTop: '2px solid rgb(var(--act-fill, 59 130 246))', borderRadius: '50%',
    animation: 'spin 0.8s linear infinite',
  },
  empty:   { color: '#475569', fontSize: 13, textAlign: 'center', padding: '24px 0' },
  list:    { display: 'flex', flexDirection: 'column', gap: 6 },
  card:    { background: '#0f172a', border: '1px solid #1e293b', borderRadius: 8, overflow: 'hidden' },
  cardHeader: {
    width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '10px 12px', background: 'transparent', border: 'none', cursor: 'pointer',
    textAlign: 'left' as const, gap: 8,
  },
  cardLeft:   { display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 },
  orderNum:   { fontSize: 13, fontWeight: 700, color: '#f1f5f9' },
  orderMeta:  { fontSize: 11, color: '#475569', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  cardRight:  { display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 },
  methodBadge:{ fontSize: 11, color: '#64748b' },
  statusDot:  { fontSize: 10 },
  total:      { fontSize: 13, fontWeight: 700, color: '#f1f5f9' },
  chevron:    { fontSize: 10, color: '#475569' },
  detail:     { padding: '0 12px 10px', borderTop: '1px solid #1e293b' },
  detailRow:  { display: 'flex', justifyContent: 'space-between', padding: '4px 0' },
  detailLabel:{ fontSize: 12, color: '#64748b' },
  detailVal:  { fontSize: 12, color: '#94a3b8' },
  pagination: { display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 16, paddingTop: 12 },
  pageBtn:    {
    padding: '6px 14px', background: '#1e293b', border: '1px solid #334155',
    borderRadius: 7, color: '#94a3b8', fontSize: 12, cursor: 'pointer',
  },
  pageInfo:   { fontSize: 12, color: '#475569' },
  // A359
  refundedBadge: { fontSize: 10, fontWeight: 700, color: '#f59e0b', border: '1px solid rgba(245,158,11,0.4)', borderRadius: 999, padding: '1px 6px' },
  refundBtn:  { marginTop: 10, marginLeft: 6, padding: '6px 12px', fontSize: 12, fontWeight: 600, borderRadius: 8,
                border: '1px solid rgba(239,68,68,0.45)', color: '#f87171', background: 'transparent', cursor: 'pointer' },
  refundForm: { marginTop: 10, padding: 10, border: '1px solid #334155', borderRadius: 8, background: '#0b1220' },
  reasonBtn:  { padding: '4px 8px', fontSize: 11, borderRadius: 6, border: '1px solid #334155', background: 'transparent', color: '#cbd5e1', cursor: 'pointer' },
  reasonOn:   { borderColor: 'rgba(245,158,11,0.6)', color: '#fbbf24', background: 'rgba(245,158,11,0.1)' },
};
