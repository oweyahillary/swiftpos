/**
 * ManagerReportsPage.tsx
 *
 * Rich, branch-scoped reports for managers — mirrors the owner's ReportsPage
 * but uses posApi (SwiftPOS JWT) so the backend automatically scopes every
 * query to the manager's branch via branchScope().
 *
 * Tabs:
 *   1. Summary       — revenue KPIs, payment split, daily trend
 *   2. Hourly        — sales by hour of day with order count overlay
 *   3. Item Mix      — product performance table with % of revenue
 *   4. Voids         — voided orders with reason and cashier
 *   5. Staff         — revenue and orders per cashier on this branch
 *   6. Shifts        — shift list with float reconciliation
 */

import { useState, useEffect, useCallback } from 'react';
import { usePOSAuth } from '../../context/POSAuthContext';

// ── Types ─────────────────────────────────────────────────────────────────────

interface SalesSummary {
  summary: {
    totalRevenue: number; totalOrders: number;
    avgOrderValue: number; totalDiscount: number; totalVat: number;
  };
  paymentMethods: Record<string, number>;
  dailySeries: { date: string; revenue: number }[];
}

interface HourlyRow { hour: number; revenue: number; orders: number; }

interface ProductRow {
  product_id: string; name: string; category: string;
  qty: number; revenue: number; avg_price: number; gross_margin_pct: number | null;
}

interface VoidRow {
  id: string; order_number: string; total: number; void_reason: string | null;
  voided_at: string; cashier_name: string | null; table_name: string | null;
}

interface StaffRow {
  staff_id: string; staff_name: string;
  orders: number; revenue: number; voids: number; avg_order_value: number;
}

interface ShiftRow {
  id: string; opened_at: string; closed_at: string | null; status: string;
  staff_name: string | null; opening_float: number; closing_float: number | null;
  expected_cash: number | null; variance: number | null;
  order_count: number | null; total_revenue: number | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const today   = () => new Date().toISOString().slice(0, 10);
const weekAgo = () => { const d = new Date(); d.setDate(d.getDate() - 6); return d.toISOString().slice(0, 10); };

function fmt(currency: string, n: number) {
  return `${currency} ${(n ?? 0).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function fmtShort(currency: string, n: number) {
  if (n >= 1_000_000) return `${currency} ${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${currency} ${(n / 1_000).toFixed(1)}K`;
  return `${currency} ${(n ?? 0).toFixed(0)}`;
}
function fmtDate(iso: string) {
  return new Date(iso).toLocaleString('en-KE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

const METHOD_LABELS: Record<string, string> = { cash: '💵 Cash', mpesa: '📱 M-Pesa', card: '💳 Card' };

const ALL_TABS = [
  { id: 'summary',    label: 'Summary' },
  { id: 'hourly',     label: 'Hourly' },
  { id: 'items',      label: 'Item Mix' },
  { id: 'voids',      label: 'Voids' },
  { id: 'staff',      label: 'Staff' },
  { id: 'shifts',     label: 'Shifts' },
  // Petrol only
  { id: 'fuel_sales', label: '⛽ Fuel Sales' },
  { id: 'wet_stock',  label: '🛢 Wet Stock' },
];

// ── Shared loading / error states ─────────────────────────────────────────────

function Spinner() {
  return (
    <div className="flex justify-center py-12">
      <div className="w-6 h-6 border-2 border-gray-700 border-t-blue-500 rounded-full animate-spin" />
    </div>
  );
}

function ErrorMsg({ msg }: { msg: string }) {
  return <div className="bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3 text-red-400 text-sm">{msg}</div>;
}

function Empty({ label }: { label: string }) {
  return <div className="text-center py-12 text-gray-600 text-sm">{label}</div>;
}

// ── Date range bar (shared) ───────────────────────────────────────────────────

interface DateBarProps { from: string; to: string; setFrom: (v: string) => void; setTo: (v: string) => void; onApply: () => void; loading: boolean; }
function DateBar({ from, to, setFrom, setTo, onApply, loading }: DateBarProps) {
  const presets = [
    { label: 'Today',   f: today(),   t: today() },
    { label: '7 days',  f: weekAgo(), t: today() },
    { label: 'Month',   f: (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-01`; })(), t: today() },
  ];
  return (
    <div className="flex flex-wrap gap-3 items-end mb-6">
      <div className="flex gap-1 bg-gray-800 p-1 rounded-lg">
        {presets.map(p => (
          <button key={p.label} onClick={() => { setFrom(p.f); setTo(p.t); }}
            className={`text-xs px-3 py-1.5 rounded-md transition-colors ${from===p.f && to===p.t ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white'}`}>
            {p.label}
          </button>
        ))}
      </div>
      {[{ label: 'From', val: from, set: setFrom }, { label: 'To', val: to, set: setTo }].map(({ label, val, set }) => (
        <div key={label} className="flex flex-col gap-1">
          <label className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">{label}</label>
          <input type="date" value={val} onChange={e => set(e.target.value)}
            className="bg-gray-900 border border-gray-700 rounded-lg px-3 py-1.5 text-white text-sm focus:outline-none focus:border-blue-500" />
        </div>
      ))}
      <button onClick={onApply} disabled={loading}
        className="px-4 py-1.5 bg-blue-700 hover:bg-blue-600 disabled:opacity-40 text-white text-sm font-semibold rounded-lg transition-colors">
        {loading ? '…' : 'Apply'}
      </button>
    </div>
  );
}

// ── Tab: Summary ──────────────────────────────────────────────────────────────

function SummaryTab({ posApi, session, currency }: { posApi: any; session: any; currency: string }) {
  const [from, setFrom] = useState(weekAgo());
  const [to,   setTo]   = useState(today());
  const [data, setData] = useState<SalesSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');

  const load = useCallback(async (f = from, t = to) => {
    setLoading(true); setError('');
    try {
      const p = new URLSearchParams({ from: f, to: t });
      if (session?.branchId) p.set('branch_id', session.branchId);
      setData(await posApi.get<SalesSummary>(`/api/reports/sales?${p}`));
    } catch (e: any) { setError(e.message ?? 'Failed to load'); }
    finally { setLoading(false); }
  }, [session?.branchId, from, to]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(); }, []); // eslint-disable-line

  const s = data?.summary;
  const kpis = [
    { label: 'Revenue',    value: fmt(currency, s?.totalRevenue ?? 0),  color: '#22c55e' },
    { label: 'Orders',     value: String(s?.totalOrders ?? 0),          color: '#3b82f6' },
    { label: 'Avg Order',  value: fmt(currency, s?.avgOrderValue ?? 0), color: '#a855f7' },
    { label: 'VAT',        value: fmt(currency, s?.totalVat ?? 0),      color: '#f59e0b' },
    { label: 'Discounts',  value: fmt(currency, s?.totalDiscount ?? 0), color: '#ef4444' },
  ];

  return (
    <div className="space-y-5">
      <DateBar from={from} to={to} setFrom={setFrom} setTo={setTo} onApply={() => load(from, to)} loading={loading} />
      {error && <ErrorMsg msg={error} />}
      {loading && !data && <Spinner />}
      {data && <>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          {kpis.map(k => (
            <div key={k.label} className="bg-gray-800/50 border border-gray-700 rounded-2xl p-4">
              <p className="text-gray-500 text-xs mb-2">{k.label}</p>
              <p className="text-lg font-bold" style={{ color: k.color }}>{k.value}</p>
            </div>
          ))}
        </div>

        {Object.keys(data.paymentMethods).length > 0 && (
          <div className="bg-gray-800/50 border border-gray-700 rounded-2xl p-5">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-4">Payment Methods</p>
            <div className="space-y-3">
              {Object.entries(data.paymentMethods).sort((a, b) => b[1] - a[1]).map(([method, amount]) => {
                const pct = s?.totalRevenue ? Math.round((amount / s.totalRevenue) * 100) : 0;
                return (
                  <div key={method} className="space-y-1">
                    <div className="flex justify-between text-sm">
                      <span className="text-gray-300">{METHOD_LABELS[method] ?? method}</span>
                      <span className="text-white font-medium">{fmt(currency, amount)} <span className="text-gray-500 text-xs">({pct}%)</span></span>
                    </div>
                    <div className="h-1.5 bg-gray-700 rounded-full overflow-hidden">
                      <div className="h-full bg-blue-500 rounded-full transition-all" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {data.dailySeries.length > 0 && (
          <div className="bg-gray-800/50 border border-gray-700 rounded-2xl p-5">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-4">Daily Revenue</p>
            <div className="space-y-2">
              {data.dailySeries.map(({ date, revenue }) => {
                const max = Math.max(...data.dailySeries.map(d => d.revenue), 1);
                const pct = Math.round((revenue / max) * 100);
                return (
                  <div key={date} className="flex items-center gap-3">
                    <span className="text-xs text-gray-500 w-12 flex-shrink-0">{date.slice(5)}</span>
                    <div className="flex-1 h-1.5 bg-gray-700 rounded-full overflow-hidden">
                      <div className="h-full bg-green-500 rounded-full" style={{ width: `${pct}%` }} />
                    </div>
                    <span className="text-xs text-gray-400 w-28 text-right flex-shrink-0">{fmtShort(currency, revenue)}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </>}
    </div>
  );
}

// ── Tab: Hourly ───────────────────────────────────────────────────────────────

function HourlyTab({ posApi, session, currency }: { posApi: any; session: any; currency: string }) {
  const [from, setFrom] = useState(today());
  const [to,   setTo]   = useState(today());
  const [rows, setRows] = useState<HourlyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');

  const load = useCallback(async (f = from, t = to) => {
    setLoading(true); setError('');
    try {
      const p = new URLSearchParams({ from: f, to: t });
      if (session?.branchId) p.set('branch_id', session.branchId);
      const data = await posApi.get<{ series: HourlyRow[] }>(`/api/reports/hourly?${p}`);
      setRows((data?.series ?? []).filter(r => r.revenue > 0));
    } catch (e: any) { setError(e.message ?? 'Failed to load'); }
    finally { setLoading(false); }
  }, [session?.branchId, from, to]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(); }, []); // eslint-disable-line

  const maxRev = Math.max(...rows.map(r => r.revenue), 1);
  const total  = rows.reduce((s, r) => s + r.revenue, 0);
  const peakHour = rows.length ? rows.reduce((a, b) => a.revenue > b.revenue ? a : b) : null;

  return (
    <div className="space-y-5">
      <DateBar from={from} to={to} setFrom={setFrom} setTo={setTo} onApply={() => load(from, to)} loading={loading} />
      {error && <ErrorMsg msg={error} />}
      {loading && <Spinner />}
      {!loading && rows.length === 0 && <Empty label="No sales data for this period." />}
      {!loading && rows.length > 0 && (
        <>
          <div className="grid grid-cols-3 gap-3">
            <div className="bg-gray-800/50 border border-gray-700 rounded-xl p-4">
              <p className="text-gray-500 text-xs">Total</p>
              <p className="text-white font-bold text-lg mt-1">{fmtShort(currency, total)}</p>
            </div>
            <div className="bg-gray-800/50 border border-gray-700 rounded-xl p-4">
              <p className="text-gray-500 text-xs">Peak Hour</p>
              <p className="text-amber-400 font-bold text-lg mt-1">{peakHour ? `${peakHour.hour}:00` : '—'}</p>
            </div>
            <div className="bg-gray-800/50 border border-gray-700 rounded-xl p-4">
              <p className="text-gray-500 text-xs">Peak Revenue</p>
              <p className="text-green-400 font-bold text-lg mt-1">{peakHour ? fmtShort(currency, peakHour.revenue) : '—'}</p>
            </div>
          </div>
          <div className="bg-gray-800/50 border border-gray-700 rounded-2xl overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-700/30">
                <tr>
                  {['Hour', 'Orders', 'Revenue', 'Share', ''].map(h => (
                    <th key={h} className="text-left text-xs text-gray-400 px-4 py-3 font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800">
                {rows.sort((a, b) => a.hour - b.hour).map(r => (
                  <tr key={r.hour} className="hover:bg-gray-800/30 transition-colors">
                    <td className="px-4 py-2.5 text-white font-medium">{r.hour}:00 – {r.hour+1}:00</td>
                    <td className="px-4 py-2.5 text-gray-400">{r.orders}</td>
                    <td className="px-4 py-2.5 text-white font-medium">{fmt(currency, r.revenue)}</td>
                    <td className="px-4 py-2.5 text-gray-400 text-xs">{total ? `${((r.revenue / total) * 100).toFixed(1)}%` : '—'}</td>
                    <td className="px-4 py-2.5 w-32">
                      <div className="h-1.5 bg-gray-700 rounded-full overflow-hidden">
                        <div className="h-full bg-blue-500 rounded-full" style={{ width: `${(r.revenue / maxRev) * 100}%` }} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

// ── Tab: Item Mix ─────────────────────────────────────────────────────────────

function ItemMixTab({ posApi, session, currency }: { posApi: any; session: any; currency: string }) {
  const [from, setFrom]   = useState(weekAgo());
  const [to,   setTo]     = useState(today());
  const [rows, setRows]   = useState<ProductRow[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');

  const load = useCallback(async (f = from, t = to) => {
    setLoading(true); setError('');
    try {
      const p = new URLSearchParams({ from: f, to: t });
      if (session?.branchId) p.set('branch_id', session.branchId);
      const data = await posApi.get<{ products: ProductRow[] }>(`/api/reports/products-v2?${p}`);
      setRows(data?.products ?? []);
    } catch (e: any) { setError(e.message ?? 'Failed to load'); }
    finally { setLoading(false); }
  }, [session?.branchId, from, to]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(); }, []); // eslint-disable-line

  const totalRev = rows.reduce((s, r) => s + r.revenue, 0);
  const filtered = rows.filter(r => r.name.toLowerCase().includes(search.toLowerCase()));

  return (
    <div className="space-y-4">
      <DateBar from={from} to={to} setFrom={setFrom} setTo={setTo} onApply={() => load(from, to)} loading={loading} />
      <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search items…"
        className="w-full bg-gray-900 border border-gray-700 rounded-xl px-4 py-2.5 text-white text-sm focus:outline-none focus:border-blue-500" />
      {error && <ErrorMsg msg={error} />}
      {loading && <Spinner />}
      {!loading && filtered.length === 0 && <Empty label="No items sold in this period." />}
      {!loading && filtered.length > 0 && (
        <div className="bg-gray-800/50 border border-gray-700 rounded-2xl overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-700/30">
              <tr>
                {['Item', 'Category', 'Qty', 'Revenue', '% of Sales', 'Avg Price'].map(h => (
                  <th key={h} className="text-left text-xs text-gray-400 px-4 py-3 font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {filtered.sort((a, b) => b.revenue - a.revenue).map(r => {
                const share = totalRev ? (r.revenue / totalRev) * 100 : 0;
                return (
                  <tr key={r.product_id} className="hover:bg-gray-800/30 transition-colors">
                    <td className="px-4 py-2.5 text-white font-medium">{r.name}</td>
                    <td className="px-4 py-2.5 text-gray-400 text-xs">{r.category || '—'}</td>
                    <td className="px-4 py-2.5 text-gray-300 tabular-nums">{r.qty.toLocaleString()}</td>
                    <td className="px-4 py-2.5 text-white font-medium tabular-nums">{fmt(currency, r.revenue)}</td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2">
                        <div className="w-16 h-1.5 bg-gray-700 rounded-full overflow-hidden">
                          <div className="h-full bg-green-500 rounded-full" style={{ width: `${share}%` }} />
                        </div>
                        <span className="text-gray-400 text-xs">{share.toFixed(1)}%</span>
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-gray-400 tabular-nums">{fmt(currency, r.avg_price)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Tab: Voids ────────────────────────────────────────────────────────────────

function VoidsTab({ posApi, session, currency }: { posApi: any; session: any; currency: string }) {
  const [from, setFrom] = useState(today());
  const [to,   setTo]   = useState(today());
  const [rows, setRows] = useState<VoidRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');

  const load = useCallback(async (f = from, t = to) => {
    setLoading(true); setError('');
    try {
      const p = new URLSearchParams({ from: f, to: t });
      if (session?.branchId) p.set('branch_id', session.branchId);
      const data = await posApi.get<{ voids: VoidRow[] }>(`/api/reports/voids?${p}`);
      setRows(data?.voids ?? []);
    } catch (e: any) { setError(e.message ?? 'Failed to load'); }
    finally { setLoading(false); }
  }, [session?.branchId, from, to]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(); }, []); // eslint-disable-line

  const totalVoided = rows.reduce((s, r) => s + r.total, 0);

  return (
    <div className="space-y-4">
      <DateBar from={from} to={to} setFrom={setFrom} setTo={setTo} onApply={() => load(from, to)} loading={loading} />
      {error && <ErrorMsg msg={error} />}
      {loading && <Spinner />}
      {!loading && rows.length === 0 && <Empty label="No voided orders in this period. ✓" />}
      {!loading && rows.length > 0 && (
        <>
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-red-500/5 border border-red-500/20 rounded-xl p-4">
              <p className="text-gray-500 text-xs mb-1">Void Count</p>
              <p className="text-red-400 font-bold text-2xl">{rows.length}</p>
            </div>
            <div className="bg-red-500/5 border border-red-500/20 rounded-xl p-4">
              <p className="text-gray-500 text-xs mb-1">Total Voided Value</p>
              <p className="text-red-400 font-bold text-2xl">{fmtShort(currency, totalVoided)}</p>
            </div>
          </div>
          <div className="bg-gray-800/50 border border-gray-700 rounded-2xl overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-700/30">
                <tr>
                  {['Order', 'Amount', 'Cashier', 'Table', 'Reason', 'Time'].map(h => (
                    <th key={h} className="text-left text-xs text-gray-400 px-4 py-3 font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800">
                {rows.map(r => (
                  <tr key={r.id} className="hover:bg-gray-800/30 transition-colors">
                    <td className="px-4 py-2.5 text-white font-mono text-xs">{r.order_number}</td>
                    <td className="px-4 py-2.5 text-red-400 font-medium tabular-nums">{fmt(currency, r.total)}</td>
                    <td className="px-4 py-2.5 text-gray-300">{r.cashier_name ?? '—'}</td>
                    <td className="px-4 py-2.5 text-gray-400">{r.table_name ?? '—'}</td>
                    <td className="px-4 py-2.5 text-gray-400 text-xs max-w-[180px] truncate">{r.void_reason ?? '—'}</td>
                    <td className="px-4 py-2.5 text-gray-500 text-xs whitespace-nowrap">{fmtDate(r.voided_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

// ── Tab: Staff Performance ────────────────────────────────────────────────────

function StaffPerfTab({ posApi, session, currency }: { posApi: any; session: any; currency: string }) {
  const [from, setFrom] = useState(today());
  const [to,   setTo]   = useState(today());
  const [rows, setRows] = useState<StaffRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');

  const load = useCallback(async (f = from, t = to) => {
    setLoading(true); setError('');
    try {
      const p = new URLSearchParams({ from: f, to: t });
      if (session?.branchId) p.set('branch_id', session.branchId);
      const data = await posApi.get<{ staff: StaffRow[] }>(`/api/reports/staff?${p}`);
      setRows(data?.staff ?? []);
    } catch (e: any) { setError(e.message ?? 'Failed to load'); }
    finally { setLoading(false); }
  }, [session?.branchId, from, to]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(); }, []); // eslint-disable-line

  const maxRev = Math.max(...rows.map(r => r.revenue), 1);

  return (
    <div className="space-y-4">
      <DateBar from={from} to={to} setFrom={setFrom} setTo={setTo} onApply={() => load(from, to)} loading={loading} />
      {error && <ErrorMsg msg={error} />}
      {loading && <Spinner />}
      {!loading && rows.length === 0 && <Empty label="No staff transactions in this period." />}
      {!loading && rows.length > 0 && (
        <div className="bg-gray-800/50 border border-gray-700 rounded-2xl overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-700/30">
              <tr>
                {['Cashier', 'Orders', 'Revenue', 'Avg Order', 'Voids', ''].map(h => (
                  <th key={h} className="text-left text-xs text-gray-400 px-4 py-3 font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {rows.sort((a, b) => b.revenue - a.revenue).map(r => (
                <tr key={r.staff_id} className="hover:bg-gray-800/30 transition-colors">
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <div className="w-7 h-7 rounded-full bg-blue-600/20 border border-blue-500/30 flex items-center justify-center text-blue-400 text-xs font-bold flex-shrink-0">
                        {(r.staff_name ?? '?').charAt(0).toUpperCase()}
                      </div>
                      <span className="text-white font-medium">{r.staff_name ?? 'Unknown'}</span>
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-gray-300 tabular-nums">{r.orders}</td>
                  <td className="px-4 py-2.5 text-white font-medium tabular-nums">{fmt(currency, r.revenue)}</td>
                  <td className="px-4 py-2.5 text-gray-400 tabular-nums">{fmt(currency, r.avg_order_value)}</td>
                  <td className="px-4 py-2.5">
                    {r.voids > 0
                      ? <span className="text-red-400 text-xs font-semibold">{r.voids} void{r.voids > 1 ? 's' : ''}</span>
                      : <span className="text-green-500 text-xs">✓ None</span>}
                  </td>
                  <td className="px-4 py-2.5 w-32">
                    <div className="h-1.5 bg-gray-700 rounded-full overflow-hidden">
                      <div className="h-full bg-purple-500 rounded-full" style={{ width: `${(r.revenue / maxRev) * 100}%` }} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Tab: Shifts ───────────────────────────────────────────────────────────────

function ShiftsTab({ posApi, session, currency }: { posApi: any; session: any; currency: string }) {
  const [from, setFrom] = useState(today());
  const [to,   setTo]   = useState(today());
  const [rows, setRows] = useState<ShiftRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');

  const load = useCallback(async (f = from, t = to) => {
    setLoading(true); setError('');
    try {
      const p = new URLSearchParams({ from: f, to: t });
      if (session?.branchId) p.set('branch_id', session.branchId);
      const data = await posApi.get<{ shifts: ShiftRow[] }>(`/api/reports/shifts?${p}`);
      setRows(data?.shifts ?? []);
    } catch (e: any) { setError(e.message ?? 'Failed to load'); }
    finally { setLoading(false); }
  }, [session?.branchId, from, to]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(); }, []); // eslint-disable-line

  return (
    <div className="space-y-4">
      <DateBar from={from} to={to} setFrom={setFrom} setTo={setTo} onApply={() => load(from, to)} loading={loading} />
      {error && <ErrorMsg msg={error} />}
      {loading && <Spinner />}
      {!loading && rows.length === 0 && <Empty label="No shifts in this period." />}
      {!loading && rows.length > 0 && (
        <div className="space-y-3">
          {rows.map(r => {
            const variance = r.variance ?? null;
            const isOpen   = r.status === 'open';
            const hours    = r.closed_at
              ? ((new Date(r.closed_at).getTime() - new Date(r.opened_at).getTime()) / 3_600_000).toFixed(1)
              : ((Date.now() - new Date(r.opened_at).getTime()) / 3_600_000).toFixed(1);
            return (
              <div key={r.id} className={`border rounded-2xl p-4 ${isOpen ? 'border-green-500/30 bg-green-500/5' : 'border-gray-700 bg-gray-800/40'}`}>
                <div className="flex items-start justify-between gap-4 mb-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="text-white font-semibold">{r.staff_name ?? 'Unknown'}</p>
                      {isOpen && <span className="text-[10px] text-green-400 font-semibold border border-green-500/30 rounded-full px-2 py-0.5">● Open</span>}
                    </div>
                    <p className="text-gray-500 text-xs mt-0.5">
                      {fmtDate(r.opened_at)} {r.closed_at ? `→ ${fmtDate(r.closed_at)}` : '→ now'} · {hours}h
                    </p>
                  </div>
                  {r.total_revenue != null && (
                    <p className="text-green-400 font-bold text-lg">{fmtShort(currency, r.total_revenue)}</p>
                  )}
                </div>
                <div className="grid grid-cols-3 gap-3 text-xs">
                  <div>
                    <p className="text-gray-500">Orders</p>
                    <p className="text-white font-semibold mt-0.5">{r.order_count ?? 0}</p>
                  </div>
                  <div>
                    <p className="text-gray-500">Opening float</p>
                    <p className="text-white font-semibold mt-0.5">{fmt(currency, r.opening_float)}</p>
                  </div>
                  {variance != null && (
                    <div>
                      <p className="text-gray-500">Cash variance</p>
                      <p className={`font-semibold mt-0.5 ${Math.abs(variance) < 50 ? 'text-green-400' : 'text-red-400'}`}>
                        {variance >= 0 ? '+' : ''}{fmt(currency, variance)}
                      </p>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────


// ── Fuel Sales Tab (Manager) ──────────────────────────────────────────────────

function FuelSalesTab({ posApi, session, currency }: { posApi: any; session: any; currency: string }) {
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(today);
  const [to,   setTo]   = useState(today);
  const [data, setData] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState('');

  const load = useCallback(async (f = from, t = to) => {
    setLoading(true); setError('');
    try {
      const p = new URLSearchParams({ from: f, to: t });
      if (session?.branchId) p.set('branch_id', session.branchId);
      setData(await posApi.get<any>(`/api/reports/fuel-sales?${p}`));
    } catch (e: any) { setError(e.message ?? 'Failed to load'); }
    finally { setLoading(false); }
  }, [session?.branchId, from, to]); // eslint-disable-line

  useEffect(() => { load(); }, []); // eslint-disable-line

  const GRADE_C: Record<string, string> = { diesel: '#f59e0b', premium: '#a78bfa', petrol: '#22c55e', kerosene: '#06b6d4' };
  function gc(name: string) {
    const n = name.toLowerCase();
    if (n.includes('diesel')) return GRADE_C.diesel;
    if (n.includes('premium')) return GRADE_C.premium;
    if (n.includes('kero')) return GRADE_C.kerosene;
    return GRADE_C.petrol;
  }
  const fmtC = (n: number) => `${currency} ${n.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const fmtL = (n: number) => `${n.toLocaleString('en-KE', { maximumFractionDigits: 1 })} L`;

  return (
    <div className="space-y-5">
      <DateBar from={from} to={to} setFrom={setFrom} setTo={setTo} onApply={() => load(from, to)} loading={loading} />
      {error && <ErrorMsg msg={error} />}
      {loading && <Spinner />}
      {!loading && data && (
        <>
          <div className="grid grid-cols-3 gap-3">
            {[
              { label: 'Total Litres', value: fmtL(data.summary.totalLitres), color: '#f59e0b' },
              { label: 'Revenue', value: fmtC(data.summary.totalRevenue), color: '#22c55e' },
              { label: 'Transactions', value: String(data.summary.totalTransactions), color: '#3b82f6' },
            ].map(k => (
              <div key={k.label} className="bg-gray-800/50 border border-gray-700 rounded-xl p-4">
                <p className="text-gray-500 text-xs mb-1">{k.label}</p>
                <p className="font-bold text-lg" style={{ color: k.color }}>{k.value}</p>
              </div>
            ))}
          </div>
          {data.grades.length > 0 && (
            <div className="bg-gray-800/50 border border-gray-700 rounded-2xl overflow-hidden">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider px-5 py-4 border-b border-gray-700">By Grade</p>
              <table className="w-full text-sm">
                <thead className="bg-gray-700/30"><tr>
                  {['Grade','Litres','Revenue','Avg Price/L'].map(h => (
                    <th key={h} className="text-left text-xs text-gray-400 px-4 py-3 font-medium">{h}</th>
                  ))}
                </tr></thead>
                <tbody className="divide-y divide-gray-800">
                  {data.grades.map((g: any) => (
                    <tr key={g.product_id} className="hover:bg-gray-800/30 transition-colors">
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-2">
                          <div className="w-2 h-2 rounded-full" style={{ background: gc(g.name) }} />
                          <span className="text-white font-medium">{g.name}</span>
                        </div>
                      </td>
                      <td className="px-4 py-2.5 text-amber-400 font-semibold tabular-nums">{fmtL(g.litres)}</td>
                      <td className="px-4 py-2.5 text-white font-medium tabular-nums">{fmtC(g.revenue)}</td>
                      <td className="px-4 py-2.5 text-gray-400 tabular-nums">{fmtC(g.litres > 0 ? g.revenue / g.litres : 0)}/L</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {data.pumps.length > 0 && (
            <div className="bg-gray-800/50 border border-gray-700 rounded-2xl overflow-hidden">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider px-5 py-4 border-b border-gray-700">By Pump</p>
              <table className="w-full text-sm">
                <thead className="bg-gray-700/30"><tr>
                  {['Pump','Litres','Revenue','Transactions'].map(h => (
                    <th key={h} className="text-left text-xs text-gray-400 px-4 py-3 font-medium">{h}</th>
                  ))}
                </tr></thead>
                <tbody className="divide-y divide-gray-800">
                  {data.pumps.map((p: any) => (
                    <tr key={p.pump_id} className="hover:bg-gray-800/30 transition-colors">
                      <td className="px-4 py-2.5 text-white font-medium">⛽ {p.pump_name}</td>
                      <td className="px-4 py-2.5 text-amber-400 tabular-nums">{fmtL(p.litres)}</td>
                      <td className="px-4 py-2.5 text-white font-medium tabular-nums">{fmtC(p.revenue)}</td>
                      <td className="px-4 py-2.5 text-gray-400 tabular-nums">{p.transactions}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Wet Stock Tab (Manager) ───────────────────────────────────────────────────

function WetStockTab({ posApi, session, currency }: { posApi: any; session: any; currency: string }) {
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(today);
  const [to,   setTo]   = useState(today);
  const [data, setData] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState('');

  const load = useCallback(async (f = from, t = to) => {
    setLoading(true); setError('');
    try {
      const p = new URLSearchParams({ from: f, to: t });
      if (session?.branchId) p.set('branch_id', session.branchId);
      setData(await posApi.get<any>(`/api/reports/wet-stock?${p}`));
    } catch (e: any) { setError(e.message ?? 'Failed to load'); }
    finally { setLoading(false); }
  }, [session?.branchId, from, to]); // eslint-disable-line

  useEffect(() => { load(); }, []); // eslint-disable-line

  function gc(name: string) {
    const n = name.toLowerCase();
    if (n.includes('diesel')) return '#f59e0b';
    if (n.includes('premium')) return '#a78bfa';
    if (n.includes('kero')) return '#06b6d4';
    return '#22c55e';
  }
  const fmtL = (n: number) => `${n.toLocaleString('en-KE', { maximumFractionDigits: 1 })} L`;

  return (
    <div className="space-y-5">
      <DateBar from={from} to={to} setFrom={setFrom} setTo={setTo} onApply={() => load(from, to)} loading={loading} />
      {error && <ErrorMsg msg={error} />}
      {loading && <Spinner />}
      {!loading && data && (
        <>
          <div className="space-y-3">
            {(data.tanks ?? []).map((tank: any) => {
              const color = gc(tank.product_name);
              const isLow = tank.is_low;
              return (
                <div key={tank.id} className={`border rounded-xl p-4 ${isLow ? 'border-red-500/30 bg-red-500/5' : 'border-gray-700 bg-gray-800/40'}`}>
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <div className="w-2.5 h-2.5 rounded-full" style={{ background: color }} />
                      <p className="text-white font-semibold">{tank.name}</p>
                      <span className="text-xs text-gray-500">{tank.product_name}</span>
                      {isLow && <span className="text-[10px] text-red-400 font-bold border border-red-500/30 rounded-full px-2 py-0.5">LOW</span>}
                    </div>
                    <span className={`font-bold tabular-nums ${isLow ? 'text-red-400' : 'text-white'}`}>{tank.level_pct}%</span>
                  </div>
                  <div className="h-2 bg-gray-700 rounded-full overflow-hidden mb-3">
                    <div className="h-full rounded-full" style={{ width: `${tank.level_pct}%`, background: isLow ? '#ef4444' : color }} />
                  </div>
                  <div className="grid grid-cols-4 gap-3 text-xs">
                    <div><p className="text-gray-500">Current</p><p className="text-white font-medium mt-0.5">{fmtL(tank.current_level)}</p></div>
                    <div><p className="text-green-500">Delivered</p><p className="text-white font-medium mt-0.5">+{fmtL(tank.delivered_litres)}</p></div>
                    <div><p className="text-amber-400">Dispensed</p><p className="text-white font-medium mt-0.5">{fmtL(tank.consumed_litres)}</p></div>
                    <div>
                      <p className="text-gray-500">Variance</p>
                      <p className={`font-medium mt-0.5 ${Math.abs(tank.delivered_litres - tank.consumed_litres) < 50 ? 'text-gray-300' : 'text-red-400'}`}>
                        {tank.delivered_litres - tank.consumed_litres >= 0 ? '+' : ''}{fmtL(tank.delivered_litres - tank.consumed_litres)}
                      </p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          {(data.deliveryLog ?? []).length > 0 && (
            <div className="bg-gray-800/50 border border-gray-700 rounded-2xl overflow-hidden">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider px-5 py-4 border-b border-gray-700">Delivery Log</p>
              {data.deliveryLog.map((d: any, i: number) => (
                <div key={i} className="flex items-center gap-3 px-5 py-3 border-b border-gray-800 last:border-0">
                  <span className="text-green-400 font-semibold">+{fmtL(d.litres)}</span>
                  <span className="text-gray-500 text-xs flex-1">{d.notes ?? '—'}</span>
                  <span className="text-gray-600 text-xs">{new Date(d.recorded_at).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default function ManagerReportsPage() {
  const { posApi, session } = usePOSAuth();
  const currency = session?.currency ?? 'KES';
  const isPetrol = session?.businessType === 'petrol_station';
  const [activeTab, setActiveTab] = useState(isPetrol ? 'fuel_sales' : 'summary');

  const TABS = ALL_TABS.filter(t => {
    if (t.id === 'fuel_sales' || t.id === 'wet_stock') return isPetrol;
    if (t.id === 'items') return !isPetrol;
    return true;
  });

  const tabProps = { posApi, session, currency };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-bold text-white">Reports</h2>
        <p className="text-gray-500 text-sm mt-0.5">{session?.branchName} — all data scoped to this branch</p>
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 bg-gray-800/50 border border-gray-700 rounded-xl p-1 flex-wrap">
        {TABS.map(t => (
          <button key={t.id} onClick={() => setActiveTab(t.id)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              activeTab === t.id ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-700'
            }`}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div>
        {activeTab === 'summary' && <SummaryTab {...tabProps} />}
        {activeTab === 'hourly'  && <HourlyTab  {...tabProps} />}
        {activeTab === 'items'   && <ItemMixTab {...tabProps} />}
        {activeTab === 'voids'   && <VoidsTab   {...tabProps} />}
        {activeTab === 'staff'   && <StaffPerfTab {...tabProps} />}
        {activeTab === 'shifts'     && <ShiftsTab      {...tabProps} />}
        {activeTab === 'fuel_sales' && <FuelSalesTab  {...tabProps} />}
        {activeTab === 'wet_stock'  && <WetStockTab   {...tabProps} />}
      </div>
    </div>
  );
}
