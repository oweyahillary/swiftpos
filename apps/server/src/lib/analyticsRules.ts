/**
 * analyticsRules.ts — A549 (Analytics v1, premium): the pure rules behind /api/analytics. No database here: the four
 * aggregate functions of migration 158 hand over a few hundred grouped rows; these functions classify, summarise and
 * write the plain-English insights, so the tests can run every rule directly.
 *
 *   Menu engineering — the standard matrix. Popularity is HIGH when a product's share of the quantity sold is at least
 *     70% of an even share (1/N × 0.7, N = the products sold). Margin is HIGH when its unit margin (average selling price
 *     − the cost of one serving) is at least the QUANTITY-WEIGHTED average unit margin of the costed products. Star
 *     (high, high) · Plowhorse (popular, low margin) · Puzzle (unpopular, high margin) · Dog (low, low). A product with no
 *     cost set is listed as "no cost set" and not classified (it still counts in N and in the popularity shares).
 *   Heatmap — revenue and orders by weekday × hour (East Africa Time); the busiest and quietest TWO-HOUR slots inside
 *     the trading hours (the first to the last hour with a sale), on the days that traded.
 *   Money leaks — per cashier and per business day. A cashier is FLAGGED when their void rate (voided orders + kitchen
 *     item voids, over the orders they rang) or discount rate (discounted orders over their completed orders) is at
 *     least 2× the median of the cashiers in view, with at least 5 such events and a rate above zero.
 *   Credit ageing — totals per bucket (0–30, 31–60, 61–90, 90+ days) from the ledger allocation of migration 158.
 *   Insights — short sentences from fixed rules (no AI), each with a type and a severity so the page can sort them.
 *   A558 — what sells when (each product by business weekday × hour; the dayparts' top 5, each hour's top 3), the
 *     "Do this next" recommendations (rules only, each with a KES estimate a month or once and the assumption it rests
 *     on, ranked by the KES at stake; none without enough data; none that tells a margin to someone who may not see
 *     costs) and the one- or two-sentence "How was this period?" summary.
 *   A560 — never a price rise (the owner: prices must stay competitive). What to stock instead: "Stock up for Friday"
 *     (an item's typical Friday at least 1.5× its average day), "Order more before Friday" (the cloud's stock level below
 *     what sells until the end of its next busy day), the week at a glance (each weekday's top 3) and the slow movers. A
 *     cashier's voids or discounts are a warning to look into, with no KES estimate and out of the value line.
 *   A561 — how fast stock goes (use a day, days left at one branch, the wastage share; "runs out in about 2 days — order
 *     now"), who comes back (new and returning, the top spenders, regulars gone quiet, the order-type mix), what each
 *     sale really earns (food cost, the thinnest margins, ingredient cost rises — never a price rise) and the items with
 *     no cost; the analytics tiles' one-line hooks.
 *   A565 — between branches (a viewer who sees every branch, two or more branches): which stock to move from a branch
 *     where it sits to one where it runs low — worked out in units to decide and rank, shown as a plain recommendation
 *     with no quantity and no KES (the owner's call) — and the branches side by side, a branch flagged when its sales fall
 *     against its own previous period more than the other branches'.
 *   A575 — what sells together (migration 164's analytics_together: the product pairs found in the same order): the
 *     pairs in plain words ("People who buy Chicken Wrap often add Soda 500ml (38 of 120 orders)"), ranked by how much
 *     more often than chance they go together, the top 10; one or two "Do this next" cards in the business's own way of
 *     selling (lib/analyticsTerms.ts togetherAdvice: a combo, the same shelf, at the pumps) — never a price, no KES. And
 *     the business type's words on the cards (a shop's "cost of sales", never its "food cost").
 */
import { togetherAdvice, analyticsWords, type TogetherAdvice } from './analyticsTerms';

export const ANALYTICS_FLAG = 'analytics';
export const ANALYTICS_OFF_MESSAGE = 'Analytics is part of ZapTill Premium — contact ZapTill to enable it.';
export const MAX_RANGE_DAYS = 366;
export const DEFAULT_RANGE_DAYS = 30;
export const POPULARITY_FACTOR = 0.7;
export const FLAG_MULTIPLE = 2;
export const FLAG_MIN_EVENTS = 5;

const DAY_MS = 86_400_000;
export const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;

const r2 = (n: number) => Math.round(n * 100) / 100;
const r4 = (n: number) => Math.round(n * 10000) / 10000;
const n0 = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

// ── Range ─────────────────────────────────────────────────────────────────────

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
function dayNumber(s: string): number | null {
  if (!ISO_DATE.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) return null;
  return t / DAY_MS;
}

/** The days a range covers (both ends included), or null when either end is not a real YYYY-MM-DD. */
export function rangeDays(from: string, to: string): number | null {
  const a = dayNumber(from), b = dayNumber(to);
  return a === null || b === null ? null : b - a + 1;
}

/** Why a requested period is refused (400), or null. At most 366 days, from on or before to. */
export function rangeError(from: string, to: string): { error: string; code: string } | null {
  const days = rangeDays(from, to);
  if (days === null) return { error: 'from and to must be dates (YYYY-MM-DD).', code: 'BAD_RANGE' };
  if (days < 1) return { error: 'from must be on or before to.', code: 'BAD_RANGE' };
  if (days > MAX_RANGE_DAYS) return { error: `Choose a period of at most ${MAX_RANGE_DAYS} days.`, code: 'RANGE_TOO_LONG' };
  return null;
}

/** The last 30 business days up to `today` (YYYY-MM-DD) — the period when none is asked. */
export function defaultRange(today: string): { from: string; to: string } {
  const t = (dayNumber(today) ?? Math.floor(Date.now() / DAY_MS)) * DAY_MS;
  return { from: new Date(t - (DEFAULT_RANGE_DAYS - 1) * DAY_MS).toISOString().slice(0, 10), to: new Date(t).toISOString().slice(0, 10) };
}

// ── Menu engineering ──────────────────────────────────────────────────────────

export interface MenuRow {
  product_id: string | null; product_name: string | null; category_name: string | null;
  qty: number | string; revenue: number | string; unit_cost: number | string | null; cost_source: string | null;
}
export type MenuClass = 'star' | 'plowhorse' | 'puzzle' | 'dog' | 'no_cost';
export interface MenuItem {
  productId: string | null; name: string; category: string | null;
  qty: number; revenue: number; avgPrice: number; share: number; rank: number; popular: boolean;
  unitCost: number | null; costSource: string | null; unitMargin: number | null; totalMargin: number | null;
  highMargin: boolean | null; class: MenuClass | null;
}
export interface MenuResult {
  items: MenuItem[];
  /** The share of the quantity sold at which a product counts as popular (0.7 / N). */
  popularityThreshold: number;
  /** The quantity-weighted average unit margin of the costed products (null when none has a cost). */
  avgUnitMargin: number | null;
  counts: Record<MenuClass, number>;
  totals: { items: number; qty: number; revenue: number; margin: number | null };
  costsHidden: boolean;
}

export function classifyMenu(rows: MenuRow[]): MenuResult {
  const sold = (rows ?? []).map((r) => ({ ...r, qty: n0(r.qty), revenue: n0(r.revenue), cost: r.unit_cost === null || r.unit_cost === undefined ? null : n0(r.unit_cost) }))
    .filter((r) => r.qty > 0);
  const totalQty = sold.reduce((s, r) => s + r.qty, 0);
  const N = sold.length;
  const threshold = N ? POPULARITY_FACTOR / N : 0;
  const costed = sold.filter((r) => r.cost !== null);
  const costedQty = costed.reduce((s, r) => s + r.qty, 0);
  const totalMargin = costed.reduce((s, r) => s + (r.revenue - (r.cost as number) * r.qty), 0);
  const avg = costedQty > 0 ? totalMargin / costedQty : null;
  const byQty = [...sold].sort((a, b) => b.qty - a.qty || b.revenue - a.revenue);
  const counts: Record<MenuClass, number> = { star: 0, plowhorse: 0, puzzle: 0, dog: 0, no_cost: 0 };
  const items: MenuItem[] = byQty.map((r, i) => {
    const share = totalQty > 0 ? r.qty / totalQty : 0;
    const popular = share >= threshold - 1e-12;
    const avgPrice = r.revenue / r.qty;
    const unitMargin = r.cost === null ? null : avgPrice - r.cost;
    const highMargin = unitMargin === null || avg === null ? null : unitMargin >= avg - 1e-9;
    const cls: MenuClass = highMargin === null ? 'no_cost'
      : popular ? (highMargin ? 'star' : 'plowhorse') : (highMargin ? 'puzzle' : 'dog');
    counts[cls] += 1;
    return {
      productId: r.product_id, name: r.product_name || 'Unnamed item', category: r.category_name, qty: r4(r.qty),
      revenue: r2(r.revenue), avgPrice: r2(avgPrice), share: r4(share), rank: i + 1, popular,
      unitCost: r.cost === null ? null : r2(r.cost), costSource: r.cost_source, unitMargin: unitMargin === null ? null : r2(unitMargin),
      totalMargin: unitMargin === null ? null : r2(unitMargin * r.qty), highMargin, class: cls,
    };
  });
  return {
    items, popularityThreshold: r4(threshold), avgUnitMargin: avg === null ? null : r2(avg), counts,
    totals: { items: N, qty: r4(totalQty), revenue: r2(sold.reduce((s, r) => s + r.revenue, 0)), margin: costed.length ? r2(totalMargin) : null },
    costsHidden: false,
  };
}

/** A490: the same answer with every cost, margin and the classes (which tell the margin) removed. */
export function menuWithoutCosts(m: MenuResult): MenuResult {
  return {
    ...m, avgUnitMargin: null, totals: { ...m.totals, margin: null }, costsHidden: true,
    counts: { star: 0, plowhorse: 0, puzzle: 0, dog: 0, no_cost: 0 },
    items: m.items.map((i) => ({ ...i, unitCost: null, costSource: null, unitMargin: null, totalMargin: null, highMargin: null, class: null })),
  };
}

// ── Heatmap ───────────────────────────────────────────────────────────────────

export interface HeatRow { dow: number | string; hour: number | string; revenue: number | string; orders: number | string }
export interface Slot { dow: number; day: string; startHour: number; endHour: number; label: string; revenue: number; orders: number }
export interface HeatmapResult {
  /** [weekday 0 = Monday … 6 = Sunday][hour 0 … 23] */
  revenue: number[][]; orders: number[][];
  maxRevenue: number; totalRevenue: number; totalOrders: number;
  tradingHours: { from: number; to: number } | null;
  busiest: Slot | null; quietest: Slot | null;
}

const hh = (h: number) => `${String(h % 24).padStart(2, '0')}:00`;
export const slotLabel = (dow: number, start: number, end: number) => `${WEEKDAYS[dow]} ${hh(start)}–${hh(end)}`;

export function summariseHeatmap(rows: HeatRow[]): HeatmapResult {
  const revenue = Array.from({ length: 7 }, () => Array(24).fill(0) as number[]);
  const orders = Array.from({ length: 7 }, () => Array(24).fill(0) as number[]);
  for (const r of rows ?? []) {
    const d = n0(r.dow) - 1, h = n0(r.hour);   // ISO weekday 1 (Monday) … 7 (Sunday)
    if (d < 0 || d > 6 || h < 0 || h > 23) continue;
    revenue[d][h] += n0(r.revenue);
    orders[d][h] += n0(r.orders);
  }
  let lo = 24, hi = -1, max = 0, tr = 0, to = 0;
  for (let d = 0; d < 7; d++) for (let h = 0; h < 24; h++) {
    revenue[d][h] = r2(revenue[d][h]);
    if (orders[d][h] > 0) { lo = Math.min(lo, h); hi = Math.max(hi, h); }
    max = Math.max(max, revenue[d][h]); tr += revenue[d][h]; to += orders[d][h];
  }
  let busiest: Slot | null = null, quietest: Slot | null = null;
  if (hi >= 0) {
    const width = hi > lo ? 2 : 1;
    for (let d = 0; d < 7; d++) {
      if (!orders[d].some((x) => x > 0)) continue;   // a day the business did not trade (closed) is not "quiet"
      for (let h = lo; h + width - 1 <= hi; h++) {
        let rev = 0, ord = 0;
        for (let k = 0; k < width; k++) { rev += revenue[d][h + k]; ord += orders[d][h + k]; }
        const slot: Slot = { dow: d, day: WEEKDAYS[d], startHour: h, endHour: h + width, label: slotLabel(d, h, h + width), revenue: r2(rev), orders: ord };
        if (!busiest || rev > busiest.revenue) busiest = slot;
        if (!quietest || rev < quietest.revenue) quietest = slot;
      }
    }
  }
  return { revenue, orders, maxRevenue: max, totalRevenue: r2(tr), totalOrders: to, tradingHours: hi >= 0 ? { from: lo, to: hi } : null, busiest, quietest };
}

// ── Money leaks ───────────────────────────────────────────────────────────────

export interface LeakRow {
  by_cashier: boolean; cashier_id: string | null; day: string | null;
  orders: number | string; voids: number | string; void_value: number | string; item_voids: number | string; item_void_value: number | string;
  refunds: number | string; refund_value: number | string; discounts: number | string; discount_value: number | string;
  wastage: number | string; wastage_value: number | string; drawer_variance: number | string; day_close_variance: number | string;
}
export interface LeakFlag { kind: 'void' | 'discount'; rate: number; median: number; multiple: number | null; events: number }
interface LeakFigures {
  orders: number; voids: number; voidValue: number; itemVoids: number; itemVoidValue: number; refunds: number; refundValue: number;
  discounts: number; discountValue: number; wastage: number; wastageValue: number | null;
}
export interface CashierLeak extends LeakFigures {
  cashierId: string | null; name: string; voidEvents: number; voidRate: number | null; discountRate: number | null;
  drawerVariance: number; flags: LeakFlag[];
}
export interface DayLeak extends LeakFigures { day: string; dayCloseVariance: number; drawerVariance: number }
export interface LeaksResult {
  cashiers: CashierLeak[]; days: DayLeak[];
  medians: { voidRate: number | null; discountRate: number | null };
  totals: LeakFigures & { dayCloseShort: number; dayCloseOver: number; drawerVariance: number };
  wastageHidden: boolean;
}

/** The median of the numbers (the mean of the middle two for an even count); null for none. */
export function median(xs: number[]): number | null {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** The flag rule: at least FLAG_MIN_EVENTS events, a rate above zero, and at least FLAG_MULTIPLE × the median. */
export function leakFlag(kind: LeakFlag['kind'], rate: number | null, events: number, med: number | null): LeakFlag | null {
  if (rate === null || med === null || events < FLAG_MIN_EVENTS || rate <= 0) return null;
  if (rate < FLAG_MULTIPLE * med - 1e-12) return null;
  return { kind, rate: r4(rate), median: r4(med), multiple: med > 0 ? Math.round((rate / med) * 10) / 10 : null, events };
}

function figures(r: LeakRow): LeakFigures {
  return {
    orders: n0(r.orders), voids: n0(r.voids), voidValue: r2(n0(r.void_value)), itemVoids: n0(r.item_voids), itemVoidValue: r2(n0(r.item_void_value)),
    refunds: n0(r.refunds), refundValue: r2(n0(r.refund_value)), discounts: n0(r.discounts), discountValue: r2(n0(r.discount_value)),
    wastage: n0(r.wastage), wastageValue: r2(n0(r.wastage_value)),
  };
}

export function summariseLeaks(rows: LeakRow[], names: Record<string, string>): LeaksResult {
  const cashierRows = (rows ?? []).filter((r) => r.by_cashier);
  const dayRows = (rows ?? []).filter((r) => !r.by_cashier && r.day);
  const cashiers: CashierLeak[] = cashierRows.map((r) => {
    const f = figures(r);
    const voidEvents = f.voids + f.itemVoids;
    const completed = f.orders - f.voids;
    return {
      ...f, cashierId: r.cashier_id, name: r.cashier_id ? (names[r.cashier_id] ?? 'Unknown staff') : 'Not attributed',
      voidEvents, voidRate: f.orders > 0 ? voidEvents / f.orders : null, discountRate: completed > 0 ? f.discounts / completed : null,
      drawerVariance: r2(n0(r.drawer_variance)), flags: [],
    };
  });
  // the medians over the people who rang sales (the unattributed bucket is not a cashier)
  const people = cashiers.filter((c) => c.cashierId);
  const medVoid = median(people.map((c) => c.voidRate).filter((x): x is number => x !== null));
  const medDisc = median(people.map((c) => c.discountRate).filter((x): x is number => x !== null));
  for (const c of people) {
    const v = leakFlag('void', c.voidRate, c.voidEvents, medVoid);
    const d = leakFlag('discount', c.discountRate, c.discounts, medDisc);
    if (v) c.flags.push(v);
    if (d) c.flags.push(d);
  }
  for (const c of cashiers) {
    if (c.voidRate !== null) c.voidRate = r4(c.voidRate);
    if (c.discountRate !== null) c.discountRate = r4(c.discountRate);
  }
  cashiers.sort((a, b) => b.flags.length - a.flags.length || (b.voidValue + b.itemVoidValue + b.refundValue + b.discountValue)
    - (a.voidValue + a.itemVoidValue + a.refundValue + a.discountValue) || a.name.localeCompare(b.name));
  const days: DayLeak[] = dayRows.map((r) => ({ ...figures(r), day: String(r.day).slice(0, 10), dayCloseVariance: r2(n0(r.day_close_variance)), drawerVariance: r2(n0(r.drawer_variance)) }))
    .sort((a, b) => a.day.localeCompare(b.day));
  const sum = (k: keyof LeakFigures) => r2(days.reduce((s, d) => s + (Number(d[k]) || 0), 0));
  return {
    cashiers, days,
    medians: { voidRate: medVoid === null ? null : r4(medVoid), discountRate: medDisc === null ? null : r4(medDisc) },
    totals: {
      orders: sum('orders'), voids: sum('voids'), voidValue: sum('voidValue'), itemVoids: sum('itemVoids'), itemVoidValue: sum('itemVoidValue'),
      refunds: sum('refunds'), refundValue: sum('refundValue'), discounts: sum('discounts'), discountValue: sum('discountValue'),
      wastage: sum('wastage'), wastageValue: sum('wastageValue'),
      dayCloseShort: r2(days.reduce((s, d) => s + Math.min(0, d.dayCloseVariance), 0)),
      dayCloseOver: r2(days.reduce((s, d) => s + Math.max(0, d.dayCloseVariance), 0)),
      drawerVariance: r2(days.reduce((s, d) => s + d.drawerVariance, 0)),
    },
    wastageHidden: false,
  };
}

/** A490: wastage is valued at cost — removed for a caller who may not see costs (the count stays). */
export function leaksWithoutWastageValue(l: LeaksResult): LeaksResult {
  return {
    ...l, wastageHidden: true, totals: { ...l.totals, wastageValue: null },
    cashiers: l.cashiers.map((c) => ({ ...c, wastageValue: null })), days: l.days.map((d) => ({ ...d, wastageValue: null })),
  };
}

// ── Credit ageing ─────────────────────────────────────────────────────────────

export interface CreditRow {
  customer_id: string; customer_name: string | null; phone: string | null; balance: number | string; owed: number | string;
  d0_30: number | string; d31_60: number | string; d61_90: number | string; d90_plus: number | string; unaged: number | string;
  oldest_at: string | null; disputed_count: number | string; disputed_amount: number | string;
}
export interface CreditCustomer {
  customerId: string; name: string; phone: string | null; balance: number; owed: number;
  d0_30: number; d31_60: number; d61_90: number; d90_plus: number; unaged: number; oldestAt: string | null;
  disputedCount: number; disputedAmount: number;
}
export interface CreditResult {
  customers: CreditCustomer[];
  totals: { customers: number; owed: number; d0_30: number; d31_60: number; d61_90: number; d90_plus: number; disputedCount: number; disputedAmount: number };
  over60: { amount: number; customers: number };
}

export function summariseCredit(rows: CreditRow[]): CreditResult {
  const customers: CreditCustomer[] = (rows ?? []).map((r) => ({
    customerId: r.customer_id, name: r.customer_name || 'Unnamed customer', phone: r.phone ?? null, balance: r2(n0(r.balance)), owed: r2(n0(r.owed)),
    d0_30: r2(n0(r.d0_30)), d31_60: r2(n0(r.d31_60)), d61_90: r2(n0(r.d61_90)), d90_plus: r2(n0(r.d90_plus)), unaged: r2(n0(r.unaged)),
    oldestAt: r.oldest_at ?? null, disputedCount: n0(r.disputed_count), disputedAmount: r2(n0(r.disputed_amount)),
  })).sort((a, b) => (b.d61_90 + b.d90_plus) - (a.d61_90 + a.d90_plus) || b.owed - a.owed || a.name.localeCompare(b.name));
  const sum = (k: 'owed' | 'd0_30' | 'd31_60' | 'd61_90' | 'd90_plus' | 'disputedCount' | 'disputedAmount') => r2(customers.reduce((s, c) => s + c[k], 0));
  const old = customers.filter((c) => c.d61_90 + c.d90_plus > 0);
  return {
    customers,
    totals: { customers: customers.filter((c) => c.owed > 0).length, owed: sum('owed'), d0_30: sum('d0_30'), d31_60: sum('d31_60'), d61_90: sum('d61_90'), d90_plus: sum('d90_plus'), disputedCount: sum('disputedCount'), disputedAmount: sum('disputedAmount') },
    over60: { amount: r2(old.reduce((s, c) => s + c.d61_90 + c.d90_plus, 0)), customers: old.length },
  };
}

// ── Insights ──────────────────────────────────────────────────────────────────

export type InsightType = 'menu' | 'timing' | 'leaks' | 'credit';
export type Severity = 'high' | 'medium' | 'low';
export interface Insight { id: string; type: InsightType; severity: Severity; text: string }
export interface InsightInput {
  menu: MenuResult | null; heatmap: HeatmapResult | null; leaks: LeaksResult | null; credit: CreditResult | null; currency?: string;
}

const SEVERITY_ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
const TYPE_ORDER: Record<InsightType, number> = { leaks: 0, credit: 1, menu: 2, timing: 3 };
export const MAX_INSIGHTS = 12;

/** "KES 42,000" — whole shillings for a sentence. */
export function moneyText(n: number, currency = 'KES'): string {
  const v = Math.round(Math.abs(n));
  return `${n < 0 && v > 0 ? '-' : ''}${currency || 'KES'} ${v.toLocaleString('en-US')}`;
}
/** A561: a unit cost for a sentence — whole shillings, or two decimals under KES 100 when it has cents ("KES 0.40"). */
export function costText(n: number, currency = 'KES'): string {
  const v = Math.abs(n);
  if (v >= 100 || Number.isInteger(Math.round(v * 100) / 100)) return moneyText(n, currency);
  return `${n < 0 ? '-' : ''}${currency || 'KES'} ${v.toFixed(2)}`;
}
const times = (x: number) => `${(Math.round(x * 10) / 10).toFixed(1)}×`;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const list = (names: string[], max = 3) => names.length <= max ? names.join(', ') : `${names.slice(0, max).join(', ')} and ${names.length - max} more`;

export function buildInsights(input: InsightInput): Insight[] {
  const cur = input.currency || 'KES';
  const out: Insight[] = [];
  const add = (id: string, type: InsightType, severity: Severity, text: string) => out.push({ id, type, severity, text });

  // menu
  const m = input.menu;
  if (m && !m.costsHidden && m.avgUnitMargin !== null) {
    const avg = m.avgUnitMargin;
    for (const it of m.items.filter((i) => i.class === 'plowhorse' && i.rank <= 3)) {
      add(`menu.plowhorse.${it.productId ?? it.name}`, 'menu', 'medium',
        `${it.name} is a Plowhorse: top 3 seller but margin ${moneyText(avg - (it.unitMargin ?? 0), cur)} below average – check the recipe cost or portion, or pair it with a higher-margin item`);
    }
    const puzzle = m.items.filter((i) => i.class === 'puzzle').sort((a, b) => (b.unitMargin ?? 0) - (a.unitMargin ?? 0))[0];
    if (puzzle) {
      add(`menu.puzzle.${puzzle.productId ?? puzzle.name}`, 'menu', 'low',
        `${puzzle.name} is a Puzzle: margin ${moneyText((puzzle.unitMargin ?? 0) - avg, cur)} above average but only ${puzzle.qty} sold – feature it or have staff suggest it`);
    }
    const dogs = m.items.filter((i) => i.class === 'dog');
    if (dogs.length) {
      add('menu.dogs', 'menu', 'low', `${plural(dogs.length, 'item is a Dog', 'items are Dogs')} (low sales and low margin) – consider reworking or dropping ${list(dogs.map((d) => d.name))}`);
    }
  }
  if (m && !m.costsHidden && m.counts.no_cost > 0) {
    const names = m.items.filter((i) => i.class === 'no_cost').map((i) => i.name);
    add('menu.no_cost', 'menu', 'low', `${plural(names.length, 'item sold has', 'items sold have')} no cost set (${list(names)}) – set a cost or a recipe to see the margin`);
  }

  // timing
  const h = input.heatmap;
  if (h && h.totalOrders > 0) {
    if (h.quietest && h.busiest && h.quietest.label !== h.busiest.label) add('timing.quietest', 'timing', 'low', `${h.quietest.label} is your quietest slot`);
    if (h.busiest) add('timing.busiest', 'timing', 'low', `${h.busiest.label} is your busiest slot (${moneyText(h.busiest.revenue, cur)} in the period)`);
  }

  // money leaks
  const l = input.leaks;
  if (l) {
    for (const c of l.cashiers) {
      for (const f of c.flags) {
        const what = f.kind === 'void' ? 'voided' : 'gave discounts';
        const text = f.multiple !== null
          ? `Cashier ${c.name} ${what} ${times(f.multiple)} the branch median this period (${plural(f.events, f.kind === 'void' ? 'void' : 'discount', f.kind === 'void' ? 'voids' : 'discounts')})`
          : `Cashier ${c.name} ${what} ${plural(f.events, 'time', 'times')} this period while the median cashier did not at all`;
        add(`leaks.${f.kind}.${c.cashierId}`, 'leaks', f.kind === 'void' ? 'high' : 'medium', text);
      }
    }
    if (l.totals.dayCloseShort < 0) add('leaks.day_close_short', 'leaks', 'medium', `Day closes came up ${moneyText(-l.totals.dayCloseShort, cur)} short in total this period`);
    if (!l.wastageHidden && (l.totals.wastageValue ?? 0) > 0) {
      const sales = h?.totalRevenue ?? 0;
      const pct = sales > 0 ? ((l.totals.wastageValue ?? 0) / sales) * 100 : null;
      add('leaks.wastage', 'leaks', pct !== null && pct >= 3 ? 'medium' : 'low',
        `Wastage cost ${moneyText(l.totals.wastageValue ?? 0, cur)} this period${pct !== null ? ` (${pct.toFixed(1)}% of sales)` : ''}`);
    }
  }

  // credit
  const c = input.credit;
  if (c) {
    if (c.over60.amount > 0) add('credit.over60', 'credit', 'high', `${moneyText(c.over60.amount, cur)} is over 60 days old on credit (${plural(c.over60.customers, 'customer', 'customers')})`);
    if (c.totals.disputedCount > 0) {
      add('credit.disputed', 'credit', 'medium', `${plural(c.totals.disputedCount, 'disputed credit sale', 'disputed credit sales')} (${moneyText(c.totals.disputedAmount, cur)}) still ${c.totals.disputedCount === 1 ? 'needs' : 'need'} resolving – void or refund what was wrong`);
    }
  }

  return out.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || TYPE_ORDER[a.type] - TYPE_ORDER[b.type]).slice(0, MAX_INSIGHTS);
}

// ── A553: the overview (KPI row, revenue trend, payment mix) ──────────────────

/** The day `n` days after (or before, negative) a YYYY-MM-DD date. */
export function addDays(date: string, n: number): string {
  const d = dayNumber(date);
  return new Date(((d ?? 0) + n) * DAY_MS).toISOString().slice(0, 10);
}
/** Every date from `from` to `to`, both included. */
export function datesIn(from: string, to: string): string[] {
  const days = rangeDays(from, to) ?? 0;
  return Array.from({ length: Math.max(0, days) }, (_, i) => addDays(from, i));
}
/** The previous period of the same length: the `days` days that end the day before `from`. */
export function previousPeriod(from: string, to: string): { from: string; to: string } {
  const days = rangeDays(from, to) ?? 1;
  return { from: addDays(from, -days), to: addDays(from, -1) };
}
/** The change from `prev` to `now` as a fraction (0.25 = up 25%); null when there is nothing to compare against. */
export function pctChange(now: number, prev: number): number | null {
  if (!Number.isFinite(now) || !Number.isFinite(prev) || prev <= 0) return null;
  return r4((now - prev) / prev);
}

export interface DailyRow { day: string | null; method: string | null; revenue: number | string; orders: number | string }
export type MethodGroup = 'cash' | 'mpesa' | 'card' | 'account' | 'other';
export const METHOD_GROUPS: { key: MethodGroup; label: string }[] = [
  { key: 'cash', label: 'Cash' }, { key: 'mpesa', label: 'M-Pesa' }, { key: 'card', label: 'Card' },
  { key: 'account', label: 'On account' }, { key: 'other', label: 'Other' },
];
/** A payment method (free text since migration 89) → one of the five groups the payment-mix chart shows. */
export function methodGroup(method: string | null | undefined): MethodGroup {
  const m = String(method ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (m === 'cash') return 'cash';
  if (m.startsWith('mpesa') || m === 'mobilemoney') return 'mpesa';
  if (m === 'card' || m === 'visa' || m === 'mastercard' || m === 'pdq' || m.endsWith('card')) return 'card';
  if (m === 'credit' || m === 'account' || m === 'onaccount') return 'account';
  return 'other';
}

/** Gross margin as a share of the revenue of the items WITH a cost (the margin is only known for those); null without. */
export function grossMarginPct(m: MenuResult | null): number | null {
  if (!m || m.costsHidden || m.totals.margin === null) return null;
  const costedRevenue = m.items.filter((i) => i.unitMargin !== null).reduce((s, i) => s + i.revenue, 0);
  return costedRevenue > 0 ? r4(m.totals.margin / costedRevenue) : null;
}

type RiskFigures = Pick<LeakFigures, 'voidValue' | 'itemVoidValue' | 'refundValue' | 'discountValue' | 'wastageValue'>;
/** Money at risk on a day or a period: voids (orders + kitchen items) + refunds + discounts + wastage (when shown). */
export function moneyAtRisk(f: RiskFigures): number {
  return r2(f.voidValue + f.itemVoidValue + f.refundValue + f.discountValue + (f.wastageValue ?? 0));
}

export interface Kpi { value: number | null; prev: number | null; change: number | null }
export interface OverviewDay {
  day: string; revenue: number; orders: number; avgBill: number | null; atRisk: number;
  prevDay: string; prevRevenue: number; prevOrders: number;
}
export interface OverviewResult {
  previous: { from: string; to: string };
  days: OverviewDay[];
  kpis: { revenue: Kpi; orders: Kpi; avgBill: Kpi; margin: Kpi | null; atRisk: Kpi };
  atRiskParts: { voids: number; refunds: number; discounts: number; wastage: number | null };
  paymentMix: { key: MethodGroup; label: string; amount: number; share: number }[];
  marginHidden: boolean; wastageHidden: boolean;
}

/**
 * The overview: the period's days (each against the same day of the previous period, by position), the five KPIs with
 * their change, the money-at-risk split and the payment mix (the period only). `daily` covers BOTH periods (one call);
 * `leaksNow` / `leaksPrev` and `menuNow` / `menuPrev` are each period's answers. Without costs (A490) the margin KPI is
 * null and wastage (valued at cost) is left out of money at risk.
 */
export function buildOverview(input: {
  from: string; to: string; daily: DailyRow[]; leaksNow: LeaksResult; leaksPrev: LeaksResult;
  menuNow: MenuResult | null; menuPrev: MenuResult | null; costs: boolean;
}): OverviewResult {
  const { from, to, costs } = input;
  const prev = previousPeriod(from, to);
  const sales = new Map<string, { revenue: number; orders: number }>();
  const mix: Record<MethodGroup, number> = { cash: 0, mpesa: 0, card: 0, account: 0, other: 0 };
  for (const r of input.daily ?? []) {
    const day = String(r.day ?? '').slice(0, 10);
    if (!day) continue;
    if (r.method === null || r.method === undefined) {
      const s = sales.get(day) ?? { revenue: 0, orders: 0 };
      s.revenue += n0(r.revenue); s.orders += n0(r.orders);
      sales.set(day, s);
    } else if (day >= from && day <= to) {
      mix[methodGroup(r.method)] += n0(r.revenue);
    }
  }
  const risky = (f: RiskFigures) => moneyAtRisk(costs ? f : { ...f, wastageValue: null });
  const riskNow = new Map(input.leaksNow.days.map((d) => [d.day, risky(d)]));
  const now = datesIn(from, to), before = datesIn(prev.from, prev.to);
  const days: OverviewDay[] = now.map((day, i) => {
    const s = sales.get(day) ?? { revenue: 0, orders: 0 };
    const p = sales.get(before[i]) ?? { revenue: 0, orders: 0 };
    return {
      day, revenue: r2(s.revenue), orders: s.orders, avgBill: s.orders > 0 ? r2(s.revenue / s.orders) : null,
      atRisk: riskNow.get(day) ?? 0, prevDay: before[i], prevRevenue: r2(p.revenue), prevOrders: p.orders,
    };
  });
  const total = (ds: string[]) => ds.reduce((t, d) => {
    const s = sales.get(d);
    return { revenue: t.revenue + (s?.revenue ?? 0), orders: t.orders + (s?.orders ?? 0) };
  }, { revenue: 0, orders: 0 });
  const a = total(now), b = total(before);
  const kpi = (value: number | null, prevValue: number | null): Kpi => ({
    value, prev: prevValue, change: value === null || prevValue === null ? null : pctChange(value, prevValue),
  });
  const avgA = a.orders > 0 ? r2(a.revenue / a.orders) : null, avgB = b.orders > 0 ? r2(b.revenue / b.orders) : null;
  const t = input.leaksNow.totals;
  let margin: Kpi | null = null;
  if (costs) {
    const mA = grossMarginPct(input.menuNow), mB = grossMarginPct(input.menuPrev);
    // the margin's change is in percentage POINTS (0.02 = up 2 points), not a change of a percentage
    margin = { value: mA, prev: mB, change: mA === null || mB === null ? null : r4(mA - mB) };
  }
  const mixTotal = Object.values(mix).reduce((s, v) => s + v, 0);
  return {
    previous: prev, days,
    kpis: {
      revenue: kpi(r2(a.revenue), r2(b.revenue)), orders: kpi(a.orders, b.orders), avgBill: kpi(avgA, avgB), margin,
      atRisk: kpi(risky(t), risky(input.leaksPrev.totals)),
    },
    atRiskParts: {
      voids: r2(t.voidValue + t.itemVoidValue), refunds: t.refundValue, discounts: t.discountValue,
      wastage: costs ? (t.wastageValue ?? 0) : null,
    },
    paymentMix: METHOD_GROUPS.map((g) => ({ ...g, amount: r2(mix[g.key]), share: mixTotal > 0 ? r4(mix[g.key] / mixTotal) : 0 }))
      .filter((g) => g.amount > 0),
    marginHidden: !costs, wastageHidden: !costs,
  };
}

// ── A558: what sells when (item × time) ───────────────────────────────────────

export interface ItemTimeRow {
  is_total: boolean; product_id: string | null; product_name: string | null;
  qty: number | string; revenue: number | string; cells: unknown;
}
export type DaypartKey = 'morning' | 'lunch' | 'afternoon' | 'evening' | 'late';
export interface Daypart { key: DaypartKey; label: string; from: number; to: number }
/** The dayparts, by the clock hour (East Africa Time). Late runs from 22:00 to the start of the morning. */
export const DAYPARTS: Daypart[] = [
  { key: 'morning', label: 'Morning', from: 5, to: 11 },
  { key: 'lunch', label: 'Lunch', from: 11, to: 15 },
  { key: 'afternoon', label: 'Afternoon', from: 15, to: 18 },
  { key: 'evening', label: 'Evening', from: 18, to: 22 },
  { key: 'late', label: 'Late', from: 22, to: 5 },
];
export const ITEM_TIMES_LIMIT = 100;
export const DAYPART_TOP = 5;
export const HOUR_TOP = 3;

/** The hour the morning starts: 05:00, or later when the owner's day runs past it (a 06:00 cut-off → 06:00). */
export function morningStart(cutoffMinutes = 0): number {
  const c = Math.max(0, Math.min(360, Math.round(n0(cutoffMinutes))));
  return Math.max(5, Math.ceil(c / 60));
}
/** The daypart a clock hour falls in. Hours before the morning (the small hours, or before the cut-off) are Late. */
export function daypartOf(hour: number, cutoffMinutes = 0): DaypartKey {
  const h = ((Math.floor(n0(hour)) % 24) + 24) % 24;
  if (h >= 22 || h < morningStart(cutoffMinutes)) return 'late';
  if (h < 11) return 'morning';
  if (h < 15) return 'lunch';
  if (h < 18) return 'afternoon';
  return 'evening';
}
/** The dayparts with their hours for this business (the morning starts at morningStart). */
export function daypartsFor(cutoffMinutes = 0): Daypart[] {
  const m = morningStart(cutoffMinutes);
  return DAYPARTS.map((d) => (d.key === 'morning' ? { ...d, from: m } : d.key === 'late' ? { ...d, to: m } : d));
}

/** One weekday × hour cell: weekday 0 = Monday … 6 = Sunday (the business day), the clock hour, quantity, revenue. */
export type ItemCell = [number, number, number, number];
export interface ItemTimes {
  productId: string | null; name: string; qty: number; revenue: number; cells: ItemCell[];
  /** quantity per daypart */
  dayparts: Record<DaypartKey, number>;
  bestDaypart: DaypartKey | null; bestDaypartShare: number | null;
  /** the weekday × hour it sells most in */
  peak: { dow: number; day: string; hour: number; qty: number } | null;
}
export interface TopItem { productId: string | null; name: string; qty: number; share: number }
export interface DaypartSummary extends Daypart { qty: number; revenue: number; share: number; top: TopItem[] }
export interface HourSummary { hour: number; label: string; qty: number; revenue: number; top: TopItem[] }
export interface ItemTimesResult {
  items: ItemTimes[];
  totals: { qty: number; revenue: number };
  dayparts: DaypartSummary[];
  hours: HourSummary[];
  /** A560: everything sold (the total row) per business weekday, 0 = Monday — a weekday with 0 did not trade */
  weekdays: number[];
  /** true when only the best ITEM_TIMES_LIMIT sellers were sent (the totals and shares still count every product) */
  limited: boolean;
}

function cellsOf(raw: unknown): ItemCell[] {
  let arr: unknown = raw;
  if (typeof raw === 'string') { try { arr = JSON.parse(raw); } catch { arr = []; } }
  if (!Array.isArray(arr)) return [];
  const out: ItemCell[] = [];
  for (const c of arr) {
    if (!Array.isArray(c) || c.length < 4) continue;
    const d = n0(c[0]) - 1, h = n0(c[1]);   // ISO weekday 1 (Monday) … 7 (Sunday)
    if (d < 0 || d > 6 || h < 0 || h > 23) continue;
    out.push([d, h, r4(n0(c[2])), r2(n0(c[3]))]);
  }
  return out;
}
const emptyParts = (): Record<DaypartKey, number> => ({ morning: 0, lunch: 0, afternoon: 0, evening: 0, late: 0 });

/**
 * What sells when: each product's cells and dayparts (its best daypart and peak hour), each daypart's top 5 and each
 * trading hour's top 3 — every share against the TOTAL row (all products, not only the ones sent).
 */
export function summariseItemTimes(rows: ItemTimeRow[], cutoffMinutes = 0, limit = ITEM_TIMES_LIMIT): ItemTimesResult {
  const totalRow = (rows ?? []).find((r) => r.is_total);
  const all = totalRow ? cellsOf(totalRow.cells) : [];
  const items: ItemTimes[] = (rows ?? []).filter((r) => !r.is_total && n0(r.qty) > 0).map((r) => {
    const cells = cellsOf(r.cells);
    const parts = emptyParts();
    let peak: ItemTimes['peak'] = null;
    for (const [d, h, q] of cells) {
      parts[daypartOf(h, cutoffMinutes)] += q;
      if (!peak || q > peak.qty) peak = { dow: d, day: WEEKDAYS[d], hour: h, qty: q };
    }
    const qty = r4(n0(r.qty));
    const keys = Object.keys(parts) as DaypartKey[];
    const best = keys.reduce<DaypartKey | null>((b, k) => (parts[k] > 0 && (b === null || parts[k] > parts[b]) ? k : b), null);
    return {
      productId: r.product_id, name: r.product_name || 'Unnamed item', qty, revenue: r2(n0(r.revenue)), cells,
      dayparts: Object.fromEntries(keys.map((k) => [k, r4(parts[k])])) as Record<DaypartKey, number>,
      bestDaypart: best, bestDaypartShare: best && qty > 0 ? r4(parts[best] / qty) : null, peak,
    };
  }).sort((a, b) => b.qty - a.qty || b.revenue - a.revenue || a.name.localeCompare(b.name));

  // the denominators: every product's quantity per daypart and per hour (the total row)
  const partQty = emptyParts(), partRev = emptyParts();
  const hourQty = Array(24).fill(0) as number[], hourRev = Array(24).fill(0) as number[];
  const dayQty = Array(7).fill(0) as number[];
  for (const [d, h, q, v] of all) {
    const k = daypartOf(h, cutoffMinutes);
    partQty[k] += q; partRev[k] += v; hourQty[h] += q; hourRev[h] += v; dayQty[d] += q;
  }
  const totalQty = all.reduce((s, c) => s + c[2], 0);
  const top = (inIt: (c: ItemCell) => boolean, denom: number, n: number): TopItem[] => items
    .map((i) => ({ i, q: i.cells.reduce((s, c) => s + (inIt(c) ? c[2] : 0), 0) })).filter((x) => x.q > 0)
    .sort((a, b) => b.q - a.q || b.i.revenue - a.i.revenue || a.i.name.localeCompare(b.i.name)).slice(0, n)
    .map(({ i, q }) => ({ productId: i.productId, name: i.name, qty: r4(q), share: denom > 0 ? r4(q / denom) : 0 }));
  const dayparts: DaypartSummary[] = daypartsFor(cutoffMinutes).map((d) => ({
    ...d, qty: r4(partQty[d.key]), revenue: r2(partRev[d.key]), share: totalQty > 0 ? r4(partQty[d.key] / totalQty) : 0,
    top: top((c) => daypartOf(c[1], cutoffMinutes) === d.key, partQty[d.key], DAYPART_TOP),
  }));
  // the hours that sold, in the day's order: from the morning start round to the small hours
  const start = morningStart(cutoffMinutes);
  const hours: HourSummary[] = [];
  for (let k = 0; k < 24; k++) {
    const h = (start + k) % 24;
    if (hourQty[h] <= 0) continue;
    hours.push({ hour: h, label: hh(h), qty: r4(hourQty[h]), revenue: r2(hourRev[h]), top: top((c) => c[1] === h, hourQty[h], HOUR_TOP) });
  }
  return {
    items, dayparts, hours, weekdays: dayQty.map(r4),
    totals: { qty: r4(totalQty), revenue: r2(totalRow ? n0(totalRow.revenue) : 0) },
    limited: items.length >= limit,
  };
}

// ── A558: "Do this next" — the recommendations ────────────────────────────────

export const MONTH_DAYS = 30;
export const MENU_MIN_QTY = 50;          // no menu advice on fewer items sold than this in the period
export const MENU_MIN_DAYS = 7;          // …or on less than a week
export const PROMOTE_MIN_QTY = 3;
export const PROMOTE_UPLIFT = 0.2;       // the assumed lift from featuring a Puzzle
export const DROP_MIN_DAYS = 14;         // never "drop it" on less than two weeks
export const DROP_TOP = 3;
export const TIMING_MIN_ORDERS = 100;    // no staffing or happy-hour advice on fewer orders
export const TIMING_MIN_DAYS = 7;
export const STAFF_BLOCK_HOURS = 3;
export const STAFF_MIN_MULTIPLE = 2;     // the block takes at least 2× an even share of the sales
export const STAFF_UPLIFT = 0.05;        // the assumed gain from quicker service in the rush
export const QUIET_MAX_RATIO = 0.5;      // the quietest two hours at most half a typical two hours
export const QUIET_FILL = 0.25;          // the assumed share of that gap an offer fills
export const LEAK_TOP = 3;
export const DAY_CLOSE_MIN_SHORT = 500;
export const CREDIT_MIN_OVER60 = 1000;
export const COST_MIN_QTY = 5;
export const MAX_RECOMMENDATIONS = 7;
// A560: what to stock
export const STOCK_MIN_DAYS = 14;        // no stock advice on less than two weeks
export const STOCK_MIN_WEEKDAYS = 2;     // a weekday needs at least two of itself in the period
export const STOCK_UP_MULTIPLE = 1.5;    // a busy day for an item: its typical sales that weekday ≥ 1.5× its average day
export const STOCK_UP_MIN_QTY = 10;      // …and at least 10 units on that weekday
export const STOCK_BUFFER = 0.1;         // 10% over the typical day, so a busier one does not run you out
export const STOCK_UP_ITEMS = 3;         // items named per weekday card
export const STOCK_UP_TOP = 2;           // weekday cards at most
export const STOCK_COVER_DAYS = 2;       // no busy day ahead: today and tomorrow
export const STOCK_LOW_MIN_SHORT = 3;    // units short before a "running low" card
export const STOCK_LOW_TOP = 2;
export const WEEK_TOP = 3;               // the week at a glance: the top 3 per weekday
export const SLOW_MIN_DAYS = 28;         // never "stock less" on less than four weeks
export const SLOW_MAX_PER_WEEK = 2;      // a slow mover sells under 2 a week
export const SLOW_MIN_ITEMS = 5;         // a list of at least 5 items sold to compare with
export const SLOW_TOP = 3;

export type RecKind = 'stock_low' | 'stock_up' | 'slow' | 'promote' | 'rework' | 'staffing' | 'quiet' | 'leak' | 'day_close' | 'credit' | 'cost'
  | 'stock_out' | 'wastage' | 'lapsed' | 'food_cost' | 'thin_margin' | 'cost_rise' | 'stock_move' | 'branch_drop' | 'together';
export type Confidence = 'high' | 'medium' | 'low';
export type Evidence = 'menu' | 'heatmap' | 'leaks' | 'credit' | 'times' | 'stock' | 'customers' | 'costs' | 'branches' | 'together';
export interface Recommendation {
  id: string; kind: RecKind;
  /** verb first: "Stock up for Friday: 140 Tusker lager" */
  title: string;
  /** why, in one sentence, with the numbers */
  why: string;
  /**
   * the estimate in KES (null: no honest KES figure), a month or once, and what kind of money it is. A560: 'at_risk' —
   * the sales lost if an item runs out (units short × what it sells for), never called profit.
   */
  impact: number | null; impactPer: 'month' | 'once' | null; impactKind: 'gain' | 'recover' | 'collect' | 'at_risk' | null;
  /** A560: a stock card's estimate in units — what to have in by `by` (and, running low, what is on hand and to order) */
  stock: { by: string; items: StockLine[] } | null;
  /** A560: a warning to look into (a cashier's voids or discounts) — no estimate, drawn as a warning */
  warning: boolean;
  /** the assumption the estimate rests on, said plainly */
  assumption: string;
  confidence: Confidence;
  /** the tab (or section) that shows the evidence */
  evidence: Evidence;
  /** A565: a stock move to consider — the items and the two branches, never a quantity (the owner decides how much) */
  move?: MoveLine;
  /** A565: the branch a card is about (an underperforming branch) — "What sells when" there */
  branchId?: string;
  /** A565: internal only — orders cards with no estimate inside their group; the route never sends it */
  score?: number;
}
export interface StockLine { name: string; qty: number; onHand?: number; order?: number }
/** A560: an item's stock level now at the branch in view (stock_levels, tracked products only). */
export interface StockLevel { productId: string; onHand: number }
export interface RecInput {
  days: number; costs: boolean; currency?: string;
  menu: MenuResult | null; heatmap: HeatmapResult | null; leaks: LeaksResult | null; credit: CreditResult | null;
  times: ItemTimesResult | null;
  /** A560: the period (business dates) — the weekday counts; without it no stock rule */
  from?: string; to?: string;
  /** A560: the business date now — where "the next busy day" counts from */
  today?: string;
  /** A560: stock levels now (one branch); null or absent — no "running low" card */
  stock?: StockLevel[] | null;
  /** A561: how fast stock goes (on hand only for one branch); null or absent — no run-out or wastage card */
  stockUse?: StockUseResult | null;
  /** A561: who comes back (customers.view / customers.credit only); null or absent — no lapsed-regulars card */
  customers?: CustomersResult | null;
  /** A561: costs and margins (seesCosts only); null or absent — no food-cost, thin-margin or cost-rise card */
  costWatch?: CostsResult | null;
  /** A565: the stock moves worked out across every branch (all-branch viewers, 2+ branches); null or absent — none */
  moves?: StockMove[] | null;
  /** A565: the branch comparison (all-branch viewers, 2+ branches); null or absent — no underperforming card */
  branchCompare?: BranchCompare | null;
  /** A565: the branch in view (null: every branch) — moves touching it, and the run-out cards a move replaces */
  branchInView?: string | null;
  /** A575: what sells together (migration 164); null or absent — no together card */
  together?: TogetherResult | null;
  /** A575: the business type (businesses.type) — the words of the cards; absent: a restaurant's, as before */
  businessType?: string | null;
}

const perMonth = (x: number, days: number) => (days > 0 ? (x * MONTH_DAYS) / days : 0);
const pctText = (x: number) => { const p = x * 100; return `${p < 10 && p > 0 ? p.toFixed(1) : Math.round(p)}%`; };
const qtyText = (n: number) => (Number.isInteger(n) ? n.toLocaleString('en-US') : (Math.round(n * 10) / 10).toLocaleString('en-US'));
const andList = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
/** The menu, when menu advice may be given: costs shown, a margin line, enough sold over enough days. */
function menuReady(i: RecInput): MenuResult | null {
  const m = i.menu;
  if (!i.costs || !m || m.costsHidden || m.avgUnitMargin === null) return null;
  if (m.totals.qty < MENU_MIN_QTY || i.days < MENU_MIN_DAYS) return null;
  return m;
}
const daypartLabel = (k: DaypartKey) => (DAYPARTS.find((d) => d.key === k) as Daypart).label;
const timesFor = (t: ItemTimesResult | null, it: { productId: string | null; name: string }) =>
  t?.items.find((x) => (it.productId ? x.productId === it.productId : !x.productId && x.name === it.name)) ?? null;

/** The best Puzzle (high margin, low popularity): feature it at its best daypart. Impact = margin × 20% more a month. */
export function recPromote(i: RecInput): Recommendation[] {
  const m = menuReady(i); if (!m) return [];
  const cur = i.currency || 'KES';
  const avg = m.avgUnitMargin as number;
  const best = m.items.filter((it) => it.class === 'puzzle' && it.unitMargin !== null && it.qty >= PROMOTE_MIN_QTY)
    .map((it) => ({ it, monthly: perMonth(it.qty, i.days) }))
    .sort((a, b) => (b.it.unitMargin as number) * b.monthly - (a.it.unitMargin as number) * a.monthly)[0];
  if (!best) return [];
  const { it, monthly } = best;
  const t = timesFor(i.times, it);
  const part = t?.bestDaypart ?? null;
  const extra = monthly * PROMOTE_UPLIFT;
  return [{
    id: `promote.${it.productId ?? it.name}`, kind: 'promote',
    title: part ? `Feature ${it.name} at ${daypartLabel(part).toLowerCase()}` : `Have staff suggest ${it.name}`,
    why: `It leaves ${moneyText(it.unitMargin as number, cur)} each — ${moneyText((it.unitMargin as number) - avg, cur)} more than your average — but only ${qtyText(it.qty)} sold in ${i.days} days`
      + (part && t?.bestDaypartShare ? `, ${pctText(t.bestDaypartShare)} of them at ${daypartLabel(part).toLowerCase()}.` : '.'),
    impact: Math.round((it.unitMargin as number) * extra), impactPer: 'month', impactKind: 'gain', stock: null, warning: false,
    assumption: `If featuring it lifts its sales by ${Math.round(PROMOTE_UPLIFT * 100)}% (about ${qtyText(Math.round(monthly))} → ${qtyText(Math.round(monthly + extra))} a month) at today's margin.`,
    confidence: 'low', evidence: 'menu',
  }];
}

/** Dogs (slow and low margin): rework or drop. No KES estimate — it says how little they earn. */
export function recRework(i: RecInput): Recommendation[] {
  const m = menuReady(i); if (!m || i.days < DROP_MIN_DAYS) return [];
  const cur = i.currency || 'KES';
  const dogs = m.items.filter((it) => it.class === 'dog').sort((a, b) => (a.totalMargin ?? 0) - (b.totalMargin ?? 0) || a.qty - b.qty).slice(0, DROP_TOP);
  if (!dogs.length) return [];
  const margin = perMonth(dogs.reduce((s, d) => s + (d.totalMargin ?? 0), 0), i.days);
  const sold = dogs.reduce((s, d) => s + d.qty, 0);
  return [{
    id: 'rework.dogs', kind: 'rework',
    title: dogs.length === 1 ? `Rework or drop ${dogs[0].name}` : `Rework or drop ${dogs.length} slow items`,
    why: `${andList(dogs.map((d) => d.name))} sell little and earn little: ${qtyText(sold)} sold in ${i.days} days, about ${moneyText(margin, cur)} a month left after cost${dogs.length === 1 ? '' : ' between them'}.`,
    impact: null, impactPer: null, impactKind: null, stock: null, warning: false,
    assumption: analyticsWords(i.businessType).costOfSales === 'Food cost'
      ? 'No KES estimate: a shorter menu saves prep, stock and waste, and points customers to your best items.'
      : 'No KES estimate: a shorter list frees shelf space and money tied up in stock, and points customers to your best items.',
    confidence: 'medium', evidence: 'menu',
  }];
}

/** Every `width`-hour slot inside the trading hours, on the days that traded (as summariseHeatmap's busiest / quietest). */
export function slotsOf(h: HeatmapResult, width: number): Slot[] {
  const out: Slot[] = [];
  if (!h.tradingHours) return out;
  const { from, to } = h.tradingHours;
  for (let d = 0; d < 7; d++) {
    if (!h.orders[d]?.some((x) => x > 0)) continue;
    for (let s = from; s + width - 1 <= to; s++) {
      let rev = 0, ord = 0;
      for (let k = 0; k < width; k++) { rev += h.revenue[d][s + k]; ord += h.orders[d][s + k]; }
      out.push({ dow: d, day: WEEKDAYS[d], startHour: s, endHour: s + width, label: slotLabel(d, s, s + width), revenue: r2(rev), orders: ord });
    }
  }
  return out;
}
function timingReady(i: RecInput): HeatmapResult | null {
  const h = i.heatmap;
  return h && h.tradingHours && h.totalOrders >= TIMING_MIN_ORDERS && i.days >= TIMING_MIN_DAYS && h.totalRevenue > 0 ? h : null;
}
/** The items sold most in a weekday's hours [fromHour, toHour) (from item × time), by quantity. */
export function topItemsIn(t: ItemTimesResult | null, dow: number, fromHour: number, toHour: number, n = 3): string[] {
  if (!t) return [];
  return t.items.map((it) => ({ it, q: it.cells.reduce((s, c) => s + (c[0] === dow && c[1] >= fromHour && c[1] < toHour ? c[2] : 0), 0) }))
    .filter((x) => x.q > 0).sort((a, b) => b.q - a.q || a.it.name.localeCompare(b.it.name)).slice(0, n).map((x) => x.it.name);
}

/** The busiest three hours of the week: an extra cashier. Impact = 5% more of those hours' sales a month. */
export function recStaffing(i: RecInput): Recommendation[] {
  const h = timingReady(i); if (!h || !h.tradingHours) return [];
  const span = h.tradingHours.to - h.tradingHours.from + 1;
  if (span <= STAFF_BLOCK_HOURS) return [];
  const cur = i.currency || 'KES';
  const block = slotsOf(h, STAFF_BLOCK_HOURS).sort((a, b) => b.revenue - a.revenue || a.dow - b.dow || a.startHour - b.startHour)[0];
  if (!block) return [];
  const share = block.revenue / h.totalRevenue;
  const even = STAFF_BLOCK_HOURS / (7 * span);
  if (share < STAFF_MIN_MULTIPLE * even) return [];
  const items = topItemsIn(i.times, block.dow, block.startHour, block.endHour);
  return [{
    id: `staffing.${block.dow}.${block.startHour}`, kind: 'staffing',
    title: `Put an extra cashier on ${block.label}`,
    why: `You take ${pctText(share)} of all your sales in those three hours (${moneyText(block.revenue, cur)}, ${qtyText(block.orders)} orders in ${i.days} days)`
      + (items.length ? ` — most bought then: ${andList(items)}; have them ready.` : '.'),
    impact: Math.round(perMonth(block.revenue, i.days) * STAFF_UPLIFT), impactPer: 'month', impactKind: 'gain', stock: null, warning: false,
    assumption: `If quicker service there adds ${Math.round(STAFF_UPLIFT * 100)}% to those hours' sales.`,
    confidence: 'low', evidence: 'heatmap',
  }];
}

/** The quietest two hours (at most half a typical two hours): a happy-hour offer. Impact = a quarter of the gap a month. */
export function recQuietSlot(i: RecInput): Recommendation[] {
  const h = timingReady(i); if (!h || !h.quietest || !h.busiest || h.quietest.label === h.busiest.label) return [];
  const cur = i.currency || 'KES';
  const q = h.quietest;
  const typical = median(slotsOf(h, q.endHour - q.startHour).map((s) => s.revenue));
  if (typical === null || typical <= 0 || q.revenue > QUIET_MAX_RATIO * typical) return [];
  return [{
    id: `quiet.${q.dow}.${q.startHour}`, kind: 'quiet',
    title: `Try a happy-hour offer on ${q.label}`,
    why: `It is your quietest time: ${moneyText(q.revenue, cur)} in ${i.days} days, against ${moneyText(typical, cur)} for a typical two hours.`,
    impact: Math.round(perMonth(typical - q.revenue, i.days) * QUIET_FILL), impactPer: 'month', impactKind: 'gain', stock: null, warning: false,
    assumption: `If an offer fills a quarter of the gap to a typical two hours (sales, before the offer's cost).`,
    confidence: 'low', evidence: 'heatmap',
  }];
}

/**
 * A flagged cashier (A549's flag: ≥ 2× the median, ≥ 5 events). A560 (the owner: "warning only for investigation"): a
 * warning to look into — no KES estimate (a void before payment is not always a loss) and never in the value line.
 */
export function recLeaks(i: RecInput): Recommendation[] {
  const l = i.leaks; if (!l) return [];
  const cur = i.currency || 'KES';
  const out: { rec: Recommendation; value: number }[] = [];
  for (const c of l.cashiers) {
    for (const f of c.flags) {
      const isVoid = f.kind === 'void';
      const value = isVoid ? c.voidValue + c.itemVoidValue : c.discountValue;
      const what = isVoid ? 'voids' : 'discounts';
      const count = `${qtyText(f.events)} ${f.events === 1 ? what.slice(0, -1) : what} (${moneyText(value, cur)}) in ${i.days} days`;
      out.push({
        value,
        rec: {
          id: `leak.${f.kind}.${c.cashierId ?? c.name}`, kind: 'leak',
          title: `Check ${c.name}'s ${what}`,
          why: (f.multiple !== null ? `${count} — ${times(f.multiple)} the branch median rate.` : `${count}, while the typical cashier had none.`)
            + (isVoid ? ' Worth a look; a void before payment is not always a loss.' : ' Worth a look; some discounts are offers you approved.'),
          impact: null, impactPer: null, impactKind: null, stock: null, warning: true,
          assumption: 'A warning to look into, not money lost — no KES estimate.',
          confidence: isVoid ? 'high' : 'medium', evidence: 'leaks',
        },
      });
    }
  }
  return out.sort((a, b) => b.value - a.value || a.rec.id.localeCompare(b.rec.id)).slice(0, LEAK_TOP).map((x) => x.rec);
}

/** Day closes short in total: check them. Impact = the shortfall a month. */
export function recDayClose(i: RecInput): Recommendation[] {
  const l = i.leaks; if (!l || -l.totals.dayCloseShort < DAY_CLOSE_MIN_SHORT) return [];
  const cur = i.currency || 'KES';
  const short = -l.totals.dayCloseShort;
  const daysShort = l.days.filter((d) => d.dayCloseVariance < 0).length;
  return [{
    id: 'day_close.short', kind: 'day_close',
    title: 'Check why the day closes came up short',
    why: `The cash counted at day close was ${moneyText(short, cur)} short in all, on ${daysShort} ${daysShort === 1 ? 'day' : 'days'} of ${i.days}.`,
    impact: Math.round(perMonth(short, i.days)), impactPer: 'month', impactKind: 'recover', stock: null, warning: false,
    assumption: 'If the shortfall stops (part of it may be counting mistakes rather than loss).',
    confidence: 'medium', evidence: 'leaks',
  }];
}

/** Credit over 60 days: chase it, the top names first. Impact = the amount, once. */
export function recCredit(i: RecInput): Recommendation[] {
  const c = i.credit; if (!c || c.over60.amount < CREDIT_MIN_OVER60) return [];
  const cur = i.currency || 'KES';
  const old = c.customers.filter((x) => x.d61_90 + x.d90_plus > 0)
    .sort((a, b) => (b.d61_90 + b.d90_plus) - (a.d61_90 + a.d90_plus) || a.name.localeCompare(b.name));
  const names = old.slice(0, 3).map((x) => `${x.name} ${moneyText(x.d61_90 + x.d90_plus, cur)}`);
  const more = old.length - names.length;
  return [{
    id: 'credit.over60', kind: 'credit',
    title: `Chase ${moneyText(c.over60.amount, cur)} owed for over 60 days`,
    why: `${andList(more > 0 ? [...names, `${more} more`] : names)} — owed for more than two months.`,
    impact: Math.round(c.over60.amount), impactPer: 'once', impactKind: 'collect', stock: null, warning: false,
    assumption: 'Money already owed to you — counted once, if it is paid.',
    confidence: 'high', evidence: 'credit',
  }];
}

/** Items sold with no cost: set one. No KES estimate. Costs only (it tells which items have a cost). */
export function recCostData(i: RecInput): Recommendation[] {
  const m = i.menu; if (!i.costs || !m || m.costsHidden) return [];
  const cur = i.currency || 'KES';
  const missing = m.items.filter((it) => it.class === 'no_cost' && it.qty >= COST_MIN_QTY).sort((a, b) => b.revenue - a.revenue || a.name.localeCompare(b.name));
  if (!missing.length) return [];
  const shown = missing.slice(0, 3).map((x) => x.name);
  const revenue = missing.reduce((s, x) => s + x.revenue, 0);
  return [{
    id: 'cost.missing', kind: 'cost',
    title: missing.length === 1 ? `Set a cost for ${missing[0].name}` : `Set a cost for ${missing[0].name} and ${missing.length - 1} more`,
    why: `${andList(missing.length > shown.length ? [...shown, `${missing.length - shown.length} more`] : shown)} sold ${moneyText(revenue, cur)} in ${i.days} days with no cost or recipe set, so the margin is unknown.`,
    impact: null, impactPer: null, impactKind: null, stock: null, warning: false,
    assumption: 'No KES estimate: with a cost set, every margin on this page is complete.',
    confidence: 'medium', evidence: 'costs',
  }];
}

// ── A560: what to stock ───────────────────────────────────────────────────────

/** The weekday of a business date, 0 = Monday … 6 = Sunday. */
export function weekdayOf(date: string): number {
  const d = dayNumber(date) ?? 0;   // 1970-01-01 was a Thursday (3)
  return (((d + 3) % 7) + 7) % 7;
}
/** How many of each weekday (0 = Monday) the period holds. */
export function weekdayCounts(from: string, to: string): number[] {
  const out = Array(7).fill(0) as number[];
  for (const d of datesIn(from, to)) out[weekdayOf(d)] += 1;
  return out;
}
/** What to have in for a typical day's `typical` sales: 10% more, rounded UP (to 1 under 20, to 5 under 100, else to 10). */
export function stockQty(typical: number): number {
  const v = Math.max(0, typical) * (1 + STOCK_BUFFER);
  const step = v < 20 ? 1 : v < 100 ? 5 : 10;
  return Math.ceil(v / step - 1e-9) * step;
}

export interface WeekdayProfile {
  productId: string | null; name: string;
  /** what it sells for on average (revenue / quantity) */
  avgPrice: number;
  /** its typical sales on each weekday (the weekday's quantity / how many of that weekday the period held); null: none */
  perDay: (number | null)[];
  /** its average day: the mean of perDay over the weekdays the business traded */
  avgDay: number;
}
/** Each item's typical sales by weekday — the period's weekday totals over the number of that weekday in it. */
export function weekdayProfiles(t: ItemTimesResult, counts: number[]): WeekdayProfile[] {
  const traded = counts.map((c, d) => c > 0 && (t.weekdays?.[d] ?? 0) > 0);
  const n = traded.filter(Boolean).length;
  return t.items.map((it) => {
    const q = Array(7).fill(0) as number[];
    for (const [d, , qty] of it.cells) q[d] += qty;
    const perDay = q.map((x, d) => (counts[d] > 0 ? x / counts[d] : null));
    const avgDay = n > 0 ? perDay.reduce<number>((s, x, d) => s + (traded[d] ? x ?? 0 : 0), 0) / n : 0;
    return { productId: it.productId, name: it.name, avgPrice: it.qty > 0 ? it.revenue / it.qty : 0, perDay, avgDay };
  });
}
/** A busy day for an item: at least two of that weekday, ≥ 10 units typically, and ≥ 1.5× its average day. */
export function isBusyDay(p: WeekdayProfile, d: number, counts: number[]): boolean {
  const x = p.perDay[d];
  return x !== null && counts[d] >= STOCK_MIN_WEEKDAYS && x >= STOCK_UP_MIN_QTY && p.avgDay > 0 && x >= STOCK_UP_MULTIPLE * p.avgDay - 1e-9;
}
function stockReady(i: RecInput): { counts: number[]; profiles: WeekdayProfile[] } | null {
  const t = i.times;
  if (!t || !t.items.length || !i.from || !i.to || i.days < STOCK_MIN_DAYS) return null;
  const counts = weekdayCounts(i.from, i.to);
  return { counts, profiles: weekdayProfiles(t, counts) };
}
const round0 = (x: number) => Math.round(x);

/**
 * "Stock up for Friday": for each weekday, the items whose typical sales that day are ≥ 1.5× their average day (≥ 10
 * units, ≥ 2 of that weekday in the period). One card per weekday — the two weekdays with the most extra sales (the
 * extra units × what each sells for) — naming its top 3 items by the extra units. The estimate is units, not KES: the
 * typical day plus 10%, rounded up (stockQty).
 */
export function recStockUp(i: RecInput): Recommendation[] {
  const r = stockReady(i); if (!r) return [];
  const { counts, profiles } = r;
  const days: { d: number; score: number; items: { p: WeekdayProfile; typical: number; extra: number }[] }[] = [];
  for (let d = 0; d < 7; d++) {
    const items = profiles.filter((p) => isBusyDay(p, d, counts))
      .map((p) => ({ p, typical: p.perDay[d] as number, extra: (p.perDay[d] as number) - p.avgDay }))
      .sort((a, b) => b.extra - a.extra || a.p.name.localeCompare(b.p.name));
    if (items.length) days.push({ d, score: items.reduce((s, x) => s + x.extra * x.p.avgPrice, 0), items });
  }
  return days.sort((a, b) => b.score - a.score || a.d - b.d).slice(0, STOCK_UP_TOP).map(({ d, items }): Recommendation => {
    const day = WEEKDAYS[d];
    const shown = items.slice(0, STOCK_UP_ITEMS);
    const more = items.length - shown.length;
    const lines = shown.map((x, k) => `${k === 0 ? 'you sell about ' : ''}${qtyText(round0(x.typical))} ${x.p.name} (vs ${qtyText(round0(x.p.avgDay))}${k === 0 ? ' on an average day' : ''})`);
    return {
      id: `stock_up.${d}`, kind: 'stock_up',
      title: shown.length === 1 ? `Stock up for ${day}: ${qtyText(stockQty(shown[0].typical))} ${shown[0].p.name}`
        : `Stock up for ${day}: ${shown[0].p.name} and ${items.length - 1} more`,
      why: `${day}s: ${andList(more > 0 ? [...lines, `${more} more`] : lines)}.`,
      impact: null, impactPer: null, impactKind: null, warning: false,
      stock: { by: day, items: shown.map((x) => ({ name: x.p.name, qty: stockQty(x.typical) })) },
      assumption: `The average ${day} in this period (${counts[d]} of them), plus 10% so a busier one does not run you out, rounded up.`,
      confidence: counts[d] >= 4 ? 'high' : 'medium', evidence: 'times',
    };
  });
}

/**
 * "Running low before your busy day" — only with stock levels (one branch, tracked items): from today to the end of the
 * item's next busy day (isBusyDay, within the week; none: today and tomorrow) it typically sells `expected`; when what
 * is on hand is below that, order up to the expected sales + 10% (rounded up). KES = the units short (expected − on
 * hand) × what it sells for on average: sales at risk if it runs out, not profit. The two with the most at risk.
 */
export function recRunningLow(i: RecInput): Recommendation[] {
  const r = stockReady(i); if (!r || !i.stock?.length || !i.today) return [];
  const cur = i.currency || 'KES';
  const { counts, profiles } = r;
  const levels = new Map(i.stock.filter((x) => Number.isFinite(x.onHand) && x.onHand >= 0).map((x) => [x.productId, x.onHand]));
  const d0 = weekdayOf(i.today);
  const out: Recommendation[] = [];
  for (const p of profiles) {
    const onHand = p.productId ? levels.get(p.productId) : undefined;
    if (onHand === undefined) continue;
    let k = -1;
    for (let j = 0; j < 7; j++) if (isBusyDay(p, (d0 + j) % 7, counts)) { k = j; break; }
    const horizon = k >= 0 ? k : STOCK_COVER_DAYS - 1;
    let expected = 0;
    for (let j = 0; j <= horizon; j++) expected += p.perDay[(d0 + j) % 7] ?? 0;
    if (expected <= 0 || onHand >= expected) continue;
    const need = stockQty(expected);
    const order = Math.ceil(need - onHand - 1e-9);
    if (order < STOCK_LOW_MIN_SHORT) continue;
    const busy = k >= 0 ? WEEKDAYS[(d0 + k) % 7] : null;
    const typicalBusy = k >= 0 ? round0(p.perDay[(d0 + k) % 7] ?? 0) : 0;
    const have = `You have ${qtyText(Math.round(onHand * 100) / 100)} ${p.name}`;
    out.push({
      id: `stock_low.${p.productId}`, kind: 'stock_low',
      title: busy === null ? `Order about ${qtyText(order)} more ${p.name}`
        : k === 0 ? `Order about ${qtyText(order)} more ${p.name} today` : `Order about ${qtyText(order)} more ${p.name} before ${busy}`,
      why: busy === null ? `${have}; you usually sell about ${qtyText(round0(expected))} today and tomorrow.`
        : k === 0 ? `${have}; a normal ${busy} (today) sells about ${qtyText(typicalBusy)}.`
        : `${have}; a normal ${busy} sells about ${qtyText(typicalBusy)}, and from today to the end of ${busy} about ${qtyText(round0(expected))}.`,
      impact: Math.round((expected - onHand) * p.avgPrice), impactPer: 'once', impactKind: 'at_risk', warning: false,
      stock: { by: busy ?? 'tomorrow', items: [{ name: p.name, qty: need, onHand, order }] },
      assumption: `Your stock level as the cloud has it now, against the average of each weekday in this period, plus 10%. ${cur} = the units you would be short × what it sells for on average (sales at risk, not profit).`,
      confidence: 'medium', evidence: 'times',
    });
  }
  return out.sort((a, b) => (b.impact ?? 0) - (a.impact ?? 0) || a.id.localeCompare(b.id)).slice(0, STOCK_LOW_TOP);
}

/** The Dogs recRework names (none when it does not run) — the slow movers leave them out, so no item is named twice. */
function reworkNames(i: RecInput): Set<string> {
  const m = menuReady(i); if (!m || i.days < DROP_MIN_DAYS) return new Set();
  return new Set(m.items.filter((it) => it.class === 'dog').sort((a, b) => (a.totalMargin ?? 0) - (b.totalMargin ?? 0) || a.qty - b.qty)
    .slice(0, DROP_TOP).map((it) => it.productId ?? it.name));
}

/**
 * "Slow movers": items sold under 2 a week over at least 4 weeks, from the menu's full list (every product sold), else
 * from what sells when when it holds every product. Not when half the list or more is slow (a quiet business, not a slow
 * item), and not the Dogs the rework card already names. No KES estimate, no talk of what it sells for.
 */
export function recSlowMovers(i: RecInput): Recommendation[] {
  if (i.days < SLOW_MIN_DAYS) return [];
  const fromMenu = !!(i.menu && i.menu.items.length);
  const src: { key: string; name: string; qty: number }[] | null = fromMenu
    ? (i.menu as MenuResult).items.map((x) => ({ key: x.productId ?? x.name, name: x.name, qty: x.qty }))
    : i.times && !i.times.limited ? i.times.items.map((x) => ({ key: x.productId ?? x.name, name: x.name, qty: x.qty })) : null;
  if (!src || src.length < SLOW_MIN_ITEMS) return [];
  const slowAll = src.filter((x) => x.qty > 0 && (x.qty * 7) / i.days < SLOW_MAX_PER_WEEK);
  if (!slowAll.length || slowAll.length * 2 >= src.length) return [];
  const named = reworkNames(i);
  const slow = slowAll.filter((x) => !named.has(x.key)).sort((a, b) => a.qty - b.qty || a.name.localeCompare(b.name));
  if (!slow.length) return [];
  const shown = slow.slice(0, SLOW_TOP);
  const more = slow.length - shown.length;
  const parts = shown.map((x) => `${x.name} (${qtyText(x.qty)})`);
  const one = slow.length === 1;
  return [{
    id: 'slow.items', kind: 'slow',
    title: one ? `Stock less of ${slow[0].name}` : `Stock less of ${slow.length} slow sellers`,
    why: `${andList(more > 0 ? [...parts, `${more} more`] : parts)} sold in ${i.days} days — under ${SLOW_MAX_PER_WEEK} a week${one ? '' : ' each'}. Consider stocking less, or dropping ${one ? 'it' : 'them'}.`,
    impact: null, impactPer: null, impactKind: null, stock: null, warning: false,
    assumption: 'No KES estimate: less of a slow item on the shelf ties up less money and leaves less to spoil or expire.',
    confidence: i.days >= 56 ? 'high' : 'medium', evidence: fromMenu ? 'menu' : 'times',
  }];
}

export interface WeekPlanDay { dow: number; day: string; count: number; top: { productId: string | null; name: string; qty: number }[] }
/**
 * "Your week at a glance — what to prepare each day": for each weekday the period holds, its top 3 items by quantity and
 * their typical sales that day (the weekday's quantity / how many of that weekday, rounded, at least 1).
 */
export function weekPlan(t: ItemTimesResult | null, from: string, to: string): WeekPlanDay[] {
  if (!t) return [];
  const counts = weekdayCounts(from, to);
  const out: WeekPlanDay[] = [];
  for (let d = 0; d < 7; d++) {
    if (!counts[d]) continue;
    const top = t.items.map((it) => ({ it, q: it.cells.reduce((s, c) => s + (c[0] === d ? c[2] : 0), 0) })).filter((x) => x.q > 0)
      .sort((a, b) => b.q - a.q || a.it.name.localeCompare(b.it.name)).slice(0, WEEK_TOP)
      .map(({ it, q }) => ({ productId: it.productId, name: it.name, qty: Math.max(1, Math.round(q / counts[d])) }));
    out.push({ dow: d, day: WEEKDAYS[d], count: counts[d], top });
  }
  return out;
}

// ── Ranking and the value line ────────────────────────────────────────────────

const CONFIDENCE_ORDER: Record<Confidence, number> = { high: 0, medium: 1, low: 2 };
/** A560: stock-out risks first, then stocking up for a busy day, then the rest. */
const kindGroup = (k: RecKind | undefined) => (k === 'stock_low' || k === 'stock_out' || k === 'stock_move' ? 0 : k === 'stock_up' ? 1 : 2);
/**
 * Stock-out risks first, then stock-up-for-a-day, then the rest — each group by the KES at stake (a month, or once),
 * biggest first, no estimate last, then by confidence. At most 7.
 */
export function rankRecommendations(recs: Recommendation[]): Recommendation[] {
  const all = [...recs].sort((a, b) => kindGroup(a.kind) - kindGroup(b.kind) || (b.impact ?? -1) - (a.impact ?? -1)
    || (b.score ?? 0) - (a.score ?? 0) || CONFIDENCE_ORDER[a.confidence] - CONFIDENCE_ORDER[b.confidence] || a.id.localeCompare(b.id));
  const top = all.slice(0, MAX_RECOMMENDATIONS);
  // A560: a warning has no estimate, so it would always sort last — the strongest one keeps a place, in the last slot
  // of "the rest" (never in place of a stock card)
  const warning = all.find((r) => r.warning);
  if (warning && !top.includes(warning) && top.length === MAX_RECOMMENDATIONS && kindGroup(top[top.length - 1].kind) === 2) top[top.length - 1] = warning;
  return top;
}

/** Every rule, ranked. A575: what sells together comes from migration 164's analytics_together (the baskets in SQL). */
export function buildRecommendations(i: RecInput): Recommendation[] {
  return rankRecommendations(allRecommendations(i));
}
/** A561: every card the rules give, before the ranking keeps 7 — the tiles' "To do" badge counts them all. */
export function allRecommendations(i: RecInput): Recommendation[] {
  const low = recRunningLow(i);
  // A561: a run-out card never repeats an item A560's running-low card already names (one card per item)
  const named = new Set(low.map((r) => r.id.replace(/^stock_low\./, '')));
  const out = recRunOut(i).filter((r) => !named.has(r.id.replace(/^stock_out\.product\./, '')));
  // A565: a move INTO the branch in view replaces its run-out / running-low card for that item (merged into the move)
  const moves = recStockMoves(i);
  const into = new Map<string, Recommendation>();
  for (const m of moves) if (i.branchInView && m.move && m.move.toId === i.branchInView) for (const it of m.move.items) into.set(`${it.kind}.${it.itemId}`, m);
  const keep = (r: Recommendation, k: string) => {
    const m = into.get(k);
    if (!m || !m.move) return true;
    const note = ` If ${m.move.from} cannot spare enough, order the rest.`;
    if (!m.why.endsWith(note)) m.why += note;
    return false;
  };
  return [
    ...low.filter((r) => keep(r, `product.${r.id.replace(/^stock_low\./, '')}`)), ...out.filter((r) => keep(r, r.id.replace(/^stock_out\./, ''))),
    ...moves, ...recStockUp(i), ...recSlowMovers(i), ...recBranchDrop(i),
    ...recPromote(i), ...recRework(i), ...recStaffing(i), ...recQuietSlot(i), ...recLeaks(i), ...recDayClose(i), ...recCredit(i),
    ...recCostData(i), ...recWastage(i), ...recLapsed(i), ...recFoodCost(i), ...recThinMargin(i), ...recCostRise(i),
    ...recTogether(i),
  ];
}

export interface Found {
  /** the monthly estimates added up: gains and recoveries only — never a warning, never sales at risk */
  monthly: number;
  /** old credit to collect, once */
  once: number;
  /** sales at risk if the items running low run out */
  atRisk: number;
  /** cards with a KES estimate */
  count: number;
  /** every card; the busy days to stock for; the items running low; the warnings */
  actions: number; stockDays: number; lowItems: number; warnings: number;
  /** A565: stock moves to consider — counted, never valued */
  moves: number;
  /** the line above the cards: "This period: 6 things to act on — …" (null with no card) */
  line: string | null;
}
/**
 * A560: the value line counts what to do rather than one big KES total — the monthly figure is only the gains and
 * recoveries (no price rise exists, and a cashier's voids are a warning, never counted); sales at risk and old credit
 * stand apart.
 */
export function valueFound(recs: Recommendation[], currency = 'KES'): Found {
  const sum = (f: (r: Recommendation) => boolean) => Math.round(recs.filter(f).reduce((s, r) => s + (r.impact ?? 0), 0));
  const monthly = sum((r) => r.impactPer === 'month' && !r.warning && (r.impactKind === 'gain' || r.impactKind === 'recover'));
  const once = sum((r) => r.impactKind === 'collect');
  const atRisk = sum((r) => r.impactKind === 'at_risk');
  const stockDays = recs.filter((r) => r.kind === 'stock_up').length;
  const lowItems = recs.filter((r) => r.kind === 'stock_low' || r.kind === 'stock_out').length;   // A561: running out too
  const warnings = recs.filter((r) => r.warning).length;
  const moves = recs.filter((r) => r.kind === 'stock_move').length;
  const parts: string[] = [];
  if (stockDays) parts.push(`stock up for ${plural(stockDays, 'busy day', 'busy days')}`);
  if (lowItems) parts.push(`${plural(lowItems, 'item', 'items')} running low${atRisk > 0 ? ` (about ${moneyText(atRisk, currency)} of sales at risk if ${lowItems === 1 ? 'it runs' : 'they run'} out)` : ''}`);
  if (moves) parts.push(`${plural(moves, 'stock move', 'stock moves')} between branches to consider`);
  if (once > 0) parts.push(`${moneyText(once, currency)} of old credit to collect`);
  if (monthly > 0) parts.push(`about ${moneyText(monthly, currency)} a month from the other ideas`);
  if (warnings) parts.push(`${plural(warnings, 'warning', 'warnings')} to look into`);
  const line = recs.length ? `This period: ${plural(recs.length, 'thing', 'things')} to act on${parts.length ? ` — ${andList(parts)}` : ''}.` : null;
  return { monthly, once, atRisk, count: recs.filter((r) => r.impact !== null).length, actions: recs.length, stockDays, lowItems, warnings, moves, line };
}

// ── A558: "How was this period?" ──────────────────────────────────────────────

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayText = (iso: string) => { const [, m, d] = iso.split('-').map(Number); return `${d} ${MONTH_NAMES[m - 1] ?? ''}`; };
export interface Summary { good: string; worry: string | null; tone: 'up' | 'down' | 'flat' }

/**
 * One or two plain sentences from the overview: the good news first (sales up, or else the best other good figure), then
 * the biggest worry (sales down, money at risk up, else the top recommendation). `today` is the business date now: a
 * period ending today reads "in the last N days".
 */
export function buildSummary(input: { from: string; to: string; today: string; overview: OverviewResult; recommendations: Recommendation[]; currency?: string }): Summary {
  const cur = input.currency || 'KES';
  const k = input.overview.kpis;
  const days = rangeDays(input.from, input.to) ?? 1;
  const span = input.to === input.today ? (days === 1 ? 'today' : `in the last ${days} days`)
    : (days === 1 ? `on ${dayText(input.from)}` : `from ${dayText(input.from)} to ${dayText(input.to)}`);
  const before = days === 1 ? 'the day before' : `the ${days} days before`;
  const sales = k.revenue.value ?? 0;
  const ch = k.revenue.change;
  const risk = input.overview.wastageHidden ? 'voids, refunds and discounts' : 'voids, refunds, discounts and wastage';
  const goods: string[] = [];
  const worries: string[] = [];
  let tone: Summary['tone'] = 'flat';
  let salesLine: string;
  if (sales <= 0) { salesLine = `No sales were recorded ${span}.`; tone = 'down'; }
  else if (ch === null) salesLine = `You sold ${moneyText(sales, cur)} ${span}.`;
  else if (ch >= 0.005) { salesLine = `You sold ${moneyText(sales, cur)} ${span} — ${pctText(ch)} more than ${before}.`; goods.push(salesLine); tone = 'up'; }
  else if (ch <= -0.005) { salesLine = `You sold ${moneyText(sales, cur)} ${span}, ${pctText(-ch)} less than ${before}.`; worries.push(salesLine); tone = 'down'; }
  else salesLine = `You sold ${moneyText(sales, cur)} ${span}, about the same as ${before}.`;
  if (k.avgBill.change !== null && k.avgBill.value !== null && k.avgBill.change >= 0.05) goods.push(`The average bill rose ${pctText(k.avgBill.change)} to ${moneyText(k.avgBill.value, cur)}.`);
  if (k.margin && k.margin.change !== null && k.margin.change >= 0.01) goods.push(`Your margin rose ${(k.margin.change * 100).toFixed(1)} points.`);
  if (k.atRisk.change !== null && k.atRisk.change <= -0.1) goods.push(`Money lost to ${risk} fell ${pctText(-k.atRisk.change)}.`);
  if (k.atRisk.change !== null && k.atRisk.change >= 0.1 && (k.atRisk.value ?? 0) > 0) worries.push(`Money lost to ${risk} rose ${pctText(k.atRisk.change)} to ${moneyText(k.atRisk.value ?? 0, cur)}.`);
  const top = input.recommendations[0];
  if (top) worries.push(`The biggest thing to act on: ${lowerFirst(top.title)}.`);
  // good news first: the sales line when it is good, else the best other good figure, else the sales line as it is
  const good = goods[0] ?? salesLine;
  const worry = worries.find((w) => w !== good) ?? null;
  return { good, worry, tone };
}

// ── A561: how fast your stock goes ────────────────────────────────────────────

export const STOCK_USE_MIN_DAYS = 7;     // no run-out or wastage card on less than a week
export const STOCK_OUT_DAYS = 3;         // a run-out card when an item lasts under 3 days at the current rate
export const STOCK_OUT_MIN_USED = 5;     // …and it used at least 5 in the period
export const STOCK_OUT_TOP = 2;
export const STOCK_WEEK_DAYS = 7;        // what to order: a week's worth (+10%, rounded up)
export const WASTE_MIN_SHARE = 0.15;     // a wastage card when 15% or more of what was used was thrown away
export const WASTE_MIN_QTY = 5;          // …and at least 5 thrown away
export const TABLE_TOP = 10;             // every table: the top 10
export const STOCK_NOTE_ALL = 'Pick a branch to see how many days your stock lasts — stock is counted per branch.';
/** What the stock tab covers and what it does not, said once. */
export const STOCK_COVERS = 'Covers items that track stock (what the sales took off, less voided or refunded sales put back, plus wastage written off) and ingredients taken off through recipes, variant links and takeaway packaging when a sale reaches the cloud. Not covered: items that do not track stock, fuel (the tanks have their own page), and the ingredients of a voided sale (the cloud does not put them back).';

export interface StockUseRow {
  kind: string; item_id: string | null; item_name: string | null; unit: string | null; by_piece: boolean | null;
  sold: number | string; wasted: number | string; prev_sold: number | string; prev_wasted: number | string; on_hand: number | string | null;
}
export interface StockItem {
  kind: 'product' | 'ingredient'; id: string | null; name: string; unit: string | null;
  /** sold + wasted in the period, and the parts */
  used: number; sold: number; wasted: number;
  prevUsed: number; change: number | null;
  /** average use a day over the period */
  perDay: number;
  /** on hand now at the branch in view (null: every branch, or no level, or a negative level nobody counts) */
  onHand: number | null;
  /** on hand ÷ use a day (null when unknown or nothing is used) */
  daysLeft: number | null;
  /** wasted ÷ used (null when nothing was used) */
  wasteShare: number | null;
}
export interface StockUseResult {
  days: number;
  /** every item used, by what was used */
  items: StockItem[];
  /** the top 10 by days left (soonest out first) and by wastage share; and how many qualified for each */
  runOut: StockItem[]; runOutTotal: number;
  wasted: StockItem[]; wastedTotal: number;
  /** on hand is known (one branch in view) */
  onHandKnown: boolean;
  /** why days left is missing (every branch in view) */
  note: string | null;
  covers: string;
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/** The stock use rows → each item's use, use a day, days left (one branch) and wastage share; the two top-10 lists. */
export function summariseStockUse(rows: StockUseRow[], days: number, onHandKnown: boolean, note: string | null = null): StockUseResult {
  const d = Math.max(1, days);
  const items: StockItem[] = (rows ?? []).map((r): StockItem => {
    const sold = Math.max(0, n0(r.sold)), wasted = Math.max(0, n0(r.wasted));
    const used = sold + wasted;
    const prevUsed = Math.max(0, n0(r.prev_sold)) + Math.max(0, n0(r.prev_wasted));
    const raw = r.on_hand === null || r.on_hand === undefined ? null : n0(r.on_hand);
    const onHand = onHandKnown && raw !== null && raw >= 0 ? r2(raw) : null;
    const perDay = used / d;
    return {
      kind: r.kind === 'ingredient' ? 'ingredient' : 'product', id: r.item_id, name: r.item_name || 'Unnamed item', unit: r.unit ?? null,
      used: r4(used), sold: r4(sold), wasted: r4(wasted), prevUsed: r4(prevUsed), change: pctChange(used, prevUsed),
      perDay: r4(perDay), onHand, daysLeft: onHand !== null && perDay > 0 ? r1(onHand / perDay) : null,
      wasteShare: used > 0 ? r4(wasted / used) : null,
    };
  }).filter((x) => x.used > 0 || x.prevUsed > 0)
    .sort((a, b) => b.used - a.used || a.name.localeCompare(b.name));
  const runAll = items.filter((x) => x.daysLeft !== null).sort((a, b) => (a.daysLeft as number) - (b.daysLeft as number) || b.perDay - a.perDay || a.name.localeCompare(b.name));
  const wasteAll = items.filter((x) => x.wasted > 0).sort((a, b) => (b.wasteShare ?? 0) - (a.wasteShare ?? 0) || b.wasted - a.wasted || a.name.localeCompare(b.name));
  return {
    days: d, items, runOut: runAll.slice(0, TABLE_TOP), runOutTotal: runAll.length, wasted: wasteAll.slice(0, TABLE_TOP), wastedTotal: wasteAll.length,
    onHandKnown, note: onHandKnown ? null : note, covers: STOCK_COVERS,
  };
}

const unitText = (it: { unit: string | null }) => (it.unit ? ` ${it.unit}` : '');
/** "about 2 days" — never "0 days" for an item still on the shelf. */
export function daysLeftText(daysLeft: number): string {
  const n = Math.max(1, Math.round(daysLeft));
  return `about ${n} ${n === 1 ? 'day' : 'days'}`;
}

/**
 * "Tusker lager runs out in about 2 days at your current rate — order now": an item (product or ingredient) whose stock
 * at the branch in view lasts under 3 days at this period's average use a day (sales + wastage), used ≥ 5 in the
 * period, ≥ 7 days of data. What to order: a week's worth (7 days of use + 10%, rounded up) less what is on hand. No KES.
 */
export function recRunOut(i: RecInput): Recommendation[] {
  const s = i.stockUse;
  if (!s || !s.onHandKnown || i.days < STOCK_USE_MIN_DAYS) return [];
  return s.items.filter((x) => x.daysLeft !== null && x.daysLeft < STOCK_OUT_DAYS && x.used >= STOCK_OUT_MIN_USED && x.perDay > 0)
    .sort((a, b) => (a.daysLeft as number) - (b.daysLeft as number) || b.perDay - a.perDay || a.name.localeCompare(b.name))
    .slice(0, STOCK_OUT_TOP).map((x): Recommendation => {
      const onHand = x.onHand as number;
      const need = stockQty(x.perDay * STOCK_WEEK_DAYS);
      const order = Math.max(0, Math.ceil(need - onHand - 1e-9));
      const title = onHand <= 0 ? `${x.name} has run out — order now`
        : `${x.name} runs out in ${daysLeftText(x.daysLeft as number)} at your current rate — order now`;
      return {
        id: `stock_out.${x.kind}.${x.id ?? x.name}`, kind: 'stock_out', title,
        why: `You have ${qtyText(onHand)}${unitText(x)} left and use about ${qtyText(r1(x.perDay))} a day (${qtyText(r1(x.used))} in ${i.days} days${x.wasted > 0 ? `, ${qtyText(r1(x.wasted))} of it thrown away` : ''}).`,
        impact: null, impactPer: null, impactKind: null, warning: false,
        stock: { by: 'a week', items: [{ name: x.name, qty: need, onHand, order }] },
        assumption: 'At this period\'s average use a day (sales and wastage), with the stock level as the cloud has it now; a week\'s worth is 7 days of use plus 10%, rounded up.',
        confidence: i.days >= 14 ? 'high' : 'medium', evidence: 'stock',
      };
    });
}

/** "You throw away 20% of your milk — …": 15% or more of what an item used was thrown away (≥ 5, ≥ 7 days). One card. */
export function recWastage(i: RecInput): Recommendation[] {
  const s = i.stockUse;
  if (!s || i.days < STOCK_USE_MIN_DAYS) return [];
  const bad = s.items.filter((x) => (x.wasteShare ?? 0) >= WASTE_MIN_SHARE - 1e-9 && x.wasted >= WASTE_MIN_QTY)
    .sort((a, b) => (b.wasteShare ?? 0) - (a.wasteShare ?? 0) || b.wasted - a.wasted || a.name.localeCompare(b.name));
  if (!bad.length) return [];
  const top = bad[0];
  const others = bad.slice(1, 3).map((x) => `${x.name} (${pctText(x.wasteShare ?? 0)})`);
  const more = bad.length - 1 - others.length;
  return [{
    id: `wastage.${top.kind}.${top.id ?? top.name}`, kind: 'wastage',
    title: `You throw away ${pctText(top.wasteShare ?? 0)} of your ${top.name} — order less at a time or check how it is stored`,
    why: `${qtyText(r1(top.wasted))}${unitText(top)} of the ${qtyText(r1(top.used))} used in ${i.days} days went to wastage.`
      + (others.length ? ` Also high: ${andList(more > 0 ? [...others, `${more} more`] : others)}.` : ''),
    impact: null, impactPer: null, impactKind: null, stock: null, warning: false,
    assumption: 'From the wastage your staff wrote off; no KES estimate — less waste means less to buy.',
    confidence: top.used >= 20 ? 'high' : 'medium', evidence: 'stock',
  }];
}

// ── A561: who comes back ──────────────────────────────────────────────────────

export const CUSTOMER_COVERAGE_LOW = 0.2;   // under 20% of orders with a customer: say so
export const REGULAR_MIN_VISITS = 4;        // a regular: at least 4 visits in the 90 days to the period's end
export const REGULAR_MAX_GAP = 15;          // …about every two weeks or more often (at least 2 a month)
export const LAPSED_MULTIPLE = 2;           // gone quiet: no visit for twice their usual gap
export const LAPSED_MIN_DAYS = 14;          // …and at least two weeks
export const LAPSED_NAMED = 3;

export interface CustomerAggRow {
  kind: string; which: string | null; day: string | null; order_type: string | null; orders: number | string | null; sales: number | string | null;
  linked_orders: number | string | null; linked_sales: number | string | null; customers: number | string | null; new_customers: number | string | null;
  customer_id: string | null; customer_name: string | null; phone: string | null; visits: number | string | null; spend: number | string | null;
  prev_visits: number | string | null; visits_90: number | string | null; first_90: string | null; last_visit: string | null;
}
export interface PeriodCustomers { orders: number; sales: number; linkedOrders: number; linkedSales: number; customers: number; newCustomers: number; returning: number }
export interface CustomerLine {
  customerId: string; name: string; phone: string | null; visits: number; spend: number; lastVisit: string | null;
  visits90: number; gap: number | null; regular: boolean; daysSince: number | null;
}
export type OrderTypeKey = 'dine_in' | 'takeaway' | 'delivery' | 'other';
export const ORDER_TYPES: { key: OrderTypeKey; label: string }[] = [
  { key: 'dine_in', label: 'Dine-in' }, { key: 'takeaway', label: 'Takeaway' }, { key: 'delivery', label: 'Delivery' }, { key: 'other', label: 'Counter and other' },
];
export interface MixBucket { from: string; to: string; orders: Record<OrderTypeKey, number>; total: number; sales: number; avgBill: number | null }
export interface CustomersResult {
  customersHidden: boolean;
  now: PeriodCustomers; prev: PeriodCustomers;
  change: { customers: number | null; newCustomers: number | null; returning: number | null };
  coverage: { share: number | null; low: boolean; note: string | null };
  /** the top 10 by spend; how many customers came in the period */
  top: CustomerLine[]; totalCustomers: number;
  frequency: { regulars: number; medianGap: number | null };
  /** regulars gone quiet, the best regulars first */
  lapsed: CustomerLine[];
  avgBill: { customer: number | null; walkIn: number | null };
  /** the order-type mix and the average bill, per day (≤ 31 days) or per 7-day block */
  mix: MixBucket[]; byWeek: boolean;
  mixTotals: { key: OrderTypeKey; label: string; orders: number; share: number }[];
  asOf: string;
}

/** An order type (free text) → one of the four groups the mix shows. */
export function orderTypeGroup(t: string | null | undefined): OrderTypeKey {
  const s = String(t ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (s === 'dine_in' || s === 'dinein' || s === 'table') return 'dine_in';
  if (s === 'takeaway' || s === 'take_away' || s === 'pickup' || s === 'collection') return 'takeaway';
  if (s === 'delivery') return 'delivery';
  return 'other';
}
const daysFrom = (a: string, b: string) => (rangeDays(a, b) ?? 1) - 1;   // b − a in days
const emptyPeriod = (): PeriodCustomers => ({ orders: 0, sales: 0, linkedOrders: 0, linkedSales: 0, customers: 0, newCustomers: 0, returning: 0 });

/**
 * Who comes back: new against returning in this and the previous period, the top 10 by spend, how often regulars come,
 * the regulars gone quiet, the average bill with a customer against a walk-in, and the order-type mix over the period.
 * `asOf` (a business date): the end of the period, or today when the period runs past it.
 */
export function summariseCustomers(rows: CustomerAggRow[], from: string, to: string, asOf: string, customersHidden = false): CustomersResult {
  const pe = { now: emptyPeriod(), prev: emptyPeriod() };
  for (const r of (rows ?? []).filter((x) => x.kind === 'period')) {
    const p = r.which === 'prev' ? pe.prev : pe.now;
    p.orders = n0(r.orders); p.sales = r2(n0(r.sales)); p.linkedOrders = n0(r.linked_orders); p.linkedSales = r2(n0(r.linked_sales));
    p.customers = n0(r.customers); p.newCustomers = n0(r.new_customers); p.returning = Math.max(0, p.customers - p.newCustomers);
  }
  const share = pe.now.orders > 0 ? r4(pe.now.linkedOrders / pe.now.orders) : null;
  const low = share !== null && share < CUSTOMER_COVERAGE_LOW;
  const note = share !== null && low
    ? `Only ${pctText(share)} of your sales are linked to a customer, so these trends cover your account and loyalty customers only.` : null;

  const lines: CustomerLine[] = (rows ?? []).filter((x) => x.kind === 'customer' && x.customer_id).map((r): CustomerLine => {
    const v90 = n0(r.visits_90);
    const last = r.last_visit ? String(r.last_visit).slice(0, 10) : null;
    const first90 = r.first_90 ? String(r.first_90).slice(0, 10) : null;
    const gap = v90 >= 2 && first90 && last ? r1(daysFrom(first90, last) / (v90 - 1)) : null;
    return {
      customerId: r.customer_id as string, name: r.customer_name || 'Unnamed customer', phone: r.phone ?? null,
      visits: n0(r.visits), spend: r2(n0(r.spend)), lastVisit: last, visits90: v90, gap,
      regular: v90 >= REGULAR_MIN_VISITS && gap !== null && gap <= REGULAR_MAX_GAP,
      daysSince: last ? Math.max(0, daysFrom(last, asOf)) : null,
    };
  });
  const top = lines.filter((c) => c.visits > 0).sort((a, b) => b.spend - a.spend || b.visits - a.visits || a.name.localeCompare(b.name)).slice(0, TABLE_TOP);
  const regulars = lines.filter((c) => c.regular);
  const lapsed = regulars.filter((c) => c.daysSince !== null && c.daysSince > LAPSED_MULTIPLE * (c.gap as number) && c.daysSince >= LAPSED_MIN_DAYS)
    .sort((a, b) => b.visits90 - a.visits90 || (b.daysSince ?? 0) - (a.daysSince ?? 0) || a.name.localeCompare(b.name));

  // the order-type mix and the average bill: per day (≤ 31 days), else per 7-day block from the period's start
  const days = datesIn(from, to);
  const byWeek = days.length > 31;
  const step = byWeek ? 7 : 1;
  const buckets: MixBucket[] = [];
  for (let k = 0; k < days.length; k += step) {
    buckets.push({ from: days[k], to: days[Math.min(days.length - 1, k + step - 1)], orders: { dine_in: 0, takeaway: 0, delivery: 0, other: 0 }, total: 0, sales: 0, avgBill: null });
  }
  const totals: Record<OrderTypeKey, number> = { dine_in: 0, takeaway: 0, delivery: 0, other: 0 };
  for (const r of (rows ?? []).filter((x) => x.kind === 'type' && x.day)) {
    const idx = rangeDays(from, String(r.day).slice(0, 10));
    if (idx === null || idx < 1 || idx > days.length) continue;
    const b = buckets[Math.floor((idx - 1) / step)];
    const g = orderTypeGroup(r.order_type);
    b.orders[g] += n0(r.orders); b.total += n0(r.orders); b.sales += n0(r.sales); totals[g] += n0(r.orders);
  }
  for (const b of buckets) { b.sales = r2(b.sales); b.avgBill = b.total > 0 ? r2(b.sales / b.total) : null; }
  const allOrders = Object.values(totals).reduce((s, v) => s + v, 0);
  const walkOrders = pe.now.orders - pe.now.linkedOrders;
  const out: CustomersResult = {
    customersHidden: false, now: pe.now, prev: pe.prev,
    change: {
      customers: pctChange(pe.now.customers, pe.prev.customers), newCustomers: pctChange(pe.now.newCustomers, pe.prev.newCustomers),
      returning: pctChange(pe.now.returning, pe.prev.returning),
    },
    coverage: { share, low, note },
    top, totalCustomers: pe.now.customers,
    frequency: { regulars: regulars.length, medianGap: median(regulars.map((c) => c.gap as number)) },
    lapsed,
    avgBill: {
      customer: pe.now.linkedOrders > 0 ? r2(pe.now.linkedSales / pe.now.linkedOrders) : null,
      walkIn: walkOrders > 0 ? r2((pe.now.sales - pe.now.linkedSales) / walkOrders) : null,
    },
    mix: buckets, byWeek,
    mixTotals: ORDER_TYPES.map((t) => ({ ...t, orders: totals[t.key], share: allOrders > 0 ? r4(totals[t.key] / allOrders) : 0 })).filter((t) => t.orders > 0),
    asOf,
  };
  return customersHidden ? customersWithheld(out) : out;
}
/** Without customers.view / customers.credit: the order-type mix and the average bill stay (no customer in them). */
export function customersWithheld(c: CustomersResult): CustomersResult {
  return {
    ...c, customersHidden: true, top: [], lapsed: [], totalCustomers: 0, frequency: { regulars: 0, medianGap: null },
    change: { customers: null, newCustomers: null, returning: null }, coverage: { share: null, low: false, note: null },
    avgBill: { customer: null, walkIn: null },
    now: { ...emptyPeriod(), orders: c.now.orders, sales: c.now.sales }, prev: { ...emptyPeriod(), orders: c.prev.orders, sales: c.prev.sales },
  };
}

/**
 * "5 regulars have not been back in over 3 weeks — call or message them": regulars (≥ 4 visits in 90 days, about every
 * two weeks or more often) with no visit for twice their usual gap and at least two weeks. Three names in the card, then
 * "N more"; the Customers tab lists them (10 at a time). No KES estimate.
 */
export function recLapsed(i: RecInput): Recommendation[] {
  const c = i.customers;
  if (!c || c.customersHidden || !c.lapsed.length) return [];
  const n = c.lapsed.length;
  const minSince = Math.min(...c.lapsed.map((x) => x.daysSince ?? 0));
  const weeks = Math.floor(minSince / 7);
  const named = c.lapsed.slice(0, LAPSED_NAMED).map((x) => `${x.name} (usually every ${qtyText(Math.round(x.gap ?? 0))} days, last came ${x.daysSince} days ago)`);
  const more = n - named.length;
  return [{
    id: 'lapsed.regulars', kind: 'lapsed',
    title: n === 1 ? `${c.lapsed[0].name}, a regular, has not been back in ${c.lapsed[0].daysSince} days — call or message them`
      : `${n} regulars have not been back in over ${weeks} weeks — call or message them`,
    why: `${andList(more > 0 ? [...named, `${more} more`] : named)}.`,
    impact: null, impactPer: null, impactKind: null, stock: null, warning: false,
    assumption: `A regular: at least ${REGULAR_MIN_VISITS} visits in the last 90 days, about every two weeks or more often; gone quiet: no visit for twice their usual gap and at least two weeks. No KES estimate.`,
    confidence: 'medium', evidence: 'customers',
  }];
}

// ── A561: what each sale really earns ─────────────────────────────────────────

export const FOOD_COST_RISE = 0.02;      // a food-cost card when it rose 2 points or more
export const THIN_MIN_QTY = 5;           // the thinnest-margin table: items sold at least 5
export const THIN_MAX = 0.2;             // a thin-margin card under 20% …
export const THIN_CARD_MIN_QTY = 10;     // … sold at least 10
export const COST_RISE_MIN = 0.05;       // a cost-rise card when an ingredient's cost rose 5% or more
export const NO_COST_BANNER = 0.05;      // the page's call-out when 5% or more of sales have no cost

export interface CostWatchRow {
  kind: string; item_id: string | null; item_name: string | null; unit: string | null; cost_start: number | string | null; cost_end: number | string | null;
  changes: number | string | null; used_in: number | string | null; delta: number | string | null; cost_now: number | string | null; names: string[] | null;
}
export interface ThinItem { productId: string | null; name: string; qty: number; avgPrice: number; unitCost: number; unitMargin: number; marginPct: number; topIngredient: string | null }
export interface CostRise {
  ingredientId: string | null; name: string; unit: string | null; from: number; to: number; change: number; changes: number; usedIn: number;
  products: { name: string; delta: number; qty: number; extra: number }[]; extraMonth: number;
}
export interface NoCostItem { productId: string | null; name: string; category: string | null; qty: number; revenue: number }
export interface CostsResult {
  days: number;
  foodCost: { now: number | null; prev: number | null; change: number | null; costedShare: number | null; movers: { name: string; now: number; prev: number }[] };
  thin: ThinItem[]; thinTotal: number;
  rises: CostRise[]; risesTotal: number; historyNote: string;
  noCost: { items: NoCostItem[]; total: number; revenue: number; share: number | null; unsold: number; unsoldNames: string[] };
}
/** Food cost: the cost of what was sold ÷ what it sold for, over the items with a cost (1 − the gross margin). */
export const foodCostOf = (m: MenuResult | null) => { const g = grossMarginPct(m); return g === null ? null : r4(1 - g); };
/** The share of the period's item sales with no cost (null without costs or sales). */
export function noCostShare(m: MenuResult | null): { share: number | null; items: number; revenue: number } {
  if (!m || m.costsHidden || m.totals.revenue <= 0) return { share: null, items: 0, revenue: 0 };
  const none = m.items.filter((x) => x.unitCost === null);
  const revenue = r2(none.reduce((s, x) => s + x.revenue, 0));
  return { share: r4(revenue / m.totals.revenue), items: none.length, revenue };
}

/** Costs and margins (seesCosts only): food cost now and before, the thinnest margins, ingredient cost rises, items with no cost. */
export function buildCosts(input: { menu: MenuResult; menuPrev: MenuResult | null; watch: CostWatchRow[]; days: number }): CostsResult {
  const { menu: m, menuPrev: mp, days } = input;
  const w = input.watch ?? [];
  const now = foodCostOf(m), prev = foodCostOf(mp);
  const costed = m.items.filter((x) => x.unitCost !== null);
  const costedRev = costed.reduce((s, x) => s + x.revenue, 0);
  const prevCosted = (mp?.items ?? []).filter((x) => x.unitCost !== null);
  const prevRev = prevCosted.reduce((s, x) => s + x.revenue, 0);
  const key = (x: { productId: string | null; name: string }) => x.productId ?? `name:${x.name}`;
  // a mover: an item whose cost took a bigger share of the costed sales than before (its mix or its selling level moved)
  const prevShare = new Map(prevCosted.map((x) => [key(x), prevRev > 0 ? ((x.unitCost as number) * x.qty) / prevRev : 0]));
  const movers = costed.map((x) => ({ name: x.name, now: costedRev > 0 ? ((x.unitCost as number) * x.qty) / costedRev : 0, prev: prevShare.get(key(x)) ?? 0 }))
    .filter((x) => x.now - x.prev > 0.001).sort((a, b) => (b.now - b.prev) - (a.now - a.prev) || a.name.localeCompare(b.name)).slice(0, 3)
    .map((x) => ({ name: x.name, now: r4(x.now), prev: r4(x.prev) }));
  const topIng = new Map(w.filter((r) => r.kind === 'top_ingredient' && r.item_id).map((r) => [r.item_id as string, r.item_name ?? null]));
  const thinAll = costed.filter((x) => x.qty >= THIN_MIN_QTY && x.avgPrice > 0).map((x): ThinItem => ({
    productId: x.productId, name: x.name, qty: x.qty, avgPrice: x.avgPrice, unitCost: x.unitCost as number, unitMargin: x.unitMargin as number,
    marginPct: r4((x.unitMargin as number) / x.avgPrice), topIngredient: x.productId ? topIng.get(x.productId) ?? null : null,
  })).sort((a, b) => a.marginPct - b.marginPct || b.qty - a.qty || a.name.localeCompare(b.name));
  const qtyOf = new Map(m.items.filter((x) => x.productId).map((x) => [x.productId as string, x.qty]));
  const productRows = w.filter((r) => r.kind === 'product' && r.item_id);
  const risesAll = w.filter((r) => r.kind === 'ingredient' && n0(r.cost_start) > 0 && n0(r.cost_end) > n0(r.cost_start)).map((r): CostRise => {
    const from = n0(r.cost_start), to = n0(r.cost_end);
    return {
      ingredientId: r.item_id, name: r.item_name || 'Unnamed ingredient', unit: r.unit ?? null, from: r4(from), to: r4(to), change: r4((to - from) / from),
      changes: n0(r.changes), usedIn: n0(r.used_in), products: [], extraMonth: 0,
    };
  }).sort((a, b) => b.change - a.change || a.name.localeCompare(b.name));
  // a product row is one product × one moved ingredient: what that ingredient's rise adds to one serving
  for (const rise of risesAll) {
    for (const p of productRows) {
      const delta = n0(p.delta);
      if (delta <= 0 || !(p.names ?? []).includes(rise.ingredientId ?? '')) continue;
      const qty = qtyOf.get(p.item_id as string) ?? 0;
      rise.products.push({ name: p.item_name || 'Unnamed item', delta: r2(delta), qty, extra: r2(delta * qty) });
    }
    rise.products.sort((a, b) => b.qty - a.qty || a.name.localeCompare(b.name));
    rise.extraMonth = Math.round(perMonth(rise.products.reduce((s, x) => s + x.extra, 0), days));
  }
  const none = m.items.filter((x) => x.unitCost === null).sort((a, b) => b.revenue - a.revenue || a.name.localeCompare(b.name));
  const unsold = w.find((r) => r.kind === 'unsold_no_cost');
  const nc = noCostShare(m);
  return {
    days,
    foodCost: { now, prev, change: now === null || prev === null ? null : r4(now - prev), costedShare: m.totals.revenue > 0 ? r4(costedRev / m.totals.revenue) : null, movers },
    thin: thinAll.slice(0, TABLE_TOP), thinTotal: thinAll.length,
    rises: risesAll.slice(0, TABLE_TOP), risesTotal: risesAll.length,
    historyNote: 'Cost changes come from ingredient cost edits and delivery notes. An item\'s own cost keeps no history, so a change to it is not seen here.',
    noCost: {
      items: none.slice(0, TABLE_TOP).map((x) => ({ productId: x.productId, name: x.name, category: x.category, qty: x.qty, revenue: x.revenue })),
      total: none.length, revenue: nc.revenue, share: nc.share,
      unsold: n0(unsold?.changes), unsoldNames: (unsold?.names ?? []).filter(Boolean),
    },
  };
}

/** "Your food cost rose from 31% to 35% — check the biggest movers". Impact = the rise × the costed sales, a month. */
export function recFoodCost(i: RecInput): Recommendation[] {
  const c = i.costWatch; const m = menuReady(i);
  if (!c || !m) return [];
  const f = c.foodCost;
  if (f.now === null || f.prev === null || f.change === null || f.change < FOOD_COST_RISE - 1e-9) return [];
  const costedRev = m.items.filter((x) => x.unitCost !== null).reduce((s, x) => s + x.revenue, 0);
  const names = f.movers.map((x) => x.name);
  const w = analyticsWords(i.businessType); const food = w.costOfSales === 'Food cost';   // A575: a shop's own words
  const cos = w.costOfSales.toLowerCase();
  return [{
    id: 'food_cost.rise', kind: 'food_cost',
    title: `Your ${cos} rose from ${pctText(f.prev)} to ${pctText(f.now)} — check the biggest movers`,
    why: names.length ? (food ? `The biggest movers are ${andList(names)}: they took a bigger share of what you spend on food. Check their portions and what you pay for them.`
      : `The biggest movers are ${andList(names)}: they took a bigger share of what your stock costs. Check what you pay for them.`)
      : food ? 'Check the portions of your best sellers and what you pay for them.' : 'Check what you pay for your best sellers.',
    impact: Math.round(perMonth(f.change * costedRev, i.days)), impactPer: 'month', impactKind: 'recover', stock: null, warning: false,
    assumption: `If your ${cos} goes back to ${pctText(f.prev)} of what these items sell for. Both periods use today's costs, so the change comes from what sold and what it sold for; cost rises show on the Costs tab.`,
    confidence: 'low', evidence: 'costs',
  }];
}

/** "Chips masala earns 12% — check the portion or the oil cost": the best seller (≥ 10 sold) earning under 20%. No KES. */
export function recThinMargin(i: RecInput): Recommendation[] {
  const c = i.costWatch; const m = menuReady(i);
  if (!c || !m) return [];
  const cur = i.currency || 'KES';
  const thin = c.thin.filter((x) => x.marginPct < THIN_MAX && x.qty >= THIN_CARD_MIN_QTY).sort((a, b) => b.qty - a.qty || a.marginPct - b.marginPct);
  if (!thin.length) return [];
  const t = thin[0];
  const others = thin.slice(1, 3).map((x) => `${x.name} (${pctText(Math.max(0, x.marginPct))})`);
  return [{
    id: `thin.${t.productId ?? t.name}`, kind: 'thin_margin',
    title: `${t.name} earns ${pctText(Math.max(0, t.marginPct))} — check the portion or ${t.topIngredient ? `the ${t.topIngredient.toLowerCase()} cost` : 'what goes into it'}`,
    why: `Of every ${moneyText(t.avgPrice, cur)} it sells for, ${moneyText(Math.max(0, t.unitMargin), cur)} is left after its cost (${qtyText(t.qty)} sold in ${i.days} days).`
      + (others.length ? ` Also thin: ${andList(others)}.` : ''),
    impact: null, impactPer: null, impactKind: null, stock: null, warning: false,
    assumption: 'No KES estimate: what it earns = what it sells for less the cost of one serving (its own cost, else the recipe).',
    confidence: 'medium', evidence: 'costs',
  }];
}

/** "Compare suppliers for cooking oil: its cost rose 25%": the rise (≥ 5%) that costs the most a month in what you sell. */
export function recCostRise(i: RecInput): Recommendation[] {
  const c = i.costWatch;
  if (!c || !i.costs || i.days < MENU_MIN_DAYS) return [];
  const cur = i.currency || 'KES';
  const r = c.rises.filter((x) => x.change >= COST_RISE_MIN - 1e-9 && x.extraMonth > 0).sort((a, b) => b.extraMonth - a.extraMonth || b.change - a.change)[0];
  if (!r) return [];
  const names = r.products.map((p) => p.name);
  const shown = names.slice(0, 2);
  return [{
    id: `cost_rise.${r.ingredientId ?? r.name}`, kind: 'cost_rise',
    title: `Compare suppliers for ${r.name}: its cost rose ${pctText(r.change)}`,
    why: `${r.name} went from ${costText(r.from, cur)} to ${costText(r.to, cur)}${r.unit ? ` a ${r.unit}` : ''} this period; ${andList(names.length > 2 ? [...shown, `${names.length - 2} more`] : shown)} now ${names.length === 1 ? 'costs' : 'cost'} more to make.`,
    impact: r.extraMonth, impactPer: 'month', impactKind: 'recover', stock: null, warning: false,
    assumption: 'If you find it at the old cost again: the extra cost of one serving × what you sell a month.',
    confidence: 'medium', evidence: 'costs',
  }];
}

// ── A561: the tiles' hooks ────────────────────────────────────────────────────

export type TileKey = 'menu' | 'heatmap' | 'leaks' | 'credit' | 'stock' | 'branches' | 'customers' | 'costs';
export interface TileHook { text: string; alert: boolean; hidden: boolean }
const TILE_OF: Partial<Record<RecKind, TileKey>> = {
  promote: 'menu', rework: 'menu', slow: 'menu', staffing: 'heatmap', quiet: 'heatmap', leak: 'leaks', day_close: 'leaks', credit: 'credit',
  stock_low: 'stock', stock_out: 'stock', stock_up: 'stock', wastage: 'stock', lapsed: 'customers',
  cost: 'costs', food_cost: 'costs', thin_margin: 'costs', cost_rise: 'costs', stock_move: 'branches', branch_drop: 'branches',
};
const DAY3 = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
/**
 * One live figure per area for its tile ("4 stars · 2 dogs", "Busiest: Sat 19:00", "1 cashier to check", …) and whether
 * a card or a warning points there (`recommendations`: every card the rules give, allRecommendations — not only the 7
 * "Do this next" keeps). A tile the person may not open is hidden (costs, credit).
 */
export function tileHooks(input: {
  costs: boolean; seesCredit: boolean; currency?: string;
  menu: MenuResult | null; heatmap: HeatmapResult | null; leaks: LeaksResult | null; credit: CreditResult | null;
  stockUse: StockUseResult | null; customers: CustomersResult | null; costWatch: CostsResult | null; recommendations: Recommendation[];
  /** without costs (no menu worked out): how many items sold, from what sells when */
  itemsSold?: number | null;
  /** A575: the business type — a shop's "Cost of sales", a restaurant's "Food cost" */
  businessType?: string | null;
  /** A565: the Branches tile — null (one branch, or a viewer held to one): hidden */
  branches?: { count: number; moves: number; underperforming: { name: string; change: number | null }[] } | null;
}): Record<TileKey, TileHook> {
  const cur = input.currency || 'KES';
  const alert = new Set(input.recommendations.map((r) => TILE_OF[r.kind]).filter(Boolean) as TileKey[]);
  const hook = (k: TileKey, text: string, hidden = false): TileHook => ({ text, alert: !hidden && alert.has(k), hidden });
  const m = input.menu;
  const sold = m ? m.totals.items : input.itemsSold ?? 0;
  const menuText = !sold ? 'No items sold yet'
    : m && input.costs && !m.costsHidden && m.avgUnitMargin !== null ? `${plural(m.counts.star, 'star', 'stars')} · ${plural(m.counts.dog, 'dog', 'dogs')}`
    : `${plural(sold, 'item', 'items')} sold`;
  const h = input.heatmap;
  const heatText = h?.busiest ? `Busiest: ${DAY3[h.busiest.dow]} ${hh(h.busiest.startHour)}` : 'No sales yet';
  const flagged = input.leaks ? input.leaks.cashiers.filter((c) => c.flags.length).length : 0;
  const leakText = flagged ? `${plural(flagged, 'cashier', 'cashiers')} to check` : 'Nobody flagged';
  const c = input.credit;
  const creditText = !c ? 'Who owes you' : c.over60.amount > 0 ? `${moneyText(c.over60.amount, cur)} over 60 days`
    : c.totals.owed > 0 ? `${moneyText(c.totals.owed, cur)} owed` : 'Nobody owes you';
  const s = input.stockUse;
  const soon = s ? s.items.filter((x) => x.daysLeft !== null && x.daysLeft < 7 && x.perDay > 0).length : 0;
  const stockText = !s ? 'How fast stock goes' : !s.onHandKnown ? (s.items.length ? `${plural(s.items.length, 'item', 'items')} used` : 'No stock tracked')
    : soon ? `${plural(soon, 'item runs', 'items run')} out this week` : s.items.length ? 'Nothing runs out this week' : 'No stock tracked';
  const cu = input.customers;
  const custText = !cu ? 'Who comes back' : cu.customersHidden ? 'Order types and average bill'
    : cu.lapsed.length ? `${plural(cu.lapsed.length, 'regular', 'regulars')} gone quiet`
    : `${plural(cu.now.returning, 'customer', 'customers')} came back`;
  const cw = input.costWatch;
  const costText = !cw ? 'What each sale earns' : cw.noCost.total ? `${plural(cw.noCost.total, 'item has', 'items have')} no cost`
    : cw.foodCost.now !== null ? `${analyticsWords(input.businessType).costOfSales} ${pctText(cw.foodCost.now)}` : 'What each sale earns';
  return {
    menu: hook('menu', menuText), heatmap: hook('heatmap', heatText), leaks: hook('leaks', leakText),
    credit: hook('credit', creditText, !input.seesCredit), stock: hook('stock', stockText),
    branches: hook('branches', branchText(input.branches ?? null), !input.branches),
    customers: hook('customers', custText), costs: hook('costs', costText, !input.costs),
  };
}

// ── A565: between branches ────────────────────────────────────────────────────
//
// The owner (2026-10-22): "also under analytics if there are several branches it can suggest items movement since branch
// A is not performing"; then: "it should be a recommendation so it should not show number something like product x sells
// well in shop b than A, or items in shop c are moving slow unlike in shop d which sells 10 items in a day and their stock
// levels are low you can move some items to the shop". So the maths below DECIDES which moves to suggest and ranks them;
// what is shown is a plain recommendation in words (a daily rate at most) — never a quantity, never a KES estimate.
// Only for a viewer who sees every branch (the owner, an A550 partner of every branch) with two or more active branches.

export const BRANCH_MIN_DAYS = 14;        // no move or branch flag on less than two weeks
export const MAX_BRANCHES = 10;           // the comparison (and the work behind it) covers 10 branches at most
export const MOVE_SHORT_DAYS = 3;         // short: under 3 days of its own sales on hand …
export const MOVE_FAST_DAYS = 7;          // … or under a week while it sells ≥ 2× the other branches' median a day
export const MOVE_FAST_MULTIPLE = 2;
export const MOVE_MIN_USED = 10;          // the short branch used at least 10 in the period
export const MOVE_SURPLUS_DAYS = 30;      // surplus: over 30 days of its own sales on hand …
export const MOVE_SURPLUS_MEDIAN = 3;     // … or over 3× the median cover of the branches that sell it
export const MOVE_SURPLUS_MIN = 10;       // … and at least 10 on hand
export const MOVE_TARGET_DAYS = 7;        // internal: a move would bring the short branch to about a week
export const MOVE_KEEP_DAYS = 14;         // internal: never leave the surplus branch under two weeks of its own sales
export const MOVE_MIN_QTY = 3;            // internal: a move worth suggesting is at least 3 units
export const MOVE_TOP = 3;                // movement cards at most in "Do this next"
export const MOVE_GROUP = 3;              // items named in one card (same two branches, same way)
export const BRANCH_DROP = 0.2;           // underperforming: sales down 20% or more on its own previous period …
export const BRANCH_GAP = 0.1;            // … and at least 10 points worse than the other branches together
export const BRANCH_MIN_PREV_ORDERS = 30; // a previous period with at least 30 bills to compare against
export const BRANCH_DROP_TOP = 2;
export const BRANCH_BASIS = 'Each branch is compared with its own previous period: it is flagged when its sales fall 20% or more and at least 10 points more than the other branches together. So a small branch is never flagged for being small, and a quiet month for everyone flags no branch.';
export const MOVE_BASIS = 'A suggestion, not an order: how much to move is your call or your manager\'s. From this period\'s sales and wastage and the stock levels now. Running low means under about 3 days of its own sales (or under a week while it sells at least twice what the other branches do); plenty means over a month of its own sales, keeping at least two weeks after a move.';

export interface BranchInfo { id: string; name: string }
/** A stock level at a branch from a plain read — an item a branch did not use in either period is not in its use rows. */
export interface BranchLevel { kind: 'product' | 'ingredient'; itemId: string; branchId: string; onHand: number }
/** Internal: one possible move, with the quantity and the covers that decide and rank it (never sent to the page). */
export interface StockMove {
  kind: 'product' | 'ingredient'; itemId: string; name: string;
  fromId: string; from: string; toId: string; to: string;
  qty: number; score: number;
  source: { perDay: number; cover: number | null };
  target: { perDay: number; cover: number; fast: boolean };
}
/** What the page sees of a move: the items and the two branches — no quantity. */
export interface MoveLine { fromId: string; from: string; toId: string; to: string; items: { kind: 'product' | 'ingredient'; itemId: string; name: string }[] }
/** A grouped suggestion (one card, one row of the Branches area): 1–3 items moving the same way between two branches. */
export interface MoveSuggestion { id: string; move: MoveLine; title: string; why: string; score: number }

interface ItemAtBranch { branchId: string; branch: string; onHand: number | null; used: number }
interface ItemAcross { kind: 'product' | 'ingredient'; itemId: string; name: string; at: Map<string, ItemAtBranch> }

/** A quantity to a sensible step (1 under 20, 5 under 100, else 10) — up for what is needed, down for what can go. */
export function stepRound(x: number, up: boolean): number {
  const v = Math.max(0, x);
  const step = v < 20 ? 1 : v < 100 ? 5 : 10;
  return up ? Math.ceil(v / step - 1e-9) * step : Math.floor(v / step + 1e-9) * step;
}

function itemsAcross(branches: BranchInfo[], stock: Record<string, StockUseResult | null>, levels: BranchLevel[] = []): ItemAcross[] {
  const map = new Map<string, ItemAcross>();
  for (const b of branches) {
    for (const x of stock[b.id]?.items ?? []) {
      if (!x.id) continue;
      const k = `${x.kind}.${x.id}`;
      const it = map.get(k) ?? { kind: x.kind, itemId: x.id, name: x.name, at: new Map() };
      it.at.set(b.id, { branchId: b.id, branch: b.name, onHand: x.onHand, used: x.used });
      map.set(k, it);
    }
  }
  for (const l of levels) {
    const it = map.get(`${l.kind}.${l.itemId}`);
    const b = branches.find((x) => x.id === l.branchId);
    if (!it || !b || !Number.isFinite(l.onHand) || l.onHand < 0) continue;
    const cur = it.at.get(b.id);
    if (cur && cur.onHand !== null) continue;   // the use rows' level wins
    it.at.set(b.id, { branchId: b.id, branch: b.name, onHand: l.onHand, used: cur?.used ?? 0 });
  }
  return [...map.values()];
}

interface Cover { branchId: string; branch: string; onHand: number; perDay: number; cover: number | null; used: number }
function coversOf(it: ItemAcross, days: number): Cover[] {
  return [...it.at.values()].filter((a) => a.onHand !== null && a.onHand >= 0).map((a) => {
    const perDay = a.used / days;
    return { branchId: a.branchId, branch: a.branch, onHand: a.onHand as number, perDay, used: a.used, cover: perDay > 0 ? (a.onHand as number) / perDay : null };
  });
}
function shortsOf(cs: Cover[]): (Cover & { fast: boolean })[] {
  const out: (Cover & { fast: boolean })[] = [];
  for (const c of cs) {
    if (c.perDay <= 0 || c.used < MOVE_MIN_USED || c.cover === null) continue;
    const others = median(cs.filter((o) => o.branchId !== c.branchId && o.perDay > 0).map((o) => o.perDay));
    const fast = others !== null && c.perDay >= MOVE_FAST_MULTIPLE * others - 1e-9;
    if (c.cover < MOVE_SHORT_DAYS || (c.cover < MOVE_FAST_DAYS && fast)) out.push({ ...c, fast });
  }
  return out;
}

/** The items short at some branch (the only ones whose levels elsewhere are worth reading). */
export function moveCandidates(input: { days: number; branches: BranchInfo[]; stock: Record<string, StockUseResult | null> }): { kind: 'product' | 'ingredient'; itemId: string }[] {
  if (input.days < BRANCH_MIN_DAYS || input.branches.length < 2) return [];
  return itemsAcross(input.branches, input.stock).filter((it) => shortsOf(coversOf(it, input.days)).length > 0)
    .map((it) => ({ kind: it.kind, itemId: it.itemId }));
}

/**
 * The moves, worked out per item across the branches. Short branch: under 3 days of cover, or under a week while it sells
 * at least 2× the other branches' median a day (used ≥ 10). Surplus branch: ≥ 10 on hand and over 30 days of cover (or
 * over 3× the median cover of the branches that sell it; a branch that sold none counts as surplus). Internally the
 * quantity = the need to bring the short branch to 7 days (rounded up to a step) or what the surplus branch can spare
 * keeping 14 days of its own sales (rounded down), whichever is less; under 3: no move. Each short branch takes from the
 * branch that can spare most. score = the units that would otherwise run short × the average price (products), else the
 * units — used ONLY to choose and rank.
 */
export function stockMoves(input: {
  days: number; branches: BranchInfo[]; stock: Record<string, StockUseResult | null>; levels?: BranchLevel[]; prices?: Record<string, number>;
}): StockMove[] {
  const { days, branches } = input;
  if (days < BRANCH_MIN_DAYS || branches.length < 2) return [];
  const out: StockMove[] = [];
  for (const it of itemsAcross(branches, input.stock, input.levels)) {
    const cs = coversOf(it, days);
    const shorts = shortsOf(cs).sort((a, b) => (a.cover as number) - (b.cover as number) || b.perDay - a.perDay);
    if (!shorts.length) continue;
    const medCover = median(cs.filter((c) => c.cover !== null).map((c) => c.cover as number));
    const spare = new Map<string, number>();
    for (const c of cs) {
      if (c.onHand < MOVE_SURPLUS_MIN || shorts.some((s) => s.branchId === c.branchId)) continue;
      const plenty = c.cover === null || c.cover > MOVE_SURPLUS_DAYS || (medCover !== null && medCover > 0 && c.cover > MOVE_SURPLUS_MEDIAN * medCover);
      if (!plenty) continue;
      const can = c.onHand - MOVE_KEEP_DAYS * c.perDay;
      if (can > 0) spare.set(c.branchId, can);
    }
    for (const s of shorts) {
      const from = [...spare.entries()].sort((a, b) => b[1] - a[1])[0];
      if (!from) break;
      const need = MOVE_TARGET_DAYS * s.perDay - s.onHand;
      const qty = Math.min(stepRound(need, true), stepRound(from[1], false));
      if (qty < MOVE_MIN_QTY) continue;
      spare.set(from[0], from[1] - qty);
      const src = cs.find((c) => c.branchId === from[0]) as Cover;
      const price = it.kind === 'product' ? input.prices?.[it.itemId] ?? null : null;
      const units = Math.min(qty, Math.max(0, need));
      out.push({
        kind: it.kind, itemId: it.itemId, name: it.name, fromId: src.branchId, from: src.branch, toId: s.branchId, to: s.branch,
        qty, score: r2(price !== null && price > 0 ? units * price : units),
        source: { perDay: r4(src.perDay), cover: src.cover === null ? null : r1(src.cover) },
        target: { perDay: r4(s.perDay), cover: r1(s.cover as number), fast: s.fast },
      });
    }
  }
  return out.sort((a, b) => b.score - a.score || a.target.cover - b.target.cover || a.name.localeCompare(b.name));
}

/** "about 18 a day" — a daily rate only when it is at least one a day (the owner's own example uses one). */
const dayRate = (perDay: number) => (perDay >= 1 ? ` (about ${Math.round(perDay)} a day)` : '');

/**
 * The moves grouped into plain suggestions: the same two branches the same way → one suggestion naming up to 3 items (the
 * best scored first; the rest wait for a later period). Words only — no quantity, no stock count, no KES; a daily rate at
 * most. `branchInView`: only suggestions touching that branch (null: every one).
 */
export function moveSuggestions(moves: StockMove[] | null | undefined, branchInView: string | null = null): MoveSuggestion[] {
  const groups = new Map<string, StockMove[]>();
  for (const m of moves ?? []) {
    if (branchInView && m.fromId !== branchInView && m.toId !== branchInView) continue;
    const k = `${m.fromId}>${m.toId}`;
    groups.set(k, [...(groups.get(k) ?? []), m]);
  }
  const out: MoveSuggestion[] = [];
  for (const [k, ms] of groups) {
    const g = [...ms].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, MOVE_GROUP);
    const { from, to, fromId, toId } = g[0];
    const m = g[0];
    const one = g.length === 1;
    const urgent = g.some((x) => x.target.cover < 1);
    const idle = g.every((x) => x.source.perDay <= 0);
    const why = one
      ? `${m.name} sells well at ${to}${dayRate(m.target.perDay)} and is ${m.target.cover < 1 ? 'about to run out' : 'running low'} there, but ${m.source.perDay > 0 ? `sells slowly at ${from}, where you hold plenty` : `is not selling at ${from}, where you hold some`} — consider moving some to ${to}.`
      : `${andList(g.map((x) => x.name))} are ${idle ? `not selling at ${from}` : `moving slowly at ${from}`} but sell fast at ${to}, where ${urgent ? 'some are about to run out' : 'they are running low'} — consider moving some across.`;
    out.push({
      id: `stock_move.${k}`,
      move: { fromId, from, toId, to, items: g.map((x) => ({ kind: x.kind, itemId: x.itemId, name: x.name })) },
      title: one ? `Consider moving some ${m.name} from ${from} to ${to}` : `Consider moving some stock from ${from} to ${to}`,
      why, score: r2(g.reduce((s, x) => s + x.score, 0)),
    });
  }
  return out.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

/** The movement cards: at most 3, ranked with the stock-out risks. No estimate — a suggestion; the owner decides how much. */
export function recStockMoves(i: RecInput): Recommendation[] {
  if (!i.moves?.length || i.days < BRANCH_MIN_DAYS) return [];
  return moveSuggestions(i.moves, i.branchInView ?? null).slice(0, MOVE_TOP).map((s): Recommendation => ({
    id: s.id, kind: 'stock_move', title: s.title, why: s.why,
    impact: null, impactPer: null, impactKind: null, stock: null, warning: false,
    assumption: MOVE_BASIS, confidence: i.days >= 28 ? 'high' : 'medium', evidence: 'branches', move: s.move, score: s.score,
  }));
}

export interface BranchRow {
  id: string; name: string; sales: number; prevSales: number; change: number | null; orders: number; prevOrders: number;
  tradingDays: number; perDay: number | null; avgBill: number | null; margin: number | null; share: number | null;
  flagged: boolean; reason: string | null;
  /** items whose stock moves slowly here and would sell faster at another branch (a count of items, not of stock) */
  slowOut: number;
}
export interface BranchCompare { days: number; rows: BranchRow[]; total: number; underperforming: BranchRow[]; basis: string; marginHidden: boolean }

/**
 * The branches side by side: sales, the change against each branch's own previous period, sales per trading day, the
 * average bill and (costs only) the gross margin. Underperforming (BRANCH_BASIS): ≥ 2 weeks, ≥ 30 bills before, sales
 * down ≥ 20% AND ≥ 10 points worse than the other branches together. `daily`: each branch's analytics_daily_sales rows
 * (both periods); `margins`: each branch's gross margin (null without costs). At most 10 rows, by sales.
 */
export function compareBranches(input: {
  from: string; to: string; branches: BranchInfo[]; daily: Record<string, DailyRow[] | null>;
  margins: Record<string, number | null> | null; moves?: StockMove[] | null;
}): BranchCompare {
  const { from, to } = input;
  const days = rangeDays(from, to) ?? 1;
  const sums = input.branches.map((b) => {
    let sales = 0, orders = 0, prevSales = 0, prevOrders = 0;
    const traded = new Set<string>();
    for (const r of input.daily[b.id] ?? []) {
      if (r.method !== null && r.method !== undefined) continue;
      const d = String(r.day ?? '').slice(0, 10);
      if (!d) continue;
      if (d >= from && d <= to) { sales += n0(r.revenue); orders += n0(r.orders); if (n0(r.revenue) > 0) traded.add(d); }
      else if (d < from) { prevSales += n0(r.revenue); prevOrders += n0(r.orders); }
    }
    return { b, sales, orders, prevSales, prevOrders, tradingDays: traded.size };
  });
  const total = sums.reduce((s, x) => s + x.sales, 0);
  const rows: BranchRow[] = sums.map((x) => {
    const others = sums.filter((o) => o.b.id !== x.b.id);
    const rest = pctChange(others.reduce((s, o) => s + o.sales, 0), others.reduce((s, o) => s + o.prevSales, 0));
    const change = pctChange(x.sales, x.prevSales);
    const flagged = days >= BRANCH_MIN_DAYS && x.prevOrders >= BRANCH_MIN_PREV_ORDERS && change !== null
      && change <= -BRANCH_DROP + 1e-9 && (rest === null || change <= rest - BRANCH_GAP + 1e-9);
    const restWords = rest === null ? '' : rest >= 0.005 ? `, while the other branches together sold ${pctText(rest)} more`
      : rest <= -0.005 ? `, while the other branches together sold ${pctText(-rest)} less` : ', while the other branches together held steady';
    return {
      id: x.b.id, name: x.b.name, sales: r2(x.sales), prevSales: r2(x.prevSales), change, orders: x.orders, prevOrders: x.prevOrders,
      tradingDays: x.tradingDays, perDay: x.tradingDays > 0 ? r2(x.sales / x.tradingDays) : null,
      avgBill: x.orders > 0 ? r2(x.sales / x.orders) : null, margin: input.margins ? input.margins[x.b.id] ?? null : null,
      share: total > 0 ? r4(x.sales / total) : null,
      flagged, reason: flagged && change !== null ? `Sales fell ${pctText(-change)} against the previous ${days} days${restWords}.` : null,
      slowOut: new Set((input.moves ?? []).filter((m) => m.fromId === x.b.id).map((m) => `${m.kind}.${m.itemId}`)).size,
    };
  }).sort((a, b) => b.sales - a.sales || a.name.localeCompare(b.name));
  return {
    days, rows: rows.slice(0, TABLE_TOP), total: rows.length, basis: BRANCH_BASIS, marginHidden: !input.margins,
    underperforming: rows.filter((r) => r.flagged).sort((a, b) => (a.change ?? 0) - (b.change ?? 0) || a.name.localeCompare(b.name)),
  };
}

/**
 * "Sales at Westlands fell 28% against the previous 30 days": a branch flagged by compareBranches (the branch in view, or
 * every branch). When some of its stock is moving slowly and sells faster elsewhere, the card says so in words. No KES,
 * never a price; the page links it to What sells when there.
 */
export function recBranchDrop(i: RecInput): Recommendation[] {
  const bc = i.branchCompare;
  if (!bc || i.days < BRANCH_MIN_DAYS) return [];
  return bc.underperforming.filter((r) => !i.branchInView || r.id === i.branchInView).slice(0, BRANCH_DROP_TOP).map((r): Recommendation => {
    const toward = [...new Set((i.moves ?? []).filter((m) => m.fromId === r.id).map((m) => m.to))];
    return {
      id: `branch_drop.${r.id}`, kind: 'branch_drop', branchId: r.id,
      title: `Sales at ${r.name} fell ${pctText(-(r.change as number))} against the previous ${bc.days} days`,
      why: `${r.reason ?? ''}${toward.length ? ` Its stock is moving slowly — some of it may sell faster at ${andList(toward.slice(0, 2))}.` : ''} Look at what sells when at ${r.name} to see which hours and items dropped.`.trim(),
      impact: null, impactPer: null, impactKind: null, stock: null, warning: false,
      assumption: `No KES estimate. ${BRANCH_BASIS}`, confidence: bc.days >= 28 ? 'high' : 'medium', evidence: 'branches',
    };
  });
}

/** The Branches tile's hook: the moves to consider first, else the branch that fell, else how many are compared. */
function branchText(b: { count: number; moves: number; underperforming: { name: string; change: number | null }[] } | null): string {
  if (!b) return 'Compare your branches';
  if (b.moves) return `${plural(b.moves, 'stock move', 'stock moves')} to consider`;
  const u = b.underperforming[0];
  if (u && u.change !== null) return `${u.name} down ${pctText(-u.change)}`;
  return `${b.count} branches compared`;
}

// ── A575: what sells together ─────────────────────────────────────────────────
//
// The owner's backlog: which products end up in the same order, in plain words, and what to do about it — stock them
// together, put them side by side, offer one with the other, make a combo. Never a price (the owner: "prices should be
// competitive"), never a KES gain: only what was seen.

/** migration 164's analytics_together: one 'total' row, then the pairs found together most */
export interface TogetherRow {
  kind: 'total' | 'pair'; orders: number | string | null; multi_orders: number | string | null;
  a_id: string | null; a_name: string | null; a_fuel: boolean | null; a_orders: number | string | null;
  b_id: string | null; b_name: string | null; b_fuel: boolean | null; b_orders: number | string | null;
  together: number | string | null;
}
export const TOGETHER_LIMIT = 100;        // pairs asked of the SQL (the most found together)
export const TOGETHER_MIN_BASKETS = 30;   // no section on fewer orders holding two or more items
export const TOGETHER_MIN_PAIR = 5;       // a pair listed: together in at least 5 orders…
export const TOGETHER_MIN_LIFT = 1.2;     // …and at least 1.2× as often as chance would put them together
export const TOGETHER_CARD_MIN = 10;      // a card: together in at least 10 orders…
export const TOGETHER_CARD_SHARE = 0.15;  // …in at least 15% of the orders with the first item…
export const TOGETHER_CARD_LIFT = 1.5;    // …and 1.5× as often as chance
export const TOGETHER_CARDS = 2;          // at most 2 cards, no product in both
export interface TogetherPair {
  /** a: what customers come for (the item with fewer orders — the stronger "who buys a adds b"); b: what they add */
  aId: string; aName: string; aFuel: boolean; aOrders: number;
  bId: string; bName: string; bFuel: boolean; bOrders: number;
  /** orders holding both */
  together: number;
  /** together ÷ the orders with a */
  share: number;
  /** how many times as often as chance (together × orders ÷ (a's orders × b's orders)); ranks, never shown as a number */
  lift: number;
  /** "People who buy Chicken Wrap often add Soda 500ml (38 of 120 orders with Chicken Wrap)" */
  sentence: string;
  /** what to do, in the business's own way of selling */
  advice: TogetherAdvice;
}
export interface TogetherResult {
  orders: number; multiOrders: number;
  /** enough orders with two or more items to say anything */
  enough: boolean;
  /** why nothing is listed (too few orders, or nothing goes together more than by chance) */
  note: string | null;
  /** the top 10 */
  pairs: TogetherPair[];
  /** every pair that passed, before the cap */
  total: number;
  /** the cards' pairs (at most 2, no product in both) */
  strong: TogetherPair[];
}
/** How often b comes with a, in words: half the time or more "usually", a quarter "often", else "sometimes". */
export function togetherWord(share: number): string {
  return share >= 0.5 ? 'usually' : share >= 0.25 ? 'often' : 'sometimes';
}
export function togetherSentence(p: { aName: string; bName: string; together: number; aOrders: number; share: number }): string {
  return `People who buy ${p.aName} ${togetherWord(p.share)} add ${p.bName} (${qtyText(p.together)} of ${qtyText(p.aOrders)} orders with ${p.aName})`;
}

/**
 * The pairs of migration 164 in plain words. Each pair is turned so that `a` is the item with fewer orders (who buys a
 * adds b — the stronger direction), listed when found together in at least 5 orders and 1.2× as often as chance, ranked
 * by orders together × how much more often than chance (capped at 5×, so two rare items never outrank a real habit),
 * the top 10. Fewer than 30 orders with two or more items: nothing, and a note.
 */
export function summariseTogether(rows: TogetherRow[], businessType?: string | null): TogetherResult {
  const n = (x: unknown) => (x === null || x === undefined ? 0 : Number(x) || 0);
  const tot = rows.find((r) => r.kind === 'total');
  const orders = n(tot?.orders); const multiOrders = n(tot?.multi_orders);
  if (multiOrders < TOGETHER_MIN_BASKETS) {
    return {
      orders, multiOrders, enough: false, pairs: [], total: 0, strong: [],
      note: `Not enough orders with two or more items yet (${qtyText(multiOrders)} of the ${TOGETHER_MIN_BASKETS} needed) — try a longer period.`,
    };
  }
  const all: (TogetherPair & { score: number })[] = [];
  for (const r of rows) {
    if (r.kind !== 'pair' || !r.a_id || !r.b_id) continue;
    const together = n(r.together); const ao = n(r.a_orders); const bo = n(r.b_orders);
    if (together < TOGETHER_MIN_PAIR || ao <= 0 || bo <= 0 || orders <= 0) continue;
    const lift = (together * orders) / (ao * bo);
    if (lift < TOGETHER_MIN_LIFT) continue;
    const aName = r.a_name || 'Unnamed item'; const bName = r.b_name || 'Unnamed item';
    // the anchor: the item with fewer orders (ties: by name)
    const flip = bo < ao || (bo === ao && bName.localeCompare(aName) < 0);
    const A = flip ? { id: r.b_id, name: bName, fuel: !!r.b_fuel, orders: bo } : { id: r.a_id, name: aName, fuel: !!r.a_fuel, orders: ao };
    const B = flip ? { id: r.a_id, name: aName, fuel: !!r.a_fuel, orders: ao } : { id: r.b_id, name: bName, fuel: !!r.b_fuel, orders: bo };
    const share = together / A.orders;
    const p = { aId: A.id, aName: A.name, aFuel: A.fuel, aOrders: A.orders, bId: B.id, bName: B.name, bFuel: B.fuel, bOrders: B.orders, together, share, lift };
    all.push({
      ...p, sentence: togetherSentence(p), advice: togetherAdvice(businessType, { name: A.name, fuel: A.fuel }, { name: B.name, fuel: B.fuel }),
      score: together * Math.min(lift, 5),
    });
  }
  all.sort((x, y) => y.score - x.score || y.together - x.together || x.aName.localeCompare(y.aName) || x.bName.localeCompare(y.bName));
  const strip = ({ score: _s, ...x }: TogetherPair & { score: number }): TogetherPair => x;
  const strong: TogetherPair[] = [];
  const used = new Set<string>();
  for (const p of all) {
    if (strong.length >= TOGETHER_CARDS) break;
    if (p.together < TOGETHER_CARD_MIN || p.share < TOGETHER_CARD_SHARE || p.lift < TOGETHER_CARD_LIFT) continue;
    if (used.has(p.aId) || used.has(p.bId)) continue;
    used.add(p.aId); used.add(p.bId); strong.push(strip(p));
  }
  return {
    orders, multiOrders, enough: true,
    note: all.length ? null : 'Nothing is bought together more often than chance would put it in the same order — your customers buy each item for itself.',
    pairs: all.slice(0, TABLE_TOP).map(strip), total: all.length, strong,
  };
}

/** One or two cards from the strongest pairs (no product in two cards). No KES: what customers already do. */
export function recTogether(i: RecInput): Recommendation[] {
  const t = i.together;
  if (!t || !t.enough) return [];
  return t.strong.slice(0, TOGETHER_CARDS).map((p): Recommendation => ({
    id: `together.${p.aId}.${p.bId}`, kind: 'together',
    title: p.advice.title,
    why: `${p.sentence}. ${p.advice.action}`,
    impact: null, impactPer: null, impactKind: null, stock: null, warning: false,
    assumption: `Based on what customers already bought together in the period (${qtyText(p.together)} orders); nothing here is an estimate.`,
    confidence: p.together >= 30 && i.days >= 14 ? 'high' : 'medium',
    evidence: 'together',
  }));
}
