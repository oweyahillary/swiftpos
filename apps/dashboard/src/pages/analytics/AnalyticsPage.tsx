/**
 * AnalyticsPage.tsx — A549: Analytics v1 (premium); A553: Analytics v2 — the same figures, drawn. A KPI row (sales, orders,
 * average bill, gross margin, money at risk — each against the previous period of the same length, with a sparkline), the
 * daily sales trend against the previous period, the payment mix, insight cards by severity, and four tabs: menu
 * engineering (the tinted quadrant scatter, bubbles sized by revenue, the top 10 by revenue), busy times (the heatmap on a
 * one-hue ramp, sales by hour and by weekday), money leaks (a stacked bar per cashier, the split of leak types) and credit
 * ageing (the buckets green → red, the top debtors). The tables stay below the charts.
 *
 * The cloud works every figure out in SQL and keeps it a few minutes (routes/analytics.ts); this page asks once per tab
 * and period (the overview and the insights once per period) and NEVER polls.
 *
 * Owner (/dashboard/analytics): every branch, or one, from the branch filter (the dashboard's own branch selection).
 * Manager portal (Analytics tab, reports.sales): their own branch — no filter; the cloud holds them to it anyway.
 * Off for the business (the admin portal's 'analytics' switch): the cloud answers ANALYTICS_OFF and the page shows the
 * premium panel instead. Without costs (A490) no margin, class or wastage value is sent, so none is drawn.
 * Colours: the back office's actions stay the SwiftPOS teal (swift-*); every chart colour comes from chartPalette.ts for the
 * dashboard's mode (light / dark), and text stays in the usual gray classes.
 */
import { useState, useEffect, useMemo, useCallback } from 'react';
import { api } from '../../lib/api';
import { useBusiness } from '../../context/BusinessContext';
import { useBranch } from '../../context/BranchContext';
import { useTheme } from '../../context/ThemeContext';
import { localDateStr } from '../../lib/localDate';
import { DESK } from '../../components/RowMore';
import * as fmt from '../../lib/format';
import { chartPalette, CLASS_ORDER, CLASS_SHAPE, type ChartPalette, type PayKey } from './chartPalette';
import {
  ChartCard, Legend, KpiTile, RevenueTrend, Donut, MenuScatter, TopItemsBar, Heatmap, HourColumns, WeekdayBars, LeakStack,
  AgeingBar, TopDebtors, classLegend, leakLegend,
} from './charts';

// ── Types (the cloud's answers) ───────────────────────────────────────────────

type MenuClass = 'star' | 'plowhorse' | 'puzzle' | 'dog' | 'no_cost';
interface MenuItem {
  productId: string | null; name: string; category: string | null; qty: number; revenue: number; avgPrice: number;
  share: number; rank: number; popular: boolean; unitCost: number | null; costSource: string | null;
  unitMargin: number | null; totalMargin: number | null; highMargin: boolean | null; class: MenuClass | null;
}
interface MenuAnswer {
  items: MenuItem[]; popularityThreshold: number; avgUnitMargin: number | null; costsHidden: boolean;
  counts: Record<MenuClass, number>; totals: { items: number; qty: number; revenue: number; margin: number | null };
}
interface Slot { dow: number; day: string; startHour: number; endHour: number; label: string; revenue: number; orders: number }
interface HeatAnswer {
  revenue: number[][]; orders: number[][]; maxRevenue: number; totalRevenue: number; totalOrders: number;
  tradingHours: { from: number; to: number } | null; busiest: Slot | null; quietest: Slot | null;
}
interface LeakFlag { kind: 'void' | 'discount'; rate: number; median: number; multiple: number | null; events: number }
interface LeakFigures {
  orders: number; voids: number; voidValue: number; itemVoids: number; itemVoidValue: number; refunds: number; refundValue: number;
  discounts: number; discountValue: number; wastage: number; wastageValue: number | null;
}
interface CashierLeak extends LeakFigures {
  cashierId: string | null; name: string; voidEvents: number; voidRate: number | null; discountRate: number | null; drawerVariance: number; flags: LeakFlag[];
}
interface DayLeak extends LeakFigures { day: string; dayCloseVariance: number; drawerVariance: number }
interface LeaksAnswer {
  cashiers: CashierLeak[]; days: DayLeak[]; medians: { voidRate: number | null; discountRate: number | null };
  totals: LeakFigures & { dayCloseShort: number; dayCloseOver: number; drawerVariance: number }; wastageHidden: boolean;
}
interface CreditCustomer {
  customerId: string; name: string; phone: string | null; balance: number; owed: number; d0_30: number; d31_60: number;
  d61_90: number; d90_plus: number; unaged: number; oldestAt: string | null; disputedCount: number; disputedAmount: number;
}
interface CreditAnswer {
  asOf: string; customers: CreditCustomer[]; over60: { amount: number; customers: number };
  totals: { customers: number; owed: number; d0_30: number; d31_60: number; d61_90: number; d90_plus: number; disputedCount: number; disputedAmount: number };
}
interface Insight { id: string; type: 'menu' | 'timing' | 'leaks' | 'credit'; severity: 'high' | 'medium' | 'low'; text: string }
interface Kpi { value: number | null; prev: number | null; change: number | null }
interface OverviewAnswer {
  period: { from: string; to: string }; previous: { from: string; to: string };
  days: { day: string; revenue: number; orders: number; avgBill: number | null; atRisk: number; prevDay: string; prevRevenue: number; prevOrders: number }[];
  kpis: { revenue: Kpi; orders: Kpi; avgBill: Kpi; margin: Kpi | null; atRisk: Kpi };
  atRiskParts: { voids: number; refunds: number; discounts: number; wastage: number | null };
  paymentMix: { key: PayKey; label: string; amount: number; share: number }[];
  marginHidden: boolean; wastageHidden: boolean;
}

export interface AnalyticsClient { get: <T>(path: string) => Promise<T> }
type Tab = 'menu' | 'heatmap' | 'leaks' | 'credit';
const TABS: { key: Tab; label: string; path: string }[] = [
  { key: 'menu', label: 'Menu engineering', path: '/api/analytics/menu-engineering' },
  { key: 'heatmap', label: 'Busy times', path: '/api/analytics/heatmap' },
  { key: 'leaks', label: 'Money leaks', path: '/api/analytics/money-leaks' },
  { key: 'credit', label: 'Credit ageing', path: '/api/analytics/credit-ageing' },
];

// ── Period presets ────────────────────────────────────────────────────────────

type PresetKey = '7d' | '30d' | 'month' | 'last_month' | 'custom';
function presetRange(k: Exclude<PresetKey, 'custom'>, now = new Date()): { from: string; to: string } {
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const back = (n: number) => localDateStr(new Date(day.getFullYear(), day.getMonth(), day.getDate() - n));
  if (k === '7d') return { from: back(6), to: localDateStr(day) };
  if (k === '30d') return { from: back(29), to: localDateStr(day) };
  if (k === 'month') return { from: localDateStr(new Date(day.getFullYear(), day.getMonth(), 1)), to: localDateStr(day) };
  return { from: localDateStr(new Date(day.getFullYear(), day.getMonth() - 1, 1)), to: localDateStr(new Date(day.getFullYear(), day.getMonth(), 0)) };
}
const PRESETS: { key: PresetKey; label: string }[] = [
  { key: '7d', label: '7 days' }, { key: '30d', label: '30 days' }, { key: 'month', label: 'This month' },
  { key: 'last_month', label: 'Last month' }, { key: 'custom', label: 'Custom' },
];
const MAX_DAYS = 366;
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000) + 1;

// ── Small pieces ──────────────────────────────────────────────────────────────

const CLASS_META: Record<MenuClass, { label: string; hint: string }> = {
  star:      { label: 'Star',        hint: 'Popular and profitable — keep it prominent.' },
  plowhorse: { label: 'Plowhorse',   hint: 'Popular, low margin — a small price rise or a cheaper recipe.' },
  puzzle:    { label: 'Puzzle',      hint: 'Profitable but slow — feature it, have staff suggest it.' },
  dog:       { label: 'Dog',         hint: 'Slow and low margin — rework it or take it off.' },
  no_cost:   { label: 'No cost set', hint: 'Set a cost price or a recipe to see its margin.' },
};
const pct = (x: number | null | undefined, dp = 1) => (x === null || x === undefined ? '—' : `${(x * 100).toFixed(dp)}%`);

function Card({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-3">
      <p className="text-xs text-gray-500">{label}</p>
      <p className={`font-semibold mt-0.5 ${tone ?? 'text-white'}`}>{value}</p>
      {sub && <p className="text-[11px] text-gray-500 mt-0.5">{sub}</p>}
    </div>
  );
}

/** A small marker of a class's own shape and colour — the scatter's key, so a class never reads by colour alone. */
function ClassMark({ k, p }: { k: MenuClass; p: ChartPalette }) {
  const c = p.classes[k];
  const s = CLASS_SHAPE[k];
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden className="flex-shrink-0">
      {s === 'circle' ? <circle cx="6" cy="6" r="5" fill={c} />
        : s === 'square' ? <rect x="1" y="1" width="10" height="10" rx="2" fill={c} />
        : s === 'diamond' ? <path d="M6 0.5 L11.5 6 L6 11.5 L0.5 6 Z" fill={c} />
        : s === 'triangle' ? <path d="M6 1 L11.5 11 H0.5 Z" fill={c} />
        : <path d="M2 2 L10 10 M10 2 L2 10" stroke={c} strokeWidth="2" />}
    </svg>
  );
}

const INSIGHT_ICON: Record<Insight['type'], string> = {
  leaks: 'M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z',
  credit: 'M3 7h18v12H3zM3 11h18M7 15h3',
  menu: 'm12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9Z',
  timing: 'M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
};
const INSIGHT_TYPE: Record<Insight['type'], string> = { timing: 'Timing', leaks: 'Money leak', credit: 'Credit', menu: 'Menu' };
const SEVERITY_LABEL: Record<Insight['severity'], string> = { high: 'Act now', medium: 'Worth a look', low: 'Good to know' };

/** An insight as a card: a stripe and an icon in its severity's colour, the severity in words (never colour alone). */
function InsightCard({ i, p }: { i: Insight; p: ChartPalette }) {
  const c = p.severity[i.severity];
  return (
    <li className="relative bg-gray-900 border border-gray-800 rounded-xl pl-4 pr-3 py-3 flex gap-3 overflow-hidden" data-severity={i.severity}>
      <span aria-hidden className="absolute left-0 top-0 bottom-0 w-1" style={{ background: c }} />
      <span aria-hidden className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0" style={{ background: `${c}22` }}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d={INSIGHT_ICON[i.type]} /></svg>
      </span>
      <div className="min-w-0">
        <p className="text-[10px] font-bold uppercase tracking-wider text-gray-500">{INSIGHT_TYPE[i.type]} · {SEVERITY_LABEL[i.severity]}</p>
        <p className="text-sm text-gray-200 mt-0.5">{i.text}</p>
      </div>
    </li>
  );
}

/** A549: what a business without Analytics sees — the premium panel, as the Branding page's Themes note. */
export function AnalyticsLocked() {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 max-w-xl" data-testid="analytics-locked">
      <p className="text-xs font-bold uppercase tracking-wider text-swift-text">ZapTill Premium</p>
      <h2 className="text-lg font-bold text-white mt-1">Analytics is part of ZapTill Premium</h2>
      <p className="text-sm text-gray-400 mt-2">
        Sales against the previous period, menu engineering (your Stars, Plowhorses, Puzzles and Dogs), busy times by day and
        hour, money leaks by cashier and day, and credit ageing — drawn as charts, with plain-English suggestions. Contact
        ZapTill to enable it.
      </p>
    </div>
  );
}

// ── The page ──────────────────────────────────────────────────────────────────

/** The owner's route: every branch or one (the dashboard's branch selection), through the dashboard's api client. */
export default function AnalyticsRoute() {
  const currency = useBusiness().business?.currency ?? 'KES';
  return <Analytics client={api} ownerView currency={currency} />;
}

export function Analytics({ client, ownerView, currency, branchName }: { client: AnalyticsClient; ownerView: boolean; currency: string; branchName?: string }) {
  const branchCtx = useBranch();
  const p = chartPalette(useTheme().theme === 'light' ? 'light' : 'dark');
  const [preset, setPreset] = useState<PresetKey>('30d');
  const [range, setRange] = useState(() => presetRange('30d'));
  const [draft, setDraft] = useState(range);
  const [tab, setTab] = useState<Tab>('menu');
  const [locked, setLocked] = useState(false);
  const [insights, setInsights] = useState<Insight[] | null>(null);
  const [overview, setOverview] = useState<OverviewAnswer | null>(null);
  const [data, setData] = useState<Record<string, unknown>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // the owner's branch filter is the dashboard's branch selection (the api client sends it as X-Branch-Id too)
  const branch = ownerView ? (branchCtx.activeBranchId ?? '') : '';
  const qs = useMemo(() => {
    const q = new URLSearchParams({ from: range.from, to: range.to });
    if (ownerView) q.set('branch', branch);
    return q.toString();
  }, [range, branch, ownerView]);

  const fail = useCallback((e: unknown) => {
    const err = e as { code?: string; message?: string };
    if (err?.code === 'ANALYTICS_OFF') { setLocked(true); return; }
    setError(err?.message || 'Could not load analytics.');
  }, []);

  // the overview and the insights: once per period and branch
  useEffect(() => {
    let live = true;
    setInsights(null); setOverview(null); setError(null);
    client.get<OverviewAnswer>(`/api/analytics/overview?${qs}`)
      .then((r) => { if (live) { setLocked(false); setOverview(r); } })
      .catch((e) => { if (live) fail(e); });
    client.get<{ insights: Insight[] }>(`/api/analytics/insights?${qs}`)
      .then((r) => { if (live) { setLocked(false); setInsights(r.insights ?? []); } })
      .catch((e) => { if (live) fail(e); });
    return () => { live = false; };
  }, [qs]); // eslint-disable-line react-hooks/exhaustive-deps -- posApi is a new object every render (ManagerDashboard note)

  // the open tab: once per tab, period and branch (kept while the page is open — no polling)
  const tabKey = `${tab}|${qs}`;
  useEffect(() => {
    if (locked || tabKey in data) return;
    let live = true;
    setBusy(true);
    const path = TABS.find((t) => t.key === tab)!.path;
    client.get<unknown>(`${path}?${qs}`)
      .then((r) => { if (live) setData((d) => ({ ...d, [tabKey]: r })); })
      .catch((e) => { if (live) fail(e); })
      .finally(() => { if (live) setBusy(false); });
    return () => { live = false; };
  }, [tabKey, locked]); // eslint-disable-line react-hooks/exhaustive-deps

  function choose(k: PresetKey) {
    setPreset(k);
    if (k !== 'custom') { const r = presetRange(k); setRange(r); setDraft(r); }
  }
  const draftDays = draft.from && draft.to ? daysBetween(draft.from, draft.to) : 0;
  const draftError = !draft.from || !draft.to ? 'Choose both dates.' : draftDays < 1 ? 'The start must be on or before the end.'
    : draftDays > MAX_DAYS ? `At most ${MAX_DAYS} days.` : null;

  if (locked) {
    return (
      <div className="p-4 sm:p-6 space-y-4">
        <h1 className="text-xl font-bold text-white">Analytics</h1>
        <AnalyticsLocked />
      </div>
    );
  }

  const current = data[tabKey];
  return (
    <div className="p-4 sm:p-6 space-y-4 min-w-0" data-testid="analytics-page">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-bold text-white">Analytics</h1>
          <p className="text-sm text-gray-400">
            {ownerView ? (branchCtx.activeBranch?.name ?? 'All branches') : (branchName ?? 'Your branch')} · {fmt.dateShort(`${range.from}T12:00:00`)} – {fmt.dateShort(`${range.to}T12:00:00`)}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {ownerView && branchCtx.branches.length > 1 && (
            <label className="text-sm text-gray-400 flex items-center gap-2">
              Branch
              <select value={branch} onChange={(e) => branchCtx.setActiveBranch(branchCtx.branches.find((b) => b.id === e.target.value) ?? null)}
                className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm max-w-[12rem]" data-testid="analytics-branch">
                <option value="">All branches</option>
                {branchCtx.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </label>
          )}
          <button onClick={() => window.print()} className="px-3 py-2 rounded-lg text-sm bg-gray-800 text-gray-300 hover:text-white print:hidden" data-testid="analytics-print">
            Print
          </button>
        </div>
      </div>

      {/* period */}
      <div className="flex flex-wrap items-end gap-2 print:hidden">
        {PRESETS.map((x) => (
          <button key={x.key} onClick={() => choose(x.key)}
            className={`px-3 py-1.5 rounded-lg text-sm ${preset === x.key ? 'bg-swift-strong text-white' : 'bg-gray-800 text-gray-400 hover:text-white'}`}>
            {x.label}
          </button>
        ))}
        {preset === 'custom' && (
          <div className="flex flex-wrap items-end gap-2 w-full sm:w-auto">
            {(['from', 'to'] as const).map((k) => (
              <label key={k} className="text-xs text-gray-500 flex flex-col gap-1">
                {k === 'from' ? 'From' : 'To'}
                <input type="date" value={draft[k]} onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value }))}
                  className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-white text-sm" />
              </label>
            ))}
            <button disabled={!!draftError} onClick={() => setRange(draft)}
              className="px-3 py-1.5 rounded-lg text-sm bg-swift-strong hover:bg-swift-deep disabled:opacity-50 text-white">Show</button>
            {draftError && <span className="text-xs text-amber-400">{draftError}</span>}
          </div>
        )}
      </div>

      {error && <div className="px-4 py-2.5 rounded-lg text-sm bg-red-500/10 text-red-400">{error}</div>}

      {/* KPI row, the trend and the payment mix */}
      {overview ? <OverviewSection o={overview} p={p} currency={currency} />
        : <p className="text-sm text-gray-500">Working out the figures…</p>}

      {/* insights */}
      <section aria-label="Insights">
        {insights === null ? <p className="text-sm text-gray-500">Working out insights…</p>
          : insights.length === 0 ? <p className="text-sm text-gray-500">Nothing stands out in this period.</p>
          : (
            <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3" data-testid="analytics-insights">
              {insights.map((i) => <InsightCard key={i.id} i={i} p={p} />)}
            </ul>
          )}
      </section>

      {/* tabs */}
      <div className="flex gap-1 overflow-x-auto border-b border-gray-800 print:hidden">
        {TABS.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`px-3 py-2 text-sm whitespace-nowrap border-b-2 -mb-px ${tab === t.key ? 'border-swift text-swift-text' : 'border-transparent text-gray-400 hover:text-white'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {!current ? <p className="text-sm text-gray-500">{busy ? 'Loading…' : ''}</p>
        : tab === 'menu' ? <MenuSection m={current as MenuAnswer} p={p} currency={currency} />
        : tab === 'heatmap' ? <HeatmapSection h={current as HeatAnswer} p={p} currency={currency} />
        : tab === 'leaks' ? <LeaksSection l={current as LeaksAnswer} p={p} currency={currency} />
        : <CreditSection c={current as CreditAnswer} p={p} currency={currency} />}
    </div>
  );
}

// ── Overview: KPI row, trend, payment mix ─────────────────────────────────────

function OverviewSection({ o, p, currency }: { o: OverviewAnswer; p: ChartPalette; currency: string }) {
  const days = o.days.length;
  const compareLabel = `previous ${days} day${days === 1 ? '' : 's'}`;
  const money0 = (n: number | null) => fmt.money(n, currency, { decimals: 0, blank: '—' });
  const k = o.kpis;
  const spark = (pick: (d: OverviewAnswer['days'][number]) => number) => o.days.map(pick);
  const traded = o.days.some((d) => d.revenue > 0 || d.prevRevenue > 0);
  return (
    <div className="space-y-4" data-testid="analytics-overview">
      <div className={`grid grid-cols-2 sm:grid-cols-3 gap-2 ${k.margin ? 'lg:grid-cols-5' : 'lg:grid-cols-4'}`} data-testid="analytics-kpis">
        <KpiTile label="Sales" value={money0(k.revenue.value)} change={k.revenue.change} upIsGood compareLabel={compareLabel}
          spark={spark((d) => d.revenue)} p={p} testId="kpi-revenue" />
        <KpiTile label="Orders" value={fmt.num(k.orders.value ?? 0)} change={k.orders.change} upIsGood compareLabel={compareLabel}
          spark={spark((d) => d.orders)} p={p} testId="kpi-orders" />
        <KpiTile label="Average bill" value={money0(k.avgBill.value)} change={k.avgBill.change} upIsGood compareLabel={compareLabel}
          spark={spark((d) => d.avgBill ?? 0)} p={p} testId="kpi-avg-bill" />
        {k.margin && (
          <KpiTile label="Gross margin" value={pct(k.margin.value)} change={k.margin.change} upIsGood points compareLabel={compareLabel}
            p={p} note="on items with a cost set" testId="kpi-margin" />
        )}
        <KpiTile label="Money at risk" value={money0(k.atRisk.value)} change={k.atRisk.change} upIsGood={false} compareLabel={compareLabel}
          spark={spark((d) => d.atRisk)} p={p} testId="kpi-at-risk"
          note={o.wastageHidden ? 'voids, refunds, discounts' : 'voids, refunds, discounts, wastage'} />
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2 min-w-0">
          <ChartCard title="Daily sales" sub={`Against the ${compareLabel} (${fmt.dateShort(`${o.previous.from}T12:00:00`)} – ${fmt.dateShort(`${o.previous.to}T12:00:00`)})`}
            legend={<Legend items={[{ label: 'This period', colour: p.accent, line: true }, { label: 'Previous period', colour: p.compare, line: true }]} />}
            testId="analytics-trend">
            {traded ? <RevenueTrend days={o.days} p={p} currency={currency} /> : <p className="text-sm text-gray-500 py-6 text-center">No sales in either period.</p>}
          </ChartCard>
        </div>
        <ChartCard title="Payment mix" sub="What the period's sales were paid with" testId="analytics-payment-mix">
          <Donut slices={o.paymentMix.map((m) => ({ key: m.key, label: m.label, value: m.amount, colour: p.payments[m.key] }))}
            p={p} currency={currency} centre={fmt.compactMoney(o.paymentMix.reduce((s, m) => s + m.amount, 0), currency)} />
        </ChartCard>
      </div>
    </div>
  );
}

// ── Menu engineering ──────────────────────────────────────────────────────────

type SortKey = 'name' | 'qty' | 'revenue' | 'unitCost' | 'unitMargin' | 'totalMargin' | 'share' | 'class';

function MenuSection({ m, p, currency }: { m: MenuAnswer; p: ChartPalette; currency: string }) {
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'qty', desc: true });
  const rows = useMemo(() => {
    const v = (i: MenuItem): number | string => sort.key === 'name' ? i.name.toLowerCase() : sort.key === 'class' ? (i.class ?? '') : (i[sort.key] ?? -Infinity);
    return [...m.items].sort((a, b) => { const x = v(a), y = v(b); const c = x < y ? -1 : x > y ? 1 : 0; return sort.desc ? -c : c; });
  }, [m.items, sort]);
  const head = (key: SortKey, label: string, cls = '') => (
    <th className={`p-2 font-medium cursor-pointer select-none ${cls}`} onClick={() => setSort((s) => ({ key, desc: s.key === key ? !s.desc : key !== 'name' }))}>
      {label}{sort.key === key ? (sort.desc ? ' ↓' : ' ↑') : ''}
    </th>
  );
  if (!m.items.length) return <p className="text-sm text-gray-500">No items sold in this period.</p>;
  const hasMatrix = !m.costsHidden && m.avgUnitMargin !== null && m.items.some((i) => i.class && i.class !== 'no_cost');
  return (
    <div className="space-y-4">
      {m.costsHidden ? (
        <p className="text-sm text-gray-400">Costs and margins are hidden for your role, so items are not classified — the charts show what sold.</p>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
          {CLASS_ORDER.map((k) => (
            <div key={k} className="bg-gray-900 border border-gray-800 rounded-xl p-3" title={CLASS_META[k].hint}>
              <p className="text-xs text-gray-500 flex items-center gap-1.5"><ClassMark k={k} p={p} />{CLASS_META[k].label}</p>
              <p className="font-semibold mt-0.5 text-white text-lg">{m.counts[k] ?? 0}</p>
            </div>
          ))}
        </div>
      )}
      <div className="grid gap-4 xl:grid-cols-5">
        {hasMatrix ? (
          <div className="xl:col-span-3 min-w-0">
            <ChartCard title="Menu engineering matrix" sub="Popularity across, margin a unit up; bubble size = revenue"
              legend={<ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-gray-400">
                {(['star', 'plowhorse', 'puzzle', 'dog'] as MenuClass[]).map((k) => (
                  <li key={k} className="flex items-center gap-1.5"><ClassMark k={k} p={p} />{CLASS_META[k].label}s</li>
                ))}
              </ul>}>
              <MenuScatter items={m.items} threshold={m.popularityThreshold} avgMargin={m.avgUnitMargin as number} p={p} currency={currency} />
            </ChartCard>
          </div>
        ) : !m.costsHidden && (
          <p className="text-sm text-gray-500 xl:col-span-3">No item sold has a cost set yet, so there is no matrix.</p>
        )}
        <div className={`${hasMatrix || !m.costsHidden ? 'xl:col-span-2' : 'xl:col-span-5'} min-w-0`}>
          <ChartCard title="Top 10 items by revenue" sub={m.costsHidden ? undefined : 'Each bar in its class colour'}
            legend={m.costsHidden ? undefined : <Legend items={classLegend(p, m.counts.no_cost > 0)} />}>
            <TopItemsBar items={m.items} p={p} currency={currency} />
          </ChartCard>
        </div>
      </div>
      {!m.costsHidden && (
        <p className="text-xs text-gray-500">
          Popular = at least {pct(m.popularityThreshold)} of the items sold (70% of an even share). High margin = at least the
          average margin per item sold, {fmt.money(m.avgUnitMargin ?? 0, currency)}. Margin = average selling price − the cost of one
          serving (the cost price, else the recipe).
        </p>
      )}
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        <div className="overflow-x-auto"><table className="w-full text-sm">
          <thead><tr className="text-gray-500 text-left text-xs border-b border-gray-800">
            {head('name', 'Item')}
            {head('qty', 'Sold', 'text-right')}
            {head('revenue', 'Revenue', `text-right ${DESK}`)}
            {!m.costsHidden && head('unitCost', 'Unit cost', `text-right ${DESK}`)}
            {!m.costsHidden && head('unitMargin', 'Unit margin', 'text-right')}
            {!m.costsHidden && head('totalMargin', 'Total margin', `text-right ${DESK}`)}
            {head('share', 'Share', `text-right ${DESK}`)}
            {!m.costsHidden && head('class', 'Class')}
          </tr></thead>
          <tbody>
            {rows.map((i) => (
              <tr key={`${i.productId ?? i.name}`} className="border-b border-gray-800 last:border-0">
                <td className="p-2 text-white">{i.name}{i.category && <span className="block text-[11px] text-gray-500">{i.category}</span>}</td>
                <td className="p-2 text-right text-gray-300">{fmt.qty(i.qty)}</td>
                <td className={`p-2 text-right text-gray-300 ${DESK}`}>{fmt.money(i.revenue, currency)}</td>
                {!m.costsHidden && <td className={`p-2 text-right text-gray-400 ${DESK}`}>{fmt.money(i.unitCost, currency, { blank: '—' })}</td>}
                {!m.costsHidden && <td className="p-2 text-right text-gray-300">{fmt.money(i.unitMargin, currency, { blank: '—' })}</td>}
                {!m.costsHidden && <td className={`p-2 text-right text-gray-300 ${DESK}`}>{fmt.money(i.totalMargin, currency, { blank: '—' })}</td>}
                <td className={`p-2 text-right text-gray-400 ${DESK}`}>{pct(i.share)}</td>
                {!m.costsHidden && (
                  <td className="p-2 whitespace-nowrap text-gray-300" title={i.class ? CLASS_META[i.class].hint : ''}>
                    {i.class ? <span className="inline-flex items-center gap-1.5"><ClassMark k={i.class} p={p} />{CLASS_META[i.class].label}</span> : '—'}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table></div>
      </div>
    </div>
  );
}

// ── Busy times ────────────────────────────────────────────────────────────────

function HeatmapSection({ h, p, currency }: { h: HeatAnswer; p: ChartPalette; currency: string }) {
  if (!h.totalOrders || !h.tradingHours) return <p className="text-sm text-gray-500">No sales in this period.</p>;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <Card label="Busiest slot" value={h.busiest?.label ?? '—'} sub={h.busiest ? `${fmt.money(h.busiest.revenue, currency)} · ${h.busiest.orders} orders` : undefined} />
        <Card label="Quietest slot" value={h.quietest?.label ?? '—'} sub={h.quietest ? `${fmt.money(h.quietest.revenue, currency)} · ${h.quietest.orders} orders` : undefined} />
        <Card label="Sales in the period" value={fmt.money(h.totalRevenue, currency)} sub={`${fmt.num(h.totalOrders)} orders · East Africa Time`} />
      </div>
      <ChartCard title="Sales by day and hour" sub="Darker = more sales. Hours with no sale in the whole period are left out.">
        <Heatmap h={h} p={p} currency={currency} />
      </ChartCard>
      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard title="Sales by hour" sub="Every day of the period added together">
          <HourColumns h={h} p={p} currency={currency} />
        </ChartCard>
        <ChartCard title="Sales by weekday" sub="Every hour added together">
          <WeekdayBars h={h} p={p} currency={currency} />
        </ChartCard>
      </div>
      <p className="text-xs text-gray-500">Sales are counted when rung, before refunds.</p>
    </div>
  );
}

// ── Money leaks ───────────────────────────────────────────────────────────────

function LeaksSection({ l, p, currency }: { l: LeaksAnswer; p: ChartPalette; currency: string }) {
  const m = (n: number | null) => fmt.money(n, currency, { blank: '—' });
  const variance = (n: number) => <span className={n < 0 ? 'text-red-400' : n > 0 ? 'text-amber-400' : 'text-gray-500'}>{fmt.money(n, currency, { sign: true })}</span>;
  const flagged = l.cashiers.filter((c) => c.flags.length);
  const split = [
    { key: 'voids', label: 'Voids', value: l.totals.voidValue + l.totals.itemVoidValue, colour: p.leaks.voids },
    { key: 'refunds', label: 'Refunds', value: l.totals.refundValue, colour: p.leaks.refunds },
    { key: 'discounts', label: 'Discounts', value: l.totals.discountValue, colour: p.leaks.discounts },
    ...(l.wastageHidden ? [] : [{ key: 'wastage', label: 'Wastage', value: l.totals.wastageValue ?? 0, colour: p.leaks.wastage }]),
  ];
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Card label="Voids" value={m(l.totals.voidValue + l.totals.itemVoidValue)} sub={`${l.totals.voids} orders · ${l.totals.itemVoids} kitchen items`} />
        <Card label="Refunds" value={m(l.totals.refundValue)} sub={`${l.totals.refunds} refunds`} />
        <Card label="Discounts" value={m(l.totals.discountValue)} sub={`${l.totals.discounts} orders`} />
        <Card label="Day close short" value={m(-l.totals.dayCloseShort)} sub={l.wastageHidden ? `Wastage: ${l.totals.wastage} entries` : `Wastage ${m(l.totals.wastageValue)}`}
          tone={l.totals.dayCloseShort < 0 ? 'text-red-400' : 'text-white'} />
      </div>
      <div className="grid gap-4 xl:grid-cols-5">
        <div className="xl:col-span-3 min-w-0">
          <ChartCard title="By cashier" sub={flagged.length ? `${flagged.length} flagged (marked ⚑, listed first)` : 'Nobody is flagged'}
            legend={<Legend items={leakLegend(p, l.wastageHidden)} />}>
            <LeakStack cashiers={l.cashiers} p={p} currency={currency} wastageHidden={l.wastageHidden} />
          </ChartCard>
        </div>
        <div className="xl:col-span-2 min-w-0">
          <ChartCard title="Where it goes" sub="The split of the period's leaks">
            <Donut slices={split} p={p} currency={currency} centre={fmt.compactMoney(split.reduce((s, x) => s + x.value, 0), currency)} testId="analytics-leak-donut" />
          </ChartCard>
        </div>
      </div>
      <p className="text-xs text-gray-500">
        A cashier is flagged when their void rate or discount rate is at least 2× the median of the cashiers here (median void
        rate {pct(l.medians.voidRate)}, discount rate {pct(l.medians.discountRate)}), with at least 5 such events.
        {flagged.length ? ` ${flagged.length} flagged.` : ' Nobody is flagged.'}
      </p>
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        <h3 className="px-3 pt-3 text-sm font-semibold text-white">By cashier</h3>
        <div className="overflow-x-auto"><table className="w-full text-sm">
          <thead><tr className="text-gray-500 text-left text-xs border-b border-gray-800">
            <th className="p-2 font-medium">Cashier</th><th className={`p-2 font-medium text-right ${DESK}`}>Orders</th>
            <th className="p-2 font-medium text-right">Voids</th><th className="p-2 font-medium text-right">Void rate</th>
            <th className={`p-2 font-medium text-right ${DESK}`}>Refunds</th><th className={`p-2 font-medium text-right ${DESK}`}>Discounts</th>
            <th className={`p-2 font-medium text-right ${DESK}`}>Disc. rate</th><th className={`p-2 font-medium text-right ${DESK}`}>Wastage</th>
            <th className={`p-2 font-medium text-right ${DESK}`}>Drawer ±</th>
          </tr></thead>
          <tbody>
            {l.cashiers.map((c) => {
              const fv = c.flags.find((f) => f.kind === 'void'), fd = c.flags.find((f) => f.kind === 'discount');
              const tag = (f?: LeakFlag) => f ? <span className="ml-1 px-1.5 py-0.5 rounded bg-red-500/15 text-red-400 text-[10px] font-semibold">{f.multiple !== null ? `${f.multiple.toFixed(1)}× median` : 'flagged'}</span> : null;
              return (
                <tr key={c.cashierId ?? 'none'} className={`border-b border-gray-800 last:border-0 ${c.flags.length ? 'bg-red-500/5' : ''}`} data-flagged={c.flags.length ? 'yes' : undefined}>
                  <td className="p-2 text-white">{c.name}</td>
                  <td className={`p-2 text-right text-gray-300 ${DESK}`}>{c.orders}</td>
                  <td className="p-2 text-right text-gray-300">{c.voidEvents}<span className="block text-[11px] text-gray-500">{m(c.voidValue + c.itemVoidValue)}</span></td>
                  <td className={`p-2 text-right whitespace-nowrap ${fv ? 'text-red-400 font-semibold' : 'text-gray-300'}`}>{pct(c.voidRate)}{tag(fv)}</td>
                  <td className={`p-2 text-right text-gray-300 ${DESK}`}>{c.refunds}<span className="block text-[11px] text-gray-500">{m(c.refundValue)}</span></td>
                  <td className={`p-2 text-right text-gray-300 ${DESK}`}>{c.discounts}<span className="block text-[11px] text-gray-500">{m(c.discountValue)}</span></td>
                  <td className={`p-2 text-right whitespace-nowrap ${DESK} ${fd ? 'text-red-400 font-semibold' : 'text-gray-300'}`}>{pct(c.discountRate)}{tag(fd)}</td>
                  <td className={`p-2 text-right text-gray-300 ${DESK}`}>{l.wastageHidden ? c.wastage : m(c.wastageValue)}</td>
                  <td className={`p-2 text-right ${DESK}`}>{variance(c.drawerVariance)}</td>
                </tr>
              );
            })}
          </tbody>
        </table></div>
      </div>
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        <h3 className="px-3 pt-3 text-sm font-semibold text-white">By day</h3>
        <div className="overflow-x-auto"><table className="w-full text-sm">
          <thead><tr className="text-gray-500 text-left text-xs border-b border-gray-800">
            <th className="p-2 font-medium">Day</th><th className={`p-2 font-medium text-right ${DESK}`}>Orders</th>
            <th className="p-2 font-medium text-right">Voids</th><th className={`p-2 font-medium text-right ${DESK}`}>Refunds</th>
            <th className={`p-2 font-medium text-right ${DESK}`}>Discounts</th><th className={`p-2 font-medium text-right ${DESK}`}>Wastage</th>
            <th className="p-2 font-medium text-right">Day close ±</th>
          </tr></thead>
          <tbody>
            {l.days.map((d) => (
              <tr key={d.day} className={`border-b border-gray-800 last:border-0 ${d.dayCloseVariance < 0 ? 'bg-red-500/5' : ''}`}>
                <td className="p-2 text-white whitespace-nowrap">{fmt.dateShort(`${d.day}T12:00:00`)}</td>
                <td className={`p-2 text-right text-gray-300 ${DESK}`}>{d.orders}</td>
                <td className="p-2 text-right text-gray-300">{m(d.voidValue + d.itemVoidValue)}</td>
                <td className={`p-2 text-right text-gray-300 ${DESK}`}>{m(d.refundValue)}</td>
                <td className={`p-2 text-right text-gray-300 ${DESK}`}>{m(d.discountValue)}</td>
                <td className={`p-2 text-right text-gray-300 ${DESK}`}>{l.wastageHidden ? d.wastage : m(d.wastageValue)}</td>
                <td className="p-2 text-right">{variance(d.dayCloseVariance)}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </div>
      <p className="text-xs text-gray-500">Voids are voided orders plus kitchen items removed after they were sent. Refunds count on the day they were given, against the cashier of the sale. Drawer ± is the cashier's shift count; day close ± the till's day close (over +, short −).</p>
    </div>
  );
}

// ── Credit ageing ─────────────────────────────────────────────────────────────

function CreditSection({ c, p, currency }: { c: CreditAnswer; p: ChartPalette; currency: string }) {
  const m = (n: number) => (n ? fmt.money(n, currency) : '—');
  if (!c.customers.length) return <p className="text-sm text-gray-500">Nobody owes on credit.</p>;
  return (
    <div className="space-y-4">
      <div className="grid gap-4 xl:grid-cols-5">
        <div className="xl:col-span-2 min-w-0 space-y-4">
          <ChartCard title="How old the credit is" sub={`${fmt.money(c.totals.owed, currency, { decimals: 0 })} owed by ${c.totals.customers} customer${c.totals.customers === 1 ? '' : 's'}${c.totals.disputedCount ? ` · ${c.totals.disputedCount} disputed` : ''}`}>
            <AgeingBar totals={c.totals} p={p} currency={currency} />
          </ChartCard>
        </div>
        <div className="xl:col-span-3 min-w-0">
          <ChartCard title="Top debtors" sub="Each bar split by age" testId="analytics-debtors-card">
            <TopDebtors customers={c.customers} p={p} currency={currency} />
          </ChartCard>
        </div>
      </div>
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        <div className="overflow-x-auto"><table className="w-full text-sm">
          <thead><tr className="text-gray-500 text-left text-xs border-b border-gray-800">
            <th className="p-2 font-medium">Customer</th><th className="p-2 font-medium text-right">Owed</th>
            <th className={`p-2 font-medium text-right ${DESK}`}>0–30</th><th className={`p-2 font-medium text-right ${DESK}`}>31–60</th>
            <th className={`p-2 font-medium text-right ${DESK}`}>61–90</th><th className="p-2 font-medium text-right">90+</th>
            <th className={`p-2 font-medium text-right ${DESK}`}>Disputed</th>
          </tr></thead>
          <tbody>
            {c.customers.map((r) => (
              <tr key={r.customerId} className="border-b border-gray-800 last:border-0">
                <td className="p-2 text-white">{r.name}{r.phone && <span className="block text-[11px] text-gray-500">{r.phone}</span>}</td>
                <td className="p-2 text-right text-gray-300">{m(r.owed)}</td>
                <td className={`p-2 text-right text-gray-300 ${DESK}`}>{m(r.d0_30)}</td>
                <td className={`p-2 text-right text-gray-300 ${DESK}`}>{m(r.d31_60)}</td>
                <td className={`p-2 text-right ${DESK} ${r.d61_90 ? 'text-amber-400' : 'text-gray-500'}`}>{m(r.d61_90)}</td>
                <td className={`p-2 text-right ${r.d90_plus ? 'text-red-400' : 'text-gray-500'}`}>{m(r.d90_plus)}</td>
                <td className={`p-2 text-right ${DESK} ${r.disputedCount ? 'text-amber-400' : 'text-gray-500'}`}>{r.disputedCount ? `${r.disputedCount} · ${fmt.money(r.disputedAmount, currency)}` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </div>
      <p className="text-xs text-gray-500">
        As of {fmt.dateTime(c.asOf)}. The balance is the customer's credit account; repayments clear the oldest sales first, so what
        is still owed is the newest sales. A balance older than the account's history counts as over 90 days. Disputed: sales a
        manager disputed (still owed until voided or refunded).
      </p>
    </div>
  );
}
