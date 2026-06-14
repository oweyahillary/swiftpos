import { useEffect, useState, useCallback } from 'react';
import { api } from '../../lib/api';
import VoidModal from './VoidModal';

interface Payment { method: string; amount: number; status: string; }
interface OrderItem {
  id: string; product_name: string; category_name: string | null;
  quantity: number; unit_price: number; subtotal: number; notes: string | null;
  order_item_variants: { variant_group_name: string; variant_option_name: string }[];
  order_item_modifiers: { modifier_group_name: string; modifier_option_name: string; price: number }[];
}
interface Order {
  id: string; order_number: string; order_type: string; status: string;
  subtotal: number; vat_amount: number; total: number; created_at: string;
  payments: Payment[];
  order_items?: OrderItem[];
}

interface Props {
  branchId: string | null;
  currency: string;
}

const STATUS_COLORS: Record<string, string> = {
  completed: 'bg-green-500/15 text-green-400',
  voided:    'bg-red-500/15 text-red-400',
  pending:   'bg-yellow-500/15 text-yellow-400',
};

const VOID_WINDOW_MS = 30 * 60 * 1000; // 30 minutes — must match server constant

function getVoidSecondsLeft(createdAt: string): number {
  const elapsed = Date.now() - new Date(createdAt).getTime();
  return Math.max(0, Math.floor((VOID_WINDOW_MS - elapsed) / 1000));
}

function VoidTimer({ createdAt }: { createdAt: string }) {
  const [secs, setSecs] = useState(() => getVoidSecondsLeft(createdAt));

  useEffect(() => {
    if (secs <= 0) return;
    const t = setInterval(() => setSecs(getVoidSecondsLeft(createdAt)), 1000);
    return () => clearInterval(t);
  }, [createdAt]);

  if (secs <= 0) return <span className="text-xs text-gray-600">Void window expired</span>;

  const mins = Math.floor(secs / 60);
  const s = secs % 60;
  const isUrgent = secs < 120;

  return (
    <span className={`text-xs font-mono ${isUrgent ? 'text-orange-400' : 'text-gray-500'}`}>
      Void window: {mins}:{String(s).padStart(2, '0')}
    </span>
  );
}

export default function OrderHistoryTab({ branchId, currency }: Props) {
  const [orders, setOrders] = useState<Order[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [page, setPage] = useState(0);
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [voidTarget, setVoidTarget] = useState<Order | null>(null);

  const LIMIT = 20;

  const fetchOrders = useCallback(async (reset = false) => {
    if (!branchId) return;
    setLoading(true);
    try {
      const currentPage = reset ? 0 : page;
      const params = new URLSearchParams({
        branch_id: branchId,
        limit: String(LIMIT),
        offset: String(currentPage * LIMIT),
      });
      if (search)       params.set('search', search);
      if (statusFilter) params.set('status', statusFilter);
      if (dateFrom)     params.set('date_from', dateFrom);
      if (dateTo)       params.set('date_to', dateTo + 'T23:59:59');

      const data = await api.get<{ orders: Order[]; total: number }>(`/api/orders?${params}`);
      setOrders(data.orders ?? []);
      setTotal(data.total ?? 0);
      if (reset) setPage(0);
    } catch (err) {
      console.error('Failed to fetch orders:', err);
    } finally {
      setLoading(false);
    }
  }, [branchId, page, search, statusFilter, dateFrom, dateTo]);

  useEffect(() => { fetchOrders(); }, [page]);

  const applyFilters = () => { setPage(0); fetchOrders(true); };

  const openDetail = async (order: Order) => {
    setSelectedOrder(order);
    if (order.order_items) return;
    setDetailLoading(true);
    try {
      const full = await api.get<Order>(`/api/orders/${order.id}`);
      setSelectedOrder(full);
      setOrders(prev => prev.map(o => o.id === full.id ? { ...o, ...full } : o));
    } catch {
      // keep summary open if detail fails
    } finally {
      setDetailLoading(false);
    }
  };

  // Optimistic void — update local state immediately, no full refetch
  const handleVoidSuccess = (orderId: string) => {
    const voidedOrder = { ...orders.find(o => o.id === orderId)!, status: 'voided' };
    setOrders(prev => prev.map(o => o.id === orderId ? voidedOrder : o));
    setSelectedOrder(prev => prev?.id === orderId ? voidedOrder : prev);
    setVoidTarget(null);
  };

  const canVoid = (order: Order) =>
    order.status !== 'voided' && getVoidSecondsLeft(order.created_at) > 0;

  const totalPages = Math.ceil(total / LIMIT);

  return (
    <div className="flex h-full overflow-hidden">

      {/* ── Left: Order list ── */}
      <div className="flex-1 flex flex-col overflow-hidden border-r border-gray-800">

        {/* Filters */}
        <div className="px-4 pt-4 pb-3 border-b border-gray-800 space-y-2">
          <div className="flex gap-2">
            <input
              type="text"
              placeholder="Search order number…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && applyFilters()}
              className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-green-500"
            />
            <select
              value={statusFilter}
              onChange={e => setStatusFilter(e.target.value)}
              className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-green-500"
            >
              <option value="">All statuses</option>
              <option value="completed">Completed</option>
              <option value="voided">Voided</option>
              <option value="pending">Pending</option>
            </select>
          </div>
          <div className="flex gap-2 items-center">
            <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
              className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-green-500" />
            <span className="text-gray-600 text-xs">to</span>
            <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
              className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-green-500" />
            <button onClick={applyFilters}
              className="px-4 py-2 bg-green-500 hover:bg-green-400 text-gray-950 text-sm font-medium rounded-lg transition-colors">
              Filter
            </button>
          </div>
        </div>

        {/* Count */}
        <div className="px-4 py-2 text-xs text-gray-500 border-b border-gray-800">
          {total} order{total !== 1 ? 's' : ''}
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center h-40 text-gray-500 text-sm">Loading…</div>
          ) : orders.length === 0 ? (
            <div className="flex items-center justify-center h-40 text-gray-500 text-sm">No orders found</div>
          ) : (
            orders.map(order => {
              const payment = order.payments?.[0];
              const isSelected = selectedOrder?.id === order.id;
              return (
                <button
                  key={order.id}
                  onClick={() => openDetail(order)}
                  className={`w-full text-left px-4 py-3 border-b border-gray-800 hover:bg-gray-800/50 transition-colors ${isSelected ? 'bg-gray-800/70' : ''}`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-white text-sm font-medium">{order.order_number}</span>
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_COLORS[order.status] ?? 'bg-gray-700 text-gray-400'}`}>
                      {order.status}
                    </span>
                  </div>
                  <div className="flex items-center justify-between mt-1">
                    <span className="text-gray-400 text-xs">
                      {new Date(order.created_at).toLocaleString()} · {payment?.method ?? '—'}
                    </span>
                    <span className="text-white text-sm font-semibold">
                      {currency} {Number(order.total).toLocaleString()}
                    </span>
                  </div>
                </button>
              );
            })
          )}
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-gray-800">
            <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}
              className="text-sm text-gray-400 hover:text-white disabled:opacity-30 transition-colors">← Prev</button>
            <span className="text-xs text-gray-500">Page {page + 1} of {totalPages}</span>
            <button onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1}
              className="text-sm text-gray-400 hover:text-white disabled:opacity-30 transition-colors">Next →</button>
          </div>
        )}
      </div>

      {/* ── Right: Order detail ── */}
      <div className="w-80 flex-shrink-0 flex flex-col bg-gray-900">
        {!selectedOrder ? (
          <div className="flex items-center justify-center h-full text-gray-600 text-sm">
            Select an order to view details
          </div>
        ) : (
          <>
            {/* Detail header */}
            <div className="px-4 py-4 border-b border-gray-800">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-white font-semibold">{selectedOrder.order_number}</h2>
                  <p className="text-gray-500 text-xs mt-0.5">
                    {new Date(selectedOrder.created_at).toLocaleString()}
                  </p>
                </div>
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_COLORS[selectedOrder.status] ?? 'bg-gray-700 text-gray-400'}`}>
                  {selectedOrder.status}
                </span>
              </div>
              {/* Void window countdown — only shown for voidable orders */}
              {selectedOrder.status !== 'voided' && (
                <div className="mt-2">
                  <VoidTimer createdAt={selectedOrder.created_at} />
                </div>
              )}
            </div>

            {/* Items */}
            <div className="flex-1 overflow-y-auto px-4 py-3">
              {detailLoading ? (
                <div className="text-gray-500 text-sm text-center py-8">Loading items…</div>
              ) : !selectedOrder.order_items ? (
                <div className="text-gray-600 text-sm text-center py-8">Items unavailable</div>
              ) : (
                <div className="space-y-3">
                  {selectedOrder.order_items.map(item => (
                    <div key={item.id} className="space-y-1">
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          <p className="text-white text-sm truncate">{item.product_name}</p>
                          {item.category_name && (
                            <p className="text-gray-600 text-xs">{item.category_name}</p>
                          )}
                        </div>
                        <div className="text-right flex-shrink-0">
                          <p className="text-gray-400 text-xs">×{item.quantity}</p>
                          <p className="text-white text-sm">{currency} {Number(item.subtotal).toLocaleString()}</p>
                        </div>
                      </div>
                      {(item.order_item_variants.length > 0 || item.order_item_modifiers.length > 0) && (
                        <div className="flex flex-wrap gap-1">
                          {item.order_item_variants.map((v, i) => (
                            <span key={i} className="text-xs bg-gray-800 text-gray-400 px-1.5 py-0.5 rounded">
                              {v.variant_group_name}: {v.variant_option_name}
                            </span>
                          ))}
                          {item.order_item_modifiers.map((m, i) => (
                            <span key={i} className="text-xs bg-gray-800 text-purple-400 px-1.5 py-0.5 rounded">
                              +{m.modifier_option_name}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Totals + payment */}
            <div className="px-4 py-4 border-t border-gray-800 space-y-2">
              <div className="flex justify-between text-sm text-gray-400">
                <span>Subtotal (incl. VAT)</span>
                <span>{currency} {Number(selectedOrder.subtotal).toLocaleString()}</span>
              </div>
              {selectedOrder.payments?.map((p, i) => (
                <div key={i} className="flex justify-between text-sm">
                  <span className={p.status === 'refunded' ? 'text-red-400' : 'text-gray-400'}>
                    {p.status === 'refunded' ? 'Refunded' : `Payment (${p.method})`}
                  </span>
                  <span className={p.status === 'refunded' ? 'text-red-400' : 'text-white'}>
                    {p.status === 'refunded' ? '-' : ''}{currency} {Math.abs(Number(p.amount)).toLocaleString()}
                  </span>
                </div>
              ))}

              {/* Void button — only shown within 30-min window */}
              {canVoid(selectedOrder) && (
                <button
                  onClick={() => setVoidTarget(selectedOrder)}
                  className="w-full mt-2 bg-red-600/20 hover:bg-red-600/30 border border-red-600/40 text-red-400 hover:text-red-300 rounded-xl py-2.5 text-sm font-medium transition-colors"
                >
                  Void Order
                </button>
              )}
              {/* TODO (Step 12): Expose void-after-window as a permission for selected roles */}
            </div>
          </>
        )}
      </div>

      {/* Void modal */}
      {voidTarget && (
        <VoidModal
          order={voidTarget}
          currency={currency}
          onSuccess={() => handleVoidSuccess(voidTarget.id)}
          onClose={() => setVoidTarget(null)}
        />
      )}
    </div>
  );
}
