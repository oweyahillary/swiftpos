/**
 * AnalyticsPage.tsx — A549: Analytics v1 (premium); A553: Analytics v2 — the figures drawn; A558: "decisions made easy".
 *
 * The owner, 2026-10-21: "i dont understand the cards at the top … add recommendations … what is sold more at what time
 * make it fine to grain level … the owner/manager needs to feel the value not just numbers on the screen … any table cap
 * it to 10 rows". The page, top to bottom:
 *   1. "How was this period?" — one or two sentences from the numbers, the good news first, then the biggest worry;
 *   2. "Do this next" — 3 to 7 ranked action cards (verb first, why with the numbers, the KES estimate a month or once
 *      with the assumption it rests on, a confidence marker, a link to the evidence) and the estimates added up;
 *   3. the KPI tiles in plain words ("9.5% more than the 30 days before", "What one customer spends per visit");
 *   4. "What sells when" — the dayparts' top 5, one item's own weekday × hour grid, every hour's top 3;
 *   5. daily sales against the previous period and the payment mix;
 *   6. the tabs (menu engineering, busy times, money leaks, credit ageing), each opening with what it tells you.
 * Every table shows its top 10 by the column that matters and says "Showing the top 10 of N" — no paging.
 * A561: three more areas — Stock ("How fast your stock goes"), Customers ("Who comes back") and Costs ("What each sale
 * really earns", with the items that have no cost at the top) — and the tab row is now "Dig into the details": tiles with
 * a live figure each and a "To do" badge (areas.tsx), a compact copy sticking while scrolling inside an area, `?tab=` to
 * open one directly. A call-out under the summary when 5% or more of the sales have no cost (costs only).
 * A565: a Branches area (the owner or a partner of every branch, with two or more branches — the cloud's hook says so):
 * the branches side by side and the stock moves to consider; "Do this next" gains the movement cards (words only — no
 * quantity, no KES; "Start a transfer" opens the transfer page with the items and both branches filled in, the quantity
 * blank) and the falling-branch card ("What sells when at Westlands" switches the branch and scrolls there).
 * A575: "What sells together" after What sells when (the product pairs bought in the same order, the top 10, together.tsx)
 * with one or two "Do this next" cards (a combo, the same shelf, at the pumps — never a price, no KES). And each business
 * type's own words (lib/analyticsTerms.ts analyticsWords): a shop reads "Product performance", "cost of sales", "items
 * removed" — never "Menu engineering", "food cost" or "kitchen items"; a restaurant or café keeps its words.
 *
 * The cloud works every figure out in SQL and keeps it a few minutes (routes/analytics.ts); this page asks once per
 * period for the overview, the recommendations and what sells when, once per tab and period for a tab, and NEVER polls.
 *
 * Owner (/dashboard/analytics): every branch, or one, from the branch filter (the dashboard's own branch selection).
 * Manager portal (Analytics tab, reports.sales): their own branch — no filter; the cloud holds them to it anyway.
 * Off for the business (the admin portal's 'analytics' switch): the cloud answers ANALYTICS_OFF and the page shows the
 * premium panel instead. Without costs (A490) no margin, class, wastage value or menu advice is sent, so none is drawn.
 * Colours: the back office's actions stay the SwiftPOS teal (swift-*); every chart colour comes from chartPalette.ts for the
 * dashboard's mode (light / dark), and text stays in the usual gray classes.
 */
import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { useBusiness } from '../../context/BusinessContext';
import { analyticsWords, type AnalyticsWords } from '@zaptill/core/analyticsTerms';
import { useBranch } from '../../context/BranchContext';
import { useTheme } from '../../context/ThemeContext';
import { localDateStr } from '../../lib/localDate';
import { DESK } from '../../components/RowMore';
import * as fmt from '../../lib/format';
import { chartPalette, CLASS_ORDER, CLASS_SHAPE, type ChartPalette, type PayKey } from './chartPalette';
import { useBrandLook } from '../../components/ThemeLayer';   // A597
import { brandChartAccent, brandChartSecond } from '../../lib/themeVars';
import { capRows, compareWords, per100, visibleAreas, areaFromQuery, AREA_ORDER, type AreaKey, type AreaHook } from './chartMath';
import {
  AreaTiles, StockSection, CustomersSection, CostsSection, NoCostBanner, BranchesSection, transferLink,
  type StockAnswer, type CustomersAnswer, type CostsAnswer, type BranchesAnswer, type MoveLine,
} from './areas';
import {
  ChartCard, Legend, KpiTile, RevenueTrend, Donut, MenuScatter, TopItemsBar, Heatmap, HourColumns, WeekdayBars, LeakStack,
  AgeingBar, TopDebtors, ItemHeatmap, ShareList, classLegend, leakLegend,
} from './charts';
import { TogetherSection, type TogetherAnswer } from './together';

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
interface Kpi { value: number | null; prev: number | null; change: number | null }
interface OverviewAnswer {
  period: { from: string; to: string }; previous: { from: string; to: string };
  days: { day: string; revenue: number; orders: number; avgBill: number | null; atRisk: number; prevDay: string; prevRevenue: number; prevOrders: number }[];
  kpis: { revenue: Kpi; orders: Kpi; avgBill: Kpi; margin: Kpi | null; atRisk: Kpi };
  atRiskParts: { voids: number; refunds: number; discounts: number; wastage: number | null };
  paymentMix: { key: PayKey; label: string; amount: number; share: number }[];
  marginHidden: boolean; wastageHidden: boolean;
  /** A561: the share of sales with no cost (costs only) */
  noCost?: { share: number | null; items: number; revenue: number } | null;
}
type Evidence = 'menu' | 'heatmap' | 'leaks' | 'credit' | 'times' | 'stock' | 'customers' | 'costs' | 'branches' | 'together';
interface Recommendation {
  id: string; kind: string; title: string; why: string;
  impact: number | null; impactPer: 'month' | 'once' | null; impactKind: 'gain' | 'recover' | 'collect' | 'at_risk' | null;
  assumption: string; confidence: 'high' | 'medium' | 'low'; evidence: Evidence;
  /** A560: a stock card's estimate in units; a warning (a cashier's voids) has no estimate */
  stock?: { by: string; items: { name: string; qty: number; onHand?: number; order?: number }[] } | null;
  warning?: boolean;
  /** A565: a stock move to consider (the items and the two branches — no quantity); the branch a card is about */
  move?: MoveLine;
  branchId?: string;
}
interface RecAnswer {
  summary: { good: string; worry: string | null; tone: 'up' | 'down' | 'flat' };
  recommendations: Recommendation[]; costsHidden: boolean;
  found: { monthly: number; once: number; count: number; atRisk?: number; line?: string | null };
  /** A560: why no "running low" card can be worked out (every branch in view) */
  stockNote?: string | null;
  /** A561: one live figure per area tile, and whether a card points there */
  hooks?: Partial<Record<AreaKey, AreaHook>>;
}
type DaypartKey = 'morning' | 'lunch' | 'afternoon' | 'evening' | 'late';
interface TopItem { productId: string | null; name: string; qty: number; share: number }
interface ItemTimes {
  productId: string | null; name: string; qty: number; revenue: number; cells: [number, number, number, number][];
  dayparts: Record<DaypartKey, number>; bestDaypart: DaypartKey | null; bestDaypartShare: number | null;
  peak: { dow: number; day: string; hour: number; qty: number } | null;
}
interface TimesAnswer {
  cutoff: number; items: ItemTimes[]; totals: { qty: number; revenue: number }; limited: boolean;
  dayparts: { key: DaypartKey; label: string; from: number; to: number; qty: number; revenue: number; share: number; top: TopItem[] }[];
  hours: { hour: number; label: string; qty: number; revenue: number; top: TopItem[] }[];
  /** A560: each weekday's top 3 and their typical sales that day */
  week?: { dow: number; day: string; count: number; top: { productId: string | null; name: string; qty: number }[] }[];
}

export interface AnalyticsClient { get: <T>(path: string) => Promise<T> }
type Tab = AreaKey;
const TABS: { key: Tab; label: string; path: string; tells: string }[] = [
  { key: 'menu', label: 'Menu engineering', path: '/api/analytics/menu-engineering',
    tells: 'Which items earn you money and which only keep the kitchen busy: keep the Stars, check the recipe or portion of the Plowhorses, push the Puzzles, rework the Dogs.' },
  { key: 'heatmap', label: 'Busy times', path: '/api/analytics/heatmap',
    tells: 'When customers come: put more staff on the dark squares, run offers in the pale ones.' },
  { key: 'leaks', label: 'Money leaks', path: '/api/analytics/money-leaks',
    tells: 'Where money leaves without a sale — voids, refunds, discounts, wastage — and which cashier to talk to first.' },
  { key: 'credit', label: 'Credit ageing', path: '/api/analytics/credit-ageing',
    tells: 'Who owes you and for how long: chase the oldest (red) first — the longer it waits, the less likely it is paid.' },
  { key: 'stock', label: 'Stock', path: '/api/analytics/stock',
    tells: 'How fast your stock goes: order what runs out soonest, and buy less of what you throw away.' },
  { key: 'branches', label: 'Branches', path: '/api/analytics/branches',
    tells: 'Your branches side by side: see which one is falling behind, and which stock sits at one branch while another runs low.' },
  { key: 'customers', label: 'Customers', path: '/api/analytics/customers',
    tells: 'Who comes back: thank your best customers, call the regulars who have gone quiet, and see how orders come in.' },
  { key: 'costs', label: 'Costs', path: '/api/analytics/costs',
    tells: 'What each sale really earns: set the missing costs first, then check the portion or the ingredients of the thinnest items.' },
];
/** A561: a tab the person may not open answers 403 — shown in the area, not as a page error. */
interface Forbidden { forbidden: string }

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
const TABLE_ROWS = 10;

// ── Small pieces ──────────────────────────────────────────────────────────────

const CLASS_META: Record<MenuClass, { label: string; hint: string }> = {
  star:      { label: 'Star',        hint: 'Popular and profitable — keep it prominent.' },
  plowhorse: { label: 'Plowhorse',   hint: 'Popular but earns little — check the recipe cost or portion, or pair it with a higher-margin item.' },
  puzzle:    { label: 'Puzzle',      hint: 'Profitable but slow — feature it, have staff suggest it.' },
  dog:       { label: 'Dog',         hint: 'Slow and low margin — rework it or take it off.' },
  no_cost:   { label: 'No cost set', hint: 'Set a cost or a recipe to see its margin.' },
};
const pct = (x: number | null | undefined, dp = 1) => (x === null || x === undefined ? '—' : `${(x * 100).toFixed(dp)}%`);
const hh = (h: number) => `${String(h % 24).padStart(2, '0')}:00`;

function Card({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-3">
      <p className="text-xs text-gray-500">{label}</p>
      <p className={`font-semibold mt-0.5 ${tone ?? 'text-white'}`}>{value}</p>
      {sub && <p className="text-[11px] text-gray-500 mt-0.5">{sub}</p>}
    </div>
  );
}

/** A558: under every capped table — the top 10 of how many, and by what. */
function CapNote({ shown, total, by }: { shown: number; total: number; by: string }) {
  if (total <= shown) return null;
  return <p className="px-3 py-2 text-[11px] text-gray-500 border-t border-gray-800" data-testid="analytics-cap">Showing the top {shown} of {total}, {by}.</p>;
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

/** A549: what a business without Analytics sees — the premium panel, as the Branding page's Themes note. */
export function AnalyticsLocked() {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 max-w-xl" data-testid="analytics-locked">
      <p className="text-xs font-bold uppercase tracking-wider text-swift-text">ZapTill Premium</p>
      <h2 className="text-lg font-bold text-white mt-1">Analytics is part of ZapTill Premium</h2>
      <p className="text-sm text-gray-400 mt-2">
        A plain-English verdict on every period, a short list of what to do next with what each is worth in shillings, what
        sells at what time of day, which items earn you money, what runs out soonest, which regulars have gone quiet, when
        to staff up, which cashier to talk to and who owes you — drawn as charts. Contact ZapTill to enable it.
      </p>
    </div>
  );
}

// ── The page ──────────────────────────────────────────────────────────────────

/** The owner's route: every branch or one (the dashboard's branch selection), through the dashboard's api client. */
export default function AnalyticsRoute() {
  const business = useBusiness().business;
  return <Analytics client={api} ownerView currency={business?.currency ?? 'KES'} businessType={business?.type ?? null} />;
}

export function Analytics({ client, ownerView, currency, branchName, businessType }: {
  client: AnalyticsClient; ownerView: boolean; currency: string; branchName?: string;
  /** A575: the business type (the owner's BusinessContext, the manager portal's session) — the page's words */
  businessType?: string | null;
}) {
  const words = analyticsWords(businessType);
  const branchCtx = useBranch();
  const mode = useTheme().theme === 'light' ? 'light' : 'dark';
  // A597 / A605: the shop's primary colour (else its secondary) as the first series, and its secondary as the comparison
  // line, each at a shade seen on the card — only with themes on and a colour chosen; otherwise the palette as before.
  const look = useBrandLook();
  const brandAccent = brandChartAccent(look, mode), brandSecond = brandChartSecond(look, mode);
  const p = useMemo(() => {
    const base = chartPalette(mode);
    return brandAccent ? { ...base, accent: brandAccent, ...(brandSecond ? { compare: brandSecond } : {}), severity: { ...base.severity, low: brandAccent } } : base;
  }, [mode, brandAccent, brandSecond]);
  const [preset, setPreset] = useState<PresetKey>('30d');
  const [range, setRange] = useState(() => presetRange('30d'));
  const [draft, setDraft] = useState(range);
  // A561: ?tab=stock opens an area directly (the owner's page keeps it in the address as areas are picked)
  const [tab, setTab] = useState<Tab>(() => (typeof window !== 'undefined' ? areaFromQuery(window.location.search, AREA_ORDER) : null) ?? 'menu');
  const [locked, setLocked] = useState(false);
  const [recs, setRecs] = useState<RecAnswer | null>(null);
  const [overview, setOverview] = useState<OverviewAnswer | null>(null);
  const [times, setTimes] = useState<TimesAnswer | null>(null);
  const [together, setTogether] = useState<TogetherAnswer | null>(null);   // A575
  const [data, setData] = useState<Record<string, unknown>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // An area that failed to load says so in its own panel (not only at the top of the page), with Retry
  const [areaError, setAreaError] = useState<Record<string, string>>({});
  const [retry, setRetry] = useState(0);
  const tabsRef = useRef<HTMLDivElement>(null);
  const timesRef = useRef<HTMLElement>(null);
  const togetherRef = useRef<HTMLElement>(null);

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

  // the overview, the recommendations and what sells when: once per period and branch (the cloud shares the work)
  useEffect(() => {
    let live = true;
    setRecs(null); setOverview(null); setTimes(null); setTogether(null); setError(null);
    client.get<OverviewAnswer>(`/api/analytics/overview?${qs}`)
      .then((r) => { if (live) { setLocked(false); setOverview(r); } })
      .catch((e) => { if (live) fail(e); });
    client.get<RecAnswer>(`/api/analytics/recommendations?${qs}`)
      .then((r) => { if (live) { setLocked(false); setRecs(r); } })
      .catch((e) => { if (live) fail(e); });
    client.get<TimesAnswer>(`/api/analytics/item-times?${qs}`)
      .then((r) => { if (live) { setLocked(false); setTimes(r); } })
      .catch((e) => { if (live) fail(e); });
    // A575: what sells together — before migration 164 runs the cloud answers 503; the section is simply left out
    client.get<TogetherAnswer>(`/api/analytics/together?${qs}`)
      .then((r) => { if (live) setTogether(r); })
      .catch((e) => { if (live && (e as { code?: string })?.code === 'ANALYTICS_OFF') fail(e); });
    return () => { live = false; };
  }, [qs]); // eslint-disable-line react-hooks/exhaustive-deps -- posApi is a new object every render (ManagerDashboard note)

  // the open tab: once per tab, period and branch (kept while the page is open — no polling)
  const tabKey = `${tab}|${qs}`;
  useEffect(() => {
    if (locked || tabKey in data) return;
    let live = true;
    setBusy(true);
    setAreaError((a) => { if (!(tabKey in a)) return a; const n = { ...a }; delete n[tabKey]; return n; });
    const path = TABS.find((t) => t.key === tab)!.path;
    client.get<unknown>(`${path}?${qs}`)
      .then((r) => { if (live) setData((d) => ({ ...d, [tabKey]: r })); })
      .catch((e) => {
        if (!live) return;
        const err = e as { status?: number; code?: string; message?: string };
        if (err?.status === 403 && err.code !== 'ANALYTICS_OFF') { setData((d) => ({ ...d, [tabKey]: { forbidden: err.message || 'Your role cannot see this area.' } satisfies Forbidden })); return; }
        if (err?.code === 'ANALYTICS_OFF') { fail(e); return; }
        setAreaError((a) => ({ ...a, [tabKey]: err?.message || 'This area could not be loaded.' }));
      })
      .finally(() => { if (live) setBusy(false); });
    return () => { live = false; };
  }, [tabKey, locked, retry]); // eslint-disable-line react-hooks/exhaustive-deps

  // A561: once the cloud says which areas this person sees, an area they may not open (a ?tab= link) falls back to the first
  const seen = visibleAreas(recs?.hooks, recs?.costsHidden ?? overview?.marginHidden ?? false);
  useEffect(() => { if (recs && !seen.includes(tab)) setTab(seen[0] ?? 'menu'); }, [recs, seen.join('|'), tab]); // eslint-disable-line react-hooks/exhaustive-deps

  function choose(k: PresetKey) {
    setPreset(k);
    if (k !== 'custom') { const r = presetRange(k); setRange(r); setDraft(r); }
  }
  /** A561: open an area; on the owner's page the address keeps it (?tab=), so a link or a refresh opens it again. */
  function pick(a: Tab) {
    setTab(a);
    if (ownerView && typeof window !== 'undefined') {
      try {
        const u = new URL(window.location.href);
        u.searchParams.set('tab', a);
        window.history.replaceState(window.history.state, '', `${u.pathname}${u.search}${u.hash}`);
      } catch { /* the address is a convenience only */ }
    }
  }
  /** A card's "See why": the tile with the evidence (or What sells when), scrolled into view. */
  function evidence(e: Evidence) {
    if (e === 'times') { timesRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    if (e === 'together') { togetherRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    pick(e);
    tabsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  /** A565: "What sells when at Westlands" — that branch in view (the dashboard's branch selection), then What sells when. */
  function branchTimes(id: string) {
    const b = branchCtx.branches.find((x) => x.id === id);
    if (!b) return;
    branchCtx.setActiveBranch(b);
    setTimeout(() => timesRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
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
  const days = daysBetween(range.from, range.to);
  const openTab = TABS.find((t) => t.key === tab)!;
  const tells = tab === 'menu' ? words.itemsTells : openTab.tells;   // A575: a shop's own words
  const costsHidden = recs?.costsHidden ?? overview?.marginHidden ?? false;
  const areas = visibleAreas(recs?.hooks, costsHidden);
  const forbidden = current && typeof current === 'object' && 'forbidden' in (current as object) ? (current as Forbidden).forbidden : null;
  const noCost = overview?.noCost;
  return (
    <div className="p-4 sm:p-6 space-y-5 min-w-0" data-testid="analytics-page">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-bold text-white">Analytics</h1>
          <p className="text-sm text-gray-400">
            {ownerView ? (branchCtx.activeBranch?.name ?? branchCtx.allLabel) : (branchName ?? 'Your branch')} · {fmt.dateShort(`${range.from}T12:00:00`)} – {fmt.dateShort(`${range.to}T12:00:00`)}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {ownerView && branchCtx.branches.length > 1 && (
            <label className="text-sm text-gray-400 flex items-center gap-2">
              Branch
              <select value={branch} onChange={(e) => branchCtx.setActiveBranch(branchCtx.branches.find((b) => b.id === e.target.value) ?? null)}
                className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm max-w-[12rem]" data-testid="analytics-branch">
                {(branchCtx.allowAll || branchCtx.allowMine) && <option value="">{branchCtx.allLabel}</option>}
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

      {/* 1 · 2 — the verdict and what to do next */}
      {recs ? (
        <>
          <SummarySection r={recs} p={p} />
          {noCost && noCost.share !== null && noCost.share >= 0.05 && (
            <NoCostBanner share={noCost.share} items={noCost.items} onOpen={() => evidence('costs')} />
          )}
          <DoThisNext r={recs} p={p} currency={currency} onEvidence={evidence} ownerView={ownerView} onBranchTimes={branchTimes} words={words}
            branchName={(id) => branchCtx.branches.find((b) => b.id === id)?.name ?? null} />
        </>
      ) : <p className="text-sm text-gray-500">Working out what to do next…</p>}

      {/* 3 · 5 — the KPI tiles; the trend and the payment mix come after What sells when */}
      {overview ? <KpiRow o={overview} p={p} currency={currency} words={words} />
        : <p className="text-sm text-gray-500">Working out the figures…</p>}

      {/* 4 — what sells when */}
      <section ref={timesRef} aria-label="What sells when" className="scroll-mt-4">
        {times ? <WhatSellsWhen t={times} p={p} words={words} /> : <p className="text-sm text-gray-500">Working out what sells when…</p>}
      </section>

      {/* A575 — what sells together */}
      {together && (
        <section ref={togetherRef} aria-label="What sells together" className="scroll-mt-4">
          <TogetherSection t={together} p={p} />
        </section>
      )}

      {overview && <TrendAndMix o={overview} p={p} currency={currency} />}

      {/* 6 — dig into the details: the area tiles (A561) */}
      <div ref={tabsRef} className="scroll-mt-4">
        <AreaTiles areas={areas} hooks={recs?.hooks ?? null} active={tab} onPick={pick} labels={{ menu: words.itemsArea }}
          stickyTop={ownerView ? 'top-12 md:top-0' : 'top-0'}>
          <p className="text-sm text-gray-300" data-testid="analytics-tab-tells">{tells}</p>
          {!current ? (areaError[tabKey] && !busy
              ? <div className="flex flex-wrap items-center gap-3 px-4 py-3 rounded-lg text-sm bg-red-500/10 text-red-400" data-testid="analytics-area-error">
                  <span>{areaError[tabKey]}</span>
                  <button type="button" onClick={() => setRetry((n) => n + 1)} className="px-3 py-1 rounded-lg bg-white/10 hover:bg-white/15 text-white">Retry</button>
                </div>
              : <p className="text-sm text-gray-500">Loading…</p>)
            : forbidden ? <p className="text-sm text-gray-400" data-testid="analytics-area-forbidden">{forbidden}</p>
            : tab === 'menu' ? <MenuSection m={current as MenuAnswer} p={p} currency={currency} words={words} />
            : tab === 'heatmap' ? <HeatmapSection h={current as HeatAnswer} p={p} currency={currency} />
            : tab === 'leaks' ? <LeaksSection l={current as LeaksAnswer} p={p} currency={currency} words={words} />
            : tab === 'stock' ? <StockSection s={current as StockAnswer} />
            : tab === 'customers' ? <CustomersSection c={current as CustomersAnswer} p={p} currency={currency} />
            : tab === 'costs' ? <CostsSection c={current as CostsAnswer} ownerView={ownerView} currency={currency} words={words} />
            : tab === 'branches' ? <BranchesSection b={current as BranchesAnswer} currency={currency} ownerView={ownerView} inView={branch || null} onBranchTimes={branchTimes} />
            : <CreditSection c={current as CreditAnswer} p={p} currency={currency} />}
        </AreaTiles>
      </div>
      {days > 0 && <p className="text-[11px] text-gray-500">Every figure is worked out from the sales of this period ({days} day{days === 1 ? '' : 's'}), in East Africa Time, with your day cut-off.</p>}
    </div>
  );
}

// ── 1 · How was this period? ──────────────────────────────────────────────────

const ICON = {
  up: 'M5 15l7-7 7 7',
  down: 'M19 9l-7 7-7-7',
  flat: 'M5 12h14',
  warn: 'M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z',
};
function Glyph({ d, colour, size = 18 }: { d: string; colour: string; size?: number }) {
  return (
    <span aria-hidden className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0" style={{ background: `${colour}22` }}>
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={colour} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>
    </span>
  );
}

function SummarySection({ r, p }: { r: RecAnswer; p: ChartPalette }) {
  const s = r.summary;
  const tone = s.tone === 'up' ? p.deltaGood : s.tone === 'down' ? p.deltaBad : p.muted;
  return (
    <section className="bg-gray-900 border border-gray-800 rounded-xl p-4 sm:p-5" aria-label="How was this period?" data-testid="analytics-summary">
      <p className="text-[11px] font-bold uppercase tracking-wider text-gray-500">How was this period?</p>
      <div className="flex gap-3 mt-2">
        <Glyph d={ICON[s.tone]} colour={tone} />
        <p className="text-base sm:text-lg font-semibold text-white leading-snug" data-testid="analytics-summary-good">{s.good}</p>
      </div>
      {s.worry && (
        <div className="flex gap-3 mt-3">
          <Glyph d={ICON.warn} colour={p.severity.medium} size={16} />
          <p className="text-sm sm:text-base text-gray-300 leading-snug self-center" data-testid="analytics-summary-worry">{s.worry}</p>
        </div>
      )}
    </section>
  );
}

// ── 2 · Do this next ──────────────────────────────────────────────────────────

const CONFIDENCE: Record<Recommendation['confidence'], { dots: number; label: string }> = {
  high: { dots: 3, label: 'Strong evidence' }, medium: { dots: 2, label: 'Good evidence' }, low: { dots: 1, label: 'Worth a try' },
};
const IMPACT_LABEL: Record<NonNullable<Recommendation['impactKind']>, string> = {
  gain: 'more profit', recover: 'to recover', collect: 'to collect', at_risk: 'of sales at risk if it runs out',
};
const EVIDENCE_LABEL: Record<Evidence, string> = {
  menu: 'Menu engineering', heatmap: 'Busy times', leaks: 'Money leaks', credit: 'Credit ageing', times: 'What sells when',
  stock: 'Stock', customers: 'Customers', costs: 'Costs', branches: 'Branches', together: 'What sells together',
};

function DoThisNext({ r, p, currency, onEvidence, ownerView, onBranchTimes, branchName, words }: {
  r: RecAnswer; p: ChartPalette; currency: string; onEvidence: (e: Evidence) => void; words: AnalyticsWords;
  ownerView: boolean; onBranchTimes: (branchId: string) => void; branchName: (id: string) => string | null;
}) {
  const money0 = (n: number) => fmt.money(n, currency, { decimals: 0 });
  const f = r.found;
  return (
    <section aria-label="Do this next" data-testid="analytics-do-next">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1 mb-2">
        <h2 className="text-lg font-bold text-white">Do this next</h2>
        {f.line && (
          <p className="text-sm text-gray-300" data-testid="analytics-found">
            {f.line}<span className="text-gray-500"> Estimates; each card says what it assumes.</span>
          </p>
        )}
      </div>
      {r.stockNote && <p className="text-xs text-gray-500 mb-2" data-testid="analytics-stock-note">{r.stockNote}</p>}
      {r.recommendations.length === 0 ? (
        <p className="text-sm text-gray-400 bg-gray-900 border border-gray-800 rounded-xl p-4">
          Nothing to act on yet — either all is well, or there is not enough trading in this period to be sure. Try a longer period.
        </p>
      ) : (
        <ol className="grid gap-3 md:grid-cols-2 xl:grid-cols-3" data-testid="analytics-recommendations">
          {r.recommendations.map((x, i) => {
            const c = CONFIDENCE[x.confidence];
            const st = x.stock;
            const low = (x.kind === 'stock_low' || x.kind === 'stock_out') && st ? st.items[0] : null;
            return (
              <li key={x.id} className={`bg-gray-900 border rounded-xl p-4 flex flex-col gap-2 min-w-0 ${x.warning ? 'border-amber-500/40' : 'border-gray-800'}`}
                data-kind={x.kind} data-confidence={x.confidence} data-warning={x.warning ? 'true' : undefined}>
                <div className="flex gap-3 items-start">
                  {x.warning
                    ? <span aria-label={`Number ${i + 1}, a warning`} className="flex-shrink-0"><Glyph d={ICON.warn} colour={p.severity.medium} size={15} /></span>
                    : <span className="w-7 h-7 rounded-full bg-gray-800 text-white text-sm font-bold flex items-center justify-center flex-shrink-0" aria-label={`Number ${i + 1}`}>{i + 1}</span>}
                  <div className="min-w-0">
                    {x.warning && <p className="text-[11px] font-bold uppercase tracking-wider text-amber-400">Warning · worth a look</p>}
                    <h3 className="text-base font-semibold text-white leading-snug">{x.title}</h3>
                  </div>
                </div>
                <p className="text-sm text-gray-300 leading-snug">{x.why}</p>
                <div className="mt-auto pt-1">
                  {low && st ? (
                    <p className="text-sm" data-testid="analytics-stock-plan">
                      <span className="text-gray-500">Order: </span>
                      <span className="text-lg font-bold text-white tabular-nums">≈ {fmt.qty(low.order ?? 0)} more</span>
                      <span className="text-gray-400"> to have {fmt.qty(low.qty)} {st.by === 'tomorrow' ? 'for today and tomorrow' : st.by === 'a week' ? 'for a week' : `by ${st.by}`}</span>
                    </p>
                  ) : st && st.items.length > 0 ? (
                    <p className="text-sm" data-testid="analytics-stock-plan">
                      <span className="text-gray-500">Have in for {st.by}: </span>
                      {st.items.map((s, k) => (
                        <span key={s.name} className="text-white"><span className="font-bold tabular-nums">{fmt.qty(s.qty)}</span> {s.name}{k < st.items.length - 1 ? ' · ' : ''}</span>
                      ))}
                    </p>
                  ) : null}
                  {x.impact !== null && x.impactKind ? (
                    <p className="text-sm">
                      <span className="text-gray-500">Estimate: </span>
                      <span className={`${st ? 'text-sm' : 'text-lg'} font-bold text-white tabular-nums`}>≈ {money0(x.impact)}</span>
                      <span className="text-gray-400"> {x.impactKind === 'at_risk' ? '' : x.impactPer === 'once' ? 'once ' : 'a month '}{IMPACT_LABEL[x.impactKind]}</span>
                    </p>
                  ) : x.warning ? <p className="text-sm text-gray-500">No estimate — look into it first</p>
                    : x.move ? (
                      <p className="text-sm text-gray-400" data-testid="analytics-move-plan">
                        How much to move is your call.
                        {ownerView && x.move.items.some((i) => i.kind === 'product') && (
                          <> <Link to={transferLink(x.move)} className="text-swift-text hover:underline print:hidden" data-testid="analytics-move-transfer">Start a transfer →</Link></>
                        )}
                      </p>
                    )
                    : x.kind === 'branch_drop' && x.branchId && ownerView ? (
                      <button onClick={() => onBranchTimes(x.branchId as string)} className="text-sm font-semibold text-swift-text hover:underline print:hidden text-left">
                        What sells when at {branchName(x.branchId) ?? 'that branch'} →
                      </button>
                    )
                    : st ? null : <p className="text-sm text-gray-500">No KES estimate</p>}
                  <p className="text-[11px] text-gray-500 leading-snug mt-0.5">{x.assumption}</p>
                </div>
                <div className="flex items-center justify-between gap-2 pt-2 border-t border-gray-800">
                  <span className="flex items-center gap-1.5 text-xs text-gray-400" title={`Confidence: ${c.label}`}>
                    <span aria-hidden className="flex gap-0.5">
                      {[0, 1, 2].map((k) => <span key={k} className="w-1.5 h-3 rounded-sm" style={{ background: k < c.dots ? p.ink : p.grid }} />)}
                    </span>
                    {c.label}
                  </span>
                  <button onClick={() => onEvidence(x.evidence)} className="text-xs text-swift-text hover:underline print:hidden">
                    See why · {x.evidence === 'menu' ? words.itemsArea : EVIDENCE_LABEL[x.evidence]}
                  </button>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

// ── 3 · The KPI tiles, in plain words ─────────────────────────────────────────

function KpiRow({ o, p, currency, words }: { o: OverviewAnswer; p: ChartPalette; currency: string; words: AnalyticsWords }) {
  const compare = compareWords(o.days.length);
  const money0 = (n: number | null) => fmt.money(n, currency, { decimals: 0, blank: '—' });
  const k = o.kpis;
  const left = per100(k.margin?.value);
  const cur = currency || 'KES';
  return (
    <section aria-label="The numbers" className={`grid grid-cols-1 min-[420px]:grid-cols-2 sm:grid-cols-3 gap-2 ${k.margin ? 'lg:grid-cols-5' : 'lg:grid-cols-4'}`} data-testid="analytics-kpis">
      <KpiTile label="Sales" value={money0(k.revenue.value)} change={k.revenue.change} upIsGood compare={compare}
        explain="Everything you rang up in the period, before refunds." spark={o.days.map((d) => d.revenue)} p={p} testId="kpi-revenue" />
      <KpiTile label="Bills" value={fmt.num(k.orders.value ?? 0)} change={k.orders.change} upIsGood compare={compare}
        explain="How many sales were paid — one per table or customer." p={p} testId="kpi-orders" />
      <KpiTile label="Average bill" value={money0(k.avgBill.value)} change={k.avgBill.change} upIsGood compare={compare}
        explain="What one customer spends per visit, on average." p={p} testId="kpi-avg-bill" />
      {k.margin && (
        <KpiTile label="Gross margin" value={pct(k.margin.value)} change={k.margin.change} upIsGood points compare={compare}
          explain={left === null ? `Set costs on your items to see what is left after ${words.costOf}.`
            : `Of every ${cur} 100 sold, ${cur} ${left} is left after ${words.costOf} (items with a cost set).`} p={p} testId="kpi-margin" />
      )}
      <KpiTile label="Money at risk" value={money0(k.atRisk.value)} change={k.atRisk.change} upIsGood={false} compare={compare}
        explain={`${o.wastageHidden ? 'Voids, refunds and discounts' : 'Voids, refunds, discounts and wastage'} — money that left without a sale.`} p={p} testId="kpi-at-risk" />
    </section>
  );
}

// ── 4 · What sells when ───────────────────────────────────────────────────────

const PART_WORD: Record<DaypartKey, string> = { morning: 'in the morning', lunch: 'at lunch', afternoon: 'in the afternoon', evening: 'in the evening', late: 'late at night' };

function WhatSellsWhen({ t, p, words }: { t: TimesAnswer; p: ChartPalette; words: AnalyticsWords }) {
  const food = words.costOfSales === 'Food cost';   // A575: a shop stocks, it does not prep
  const [pick, setPick] = useState<string>('');
  if (!t.items.length) return null;
  const chosen = t.items.find((i) => (i.productId ?? `name:${i.name}`) === pick) ?? t.items[0];
  const parts = t.dayparts.filter((d) => d.qty > 0);
  const best = chosen.bestDaypart ? t.dayparts.find((d) => d.key === chosen.bestDaypart) : null;
  const todayName = new Date().toLocaleDateString('en-GB', { weekday: 'long' });   // A572: today's card is ringed
  return (
    <div className="space-y-4" data-testid="analytics-times">
      <div>
        <h2 className="text-lg font-bold text-white">What sells when</h2>
        <p className="text-sm text-gray-400">By the hour it was rung, every day of the period added together — so you know what to {food ? 'prep, push and stock' : 'push and stock'} for each part of the day.</p>
      </div>

      {/* (a) the dayparts' top 5 */}
      <div className={`grid gap-2 grid-cols-1 min-[420px]:grid-cols-2 ${parts.length >= 5 ? 'lg:grid-cols-5' : parts.length === 4 ? 'lg:grid-cols-4' : 'lg:grid-cols-3'}`} data-testid="analytics-dayparts">
        {parts.map((d) => (
          <div key={d.key} className="bg-gray-900 border border-gray-800 rounded-xl p-3 min-w-0" data-daypart={d.key}>
            <p className="text-sm font-semibold text-white">What sells {PART_WORD[d.key]}</p>
            <p className="text-[11px] text-gray-500 mb-2">{hh(d.from)}–{hh(d.to)} · {Math.round(d.share * 100)}% of everything sold</p>
            <ShareList items={d.top.map((x) => ({ key: x.productId ?? x.name, name: x.name, share: x.share }))} p={p} />
          </div>
        ))}
      </div>

      {/* A560: the week at a glance — each weekday's top 3 with its typical sales */}
      {t.week && t.week.some((d) => d.top.length > 0) && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-3 sm:p-4" data-testid="analytics-week">
          <p className="text-sm font-semibold text-white">Your week at a glance — what to {food ? 'prepare' : 'stock'} each day</p>
          <p className="text-xs text-gray-500 mb-3">The top 3 on each day of the week, with what a typical one sells</p>
          {/* A572 (owner: "the cards are small, reading them is a bit hard"): body-size text, the whole item name (two
              lines before it clips), the count in its own column; 7 across only on a very wide screen, stacked on a phone */}
          <ol className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 min-[1800px]:grid-cols-7 gap-3">
            {t.week.map((d) => {
              const today = d.day === todayName;
              return (
                <li key={d.dow} className={`bg-gray-800/60 rounded-lg p-3 min-w-0 ${today ? 'ring-1 ring-swift' : ''}`} data-day={d.day} data-today={today || undefined}>
                  <p className="text-sm font-bold text-white">{d.day}{today && <span className="ml-2 text-xs font-semibold text-swift-text">Today</span>}</p>
                  {d.top.length === 0 ? <p className="text-sm text-gray-500 mt-1">No sales</p> : (
                    <ul className="mt-2 space-y-2">
                      {d.top.map((x) => (
                        <li key={x.productId ?? x.name} className="flex items-start justify-between gap-3 text-sm leading-snug">
                          <span className="text-gray-200 min-w-0 line-clamp-2 break-words" title={x.name}>{x.name}</span>
                          <span className="text-white font-semibold tabular-nums flex-shrink-0">{fmt.qty(x.qty)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ol>
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-5">
        {/* (b) one item's own grid */}
        <div className="xl:col-span-3 min-w-0">
          <ChartCard title={`When does ${chosen.name} sell?`}
            sub={chosen.peak ? `Most on ${chosen.peak.day} ${hh(chosen.peak.hour)}–${hh(chosen.peak.hour + 1)}${best && chosen.bestDaypartShare ? `; ${Math.round(chosen.bestDaypartShare * 100)}% of it sells ${PART_WORD[best.key]}` : ''}. ${fmt.qty(chosen.qty)} sold in the period.` : undefined}
            legend={(
              <label className="text-xs text-gray-400 flex items-center gap-2 print:hidden">
                Item
                <select value={chosen.productId ?? `name:${chosen.name}`} onChange={(e) => setPick(e.target.value)} data-testid="analytics-item-pick"
                  className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-white text-sm max-w-[14rem]">
                  {t.items.map((i) => <option key={i.productId ?? `name:${i.name}`} value={i.productId ?? `name:${i.name}`}>{i.name}</option>)}
                </select>
              </label>
            )} testId="analytics-item-card">
            <ItemHeatmap cells={chosen.cells} name={chosen.name} p={p} />
            {t.cutoff > 0 && <p className="text-[11px] text-gray-500 mt-2">A sale after midnight counts on the day before, as your business day ends at {`${String(Math.floor(t.cutoff / 60)).padStart(2, '0')}:${String(t.cutoff % 60).padStart(2, '0')}`}.</p>}
            {t.limited && <p className="text-[11px] text-gray-500 mt-1">The list holds your {t.items.length} best sellers; every share counts everything sold.</p>}
          </ChartCard>
        </div>

        {/* (c) every hour's top 3 */}
        <div className="xl:col-span-2 min-w-0">
          <ChartCard title="The top 3 at every hour" sub="Have these ready before the hour starts" testId="analytics-hour-grid">
            <ul className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-1 gap-x-4 gap-y-1.5 text-sm">
              {t.hours.map((h) => (
                <li key={h.hour} className="flex gap-2 min-w-0">
                  <span className="text-white font-semibold tabular-nums w-11 flex-shrink-0">{h.label}</span>
                  <span className="text-gray-300 truncate" title={h.top.map((x) => `${x.name} ${Math.round(x.share * 100)}%`).join(' · ')}>
                    {h.top.map((x) => x.name).join(' · ')}
                  </span>
                </li>
              ))}
            </ul>
          </ChartCard>
        </div>
      </div>
    </div>
  );
}

// ── 5 · Daily sales and the payment mix ───────────────────────────────────────

function TrendAndMix({ o, p, currency }: { o: OverviewAnswer; p: ChartPalette; currency: string }) {
  const traded = o.days.some((d) => d.revenue > 0 || d.prevRevenue > 0);
  const compare = compareWords(o.days.length);
  return (
    <div className="grid gap-4 lg:grid-cols-3" data-testid="analytics-overview">
      <div className="lg:col-span-2 min-w-0">
        <ChartCard title="Daily sales" sub={`Each day against ${compare} (${fmt.dateShort(`${o.previous.from}T12:00:00`)} – ${fmt.dateShort(`${o.previous.to}T12:00:00`)})`}
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
  );
}

// ── Menu engineering ──────────────────────────────────────────────────────────

type SortKey = 'name' | 'qty' | 'revenue' | 'unitCost' | 'unitMargin' | 'totalMargin' | 'share' | 'class';
const SORT_WORD: Record<SortKey, string> = {
  name: 'by name', qty: 'by quantity sold', revenue: 'by revenue', unitCost: 'by unit cost', unitMargin: 'by unit margin',
  totalMargin: 'by total margin', share: 'by share', class: 'by class',
};

function MenuSection({ m, p, currency, words }: { m: MenuAnswer; p: ChartPalette; currency: string; words: AnalyticsWords }) {
  // A558: the top 10 by the column that matters for the decision — what the item brings in (total margin with costs,
  // else revenue); the headers still sort, the cap stays 10
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: m.costsHidden ? 'revenue' : 'totalMargin', desc: true });
  const sorted = useMemo(() => {
    const v = (i: MenuItem): number | string => sort.key === 'name' ? i.name.toLowerCase() : sort.key === 'class' ? (i.class ?? '') : (i[sort.key] ?? -Infinity);
    return [...m.items].sort((a, b) => { const x = v(a), y = v(b); const c = x < y ? -1 : x > y ? 1 : 0; return sort.desc ? -c : c; });
  }, [m.items, sort]);
  const cap = capRows(sorted, TABLE_ROWS);
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
              <p className="text-[11px] text-gray-500 leading-snug">{CLASS_META[k].hint}</p>
            </div>
          ))}
        </div>
      )}
      <div className="grid gap-4 xl:grid-cols-5">
        {hasMatrix ? (
          <div className="xl:col-span-3 min-w-0">
            <ChartCard title={words.matrix} sub="Popularity across, margin a unit up; bubble size = revenue"
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
          average margin per item sold, {fmt.money(m.avgUnitMargin ?? 0, currency)}. Margin = average selling price − {words.unitCost}.
        </p>
      )}
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden" data-testid="analytics-menu-table">
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
            {cap.rows.map((i) => (
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
        <CapNote shown={cap.rows.length} total={cap.total} by={SORT_WORD[sort.key]} />
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
        <Card label="Busiest two hours — staff up" value={h.busiest?.label ?? '—'} sub={h.busiest ? `${fmt.money(h.busiest.revenue, currency)} · ${h.busiest.orders} orders` : undefined} />
        <Card label="Quietest two hours — run an offer" value={h.quietest?.label ?? '—'} sub={h.quietest ? `${fmt.money(h.quietest.revenue, currency)} · ${h.quietest.orders} orders` : undefined} />
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

const dayLeak = (d: DayLeak) => d.voidValue + d.itemVoidValue + d.refundValue + d.discountValue + (d.wastageValue ?? 0) + Math.max(0, -d.dayCloseVariance);

function LeaksSection({ l, p, currency, words }: { l: LeaksAnswer; p: ChartPalette; currency: string; words: AnalyticsWords }) {
  const m = (n: number | null) => fmt.money(n, currency, { blank: '—' });
  const variance = (n: number) => <span className={n < 0 ? 'text-red-400' : n > 0 ? 'text-amber-400' : 'text-gray-500'}>{fmt.money(n, currency, { sign: true })}</span>;
  const flagged = l.cashiers.filter((c) => c.flags.length);
  const split = [
    { key: 'voids', label: 'Voids', value: l.totals.voidValue + l.totals.itemVoidValue, colour: p.leaks.voids },
    { key: 'refunds', label: 'Refunds', value: l.totals.refundValue, colour: p.leaks.refunds },
    { key: 'discounts', label: 'Discounts', value: l.totals.discountValue, colour: p.leaks.discounts },
    ...(l.wastageHidden ? [] : [{ key: 'wastage', label: 'Wastage', value: l.totals.wastageValue ?? 0, colour: p.leaks.wastage }]),
  ];
  // A558: the top 10 — cashiers flagged first, then by what went through their hands (the cloud's order); days by what
  // the day lost (voids, refunds, discounts, wastage and a short day close)
  const cashiers = capRows(l.cashiers, TABLE_ROWS);
  const days = capRows([...l.days].filter((d) => dayLeak(d) > 0).sort((a, b) => dayLeak(b) - dayLeak(a) || a.day.localeCompare(b.day)), TABLE_ROWS);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Card label="Voids" value={m(l.totals.voidValue + l.totals.itemVoidValue)} sub={`${l.totals.voids} orders · ${l.totals.itemVoids} ${words.removedItems}`} />
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
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden" data-testid="analytics-leak-cashiers">
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
            {cashiers.rows.map((c) => {
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
        <CapNote shown={cashiers.rows.length} total={cashiers.total} by="flagged first, then by the money through their hands" />
      </div>
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden" data-testid="analytics-leak-days">
        <h3 className="px-3 pt-3 text-sm font-semibold text-white">The days that lost the most</h3>
        {days.rows.length === 0 ? <p className="p-3 text-sm text-gray-500">No day lost money to voids, refunds, discounts or a short close.</p> : (
          <div className="overflow-x-auto"><table className="w-full text-sm">
            <thead><tr className="text-gray-500 text-left text-xs border-b border-gray-800">
              <th className="p-2 font-medium">Day</th><th className={`p-2 font-medium text-right ${DESK}`}>Orders</th>
              <th className="p-2 font-medium text-right">Voids</th><th className={`p-2 font-medium text-right ${DESK}`}>Refunds</th>
              <th className={`p-2 font-medium text-right ${DESK}`}>Discounts</th><th className={`p-2 font-medium text-right ${DESK}`}>Wastage</th>
              <th className="p-2 font-medium text-right">Day close ±</th>
            </tr></thead>
            <tbody>
              {days.rows.map((d) => (
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
        )}
        <CapNote shown={days.rows.length} total={days.total} by="by what the day lost" />
      </div>
      <p className="text-xs text-gray-500">{words.voidsNote} Refunds count on the day they were given, against the cashier of the sale. Drawer ± is the cashier's shift count; day close ± the POS's day close (over +, short −).</p>
    </div>
  );
}

// ── Credit ageing ─────────────────────────────────────────────────────────────

function CreditSection({ c, p, currency }: { c: CreditAnswer; p: ChartPalette; currency: string }) {
  const m = (n: number) => (n ? fmt.money(n, currency) : '—');
  if (!c.customers.length) return <p className="text-sm text-gray-500">Nobody owes on credit.</p>;
  // A558: the top 10 — the oldest debt first (over 60 days), then what is owed (the cloud's order)
  const rows = capRows(c.customers, TABLE_ROWS);
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
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden" data-testid="analytics-credit-table">
        <div className="overflow-x-auto"><table className="w-full text-sm">
          <thead><tr className="text-gray-500 text-left text-xs border-b border-gray-800">
            <th className="p-2 font-medium">Customer</th><th className="p-2 font-medium text-right">Owed</th>
            <th className={`p-2 font-medium text-right ${DESK}`}>0–30</th><th className={`p-2 font-medium text-right ${DESK}`}>31–60</th>
            <th className={`p-2 font-medium text-right ${DESK}`}>61–90</th><th className="p-2 font-medium text-right">90+</th>
            <th className={`p-2 font-medium text-right ${DESK}`}>Disputed</th>
          </tr></thead>
          <tbody>
            {rows.rows.map((r) => (
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
        <CapNote shown={rows.rows.length} total={rows.total} by="the oldest debt first, then by what is owed" />
      </div>
      <p className="text-xs text-gray-500">
        As of {fmt.dateTime(c.asOf)}. The balance is the customer's credit account; repayments clear the oldest sales first, so what
        is still owed is the newest sales. A balance older than the account's history counts as over 90 days. Disputed: sales a
        manager disputed (still owed until voided or refunded).
      </p>
    </div>
  );
}
