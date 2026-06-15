import { API_URL } from '../lib/config';
/**
 * ReportsPage.tsx  — Full Posist-style reporting suite for SwiftPOS.
 *
 * Tabs: Master/DSR · Hourly Sales · Item Mix · Voids & Exceptions · Tax · Staff
 */

import { useState, useEffect, useCallback } from 'react';
import { ReportsSkeleton } from './pos/cashier/POSSkeletons';
import { api } from '../lib/api';
import { useBusiness } from '../context/BusinessContext';
import { useBranch } from '../context/BranchContext';

// ── Types ─────────────────────────────────────────────────────────────────────

interface DateRange { from: string; to: string }

interface MasterReport {
  period: { from: string; to: string };
  branchName: string;
  summary: {
    totalSale: number; totalVat: number; totalCtl: number; totalDiscount: number;
    netSales: number; totalRevenue: number; totalOrders: number;
    voidedCount: number; voidedValue: number; avgOrderValue: number;
    totalExpenses: number; netProfit: number;
  };
  channels: { channel: string; amount: number; pct: number }[];
  payments: { method: string; amount: number }[];
  categoryBreakdown: { category: string; superCategory: string; qty: number; netSales: number }[];
  expenses: { total: number; breakdown: { category: string; amount: number }[] };
}

interface HourlyReport {
  period: { from: string; to: string };
  hourly: { hour: number; label: string; revenue: number; orders: number; avgOrderValue: number }[];
  dayOfWeek: { day: string; dayIndex: number; revenue: number; orders: number }[];
  dailySeries: { date: string; revenue: number; orders: number }[];
  peakHour: number | null;
  peakRevenue: number;
}

interface ProductV2Report {
  products: {
    product_id: string; name: string; category: string; qty: number; revenue: number;
    contribution_pct: number; cost_price: number | null; total_cost: number | null;
    gross_margin_pct: number | null;
  }[];
  totalRevenue: number;
}

interface VoidsReport {
  period: { from: string; to: string };
  voids: {
    id: string; order_number: string; order_type: string; total: number;
    void_reason: string | null; cashier_id: string; cashier_name: string;
    authorized_by_name: string | null;
    branch_name: string; created_at: string;
  }[];
  summary: {
    totalVoids: number; totalValue: number;
    byStaff: { cashier_id: string; name: string; count: number; value: number }[];
  };
}

interface TaxReport {
  period: { from: string; to: string };
  rates: { vatRate: number; ctlRate: number };
  summary: { grossSales: number; vatTotal: number; ctlTotal: number; netSales: number; totalOrders: number };
  byCategory: { category: string; grossSales: number; vatAmount: number; ctlAmount: number; netSales: number }[];
  byBranch: { branchName: string; grossSales: number; vatAmount: number; ctlAmount: number; netSales: number }[];
}

interface StaffReport {
  staff: { cashier_id: string; name: string; branch: string; orders: number; revenue: number }[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtShort(n: number | null | undefined, currency = 'KES') {
  if (n == null) return '—';
  return `${currency} ${n.toLocaleString('en-KE', { maximumFractionDigits: 0 })}`;
}
function pct(n: number) { return `${n.toFixed(1)}%`; }
function today() { return new Date().toISOString().slice(0, 10); }
function monthStart() { const d = new Date(); d.setDate(1); return d.toISOString().slice(0, 10); }

const CHANNEL_LABELS: Record<string, string> = {
  counter: 'Counter', takeaway: 'Takeaway',
  delivery: 'Delivery', aggregator: 'Aggregator', other: 'Other',
};
const CHANNEL_BAR_COLORS: Record<string, string> = {
  counter: 'bg-blue-500', takeaway: 'bg-purple-500',
  delivery: 'bg-teal-500', aggregator: 'bg-amber-500', other: 'bg-gray-400',
};
const TAB_LIST = [
  { id: 'master',     label: 'Master / DSR' },
  { id: 'hourly',     label: 'Hourly Sales' },
  { id: 'items',      label: 'Item Mix' },
  { id: 'matrix',     label: 'Menu Matrix' },
  { id: 'food_cost',  label: 'Food Cost' },
  { id: 'aggregator', label: 'Aggregators' },
  { id: 'voids',      label: 'Voids & Exceptions' },
  { id: 'tax',        label: 'Tax Report' },
  { id: 'staff',      label: 'Staff Performance' },
  { id: 'splh',       label: 'SPLH & Labour' },
  // Petrol station tabs — shown only when business.type === 'petrol_station'
  { id: 'fuel_sales', label: 'Fuel Sales' },
  { id: 'wet_stock',  label: 'Wet Stock' },
];

// ── Sub-components ────────────────────────────────────────────────────────────

function KpiCard({ label, value, sub, accent = false }: { label: string; value: string; sub?: string; accent?: boolean }) {
  return (
    <div className={`rounded-xl p-4 border ${accent
      ? 'bg-blue-600 border-blue-700'
      : 'bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700'}`}>
      <p className={`text-xs font-medium uppercase tracking-wide mb-1 ${accent ? 'text-blue-100' : 'text-gray-500 dark:text-gray-400'}`}>{label}</p>
      <p className={`text-xl font-semibold tabular-nums ${accent ? 'text-white' : 'text-gray-900 dark:text-white'}`}>{value}</p>
      {sub && <p className={`text-xs mt-0.5 ${accent ? 'text-blue-100' : 'text-gray-400'}`}>{sub}</p>}
    </div>
  );
}

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-3">{title}</h3>
      {children}
    </div>
  );
}

function Th({ children, right = false }: { children: React.ReactNode; right?: boolean }) {
  return <th className={`text-xs text-gray-400 pb-2 font-medium ${right ? 'text-right' : 'text-left'}`}>{children}</th>;
}

function Spinner() {
  return <ReportsSkeleton />;
}

function ErrMsg({ msg }: { msg: string }) {
  return <div className="text-red-500 py-6 text-sm">{msg}</div>;
}

// ── Date range bar ────────────────────────────────────────────────────────────

function DateRangeBar({ range, onChange, branches, branchId, onBranchChange }: {
  range: DateRange; onChange: (r: DateRange) => void;
  branches: { id: string; name: string }[]; branchId: string; onBranchChange: (id: string) => void;
}) {
  const yesterday = (() => { const d = new Date(); d.setDate(d.getDate() - 1); return d.toISOString().slice(0, 10); })();
  const presets = [
    { label: 'Today',      from: today(),      to: today() },
    { label: 'Yesterday',  from: yesterday,    to: yesterday },
    { label: 'This month', from: monthStart(), to: today() },
  ];
  const inputCls = 'text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-1.5 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200';
  return (
    <div className="flex flex-wrap items-center gap-2 mb-5">
      <div className="flex items-center gap-1 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-1">
        {presets.map(p => (
          <button key={p.label} onClick={() => onChange({ from: p.from, to: p.to })}
            className={`text-xs px-3 py-1.5 rounded-md transition-colors ${range.from === p.from && range.to === p.to ? 'bg-blue-600 text-white' : 'text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'}`}>
            {p.label}
          </button>
        ))}
      </div>
      <input type="date" value={range.from} max={range.to} onChange={e => onChange({ ...range, from: e.target.value })} className={inputCls} />
      <span className="text-gray-400 text-sm">→</span>
      <input type="date" value={range.to} min={range.from} onChange={e => onChange({ ...range, to: e.target.value })} className={inputCls} />
      {branches.length > 1 && (
        <select value={branchId} onChange={e => onBranchChange(e.target.value)} className={inputCls}>
          <option value="">All branches</option>
          {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
      )}
    </div>
  );
}

// ── Tab: Master / DSR ─────────────────────────────────────────────────────────

function MasterTab({ range, branchId, currency }: { range: DateRange; branchId: string; currency: string }) {
  const [data, setData]     = useState<MasterReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]   = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const p = new URLSearchParams({ from: range.from, to: range.to });
      if (branchId) p.set('branch_id', branchId);
      setData(await api.get<MasterReport>(`/api/reports/master?${p}`));
    } catch (e: any) { setError(e.message ?? 'Failed to load'); }
    finally { setLoading(false); }
  }, [range.from, range.to, branchId]);
  useEffect(() => { load(); }, [load]);

  if (loading) return <Spinner />;
  if (error)   return <ErrMsg msg={error} />;
  if (!data)   return null;

  const { summary, channels, payments, categoryBreakdown, expenses } = data;
  const maxCh = Math.max(...channels.map(c => c.amount), 1);

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-gray-900 dark:text-white">{data.branchName || 'All branches'}</h2>
          <p className="text-xs text-gray-400 mt-0.5">{range.from} — {range.to}</p>
        </div>
        <button
          onClick={() => {
            const p = new URLSearchParams({ from: range.from, to: range.to, format: 'xlsx' });
            if (branchId) p.set('branch_id', branchId);
            window.open(`${API_URL}/api/reports/export/sales?${p}`);
          }}
          className="text-xs px-3 py-1.5 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-200 rounded-lg transition-colors"
        >↓ Export Excel</button>
      </div>

      {/* KPI rows */}
      <div>
        <p className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-2">Sale Summary</p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
          <KpiCard label="Gross Sales"  value={fmtShort(summary.totalSale, currency)} />
          <KpiCard label="VAT 16%"      value={fmtShort(summary.totalVat, currency)} />
          <KpiCard label="CTL 2%"       value={fmtShort(summary.totalCtl, currency)} />
          <KpiCard label="Net Sales"    value={fmtShort(summary.netSales, currency)} accent />
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <KpiCard label="Total Orders"  value={summary.totalOrders.toString()} sub={`avg ${fmtShort(summary.avgOrderValue, currency)}`} />
          <KpiCard label="Discounts"     value={fmtShort(summary.totalDiscount, currency)} />
          <KpiCard label="Voided Bills"  value={summary.voidedCount.toString()} sub={fmtShort(summary.voidedValue, currency)} />
          <KpiCard label="Net Profit"    value={fmtShort(summary.netProfit, currency)} sub={`after ${fmtShort(summary.totalExpenses, currency)} expenses`} />
        </div>
      </div>

      {/* Channel + payments */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <SectionCard title="Order Channels">
          <div className="space-y-2.5">
            {channels.filter(c => c.amount > 0).sort((a, b) => b.amount - a.amount).map(ch => (
              <div key={ch.channel}>
                <div className="flex justify-between text-sm mb-1">
                  <span className="text-gray-700 dark:text-gray-200">{CHANNEL_LABELS[ch.channel] ?? ch.channel}</span>
                  <span className="font-medium tabular-nums text-gray-900 dark:text-white">
                    {fmtShort(ch.amount, currency)} <span className="text-gray-400 font-normal">{pct(ch.pct)}</span>
                  </span>
                </div>
                <div className="h-1.5 bg-gray-100 dark:bg-gray-700 rounded-full overflow-hidden">
                  <div className={`h-full rounded-full ${CHANNEL_BAR_COLORS[ch.channel] ?? 'bg-gray-400'}`}
                    style={{ width: `${(ch.amount / maxCh) * 100}%` }} />
                </div>
              </div>
            ))}
          </div>
        </SectionCard>

        <SectionCard title="Payment Methods">
          <table className="w-full text-sm">
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
              {payments.sort((a, b) => b.amount - a.amount).map(p => (
                <tr key={p.method}>
                  <td className="py-2 text-gray-700 dark:text-gray-300 capitalize">{p.method.replace(/_/g, ' ')}</td>
                  <td className="py-2 text-right font-medium tabular-nums text-gray-900 dark:text-white">{fmtShort(p.amount, currency)}</td>
                  <td className="py-2 text-right text-gray-400 w-14">{pct(summary.totalRevenue > 0 ? (p.amount / summary.totalRevenue) * 100 : 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </SectionCard>
      </div>

      {/* Category breakdown */}
      <SectionCard title="Category Breakdown">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 dark:border-gray-700">
              <Th>Category</Th>
              <Th>Super Category</Th>
              <Th right>Qty</Th>
              <Th right>Net Sales</Th>
              <Th right>Share</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50 dark:divide-gray-700/50">
            {categoryBreakdown.map(row => (
              <tr key={row.category}>
                <td className="py-2 text-gray-800 dark:text-gray-200">{row.category}</td>
                <td className="py-2 text-gray-400 dark:text-gray-500 text-xs">{row.superCategory}</td>
                <td className="py-2 text-right tabular-nums text-gray-700 dark:text-gray-300">{row.qty.toLocaleString()}</td>
                <td className="py-2 text-right tabular-nums font-medium text-gray-900 dark:text-white">{fmtShort(row.netSales, currency)}</td>
                <td className="py-2 text-right text-gray-400 text-xs">{pct(summary.totalRevenue > 0 ? (row.netSales / summary.totalRevenue) * 100 : 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </SectionCard>

      {/* Expenses */}
      {expenses.total > 0 && (
        <SectionCard title={`Expenses — ${fmtShort(expenses.total, currency)} total`}>
          <table className="w-full text-sm">
            <tbody className="divide-y divide-gray-50 dark:divide-gray-700/50">
              {expenses.breakdown.map(e => (
                <tr key={e.category}>
                  <td className="py-2 text-gray-700 dark:text-gray-300">{e.category}</td>
                  <td className="py-2 text-right font-medium tabular-nums text-gray-900 dark:text-white">{fmtShort(e.amount, currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </SectionCard>
      )}
    </div>
  );
}

// ── Tab: Hourly Sales ─────────────────────────────────────────────────────────

function HourlyTab({ range, branchId, currency }: { range: DateRange; branchId: string; currency: string }) {
  const [data, setData]       = useState<HourlyReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const p = new URLSearchParams({ from: range.from, to: range.to });
      if (branchId) p.set('branch_id', branchId);
      setData(await api.get<HourlyReport>(`/api/reports/hourly?${p}`));
    } catch (e: any) { setError(e.message ?? 'Failed'); }
    finally { setLoading(false); }
  }, [range.from, range.to, branchId]);
  useEffect(() => { load(); }, [load]);

  if (loading) return <Spinner />;
  if (error)   return <ErrMsg msg={error} />;
  if (!data)   return null;

  const maxH   = Math.max(...data.hourly.map(h => h.revenue), 1);
  const maxDow = Math.max(...data.dayOfWeek.map(d => d.revenue), 1);
  const activeHours = data.hourly.filter(h => h.orders > 0);

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <KpiCard label="Peak Hour" value={data.peakHour != null ? `${String(data.peakHour).padStart(2,'0')}:00` : '—'} sub={fmtShort(data.peakRevenue, currency)} accent />
        <KpiCard label="Active Hours" value={activeHours.length.toString()} sub="hours with sales" />
        <KpiCard label="Avg / Active Hour" value={fmtShort(activeHours.reduce((s,h)=>s+h.revenue,0) / Math.max(activeHours.length,1), currency)} />
      </div>

      <SectionCard title="Revenue by Hour">
        <div className="overflow-x-auto">
          <div className="flex items-end gap-0.5 h-36 min-w-[600px]">
            {data.hourly.map(h => {
              const barH = h.revenue > 0 ? Math.max(3, (h.revenue / maxH) * 100) : 0;
              const isPeak = h.hour === data.peakHour;
              return (
                <div key={h.hour} title={`${h.label}: ${fmtShort(h.revenue, currency)} (${h.orders} orders)`}
                  className="flex flex-col items-center flex-1 cursor-default">
                  <div className={`w-full rounded-t transition-all ${isPeak ? 'bg-blue-600' : 'bg-blue-200 dark:bg-blue-900 hover:bg-blue-400'}`}
                    style={{ height: `${barH}%` }} />
                  <span className="text-[10px] text-gray-400 mt-1">{h.hour}</span>
                </div>
              );
            })}
          </div>
        </div>
      </SectionCard>

      <SectionCard title="Revenue by Day of Week">
        <div className="flex items-end gap-2 h-24">
          {data.dayOfWeek.map(d => {
            const barH = d.revenue > 0 ? Math.max(3, (d.revenue / maxDow) * 100) : 0;
            return (
              <div key={d.day} title={`${d.day}: ${fmtShort(d.revenue, currency)}`}
                className="flex flex-col items-center flex-1 cursor-default">
                <div className="w-full rounded-t bg-purple-200 dark:bg-purple-900 hover:bg-purple-500 transition-all"
                  style={{ height: `${barH}%` }} />
                <span className="text-xs text-gray-500 dark:text-gray-400 mt-1">{d.day}</span>
              </div>
            );
          })}
        </div>
      </SectionCard>

      <SectionCard title="Hourly Detail">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 dark:border-gray-700">
              <Th>Hour</Th><Th right>Orders</Th><Th right>Revenue</Th><Th right>Avg Order</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50 dark:divide-gray-700/50">
            {activeHours.map(h => (
              <tr key={h.hour} className={h.hour === data.peakHour ? 'bg-blue-50 dark:bg-blue-900/20' : ''}>
                <td className="py-1.5 text-gray-700 dark:text-gray-300">
                  {h.label}
                  {h.hour === data.peakHour && <span className="ml-2 text-[10px] bg-blue-100 dark:bg-blue-800 text-blue-700 dark:text-blue-200 px-1.5 py-0.5 rounded">peak</span>}
                </td>
                <td className="py-1.5 text-right tabular-nums text-gray-600 dark:text-gray-400">{h.orders}</td>
                <td className="py-1.5 text-right tabular-nums font-medium text-gray-900 dark:text-white">{fmtShort(h.revenue, currency)}</td>
                <td className="py-1.5 text-right tabular-nums text-gray-500">{fmtShort(h.avgOrderValue, currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </SectionCard>
    </div>
  );
}

// ── Tab: Item Mix ─────────────────────────────────────────────────────────────

function ItemMixTab({ range, branchId, currency }: { range: DateRange; branchId: string; currency: string }) {
  const [data, setData]       = useState<ProductV2Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const [search, setSearch]   = useState('');
  const [sortBy, setSortBy]   = useState<'revenue'|'qty'|'margin'>('revenue');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const p = new URLSearchParams({ from: range.from, to: range.to });
      if (branchId) p.set('branch_id', branchId);
      setData(await api.get<ProductV2Report>(`/api/reports/products-v2?${p}`));
    } catch (e: any) { setError(e.message ?? 'Failed'); }
    finally { setLoading(false); }
  }, [range.from, range.to, branchId]);
  useEffect(() => { load(); }, [load]);

  if (loading) return <Spinner />;
  if (error)   return <ErrMsg msg={error} />;
  if (!data)   return null;

  const filtered = data.products
    .filter(p => p.name.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => sortBy === 'qty' ? b.qty - a.qty : sortBy === 'margin' ? (b.gross_margin_pct ?? -99) - (a.gross_margin_pct ?? -99) : b.revenue - a.revenue);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <input type="search" placeholder="Search items…" value={search} onChange={e => setSearch(e.target.value)}
          className="flex-1 min-w-[200px] text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-1.5 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200" />
        <div className="flex gap-1 bg-gray-100 dark:bg-gray-700 p-1 rounded-lg">
          {(['revenue','qty','margin'] as const).map(s => (
            <button key={s} onClick={() => setSortBy(s)}
              className={`text-xs px-3 py-1 rounded-md transition-colors capitalize ${sortBy === s ? 'bg-white dark:bg-gray-600 shadow-sm text-gray-900 dark:text-white' : 'text-gray-500 dark:text-gray-400'}`}>
              {s}
            </button>
          ))}
        </div>
      </div>

      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-700/50">
              <tr>
                <th className="text-left text-xs text-gray-400 px-4 py-2.5 font-medium">#</th>
                <th className="text-left text-xs text-gray-400 px-2 py-2.5 font-medium">Item</th>
                <th className="text-left text-xs text-gray-400 px-2 py-2.5 font-medium">Category</th>
                <th className="text-right text-xs text-gray-400 px-2 py-2.5 font-medium">Qty</th>
                <th className="text-right text-xs text-gray-400 px-2 py-2.5 font-medium">Revenue</th>
                <th className="text-right text-xs text-gray-400 px-2 py-2.5 font-medium">Share</th>
                <th className="text-right text-xs text-gray-400 px-2 py-2.5 font-medium">Cost</th>
                <th className="text-right text-xs text-gray-400 px-4 py-2.5 font-medium">Margin</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50 dark:divide-gray-700/50">
              {filtered.map((p, i) => (
                <tr key={p.product_id} className="hover:bg-gray-50 dark:hover:bg-gray-700/30">
                  <td className="px-4 py-2 text-gray-300 dark:text-gray-600 text-xs tabular-nums">{i + 1}</td>
                  <td className="px-2 py-2 text-gray-800 dark:text-gray-200">{p.name}</td>
                  <td className="px-2 py-2 text-gray-500 dark:text-gray-400 text-xs">{p.category || '—'}</td>
                  <td className="px-2 py-2 text-right tabular-nums text-gray-700 dark:text-gray-300">{p.qty.toLocaleString()}</td>
                  <td className="px-2 py-2 text-right tabular-nums font-medium text-gray-900 dark:text-white">{fmtShort(p.revenue, currency)}</td>
                  <td className="px-2 py-2 text-right">
                    <div className="flex items-center justify-end gap-1.5">
                      <div className="w-14 bg-gray-100 dark:bg-gray-700 rounded-full h-1.5 overflow-hidden">
                        <div className="bg-blue-500 h-full rounded-full" style={{ width: `${p.contribution_pct}%` }} />
                      </div>
                      <span className="text-xs text-gray-400 tabular-nums w-9 text-right">{pct(p.contribution_pct)}</span>
                    </div>
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums text-gray-500 text-xs">
                    {p.total_cost != null ? fmtShort(p.total_cost, currency) : <span className="text-gray-300 dark:text-gray-600">—</span>}
                  </td>
                  <td className="px-4 py-2 text-right">
                    {p.gross_margin_pct != null
                      ? <span className={`text-xs font-medium tabular-nums ${p.gross_margin_pct >= 60 ? 'text-green-600' : p.gross_margin_pct >= 30 ? 'text-amber-600' : 'text-red-500'}`}>{pct(p.gross_margin_pct)}</span>
                      : <span className="text-gray-300 dark:text-gray-600 text-xs">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ── Tab: Voids & Exceptions ───────────────────────────────────────────────────

function VoidsTab({ range, branchId, currency }: { range: DateRange; branchId: string; currency: string }) {
  const [data, setData]       = useState<VoidsReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const p = new URLSearchParams({ from: range.from, to: range.to });
      if (branchId) p.set('branch_id', branchId);
      setData(await api.get<VoidsReport>(`/api/reports/voids?${p}`));
    } catch (e: any) { setError(e.message ?? 'Failed'); }
    finally { setLoading(false); }
  }, [range.from, range.to, branchId]);
  useEffect(() => { load(); }, [load]);

  if (loading) return <Spinner />;
  if (error)   return <ErrMsg msg={error} />;
  if (!data)   return null;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <KpiCard label="Total Voids"   value={data.summary.totalVoids.toString()} accent={data.summary.totalVoids > 0} />
        <KpiCard label="Voided Value"  value={fmtShort(data.summary.totalValue, currency)} />
        <KpiCard label="Staff Involved" value={data.summary.byStaff.length.toString()} />
      </div>

      {data.summary.byStaff.length > 0 && (
        <SectionCard title="Voids by Cashier">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 dark:border-gray-700">
                <Th>Cashier</Th><Th right>Count</Th><Th right>Value</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50 dark:divide-gray-700/50">
              {data.summary.byStaff.map(s => (
                <tr key={s.cashier_id}>
                  <td className="py-2 text-gray-800 dark:text-gray-200">{s.name}</td>
                  <td className="py-2 text-right tabular-nums text-gray-600 dark:text-gray-400">{s.count}</td>
                  <td className="py-2 text-right tabular-nums font-medium text-red-600 dark:text-red-400">{fmtShort(s.value, currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </SectionCard>
      )}

      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100 dark:border-gray-700">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">Void Log</h3>
        </div>
        {data.voids.length === 0
          ? <p className="text-center text-gray-400 py-10 text-sm">No voids in this period ✓</p>
          : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 dark:bg-gray-700/50">
                  <tr>
                    <th className="text-left text-xs text-gray-400 px-4 py-2.5 font-medium">Order</th>
                    <th className="text-left text-xs text-gray-400 px-2 py-2.5 font-medium">Cashier</th>
                    <th className="text-left text-xs text-gray-400 px-2 py-2.5 font-medium">Authorized by</th>
                    <th className="text-left text-xs text-gray-400 px-2 py-2.5 font-medium">Reason</th>
                    <th className="text-right text-xs text-gray-400 px-2 py-2.5 font-medium">Amount</th>
                    <th className="text-right text-xs text-gray-400 px-4 py-2.5 font-medium">Time</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50 dark:divide-gray-700/50">
                  {data.voids.map(v => (
                    <tr key={v.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/30">
                      <td className="px-4 py-2 font-mono text-xs text-gray-500 dark:text-gray-400">{v.order_number}</td>
                      <td className="px-2 py-2 text-gray-700 dark:text-gray-300">{v.cashier_name}</td>
                      <td className="px-2 py-2 text-xs text-gray-600 dark:text-gray-400">{v.authorized_by_name ?? '—'}</td>
                      <td className="px-2 py-2 text-gray-500 dark:text-gray-400 text-xs">{v.void_reason || '—'}</td>
                      <td className="px-2 py-2 text-right tabular-nums text-red-600 dark:text-red-400 font-medium">{fmtShort(v.total, currency)}</td>
                      <td className="px-4 py-2 text-right text-xs text-gray-400">
                        {new Date(v.created_at).toLocaleString('en-KE', { dateStyle: 'short', timeStyle: 'short' })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </div>
    </div>
  );
}

// ── Tab: Tax Report ───────────────────────────────────────────────────────────

function TaxTab({ range, branchId, currency }: { range: DateRange; branchId: string; currency: string }) {
  const [data, setData]       = useState<TaxReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const p = new URLSearchParams({ from: range.from, to: range.to });
      if (branchId) p.set('branch_id', branchId);
      setData(await api.get<TaxReport>(`/api/reports/tax?${p}`));
    } catch (e: any) { setError(e.message ?? 'Failed'); }
    finally { setLoading(false); }
  }, [range.from, range.to, branchId]);
  useEffect(() => { load(); }, [load]);

  if (loading) return <Spinner />;
  if (error)   return <ErrMsg msg={error} />;
  if (!data)   return null;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <KpiCard label="Gross Sales"               value={fmtShort(data.summary.grossSales, currency)} />
        <KpiCard label={`VAT ${data.rates.vatRate}%`} value={fmtShort(data.summary.vatTotal, currency)} />
        <KpiCard label={`CTL ${data.rates.ctlRate}%`} value={fmtShort(data.summary.ctlTotal, currency)} />
        <KpiCard label="Net Sales"                 value={fmtShort(data.summary.netSales, currency)} accent />
      </div>

      {data.byBranch.length > 1 && (
        <SectionCard title="By Branch">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 dark:border-gray-700">
                <Th>Branch</Th><Th right>Gross Sales</Th><Th right>VAT</Th><Th right>CTL</Th><Th right>Net Sales</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50 dark:divide-gray-700/50">
              {data.byBranch.map(b => (
                <tr key={b.branchName}>
                  <td className="py-2 text-gray-800 dark:text-gray-200">{b.branchName}</td>
                  <td className="py-2 text-right tabular-nums text-gray-700 dark:text-gray-300">{fmtShort(b.grossSales, currency)}</td>
                  <td className="py-2 text-right tabular-nums text-gray-500">{fmtShort(b.vatAmount, currency)}</td>
                  <td className="py-2 text-right tabular-nums text-gray-500">{fmtShort(b.ctlAmount, currency)}</td>
                  <td className="py-2 text-right tabular-nums font-medium text-gray-900 dark:text-white">{fmtShort(b.netSales, currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </SectionCard>
      )}

      <SectionCard title="By Category">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 dark:border-gray-700">
              <Th>Category</Th><Th right>Gross Sales</Th><Th right>VAT</Th><Th right>CTL</Th><Th right>Net Sales</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50 dark:divide-gray-700/50">
            {data.byCategory.map(c => (
              <tr key={c.category}>
                <td className="py-2 text-gray-800 dark:text-gray-200">{c.category}</td>
                <td className="py-2 text-right tabular-nums text-gray-700 dark:text-gray-300">{fmtShort(c.grossSales, currency)}</td>
                <td className="py-2 text-right tabular-nums text-gray-500">{fmtShort(c.vatAmount, currency)}</td>
                <td className="py-2 text-right tabular-nums text-gray-500">{fmtShort(c.ctlAmount, currency)}</td>
                <td className="py-2 text-right tabular-nums font-medium text-gray-900 dark:text-white">{fmtShort(c.netSales, currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </SectionCard>
    </div>
  );
}

// ── Tab: Staff Performance ─────────────────────────────────────────────────────

function StaffTab({ range, branchId, currency }: { range: DateRange; branchId: string; currency: string }) {
  const [data, setData]       = useState<StaffReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const p = new URLSearchParams({ from: range.from, to: range.to });
      if (branchId) p.set('branch_id', branchId);
      setData(await api.get<StaffReport>(`/api/reports/staff?${p}`));
    } catch (e: any) { setError(e.message ?? 'Failed'); }
    finally { setLoading(false); }
  }, [range.from, range.to, branchId]);
  useEffect(() => { load(); }, [load]);

  if (loading) return <Spinner />;
  if (error)   return <ErrMsg msg={error} />;
  if (!data)   return null;

  const total = data.staff.reduce((s, c) => s + c.revenue, 0);

  return (
    <div className="space-y-4">
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-700/50">
              <tr>
                <th className="text-left text-xs text-gray-400 px-4 py-2.5 font-medium">#</th>
                <th className="text-left text-xs text-gray-400 px-2 py-2.5 font-medium">Cashier</th>
                <th className="text-left text-xs text-gray-400 px-2 py-2.5 font-medium">Branch</th>
                <th className="text-right text-xs text-gray-400 px-2 py-2.5 font-medium">Orders</th>
                <th className="text-right text-xs text-gray-400 px-2 py-2.5 font-medium">Revenue</th>
                <th className="text-right text-xs text-gray-400 px-2 py-2.5 font-medium">Avg Order</th>
                <th className="text-right text-xs text-gray-400 px-4 py-2.5 font-medium">Share</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50 dark:divide-gray-700/50">
              {data.staff.map((s, i) => (
                <tr key={s.cashier_id} className="hover:bg-gray-50 dark:hover:bg-gray-700/30">
                  <td className="px-4 py-2.5 text-gray-300 dark:text-gray-600 text-xs tabular-nums">{i + 1}</td>
                  <td className="px-2 py-2.5 text-gray-800 dark:text-gray-200 font-medium">{s.name}</td>
                  <td className="px-2 py-2.5 text-gray-500 dark:text-gray-400 text-xs">{s.branch}</td>
                  <td className="px-2 py-2.5 text-right tabular-nums text-gray-600 dark:text-gray-400">{s.orders}</td>
                  <td className="px-2 py-2.5 text-right tabular-nums font-medium text-gray-900 dark:text-white">{fmtShort(s.revenue, currency)}</td>
                  <td className="px-2 py-2.5 text-right tabular-nums text-gray-500">{fmtShort(s.orders > 0 ? s.revenue / s.orders : 0, currency)}</td>
                  <td className="px-4 py-2.5 text-right">
                    <div className="flex items-center justify-end gap-1.5">
                      <div className="w-14 bg-gray-100 dark:bg-gray-700 rounded-full h-1.5 overflow-hidden">
                        <div className="bg-teal-500 h-full rounded-full" style={{ width: `${total > 0 ? (s.revenue / total) * 100 : 0}%` }} />
                      </div>
                      <span className="text-xs text-gray-400 tabular-nums w-9 text-right">{pct(total > 0 ? (s.revenue / total) * 100 : 0)}</span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────


// ── Tab: Food Cost — Ideal vs Actual ─────────────────────────────────────────

interface FoodCostReport {
  period: { from: string; to: string };
  summary: {
    totalRevenue: number; totalIdealCost: number;
    totalActualCost: number | null; foodCostPct: number; variance: number | null;
  };
  products: {
    product_id: string; name: string; qtySold: number;
    revenue: number; idealCost: number; grossMargin: number; costPct: number;
  }[];
  ingredients: {
    ingredient_id: string; name: string; unit: string; unit_cost: number | null;
    idealQty: number; actualQty: number; variance: number; variancePct: number;
    idealCost: number; actualCost: number | null;
  }[];
}

function FoodCostTab({ range, branchId, currency }: { range: DateRange; branchId: string; currency: string }) {
  const [data, setData]         = useState<FoodCostReport | null>(null);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState('');
  const [view, setView]         = useState<'ingredients' | 'products'>('ingredients');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const p = new URLSearchParams({ from: range.from, to: range.to });
      if (branchId) p.set('branch_id', branchId);
      setData(await api.get<FoodCostReport>(`/api/reports/food-cost?${p}`));
    } catch (e: any) { setError(e.message ?? 'Failed'); }
    finally { setLoading(false); }
  }, [range.from, range.to, branchId]);
  useEffect(() => { load(); }, [load]);

  if (loading) return <Spinner />;
  if (error)   return <ErrMsg msg={error} />;
  if (!data)   return null;

  const { summary, products, ingredients } = data;
  const hasActual = summary.totalActualCost !== null;

  if (products.length === 0 && ingredients.length === 0) {
    return (
      <div className="text-center py-16">
        <p className="text-3xl mb-3">🍳</p>
        <p className="text-gray-400 text-sm mb-1">No food cost data for this period.</p>
        <p className="text-gray-500 text-xs">Make sure your recipes have ingredients, and ingredients have unit costs set in Stock → Ingredients.</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* KPI row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <KpiCard label="Revenue"         value={fmtShort(summary.totalRevenue, currency)} />
        <KpiCard label="Ideal food cost" value={fmtShort(summary.totalIdealCost, currency)}
          sub={`${pct(summary.foodCostPct)} of revenue`} />
        {hasActual ? (
          <KpiCard label="Actual food cost" value={fmtShort(summary.totalActualCost!, currency)}
            sub={summary.variance! > 0 ? `+${fmtShort(summary.variance!, currency)} over ideal` : `${fmtShort(summary.variance!, currency)} vs ideal`}
            accent={summary.variance! > 0} />
        ) : (
          <KpiCard label="Actual food cost" value="—"
            sub="No stock movements yet" />
        )}
        <KpiCard label="Food cost %"     value={pct(summary.foodCostPct)}
          sub={summary.foodCostPct > 35 ? '⚠ Above 35% target' : '✓ Within target'} />
      </div>

      {/* Food cost % visual gauge */}
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500">Food cost % gauge</h3>
          <span className={`text-sm font-bold ${summary.foodCostPct > 35 ? 'text-red-500' : summary.foodCostPct > 28 ? 'text-amber-500' : 'text-green-600'}`}>
            {pct(summary.foodCostPct)}
          </span>
        </div>
        <div className="relative h-4 bg-gray-100 dark:bg-gray-700 rounded-full overflow-hidden">
          {/* Zones */}
          <div className="absolute inset-0 flex">
            <div className="h-full bg-green-100 dark:bg-green-900/30" style={{ width: '28%' }} />
            <div className="h-full bg-amber-100 dark:bg-amber-900/30" style={{ width: '7%' }} />
            <div className="h-full bg-red-100 dark:bg-red-900/20 flex-1" />
          </div>
          {/* Bar */}
          <div className="absolute inset-0 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${summary.foodCostPct > 35 ? 'bg-red-500' : summary.foodCostPct > 28 ? 'bg-amber-500' : 'bg-green-500'}`}
              style={{ width: `${Math.min(100, summary.foodCostPct)}%` }}
            />
          </div>
          {/* 28% marker */}
          <div className="absolute top-0 bottom-0" style={{ left: '28%', borderLeft: '2px dashed rgba(0,0,0,0.2)' }} />
          {/* 35% marker */}
          <div className="absolute top-0 bottom-0" style={{ left: '35%', borderLeft: '2px dashed rgba(0,0,0,0.2)' }} />
        </div>
        <div className="flex justify-between text-[10px] text-gray-400 mt-1">
          <span>0%</span>
          <span className="text-green-600">28% good</span>
          <span className="text-amber-500">35% target</span>
          <span className="text-red-500 ml-auto">too high</span>
        </div>
      </div>

      {/* View toggle */}
      <div className="flex gap-1 bg-gray-100 dark:bg-gray-700 p-1 rounded-lg w-fit">
        {(['ingredients', 'products'] as const).map(v => (
          <button key={v} onClick={() => setView(v)}
            className={`text-xs px-4 py-1.5 rounded-md transition-colors capitalize ${view === v ? 'bg-white dark:bg-gray-600 shadow-sm text-gray-900 dark:text-white' : 'text-gray-500 dark:text-gray-400'}`}>
            {v === 'ingredients' ? 'Ingredient variance' : 'Cost per dish'}
          </button>
        ))}
      </div>

      {/* Ingredient variance table */}
      {view === 'ingredients' && (
        <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 dark:bg-gray-700/50">
                <tr>
                  <th className="text-left text-xs text-gray-400 px-4 py-2.5 font-medium">Ingredient</th>
                  <th className="text-right text-xs text-gray-400 px-2 py-2.5 font-medium">Ideal qty</th>
                  <th className="text-right text-xs text-gray-400 px-2 py-2.5 font-medium">Actual qty</th>
                  <th className="text-right text-xs text-gray-400 px-2 py-2.5 font-medium">Variance</th>
                  <th className="text-right text-xs text-gray-400 px-2 py-2.5 font-medium">Ideal cost</th>
                  <th className="text-right text-xs text-gray-400 px-4 py-2.5 font-medium">Actual cost</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50 dark:divide-gray-700/50">
                {ingredients.map(ing => {
                  const over    = ing.variance > 0;
                  const noData  = ing.actualCost === null;
                  return (
                    <tr key={ing.ingredient_id} className={over && !noData ? 'bg-red-50/40 dark:bg-red-900/10' : ''}>
                      <td className="px-4 py-2.5">
                        <p className="text-gray-800 dark:text-gray-200 font-medium">{ing.name}</p>
                        <p className="text-gray-400 text-xs">{ing.unit}{ing.unit_cost ? ` · ${fmtShort(ing.unit_cost, currency)}/${ing.unit}` : ''}</p>
                      </td>
                      <td className="px-2 py-2.5 text-right tabular-nums text-gray-600 dark:text-gray-400">
                        {ing.idealQty.toLocaleString()} {ing.unit}
                      </td>
                      <td className="px-2 py-2.5 text-right tabular-nums text-gray-600 dark:text-gray-400">
                        {noData ? <span className="text-gray-300 dark:text-gray-600">—</span> : `${ing.actualQty.toLocaleString()} ${ing.unit}`}
                      </td>
                      <td className="px-2 py-2.5 text-right tabular-nums font-medium">
                        {noData ? <span className="text-gray-300 dark:text-gray-600">—</span> : (
                          <span className={over ? 'text-red-500' : ing.variance < 0 ? 'text-green-600' : 'text-gray-500'}>
                            {over ? '+' : ''}{ing.variance.toLocaleString()} {ing.unit}
                            <span className="text-xs font-normal ml-1">({over ? '+' : ''}{ing.variancePct}%)</span>
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-2.5 text-right tabular-nums text-gray-600 dark:text-gray-400">
                        {fmtShort(ing.idealCost, currency)}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums font-medium">
                        {noData ? <span className="text-gray-300 dark:text-gray-600">—</span> : (
                          <span className={over ? 'text-red-500' : 'text-gray-700 dark:text-gray-300'}>
                            {fmtShort(ing.actualCost!, currency)}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {!hasActual && (
            <div className="px-4 py-3 border-t border-gray-100 dark:border-gray-700 bg-amber-50/50 dark:bg-amber-900/10">
              <p className="text-xs text-amber-600 dark:text-amber-400">
                Actual quantities will appear once stock movements are recorded. They are logged automatically when orders are placed.
              </p>
            </div>
          )}
        </div>
      )}

      {/* Cost per dish table */}
      {view === 'products' && (
        <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 dark:bg-gray-700/50">
                <tr>
                  <th className="text-left text-xs text-gray-400 px-4 py-2.5 font-medium">Dish</th>
                  <th className="text-right text-xs text-gray-400 px-2 py-2.5 font-medium">Qty sold</th>
                  <th className="text-right text-xs text-gray-400 px-2 py-2.5 font-medium">Revenue</th>
                  <th className="text-right text-xs text-gray-400 px-2 py-2.5 font-medium">Ideal cost</th>
                  <th className="text-right text-xs text-gray-400 px-2 py-2.5 font-medium">Cost %</th>
                  <th className="text-right text-xs text-gray-400 px-4 py-2.5 font-medium">Gross margin</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50 dark:divide-gray-700/50">
                {products.map(p => (
                  <tr key={p.product_id}>
                    <td className="px-4 py-2.5 font-medium text-gray-800 dark:text-gray-200">{p.name}</td>
                    <td className="px-2 py-2.5 text-right tabular-nums text-gray-600 dark:text-gray-400">{p.qtySold.toLocaleString()}</td>
                    <td className="px-2 py-2.5 text-right tabular-nums text-gray-700 dark:text-gray-300">{fmtShort(p.revenue, currency)}</td>
                    <td className="px-2 py-2.5 text-right tabular-nums text-gray-600 dark:text-gray-400">{fmtShort(p.idealCost, currency)}</td>
                    <td className="px-2 py-2.5 text-right tabular-nums">
                      <span className={`font-medium ${p.costPct > 35 ? 'text-red-500' : p.costPct > 28 ? 'text-amber-500' : 'text-green-600'}`}>
                        {pct(p.costPct)}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums font-medium">
                      <span className={p.grossMargin >= 60 ? 'text-green-600' : p.grossMargin >= 40 ? 'text-amber-500' : 'text-red-500'}>
                        {pct(p.grossMargin)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}


interface AggregatorReport {
  period: { from: string; to: string };
  summary: { totalGross: number; totalComm: number; totalNet: number; totalOrders: number };
  platforms: {
    platform: string; orders: number; grossRevenue: number;
    commissionPct: number; commissionAmount: number; netRevenue: number;
  }[];
  commissions: Record<string, number>;
}

const PLATFORM_LABELS: Record<string, string> = {
  bolt: 'Bolt Food', ubereats: 'Uber Eats', jumia: 'Jumia Food',
  glovo: 'Glovo', instashop: 'InstaShop',
};
const PLATFORM_COLORS: Record<string, string> = {
  bolt: '#34d399', ubereats: '#f97316', jumia: '#f59e0b',
  glovo: '#a78bfa', instashop: '#60a5fa',
};

function AggregatorTab({ range, branchId, currency }: { range: DateRange; branchId: string; currency: string }) {
  const [data, setData]               = useState<AggregatorReport | null>(null);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState('');
  const [editComm, setEditComm]       = useState<Record<string, string>>({});
  const [savingComm, setSavingComm]   = useState(false);
  const [commSaved, setCommSaved]     = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const p = new URLSearchParams({ from: range.from, to: range.to });
      if (branchId) p.set('branch_id', branchId);
      const d = await api.get<AggregatorReport>(`/api/reports/aggregator?${p}`);
      setData(d);
      // Pre-fill commission editor with current values
      const vals: Record<string, string> = {};
      Object.entries(d.commissions ?? {}).forEach(([k, v]) => { vals[k] = String(v); });
      setEditComm(vals);
    } catch (e: any) { setError(e.message ?? 'Failed'); }
    finally { setLoading(false); }
  }, [range.from, range.to, branchId]);
  useEffect(() => { load(); }, [load]);

  async function saveCommissions() {
    setSavingComm(true);
    try {
      await Promise.all(
        Object.entries(editComm).map(([platform, pct]) =>
          api.post('/api/business/settings', {
            key: `aggregator_commission_${platform}`,
            value: String(parseFloat(pct) || 0),
          })
        )
      );
      setCommSaved(true);
      setTimeout(() => setCommSaved(false), 2500);
      await load();
    } finally { setSavingComm(false); }
  }

  if (loading) return <Spinner />;
  if (error)   return <ErrMsg msg={error} />;
  if (!data)   return null;

  const { summary, platforms } = data;
  const maxGross = Math.max(...platforms.map(p => p.grossRevenue), 1);

  if (platforms.length === 0) {
    return (
      <div className="text-center py-16">
        <p className="text-3xl mb-3">🚀</p>
        <p className="text-gray-400 text-sm mb-1">No aggregator orders in this period.</p>
        <p className="text-gray-500 text-xs">Orders with type "aggregator" and an aggregator_name will appear here.</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Summary KPIs */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <KpiCard label="Gross Revenue"   value={fmtShort(summary.totalGross, currency)} />
        <KpiCard label="Total Commission" value={fmtShort(summary.totalComm, currency)} />
        <KpiCard label="Net Revenue"     value={fmtShort(summary.totalNet, currency)} accent />
        <KpiCard label="Total Orders"    value={summary.totalOrders.toString()} />
      </div>

      {/* Platform breakdown */}
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-4">
          Revenue by Platform
        </h3>
        <div className="space-y-4">
          {platforms.map(p => {
            const label = PLATFORM_LABELS[p.platform] ?? p.platform;
            const color = PLATFORM_COLORS[p.platform] ?? '#6b7280';
            const barW  = Math.max(2, (p.grossRevenue / maxGross) * 100);
            return (
              <div key={p.platform}>
                <div className="flex items-center justify-between text-sm mb-1.5">
                  <div className="flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: color }} />
                    <span className="font-medium text-gray-800 dark:text-gray-200 capitalize">{label}</span>
                    <span className="text-gray-400 text-xs">{p.orders} orders</span>
                  </div>
                  <div className="flex items-center gap-4 tabular-nums">
                    <span className="text-gray-500 dark:text-gray-400 text-xs">
                      −{fmtShort(p.commissionAmount, currency)} ({p.commissionPct}% comm)
                    </span>
                    <span className="font-semibold text-gray-900 dark:text-white">
                      {fmtShort(p.netRevenue, currency)} net
                    </span>
                  </div>
                </div>
                <div className="h-2 bg-gray-100 dark:bg-gray-700 rounded-full overflow-hidden">
                  <div className="h-full rounded-full" style={{ width: `${barW}%`, background: color }} />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Detail table */}
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-700/50">
              <tr>
                <th className="text-left text-xs text-gray-400 px-4 py-2.5 font-medium">Platform</th>
                <th className="text-right text-xs text-gray-400 px-2 py-2.5 font-medium">Orders</th>
                <th className="text-right text-xs text-gray-400 px-2 py-2.5 font-medium">Gross</th>
                <th className="text-right text-xs text-gray-400 px-2 py-2.5 font-medium">Commission</th>
                <th className="text-right text-xs text-gray-400 px-4 py-2.5 font-medium">Net Revenue</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50 dark:divide-gray-700/50">
              {platforms.map(p => (
                <tr key={p.platform}>
                  <td className="px-4 py-2.5 font-medium text-gray-800 dark:text-gray-200 capitalize">
                    {PLATFORM_LABELS[p.platform] ?? p.platform}
                  </td>
                  <td className="px-2 py-2.5 text-right tabular-nums text-gray-600 dark:text-gray-400">{p.orders}</td>
                  <td className="px-2 py-2.5 text-right tabular-nums text-gray-700 dark:text-gray-300">{fmtShort(p.grossRevenue, currency)}</td>
                  <td className="px-2 py-2.5 text-right tabular-nums text-red-500">
                    −{fmtShort(p.commissionAmount, currency)}
                    <span className="text-gray-400 text-xs ml-1">({p.commissionPct}%)</span>
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums font-semibold text-gray-900 dark:text-white">
                    {fmtShort(p.netRevenue, currency)}
                  </td>
                </tr>
              ))}
              <tr className="bg-gray-50 dark:bg-gray-700/30 font-semibold">
                <td className="px-4 py-2.5 text-gray-700 dark:text-gray-300">Total</td>
                <td className="px-2 py-2.5 text-right tabular-nums text-gray-700 dark:text-gray-300">{summary.totalOrders}</td>
                <td className="px-2 py-2.5 text-right tabular-nums text-gray-700 dark:text-gray-300">{fmtShort(summary.totalGross, currency)}</td>
                <td className="px-2 py-2.5 text-right tabular-nums text-red-500">−{fmtShort(summary.totalComm, currency)}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-gray-900 dark:text-white">{fmtShort(summary.totalNet, currency)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* Commission editor */}
      {platforms.length > 0 && (
        <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-3">
            Commission rates
          </h3>
          <p className="text-xs text-gray-400 dark:text-gray-500 mb-3">
            Set the commission % each platform charges. Saved per business and applied to future calculations.
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-3">
            {platforms.map(p => (
              <div key={p.platform}>
                <label className="block text-xs text-gray-500 mb-1 capitalize">
                  {PLATFORM_LABELS[p.platform] ?? p.platform} %
                </label>
                <input
                  type="number" min="0" max="100" step="0.5"
                  value={editComm[p.platform] ?? '0'}
                  onChange={e => setEditComm(prev => ({ ...prev, [p.platform]: e.target.value }))}
                  className="w-full text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-1.5 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200"
                />
              </div>
            ))}
          </div>
          <button onClick={saveCommissions} disabled={savingComm}
            className="text-xs px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white rounded-lg transition-colors font-medium">
            {savingComm ? 'Saving…' : commSaved ? '✓ Saved' : 'Save commission rates'}
          </button>
        </div>
      )}
    </div>
  );
}


// ── Tab: SPLH & Labour Cost ───────────────────────────────────────────────────

interface SplhReport {
  period: { from: string; to: string };
  summary: {
    totalRevenue: number; totalHours: number; splh: number;
    totalLabour: number | null; labourCostPct: number | null;
  };
  shifts: {
    shift_id: string; cashier_name: string; branch_name: string;
    opened_at: string; closed_at: string; hours: number; revenue: number;
    splh: number; hourly_rate: number | null; labour_cost: number | null; labour_pct: number | null;
  }[];
  staff: {
    cashier_id: string; name: string; shifts: number;
    totalHours: number; totalRevenue: number; splh: number;
    totalLabour: number | null; labour_pct: number | null;
  }[];
}

function SplhTab({ range, branchId, currency }: { range: DateRange; branchId: string; currency: string }) {
  const [data, setData]       = useState<SplhReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const [view, setView]       = useState<'staff' | 'shifts'>('staff');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const p = new URLSearchParams({ from: range.from, to: range.to });
      if (branchId) p.set('branch_id', branchId);
      setData(await api.get<SplhReport>(`/api/reports/splh?${p}`));
    } catch (e: any) { setError(e.message ?? 'Failed'); }
    finally { setLoading(false); }
  }, [range.from, range.to, branchId]);
  useEffect(() => { load(); }, [load]);

  if (loading) return <Spinner />;
  if (error)   return <ErrMsg msg={error} />;
  if (!data)   return null;

  const { summary, staff, shifts } = data;

  const splhColor = (v: number) =>
    v >= 2000 ? 'text-green-600' : v >= 1000 ? 'text-amber-500' : 'text-red-500';

  const labourColor = (v: number | null) =>
    v === null ? 'text-gray-400' : v <= 25 ? 'text-green-600' : v <= 35 ? 'text-amber-500' : 'text-red-500';

  function fmtHours(h: number) {
    const hrs  = Math.floor(h);
    const mins = Math.round((h - hrs) * 60);
    return mins > 0 ? `${hrs}h ${mins}m` : `${hrs}h`;
  }

  function fmtShiftTime(iso: string) {
    return new Date(iso).toLocaleString('en-KE', { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  if (summary.totalHours === 0) {
    return (
      <div className="text-center py-16">
        <p className="text-3xl mb-3">⏱️</p>
        <p className="text-gray-400 text-sm mb-1">No closed shifts in this period.</p>
        <p className="text-gray-500 text-xs">SPLH is calculated from shifts that have been opened and closed at the POS.</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* KPI row */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        <KpiCard label="Revenue"       value={fmtShort(summary.totalRevenue, currency)} />
        <KpiCard label="Hours worked"  value={fmtHours(summary.totalHours)} />
        <KpiCard label="SPLH"          value={fmtShort(summary.splh, currency)}
          sub="Sales per labour hour" accent />
        <KpiCard label="Labour cost"
          value={summary.totalLabour !== null ? fmtShort(summary.totalLabour, currency) : '—'}
          sub={summary.labourCostPct !== null ? `${pct(summary.labourCostPct)} of revenue` : 'Set hourly rates in Staff'} />
        <KpiCard label="Labour cost %"
          value={summary.labourCostPct !== null ? pct(summary.labourCostPct) : '—'}
          sub={summary.labourCostPct !== null
            ? (summary.labourCostPct <= 25 ? '✓ Within target' : '⚠ Above 25% target')
            : 'Requires hourly rates'} />
      </div>

      {/* SPLH gauge */}
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500">SPLH gauge</h3>
          <span className={`text-sm font-bold tabular-nums ${splhColor(summary.splh)}`}>
            {fmtShort(summary.splh, currency)}/hr
          </span>
        </div>
        <div className="relative h-3 bg-gray-100 dark:bg-gray-700 rounded-full overflow-hidden">
          <div className="absolute inset-0 flex">
            <div className="h-full bg-red-100   dark:bg-red-900/20"   style={{ width: '33%' }} />
            <div className="h-full bg-amber-100 dark:bg-amber-900/20" style={{ width: '22%' }} />
            <div className="h-full bg-green-100 dark:bg-green-900/20 flex-1" />
          </div>
          <div className="absolute inset-0 rounded-full overflow-hidden">
            <div className={`h-full rounded-full transition-all ${splhColor(summary.splh).replace('text-', 'bg-')}`}
              style={{ width: `${Math.min(100, (summary.splh / 3000) * 100)}%` }} />
          </div>
          <div className="absolute top-0 bottom-0" style={{ left: '33%', borderLeft: '2px dashed rgba(0,0,0,0.15)' }} />
          <div className="absolute top-0 bottom-0" style={{ left: '55%', borderLeft: '2px dashed rgba(0,0,0,0.15)' }} />
        </div>
        <div className="flex text-[10px] text-gray-400 mt-1 gap-4">
          <span className="text-red-500">Low</span>
          <span className="text-amber-500 ml-auto">KES 1,000/hr avg</span>
          <span className="text-green-600">KES 2,000/hr+ good</span>
        </div>
      </div>

      {/* View toggle */}
      <div className="flex gap-1 bg-gray-100 dark:bg-gray-700 p-1 rounded-lg w-fit">
        {(['staff', 'shifts'] as const).map(v => (
          <button key={v} onClick={() => setView(v)}
            className={`text-xs px-4 py-1.5 rounded-md transition-colors capitalize ${view === v ? 'bg-white dark:bg-gray-600 shadow-sm text-gray-900 dark:text-white' : 'text-gray-500 dark:text-gray-400'}`}>
            {v === 'staff' ? 'By staff member' : 'Shift log'}
          </button>
        ))}
      </div>

      {/* Staff rollup table */}
      {view === 'staff' && (
        <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 dark:bg-gray-700/50">
                <tr>
                  <th className="text-left   text-xs text-gray-400 px-4 py-2.5 font-medium">Staff</th>
                  <th className="text-right  text-xs text-gray-400 px-2 py-2.5 font-medium">Shifts</th>
                  <th className="text-right  text-xs text-gray-400 px-2 py-2.5 font-medium">Hours</th>
                  <th className="text-right  text-xs text-gray-400 px-2 py-2.5 font-medium">Revenue</th>
                  <th className="text-right  text-xs text-gray-400 px-2 py-2.5 font-medium">SPLH</th>
                  <th className="text-right  text-xs text-gray-400 px-2 py-2.5 font-medium">Labour cost</th>
                  <th className="text-right  text-xs text-gray-400 px-4 py-2.5 font-medium">Labour %</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50 dark:divide-gray-700/50">
                {staff.map(s => (
                  <tr key={s.cashier_id}>
                    <td className="px-4 py-2.5 font-medium text-gray-800 dark:text-gray-200">{s.name}</td>
                    <td className="px-2 py-2.5 text-right tabular-nums text-gray-500">{s.shifts}</td>
                    <td className="px-2 py-2.5 text-right tabular-nums text-gray-600 dark:text-gray-400">{fmtHours(s.totalHours)}</td>
                    <td className="px-2 py-2.5 text-right tabular-nums text-gray-700 dark:text-gray-300">{fmtShort(s.totalRevenue, currency)}</td>
                    <td className="px-2 py-2.5 text-right tabular-nums font-bold">
                      <span className={splhColor(s.splh)}>{fmtShort(s.splh, currency)}</span>
                    </td>
                    <td className="px-2 py-2.5 text-right tabular-nums text-gray-600 dark:text-gray-400">
                      {s.totalLabour !== null ? fmtShort(s.totalLabour, currency) : <span className="text-gray-300 dark:text-gray-600">—</span>}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums font-semibold">
                      {s.labour_pct !== null
                        ? <span className={labourColor(s.labour_pct)}>{pct(s.labour_pct)}</span>
                        : <span className="text-gray-300 dark:text-gray-600 text-xs font-normal">No rate set</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {staff.some(s => s.labour_pct === null) && (
            <div className="px-4 py-2.5 border-t border-gray-100 dark:border-gray-700 bg-amber-50/50 dark:bg-amber-900/10">
              <p className="text-xs text-amber-600 dark:text-amber-400">
                Labour cost % requires hourly rates. Set them in Setup → Staff Management → edit a staff member.
              </p>
            </div>
          )}
        </div>
      )}

      {/* Shift log */}
      {view === 'shifts' && (
        <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 dark:bg-gray-700/50">
                <tr>
                  <th className="text-left  text-xs text-gray-400 px-4 py-2.5 font-medium">Cashier</th>
                  <th className="text-left  text-xs text-gray-400 px-2 py-2.5 font-medium">Branch</th>
                  <th className="text-left  text-xs text-gray-400 px-2 py-2.5 font-medium">Opened</th>
                  <th className="text-right text-xs text-gray-400 px-2 py-2.5 font-medium">Hours</th>
                  <th className="text-right text-xs text-gray-400 px-2 py-2.5 font-medium">Revenue</th>
                  <th className="text-right text-xs text-gray-400 px-2 py-2.5 font-medium">SPLH</th>
                  <th className="text-right text-xs text-gray-400 px-4 py-2.5 font-medium">Labour %</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50 dark:divide-gray-700/50">
                {shifts.map(s => (
                  <tr key={s.shift_id}>
                    <td className="px-4 py-2.5 font-medium text-gray-800 dark:text-gray-200">{s.cashier_name}</td>
                    <td className="px-2 py-2.5 text-gray-500 dark:text-gray-400 text-xs">{s.branch_name}</td>
                    <td className="px-2 py-2.5 text-gray-500 dark:text-gray-400 text-xs">{fmtShiftTime(s.opened_at)}</td>
                    <td className="px-2 py-2.5 text-right tabular-nums text-gray-600 dark:text-gray-400">{fmtHours(s.hours)}</td>
                    <td className="px-2 py-2.5 text-right tabular-nums text-gray-700 dark:text-gray-300">{fmtShort(s.revenue, currency)}</td>
                    <td className="px-2 py-2.5 text-right tabular-nums font-bold">
                      <span className={splhColor(s.splh)}>{fmtShort(s.splh, currency)}</span>
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">
                      {s.labour_pct !== null
                        ? <span className={`font-semibold ${labourColor(s.labour_pct)}`}>{pct(s.labour_pct)}</span>
                        : <span className="text-gray-300 dark:text-gray-600 text-xs">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Placeholder tabs ──────────────────────────────────────────────────────────
// These tabs are listed in TAB_LIST and referenced in the switch below, but were
// never implemented in this file. They render a notice instead of crashing.
// Replace the body with a real report (see MasterTab/FoodCostTab for the pattern).
function ComingSoonTab({ title }: { title: string }) {
  return (
    <div className="rounded-xl border border-dashed border-gray-300 dark:border-gray-700 p-10 text-center">
      <p className="text-base font-medium text-gray-700 dark:text-gray-200">{title}</p>
      <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">This report is not available yet.</p>
    </div>
  );
}
function MatrixTab(_props: { range: DateRange; branchId: string; currency: string }) {
  return <ComingSoonTab title="Menu Matrix" />;
}
function FuelSalesTab({ range, branchId, currency }: { range: DateRange; branchId: string; currency: string }) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const p = new URLSearchParams({ from: range.from, to: range.to });
      if (branchId) p.set('branch_id', branchId);
      setData(await api.get<any>(`/api/reports/fuel-sales?${p}`));
    } catch (e: any) { setError(e.message ?? 'Failed to load'); }
    finally { setLoading(false); }
  }, [range.from, range.to, branchId]);
  useEffect(() => { load(); }, [load]);

  if (loading) return <Spinner />;
  if (error)   return <ErrMsg msg={error} />;
  if (!data)   return null;

  const { summary, grades, pumps, hourlySeries } = data;
  const fmtC = (n: number) => `${currency} ${Number(n).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const fmtL = (n: number | null | undefined) => n != null ? `${Number(n).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} L` : '—';
  const fmtL0 = (n: number | null | undefined) => n != null ? `${Number(n).toLocaleString('en-KE', { maximumFractionDigits: 0 })} L` : '—';
  const peakHour = (hourlySeries as any[]).reduce((best: any, h: any) => (!best || h.litres > best.litres) ? h : best, null);

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-3 gap-3">
        <KpiCard label="Revenue" value={fmtC(summary.totalRevenue)} accent />
        <KpiCard label="Total Litres Sold" value={fmtL(summary.totalLitres)} />
        <KpiCard label="Transactions" value={String(summary.totalTransactions)}
          sub={summary.totalTransactions > 0 ? `avg ${fmtL(summary.totalLitres / summary.totalTransactions)} / tx` : undefined} />
      </div>

      <SectionCard title="Pump Monitor — Opening · Sold · Remaining">
        {pumps.length === 0
          ? <p className="text-sm text-gray-500">No pumps configured or no data for this period.</p>
          : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-200 dark:border-gray-700">
                    <Th>Pump</Th><Th>Grade</Th><Th right>Price/L</Th><Th right>Capacity</Th>
                    <Th right>Opening Stock</Th><Th right>Sold (L)</Th><Th right>Remaining</Th>
                    <Th right>Revenue</Th><Th right>Transactions</Th><Th right>Avg L/Tx</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                  {(pumps as any[]).map((p: any) => {
                    const opening = p.current_level != null ? p.current_level + p.litres : null;
                    const pct = p.capacity_litres && p.current_level != null
                      ? Math.min(100, Math.round((p.current_level / p.capacity_litres) * 100)) : null;
                    return (
                      <tr key={p.pump_id}>
                        <td className="py-2.5 font-semibold text-gray-900 dark:text-white whitespace-nowrap">{p.pump_name}</td>
                        <td className="py-2.5 text-gray-500">{p.product_name ?? '—'}</td>
                        <td className="py-2.5 text-right tabular-nums text-gray-500">
                          {p.price_per_litre ? `${currency} ${Number(p.price_per_litre).toFixed(2)}` : '—'}
                        </td>
                        <td className="py-2.5 text-right tabular-nums text-gray-500">{fmtL0(p.capacity_litres)}</td>
                        <td className="py-2.5 text-right tabular-nums text-gray-600 dark:text-gray-300">{fmtL(opening)}</td>
                        <td className="py-2.5 text-right tabular-nums font-semibold text-amber-600 dark:text-amber-400">{fmtL(p.litres)}</td>
                        <td className="py-2.5 text-right tabular-nums">
                          <span className={`font-semibold ${p.current_level != null && p.current_level < 1000 ? 'text-red-500' : 'text-green-600 dark:text-green-400'}`}>
                            {fmtL(p.current_level)}{pct != null ? ` (${pct}%)` : ''}
                          </span>
                        </td>
                        <td className="py-2.5 text-right tabular-nums font-medium text-gray-900 dark:text-white">{fmtC(p.revenue)}</td>
                        <td className="py-2.5 text-right tabular-nums text-gray-500">{p.transactions}</td>
                        <td className="py-2.5 text-right tabular-nums text-gray-500">
                          {p.transactions > 0 ? fmtL(p.litres / p.transactions) : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-gray-200 dark:border-gray-700 font-semibold">
                    <td colSpan={5} className="py-2 text-xs text-gray-600 dark:text-gray-400">Total</td>
                    <td className="py-2 text-right tabular-nums text-xs text-amber-600 dark:text-amber-400">{fmtL(summary.totalLitres)}</td>
                    <td />
                    <td className="py-2 text-right tabular-nums text-xs">{fmtC(summary.totalRevenue)}</td>
                    <td className="py-2 text-right tabular-nums text-xs text-gray-500">{summary.totalTransactions}</td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
      </SectionCard>

      <SectionCard title="By Fuel Grade">
        {grades.length === 0
          ? <p className="text-sm text-gray-500">No fuel sales in this period.</p>
          : (
            <table className="w-full text-sm">
              <thead><tr className="border-b border-gray-200 dark:border-gray-700">
                <Th>Grade</Th><Th right>Litres Sold</Th><Th right>Revenue</Th>
                <Th right>Transactions</Th><Th right>Revenue/L</Th>
              </tr></thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                {(grades as any[]).map((g: any) => (
                  <tr key={g.product_id}>
                    <td className="py-2 font-medium text-gray-800 dark:text-gray-200">{g.name}</td>
                    <td className="py-2 text-right tabular-nums">{fmtL(g.litres)}</td>
                    <td className="py-2 text-right tabular-nums">{fmtC(g.revenue)}</td>
                    <td className="py-2 text-right tabular-nums text-gray-500">{g.transactions}</td>
                    <td className="py-2 text-right tabular-nums text-gray-500">
                      {g.litres > 0 ? `${currency} ${(g.revenue / g.litres).toFixed(2)}` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </SectionCard>

      <SectionCard title={`Hourly Sales Pattern${peakHour?.litres > 0 ? ` · Peak ${peakHour.hour}:00–${peakHour.hour + 1}:00` : ''}`}>
        {(() => {
          const max = Math.max(...(hourlySeries as any[]).map((h: any) => h.litres), 1);
          const hasData = (hourlySeries as any[]).some((h: any) => h.litres > 0);
          if (!hasData) return <p className="text-sm text-gray-500">No sales in this period.</p>;
          return (
            <>
              <div className="flex items-end gap-0.5 h-20 mb-1">
                {(hourlySeries as any[]).map((h: any) => {
                  const isPeak = h.hour === peakHour?.hour;
                  return (
                    <div key={h.hour} className="flex-1 flex flex-col justify-end h-full"
                      title={`${h.hour}:00  ${fmtL(h.litres)}  ${fmtC(h.revenue)}`}>
                      <div style={{ height: `${Math.max(4, Math.round((h.litres / max) * 100))}%` }}
                        className={`rounded-sm ${isPeak ? 'bg-amber-500' : 'bg-amber-400/60'}`} />
                    </div>
                  );
                })}
              </div>
              <div className="flex justify-between">
                {[0, 4, 8, 12, 16, 20, 23].map(h => <span key={h} className="text-[9px] text-gray-400">{h}:00</span>)}
              </div>
            </>
          );
        })()}
      </SectionCard>
    </div>
  );
}


function WetStockTab({ range, branchId, currency }: { range: DateRange; branchId: string; currency: string }) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const p = new URLSearchParams({ from: range.from, to: range.to });
      if (branchId) p.set('branch_id', branchId);
      setData(await api.get<any>(`/api/reports/wet-stock?${p}`));
    } catch (e: any) { setError(e.message ?? 'Failed to load'); }
    finally { setLoading(false); }
  }, [range.from, range.to, branchId]);
  useEffect(() => { load(); }, [load]);

  if (loading) return <Spinner />;
  if (error)   return <ErrMsg msg={error} />;
  if (!data)   return null;

  const { tanks, deliveryLog } = data;
  const fmtL  = (n: number | null | undefined) => n != null ? `${Number(n).toLocaleString('en-KE', { maximumFractionDigits: 0 })} L` : '—';
  const fmtL2 = (n: number | null | undefined) => n != null ? `${Number(n).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} L` : '—';
  const fmtC  = (n: number) => `${currency} ${Number(n).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  return (
    <div className="space-y-5">

      {/* KPI cards */}
      {tanks.length > 0 && (() => {
        const totalCap  = tanks.reduce((s: number, t: any) => s + Number(t.capacity_litres ?? 0), 0);
        const totalCurr = tanks.reduce((s: number, t: any) => s + Number(t.current_level ?? 0), 0);
        const totalSold = tanks.reduce((s: number, t: any) => s + Number(t.consumed_litres ?? 0), 0);
        const totalDel  = tanks.reduce((s: number, t: any) => s + Number(t.delivered_litres ?? 0), 0);
        const pctFull   = totalCap > 0 ? Math.round((totalCurr / totalCap) * 100) : 0;
        return (
          <div className="grid grid-cols-4 gap-3">
            <KpiCard label="Current Stock"       value={fmtL(totalCurr)} sub={`${pctFull}% of capacity`} accent />
            <KpiCard label="Sold (Period)"        value={fmtL2(totalSold)} />
            <KpiCard label="Delivered (Period)"   value={fmtL(totalDel)} />
            <KpiCard label="Revenue Value (stock)" value={fmtC(
              tanks.reduce((s: number, t: any) => s + Number(t.current_level ?? 0) * Number(t.price_per_litre ?? 0), 0)
            )} />
          </div>
        );
      })()}

      {/* Per-tank reconciliation table */}
      <SectionCard title="Tank Reconciliation — Current · Sold · Delivered · Opening">
        {tanks.length === 0
          ? <p className="text-sm text-gray-500">No tanks configured. Add tanks in Settings → Petrol Setup.</p>
          : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-200 dark:border-gray-700">
                    <Th>Tank</Th><Th>Grade</Th><Th right>Price/L</Th><Th right>Capacity</Th>
                    <Th right>Opening*</Th><Th right>Delivered</Th><Th right>Sold</Th>
                    <Th right>Current</Th><Th right>Level %</Th><Th right>Stock Value</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                  {(tanks as any[]).map((t: any) => {
                    const pct = t.capacity_litres > 0
                      ? Math.min(100, Math.round((t.current_level / t.capacity_litres) * 100)) : 0;
                    const barColour = t.is_low ? 'bg-red-500' : pct < 50 ? 'bg-amber-400' : 'bg-green-500';
                    const textColour = t.is_low ? 'text-red-500' : pct < 50 ? 'text-amber-500' : 'text-green-600 dark:text-green-400';
                    // Opening = current + sold - delivered (reverse the period's net movement)
                    const opening = Number(t.current_level ?? 0) + Number(t.consumed_litres ?? 0) - Number(t.delivered_litres ?? 0);
                    const stockValue = Number(t.current_level ?? 0) * Number(t.price_per_litre ?? 0);
                    return (
                      <tr key={t.id}>
                        <td className="py-2.5 font-semibold text-gray-900 dark:text-white whitespace-nowrap">
                          {t.name}
                          {t.is_low && <span className="ml-1.5 text-[10px] bg-red-100 dark:bg-red-500/20 text-red-600 dark:text-red-400 px-1.5 py-0.5 rounded-full font-semibold">LOW</span>}
                        </td>
                        <td className="py-2.5 text-gray-500">{t.product_name}</td>
                        <td className="py-2.5 text-right tabular-nums text-gray-500">
                          {t.price_per_litre ? `${currency} ${Number(t.price_per_litre).toFixed(2)}` : '—'}
                        </td>
                        <td className="py-2.5 text-right tabular-nums text-gray-500">{fmtL(t.capacity_litres)}</td>
                        <td className="py-2.5 text-right tabular-nums text-gray-600 dark:text-gray-300">{fmtL(opening)}</td>
                        <td className="py-2.5 text-right tabular-nums text-green-600 dark:text-green-400 font-medium">
                          {Number(t.delivered_litres ?? 0) > 0 ? `+${fmtL(t.delivered_litres)}` : '—'}
                        </td>
                        <td className="py-2.5 text-right tabular-nums text-amber-600 dark:text-amber-400 font-medium">
                          {Number(t.consumed_litres ?? 0) > 0 ? `-${fmtL2(t.consumed_litres)}` : '—'}
                        </td>
                        <td className={`py-2.5 text-right tabular-nums font-semibold ${textColour}`}>{fmtL(t.current_level)}</td>
                        <td className="py-2.5">
                          <div className="flex items-center gap-2 justify-end">
                            <div className="w-14 h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                              <div className={`h-full ${barColour} rounded-full`} style={{ width: `${pct}%` }} />
                            </div>
                            <span className={`text-xs tabular-nums ${textColour}`}>{pct}%</span>
                          </div>
                        </td>
                        <td className="py-2.5 text-right tabular-nums text-gray-700 dark:text-gray-300">
                          {stockValue > 0 ? fmtC(stockValue) : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-gray-200 dark:border-gray-700 text-xs font-semibold">
                    <td colSpan={4} className="py-2 text-gray-600 dark:text-gray-400">Totals</td>
                    <td className="py-2 text-right tabular-nums text-gray-600 dark:text-gray-300">
                      {fmtL(tanks.reduce((s: number, t: any) => s + Number(t.current_level ?? 0) + Number(t.consumed_litres ?? 0) - Number(t.delivered_litres ?? 0), 0))}
                    </td>
                    <td className="py-2 text-right tabular-nums text-green-600 dark:text-green-400">
                      {tanks.some((t: any) => t.delivered_litres > 0) ? fmtL(tanks.reduce((s: number, t: any) => s + Number(t.delivered_litres ?? 0), 0)) : '—'}
                    </td>
                    <td className="py-2 text-right tabular-nums text-amber-600 dark:text-amber-400">
                      {fmtL2(tanks.reduce((s: number, t: any) => s + Number(t.consumed_litres ?? 0), 0))}
                    </td>
                    <td className="py-2 text-right tabular-nums">{fmtL(tanks.reduce((s: number, t: any) => s + Number(t.current_level ?? 0), 0))}</td>
                    <td />
                    <td className="py-2 text-right tabular-nums">
                      {fmtC(tanks.reduce((s: number, t: any) => s + Number(t.current_level ?? 0) * Number(t.price_per_litre ?? 0), 0))}
                    </td>
                  </tr>
                </tfoot>
              </table>
              <p className="text-[10px] text-gray-400 mt-2">* Opening = Current + Sold − Delivered in this period (approximate if period excludes prior sales)</p>
            </div>
          )}
      </SectionCard>

      {/* Delivery log */}
      <SectionCard title="Delivery Log">
        {!deliveryLog?.length
          ? <p className="text-sm text-gray-500">No deliveries recorded in this period.</p>
          : (
            <table className="w-full text-sm">
              <thead><tr className="border-b border-gray-200 dark:border-gray-700">
                <Th>Date</Th><Th>Grade</Th><Th right>Litres Added</Th><Th right>Level After</Th><Th>Notes</Th>
              </tr></thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                {(deliveryLog as any[]).map((d: any, i: number) => (
                  <tr key={i}>
                    <td className="py-2 text-gray-500 text-xs whitespace-nowrap">
                      {d.recorded_at ? new Date(d.recorded_at).toLocaleString('en-KE', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' }) : '—'}
                    </td>
                    <td className="py-2 text-gray-800 dark:text-gray-200">{d.product_name ?? '—'}</td>
                    <td className="py-2 text-right tabular-nums text-green-600 dark:text-green-400 font-medium">+{fmtL(d.litres)}</td>
                    <td className="py-2 text-right tabular-nums text-gray-500">{fmtL(d.level_after)}</td>
                    <td className="py-2 text-gray-500 text-xs max-w-[200px] truncate">{d.notes ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </SectionCard>
    </div>
  );
}


export default function ReportsPage() {
  const { business } = useBusiness();
  const isPetrol = business?.type === 'petrol_station';
  const visibleTabs = TAB_LIST.filter(t => {
    if (t.id === 'fuel_sales' || t.id === 'wet_stock') return isPetrol;
    if (t.id === 'matrix' || t.id === 'food_cost')     return !isPetrol;
    return true;
  });
  const { branches, activeBranchId } = useBranch();
  const [activeTab, setActiveTab] = useState('master');
  const [range, setRange]         = useState<DateRange>({ from: today(), to: today() });
  const [branchId, setBranchId]   = useState(activeBranchId ?? '');
  const currency = business?.currency ?? 'KES';
  const tabProps = { range, branchId, currency };

  return (
    <div className="p-4 sm:p-6 w-full">
      <div className="mb-5">
        <h1 className="text-xl font-semibold text-gray-900 dark:text-white">Reports</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">Sales analysis · Tax · Staff performance · Voids</p>
      </div>

      <DateRangeBar range={range} onChange={setRange} branches={branches ?? []} branchId={branchId} onBranchChange={setBranchId} />

      {/* Tab bar */}
      <div className="flex gap-0 overflow-x-auto border-b border-gray-200 dark:border-gray-700 mb-5">
        {visibleTabs.map(t => (
          <button key={t.id} onClick={() => setActiveTab(t.id)}
            className={`whitespace-nowrap text-sm px-4 py-2.5 border-b-2 transition-colors flex-shrink-0 ${
              activeTab === t.id
                ? 'border-blue-600 text-blue-600 dark:text-blue-400 font-medium'
                : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
            }`}>{t.label}
          </button>
        ))}
      </div>

      {activeTab === 'master' && <MasterTab  {...tabProps} />}
      {activeTab === 'hourly' && <HourlyTab  {...tabProps} />}
      {activeTab === 'items'     && <ItemMixTab   {...tabProps} />}
      {activeTab === 'matrix'    && <MatrixTab    {...tabProps} />}
      {activeTab === 'food_cost'  && <FoodCostTab    {...tabProps} />}
      {activeTab === 'aggregator' && <AggregatorTab {...tabProps} />}
      {activeTab === 'voids'  && <VoidsTab   {...tabProps} />}
      {activeTab === 'tax'    && <TaxTab     {...tabProps} />}
      {activeTab === 'staff'  && <StaffTab   {...tabProps} />}
      {activeTab === 'splh'      && <SplhTab      {...tabProps} />}
      {activeTab === 'fuel_sales' && <FuelSalesTab  {...tabProps} />}
      {activeTab === 'wet_stock'  && <WetStockTab   {...tabProps} />}
    </div>
  );
}
