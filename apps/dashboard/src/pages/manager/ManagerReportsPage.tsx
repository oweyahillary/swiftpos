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

import { useState, useEffect, useCallback, useRef, Fragment } from 'react';
import { usePOSAuth , type PosApi } from '../../context/POSAuthContext';
import { useBusiness } from '../../context/BusinessContext';
import { printDocument } from '../../lib/printDocument';
import { localDateStr } from '../../lib/localDate';
import { DESK, useRowMore, ViewMore, MoreRow } from '../../components/RowMore';
import DownloadExcelButton from '../../components/DownloadExcelButton';   // A467
import { localStamp, type ReportColumn, type ReportSheet } from '../../lib/reportDownload';   // A467
import { reportPresets } from '../../lib/reportPeriods';   // A467
import * as fmt from '../../lib/format';   // A471: one money/number/date format
import Pager, { usePageSize } from '../../components/Pager';   // A475
import { paginate } from '../../lib/paginate';

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
  authorized_by_name: string | null;
}

interface StaffRow {
  staff_id: string; staff_name: string;
  orders: number; revenue: number; voids: number; avg_order_value: number;
}

interface ShiftRow {
  id: string; opened_at: string; closed_at: string | null; status: string;
  cashier_name: string | null; opening_float: number; closing_float: number | null;
  expected_cash: number | null;
  cash_variance: number | null; order_count: number | null; order_revenue: number | null;
  float_in?: number | null; float_out?: number | null;
  // legacy aliases (the API sends cash_variance / order_revenue; kept as fallbacks)
  variance?: number | null; total_revenue?: number | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const today   = () => localDateStr();
const weekAgo = () => { const d = new Date(); d.setDate(d.getDate() - 6); return localDateStr(d); };


const METHOD_LABELS: Record<string, string> = { cash: '💵 Cash', mpesa: '📱 M-Pesa', card: '💳 Card' };

// A467: Download Excel column shorthands (text, money to 2 dp, a number to `dp` places) and a KPI sheet.
const col   = (key: string, label: string): ReportColumn => ({ key, label });
const money = (key: string, label: string): ReportColumn => ({ key, label, money: true });
const num   = (key: string, label: string, dp = 2): ReportColumn => ({ key, label, dp });
const kpiSheet = (name: string, rows: [string, unknown][]): ReportSheet => ({
  name, columns: [col('metric', 'Metric'), num('value', 'Value')], rows: rows.map(([metric, value]) => ({ metric, value })),
});
const METHOD_NAMES: Record<string, string> = { cash: 'Cash', mpesa: 'M-Pesa', card: 'Card' };

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
      <div className="w-6 h-6 border-2 border-gray-700 border-t-swift rounded-full animate-spin" />
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

interface DateBarProps {
  from: string; to: string; setFrom: (v: string) => void; setTo: (v: string) => void; onApply: () => void; loading: boolean;
  /** A467: Download Excel — the report's name and the sheets the tab shows (built from its loaded data). */
  report?: string; sheets?: ReportSheet[]; branchName?: string;
}
function DateBar({ from, to, setFrom, setTo, onApply, loading, report, sheets, branchName }: DateBarProps) {
  const { business } = useBusiness();
  // A467: between a date change and the debounced reload the tab still shows the OLD period — no download then.
  const [pending, setPending] = useState(false);
  // A216: auto-apply. Presets and date edits both just set from/to; this debounced
  // effect runs the query ~400ms later, so there's no need to click Apply. The
  // first run is skipped (each tab already loads once on mount), and empty/partial
  // dates are guarded. The Apply button stays as an immediate manual trigger.
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; return; }
    if (!from || !to) return;
    setPending(true);
    const id = setTimeout(() => onApply(), 400);
    return () => clearTimeout(id);
  }, [from, to]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (loading) setPending(false); }, [loading]);   // A467: the reload began — `loading` covers it now
  // A467: Today · Yesterday · 7 days · This week · Last week · This month · Last month (local EAT days, Monday weeks).
  const P = reportPresets();
  const presets = [
    { label: 'Today',   f: today(),   t: today() },
    { label: 'Yesterday', f: P[1].from, t: P[1].to },
    { label: '7 days',  f: weekAgo(), t: today() },
    ...P.slice(2).map(p => ({ label: p.label, f: p.from, t: p.to })),
  ];
  // A263: track the chosen preset explicitly so exactly one highlights (deriving
  // it from from/to could light two up when their ranges coincide), and clear it
  // when the dates are edited by hand.
  const [active, setActive] = useState<string>(() => presets.find(p => p.f === from && p.t === to)?.label ?? '');
  return (
    <div className="flex flex-wrap gap-3 items-end mb-6">
      {/* A467: seven presets — on a phone the row scrolls sideways inside its box. */}
      <div data-testid="report-presets" className="flex gap-1 max-w-full overflow-x-auto bg-gray-800 p-1 rounded-lg">
        {presets.map(p => (
          <button key={p.label} onClick={() => { setActive(p.label); setFrom(p.f); setTo(p.t); }}
            className={`flex-shrink-0 whitespace-nowrap text-xs px-3 py-1.5 rounded-md transition-colors ${active === p.label ? 'bg-swift-strong text-white' : 'text-gray-400 hover:text-white'}`}>
            {p.label}
          </button>
        ))}
      </div>
      {[{ label: 'From', val: from, set: setFrom }, { label: 'To', val: to, set: setTo }].map(({ label, val, set }) => (
        <div key={label} className="flex flex-col gap-1">
          <label className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">{label}</label>
          <input type="date" value={val} onChange={e => { set(e.target.value); setActive(''); }}
            className="bg-gray-900 border border-gray-700 rounded-lg px-3 py-1.5 text-white text-sm focus:outline-none focus:border-swift" />
        </div>
      ))}
      {loading && <span className="self-end pb-1.5 text-xs text-gray-500">Updating…</span>}
      {report && (
        <div className="ml-auto self-end">
          <DownloadExcelButton loading={loading || pending}
            input={{ report, from, to, businessName: business?.name ?? '', branchName: branchName ?? '', sheets: sheets ?? [] }} />
        </div>
      )}
    </div>
  );
}

// ── Tab: Summary ──────────────────────────────────────────────────────────────

function SummaryTab({ posApi, session, currency }: { posApi: PosApi; session: any; currency: string }) {
  const [from, setFrom] = useState(today());
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
    { label: 'Revenue',    value: fmt.money(s?.totalRevenue ?? 0, currency),  color: '#22c55e' },
    { label: 'Orders',     value: String(s?.totalOrders ?? 0),          color: '#3b82f6' },
    { label: 'Avg Order',  value: fmt.money(s?.avgOrderValue ?? 0, currency), color: '#a855f7' },
    { label: 'VAT',        value: fmt.money(s?.totalVat ?? 0, currency),      color: '#f59e0b' },
    { label: 'Discounts',  value: fmt.money(s?.totalDiscount ?? 0, currency), color: '#ef4444' },
  ];
  // A467: the KPIs, the payment split and the daily trend, from the loaded data.
  const sheets: ReportSheet[] = !data || (!(s?.totalOrders) && data.dailySeries.length === 0) ? [] : [
    kpiSheet('Summary', [['Revenue', s?.totalRevenue ?? 0], ['Orders', s?.totalOrders ?? 0], ['Avg Order', s?.avgOrderValue ?? 0],
      ['VAT', s?.totalVat ?? 0], ['Discounts', s?.totalDiscount ?? 0]]),
    { name: 'Payment Methods', columns: [col('method', 'Method'), money('amount', 'Amount'), num('pct', 'Share %', 0)],
      rows: Object.entries(data.paymentMethods).sort((a, b) => b[1] - a[1]).map(([method, amount]) => ({
        method: METHOD_NAMES[method] ?? method, amount, pct: s?.totalRevenue ? Math.round((amount / s.totalRevenue) * 100) : 0 })) },
    { name: 'Daily Revenue', columns: [col('date', 'Date'), money('revenue', 'Revenue')], rows: data.dailySeries },
  ];

  return (
    <div className="space-y-5">
      <DateBar from={from} to={to} setFrom={setFrom} setTo={setTo} onApply={() => load(from, to)} loading={loading}
        report="Summary" sheets={sheets} branchName={session?.branchName} />
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
                      <span className="text-white font-medium">{fmt.money(amount, currency)} <span className="text-gray-500 text-xs">({pct}%)</span></span>
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
                    <span className="text-xs text-gray-400 w-28 text-right flex-shrink-0">{fmt.compactMoney(revenue, currency)}</span>
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

function HourlyTab({ posApi, session, currency }: { posApi: PosApi; session: any; currency: string }) {
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
  const more = useRowMore();
  // A467: the KPIs and the hour table, from the loaded rows.
  const sheets: ReportSheet[] = rows.length === 0 ? [] : [
    kpiSheet('Summary', [['Total', total], ['Peak Hour', peakHour?.hour ?? null], ['Peak Revenue', peakHour?.revenue ?? null]]),
    { name: 'Hourly', columns: [col('label', 'Hour'), num('orders', 'Orders', 0), money('revenue', 'Revenue'), num('pct', 'Share %', 1)],
      rows: [...rows].sort((a, b) => a.hour - b.hour).map(r => ({ ...r, label: `${r.hour}:00 – ${r.hour + 1}:00`, pct: total ? (r.revenue / total) * 100 : null })) },
  ];

  return (
    <div className="space-y-5">
      <DateBar from={from} to={to} setFrom={setFrom} setTo={setTo} onApply={() => load(from, to)} loading={loading}
        report="Hourly" sheets={sheets} branchName={session?.branchName} />
      {error && <ErrorMsg msg={error} />}
      {loading && <Spinner />}
      {!loading && rows.length === 0 && <Empty label="No sales data for this period." />}
      {!loading && rows.length > 0 && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="bg-gray-800/50 border border-gray-700 rounded-xl p-4">
              <p className="text-gray-500 text-xs">Total</p>
              <p className="text-white font-bold text-lg mt-1">{fmt.compactMoney(total, currency)}</p>
            </div>
            <div className="bg-gray-800/50 border border-gray-700 rounded-xl p-4">
              <p className="text-gray-500 text-xs">Peak Hour</p>
              <p className="text-amber-400 font-bold text-lg mt-1">{peakHour ? `${peakHour.hour}:00` : '—'}</p>
            </div>
            <div className="bg-gray-800/50 border border-gray-700 rounded-xl p-4">
              <p className="text-gray-500 text-xs">Peak Revenue</p>
              <p className="text-green-400 font-bold text-lg mt-1">{peakHour ? fmt.compactMoney(peakHour.revenue, currency) : '—'}</p>
            </div>
          </div>
          <div className="bg-gray-800/50 border border-gray-700 rounded-2xl overflow-hidden">
            <div className="overflow-x-auto"><table className="w-full text-sm">
              <thead className="bg-gray-700/30">
                <tr>
                  {['Hour', 'Orders', 'Revenue', 'Share', ''].map((h, i) => (
                    <th key={h} className={`text-left text-xs text-gray-400 px-4 py-3 font-medium${i !== 0 && i !== 2 ? ` ${DESK}` : ''}`}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800">
                {rows.sort((a, b) => a.hour - b.hour).map(r => (
                  <Fragment key={r.hour}>
                  <tr className="hover:bg-gray-800/30 transition-colors">
                    <td className="px-4 py-2.5 text-white font-medium">{r.hour}:00 – {r.hour+1}:00
                      <ViewMore open={more.isOpen(String(r.hour))} onClick={() => more.toggle(String(r.hour))} />
                    </td>
                    <td className={`px-4 py-2.5 text-gray-400 ${DESK}`}>{r.orders}</td>
                    <td className="px-4 py-2.5 text-white font-medium">{fmt.money(r.revenue, currency)}</td>
                    <td className={`px-4 py-2.5 text-gray-400 text-xs ${DESK}`}>{total ? fmt.pct((r.revenue / total) * 100) : '—'}</td>
                    <td className={`px-4 py-2.5 w-32 ${DESK}`}>
                      <div className="h-1.5 bg-gray-700 rounded-full overflow-hidden">
                        <div className="h-full bg-blue-500 rounded-full" style={{ width: `${(r.revenue / maxRev) * 100}%` }} />
                      </div>
                    </td>
                  </tr>
                  <MoreRow open={more.isOpen(String(r.hour))} colSpan={2} items={[
                    ['Orders', r.orders],
                    ['Share', total ? fmt.pct((r.revenue / total) * 100) : '—'],
                  ]} />
                  </Fragment>
                ))}
              </tbody>
            </table></div>
          </div>
        </>
      )}
    </div>
  );
}

// ── Tab: Item Mix ─────────────────────────────────────────────────────────────

function ItemMixTab({ posApi, session, currency }: { posApi: PosApi; session: any; currency: string }) {
  const [from, setFrom]   = useState(today());
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
  const byRevenue = [...filtered].sort((a, b) => b.revenue - a.revenue);
  const more = useRowMore();
  // A475: the list in pages (25 / 50 / 100, remembered in this browser); a new search / filter / period → page 1, an edit keeps the page (clamped).
  const [itemPage, setItemPage] = useState(1);
  const [itemPageSize, setItemPageSize] = usePageSize('swiftpos.pageSize.manager.reports.itemMix');
  useEffect(() => { setItemPage(1); }, [from, to, search]);
  const itemPaged = paginate(byRevenue, itemPage, itemPageSize);
  useEffect(() => { if (itemPaged.page !== itemPage) setItemPage(itemPaged.page); }, [itemPaged.page, itemPage]);
  // A467: the item table as shown — the search applied, by revenue.
  const sheets: ReportSheet[] = filtered.length === 0 ? [] : [{
    name: 'Item Mix',
    columns: [col('name', 'Item'), col('category', 'Category'), num('qty', 'Qty', 3), money('revenue', 'Revenue'), num('pct', '% of Sales', 1), money('avg_price', 'Avg Price')],
    rows: [...filtered].sort((a, b) => b.revenue - a.revenue).map(r => ({ ...r, pct: totalRev ? (r.revenue / totalRev) * 100 : 0 })),
  }];

  return (
    <div className="space-y-4">
      <DateBar from={from} to={to} setFrom={setFrom} setTo={setTo} onApply={() => load(from, to)} loading={loading}
        report="Item Mix" sheets={sheets} branchName={session?.branchName} />
      <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search items…"
        className="w-full bg-gray-900 border border-gray-700 rounded-xl px-4 py-2.5 text-white text-sm focus:outline-none focus:border-swift" />
      {error && <ErrorMsg msg={error} />}
      {loading && <Spinner />}
      {!loading && filtered.length === 0 && <Empty label="No items sold in this period." />}
      {!loading && filtered.length > 0 && (
        <div className="bg-gray-800/50 border border-gray-700 rounded-2xl overflow-hidden">
          <div className="overflow-x-auto"><table className="w-full text-sm">
            <thead className="bg-gray-700/30">
              <tr>
                {['Item', 'Category', 'Qty', 'Revenue', '% of Sales', 'Avg Price'].map((h, i) => (
                  <th key={h} className={`text-left text-xs text-gray-400 px-4 py-3 font-medium${i !== 0 && i !== 3 ? ` ${DESK}` : ''}`}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {itemPaged.items.map(r => {
                const share = totalRev ? (r.revenue / totalRev) * 100 : 0;
                return (
                  <Fragment key={r.product_id}>
                  <tr className="hover:bg-gray-800/30 transition-colors">
                    <td className="px-4 py-2.5 text-white font-medium">{r.name}
                      <ViewMore open={more.isOpen(String(r.product_id))} onClick={() => more.toggle(String(r.product_id))} />
                    </td>
                    <td className={`px-4 py-2.5 text-gray-400 text-xs ${DESK}`}>{r.category || '—'}</td>
                    <td className={`px-4 py-2.5 text-gray-300 tabular-nums ${DESK}`}>{fmt.qty(r.qty)}</td>
                    <td className="px-4 py-2.5 text-white font-medium tabular-nums">{fmt.money(r.revenue, currency)}</td>
                    <td className={`px-4 py-2.5 ${DESK}`}>
                      <div className="flex items-center gap-2">
                        <div className="w-16 h-1.5 bg-gray-700 rounded-full overflow-hidden">
                          <div className="h-full bg-green-500 rounded-full" style={{ width: `${share}%` }} />
                        </div>
                        <span className="text-gray-400 text-xs">{fmt.pct(share)}</span>
                      </div>
                    </td>
                    <td className={`px-4 py-2.5 text-gray-400 tabular-nums ${DESK}`}>{fmt.money(r.avg_price, currency)}</td>
                  </tr>
                  <MoreRow open={more.isOpen(String(r.product_id))} colSpan={2} items={[
                    ['Category', r.category || '—'],
                    ['Qty', fmt.qty(r.qty)],
                    ['% of Sales', fmt.pct(share)],
                    ['Avg Price', fmt.money(r.avg_price, currency)],
                  ]} />
                  </Fragment>
                );
              })}
            </tbody>
          </table></div>
          <Pager paged={itemPaged} noun="items" onPage={setItemPage} onSize={n => { setItemPageSize(n); setItemPage(1); }} />
        </div>
      )}
    </div>
  );
}

// ── Tab: Voids ────────────────────────────────────────────────────────────────

function VoidsTab({ posApi, session, currency }: { posApi: PosApi; session: any; currency: string }) {
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
  const more = useRowMore();
  // A475: the list in pages (25 / 50 / 100, remembered in this browser); a new search / filter / period → page 1, an edit keeps the page (clamped).
  const [voidPage, setVoidPage] = useState(1);
  const [voidPageSize, setVoidPageSize] = usePageSize('swiftpos.pageSize.manager.reports.voids');
  useEffect(() => { setVoidPage(1); }, [from, to]);
  const voidPaged = paginate(rows, voidPage, voidPageSize);
  useEffect(() => { if (voidPaged.page !== voidPage) setVoidPage(voidPaged.page); }, [voidPaged.page, voidPage]);
  // A467: the KPIs and the void log, from the loaded rows.
  const sheets: ReportSheet[] = rows.length === 0 ? [] : [
    kpiSheet('Summary', [['Void Count', rows.length], ['Total Voided Value', totalVoided]]),
    { name: 'Voids',
      columns: [col('order_number', 'Order'), money('total', 'Amount'), col('cashier_name', 'Cashier'), col('authorized_by_name', 'Authorized by'),
        col('table_name', 'Table'), col('void_reason', 'Reason'), col('time', 'Time')],
      rows: rows.map(r => ({ ...r, time: localStamp(r.voided_at) })) },
  ];

  return (
    <div className="space-y-4">
      <DateBar from={from} to={to} setFrom={setFrom} setTo={setTo} onApply={() => load(from, to)} loading={loading}
        report="Voids" sheets={sheets} branchName={session?.branchName} />
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
              <p className="text-red-400 font-bold text-2xl">{fmt.compactMoney(totalVoided, currency)}</p>
            </div>
          </div>
          <div className="bg-gray-800/50 border border-gray-700 rounded-2xl overflow-hidden">
            <div className="overflow-x-auto"><table className="w-full text-sm">
              <thead className="bg-gray-700/30">
                <tr>
                  {['Order', 'Amount', 'Cashier', 'Authorized by', 'Table', 'Reason', 'Time'].map((h, i) => (
                    <th key={h} className={`text-left text-xs text-gray-400 px-4 py-3 font-medium${i > 1 ? ` ${DESK}` : ''}`}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800">
                {voidPaged.items.map(r => (
                  <Fragment key={r.id}>
                  <tr className="hover:bg-gray-800/30 transition-colors">
                    <td className="px-4 py-2.5 text-white font-mono text-xs">{r.order_number}
                      <ViewMore open={more.isOpen(String(r.id))} onClick={() => more.toggle(String(r.id))} />
                    </td>
                    <td className="px-4 py-2.5 text-red-400 font-medium tabular-nums">{fmt.money(r.total, currency)}</td>
                    <td className={`px-4 py-2.5 text-gray-300 ${DESK}`}>{r.cashier_name ?? '—'}</td>
                    <td className={`px-4 py-2.5 text-gray-400 text-xs ${DESK}`}>{r.authorized_by_name ?? '—'}</td>
                    <td className={`px-4 py-2.5 text-gray-400 ${DESK}`}>{r.table_name ?? '—'}</td>
                    <td className={`px-4 py-2.5 text-gray-400 text-xs max-w-[180px] truncate ${DESK}`}>{r.void_reason ?? '—'}</td>
                    <td className={`px-4 py-2.5 text-gray-500 text-xs whitespace-nowrap ${DESK}`}>{fmt.dayTime(r.voided_at)}</td>
                  </tr>
                  <MoreRow open={more.isOpen(String(r.id))} colSpan={2} items={[
                    ['Cashier', r.cashier_name ?? '—'],
                    ['Authorized by', r.authorized_by_name ?? '—'],
                    ['Table', r.table_name ?? '—'],
                    ['Reason', r.void_reason ?? '—'],
                    ['Time', fmt.dayTime(r.voided_at)],
                  ]} />
                  </Fragment>
                ))}
              </tbody>
            </table></div>
            <Pager paged={voidPaged} noun="voids" onPage={setVoidPage} onSize={n => { setVoidPageSize(n); setVoidPage(1); }} />
          </div>
        </>
      )}
    </div>
  );
}

// ── Tab: Staff Performance ────────────────────────────────────────────────────

function StaffPerfTab({ posApi, session, currency }: { posApi: PosApi; session: any; currency: string }) {
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
  const more = useRowMore();
  // A467: the staff table, by revenue.
  const sheets: ReportSheet[] = rows.length === 0 ? [] : [{
    name: 'Staff',
    columns: [col('staff_name', 'Cashier'), num('orders', 'Orders', 0), money('revenue', 'Revenue'), money('avg_order_value', 'Avg Order'), num('voids', 'Voids', 0)],
    rows: [...rows].sort((a, b) => b.revenue - a.revenue),
  }];

  return (
    <div className="space-y-4">
      <DateBar from={from} to={to} setFrom={setFrom} setTo={setTo} onApply={() => load(from, to)} loading={loading}
        report="Staff" sheets={sheets} branchName={session?.branchName} />
      {error && <ErrorMsg msg={error} />}
      {loading && <Spinner />}
      {!loading && rows.length === 0 && <Empty label="No staff transactions in this period." />}
      {!loading && rows.length > 0 && (
        <div className="bg-gray-800/50 border border-gray-700 rounded-2xl overflow-hidden">
          <div className="overflow-x-auto"><table className="w-full text-sm">
            <thead className="bg-gray-700/30">
              <tr>
                {['Cashier', 'Orders', 'Revenue', 'Avg Order', 'Voids', ''].map((h, i) => (
                  <th key={h} className={`text-left text-xs text-gray-400 px-4 py-3 font-medium${i !== 0 && i !== 2 ? ` ${DESK}` : ''}`}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {rows.sort((a, b) => b.revenue - a.revenue).map(r => (
                <Fragment key={r.staff_id}>
                <tr className="hover:bg-gray-800/30 transition-colors">
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <div className="w-7 h-7 rounded-full bg-swift/20 border border-swift/30 flex items-center justify-center text-swift-text text-xs font-bold flex-shrink-0">
                        {(r.staff_name ?? '?').charAt(0).toUpperCase()}
                      </div>
                      <span className="text-white font-medium">{r.staff_name ?? 'Unknown'}</span>
                    </div>
                    <ViewMore open={more.isOpen(String(r.staff_id))} onClick={() => more.toggle(String(r.staff_id))} />
                  </td>
                  <td className={`px-4 py-2.5 text-gray-300 tabular-nums ${DESK}`}>{r.orders}</td>
                  <td className="px-4 py-2.5 text-white font-medium tabular-nums">{fmt.money(r.revenue, currency)}</td>
                  <td className={`px-4 py-2.5 text-gray-400 tabular-nums ${DESK}`}>{fmt.money(r.avg_order_value, currency)}</td>
                  <td className={`px-4 py-2.5 ${DESK}`}>
                    {r.voids > 0
                      ? <span className="text-red-400 text-xs font-semibold">{r.voids} void{r.voids > 1 ? 's' : ''}</span>
                      : <span className="text-green-500 text-xs">✓ None</span>}
                  </td>
                  <td className={`px-4 py-2.5 w-32 ${DESK}`}>
                    <div className="h-1.5 bg-gray-700 rounded-full overflow-hidden">
                      <div className="h-full bg-purple-500 rounded-full" style={{ width: `${(r.revenue / maxRev) * 100}%` }} />
                    </div>
                  </td>
                </tr>
                <MoreRow open={more.isOpen(String(r.staff_id))} colSpan={2} items={[
                  ['Orders', r.orders],
                  ['Avg Order', fmt.money(r.avg_order_value, currency)],
                  ['Voids', r.voids > 0
                    ? <span className="text-red-400 text-xs font-semibold">{r.voids} void{r.voids > 1 ? 's' : ''}</span>
                    : <span className="text-green-500 text-xs">✓ None</span>],
                ]} />
                </Fragment>
              ))}
            </tbody>
          </table></div>
        </div>
      )}
    </div>
  );
}

// ── Tab: Shifts ───────────────────────────────────────────────────────────────

function ShiftsTab({ posApi, session, currency }: { posApi: PosApi; session: any; currency: string }) {
  const { business } = useBusiness();
  const [from, setFrom] = useState(today());

  const printZReport = (r: ShiftRow) => {
    const rev      = Number(r.order_revenue ?? r.total_revenue ?? 0);
    const expected = r.expected_cash == null ? null : Number(r.expected_cash);
    const counted  = r.closing_float == null ? null : Number(r.closing_float);
    const variance = r.cash_variance ?? r.variance;
    printDocument({
      docType: 'Z REPORT',
      number: `Z · ${new Date(r.opened_at).toLocaleDateString('en-KE')}`,
      dateLabel: r.closed_at ? new Date(r.closed_at).toLocaleString('en-KE') : 'open shift',
      accent: '#7c3aed', statusLabel: r.status,
      business: business ?? { name: 'ZapTill' },
      meta: [
        { label: 'Cashier', value: r.cashier_name ?? 'Unknown' },
        { label: 'Branch', value: session?.branchName ?? '—' },
        { label: 'Opened', value: new Date(r.opened_at).toLocaleString('en-KE') },
        { label: 'Closed', value: r.closed_at ? new Date(r.closed_at).toLocaleString('en-KE') : '—' },
      ],
      columns: [{ label: 'Line' }, { label: 'Amount', align: 'right' }],
      rows: [
        ['Orders', String(r.order_count ?? 0)],
        ['Sales', fmt.money(rev, currency)],
        ['Opening float', fmt.money(r.opening_float, currency)],
        ['Paid in', fmt.money(r.float_in ?? 0, currency)],
        ['Paid out', fmt.money(r.float_out ?? 0, currency)],
      ],
      totals: [
        ...(expected != null ? [{ label: 'Expected cash', value: fmt.money(expected, currency) }] : []),
        ...(counted  != null ? [{ label: 'Counted cash',  value: fmt.money(counted, currency) }] : []),
        ...(variance != null ? [{ label: 'Variance',      value: fmt.money(Number(variance), currency) }] : []),
      ],
      signatures: ['Counted by', 'Verified by'],
    });
  };
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
  // A475: the list in pages (25 / 50 / 100, remembered in this browser); a new search / filter / period → page 1, an edit keeps the page (clamped).
  const [shiftPage, setShiftPage] = useState(1);
  const [shiftPageSize, setShiftPageSize] = usePageSize('swiftpos.pageSize.manager.reports.shifts');
  useEffect(() => { setShiftPage(1); }, [from, to]);
  const shiftPaged = paginate(rows, shiftPage, shiftPageSize);
  useEffect(() => { if (shiftPaged.page !== shiftPage) setShiftPage(shiftPaged.page); }, [shiftPaged.page, shiftPage]);

  // A467: one row per shift card — what each card shows.
  const sheets: ReportSheet[] = rows.length === 0 ? [] : [{
    name: 'Shifts',
    columns: [col('cashier', 'Cashier'), col('status', 'Status'), col('opened', 'Opened'), col('closed', 'Closed'), num('hours', 'Hours', 1),
      num('orders', 'Orders', 0), money('revenue', 'Sales'), money('opening_float', 'Opening float'), money('variance', 'Cash variance')],
    rows: rows.map(r => ({
      cashier: r.cashier_name ?? 'Unknown', status: r.status, opened: localStamp(r.opened_at), closed: localStamp(r.closed_at),
      hours: ((r.closed_at ? new Date(r.closed_at).getTime() : Date.now()) - new Date(r.opened_at).getTime()) / 3_600_000,
      orders: r.order_count ?? 0, revenue: r.order_revenue ?? r.total_revenue ?? null, opening_float: r.opening_float,
      variance: r.cash_variance ?? r.variance ?? null,
    })),
  }];

  return (
    <div className="space-y-4">
      <DateBar from={from} to={to} setFrom={setFrom} setTo={setTo} onApply={() => load(from, to)} loading={loading}
        report="Shifts" sheets={sheets} branchName={session?.branchName} />
      {error && <ErrorMsg msg={error} />}
      {loading && <Spinner />}
      {!loading && rows.length === 0 && <Empty label="No shifts in this period." />}
      {!loading && rows.length > 0 && (
        <div className="space-y-3">
          {shiftPaged.items.map(r => {
            const variance = r.cash_variance ?? r.variance ?? null;
            const revenue  = r.order_revenue ?? r.total_revenue ?? null;
            const isOpen   = r.status === 'open';
            const hours    = r.closed_at
              ? ((new Date(r.closed_at).getTime() - new Date(r.opened_at).getTime()) / 3_600_000).toFixed(1)
              : ((Date.now() - new Date(r.opened_at).getTime()) / 3_600_000).toFixed(1);
            return (
              <div key={r.id} className={`border rounded-2xl p-4 ${isOpen ? 'border-green-500/30 bg-green-500/5' : 'border-gray-700 bg-gray-800/40'}`}>
                <div className="flex items-start justify-between flex-wrap gap-4 mb-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="text-white font-semibold">{r.cashier_name ?? 'Unknown'}</p>
                      {isOpen && <span className="text-[10px] text-green-400 font-semibold border border-green-500/30 rounded-full px-2 py-0.5">● Open</span>}
                    </div>
                    <p className="text-gray-500 text-xs mt-0.5">
                      {fmt.dayTime(r.opened_at)} {r.closed_at ? `→ ${fmt.dayTime(r.closed_at)}` : '→ now'} · {hours}h
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    {revenue != null && (
                      <p className="text-green-400 font-bold text-lg">{fmt.compactMoney(revenue, currency)}</p>
                    )}
                    <button onClick={() => printZReport(r)}
                      className="text-xs font-medium px-3 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-200 transition-colors">
                      Print Z
                    </button>
                  </div>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs">
                  <div>
                    <p className="text-gray-500">Orders</p>
                    <p className="text-white font-semibold mt-0.5">{r.order_count ?? 0}</p>
                  </div>
                  <div>
                    <p className="text-gray-500">Opening float</p>
                    <p className="text-white font-semibold mt-0.5">{fmt.money(r.opening_float, currency)}</p>
                  </div>
                  {variance != null && (
                    <div>
                      <p className="text-gray-500">Cash variance</p>
                      <p className={`font-semibold mt-0.5 ${Math.abs(variance) < 50 ? 'text-green-400' : 'text-red-400'}`}>
                        {fmt.money(variance, currency, { sign: true })}
                      </p>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
          <Pager paged={shiftPaged} noun="shifts" onPage={setShiftPage} onSize={n => { setShiftPageSize(n); setShiftPage(1); }} />
        </div>
      )}
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────


// ── Fuel Sales Tab (Manager) ──────────────────────────────────────────────────

function FuelSalesTab({ posApi, session, currency }: { posApi: PosApi; session: any; currency: string }) {
  const today = localDateStr();
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
  const moreGrade = useRowMore();
  const morePump = useRowMore();
  // A467: the KPIs, by grade and by pump, from the loaded data.
  const sheets: ReportSheet[] = !data || ((data.grades ?? []).length === 0 && (data.pumps ?? []).length === 0) ? [] : [
    kpiSheet('Summary', [['Total Litres', data.summary.totalLitres], ['Revenue', data.summary.totalRevenue], ['Transactions', data.summary.totalTransactions]]),
    { name: 'By Grade', columns: [col('name', 'Grade'), num('litres', 'Litres'), money('revenue', 'Revenue'), money('perLitre', 'Avg Price/L')],
      rows: (data.grades ?? []).map((g: any) => ({ ...g, perLitre: g.litres > 0 ? g.revenue / g.litres : 0 })) },
    { name: 'By Pump', columns: [col('pump_name', 'Pump'), num('litres', 'Litres'), money('revenue', 'Revenue'), num('transactions', 'Transactions', 0)],
      rows: data.pumps ?? [] },
  ];

  return (
    <div className="space-y-5">
      <DateBar from={from} to={to} setFrom={setFrom} setTo={setTo} onApply={() => load(from, to)} loading={loading}
        report="Fuel Sales" sheets={sheets} branchName={session?.branchName} />
      {error && <ErrorMsg msg={error} />}
      {loading && <Spinner />}
      {!loading && data && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {[
              { label: 'Total Litres', value: fmt.litres(data.summary.totalLitres, 1), color: '#f59e0b' },
              { label: 'Revenue', value: fmt.money(data.summary.totalRevenue, currency), color: '#22c55e' },
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
              <div className="overflow-x-auto"><table className="w-full text-sm">
                <thead className="bg-gray-700/30"><tr>
                  {['Grade','Litres','Revenue','Avg Price/L'].map((h, i) => (
                    <th key={h} className={`text-left text-xs text-gray-400 px-4 py-3 font-medium${i === 1 || i === 3 ? ` ${DESK}` : ''}`}>{h}</th>
                  ))}
                </tr></thead>
                <tbody className="divide-y divide-gray-800">
                  {data.grades.map((g: any) => (
                    <Fragment key={g.product_id}>
                    <tr className="hover:bg-gray-800/30 transition-colors">
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-2">
                          <div className="w-2 h-2 rounded-full" style={{ background: gc(g.name) }} />
                          <span className="text-white font-medium">{g.name}</span>
                        </div>
                        <ViewMore open={moreGrade.isOpen(String(g.product_id))} onClick={() => moreGrade.toggle(String(g.product_id))} />
                      </td>
                      <td className={`px-4 py-2.5 text-amber-400 font-semibold tabular-nums ${DESK}`}>{fmt.litres(g.litres, 1)}</td>
                      <td className="px-4 py-2.5 text-white font-medium tabular-nums">{fmt.money(g.revenue, currency)}</td>
                      <td className={`px-4 py-2.5 text-gray-400 tabular-nums ${DESK}`}>{fmt.money(g.litres > 0 ? g.revenue / g.litres : 0, currency)}/L</td>
                    </tr>
                    <MoreRow open={moreGrade.isOpen(String(g.product_id))} colSpan={2} items={[
                      ['Litres', fmt.litres(g.litres, 1)],
                      ['Avg Price/L', `${fmt.money(g.litres > 0 ? g.revenue / g.litres : 0, currency)}/L`],
                    ]} />
                    </Fragment>
                  ))}
                </tbody>
              </table></div>
            </div>
          )}
          {data.pumps.length > 0 && (
            <div className="bg-gray-800/50 border border-gray-700 rounded-2xl overflow-hidden">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider px-5 py-4 border-b border-gray-700">By Pump</p>
              <div className="overflow-x-auto"><table className="w-full text-sm">
                <thead className="bg-gray-700/30"><tr>
                  {['Pump','Litres','Revenue','Transactions'].map((h, i) => (
                    <th key={h} className={`text-left text-xs text-gray-400 px-4 py-3 font-medium${i === 1 || i === 3 ? ` ${DESK}` : ''}`}>{h}</th>
                  ))}
                </tr></thead>
                <tbody className="divide-y divide-gray-800">
                  {data.pumps.map((p: any) => (
                    <Fragment key={p.pump_id}>
                    <tr className="hover:bg-gray-800/30 transition-colors">
                      <td className="px-4 py-2.5 text-white font-medium">⛽ {p.pump_name}
                        <ViewMore open={morePump.isOpen(String(p.pump_id))} onClick={() => morePump.toggle(String(p.pump_id))} />
                      </td>
                      <td className={`px-4 py-2.5 text-amber-400 tabular-nums ${DESK}`}>{fmt.litres(p.litres, 1)}</td>
                      <td className="px-4 py-2.5 text-white font-medium tabular-nums">{fmt.money(p.revenue, currency)}</td>
                      <td className={`px-4 py-2.5 text-gray-400 tabular-nums ${DESK}`}>{p.transactions}</td>
                    </tr>
                    <MoreRow open={morePump.isOpen(String(p.pump_id))} colSpan={2} items={[
                      ['Litres', fmt.litres(p.litres, 1)],
                      ['Transactions', p.transactions],
                    ]} />
                    </Fragment>
                  ))}
                </tbody>
              </table></div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Wet Stock Tab (Manager) ───────────────────────────────────────────────────

function WetStockTab({ posApi, session, currency }: { posApi: PosApi; session: any; currency: string }) {
  const today = localDateStr();
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
  // A475: the list in pages (25 / 50 / 100, remembered in this browser); a new search / filter / period → page 1, an edit keeps the page (clamped).
  const [deliveryPage, setDeliveryPage] = useState(1);
  const [deliveryPageSize, setDeliveryPageSize] = usePageSize('swiftpos.pageSize.manager.reports.wetStock.deliveries');
  useEffect(() => { setDeliveryPage(1); }, [from, to]);
  const deliveryPaged = paginate(((data?.deliveryLog ?? []) as any[]), deliveryPage, deliveryPageSize);
  useEffect(() => { if (deliveryPaged.page !== deliveryPage) setDeliveryPage(deliveryPaged.page); }, [deliveryPaged.page, deliveryPage]);

  function gc(name: string) {
    const n = name.toLowerCase();
    if (n.includes('diesel')) return '#f59e0b';
    if (n.includes('premium')) return '#a78bfa';
    if (n.includes('kero')) return '#06b6d4';
    return '#22c55e';
  }
  // A467: one row per tank card, and the delivery log.
  const sheets: ReportSheet[] = !data || ((data.tanks ?? []).length === 0 && (data.deliveryLog ?? []).length === 0) ? [] : [
    { name: 'Tanks',
      columns: [col('name', 'Tank'), col('product_name', 'Grade'), col('low', 'Low'), num('level_pct', 'Level %', 0), num('current_level', 'Current (L)'),
        num('delivered_litres', 'Delivered (L)'), num('consumed_litres', 'Dispensed (L)'), num('variance', 'Variance (L)')],
      rows: (data.tanks ?? []).map((t: any) => ({ ...t, low: t.is_low ? 'LOW' : '', variance: Number(t.delivered_litres ?? 0) - Number(t.consumed_litres ?? 0) })) },
    { name: 'Delivery Log', columns: [col('date', 'Date'), num('litres', 'Litres'), col('notes', 'Notes')],
      rows: (data.deliveryLog ?? []).map((d: any) => ({ ...d, date: localStamp(d.recorded_at) })) },
  ];

  return (
    <div className="space-y-5">
      <DateBar from={from} to={to} setFrom={setFrom} setTo={setTo} onApply={() => load(from, to)} loading={loading}
        report="Wet Stock" sheets={sheets} branchName={session?.branchName} />
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
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                    <div><p className="text-gray-500">Current</p><p className="text-white font-medium mt-0.5">{fmt.litres(tank.current_level, 1)}</p></div>
                    <div><p className="text-green-500">Delivered</p><p className="text-white font-medium mt-0.5">+{fmt.litres(tank.delivered_litres, 1)}</p></div>
                    <div><p className="text-amber-400">Dispensed</p><p className="text-white font-medium mt-0.5">{fmt.litres(tank.consumed_litres, 1)}</p></div>
                    <div>
                      <p className="text-gray-500">Variance</p>
                      <p className={`font-medium mt-0.5 ${Math.abs(tank.delivered_litres - tank.consumed_litres) < 50 ? 'text-gray-300' : 'text-red-400'}`}>
                        {tank.delivered_litres - tank.consumed_litres >= 0 ? '+' : ''}{fmt.litres(tank.delivered_litres - tank.consumed_litres, 1)}
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
              {deliveryPaged.items.map((d: any, j: number) => (
                <div key={deliveryPaged.from - 1 + j} className="flex items-center gap-3 px-5 py-3 border-b border-gray-800 last:border-0">
                  <span className="text-green-400 font-semibold">+{fmt.litres(d.litres, 1)}</span>
                  <span className="text-gray-500 text-xs flex-1">{d.notes ?? '—'}</span>
                  <span className="text-gray-600 text-xs">{fmt.dayTime(d.recorded_at)}</span>
                </div>
              ))}
              <Pager paged={deliveryPaged} noun="deliveries" onPage={setDeliveryPage} onSize={n => { setDeliveryPageSize(n); setDeliveryPage(1); }} />
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
              activeTab === t.id ? 'bg-swift-strong text-white' : 'text-gray-400 hover:text-white hover:bg-gray-700'
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
