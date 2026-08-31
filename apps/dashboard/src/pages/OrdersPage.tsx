/**
 * OrdersPage — owner-dashboard order history (A187, Phase 1: read-only view).
 *
 * The cloud order-history/void machinery existed only on the POS surfaces
 * (POSOrderHistoryTab, bound to usePOSAuth) and the manager dashboard — the OWNER
 * dashboard had no way to see orders at all. This page fills the view half using
 * the owner's own auth: GET /api/orders already scopes by owner-vs-staff
 * (branchScope), so an owner sees every branch's orders with no server change.
 *
 * Gated on `orders.view_all`. VOID is deliberately NOT here — that is Phase 2
 * (money-critical: orders.void + supervisor/authorizer PIN + shift/tax handling).
 */
import { useState, useEffect, useCallback, Fragment } from 'react';
import { api } from '../lib/api';
import { usePermissions } from '../context/PermissionsContext';

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
  branch_id: string | null;
  payments: Payment[];
}
interface OrdersResponse { orders: Order[]; total: number; }

const PAGE_SIZE = 25;

const STATUS_COLOR: Record<string, string> = {
  completed: 'text-green-400', voided: 'text-red-400', pending: 'text-amber-400',
};
const METHOD_ICON: Record<string, string> = { cash: '💵', mpesa: '📱', card: '💳' };

const fmt = (n: number, currency: string) =>
  `${currency} ${Number(n).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtTime = (iso: string) =>
  new Date(iso).toLocaleString('en-KE', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export default function OrdersPage({ currency = 'KES' }: { currency?: string }) {
  const { can } = usePermissions();
  const allowed = can('orders.view_all');

  const [orders, setOrders]   = useState<Order[]>([]);
  const [total, setTotal]     = useState(0);
  const [page, setPage]       = useState(1);
  const [search, setSearch]   = useState('');
  const [status, setStatus]   = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async (p = 1, q = search, s = status) => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String((p - 1) * PAGE_SIZE),
      });
      if (q) params.set('search', q);
      if (s) params.set('status', s);
      const data = await api.get<OrdersResponse>(`/api/orders?${params}`);
      setOrders(data.orders);
      setTotal(data.total);
      setPage(p);
    } catch (e: any) {
      setError(e?.message ?? 'Could not load orders');
    } finally {
      setLoading(false);
    }
  }, [search, status]);

  useEffect(() => { if (allowed) load(1); }, [allowed, load]);

  if (!allowed) {
    return (
      <div className="p-8 text-gray-400">
        You don't have permission to view orders. Ask an owner to enable
        "View all orders" for your role.
      </div>
    );
  }

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="p-6 max-w-6xl">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-semibold text-white">Orders</h1>
        <span className="text-sm text-gray-400">{total} order{total === 1 ? '' : 's'}</span>
      </div>

      <div className="flex flex-wrap gap-2 mb-4">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') load(1, search, status); }}
          placeholder="Search order number…"
          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-500 focus:border-green-500 focus:outline-none"
        />
        <select
          value={status}
          onChange={(e) => { setStatus(e.target.value); load(1, search, e.target.value); }}
          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:border-green-500 focus:outline-none"
        >
          <option value="">All statuses</option>
          <option value="completed">Completed</option>
          <option value="voided">Voided</option>
          <option value="pending">Pending</option>
        </select>
        <button
          onClick={() => load(1, search, status)}
          className="bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-200 text-sm font-medium px-4 py-2 rounded-lg transition-colors"
        >Search</button>
      </div>

      {error && <div className="mb-3 text-sm text-red-400">{error}</div>}

      <div className="border border-gray-800 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-900 text-gray-400 text-left">
            <tr>
              <th className="px-4 py-2 font-medium">Order</th>
              <th className="px-4 py-2 font-medium">Type</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2 font-medium text-right">Total</th>
              <th className="px-4 py-2 font-medium">When</th>
              <th className="px-4 py-2 font-medium">Customer</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-500">Loading…</td></tr>
            )}
            {!loading && orders.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-500">No orders found.</td></tr>
            )}
            {!loading && orders.map((o) => (
              <Fragment key={o.id}>
                <tr
                  onClick={() => setExpanded(expanded === o.id ? null : o.id)}
                  className="border-t border-gray-800 hover:bg-gray-900/50 cursor-pointer"
                >
                  <td className="px-4 py-2 text-gray-200 font-medium">{o.order_number}</td>
                  <td className="px-4 py-2 text-gray-400 capitalize">{o.order_type}</td>
                  <td className={`px-4 py-2 capitalize ${STATUS_COLOR[o.status] ?? 'text-gray-300'}`}>{o.status}</td>
                  <td className="px-4 py-2 text-right text-gray-200">{fmt(o.total, currency)}</td>
                  <td className="px-4 py-2 text-gray-400">{fmtTime(o.created_at)}</td>
                  <td className="px-4 py-2 text-gray-400">{o.customer_name ?? '—'}</td>
                </tr>
                {expanded === o.id && (
                  <tr className="bg-gray-900/40 border-t border-gray-800">
                    <td colSpan={6} className="px-4 py-3">
                      <div className="text-xs text-gray-400 space-y-1">
                        <div>Subtotal: {fmt(o.subtotal, currency)}
                          {o.discount_amount > 0 && <> · Discount: {fmt(o.discount_amount, currency)}</>}
                          · Total: <span className="text-gray-200">{fmt(o.total, currency)}</span></div>
                        <div className="flex flex-wrap gap-3 pt-1">
                          {o.payments.length === 0 && <span>No payments recorded.</span>}
                          {o.payments.map((p, i) => (
                            <span key={i} className="text-gray-300">
                              {METHOD_ICON[p.method] ?? '•'} {p.method} {fmt(p.amount, currency)}
                              {p.status !== 'completed' && <span className="text-amber-400"> ({p.status})</span>}
                            </span>
                          ))}
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>

      {pages > 1 && (
        <div className="flex items-center justify-between mt-4 text-sm text-gray-400">
          <button
            disabled={page <= 1}
            onClick={() => load(page - 1)}
            className="px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg disabled:opacity-40 hover:bg-gray-700 transition-colors"
          >Previous</button>
          <span>Page {page} of {pages}</span>
          <button
            disabled={page >= pages}
            onClick={() => load(page + 1)}
            className="px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg disabled:opacity-40 hover:bg-gray-700 transition-colors"
          >Next</button>
        </div>
      )}
    </div>
  );
}
