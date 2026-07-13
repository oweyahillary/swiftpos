/**
 * POSOrderHistoryTab
 * Paginated, searchable order list scoped to the cashier's branch.
 * Tap an order to expand its line items and payment detail.
 * Permission required: orders.view_all
 */

import { useState, useEffect, useCallback } from 'react';
import { usePOSAuth } from '../../context/POSAuthContext';

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
}
interface OrdersResponse { orders: Order[]; total: number; }

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

// ── Component ─────────────────────────────────────────────────────────────────

export default function POSOrderHistoryTab({ currency }: { currency: string }) {
  const { posApi, session } = usePOSAuth();

  const [orders, setOrders]       = useState<Order[]>([]);
  const [total, setTotal]         = useState(0);
  const [page, setPage]           = useState(1);
  const [search, setSearch]       = useState('');
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState('');
  const [expanded, setExpanded]   = useState<string | null>(null);

  const load = useCallback(async (p = 1, q = search) => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String((p - 1) * PAGE_SIZE),
      });
      if (q) params.set('search', q);
      if (session?.branchId) params.set('branch_id', session.branchId);

      const res = await posApi.get<OrdersResponse>(`/api/orders?${params}`);
      setOrders(res.orders ?? []);
      setTotal(res.total ?? 0);
      setPage(p);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load orders');
    } finally {
      setLoading(false);
    }
  }, [posApi, session, search]);

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

      {error && <p style={s.error}>{error}</p>}

      {loading && <div style={s.center}><span style={s.spinner} /></div>}

      {!loading && orders.length === 0 && (
        <p style={s.empty}>No orders found.</p>
      )}

      {/* Order list */}
      <div style={s.list}>
        {orders.map(order => {
          const isOpen = expanded === order.id;
          const method = order.payments?.[0]?.method ?? '—';
          return (
            <div key={order.id} style={s.card}>
              {/* Row */}
              <button style={s.cardHeader} onClick={() => setExpanded(isOpen ? null : order.id)}>
                <div style={s.cardLeft}>
                  <span style={s.orderNum}>#{order.order_number}</span>
                  <span style={s.orderMeta}>
                    {fmtTime(order.created_at)}
                    {order.customer_name ? ` · ${order.customer_name}` : ''}
                  </span>
                </div>
                <div style={s.cardRight}>
                  <span style={s.methodBadge}>{METHOD_ICON[method] ?? '💰'} {method}</span>
                  <span style={{ ...s.statusDot, color: STATUS_COLOR[order.status] ?? '#94a3b8' }}>
                    ●
                  </span>
                  <span style={s.total}>{fmt(order.total, currency)}</span>
                  <span style={s.chevron}>{isOpen ? '▲' : '▼'}</span>
                </div>
              </button>

              {/* Expanded detail */}
              {isOpen && (
                <div style={s.detail}>
                  <div style={s.detailRow}>
                    <span style={s.detailLabel}>Type</span>
                    <span style={s.detailVal}>{order.order_type}</span>
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
                      <span style={s.detailLabel}>{METHOD_ICON[p.method] ?? '💰'} {p.method}</span>
                      <span style={s.detailVal}>{fmt(p.amount, currency)}</span>
                    </div>
                  ))}
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
    border: '2px solid #334155', borderTop: '2px solid #3b82f6', borderRadius: '50%',
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
};
