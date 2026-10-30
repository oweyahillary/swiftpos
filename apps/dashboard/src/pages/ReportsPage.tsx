/**
 * ReportsPage.tsx  — Full Posist-style reporting suite for SwiftPOS.
 *
 * Tabs: Master/DSR · Hourly Sales · Item Mix · Voids & Exceptions · Tax · Staff
 */

import { useState, useEffect, useCallback, Fragment } from 'react';
import { useSearchParams } from 'react-router-dom';   // A576: the watch list's links open a filtered tab
import { DESK, useRowMore, ViewMore, MoreRow } from '../components/RowMore';   // A464
import { ReportsSkeleton } from './pos/cashier/POSSkeletons';
import { api, downloadFile } from '../lib/api';
import { useBusiness } from '../context/BusinessContext';
import { useBranch } from '../context/BranchContext';
import { localDateStr } from '../lib/localDate';
import { methodColour } from '@zaptill/core/paymentColours';   // A439
import MonthlyPackTab from './reports/MonthlyPackTab';   // A455
import DownloadExcelButton from '../components/DownloadExcelButton';   // A467
import { localStamp, type ReportColumn, type ReportSheet } from '../lib/reportDownload';   // A467
import { reportPresets, activePreset } from '../lib/reportPeriods';   // A467; activePreset: one preset lit
import * as fmt from '../lib/format';   // A471: one money/number/date format ('money' here is the Excel column shorthand)
import Pager, { usePageSize } from '../components/Pager';   // A475
import { paginate } from '@zaptill/core/paginate';

// ── Types ─────────────────────────────────────────────────────────────────────

interface DateRange { from: string; to: string }
/** A467: what the About sheet of a tab's Excel names. */
interface ReportMeta { businessName: string; branchName: string }
interface TabProps { range: DateRange; branchId: string; currency: string; meta: ReportMeta; /** A576: one staff member (the watch list's link). */ staffId?: string }

interface MasterReport {
  period: { from: string; to: string };
  branchName: string;
  summary: {
    totalSale: number; totalVat: number; totalCtl: number; totalDiscount: number;
    netSales: number; totalRevenue: number; totalOrders: number;
    voidedCount: number; voidedValue: number; avgOrderValue: number;
    totalExpenses: number; netProfit: number;
    /** A451: sales + delivery fees + tips — what the payment methods add up to. Absent from an older cloud. */
    totalDeliveryFees?: number; totalTips?: number; totalCollected?: number;
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
  /** Migration 133: offline till sales the cloud priced differently — kept at the till's price, the difference a loss.
   *  Absent from an older cloud. */
  price_differences?: {
    id: string; order_id: string; order_number: string | null; catalogue_total: number | string; till_total: number | string;
    difference: number | string; reason: string; suspicious: boolean; sold_at: string | null; created_at: string;
  }[];
  price_difference_summary?: { count: number; loss: number; suspicious: number };
}

interface RefundsReport {
  period: { from: string; to: string };
  refunds: {
    id: string; order_number: string; order_type: string; total: number;
    refunded_amount: number; refunded_at: string;
    refund_reason: string | null; cashier_id: string; cashier_name: string;
    refunded_by_name: string | null; authorized_by_name: string | null;
    branch_name: string; created_at: string;
  }[];
  summary: {
    totalRefunds: number; totalValue: number;
    byStaff: { cashier_id: string; name: string; count: number; value: number }[];
  };
}

interface InventoryReport {
  summary: {
    product_id: string; name: string; sold: number; revenue: number;
    restocked: number; written_off: number;
  }[];
  adjustments: { id: string; reason: string | null; created_at: string }[];
}

interface TaxReport {
  period: { from: string; to: string };
  rates: { vatRate: number; ctlRate: number };
  summary: { grossSales: number; vatTotal: number; ctlTotal: number; netSales: number; totalOrders: number };
  byCategory: { category: string; grossSales: number; vatAmount: number; ctlAmount: number; netSales: number }[];
  byBranch: { branchName: string; grossSales: number; vatAmount: number; ctlAmount: number; netSales: number }[];
}

interface StaffReport {
  // A259d: the server emits staff_id / staff_name / avg_order_value (not cashier_id /
  // name / branch). The owner table read the old field names, so the Cashier column
  // rendered blank. Match the real contract.
  staff: { staff_id: string; staff_name: string; orders: number; revenue: number; avg_order_value: number;
    /** A439: the cashier's money by payment method (adds up to revenue). Absent from an older server. */
    by_method?: { method: string; amount: number }[] }[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function today() { return localDateStr(); }

// ── A467: Download Excel — each tab's own data, one sheet per table ──────────
// Column shorthands: text, money (2 dp, #,##0.00), a number to `dp` places.
const col   = (key: string, label: string): ReportColumn => ({ key, label });
const money = (key: string, label: string): ReportColumn => ({ key, label, money: true });
const num   = (key: string, label: string, dp = 2): ReportColumn => ({ key, label, dp });
/** A KPI section as a two-column sheet (the tab's cards: label → figure). */
const kpiSheet = (name: string, rows: [string, unknown][]): ReportSheet => ({
  name, columns: [col('metric', 'Metric'), num('value', 'Value')],
  rows: rows.map(([metric, value]) => ({ metric, value })),
});
/** % of a whole, unrounded — the sheet rounds it. */
const share = (part: number, whole: number) => (whole > 0 ? (part / whole) * 100 : 0);

function ExcelButton({ report, range, meta, sheets }: { report: string; range: DateRange; meta: ReportMeta; sheets: ReportSheet[] }) {
  return <DownloadExcelButton input={{ report, from: range.from, to: range.to, businessName: meta.businessName, branchName: meta.branchName, sheets }} />;
}

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
  { id: 'monthly',    label: 'Monthly pack' },   // A455
  { id: 'hourly',     label: 'Hourly Sales' },
  { id: 'items',      label: 'Item Mix' },
  { id: 'matrix',     label: 'Menu Matrix' },
  { id: 'food_cost',  label: 'Food Cost' },
  { id: 'voids',      label: 'Voids & Exceptions' },
  { id: 'refunds',    label: 'Refunds' },
  { id: 'inventory',  label: 'Inventory' },
  { id: 'exports',    label: 'Exports' },
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
      ? 'bg-swift-strong border-swift-strong'
      : 'bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700'}`}>
      <p className={`text-xs font-medium uppercase tracking-wide mb-1 ${accent ? 'text-teal-100' : 'text-gray-500 dark:text-gray-400'}`}>{label}</p>
      <p className={`text-xl font-semibold tabular-nums ${accent ? 'text-white' : 'text-gray-900 dark:text-white'}`}>{value}</p>
      {sub && <p className={`text-xs mt-0.5 ${accent ? 'text-teal-100' : 'text-gray-400'}`}>{sub}</p>}
    </div>
  );
}

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-3">{title}</h3>
      <div className="overflow-x-auto">{children}</div>
    </div>
  );
}

function Th({ children, right = false, className = '' }: { children: React.ReactNode; right?: boolean; className?: string }) {
  return <th className={`text-xs text-gray-400 pb-2 font-medium ${right ? 'text-right' : 'text-left'}${className ? ` ${className}` : ''}`}>{children}</th>;
}

function Spinner() {
  return <ReportsSkeleton />;
}

function ErrMsg({ msg }: { msg: string }) {
  return <div className="text-red-500 py-6 text-sm">{msg}</div>;
}

// ── Date range bar ────────────────────────────────────────────────────────────

function DateRangeBar({ range, onChange, branches, branchId, onBranchChange, allLabel = 'All branches', showAll = true }: {
  range: DateRange; onChange: (r: DateRange) => void;
  branches: { id: string; name: string }[]; branchId: string; onBranchChange: (id: string) => void;
  /** A582: "All my branches (3)" for a partner of some branches; shown only where every branch in view is theirs to combine. */
  allLabel?: string; showAll?: boolean;
}) {
  // A467: Today · Yesterday · This week · Last week · This month · Last month — local (EAT) days, Monday-first weeks.
  const presets = reportPresets();
  const [picked, setPicked] = useState<string | null>(null);   // the preset clicked: only that one lights up
  const lit = activePreset(presets, range, picked);
  const inputCls = 'text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-1.5 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200';
  return (
    <div className="flex flex-wrap items-center gap-2 mb-5">
      {/* A467: six presets — on a phone the row scrolls sideways inside its box instead of widening the page. */}
      <div data-testid="report-presets" className="flex items-center gap-1 max-w-full overflow-x-auto bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-1">
        {presets.map(p => (
          <button key={p.label} onClick={() => { setPicked(p.label); onChange({ from: p.from, to: p.to }); }}
            className={`flex-shrink-0 whitespace-nowrap text-xs px-3 py-1.5 rounded-md transition-colors ${lit === p.label ? 'bg-swift-strong text-white' : 'text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'}`}>
            {p.label}
          </button>
        ))}
      </div>
      <input type="date" value={range.from} max={range.to} onChange={e => onChange({ ...range, from: e.target.value })} className={inputCls} />
      <span className="text-gray-400 text-sm">→</span>
      <input type="date" value={range.to} min={range.from} onChange={e => onChange({ ...range, to: e.target.value })} className={inputCls} />
      {branches.length > 1 && (
        <select value={branchId} onChange={e => onBranchChange(e.target.value)} className={inputCls}>
          {showAll && <option value="">{allLabel}</option>}
          {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
      )}
    </div>
  );
}

// ── Tab: Master / DSR ─────────────────────────────────────────────────────────

function MasterTab({ range, branchId, currency, meta, staffId }: TabProps) {
  const { allLabel } = useBranch();   // A582: "All my branches (3)" for a partner of some branches
  const [data, setData]     = useState<MasterReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]   = useState('');
  const more = useRowMore();   // A464: Category Breakdown on a phone: Category, Net Sales, Share

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const p = new URLSearchParams({ from: range.from, to: range.to });
      if (branchId) p.set('branch_id', branchId);
      if (staffId) p.set('cashier_id', staffId);   // A576
      setData(await api.get<MasterReport>(`/api/reports/master?${p}`));
    } catch (e: any) { setError(e.message ?? 'Failed to load'); }
    finally { setLoading(false); }
  }, [range.from, range.to, branchId, staffId]);
  useEffect(() => { load(); }, [load]);

  if (loading) return <Spinner />;
  if (error)   return <ErrMsg msg={error} />;
  if (!data)   return null;

  const { summary, channels, payments, categoryBreakdown, expenses } = data;
  const maxCh = Math.max(...channels.map(c => c.amount), 1);
  const paidTotal = payments.reduce((s, p) => s + Number(p.amount || 0), 0);   // A451: what the payment methods add up to

  // A467: the tab's sections, from its data.
  const sheets: ReportSheet[] = [
    kpiSheet('Sale Summary', [
      ['Total Collected (incl. VAT)', summary.totalCollected ?? summary.totalSale],
      ['Delivery fees', summary.totalDeliveryFees ?? 0],
      ['Tips', summary.totalTips ?? 0],
      ['Gross Sales (incl. VAT)', summary.totalSale],
      ['VAT 16%', summary.totalVat],
      ['CTL 2%', summary.totalCtl],
      ['Net Sales', summary.netSales],
      ['Total Orders', summary.totalOrders],
      ['Avg Order', summary.avgOrderValue],
      ['Discounts', summary.totalDiscount],
      ['Voided Bills', summary.voidedCount],
      ['Voided Value', summary.voidedValue],
      ['Expenses', summary.totalExpenses],
      ['Net Profit', summary.netProfit],
    ]),
    { name: 'Order Channels', columns: [col('channel', 'Channel'), money('amount', 'Amount'), num('pct', 'Share %', 1)],
      rows: channels.filter(c => c.amount > 0).sort((a, b) => b.amount - a.amount)
        .map(c => ({ channel: CHANNEL_LABELS[c.channel] ?? c.channel, amount: c.amount, pct: c.pct })) },
    { name: 'Payment Methods', columns: [col('method', 'Method'), money('amount', 'Amount'), num('pct', 'Share %', 1)],
      rows: [...[...payments].sort((a, b) => b.amount - a.amount)
        .map(p => ({ method: p.method.replace(/_/g, ' '), amount: p.amount, pct: share(p.amount, paidTotal) })),
        ...(payments.length > 0 ? [{ method: 'Total paid', amount: paidTotal, pct: null }] : [])] },
    { name: 'Category Breakdown',
      columns: [col('category', 'Category'), col('superCategory', 'Super Category'), num('qty', 'Qty', 3), money('netSales', 'Net Sales'), num('pct', 'Share %', 1)],
      rows: categoryBreakdown.map(r => ({ ...r, pct: share(r.netSales, summary.totalRevenue) })) },
    ...(expenses.total > 0 ? [{ name: 'Expenses', columns: [col('category', 'Category'), money('amount', 'Amount')], rows: expenses.breakdown }] : []),
  ];

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold text-gray-900 dark:text-white">{data.branchName || allLabel}</h2>
          <p className="text-xs text-gray-400 mt-0.5">{range.from} — {range.to}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
        <ExcelButton report="Master DSR" range={range} meta={meta} sheets={sheets} />
        <button
          onClick={() => {
            const p = new URLSearchParams({ from: range.from, to: range.to, format: 'xlsx' });
            if (branchId) p.set('branch_id', branchId);
            void downloadFile(`/api/reports/export/sales?${p}`, `zaptill-sales-${range.from}_${range.to}.xlsx`)
              .catch((e: any) => alert(e?.message ?? 'Download failed'));
          }}
          title="The server's sales export — every order, tender and total"
          className="text-xs px-3 py-1.5 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-200 rounded-lg transition-colors"
        >↓ Orders export</button>
        </div>
      </div>

      {/* KPI rows */}
      <div>
        <p className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-2">Sale Summary</p>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-3">
          {/* A451: what was paid, VAT included — the sales plus delivery fees and tips; the payment methods add up to it. */}
          <KpiCard label="Total Collected (incl. VAT)" value={fmt.money(summary.totalCollected ?? summary.totalSale, currency, { blank: '—' })}
            sub={`sales ${fmt.money(summary.totalSale, currency, { blank: '—' })}${(summary.totalDeliveryFees ?? 0) > 0 ? ` + delivery ${fmt.money(summary.totalDeliveryFees!, currency, { blank: '—' })}` : ''}${(summary.totalTips ?? 0) > 0 ? ` + tips ${fmt.money(summary.totalTips!, currency, { blank: '—' })}` : ''}`} />
          <KpiCard label="Gross Sales (incl. VAT)"  value={fmt.money(summary.totalSale, currency, { blank: '—' })} />
          <KpiCard label="VAT 16%"      value={fmt.money(summary.totalVat, currency, { blank: '—' })} />
          <KpiCard label="CTL 2%"       value={fmt.money(summary.totalCtl, currency, { blank: '—' })} />
          <KpiCard label="Net Sales"    value={fmt.money(summary.netSales, currency, { blank: '—' })} accent />
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <KpiCard label="Total Orders"  value={summary.totalOrders.toString()} sub={`avg ${fmt.money(summary.avgOrderValue, currency, { blank: '—' })}`} />
          <KpiCard label="Discounts"     value={fmt.money(summary.totalDiscount, currency, { blank: '—' })} />
          <KpiCard label="Voided Bills"  value={summary.voidedCount.toString()} sub={fmt.money(summary.voidedValue, currency, { blank: '—' })} />
          <KpiCard label="Net Profit"    value={fmt.money(summary.netProfit, currency, { blank: '—' })} sub={`after ${fmt.money(summary.totalExpenses, currency, { blank: '—' })} expenses`} />
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
                    {fmt.money(ch.amount, currency, { blank: '—' })} <span className="text-gray-400 font-normal">{fmt.pct(ch.pct)}</span>
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
            {payments.length > 0 && (
              <tfoot>
                <tr className="border-t border-gray-200 dark:border-gray-600">
                  <td className="pt-2 font-semibold text-gray-900 dark:text-white">Total paid</td>
                  <td className="pt-2 text-right font-semibold tabular-nums text-gray-900 dark:text-white">{fmt.money(paidTotal, currency, { blank: '—' })}</td>
                  <td />
                </tr>
              </tfoot>
            )}
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
              {payments.sort((a, b) => b.amount - a.amount).map(p => (
                <tr key={p.method}>
                  <td className="py-2 text-gray-700 dark:text-gray-300 capitalize">{p.method.replace(/_/g, ' ')}</td>
                  <td className="py-2 text-right font-medium tabular-nums text-gray-900 dark:text-white">{fmt.money(p.amount, currency, { blank: '—' })}</td>
                  {/* A451: a share of what was PAID (it includes delivery fees and tips) — the shares add up to 100%. */}
                  <td className="py-2 text-right text-gray-400 w-14">{fmt.pct(paidTotal > 0 ? (p.amount / paidTotal) * 100 : 0)}</td>
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
              <Th className={DESK}>Super Category</Th>
              <Th right className={DESK}>Qty</Th>
              <Th right>Net Sales</Th>
              <Th right>Share</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50 dark:divide-gray-700/50">
            {categoryBreakdown.map(row => (
              <Fragment key={row.category}>
              <tr>
                <td className="py-2 text-gray-800 dark:text-gray-200">{row.category}
                  <ViewMore open={more.isOpen(String(row.category))} onClick={() => more.toggle(String(row.category))} />
                </td>
                <td className={`py-2 text-gray-400 dark:text-gray-500 text-xs ${DESK}`}>{row.superCategory}</td>
                <td className={`py-2 text-right tabular-nums text-gray-700 dark:text-gray-300 ${DESK}`}>{fmt.qty(row.qty)}</td>
                <td className="py-2 text-right tabular-nums font-medium text-gray-900 dark:text-white">{fmt.money(row.netSales, currency, { blank: '—' })}</td>
                <td className="py-2 text-right text-gray-400 text-xs">{fmt.pct(summary.totalRevenue > 0 ? (row.netSales / summary.totalRevenue) * 100 : 0)}</td>
              </tr>
              <MoreRow open={more.isOpen(String(row.category))} colSpan={3} items={[
                ['Super Category', row.superCategory],
                ['Qty', fmt.qty(row.qty)],
              ]} />
              </Fragment>
            ))}
          </tbody>
        </table>
      </SectionCard>

      {/* Expenses */}
      {expenses.total > 0 && (
        <SectionCard title={`Expenses — ${fmt.money(expenses.total, currency, { blank: '—' })} total`}>
          <table className="w-full text-sm">
            <tbody className="divide-y divide-gray-50 dark:divide-gray-700/50">
              {expenses.breakdown.map(e => (
                <tr key={e.category}>
                  <td className="py-2 text-gray-700 dark:text-gray-300">{e.category}</td>
                  <td className="py-2 text-right font-medium tabular-nums text-gray-900 dark:text-white">{fmt.money(e.amount, currency, { blank: '—' })}</td>
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

function HourlyTab({ range, branchId, currency, meta }: TabProps) {
  const [data, setData]       = useState<HourlyReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const more = useRowMore();   // A464: Hourly Detail on a phone: Hour, Orders, Revenue

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
  const hasSales = data.hourly.some(h => h.orders > 0 || h.revenue > 0);

  // A467: the tab's sections, from its data.
  const sheets: ReportSheet[] = hasSales ? [
    kpiSheet('Summary', [
      ['Peak Hour', data.peakHour != null ? data.peakHour : null],
      ['Peak Hour Revenue', data.peakRevenue],
      ['Active Hours', activeHours.length],
      ['Avg / Active Hour', activeHours.reduce((s, h) => s + h.revenue, 0) / Math.max(activeHours.length, 1)],
    ]),
    { name: 'Revenue by Hour', columns: [col('label', 'Hour'), num('orders', 'Orders', 0), money('revenue', 'Revenue')], rows: data.hourly },
    { name: 'Revenue by Day of Week', columns: [col('day', 'Day'), num('orders', 'Orders', 0), money('revenue', 'Revenue')], rows: data.dayOfWeek },
    { name: 'Hourly Detail',
      columns: [col('label', 'Hour'), num('orders', 'Orders', 0), money('revenue', 'Revenue'), money('avgOrderValue', 'Avg Order'), col('peak', 'Peak')],
      rows: activeHours.map(h => ({ ...h, peak: h.hour === data.peakHour ? 'peak' : '' })) },
  ] : [];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <ExcelButton report="Hourly Sales" range={range} meta={meta} sheets={sheets} />
        <button
          onClick={() => {
            const p = new URLSearchParams({ from: range.from, to: range.to, format: 'xlsx' });
            if (branchId) p.set('branch_id', branchId);
            void downloadFile(`/api/reports/export/hourly?${p}`, `zaptill-hourly-${range.from}_${range.to}.xlsx`)
              .catch((e: any) => alert(e?.message ?? 'Download failed'));
          }}
          title="The server's hourly export — revenue by hour with the channel split"
          className="text-xs px-3 py-1.5 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-200 rounded-lg transition-colors"
        >↓ By channel export</button>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <KpiCard label="Peak Hour" value={data.peakHour != null ? `${String(data.peakHour).padStart(2,'0')}:00` : '—'} sub={fmt.money(data.peakRevenue, currency, { blank: '—' })} accent />
        <KpiCard label="Active Hours" value={activeHours.length.toString()} sub="hours with sales" />
        <KpiCard label="Avg / Active Hour" value={fmt.money(activeHours.reduce((s,h)=>s+h.revenue,0) / Math.max(activeHours.length,1), currency, { blank: '—' })} />
      </div>

      <SectionCard title="Revenue by Hour">
        <div className="overflow-x-auto">
          <div className="flex items-end gap-0.5 h-36 min-w-[600px]">
            {data.hourly.map(h => {
              const barH = h.revenue > 0 ? Math.max(3, (h.revenue / maxH) * 100) : 0;
              const isPeak = h.hour === data.peakHour;
              return (
                <div key={h.hour} title={`${h.label}: ${fmt.money(h.revenue, currency, { blank: '—' })} (${h.orders} orders)`}
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
              <div key={d.day} title={`${d.day}: ${fmt.money(d.revenue, currency, { blank: '—' })}`}
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
              <Th>Hour</Th><Th right>Orders</Th><Th right>Revenue</Th><Th right className={DESK}>Avg Order</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50 dark:divide-gray-700/50">
            {activeHours.map(h => (
              <Fragment key={h.hour}>
              <tr className={h.hour === data.peakHour ? 'bg-blue-50 dark:bg-blue-900/20' : ''}>
                <td className="py-1.5 text-gray-700 dark:text-gray-300">
                  {h.label}
                  {h.hour === data.peakHour && <span className="ml-2 text-[10px] bg-blue-100 dark:bg-blue-800 text-blue-700 dark:text-blue-200 px-1.5 py-0.5 rounded">peak</span>}
                  <ViewMore open={more.isOpen(String(h.hour))} onClick={() => more.toggle(String(h.hour))} />
                </td>
                <td className="py-1.5 text-right tabular-nums text-gray-600 dark:text-gray-400">{h.orders}</td>
                <td className="py-1.5 text-right tabular-nums font-medium text-gray-900 dark:text-white">{fmt.money(h.revenue, currency, { blank: '—' })}</td>
                <td className={`py-1.5 text-right tabular-nums text-gray-500 ${DESK}`}>{fmt.money(h.avgOrderValue, currency, { blank: '—' })}</td>
              </tr>
              <MoreRow open={more.isOpen(String(h.hour))} colSpan={3} items={[
                ['Avg Order', fmt.money(h.avgOrderValue, currency, { blank: '—' })],
              ]} />
              </Fragment>
            ))}
          </tbody>
        </table>
      </SectionCard>
    </div>
  );
}

// ── Tab: Item Mix ─────────────────────────────────────────────────────────────

function ItemMixTab({ range, branchId, currency, meta }: TabProps) {
  const [data, setData]       = useState<ProductV2Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const more = useRowMore();   // A464: a phone shows Item, Qty, Revenue
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

  const filtered = (data?.products ?? [])
    .filter(p => p.name.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => sortBy === 'qty' ? b.qty - a.qty : sortBy === 'margin' ? (b.gross_margin_pct ?? -99) - (a.gross_margin_pct ?? -99) : b.revenue - a.revenue);
  // A475: the list in pages (25 / 50 / 100, remembered in this browser); a new search / filter / period → page 1, an edit keeps the page (clamped).
  const [itemPage, setItemPage] = useState(1);
  const [itemPageSize, setItemPageSize] = usePageSize('swiftpos.pageSize.reports.itemMix');
  useEffect(() => { setItemPage(1); }, [range.from, range.to, branchId, search, sortBy]);
  const itemPaged = paginate(filtered, itemPage, itemPageSize);
  useEffect(() => { if (itemPaged.page !== itemPage) setItemPage(itemPaged.page); }, [itemPaged.page, itemPage]);

  if (loading) return <Spinner />;
  if (error)   return <ErrMsg msg={error} />;
  if (!data)   return null;

  // A467: the item table as shown — the search and the sort applied.
  const sheets: ReportSheet[] = [{
    name: 'Item Mix',
    columns: [num('n', '#', 0), col('name', 'Item'), col('category', 'Category'), num('qty', 'Qty', 3), money('revenue', 'Revenue'),
      num('contribution_pct', 'Share %', 1), money('total_cost', 'Cost'), num('gross_margin_pct', 'Margin %', 1)],
    rows: filtered.map((p, i) => ({ ...p, n: i + 1 })),
  }];

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
        <button
          onClick={() => {
            const p = new URLSearchParams({ from: range.from, to: range.to, format: 'xlsx' });
            if (branchId) p.set('branch_id', branchId);
            void downloadFile(`/api/reports/export/products?${p}`, `zaptill-products-${range.from}_${range.to}.xlsx`)
              .catch((e: any) => alert(e?.message ?? 'Download failed'));
          }}
          title="The server's products export — every product, unfiltered"
          className="text-xs px-3 py-1.5 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-200 rounded-lg transition-colors"
        >↓ Products export</button>
        <ExcelButton report="Item Mix" range={range} meta={meta} sheets={sheets} />
      </div>

      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-700/50">
              <tr>
                <th className={`text-left text-xs text-gray-400 px-4 py-2.5 font-medium ${DESK}`}>#</th>
                <th className="text-left text-xs text-gray-400 px-2 py-2.5 font-medium pl-4 sm:pl-2">Item</th>
                <th className={`text-left text-xs text-gray-400 px-2 py-2.5 font-medium ${DESK}`}>Category</th>
                <th className="text-right text-xs text-gray-400 px-2 py-2.5 font-medium">Qty</th>
                <th className="text-right text-xs text-gray-400 px-2 py-2.5 font-medium pr-4 sm:pr-2">Revenue</th>
                <th className={`text-right text-xs text-gray-400 px-2 py-2.5 font-medium ${DESK}`}>Share</th>
                <th className={`text-right text-xs text-gray-400 px-2 py-2.5 font-medium ${DESK}`}>Cost</th>
                <th className={`text-right text-xs text-gray-400 px-4 py-2.5 font-medium ${DESK}`}>Margin</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50 dark:divide-gray-700/50">
              {itemPaged.items.map((p, j) => {
                const i = itemPaged.from - 1 + j;   // A475: the rank over the whole list, not the page
                const cost = p.total_cost != null ? fmt.money(p.total_cost, currency, { blank: '—' }) : <span className="text-gray-300 dark:text-gray-600">—</span>;
                const margin = p.gross_margin_pct != null
                      ? <span className={`text-xs font-medium tabular-nums ${p.gross_margin_pct >= 60 ? 'text-green-600' : p.gross_margin_pct >= 30 ? 'text-amber-600' : 'text-red-500'}`}>{fmt.pct(p.gross_margin_pct)}</span>
                      : <span className="text-gray-300 dark:text-gray-600 text-xs">—</span>;
                return (
                <Fragment key={p.product_id}>
                <tr className="hover:bg-gray-50 dark:hover:bg-gray-700/30">
                  <td className={`px-4 py-2 text-gray-300 dark:text-gray-600 text-xs tabular-nums ${DESK}`}>{i + 1}</td>
                  <td className="px-2 py-2 text-gray-800 dark:text-gray-200 pl-4 sm:pl-2">{p.name}
                    <ViewMore open={more.isOpen(String(p.product_id))} onClick={() => more.toggle(String(p.product_id))} />
                  </td>
                  <td className={`px-2 py-2 text-gray-500 dark:text-gray-400 text-xs ${DESK}`}>{p.category || '—'}</td>
                  <td className="px-2 py-2 text-right tabular-nums text-gray-700 dark:text-gray-300">{fmt.qty(p.qty)}</td>
                  <td className="px-2 py-2 text-right tabular-nums font-medium text-gray-900 dark:text-white pr-4 sm:pr-2">{fmt.money(p.revenue, currency, { blank: '—' })}</td>
                  <td className={`px-2 py-2 text-right ${DESK}`}>
                    <div className="flex items-center justify-end gap-1.5">
                      <div className="w-14 bg-gray-100 dark:bg-gray-700 rounded-full h-1.5 overflow-hidden">
                        <div className="bg-blue-500 h-full rounded-full" style={{ width: `${p.contribution_pct}%` }} />
                      </div>
                      <span className="text-xs text-gray-400 tabular-nums w-9 text-right">{fmt.pct(p.contribution_pct)}</span>
                    </div>
                  </td>
                  <td className={`px-2 py-2 text-right tabular-nums text-gray-500 text-xs ${DESK}`}>
                    {cost}
                  </td>
                  <td className={`px-4 py-2 text-right ${DESK}`}>
                    {margin}
                  </td>
                </tr>
                <MoreRow open={more.isOpen(String(p.product_id))} colSpan={3} items={[
                  ['#', i + 1],
                  ['Category', p.category || '—'],
                  ['Share', fmt.pct(p.contribution_pct)],
                  ['Cost', cost],
                  ['Margin', margin],
                ]} />
                </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        <Pager paged={itemPaged} noun="items" onPage={setItemPage} onSize={n => { setItemPageSize(n); setItemPage(1); }} />
      </div>
    </div>
  );
}

// ── Tab: Voids & Exceptions ───────────────────────────────────────────────────

function VoidsTab({ range, branchId, currency, meta, staffId }: TabProps) {
  const [data, setData]       = useState<VoidsReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const more = useRowMore();   // A464: the log on a phone shows Order, Cashier, Amount

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const p = new URLSearchParams({ from: range.from, to: range.to });
      if (branchId) p.set('branch_id', branchId);
      if (staffId) p.set('cashier_id', staffId);   // A576
      setData(await api.get<VoidsReport>(`/api/reports/voids?${p}`));
    } catch (e: any) { setError(e.message ?? 'Failed'); }
    finally { setLoading(false); }
  }, [range.from, range.to, branchId, staffId]);
  useEffect(() => { load(); }, [load]);
  // A475: the list in pages (25 / 50 / 100, remembered in this browser); a new search / filter / period → page 1, an edit keeps the page (clamped).
  const [voidPage, setVoidPage] = useState(1);
  const [voidPageSize, setVoidPageSize] = usePageSize('swiftpos.pageSize.reports.voids');
  useEffect(() => { setVoidPage(1); }, [range.from, range.to, branchId]);
  const voidPaged = paginate(data?.voids ?? [], voidPage, voidPageSize);
  useEffect(() => { if (voidPaged.page !== voidPage) setVoidPage(voidPaged.page); }, [voidPaged.page, voidPage]);
  // Migration 133: the offline sales priced differently, in pages like the void log.
  const [diffPage, setDiffPage] = useState(1);
  const [diffPageSize, setDiffPageSize] = usePageSize('swiftpos.pageSize.reports.priceDiffs');
  useEffect(() => { setDiffPage(1); }, [range.from, range.to, branchId]);
  const diffPaged = paginate(data?.price_differences ?? [], diffPage, diffPageSize);
  useEffect(() => { if (diffPaged.page !== diffPage) setDiffPage(diffPaged.page); }, [diffPaged.page, diffPage]);

  if (loading) return <Spinner />;
  if (error)   return <ErrMsg msg={error} />;
  if (!data)   return null;

  // A467: the tab's sections, from its data.
  const diffs = data.price_differences ?? [];
  const diffSummary = data.price_difference_summary ?? { count: diffs.length, loss: 0, suspicious: 0 };
  const sheets: ReportSheet[] = [
    ...(data.voids.length === 0 && data.summary.byStaff.length === 0 ? [] : [
      kpiSheet('Summary', [['Total Voids', data.summary.totalVoids], ['Voided Value', data.summary.totalValue], ['Staff Involved', data.summary.byStaff.length]]),
      { name: 'Voids by Cashier', columns: [col('name', 'Cashier'), num('count', 'Count', 0), money('value', 'Value')], rows: data.summary.byStaff },
      { name: 'Void Log',
        columns: [col('order_number', 'Order'), col('cashier_name', 'Cashier'), col('authorized_by_name', 'Authorized by'), col('void_reason', 'Reason'), money('total', 'Amount'), col('time', 'Time')],
        rows: data.voids.map(v => ({ ...v, time: localStamp(v.created_at) })) },
    ] as ReportSheet[]),
    ...(diffs.length === 0 ? [] : [
      { name: 'Offline Price Differences',
        columns: [col('order_number', 'Order'), money('catalogue_total', 'Catalogue price'), money('till_total', 'POS charged'), money('difference', 'Loss'), col('reason', 'Why'), col('flag', 'Flag'), col('time', 'Sold')],
        rows: diffs.map(d => ({ ...d, catalogue_total: Number(d.catalogue_total), till_total: Number(d.till_total), difference: Number(d.difference),
          flag: d.suspicious ? 'Over half the price' : '', time: localStamp(d.sold_at ?? d.created_at) })) },
    ] as ReportSheet[]),
  ];

  return (
    <div className="space-y-5">
      <div className="flex justify-end"><ExcelButton report="Voids & Exceptions" range={range} meta={meta} sheets={sheets} /></div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <KpiCard label="Total Voids"   value={data.summary.totalVoids.toString()} accent={data.summary.totalVoids > 0} />
        <KpiCard label="Voided Value"  value={fmt.money(data.summary.totalValue, currency, { blank: '—' })} />
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
                  <td className="py-2 text-right tabular-nums font-medium text-red-600 dark:text-red-400">{fmt.money(s.value, currency, { blank: '—' })}</td>
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
          : (<>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 dark:bg-gray-700/50">
                  <tr>
                    <th className="text-left text-xs text-gray-400 px-4 py-2.5 font-medium">Order</th>
                    <th className="text-left text-xs text-gray-400 px-2 py-2.5 font-medium">Cashier</th>
                    <th className={`text-left text-xs text-gray-400 px-2 py-2.5 font-medium ${DESK}`}>Authorized by</th>
                    <th className={`text-left text-xs text-gray-400 px-2 py-2.5 font-medium ${DESK}`}>Reason</th>
                    <th className="text-right text-xs text-gray-400 px-2 py-2.5 font-medium pr-4 sm:pr-2">Amount</th>
                    <th className={`text-right text-xs text-gray-400 px-4 py-2.5 font-medium ${DESK}`}>Time</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50 dark:divide-gray-700/50">
                  {voidPaged.items.map(v => (
                    <Fragment key={v.id}>
                    <tr className="hover:bg-gray-50 dark:hover:bg-gray-700/30">
                      <td className="px-4 py-2 font-mono text-xs text-gray-500 dark:text-gray-400">{v.order_number}
                        <ViewMore open={more.isOpen(String(v.id))} onClick={() => more.toggle(String(v.id))} />
                      </td>
                      <td className="px-2 py-2 text-gray-700 dark:text-gray-300">{v.cashier_name}</td>
                      <td className={`px-2 py-2 text-xs text-gray-600 dark:text-gray-400 ${DESK}`}>{v.authorized_by_name ?? '—'}</td>
                      <td className={`px-2 py-2 text-gray-500 dark:text-gray-400 text-xs ${DESK}`}>{v.void_reason || '—'}</td>
                      <td className="px-2 py-2 text-right tabular-nums text-red-600 dark:text-red-400 font-medium pr-4 sm:pr-2">{fmt.money(v.total, currency, { blank: '—' })}</td>
                      <td className={`px-4 py-2 text-right text-xs text-gray-400 ${DESK}`}>
                        {fmt.dateTime(v.created_at)}
                      </td>
                    </tr>
                    <MoreRow open={more.isOpen(String(v.id))} colSpan={3} items={[
                      ['Authorized by', v.authorized_by_name ?? '—'],
                      ['Reason', v.void_reason || '—'],
                      ['Time', fmt.dateTime(v.created_at)],
                    ]} />
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager paged={voidPaged} noun="voids" onPage={setVoidPage} onSize={n => { setVoidPageSize(n); setVoidPage(1); }} />
          </>)}
      </div>

      {/* Migration 133 (owner, 2026-10-14: "let the sale go through but count it as a loss"): a till's offline sale the
          cloud prices differently is kept at what the till charged; the difference is shown here. */}
      {diffs.length > 0 && (
        <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100 dark:border-gray-700 flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">Price differences on offline sales</h3>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {diffSummary.count} sale{diffSummary.count === 1 ? '' : 's'} · loss {fmt.money(diffSummary.loss, currency, { blank: '—' })}
              {diffSummary.suspicious > 0 && <span className="ml-2 font-semibold text-red-600 dark:text-red-400">{diffSummary.suspicious} over half the price</span>}
            </p>
          </div>
          <p className="px-4 pt-3 text-xs text-gray-500 dark:text-gray-400">
            Sold on a POS while offline, at the POS's price; the menu price was different when the sale reached the cloud.
            The sale is kept as the customer paid it — the difference is counted as a loss.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 dark:bg-gray-700/50">
                <tr>
                  <th className="text-left text-xs text-gray-400 px-4 py-2.5 font-medium">Order</th>
                  <th className={`text-right text-xs text-gray-400 px-2 py-2.5 font-medium ${DESK}`}>Menu price</th>
                  <th className={`text-right text-xs text-gray-400 px-2 py-2.5 font-medium ${DESK}`}>POS charged</th>
                  <th className="text-right text-xs text-gray-400 px-2 py-2.5 font-medium">Loss</th>
                  <th className={`text-left text-xs text-gray-400 px-2 py-2.5 font-medium ${DESK}`}>Why</th>
                  <th className={`text-right text-xs text-gray-400 px-4 py-2.5 font-medium ${DESK}`}>Sold</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50 dark:divide-gray-700/50">
                {diffPaged.items.map(d => (
                  <Fragment key={d.id}>
                  <tr className={d.suspicious ? 'bg-red-50 dark:bg-red-900/20' : 'hover:bg-gray-50 dark:hover:bg-gray-700/30'}>
                    <td className="px-4 py-2 font-mono text-xs text-gray-500 dark:text-gray-400">{d.order_number ?? '—'}
                      {d.suspicious && <span className="ml-2 rounded bg-red-100 dark:bg-red-900/40 px-1.5 py-0.5 text-[10px] font-semibold text-red-700 dark:text-red-300">Check</span>}
                      <ViewMore open={more.isOpen(`pd-${d.id}`)} onClick={() => more.toggle(`pd-${d.id}`)} />
                    </td>
                    <td className={`px-2 py-2 text-right tabular-nums text-gray-600 dark:text-gray-400 ${DESK}`}>{fmt.money(Number(d.catalogue_total), currency, { blank: '—' })}</td>
                    <td className={`px-2 py-2 text-right tabular-nums text-gray-600 dark:text-gray-400 ${DESK}`}>{fmt.money(Number(d.till_total), currency, { blank: '—' })}</td>
                    <td className={`px-2 py-2 text-right tabular-nums font-medium ${Number(d.difference) > 0 ? 'text-red-600 dark:text-red-400' : 'text-gray-600 dark:text-gray-400'}`}>{fmt.money(Number(d.difference), currency, { blank: '—' })}</td>
                    <td className={`px-2 py-2 text-xs text-gray-500 dark:text-gray-400 ${DESK}`}>{d.reason}</td>
                    <td className={`px-4 py-2 text-right text-xs text-gray-400 ${DESK}`}>{fmt.dateTime(d.sold_at ?? d.created_at)}</td>
                  </tr>
                  <MoreRow open={more.isOpen(`pd-${d.id}`)} colSpan={2} items={[
                    ['Menu price', fmt.money(Number(d.catalogue_total), currency, { blank: '—' })],
                    ['POS charged', fmt.money(Number(d.till_total), currency, { blank: '—' })],
                    ['Why', d.reason],
                    ['Sold', fmt.dateTime(d.sold_at ?? d.created_at)],
                  ]} />
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
          <Pager paged={diffPaged} noun="sales" onPage={setDiffPage} onSize={n => { setDiffPageSize(n); setDiffPage(1); }} />
        </div>
      )}
    </div>
  );
}

// ── Tab: Tax Report ───────────────────────────────────────────────────────────

// ── Tab: Refunds ──────────────────────────────────────────────────────────────
// A193: standalone refund log — sibling of Voids & Exceptions. A refund keeps the
// sale 'completed', so it never shows in the Void Log; this is its audit surface.
function RefundsTab({ range, branchId, currency, meta, staffId }: TabProps) {
  const [data, setData]       = useState<RefundsReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const more = useRowMore();   // A464: the log on a phone shows Order, Cashier, Refunded

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const p = new URLSearchParams({ from: range.from, to: range.to });
      if (branchId) p.set('branch_id', branchId);
      if (staffId) p.set('cashier_id', staffId);   // A576
      setData(await api.get<RefundsReport>(`/api/reports/refunds?${p}`));
    } catch (e: any) { setError(e.message ?? 'Failed'); }
    finally { setLoading(false); }
  }, [range.from, range.to, branchId, staffId]);
  useEffect(() => { load(); }, [load]);
  // A475: the list in pages (25 / 50 / 100, remembered in this browser); a new search / filter / period → page 1, an edit keeps the page (clamped).
  const [refundPage, setRefundPage] = useState(1);
  const [refundPageSize, setRefundPageSize] = usePageSize('swiftpos.pageSize.reports.refunds');
  useEffect(() => { setRefundPage(1); }, [range.from, range.to, branchId]);
  const refundPaged = paginate(data?.refunds ?? [], refundPage, refundPageSize);
  useEffect(() => { if (refundPaged.page !== refundPage) setRefundPage(refundPaged.page); }, [refundPaged.page, refundPage]);

  if (loading) return <Spinner />;
  if (error)   return <ErrMsg msg={error} />;
  if (!data)   return null;

  // A467: the tab's sections, from its data.
  const sheets: ReportSheet[] = data.refunds.length === 0 && data.summary.byStaff.length === 0 ? [] : [
    kpiSheet('Summary', [['Total Refunds', data.summary.totalRefunds], ['Refunded Value', data.summary.totalValue], ['Staff Involved', data.summary.byStaff.length]]),
    { name: 'Refunds by Cashier', columns: [col('name', 'Cashier'), num('count', 'Count', 0), money('value', 'Value')], rows: data.summary.byStaff },
    { name: 'Refund Log',
      columns: [col('order_number', 'Order'), col('cashier_name', 'Cashier'), col('authorized', 'Authorized by'), col('refund_reason', 'Reason'), money('refunded_amount', 'Refunded'), col('time', 'Time')],
      rows: data.refunds.map(r => ({ ...r, authorized: r.authorized_by_name ?? r.refunded_by_name ?? '', time: localStamp(r.refunded_at) })) },
  ];

  return (
    <div className="space-y-5">
      <div className="flex justify-end"><ExcelButton report="Refunds" range={range} meta={meta} sheets={sheets} /></div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <KpiCard label="Total Refunds"  value={data.summary.totalRefunds.toString()} accent={data.summary.totalRefunds > 0} />
        <KpiCard label="Refunded Value" value={fmt.money(data.summary.totalValue, currency, { blank: '—' })} />
        <KpiCard label="Staff Involved" value={data.summary.byStaff.length.toString()} />
      </div>

      {data.summary.byStaff.length > 0 && (
        <SectionCard title="Refunds by Cashier">
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
                  <td className="py-2 text-right tabular-nums font-medium text-amber-600 dark:text-amber-400">{fmt.money(s.value, currency, { blank: '—' })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </SectionCard>
      )}

      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100 dark:border-gray-700">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">Refund Log</h3>
        </div>
        {data.refunds.length === 0
          ? <p className="text-center text-gray-400 py-10 text-sm">No refunds in this period ✓</p>
          : (<>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 dark:bg-gray-700/50">
                  <tr>
                    <th className="text-left text-xs text-gray-400 px-4 py-2.5 font-medium">Order</th>
                    <th className="text-left text-xs text-gray-400 px-2 py-2.5 font-medium">Cashier</th>
                    <th className={`text-left text-xs text-gray-400 px-2 py-2.5 font-medium ${DESK}`}>Authorized by</th>
                    <th className={`text-left text-xs text-gray-400 px-2 py-2.5 font-medium ${DESK}`}>Reason</th>
                    <th className="text-right text-xs text-gray-400 px-2 py-2.5 font-medium pr-4 sm:pr-2">Refunded</th>
                    <th className={`text-right text-xs text-gray-400 px-4 py-2.5 font-medium ${DESK}`}>Time</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50 dark:divide-gray-700/50">
                  {refundPaged.items.map(r => (
                    <Fragment key={r.id}>
                    <tr className="hover:bg-gray-50 dark:hover:bg-gray-700/30">
                      <td className="px-4 py-2 font-mono text-xs text-gray-500 dark:text-gray-400">{r.order_number}
                        <ViewMore open={more.isOpen(String(r.id))} onClick={() => more.toggle(String(r.id))} />
                      </td>
                      <td className="px-2 py-2 text-gray-700 dark:text-gray-300">{r.cashier_name}</td>
                      <td className={`px-2 py-2 text-xs text-gray-600 dark:text-gray-400 ${DESK}`}>{r.authorized_by_name ?? r.refunded_by_name ?? '—'}</td>
                      <td className={`px-2 py-2 text-gray-500 dark:text-gray-400 text-xs ${DESK}`}>{r.refund_reason || '—'}</td>
                      <td className="px-2 py-2 text-right tabular-nums text-amber-600 dark:text-amber-400 font-medium pr-4 sm:pr-2">{fmt.money(r.refunded_amount, currency, { blank: '—' })}</td>
                      <td className={`px-4 py-2 text-right text-xs text-gray-400 ${DESK}`}>
                        {fmt.dateTime(r.refunded_at)}
                      </td>
                    </tr>
                    <MoreRow open={more.isOpen(String(r.id))} colSpan={3} items={[
                      ['Authorized by', r.authorized_by_name ?? r.refunded_by_name ?? '—'],
                      ['Reason', r.refund_reason || '—'],
                      ['Time', fmt.dateTime(r.refunded_at)],
                    ]} />
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager paged={refundPaged} noun="refunds" onPage={setRefundPage} onSize={n => { setRefundPageSize(n); setRefundPage(1); }} />
          </>)}
      </div>
    </div>
  );
}

// ── Tab: Inventory ────────────────────────────────────────────────────────────
// A143: renders the existing GET /api/reports/inventory (sold / restocked /
// written-off per product) — the endpoint was live with no UI caller.
function InventoryTab({ range, branchId, currency, meta }: TabProps) {
  const [data, setData]       = useState<InventoryReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const more = useRowMore();   // A464: a phone shows Product, Sold, Written Off

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const p = new URLSearchParams({ from: range.from, to: range.to });
      if (branchId) p.set('branch_id', branchId);
      setData(await api.get<InventoryReport>(`/api/reports/inventory?${p}`));
    } catch (e: any) { setError(e.message ?? 'Failed'); }
    finally { setLoading(false); }
  }, [range.from, range.to, branchId]);
  useEffect(() => { load(); }, [load]);
  // A475: the list in pages (25 / 50 / 100, remembered in this browser); a new search / filter / period → page 1, an edit keeps the page (clamped).
  const [stockPage, setStockPage] = useState(1);
  const [stockPageSize, setStockPageSize] = usePageSize('swiftpos.pageSize.reports.inventory');
  useEffect(() => { setStockPage(1); }, [range.from, range.to, branchId]);
  const stockPaged = paginate(data?.summary ?? [], stockPage, stockPageSize);
  useEffect(() => { if (stockPaged.page !== stockPage) setStockPage(stockPaged.page); }, [stockPaged.page, stockPage]);

  if (loading) return <Spinner />;
  if (error)   return <ErrMsg msg={error} />;
  if (!data)   return null;

  const rows = data.summary;
  // A467: the tab's sections, from its data.
  const sheets: ReportSheet[] = rows.length === 0 ? [] : [
    kpiSheet('Summary', [['Products Moved', rows.length], ['Units Sold', rows.reduce((s, r) => s + r.sold, 0)], ['Units Written Off', rows.reduce((s, r) => s + r.written_off, 0)]]),
    { name: 'Stock Movement',
      columns: [col('name', 'Product'), num('sold', 'Sold', 3), money('revenue', 'Revenue'), num('restocked', 'Restocked', 3), num('written_off', 'Written Off', 3)],
      rows },
  ];
  return (
    <div className="space-y-5">
      <div className="flex justify-end"><ExcelButton report="Inventory" range={range} meta={meta} sheets={sheets} /></div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <KpiCard label="Products Moved" value={rows.length.toString()} />
        <KpiCard label="Units Sold"     value={fmt.qty(rows.reduce((s, r) => s + r.sold, 0))} />
        <KpiCard label="Units Written Off" value={fmt.qty(rows.reduce((s, r) => s + r.written_off, 0))} accent={rows.some(r => r.written_off > 0)} />
      </div>

      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100 dark:border-gray-700">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">Stock Movement</h3>
        </div>
        {rows.length === 0
          ? <p className="text-center text-gray-400 py-10 text-sm">No stock movement in this period.</p>
          : (<>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 dark:bg-gray-700/50">
                  <tr>
                    <th className="text-left text-xs text-gray-400 px-4 py-2.5 font-medium">Product</th>
                    <th className="text-right text-xs text-gray-400 px-2 py-2.5 font-medium">Sold</th>
                    <th className={`text-right text-xs text-gray-400 px-2 py-2.5 font-medium ${DESK}`}>Revenue</th>
                    <th className={`text-right text-xs text-gray-400 px-2 py-2.5 font-medium ${DESK}`}>Restocked</th>
                    <th className="text-right text-xs text-gray-400 px-4 py-2.5 font-medium">Written Off</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50 dark:divide-gray-700/50">
                  {stockPaged.items.map(r => (
                    <Fragment key={r.product_id}>
                    <tr className="hover:bg-gray-50 dark:hover:bg-gray-700/30">
                      <td className="px-4 py-2 text-gray-700 dark:text-gray-300">{r.name}
                        <ViewMore open={more.isOpen(String(r.product_id))} onClick={() => more.toggle(String(r.product_id))} />
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums text-gray-600 dark:text-gray-400">{fmt.qty(r.sold)}</td>
                      <td className={`px-2 py-2 text-right tabular-nums text-gray-600 dark:text-gray-400 ${DESK}`}>{fmt.money(r.revenue, currency, { blank: '—' })}</td>
                      <td className={`px-2 py-2 text-right tabular-nums text-green-600 dark:text-green-400 ${DESK}`}>{fmt.qty(r.restocked)}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-red-600 dark:text-red-400">{fmt.qty(r.written_off)}</td>
                    </tr>
                    <MoreRow open={more.isOpen(String(r.product_id))} colSpan={3} items={[
                      ['Revenue', fmt.money(r.revenue, currency, { blank: '—' })],
                      ['Restocked', <span className="text-green-600 dark:text-green-400">{fmt.qty(r.restocked)}</span>],
                    ]} />
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager paged={stockPaged} noun="products" onPage={setStockPage} onSize={n => { setStockPageSize(n); setStockPage(1); }} />
          </>)}
      </div>
    </div>
  );
}

// ── Tab: Exports ──────────────────────────────────────────────────────────────
// A143: one download hub for every server-side export format (they were live
// endpoints with no UI caller). Each opens /api/reports/export/<key> as xlsx for
// the current date range + branch.
const EXPORT_FORMATS: { key: string; label: string; desc: string }[] = [
  { key: 'sales',    label: 'Sales (DSR)',   desc: 'Daily sales report — orders, tenders, totals' },
  { key: 'daily',    label: 'Daily Summary', desc: 'Per-day revenue, VAT and order counts' },
  { key: 'hourly',   label: 'Hourly Sales',  desc: 'Revenue by hour with channel split' },
  { key: 'products', label: 'Item Mix',      desc: 'Product performance — qty, revenue, margin' },
  { key: 'shifts',   label: 'Shifts',        desc: 'Cashier shifts — open/close, float, variance' },
  { key: 'pnl',      label: 'Profit & Loss', desc: 'Revenue vs cost of goods and expenses' },
  { key: 'expenses', label: 'Expenses',      desc: 'Branch expenses by category' },
  { key: 'audit',    label: 'Audit Log',     desc: 'Voids, refunds and sensitive actions' },
];

function ExportsTab({ range, branchId }: TabProps) {
  const { allLabel } = useBranch();   // A582
  const [busyKey, setBusyKey] = useState('');
  const [dlError, setDlError] = useState('');
  const download = async (key: string) => {
    setBusyKey(key); setDlError('');
    const p = new URLSearchParams({ from: range.from, to: range.to, format: 'xlsx' });
    if (branchId) p.set('branch_id', branchId);
    try {
      // A143: authed fetch + blob save. window.open() sent no token → 401.
      await downloadFile(`/api/reports/export/${key}?${p}`, `zaptill-${key}-${range.from}_${range.to}.xlsx`);
    } catch (e: any) {
      setDlError(e?.message ?? 'Download failed');
    } finally {
      setBusyKey('');
    }
  };
  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-500 dark:text-gray-400">
        Download any report as an Excel file for {range.from === range.to ? range.from : `${range.from} — ${range.to}`}
        {branchId ? ' (selected branch)' : ` (${allLabel.toLowerCase()})`}.
      </p>
      {dlError && <p className="text-sm text-red-500">{dlError}</p>}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {EXPORT_FORMATS.map(f => (
          <div key={f.key} className="flex items-center justify-between gap-3 bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 px-4 py-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-gray-900 dark:text-white">{f.label}</p>
              <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{f.desc}</p>
            </div>
            <button
              onClick={() => void download(f.key)}
              disabled={busyKey === f.key}
              className="flex-shrink-0 text-xs px-3 py-1.5 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-200 rounded-lg transition-colors disabled:opacity-50"
            >{busyKey === f.key ? '…' : '↓ Excel'}</button>
          </div>
        ))}
      </div>
    </div>
  );
}

function TaxTab({ range, branchId, currency, meta }: TabProps) {
  const [data, setData]       = useState<TaxReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const moreB = useRowMore();   // A464: By Branch on a phone: Branch, Gross Sales, Net Sales
  const moreC = useRowMore();   // A464: By Category on a phone: Category, Gross Sales, Net Sales

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

  // A467: the tab's sections, from its data (By Branch only when the tab shows it).
  const taxCols = (first: ReportColumn): ReportColumn[] =>
    [first, money('grossSales', 'Gross Sales'), money('vatAmount', 'VAT'), money('ctlAmount', 'CTL'), money('netSales', 'Net Sales')];
  const sheets: ReportSheet[] = data.summary.totalOrders === 0 && data.byCategory.length === 0 ? [] : [
    kpiSheet('Summary', [['Gross Sales', data.summary.grossSales], [`VAT ${data.rates.vatRate}%`, data.summary.vatTotal],
      [`CTL ${data.rates.ctlRate}%`, data.summary.ctlTotal], ['Net Sales', data.summary.netSales]]),
    ...(data.byBranch.length > 1 ? [{ name: 'By Branch', columns: taxCols(col('branchName', 'Branch')), rows: data.byBranch }] : []),
    { name: 'By Category', columns: taxCols(col('category', 'Category')), rows: data.byCategory },
  ];

  return (
    <div className="space-y-5">
      <div className="flex justify-end"><ExcelButton report="Tax Report" range={range} meta={meta} sheets={sheets} /></div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <KpiCard label="Gross Sales"               value={fmt.money(data.summary.grossSales, currency, { blank: '—' })} />
        <KpiCard label={`VAT ${data.rates.vatRate}%`} value={fmt.money(data.summary.vatTotal, currency, { blank: '—' })} />
        <KpiCard label={`CTL ${data.rates.ctlRate}%`} value={fmt.money(data.summary.ctlTotal, currency, { blank: '—' })} />
        <KpiCard label="Net Sales"                 value={fmt.money(data.summary.netSales, currency, { blank: '—' })} accent />
      </div>

      {data.byBranch.length > 1 && (
        <SectionCard title="By Branch">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 dark:border-gray-700">
                <Th>Branch</Th><Th right>Gross Sales</Th><Th right className={DESK}>VAT</Th><Th right className={DESK}>CTL</Th><Th right>Net Sales</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50 dark:divide-gray-700/50">
              {data.byBranch.map(b => (
                <Fragment key={b.branchName}>
                <tr>
                  <td className="py-2 text-gray-800 dark:text-gray-200">{b.branchName}
                    <ViewMore open={moreB.isOpen(String(b.branchName))} onClick={() => moreB.toggle(String(b.branchName))} />
                  </td>
                  <td className="py-2 text-right tabular-nums text-gray-700 dark:text-gray-300">{fmt.money(b.grossSales, currency, { blank: '—' })}</td>
                  <td className={`py-2 text-right tabular-nums text-gray-500 ${DESK}`}>{fmt.money(b.vatAmount, currency, { blank: '—' })}</td>
                  <td className={`py-2 text-right tabular-nums text-gray-500 ${DESK}`}>{fmt.money(b.ctlAmount, currency, { blank: '—' })}</td>
                  <td className="py-2 text-right tabular-nums font-medium text-gray-900 dark:text-white">{fmt.money(b.netSales, currency, { blank: '—' })}</td>
                </tr>
                <MoreRow open={moreB.isOpen(String(b.branchName))} colSpan={3} items={[
                  ['VAT', fmt.money(b.vatAmount, currency, { blank: '—' })],
                  ['CTL', fmt.money(b.ctlAmount, currency, { blank: '—' })],
                ]} />
                </Fragment>
              ))}
            </tbody>
          </table>
        </SectionCard>
      )}

      <SectionCard title="By Category">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 dark:border-gray-700">
              <Th>Category</Th><Th right>Gross Sales</Th><Th right className={DESK}>VAT</Th><Th right className={DESK}>CTL</Th><Th right>Net Sales</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50 dark:divide-gray-700/50">
            {data.byCategory.map(c => (
              <Fragment key={c.category}>
              <tr>
                <td className="py-2 text-gray-800 dark:text-gray-200">{c.category}
                  <ViewMore open={moreC.isOpen(String(c.category))} onClick={() => moreC.toggle(String(c.category))} />
                </td>
                <td className="py-2 text-right tabular-nums text-gray-700 dark:text-gray-300">{fmt.money(c.grossSales, currency, { blank: '—' })}</td>
                <td className={`py-2 text-right tabular-nums text-gray-500 ${DESK}`}>{fmt.money(c.vatAmount, currency, { blank: '—' })}</td>
                <td className={`py-2 text-right tabular-nums text-gray-500 ${DESK}`}>{fmt.money(c.ctlAmount, currency, { blank: '—' })}</td>
                <td className="py-2 text-right tabular-nums font-medium text-gray-900 dark:text-white">{fmt.money(c.netSales, currency, { blank: '—' })}</td>
              </tr>
              <MoreRow open={moreC.isOpen(String(c.category))} colSpan={3} items={[
                ['VAT', fmt.money(c.vatAmount, currency, { blank: '—' })],
                ['CTL', fmt.money(c.ctlAmount, currency, { blank: '—' })],
              ]} />
              </Fragment>
            ))}
          </tbody>
        </table>
      </SectionCard>
    </div>
  );
}

// ── Tab: Staff Performance ─────────────────────────────────────────────────────

function StaffTab({ range, branchId, currency, meta }: TabProps) {
  const [data, setData]       = useState<StaffReport | null>(null);
  const [showAll, setShowAll] = useState(false);            // A439
  const [openRows, setOpenRows] = useState<string[]>([]);   // A439
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const more = useRowMore();   // A464: a phone shows Cashier, Revenue and Payment methods

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
  const hasMethods = data.staff.some((s) => (s.by_method ?? []).length > 0);
  const shown = (id: string) => showAll || openRows.includes(id);
  const toggleRow = (id: string) => setOpenRows((r) => (r.includes(id) ? r.filter((x) => x !== id) : [...r, id]));
  const METHOD_NAMES: Record<string, string> = { cash: 'Cash', mpesa: 'M-Pesa', card: 'Card', glovo: 'Glovo', credit: 'On account', unpaid: 'Not paid' };
  const methodName = (m: string) => METHOD_NAMES[m] ?? m.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

  // A467: the staff table, and each cashier's payment methods (shown per row or for everyone).
  const sheets: ReportSheet[] = data.staff.length === 0 ? [] : [
    { name: 'Staff Performance',
      columns: [num('n', '#', 0), col('staff_name', 'Cashier'), num('orders', 'Orders', 0), money('revenue', 'Revenue'), money('avg_order_value', 'Avg Order'), num('pct', 'Share %', 1)],
      rows: data.staff.map((s, i) => ({ ...s, n: i + 1, pct: share(s.revenue, total) })) },
    ...(hasMethods ? [{ name: 'Payment Methods',
      columns: [col('cashier', 'Cashier'), col('method', 'Method'), money('amount', 'Amount'), num('pct', 'Share %', 1)],
      rows: data.staff.flatMap(s => (s.by_method ?? []).map(m => ({ cashier: s.staff_name, method: methodName(m.method), amount: m.amount, pct: share(m.amount, s.revenue) }))) }] : []),
  ];

  return (
    <div className="space-y-4">
      {/* A439: each cashier's money by payment method — one row at a time, or everyone's. */}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {hasMethods && (
          <button type="button" onClick={() => { setShowAll((v) => !v); setOpenRows([]); }} data-testid="staff-methods-all"
            className="text-xs font-medium px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/40">
            {showAll ? 'Hide payment methods' : 'Show payment methods for everyone'}
          </button>
        )}
        <ExcelButton report="Staff Performance" range={range} meta={meta} sheets={sheets} />
      </div>
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-700/50">
              <tr>
                <th className={`text-left text-xs text-gray-400 px-4 py-2.5 font-medium ${DESK}`}>#</th>
                <th className="text-left text-xs text-gray-400 px-2 py-2.5 font-medium pl-4 sm:pl-2">Cashier</th>
                <th className={`text-right text-xs text-gray-400 px-2 py-2.5 font-medium ${DESK}`}>Orders</th>
                <th className="text-right text-xs text-gray-400 px-2 py-2.5 font-medium pr-4 sm:pr-2">Revenue</th>
                <th className={`text-right text-xs text-gray-400 px-2 py-2.5 font-medium ${DESK}`}>Avg Order</th>
                <th className={`text-right text-xs text-gray-400 px-4 py-2.5 font-medium ${DESK}`}>Share</th>
                {hasMethods && <th className="px-4 py-2.5" />}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50 dark:divide-gray-700/50">
              {data.staff.map((s, i) => (
                <Fragment key={s.staff_id}>
                <tr className="hover:bg-gray-50 dark:hover:bg-gray-700/30">
                  <td className={`px-4 py-2.5 text-gray-300 dark:text-gray-600 text-xs tabular-nums ${DESK}`}>{i + 1}</td>
                  <td className="px-2 py-2.5 text-gray-800 dark:text-gray-200 font-medium pl-4 sm:pl-2">{s.staff_name}
                    <ViewMore open={more.isOpen(String(s.staff_id))} onClick={() => more.toggle(String(s.staff_id))} />
                  </td>
                  <td className={`px-2 py-2.5 text-right tabular-nums text-gray-600 dark:text-gray-400 ${DESK}`}>{s.orders}</td>
                  <td className="px-2 py-2.5 text-right tabular-nums font-medium text-gray-900 dark:text-white pr-4 sm:pr-2">{fmt.money(s.revenue, currency, { blank: '—' })}</td>
                  <td className={`px-2 py-2.5 text-right tabular-nums text-gray-500 ${DESK}`}>{fmt.money(s.avg_order_value, currency, { blank: '—' })}</td>
                  <td className={`px-4 py-2.5 text-right ${DESK}`}>
                    <div className="flex items-center justify-end gap-1.5">
                      <div className="w-14 bg-gray-100 dark:bg-gray-700 rounded-full h-1.5 overflow-hidden">
                        <div className="bg-teal-500 h-full rounded-full" style={{ width: `${total > 0 ? (s.revenue / total) * 100 : 0}%` }} />
                      </div>
                      <span className="text-xs text-gray-400 tabular-nums w-9 text-right">{fmt.pct(total > 0 ? (s.revenue / total) * 100 : 0)}</span>
                    </div>
                  </td>
                  {hasMethods && (
                    <td className="px-4 py-2.5 text-right">
                      {(s.by_method ?? []).length > 0 && (
                        <button type="button" onClick={() => toggleRow(s.staff_id)} disabled={showAll} data-testid="staff-methods-toggle"
                          className="text-xs font-medium text-teal-600 dark:text-teal-400 hover:underline disabled:opacity-40 whitespace-nowrap">
                          {shown(s.staff_id) ? 'Hide methods' : 'Payment methods'}
                        </button>
                      )}
                    </td>
                  )}
                </tr>
                <MoreRow open={more.isOpen(String(s.staff_id))} colSpan={hasMethods ? 3 : 2} items={[
                  ['#', i + 1],
                  ['Orders', s.orders],
                  ['Avg Order', fmt.money(s.avg_order_value, currency, { blank: '—' })],
                  ['Share', fmt.pct(total > 0 ? (s.revenue / total) * 100 : 0)],
                ]} />
                {shown(s.staff_id) && (s.by_method ?? []).length > 0 && (
                  <tr className="bg-gray-50/60 dark:bg-gray-900/30" data-testid="staff-methods-row">
                    <td className={DESK} />
                    <td colSpan={hasMethods ? 6 : 5} className="px-2 pb-3 pt-1">
                      <div className="flex flex-wrap gap-2">
                        {(s.by_method ?? []).map((m) => (
                          <div key={m.method} className="flex items-center gap-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-1.5 text-xs">
                            <span className="inline-block w-2 h-2 rounded-full" style={{ background: methodColour(m.method).dot }} />
                            <span className="text-gray-600 dark:text-gray-300">{methodName(m.method)}</span>
                            <span className="font-semibold tabular-nums text-gray-900 dark:text-white">{fmt.money(m.amount, currency, { blank: '—' })}</span>
                            <span className="text-gray-400 tabular-nums">{fmt.pct(s.revenue > 0 ? (m.amount / s.revenue) * 100 : 0)}</span>
                          </div>
                        ))}
                      </div>
                    </td>
                  </tr>
                )}
                </Fragment>
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

function FoodCostTab({ range, branchId, currency, meta }: TabProps) {
  const [data, setData]         = useState<FoodCostReport | null>(null);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState('');
  const moreI = useRowMore();   // A464: Ingredient variance on a phone: Ingredient, Variance, Actual cost
  const moreP = useRowMore();   // A464: Cost per dish on a phone: Dish, Cost %, Gross margin
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
  // A475: the list in pages (25 / 50 / 100, remembered in this browser); a new search / filter / period → page 1, an edit keeps the page (clamped).
  const [ingredientPage, setIngredientPage] = useState(1);
  const [ingredientPageSize, setIngredientPageSize] = usePageSize('swiftpos.pageSize.reports.foodCost.ingredients');
  useEffect(() => { setIngredientPage(1); }, [range.from, range.to, branchId]);
  const ingredientPaged = paginate(data?.ingredients ?? [], ingredientPage, ingredientPageSize);
  useEffect(() => { if (ingredientPaged.page !== ingredientPage) setIngredientPage(ingredientPaged.page); }, [ingredientPaged.page, ingredientPage]);
  // A475: the list in pages (25 / 50 / 100, remembered in this browser); a new search / filter / period → page 1, an edit keeps the page (clamped).
  const [dishPage, setDishPage] = useState(1);
  const [dishPageSize, setDishPageSize] = usePageSize('swiftpos.pageSize.reports.foodCost.dishes');
  useEffect(() => { setDishPage(1); }, [range.from, range.to, branchId]);
  const dishPaged = paginate(data?.products ?? [], dishPage, dishPageSize);
  useEffect(() => { if (dishPaged.page !== dishPage) setDishPage(dishPaged.page); }, [dishPaged.page, dishPage]);

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

  // A467: both views (ingredient variance and cost per dish) — the tab shows each behind its toggle.
  const sheets: ReportSheet[] = [
    kpiSheet('Summary', [['Revenue', summary.totalRevenue], ['Ideal food cost', summary.totalIdealCost],
      ['Actual food cost', summary.totalActualCost], ['Variance vs ideal', summary.variance], ['Food cost %', summary.foodCostPct]]),
    { name: 'Ingredient variance',
      columns: [col('name', 'Ingredient'), col('unit', 'Unit'), money('unit_cost', 'Unit cost'), num('idealQty', 'Ideal qty', 3), num('actualQty', 'Actual qty', 3),
        num('variance', 'Variance', 3), num('variancePct', 'Variance %', 1), money('idealCost', 'Ideal cost'), money('actualCost', 'Actual cost')],
      // No stock movement yet: the tab shows a dash for actual qty / variance — so does the sheet.
      rows: ingredients.map(i => i.actualCost === null ? { ...i, actualQty: null, variance: null, variancePct: null } : i) },
    { name: 'Cost per dish',
      columns: [col('name', 'Dish'), num('qtySold', 'Qty sold', 3), money('revenue', 'Revenue'), money('idealCost', 'Ideal cost'), num('costPct', 'Cost %', 1), num('grossMargin', 'Gross margin %', 1)],
      rows: products },
  ];

  return (
    <div className="space-y-5">
      <div className="flex justify-end"><ExcelButton report="Food Cost" range={range} meta={meta} sheets={sheets} /></div>
      {/* KPI row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <KpiCard label="Revenue"         value={fmt.money(summary.totalRevenue, currency, { blank: '—' })} />
        <KpiCard label="Ideal food cost" value={fmt.money(summary.totalIdealCost, currency, { blank: '—' })}
          sub={`${fmt.pct(summary.foodCostPct)} of revenue`} />
        {hasActual ? (
          <KpiCard label="Actual food cost" value={fmt.money(summary.totalActualCost!, currency, { blank: '—' })}
            sub={summary.variance! > 0 ? `+${fmt.money(summary.variance!, currency, { blank: '—' })} over ideal` : `${fmt.money(summary.variance!, currency, { blank: '—' })} vs ideal`}
            accent={summary.variance! > 0} />
        ) : (
          <KpiCard label="Actual food cost" value="—"
            sub="No stock movements yet" />
        )}
        <KpiCard label="Food cost %"     value={fmt.pct(summary.foodCostPct)}
          sub={summary.foodCostPct > 35 ? '⚠ Above 35% target' : '✓ Within target'} />
      </div>

      {/* Food cost % visual gauge */}
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500">Food cost % gauge</h3>
          <span className={`text-sm font-bold ${summary.foodCostPct > 35 ? 'text-red-500' : summary.foodCostPct > 28 ? 'text-amber-500' : 'text-green-600'}`}>
            {fmt.pct(summary.foodCostPct)}
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
                  <th className={`text-right text-xs text-gray-400 px-2 py-2.5 font-medium ${DESK}`}>Ideal qty</th>
                  <th className={`text-right text-xs text-gray-400 px-2 py-2.5 font-medium ${DESK}`}>Actual qty</th>
                  <th className="text-right text-xs text-gray-400 px-2 py-2.5 font-medium">Variance</th>
                  <th className={`text-right text-xs text-gray-400 px-2 py-2.5 font-medium ${DESK}`}>Ideal cost</th>
                  <th className="text-right text-xs text-gray-400 px-4 py-2.5 font-medium">Actual cost</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50 dark:divide-gray-700/50">
                {ingredientPaged.items.map(ing => {
                  const over    = ing.variance > 0;
                  const noData  = ing.actualCost === null;
                  return (
                    <Fragment key={ing.ingredient_id}>
                    <tr className={over && !noData ? 'bg-red-50/40 dark:bg-red-900/10' : ''}>
                      <td className="px-4 py-2.5">
                        <p className="text-gray-800 dark:text-gray-200 font-medium">{ing.name}</p>
                        <p className="text-gray-400 text-xs">{ing.unit}{ing.unit_cost ? ` · ${fmt.money(ing.unit_cost, currency, { blank: '—' })}/${ing.unit}` : ''}</p>
                        <ViewMore open={moreI.isOpen(String(ing.ingredient_id))} onClick={() => moreI.toggle(String(ing.ingredient_id))} />
                      </td>
                      <td className={`px-2 py-2.5 text-right tabular-nums text-gray-600 dark:text-gray-400 ${DESK}`}>
                        {fmt.qty(ing.idealQty)} {ing.unit}
                      </td>
                      <td className={`px-2 py-2.5 text-right tabular-nums text-gray-600 dark:text-gray-400 ${DESK}`}>
                        {noData ? <span className="text-gray-300 dark:text-gray-600">—</span> : `${fmt.qty(ing.actualQty)} ${ing.unit}`}
                      </td>
                      <td className="px-2 py-2.5 text-right tabular-nums font-medium">
                        {noData ? <span className="text-gray-300 dark:text-gray-600">—</span> : (
                          <span className={over ? 'text-red-500' : ing.variance < 0 ? 'text-green-600' : 'text-gray-500'}>
                            {over ? '+' : ''}{fmt.qty(ing.variance)} {ing.unit}
                            <span className="text-xs font-normal ml-1">({over ? '+' : ''}{ing.variancePct}%)</span>
                          </span>
                        )}
                      </td>
                      <td className={`px-2 py-2.5 text-right tabular-nums text-gray-600 dark:text-gray-400 ${DESK}`}>
                        {fmt.money(ing.idealCost, currency, { blank: '—' })}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums font-medium">
                        {noData ? <span className="text-gray-300 dark:text-gray-600">—</span> : (
                          <span className={over ? 'text-red-500' : 'text-gray-700 dark:text-gray-300'}>
                            {fmt.money(ing.actualCost!, currency, { blank: '—' })}
                          </span>
                        )}
                      </td>
                    </tr>
                    <MoreRow open={moreI.isOpen(String(ing.ingredient_id))} colSpan={3} items={[
                      ['Ideal qty', `${fmt.qty(ing.idealQty)} ${ing.unit}`],
                      ['Actual qty', noData ? '—' : `${fmt.qty(ing.actualQty)} ${ing.unit}`],
                      ['Ideal cost', fmt.money(ing.idealCost, currency, { blank: '—' })],
                    ]} />
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          <Pager paged={ingredientPaged} noun="ingredients" onPage={setIngredientPage} onSize={n => { setIngredientPageSize(n); setIngredientPage(1); }} />
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
                  <th className={`text-right text-xs text-gray-400 px-2 py-2.5 font-medium ${DESK}`}>Qty sold</th>
                  <th className={`text-right text-xs text-gray-400 px-2 py-2.5 font-medium ${DESK}`}>Revenue</th>
                  <th className={`text-right text-xs text-gray-400 px-2 py-2.5 font-medium ${DESK}`}>Ideal cost</th>
                  <th className="text-right text-xs text-gray-400 px-2 py-2.5 font-medium">Cost %</th>
                  <th className="text-right text-xs text-gray-400 px-4 py-2.5 font-medium">Gross margin</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50 dark:divide-gray-700/50">
                {dishPaged.items.map(p => (
                  <Fragment key={p.product_id}>
                  <tr>
                    <td className="px-4 py-2.5 font-medium text-gray-800 dark:text-gray-200">{p.name}
                      <ViewMore open={moreP.isOpen(String(p.product_id))} onClick={() => moreP.toggle(String(p.product_id))} />
                    </td>
                    <td className={`px-2 py-2.5 text-right tabular-nums text-gray-600 dark:text-gray-400 ${DESK}`}>{fmt.qty(p.qtySold)}</td>
                    <td className={`px-2 py-2.5 text-right tabular-nums text-gray-700 dark:text-gray-300 ${DESK}`}>{fmt.money(p.revenue, currency, { blank: '—' })}</td>
                    <td className={`px-2 py-2.5 text-right tabular-nums text-gray-600 dark:text-gray-400 ${DESK}`}>{fmt.money(p.idealCost, currency, { blank: '—' })}</td>
                    <td className="px-2 py-2.5 text-right tabular-nums">
                      <span className={`font-medium ${p.costPct > 35 ? 'text-red-500' : p.costPct > 28 ? 'text-amber-500' : 'text-green-600'}`}>
                        {fmt.pct(p.costPct)}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums font-medium">
                      <span className={p.grossMargin >= 60 ? 'text-green-600' : p.grossMargin >= 40 ? 'text-amber-500' : 'text-red-500'}>
                        {fmt.pct(p.grossMargin)}
                      </span>
                    </td>
                  </tr>
                  <MoreRow open={moreP.isOpen(String(p.product_id))} colSpan={3} items={[
                    ['Qty sold', fmt.qty(p.qtySold)],
                    ['Revenue', fmt.money(p.revenue, currency, { blank: '—' })],
                    ['Ideal cost', fmt.money(p.idealCost, currency, { blank: '—' })],
                  ]} />
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
          <Pager paged={dishPaged} noun="dishes" onPage={setDishPage} onSize={n => { setDishPageSize(n); setDishPage(1); }} />
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

function SplhTab({ range, branchId, currency, meta }: TabProps) {
  const [data, setData]       = useState<SplhReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const moreS = useRowMore();   // A464: By staff member on a phone: Staff, SPLH, Labour %
  const moreL = useRowMore();   // A464: Shift log on a phone: Cashier, SPLH, Labour %
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
  // A475: the list in pages (25 / 50 / 100, remembered in this browser); a new search / filter / period → page 1, an edit keeps the page (clamped).
  const [shiftPage, setShiftPage] = useState(1);
  const [shiftPageSize, setShiftPageSize] = usePageSize('swiftpos.pageSize.reports.splh.shifts');
  useEffect(() => { setShiftPage(1); }, [range.from, range.to, branchId]);
  const shiftPaged = paginate(data?.shifts ?? [], shiftPage, shiftPageSize);
  useEffect(() => { if (shiftPaged.page !== shiftPage) setShiftPage(shiftPaged.page); }, [shiftPaged.page, shiftPage]);

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

  // A467: both views (by staff member and the shift log); hours as a number of hours, not "3h 20m".
  const sheets: ReportSheet[] = [
    kpiSheet('Summary', [['Revenue', summary.totalRevenue], ['Hours worked', summary.totalHours], ['SPLH', summary.splh],
      ['Labour cost', summary.totalLabour], ['Labour cost %', summary.labourCostPct]]),
    { name: 'By staff member',
      columns: [col('name', 'Staff'), num('shifts', 'Shifts', 0), num('totalHours', 'Hours'), money('totalRevenue', 'Revenue'), money('splh', 'SPLH'),
        money('totalLabour', 'Labour cost'), num('labour_pct', 'Labour %', 1)],
      rows: staff },
    { name: 'Shift log',
      columns: [col('cashier_name', 'Cashier'), col('branch_name', 'Branch'), col('opened', 'Opened'), num('hours', 'Hours'), money('revenue', 'Revenue'),
        money('splh', 'SPLH'), num('labour_pct', 'Labour %', 1)],
      rows: shifts.map(s => ({ ...s, opened: localStamp(s.opened_at) })) },
  ];

  return (
    <div className="space-y-5">
      <div className="flex justify-end"><ExcelButton report="SPLH & Labour" range={range} meta={meta} sheets={sheets} /></div>
      {/* KPI row */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        <KpiCard label="Revenue"       value={fmt.money(summary.totalRevenue, currency, { blank: '—' })} />
        <KpiCard label="Hours worked"  value={fmtHours(summary.totalHours)} />
        <KpiCard label="SPLH"          value={fmt.money(summary.splh, currency, { blank: '—' })}
          sub="Sales per labour hour" accent />
        <KpiCard label="Labour cost"
          value={summary.totalLabour !== null ? fmt.money(summary.totalLabour, currency, { blank: '—' }) : '—'}
          sub={summary.labourCostPct !== null ? `${fmt.pct(summary.labourCostPct)} of revenue` : 'Set hourly rates in Staff'} />
        <KpiCard label="Labour cost %"
          value={summary.labourCostPct !== null ? fmt.pct(summary.labourCostPct) : '—'}
          sub={summary.labourCostPct !== null
            ? (summary.labourCostPct <= 25 ? '✓ Within target' : '⚠ Above 25% target')
            : 'Requires hourly rates'} />
      </div>

      {/* SPLH gauge */}
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500">SPLH gauge</h3>
          <span className={`text-sm font-bold tabular-nums ${splhColor(summary.splh)}`}>
            {fmt.money(summary.splh, currency, { blank: '—' })}/hr
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
        <div className="flex flex-wrap text-[10px] text-gray-400 mt-1 gap-4">
          <span className="text-red-500">Low</span>
          <span className="text-amber-500 ml-auto">{fmt.money(1000, currency)}/hr avg</span>
          <span className="text-green-600">{fmt.money(2000, currency)}/hr+ good</span>
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
                  <th className={`text-right  text-xs text-gray-400 px-2 py-2.5 font-medium ${DESK}`}>Shifts</th>
                  <th className={`text-right  text-xs text-gray-400 px-2 py-2.5 font-medium ${DESK}`}>Hours</th>
                  <th className={`text-right  text-xs text-gray-400 px-2 py-2.5 font-medium ${DESK}`}>Revenue</th>
                  <th className="text-right  text-xs text-gray-400 px-2 py-2.5 font-medium">SPLH</th>
                  <th className={`text-right  text-xs text-gray-400 px-2 py-2.5 font-medium ${DESK}`}>Labour cost</th>
                  <th className="text-right  text-xs text-gray-400 px-4 py-2.5 font-medium">Labour %</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50 dark:divide-gray-700/50">
                {staff.map(s => (
                  <Fragment key={s.cashier_id}>
                  <tr>
                    <td className="px-4 py-2.5 font-medium text-gray-800 dark:text-gray-200">{s.name}
                      <ViewMore open={moreS.isOpen(String(s.cashier_id))} onClick={() => moreS.toggle(String(s.cashier_id))} />
                    </td>
                    <td className={`px-2 py-2.5 text-right tabular-nums text-gray-500 ${DESK}`}>{s.shifts}</td>
                    <td className={`px-2 py-2.5 text-right tabular-nums text-gray-600 dark:text-gray-400 ${DESK}`}>{fmtHours(s.totalHours)}</td>
                    <td className={`px-2 py-2.5 text-right tabular-nums text-gray-700 dark:text-gray-300 ${DESK}`}>{fmt.money(s.totalRevenue, currency, { blank: '—' })}</td>
                    <td className="px-2 py-2.5 text-right tabular-nums font-bold">
                      <span className={splhColor(s.splh)}>{fmt.money(s.splh, currency, { blank: '—' })}</span>
                    </td>
                    <td className={`px-2 py-2.5 text-right tabular-nums text-gray-600 dark:text-gray-400 ${DESK}`}>
                      {s.totalLabour !== null ? fmt.money(s.totalLabour, currency, { blank: '—' }) : <span className="text-gray-300 dark:text-gray-600">—</span>}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums font-semibold">
                      {s.labour_pct !== null
                        ? <span className={labourColor(s.labour_pct)}>{fmt.pct(s.labour_pct)}</span>
                        : <span className="text-gray-300 dark:text-gray-600 text-xs font-normal">No rate set</span>}
                    </td>
                  </tr>
                  <MoreRow open={moreS.isOpen(String(s.cashier_id))} colSpan={3} items={[
                    ['Shifts', s.shifts],
                    ['Hours', fmtHours(s.totalHours)],
                    ['Revenue', fmt.money(s.totalRevenue, currency, { blank: '—' })],
                    ['Labour cost', s.totalLabour !== null ? fmt.money(s.totalLabour, currency, { blank: '—' }) : '—'],
                  ]} />
                  </Fragment>
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
                  <th className={`text-left  text-xs text-gray-400 px-2 py-2.5 font-medium ${DESK}`}>Branch</th>
                  <th className={`text-left  text-xs text-gray-400 px-2 py-2.5 font-medium ${DESK}`}>Opened</th>
                  <th className={`text-right text-xs text-gray-400 px-2 py-2.5 font-medium ${DESK}`}>Hours</th>
                  <th className={`text-right text-xs text-gray-400 px-2 py-2.5 font-medium ${DESK}`}>Revenue</th>
                  <th className="text-right text-xs text-gray-400 px-2 py-2.5 font-medium">SPLH</th>
                  <th className="text-right text-xs text-gray-400 px-4 py-2.5 font-medium">Labour %</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50 dark:divide-gray-700/50">
                {shiftPaged.items.map(s => (
                  <Fragment key={s.shift_id}>
                  <tr>
                    <td className="px-4 py-2.5 font-medium text-gray-800 dark:text-gray-200">{s.cashier_name}
                      <ViewMore open={moreL.isOpen(String(s.shift_id))} onClick={() => moreL.toggle(String(s.shift_id))} />
                    </td>
                    <td className={`px-2 py-2.5 text-gray-500 dark:text-gray-400 text-xs ${DESK}`}>{s.branch_name}</td>
                    <td className={`px-2 py-2.5 text-gray-500 dark:text-gray-400 text-xs ${DESK}`}>{fmtShiftTime(s.opened_at)}</td>
                    <td className={`px-2 py-2.5 text-right tabular-nums text-gray-600 dark:text-gray-400 ${DESK}`}>{fmtHours(s.hours)}</td>
                    <td className={`px-2 py-2.5 text-right tabular-nums text-gray-700 dark:text-gray-300 ${DESK}`}>{fmt.money(s.revenue, currency, { blank: '—' })}</td>
                    <td className="px-2 py-2.5 text-right tabular-nums font-bold">
                      <span className={splhColor(s.splh)}>{fmt.money(s.splh, currency, { blank: '—' })}</span>
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">
                      {s.labour_pct !== null
                        ? <span className={`font-semibold ${labourColor(s.labour_pct)}`}>{fmt.pct(s.labour_pct)}</span>
                        : <span className="text-gray-300 dark:text-gray-600 text-xs">—</span>}
                    </td>
                  </tr>
                  <MoreRow open={moreL.isOpen(String(s.shift_id))} colSpan={3} items={[
                    ['Branch', s.branch_name],
                    ['Opened', fmtShiftTime(s.opened_at)],
                    ['Hours', fmtHours(s.hours)],
                    ['Revenue', fmt.money(s.revenue, currency, { blank: '—' })],
                  ]} />
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
          <Pager paged={shiftPaged} noun="shifts" onPage={setShiftPage} onSize={n => { setShiftPageSize(n); setShiftPage(1); }} />
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
// ── Tab: Menu Matrix (menu engineering) ───────────────────────────────────────
// Kasavana-Smith classification. Two axes:
//   Popularity   = units sold. "High" when an item's share of units ≥ 70% of an
//                  even split (the standard 70% rule): qty ≥ 0.70 × totalQty / N.
//   Profitability = unit contribution margin in money = (revenue − cost) / qty.
//                  "High" when ≥ the average unit CM across classifiable items.
// Items with no cost price can't have a margin, so they're set aside (not fed
// into the average, which they'd distort) with a prompt to set cost. (A78.)
type MatrixItem = ProductV2Report['products'][number] & { unitCM: number };

function MatrixQuad({ title, tag, items, tone, action, currency, resetKey }: {
  title: string; tag: string; items: MatrixItem[]; action: string;
  tone: 'green' | 'amber' | 'blue' | 'red';
  currency: string;
  /** The period and branch: a new one → page 1. */
  resetKey: string;
}) {
  // A475: a big menu puts hundreds of items in one quadrant — each quadrant in pages (25 / 50 / 100, remembered in this
  // browser). The count beside the title and the Excel sheet are every item.
  const [quadPage, setQuadPage] = useState(1);
  const [quadPageSize, setQuadPageSize] = usePageSize('swiftpos.pageSize.reports.matrix');
  useEffect(() => { setQuadPage(1); }, [resetKey]);
  const quadPaged = paginate(items, quadPage, quadPageSize);
  useEffect(() => { if (quadPaged.page !== quadPage) setQuadPage(quadPaged.page); }, [quadPaged.page, quadPage]);
  const ring = {
    green: 'border-green-500/40 bg-green-500/5',
    amber: 'border-amber-500/40 bg-amber-500/5',
    blue:  'border-blue-500/40 bg-blue-500/5',
    red:   'border-red-500/40 bg-red-500/5',
  }[tone];
  const dot = { green: 'bg-green-500', amber: 'bg-amber-500', blue: 'bg-blue-500', red: 'bg-red-500' }[tone];
  return (
    <div className={`rounded-xl border p-4 ${ring}`}>
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2">
          <span className={`w-2.5 h-2.5 rounded-full ${dot}`} />
          <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-100">{title}</h3>
        </div>
        <span className="text-xs text-gray-400 tabular-nums">{items.length}</span>
      </div>
      <p className="text-[11px] text-gray-500 dark:text-gray-400 mb-3">{tag} · {action}</p>
      {items.length === 0
        ? <p className="text-xs text-gray-400 dark:text-gray-600">No items.</p>
        : (
          <ul className="space-y-1.5">
            {quadPaged.items.map(p => (
              <li key={p.product_id} className="flex items-center justify-between text-sm">
                <span className="text-gray-700 dark:text-gray-200 truncate pr-2">{p.name}</span>
                <span className="text-xs text-gray-400 tabular-nums whitespace-nowrap">
                  {fmt.qty(p.qty)} sold · {fmt.money(p.unitCM, currency, { blank: '—' })}/ea
                </span>
              </li>
            ))}
          </ul>
        )}
      {items.length > 0 && (
        <Pager paged={quadPaged} noun="items" onPage={setQuadPage} onSize={n => { setQuadPageSize(n); setQuadPage(1); }} />
      )}
    </div>
  );
}

function MatrixTab({ range, branchId, currency, meta }: TabProps) {
  const [data, setData]       = useState<ProductV2Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const p = new URLSearchParams({ from: range.from, to: range.to });
      if (branchId) p.set('branch_id', branchId);
      setData(await api.get<ProductV2Report>(`/api/reports/products-v2?${p}`));
    } catch (e: any) { setError(e.message ?? 'Failed to load'); }
    finally { setLoading(false); }
  }, [range.from, range.to, branchId]);
  useEffect(() => { load(); }, [load]);

  if (loading) return <Spinner />;
  if (error)   return <ErrMsg msg={error} />;
  if (!data)   return null;

  type Item = MatrixItem;
  const needsCost = data.products.filter(p => p.total_cost == null || p.cost_price == null);
  const classifiable: Item[] = data.products
    .filter(p => p.total_cost != null && p.qty > 0 && p.revenue > 0)
    .map(p => ({ ...p, unitCM: (p.revenue - (p.total_cost as number)) / p.qty }));

  const N = classifiable.length;
  const totalQty = classifiable.reduce((s, p) => s + p.qty, 0);
  const popThreshold = N > 0 ? 0.70 * (totalQty / N) : 0;
  const avgUnitCM = N > 0 ? classifiable.reduce((s, p) => s + p.unitCM, 0) / N : 0;

  const stars:      Item[] = [];
  const plowhorses: Item[] = [];
  const puzzles:    Item[] = [];
  const dogs:       Item[] = [];
  for (const p of classifiable) {
    const highPop    = p.qty >= popThreshold;
    const highProfit = p.unitCM >= avgUnitCM;
    (highPop ? (highProfit ? stars : plowhorses) : (highProfit ? puzzles : dogs)).push(p);
  }
  const byQty = (a: Item, b: Item) => b.qty - a.qty;
  [stars, plowhorses, puzzles, dogs].forEach(g => g.sort(byQty));

  // A467: the four quadrants as one table (Class column), the thresholds, and the items with no cost price.
  const quadRows = ([['Star', stars], ['Puzzle', puzzles], ['Plowhorse', plowhorses], ['Dog', dogs]] as [string, Item[]][])
    .flatMap(([cls, items]) => items.map(p => ({ cls, name: p.name, qty: p.qty, unitCM: p.unitCM })));
  const sheets: ReportSheet[] = data.products.length === 0 ? [] : [
    kpiSheet('Thresholds', [['Popular at or above (units)', popThreshold], ['Profitable at or above (margin per unit)', avgUnitCM], ['Items classified', N], ['Not classified (no cost price)', needsCost.length]]),
    { name: 'Menu Matrix', columns: [col('cls', 'Class'), col('name', 'Item'), num('qty', 'Units sold', 3), money('unitCM', 'Margin per unit')], rows: quadRows },
    { name: 'Not classified', columns: [col('name', 'Item')], rows: needsCost.map(p => ({ name: p.name })) },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold text-gray-800 dark:text-gray-100">Menu Matrix</h2>
          <p className="text-xs text-gray-400 mt-0.5">{range.from} — {range.to}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-[11px] text-gray-400">
            Popular ≥ {popThreshold.toFixed(1)} units · Profitable ≥ {fmt.money(avgUnitCM, currency, { blank: '—' })}/unit margin
          </p>
          <ExcelButton report="Menu Matrix" range={range} meta={meta} sheets={sheets} />
        </div>
      </div>

      {N === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-300 dark:border-gray-700 p-8 text-center">
          <p className="text-sm text-gray-600 dark:text-gray-300">No items can be classified yet.</p>
          <p className="text-xs text-gray-400 mt-1">Set cost prices on your products (Inventory) so margins can be computed.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <MatrixQuad currency={currency} resetKey={`${range.from}|${range.to}|${branchId ?? ''}`} title="Stars"      tag="Popular · High margin" tone="green" action="protect & feature" items={stars} />
          <MatrixQuad currency={currency} resetKey={`${range.from}|${range.to}|${branchId ?? ''}`} title="Puzzles"    tag="Unpopular · High margin" tone="blue" action="reposition / promote" items={puzzles} />
          <MatrixQuad currency={currency} resetKey={`${range.from}|${range.to}|${branchId ?? ''}`} title="Plowhorses" tag="Popular · Low margin" tone="amber" action="raise price / cut cost" items={plowhorses} />
          <MatrixQuad currency={currency} resetKey={`${range.from}|${range.to}|${branchId ?? ''}`} title="Dogs"       tag="Unpopular · Low margin" tone="red" action="rework or remove" items={dogs} />
        </div>
      )}

      {needsCost.length > 0 && (
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 p-4">
          <p className="text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">
            Not classified — no cost price set ({needsCost.length})
          </p>
          <p className="text-[11px] text-gray-400 mb-3">Add a cost price in Inventory to place these on the matrix.</p>
          <div className="flex flex-wrap gap-1.5">
            {needsCost.slice(0, 40).map(p => (
              <span key={p.product_id} className="text-xs px-2 py-0.5 rounded-md bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300">
                {p.name}
              </span>
            ))}
            {needsCost.length > 40 && <span className="text-xs text-gray-400 self-center">+{needsCost.length - 40} more</span>}
          </div>
        </div>
      )}
    </div>
  );
}
function FuelSalesTab({ range, branchId, currency, meta }: TabProps) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const moreP = useRowMore();   // A464: Pump Monitor on a phone: Pump, Sold (L), Revenue
  const moreG = useRowMore();   // A464: By Fuel Grade on a phone: Grade, Litres Sold, Revenue
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
  const peakHour = (hourlySeries as any[]).reduce((best: any, h: any) => (!best || h.litres > best.litres) ? h : best, null);

  // A467: the tab's sections, from its data — litres to 2 dp, the pump table's Total row included.
  const pumpRows = (pumps as any[]).map((p: any) => ({
    pump: p.pump_name, grade: p.product_name ?? '', price: p.price_per_litre || null, capacity: p.capacity_litres,
    opening: p.current_level != null ? Number(p.current_level) + Number(p.litres) : null, litres: p.litres, remaining: p.current_level,
    level: p.capacity_litres && p.current_level != null ? Math.min(100, Math.round((p.current_level / p.capacity_litres) * 100)) : null,
    revenue: p.revenue, transactions: p.transactions, avg: p.transactions > 0 ? p.litres / p.transactions : null,
  }));
  const sheets: ReportSheet[] = (pumps as any[]).length === 0 && (grades as any[]).length === 0 ? [] : [
    kpiSheet('Summary', [['Revenue', summary.totalRevenue], ['Total Litres Sold', summary.totalLitres], ['Transactions', summary.totalTransactions]]),
    { name: 'Pump Monitor',
      columns: [col('pump', 'Pump'), col('grade', 'Grade'), money('price', 'Price/L'), num('capacity', 'Capacity (L)', 0), num('opening', 'Opening Stock (L)'),
        num('litres', 'Sold (L)'), num('remaining', 'Remaining (L)'), num('level', 'Level %', 0), money('revenue', 'Revenue'), num('transactions', 'Transactions', 0), num('avg', 'Avg L/Tx')],
      rows: pumpRows.length ? [...pumpRows, { pump: 'Total', litres: summary.totalLitres, revenue: summary.totalRevenue, transactions: summary.totalTransactions }] : [] },
    { name: 'By Fuel Grade',
      columns: [col('name', 'Grade'), num('litres', 'Litres Sold'), money('revenue', 'Revenue'), num('transactions', 'Transactions', 0), money('perLitre', 'Revenue/L')],
      rows: (grades as any[]).map((g: any) => ({ ...g, perLitre: g.litres > 0 ? g.revenue / g.litres : null })) },
    { name: 'Hourly Sales Pattern', columns: [num('hour', 'Hour', 0), num('litres', 'Litres'), money('revenue', 'Revenue')], rows: hourlySeries as any[] },
  ];

  return (
    <div className="space-y-5">
      <div className="flex justify-end"><ExcelButton report="Fuel Sales" range={range} meta={meta} sheets={sheets} /></div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <KpiCard label="Revenue" value={fmt.money(summary.totalRevenue, currency)} accent />
        <KpiCard label="Total Litres Sold" value={fmt.litres(summary.totalLitres, 2, '—')} />
        <KpiCard label="Transactions" value={String(summary.totalTransactions)}
          sub={summary.totalTransactions > 0 ? `avg ${fmt.litres(summary.totalLitres / summary.totalTransactions, 2, '—')} / tx` : undefined} />
      </div>

      <SectionCard title="Pump Monitor — Opening · Sold · Remaining">
        {pumps.length === 0
          ? <p className="text-sm text-gray-500">No pumps configured or no data for this period.</p>
          : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-200 dark:border-gray-700">
                    <Th>Pump</Th><Th className={DESK}>Grade</Th><Th right className={DESK}>Price/L</Th><Th right className={DESK}>Capacity</Th>
                    <Th right className={DESK}>Opening Stock</Th><Th right>Sold (L)</Th><Th right className={DESK}>Remaining</Th>
                    <Th right>Revenue</Th><Th right className={DESK}>Transactions</Th><Th right className={DESK}>Avg L/Tx</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                  {(pumps as any[]).map((p: any) => {
                    const opening = p.current_level != null ? p.current_level + p.litres : null;
                    const pct = p.capacity_litres && p.current_level != null
                      ? Math.min(100, Math.round((p.current_level / p.capacity_litres) * 100)) : null;
                    return (
                      <Fragment key={p.pump_id}>
                      <tr>
                        <td className="py-2.5 font-semibold text-gray-900 dark:text-white whitespace-nowrap">{p.pump_name}
                          <ViewMore open={moreP.isOpen(String(p.pump_id))} onClick={() => moreP.toggle(String(p.pump_id))} />
                        </td>
                        <td className={`py-2.5 text-gray-500 ${DESK}`}>{p.product_name ?? '—'}</td>
                        <td className={`py-2.5 text-right tabular-nums text-gray-500 ${DESK}`}>
                          {p.price_per_litre ? fmt.money(p.price_per_litre, currency) : '—'}
                        </td>
                        <td className={`py-2.5 text-right tabular-nums text-gray-500 ${DESK}`}>{fmt.litres(p.capacity_litres, 0, '—')}</td>
                        <td className={`py-2.5 text-right tabular-nums text-gray-600 dark:text-gray-300 ${DESK}`}>{fmt.litres(opening, 2, '—')}</td>
                        <td className="py-2.5 text-right tabular-nums font-semibold text-amber-600 dark:text-amber-400">{fmt.litres(p.litres, 2, '—')}</td>
                        <td className={`py-2.5 text-right tabular-nums ${DESK}`}>
                          <span className={`font-semibold ${p.current_level != null && p.current_level < 1000 ? 'text-red-500' : 'text-green-600 dark:text-green-400'}`}>
                            {fmt.litres(p.current_level, 2, '—')}{pct != null ? ` (${pct}%)` : ''}
                          </span>
                        </td>
                        <td className="py-2.5 text-right tabular-nums font-medium text-gray-900 dark:text-white">{fmt.money(p.revenue, currency)}</td>
                        <td className={`py-2.5 text-right tabular-nums text-gray-500 ${DESK}`}>{p.transactions}</td>
                        <td className={`py-2.5 text-right tabular-nums text-gray-500 ${DESK}`}>
                          {p.transactions > 0 ? fmt.litres(p.litres / p.transactions, 2, '—') : '—'}
                        </td>
                      </tr>
                      <MoreRow open={moreP.isOpen(String(p.pump_id))} colSpan={3} items={[
                        ['Grade', p.product_name ?? '—'],
                        ['Price/L', p.price_per_litre ? fmt.money(p.price_per_litre, currency) : '—'],
                        ['Capacity', fmt.litres(p.capacity_litres, 0, '—')],
                        ['Opening Stock', fmt.litres(opening, 2, '—')],
                        ['Remaining', <span className={`font-semibold ${p.current_level != null && p.current_level < 1000 ? 'text-red-500' : 'text-green-600 dark:text-green-400'}`}>
                            {fmt.litres(p.current_level, 2, '—')}{pct != null ? ` (${pct}%)` : ''}
                          </span>],
                        ['Transactions', p.transactions],
                        ['Avg L/Tx', p.transactions > 0 ? fmt.litres(p.litres / p.transactions, 2, '—') : '—'],
                      ]} />
                      </Fragment>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-gray-200 dark:border-gray-700 font-semibold">
                    <td colSpan={5} className={`py-2 text-xs text-gray-600 dark:text-gray-400 ${DESK}`}>Total</td>
                    <td className="sm:hidden py-2 text-xs text-gray-600 dark:text-gray-400">Total</td>
                    <td className="py-2 text-right tabular-nums text-xs text-amber-600 dark:text-amber-400">{fmt.litres(summary.totalLitres, 2, '—')}</td>
                    <td className={DESK} />
                    <td className="py-2 text-right tabular-nums text-xs">{fmt.money(summary.totalRevenue, currency)}</td>
                    <td className={`py-2 text-right tabular-nums text-xs text-gray-500 ${DESK}`}>{summary.totalTransactions}</td>
                    <td className={DESK} />
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
                <Th right className={DESK}>Transactions</Th><Th right className={DESK}>Revenue/L</Th>
              </tr></thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                {(grades as any[]).map((g: any) => (
                  <Fragment key={g.product_id}>
                  <tr>
                    <td className="py-2 font-medium text-gray-800 dark:text-gray-200">{g.name}
                      <ViewMore open={moreG.isOpen(String(g.product_id))} onClick={() => moreG.toggle(String(g.product_id))} />
                    </td>
                    <td className="py-2 text-right tabular-nums">{fmt.litres(g.litres, 2, '—')}</td>
                    <td className="py-2 text-right tabular-nums">{fmt.money(g.revenue, currency)}</td>
                    <td className={`py-2 text-right tabular-nums text-gray-500 ${DESK}`}>{g.transactions}</td>
                    <td className={`py-2 text-right tabular-nums text-gray-500 ${DESK}`}>
                      {g.litres > 0 ? fmt.money(g.revenue / g.litres, currency) : '—'}
                    </td>
                  </tr>
                  <MoreRow open={moreG.isOpen(String(g.product_id))} colSpan={3} items={[
                    ['Transactions', g.transactions],
                    ['Revenue/L', g.litres > 0 ? fmt.money(g.revenue / g.litres, currency) : '—'],
                  ]} />
                  </Fragment>
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
                      title={`${h.hour}:00  ${fmt.litres(h.litres, 2, '—')}  ${fmt.money(h.revenue, currency)}`}>
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


function WetStockTab({ range, branchId, currency, meta }: TabProps) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const moreT = useRowMore();   // A464: Tank Reconciliation on a phone: Tank, Current, Level %
  const moreD = useRowMore();   // A464: Delivery Log on a phone: Date, Grade, Litres Added
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
  // A475: the list in pages (25 / 50 / 100, remembered in this browser); a new search / filter / period → page 1, an edit keeps the page (clamped).
  const [deliveryPage, setDeliveryPage] = useState(1);
  const [deliveryPageSize, setDeliveryPageSize] = usePageSize('swiftpos.pageSize.reports.wetStock.deliveries');
  useEffect(() => { setDeliveryPage(1); }, [range.from, range.to, branchId]);
  const deliveryPaged = paginate(((data?.deliveryLog ?? []) as any[]), deliveryPage, deliveryPageSize);
  useEffect(() => { if (deliveryPaged.page !== deliveryPage) setDeliveryPage(deliveryPaged.page); }, [deliveryPaged.page, deliveryPage]);

  if (loading) return <Spinner />;
  if (error)   return <ErrMsg msg={error} />;
  if (!data)   return null;

  const { tanks, deliveryLog } = data;

  // A467: the tank reconciliation (with its Totals row) and the delivery log, from the data the tab loaded.
  const tankRows = (tanks as any[]).map((t: any) => ({
    tank: t.name, low: t.is_low ? 'LOW' : '', grade: t.product_name ?? '', price: t.price_per_litre || null, capacity: t.capacity_litres,
    opening: Number(t.current_level ?? 0) + Number(t.consumed_litres ?? 0) - Number(t.delivered_litres ?? 0),
    delivered: Number(t.delivered_litres ?? 0), sold: Number(t.consumed_litres ?? 0), current: t.current_level,
    level: t.capacity_litres > 0 ? Math.min(100, Math.round((t.current_level / t.capacity_litres) * 100)) : 0,
    value: Number(t.current_level ?? 0) * Number(t.price_per_litre ?? 0),
  }));
  const tankTotal = (k: 'opening' | 'delivered' | 'sold' | 'current' | 'value') => tankRows.reduce((s, r) => s + Number(r[k] ?? 0), 0);
  const tankCap = tankRows.reduce((s, r) => s + Number(r.capacity ?? 0), 0);
  const sheets: ReportSheet[] = tankRows.length === 0 && !deliveryLog?.length ? [] : [
    ...(tankRows.length ? [kpiSheet('Summary', [['Current Stock (L)', tankTotal('current')], ['Current Stock % of capacity', tankCap > 0 ? Math.round((tankTotal('current') / tankCap) * 100) : 0],
      ['Sold in period (L)', tankTotal('sold')], ['Delivered in period (L)', tankTotal('delivered')], ['Revenue Value (stock)', tankTotal('value')]])] : []),
    { name: 'Tank Reconciliation',
      columns: [col('tank', 'Tank'), col('low', 'Low'), col('grade', 'Grade'), money('price', 'Price/L'), num('capacity', 'Capacity (L)', 0), num('opening', 'Opening (L)'),
        num('delivered', 'Delivered (L)'), num('sold', 'Sold (L)'), num('current', 'Current (L)'), num('level', 'Level %', 0), money('value', 'Stock Value')],
      rows: tankRows.length ? [...tankRows, { tank: 'Totals', opening: tankTotal('opening'), delivered: tankTotal('delivered'), sold: tankTotal('sold'), current: tankTotal('current'), value: tankTotal('value') }] : [] },
    { name: 'Delivery Log',
      columns: [col('date', 'Date'), col('product_name', 'Grade'), num('litres', 'Litres Added'), num('level_after', 'Level After (L)'), col('notes', 'Notes')],
      rows: ((deliveryLog ?? []) as any[]).map((d: any) => ({ ...d, date: localStamp(d.recorded_at) })) },
  ];

  return (
    <div className="space-y-5">
      <div className="flex justify-end"><ExcelButton report="Wet Stock" range={range} meta={meta} sheets={sheets} /></div>

      {/* KPI cards */}
      {tanks.length > 0 && (() => {
        const totalCap  = tanks.reduce((s: number, t: any) => s + Number(t.capacity_litres ?? 0), 0);
        const totalCurr = tanks.reduce((s: number, t: any) => s + Number(t.current_level ?? 0), 0);
        const totalSold = tanks.reduce((s: number, t: any) => s + Number(t.consumed_litres ?? 0), 0);
        const totalDel  = tanks.reduce((s: number, t: any) => s + Number(t.delivered_litres ?? 0), 0);
        const pctFull   = totalCap > 0 ? Math.round((totalCurr / totalCap) * 100) : 0;
        return (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <KpiCard label="Current Stock"       value={fmt.litres(totalCurr, 0, '—')} sub={`${pctFull}% of capacity`} accent />
            <KpiCard label="Sold (Period)"        value={fmt.litres(totalSold, 2, '—')} />
            <KpiCard label="Delivered (Period)"   value={fmt.litres(totalDel, 0, '—')} />
            <KpiCard label="Revenue Value (stock)" value={fmt.money(tanks.reduce((s: number, t: any) => s + Number(t.current_level ?? 0) * Number(t.price_per_litre ?? 0), 0), currency)} />
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
                    <Th>Tank</Th><Th className={DESK}>Grade</Th><Th right className={DESK}>Price/L</Th><Th right className={DESK}>Capacity</Th>
                    <Th right className={DESK}>Opening*</Th><Th right className={DESK}>Delivered</Th><Th right className={DESK}>Sold</Th>
                    <Th right>Current</Th><Th right>Level %</Th><Th right className={DESK}>Stock Value</Th>
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
                      <Fragment key={t.id}>
                      <tr>
                        <td className="py-2.5 font-semibold text-gray-900 dark:text-white whitespace-nowrap">
                          {t.name}
                          {t.is_low && <span className="ml-1.5 text-[10px] bg-red-100 dark:bg-red-500/20 text-red-600 dark:text-red-400 px-1.5 py-0.5 rounded-full font-semibold">LOW</span>}
                          <ViewMore open={moreT.isOpen(String(t.id))} onClick={() => moreT.toggle(String(t.id))} />
                        </td>
                        <td className={`py-2.5 text-gray-500 ${DESK}`}>{t.product_name}</td>
                        <td className={`py-2.5 text-right tabular-nums text-gray-500 ${DESK}`}>
                          {t.price_per_litre ? fmt.money(t.price_per_litre, currency) : '—'}
                        </td>
                        <td className={`py-2.5 text-right tabular-nums text-gray-500 ${DESK}`}>{fmt.litres(t.capacity_litres, 0, '—')}</td>
                        <td className={`py-2.5 text-right tabular-nums text-gray-600 dark:text-gray-300 ${DESK}`}>{fmt.litres(opening, 0, '—')}</td>
                        <td className={`py-2.5 text-right tabular-nums text-green-600 dark:text-green-400 font-medium ${DESK}`}>
                          {Number(t.delivered_litres ?? 0) > 0 ? `+${fmt.litres(t.delivered_litres, 0, '—')}` : '—'}
                        </td>
                        <td className={`py-2.5 text-right tabular-nums text-amber-600 dark:text-amber-400 font-medium ${DESK}`}>
                          {Number(t.consumed_litres ?? 0) > 0 ? `-${fmt.litres(t.consumed_litres, 2, '—')}` : '—'}
                        </td>
                        <td className={`py-2.5 text-right tabular-nums font-semibold ${textColour}`}>{fmt.litres(t.current_level, 0, '—')}</td>
                        <td className="py-2.5">
                          <div className="flex items-center gap-2 justify-end">
                            <div className="w-14 h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                              <div className={`h-full ${barColour} rounded-full`} style={{ width: `${pct}%` }} />
                            </div>
                            <span className={`text-xs tabular-nums ${textColour}`}>{pct}%</span>
                          </div>
                        </td>
                        <td className={`py-2.5 text-right tabular-nums text-gray-700 dark:text-gray-300 ${DESK}`}>
                          {stockValue > 0 ? fmt.money(stockValue, currency) : '—'}
                        </td>
                      </tr>
                      <MoreRow open={moreT.isOpen(String(t.id))} colSpan={3} items={[
                        ['Grade', t.product_name],
                        ['Price/L', t.price_per_litre ? fmt.money(t.price_per_litre, currency) : '—'],
                        ['Capacity', fmt.litres(t.capacity_litres, 0, '—')],
                        ['Opening*', fmt.litres(opening, 0, '—')],
                        ['Delivered', <span className="text-green-600 dark:text-green-400 font-medium">{Number(t.delivered_litres ?? 0) > 0 ? `+${fmt.litres(t.delivered_litres, 0, '—')}` : '—'}</span>],
                        ['Sold', <span className="text-amber-600 dark:text-amber-400 font-medium">{Number(t.consumed_litres ?? 0) > 0 ? `-${fmt.litres(t.consumed_litres, 2, '—')}` : '—'}</span>],
                        ['Stock Value', stockValue > 0 ? fmt.money(stockValue, currency) : '—'],
                      ]} />
                      </Fragment>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-gray-200 dark:border-gray-700 text-xs font-semibold">
                    <td colSpan={4} className={`py-2 text-gray-600 dark:text-gray-400 ${DESK}`}>Totals</td>
                    <td className="sm:hidden py-2 text-gray-600 dark:text-gray-400">Totals</td>
                    <td className={`py-2 text-right tabular-nums text-gray-600 dark:text-gray-300 ${DESK}`}>
                      {fmt.litres(tanks.reduce((s: number, t: any) => s + Number(t.current_level ?? 0) + Number(t.consumed_litres ?? 0) - Number(t.delivered_litres ?? 0), 0), 0, '—')}
                    </td>
                    <td className={`py-2 text-right tabular-nums text-green-600 dark:text-green-400 ${DESK}`}>
                      {tanks.some((t: any) => t.delivered_litres > 0) ? fmt.litres(tanks.reduce((s: number, t: any) => s + Number(t.delivered_litres ?? 0), 0), 0, '—') : '—'}
                    </td>
                    <td className={`py-2 text-right tabular-nums text-amber-600 dark:text-amber-400 ${DESK}`}>
                      {fmt.litres(tanks.reduce((s: number, t: any) => s + Number(t.consumed_litres ?? 0), 0), 2, '—')}
                    </td>
                    <td className="py-2 text-right tabular-nums">{fmt.litres(tanks.reduce((s: number, t: any) => s + Number(t.current_level ?? 0), 0), 0, '—')}</td>
                    <td />
                    <td className={`py-2 text-right tabular-nums ${DESK}`}>
                      {fmt.money(tanks.reduce((s: number, t: any) => s + Number(t.current_level ?? 0) * Number(t.price_per_litre ?? 0), 0), currency)}
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
            <>
            <table className="w-full text-sm">
              <thead><tr className="border-b border-gray-200 dark:border-gray-700">
                <Th>Date</Th><Th>Grade</Th><Th right>Litres Added</Th><Th right className={DESK}>Level After</Th><Th className={DESK}>Notes</Th>
              </tr></thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                {deliveryPaged.items.map((d: any, j: number) => { const i = deliveryPaged.from - 1 + j; return (   // A475: keyed over the whole log
                  <Fragment key={i}>
                  <tr>
                    <td className="py-2 text-gray-500 text-xs whitespace-nowrap">
                      {fmt.dayTime(d.recorded_at)}
                      <ViewMore open={moreD.isOpen(String(i))} onClick={() => moreD.toggle(String(i))} />
                    </td>
                    <td className="py-2 text-gray-800 dark:text-gray-200">{d.product_name ?? '—'}</td>
                    <td className="py-2 text-right tabular-nums text-green-600 dark:text-green-400 font-medium">+{fmt.litres(d.litres, 0, '—')}</td>
                    <td className={`py-2 text-right tabular-nums text-gray-500 ${DESK}`}>{fmt.litres(d.level_after, 0, '—')}</td>
                    <td className={`py-2 text-gray-500 text-xs max-w-[200px] truncate ${DESK}`}>{d.notes ?? '—'}</td>
                  </tr>
                  <MoreRow open={moreD.isOpen(String(i))} colSpan={3} items={[
                    ['Level After', fmt.litres(d.level_after, 0, '—')],
                    ['Notes', d.notes ?? '—'],
                  ]} />
                  </Fragment>
                ); })}
              </tbody>
            </table>
            <Pager paged={deliveryPaged} noun="deliveries" onPage={setDeliveryPage} onSize={n => { setDeliveryPageSize(n); setDeliveryPage(1); }} />
            </>
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
  const { branches, activeBranchId, allLabel, allowAll, allMine } = useBranch();   // A582: allLabel, allMine
  // A576: ?tab=&from=&to=&branch=&staff= — a watch-list alert opens the list behind it (that day, branch and person).
  const [params] = useSearchParams();
  const isDay = (d: string | null): d is string => !!d && /^\d{4}-\d{2}-\d{2}$/.test(d);
  const [activeTab, setActiveTab] = useState(() => { const t = params.get('tab'); return t && TAB_LIST.some(x => x.id === t) ? t : 'master'; });
  const [range, setRange]         = useState<DateRange>(() => {
    const f = params.get('from'), t = params.get('to');
    return isDay(f) && isDay(t) ? { from: f, to: t } : { from: today(), to: today() };
  });
  const [branchId, setBranchId]   = useState(params.get('branch') || activeBranchId || '');
  const [staffId, setStaffId]     = useState(params.get('staff') || '');
  const currency = business?.currency ?? 'KES';
  // A467: the About sheet of every tab's Excel — the business, and the branch picked (blank = All branches).
  const meta: ReportMeta = {
    businessName: business?.name ?? '',
    branchName: branchId ? ((branches ?? []).find(b => b.id === branchId)?.name ?? '') : (allMine ? allLabel : ''),   // A582
  };
  const tabProps: TabProps = { range, branchId, currency, meta, staffId };

  return (
    <div className="p-4 sm:p-6 w-full">
      <div className="mb-5">
        <h1 className="text-xl font-semibold text-gray-900 dark:text-white">Reports</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">Sales analysis · Tax · Staff performance · Voids</p>
      </div>

      <DateRangeBar range={range} onChange={setRange} branches={branches ?? []} branchId={branchId} onBranchChange={setBranchId}
        allLabel={allLabel} showAll={allowAll || allMine} />
      {staffId && (
        <div className="mb-3 flex items-center gap-3 text-sm text-gray-600 dark:text-gray-300" data-testid="reports-one-person">
          <span>Showing one staff member's sales (from the Watch list).</span>
          <button type="button" onClick={() => setStaffId('')} className="text-swift-text hover:underline">Show everyone</button>
        </div>
      )}

      {/* Tab bar */}
      <div className="flex gap-0 overflow-x-auto border-b border-gray-200 dark:border-gray-700 mb-5">
        {visibleTabs.map(t => (
          <button key={t.id} onClick={() => setActiveTab(t.id)}
            className={`whitespace-nowrap text-sm px-4 py-2.5 border-b-2 transition-colors flex-shrink-0 ${
              activeTab === t.id
                ? 'border-swift-strong text-swift-text dark:text-swift-text font-medium'
                : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
            }`}>{t.label}
          </button>
        ))}
      </div>

      {activeTab === 'master' && <MasterTab  {...tabProps} />}
      {activeTab === 'monthly' && <MonthlyPackTab branchId={branchId} currency={currency} branches={(branches ?? []) as any} />}
      {activeTab === 'hourly' && <HourlyTab  {...tabProps} />}
      {activeTab === 'items'     && <ItemMixTab   {...tabProps} />}
      {activeTab === 'matrix'    && <MatrixTab    {...tabProps} />}
      {activeTab === 'food_cost'  && <FoodCostTab    {...tabProps} />}
      {activeTab === 'voids'  && <VoidsTab   {...tabProps} />}
      {activeTab === 'refunds'   && <RefundsTab   {...tabProps} />}
      {activeTab === 'inventory' && <InventoryTab {...tabProps} />}
      {activeTab === 'exports'   && <ExportsTab   {...tabProps} />}
      {activeTab === 'tax'    && <TaxTab     {...tabProps} />}
      {activeTab === 'staff'  && <StaffTab   {...tabProps} />}
      {activeTab === 'splh'      && <SplhTab      {...tabProps} />}
      {activeTab === 'fuel_sales' && <FuelSalesTab  {...tabProps} />}
      {activeTab === 'wet_stock'  && <WetStockTab   {...tabProps} />}
    </div>
  );
}
