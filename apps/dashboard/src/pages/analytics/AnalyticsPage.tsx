/**
 * AnalyticsPage.tsx — A549: Analytics v1 (premium). Menu engineering, a sales heatmap, money leaks and credit ageing for
 * a period, with rule-based insights at the top. The cloud works every figure out in SQL and keeps it a few minutes
 * (routes/analytics.ts); this page asks once per tab and period and NEVER polls.
 *
 * Owner (/dashboard/analytics): every branch, or one, from the branch filter (the dashboard's own branch selection).
 * Manager portal (Analytics tab, reports.sales): their own branch — no filter; the cloud holds them to it anyway.
 * Off for the business (the admin portal's 'analytics' switch): the cloud answers ANALYTICS_OFF and the page shows the
 * premium panel instead. Colours: the fixed SwiftPOS teal (swift-*) and status colours only — never raw green or blue
 * (check-back-office-colour); light and dark through the usual gray classes.
 */
import { useState, useEffect, useMemo, useCallback } from 'react';
import { api } from '../../lib/api';
import { useBusiness } from '../../context/BusinessContext';
import { useBranch } from '../../context/BranchContext';
import { localDateStr } from '../../lib/localDate';
import { DESK } from '../../components/RowMore';
import * as fmt from '../../lib/format';

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

export interface AnalyticsClient { get: <T>(path: string) => Promise<T> }
type Tab = 'menu' | 'heatmap' | 'leaks' | 'credit';
const TABS: { key: Tab; label: string; path: string }[] = [
  { key: 'menu', label: 'Menu engineering', path: '/api/analytics/menu-engineering' },
  { key: 'heatmap', label: 'Sales heatmap', path: '/api/analytics/heatmap' },
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

const CLASS_META: Record<MenuClass, { label: string; text: string; fill: string; hint: string }> = {
  star:      { label: 'Star',      text: 'text-swift-text',  fill: 'fill-swift',       hint: 'Popular and profitable — keep it prominent.' },
  plowhorse: { label: 'Plowhorse', text: 'text-amber-400',   fill: 'fill-amber-500',   hint: 'Popular, low margin — a small price rise or a cheaper recipe.' },
  puzzle:    { label: 'Puzzle',    text: 'text-purple-400',  fill: 'fill-purple-500',  hint: 'Profitable but slow — feature it, have staff suggest it.' },
  dog:       { label: 'Dog',       text: 'text-red-400',     fill: 'fill-red-500',     hint: 'Slow and low margin — rework it or take it off.' },
  no_cost:   { label: 'No cost set', text: 'text-gray-500',  fill: 'fill-gray-500',    hint: 'Set a cost price or a recipe to see its margin.' },
};
const SEVERITY_STYLE: Record<Insight['severity'], string> = {
  high: 'border-red-500/40 bg-red-500/10 text-red-400',
  medium: 'border-amber-500/40 bg-amber-500/10 text-amber-400',
  low: 'border-gray-700 bg-gray-800/60 text-gray-300',
};
const pct = (x: number | null | undefined, dp = 1) => (x === null || x === undefined ? '—' : `${(x * 100).toFixed(dp)}%`);
const hh = (h: number) => `${String(h % 24).padStart(2, '0')}:00`;
const DAYS_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function Card({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-3">
      <p className="text-xs text-gray-500">{label}</p>
      <p className={`font-semibold mt-0.5 ${tone ?? 'text-white'}`}>{value}</p>
      {sub && <p className="text-[11px] text-gray-500 mt-0.5">{sub}</p>}
    </div>
  );
}

/** A549: what a business without Analytics sees — the premium panel, as the Branding page's Themes note. */
export function AnalyticsLocked() {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 max-w-xl" data-testid="analytics-locked">
      <p className="text-xs font-bold uppercase tracking-wider text-swift-text">ZapTill Premium</p>
      <h2 className="text-lg font-bold text-white mt-1">Analytics is part of ZapTill Premium</h2>
      <p className="text-sm text-gray-400 mt-2">
        Menu engineering (your Stars, Plowhorses, Puzzles and Dogs), a sales heatmap by day and hour, money leaks by
        cashier and day, and credit ageing — with plain-English suggestions. Contact ZapTill to enable it.
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
  const [preset, setPreset] = useState<PresetKey>('30d');
  const [range, setRange] = useState(() => presetRange('30d'));
  const [draft, setDraft] = useState(range);
  const [tab, setTab] = useState<Tab>('menu');
  const [locked, setLocked] = useState(false);
  const [insights, setInsights] = useState<Insight[] | null>(null);
  const [data, setData] = useState<Record<string, unknown>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // the owner's branch filter is the dashboard's branch selection (the api client sends it as X-Branch-Id too)
  const branch = ownerView ? (branchCtx.activeBranchId ?? '') : '';
  const qs = useMemo(() => {
    const p = new URLSearchParams({ from: range.from, to: range.to });
    if (ownerView) p.set('branch', branch);
    return p.toString();
  }, [range, branch, ownerView]);

  const fail = useCallback((e: unknown) => {
    const err = e as { code?: string; message?: string };
    if (err?.code === 'ANALYTICS_OFF') { setLocked(true); return; }
    setError(err?.message || 'Could not load analytics.');
  }, []);

  // insights: once per period and branch
  useEffect(() => {
    let live = true;
    setInsights(null); setError(null);
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
      </div>

      {/* period */}
      <div className="flex flex-wrap items-end gap-2">
        {PRESETS.map((p) => (
          <button key={p.key} onClick={() => choose(p.key)}
            className={`px-3 py-1.5 rounded-lg text-sm ${preset === p.key ? 'bg-swift-strong text-white' : 'bg-gray-800 text-gray-400 hover:text-white'}`}>
            {p.label}
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

      {/* insights */}
      <section aria-label="Insights">
        {insights === null ? <p className="text-sm text-gray-500">Working out insights…</p>
          : insights.length === 0 ? <p className="text-sm text-gray-500">Nothing stands out in this period.</p>
          : (
            <ul className="grid gap-2 sm:grid-cols-2" data-testid="analytics-insights">
              {insights.map((i) => (
                <li key={i.id} className={`border rounded-lg px-3 py-2 text-sm ${SEVERITY_STYLE[i.severity]}`}>
                  <span className="text-[10px] font-bold uppercase tracking-wider opacity-80 mr-2">{i.type === 'timing' ? 'Timing' : i.type === 'leaks' ? 'Money leak' : i.type === 'credit' ? 'Credit' : 'Menu'}</span>
                  {i.text}
                </li>
              ))}
            </ul>
          )}
      </section>

      {/* tabs */}
      <div className="flex gap-1 overflow-x-auto border-b border-gray-800">
        {TABS.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`px-3 py-2 text-sm whitespace-nowrap border-b-2 -mb-px ${tab === t.key ? 'border-swift text-swift-text' : 'border-transparent text-gray-400 hover:text-white'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {!current ? <p className="text-sm text-gray-500">{busy ? 'Loading…' : ''}</p>
        : tab === 'menu' ? <MenuSection m={current as MenuAnswer} currency={currency} />
        : tab === 'heatmap' ? <HeatmapSection h={current as HeatAnswer} currency={currency} />
        : tab === 'leaks' ? <LeaksSection l={current as LeaksAnswer} currency={currency} />
        : <CreditSection c={current as CreditAnswer} currency={currency} />}
    </div>
  );
}

// ── Menu engineering ──────────────────────────────────────────────────────────

type SortKey = 'name' | 'qty' | 'revenue' | 'unitCost' | 'unitMargin' | 'totalMargin' | 'share' | 'class';

function MenuSection({ m, currency }: { m: MenuAnswer; currency: string }) {
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
  return (
    <div className="space-y-4">
      {m.costsHidden ? (
        <p className="text-sm text-gray-400">Costs and margins are hidden for your role, so items are not classified — the list shows what sold.</p>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
            {(Object.keys(CLASS_META) as MenuClass[]).map((k) => (
              <Card key={k} label={CLASS_META[k].label} value={String(m.counts[k] ?? 0)} tone={CLASS_META[k].text} />
            ))}
          </div>
          <MenuMatrix m={m} currency={currency} />
          <p className="text-xs text-gray-500">
            Popular = at least {pct(m.popularityThreshold)} of the items sold (70% of an even share). High margin = at least the
            average margin per item sold, {fmt.money(m.avgUnitMargin ?? 0, currency)}. Margin = average selling price − the cost of one
            serving (the cost price, else the recipe).
          </p>
        </>
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
                {!m.costsHidden && <td className={`p-2 whitespace-nowrap ${i.class ? CLASS_META[i.class].text : 'text-gray-500'}`} title={i.class ? CLASS_META[i.class].hint : ''}>{i.class ? CLASS_META[i.class].label : '—'}</td>}
              </tr>
            ))}
          </tbody>
        </table></div>
      </div>
    </div>
  );
}

/** Popularity (share of items sold) across, unit margin up; the two thresholds split the four quadrants. Plain SVG. */
function MenuMatrix({ m, currency }: { m: MenuAnswer; currency: string }) {
  const pts = m.items.filter((i) => i.unitMargin !== null && i.class && i.class !== 'no_cost');
  if (!pts.length || m.avgUnitMargin === null) return <p className="text-sm text-gray-500">No item sold has a cost set yet, so there is no matrix.</p>;
  const W = 600, H = 340, L = 56, R = 12, T = 12, B = 36;
  const maxX = Math.max(m.popularityThreshold * 2, ...pts.map((p) => p.share)) * 1.08;
  const margins = pts.map((p) => p.unitMargin as number);
  const minY = Math.min(0, ...margins, m.avgUnitMargin), maxY = Math.max(...margins, m.avgUnitMargin) * 1.1 || 1;
  const x = (v: number) => L + (v / maxX) * (W - L - R);
  const y = (v: number) => T + (1 - (v - minY) / (maxY - minY || 1)) * (H - T - B);
  const tx = x(m.popularityThreshold), ty = y(m.avgUnitMargin);
  const corner = (cls: MenuClass, cx: number, cy: number, anchor: 'start' | 'end') => (
    <text x={cx} y={cy} textAnchor={anchor} className={`${CLASS_META[cls].fill} text-[13px] font-bold`} opacity={0.75}>{CLASS_META[cls].label}s</text>
  );
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-3">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto text-gray-500" role="img" aria-label="Menu engineering matrix: popularity against margin">
        <line x1={L} y1={H - B} x2={W - R} y2={H - B} stroke="currentColor" strokeOpacity={0.4} />
        <line x1={L} y1={T} x2={L} y2={H - B} stroke="currentColor" strokeOpacity={0.4} />
        <line x1={tx} y1={T} x2={tx} y2={H - B} stroke="currentColor" strokeDasharray="4 4" strokeOpacity={0.6} />
        <line x1={L} y1={ty} x2={W - R} y2={ty} stroke="currentColor" strokeDasharray="4 4" strokeOpacity={0.6} />
        {corner('puzzle', L + 6, T + 14, 'start')}
        {corner('star', W - R - 6, T + 14, 'end')}
        {corner('dog', L + 6, H - B - 8, 'start')}
        {corner('plowhorse', W - R - 6, H - B - 8, 'end')}
        <text x={(L + W - R) / 2} y={H - 8} textAnchor="middle" fill="currentColor" className="text-[11px]">Popularity (share of items sold) →</text>
        <text x={14} y={(T + H - B) / 2} textAnchor="middle" fill="currentColor" className="text-[11px]" transform={`rotate(-90 14 ${(T + H - B) / 2})`}>Unit margin →</text>
        <text x={tx} y={H - B + 14} textAnchor="middle" fill="currentColor" className="text-[10px]">{pct(m.popularityThreshold)}</text>
        <text x={L - 4} y={ty + 3} textAnchor="end" fill="currentColor" className="text-[10px]">{fmt.num(m.avgUnitMargin)}</text>
        {pts.map((p) => (
          <g key={p.productId ?? p.name}>
            <circle cx={x(p.share)} cy={y(p.unitMargin as number)} r={6} className={CLASS_META[p.class as MenuClass].fill} fillOpacity={0.85}>
              <title>{`${p.name} — ${CLASS_META[p.class as MenuClass].label}: ${fmt.qty(p.qty)} sold (${pct(p.share)}), margin ${fmt.money(p.unitMargin, currency)} a unit`}</title>
            </circle>
          </g>
        ))}
      </svg>
    </div>
  );
}

// ── Heatmap ───────────────────────────────────────────────────────────────────

function HeatmapSection({ h, currency }: { h: HeatAnswer; currency: string }) {
  if (!h.totalOrders || !h.tradingHours) return <p className="text-sm text-gray-500">No sales in this period.</p>;
  const hours: number[] = [];
  for (let k = h.tradingHours.from; k <= h.tradingHours.to; k++) hours.push(k);
  const shade = (v: number) => (v <= 0 || h.maxRevenue <= 0 ? 0 : 0.12 + 0.78 * (v / h.maxRevenue));
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <Card label="Busiest slot" value={h.busiest?.label ?? '—'} sub={h.busiest ? `${fmt.money(h.busiest.revenue, currency)} · ${h.busiest.orders} orders` : undefined} tone="text-swift-text" />
        <Card label="Quietest slot" value={h.quietest?.label ?? '—'} sub={h.quietest ? `${fmt.money(h.quietest.revenue, currency)} · ${h.quietest.orders} orders` : undefined} tone="text-amber-400" />
        <Card label="Sales in the period" value={fmt.money(h.totalRevenue, currency)} sub={`${fmt.num(h.totalOrders)} orders · East Africa Time`} />
      </div>
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-3">
        <div className="overflow-x-auto">
          <table className="border-separate text-[11px]" style={{ borderSpacing: 2 }} data-testid="analytics-heatmap">
            <thead><tr>
              <th className="w-10" />
              {hours.map((k) => <th key={k} className="font-normal text-gray-500 px-0.5 min-w-[1.75rem]">{String(k).padStart(2, '0')}</th>)}
            </tr></thead>
            <tbody>
              {DAYS_SHORT.map((d, di) => (
                <tr key={d}>
                  <th className="text-left font-normal text-gray-500 pr-1">{d}</th>
                  {hours.map((k) => {
                    const v = h.revenue[di]?.[k] ?? 0, o = h.orders[di]?.[k] ?? 0;
                    return (
                      <td key={k} className="h-7 rounded border border-gray-800" style={{ background: v > 0 ? `rgb(var(--swift) / ${shade(v).toFixed(2)})` : undefined }}
                        title={`${d} ${hh(k)}–${hh(k + 1)}: ${fmt.money(v, currency)} · ${o} orders`} />
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-gray-500 mt-2">Darker = more sales. Hours with no sale in the whole period are left out. Sales are counted when rung, before refunds.</p>
      </div>
    </div>
  );
}

// ── Money leaks ───────────────────────────────────────────────────────────────

function LeaksSection({ l, currency }: { l: LeaksAnswer; currency: string }) {
  const m = (n: number | null) => fmt.money(n, currency, { blank: '—' });
  const variance = (n: number) => <span className={n < 0 ? 'text-red-400' : n > 0 ? 'text-amber-400' : 'text-gray-500'}>{fmt.money(n, currency, { sign: true })}</span>;
  const flagged = l.cashiers.filter((c) => c.flags.length);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Card label="Voids" value={m(l.totals.voidValue + l.totals.itemVoidValue)} sub={`${l.totals.voids} orders · ${l.totals.itemVoids} kitchen items`} />
        <Card label="Refunds" value={m(l.totals.refundValue)} sub={`${l.totals.refunds} refunds`} />
        <Card label="Discounts" value={m(l.totals.discountValue)} sub={`${l.totals.discounts} orders`} />
        <Card label="Day close short" value={m(-l.totals.dayCloseShort)} sub={l.wastageHidden ? `Wastage: ${l.totals.wastage} entries` : `Wastage ${m(l.totals.wastageValue)}`}
          tone={l.totals.dayCloseShort < 0 ? 'text-red-400' : 'text-white'} />
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

function CreditSection({ c, currency }: { c: CreditAnswer; currency: string }) {
  const m = (n: number) => (n ? fmt.money(n, currency) : '—');
  if (!c.customers.length) return <p className="text-sm text-gray-500">Nobody owes on credit.</p>;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        <Card label="0–30 days" value={fmt.money(c.totals.d0_30, currency)} />
        <Card label="31–60 days" value={fmt.money(c.totals.d31_60, currency)} />
        <Card label="61–90 days" value={fmt.money(c.totals.d61_90, currency)} tone={c.totals.d61_90 > 0 ? 'text-amber-400' : undefined} />
        <Card label="Over 90 days" value={fmt.money(c.totals.d90_plus, currency)} tone={c.totals.d90_plus > 0 ? 'text-red-400' : undefined} />
        <Card label="Owed in all" value={fmt.money(c.totals.owed, currency)} sub={`${c.totals.customers} customers${c.totals.disputedCount ? ` · ${c.totals.disputedCount} disputed` : ''}`} />
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
