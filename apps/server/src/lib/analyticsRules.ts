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
 */

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
        `${it.name} is a Plowhorse: top 3 seller but margin ${moneyText(avg - (it.unitMargin ?? 0), cur)} below average – consider a small price rise`);
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
    add('menu.no_cost', 'menu', 'low', `${plural(names.length, 'item sold has', 'items sold have')} no cost set (${list(names)}) – set a cost price or recipe to see the margin`);
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
  for (const [, h, q, v] of all) {
    const k = daypartOf(h, cutoffMinutes);
    partQty[k] += q; partRev[k] += v; hourQty[h] += q; hourRev[h] += v;
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
    items, dayparts, hours,
    totals: { qty: r4(totalQty), revenue: r2(totalRow ? n0(totalRow.revenue) : 0) },
    limited: items.length >= limit,
  };
}

// ── A558: "Do this next" — the recommendations ────────────────────────────────

export const MONTH_DAYS = 30;
export const MENU_MIN_QTY = 50;          // no menu advice on fewer items sold than this in the period
export const MENU_MIN_DAYS = 7;          // …or on less than a week
export const PRICE_MIN_QTY = 20;         // a Plowhorse needs this many sold to be worth a price change
export const PRICE_STEP = 10;            // prices move in KES 10
export const PRICE_MAX_RISE = 0.15;      // never more than 15% of its price at once
export const PRICE_TOP = 2;
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

export type RecKind = 'price' | 'promote' | 'rework' | 'staffing' | 'quiet' | 'leak' | 'day_close' | 'credit' | 'cost';
export type Confidence = 'high' | 'medium' | 'low';
export type Evidence = 'menu' | 'heatmap' | 'leaks' | 'credit' | 'times';
export interface Recommendation {
  id: string; kind: RecKind;
  /** verb first: "Raise the price of Tusker lager by KES 20" */
  title: string;
  /** why, in one sentence, with the numbers */
  why: string;
  /** the estimate in KES (null: no honest KES figure), a month or once, and what kind of money it is */
  impact: number | null; impactPer: 'month' | 'once' | null; impactKind: 'gain' | 'recover' | 'collect' | null;
  /** the assumption the estimate rests on, said plainly */
  assumption: string;
  confidence: Confidence;
  /** the tab (or section) that shows the evidence */
  evidence: Evidence;
}
export interface RecInput {
  days: number; costs: boolean; currency?: string;
  menu: MenuResult | null; heatmap: HeatmapResult | null; leaks: LeaksResult | null; credit: CreditResult | null;
  times: ItemTimesResult | null;
}

const perMonth = (x: number, days: number) => (days > 0 ? (x * MONTH_DAYS) / days : 0);
const roundTo = (x: number, step: number) => Math.round(x / step) * step;
const floorTo = (x: number, step: number) => Math.floor(x / step) * step;
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

/** The rise for a Plowhorse: half its margin gap to the average, in KES 10, at least 10, at most 15% of its price. */
export function suggestedRise(gap: number, price: number): number {
  const cap = Math.max(PRICE_STEP, floorTo(price * PRICE_MAX_RISE, PRICE_STEP));
  return Math.min(cap, Math.max(PRICE_STEP, roundTo(gap / 2, PRICE_STEP)));
}

/** Plowhorses (popular, low margin): a small price rise. Impact = the rise × the quantity a month. */
export function recPriceRise(i: RecInput): Recommendation[] {
  const m = menuReady(i); if (!m) return [];
  const cur = i.currency || 'KES';
  const avg = m.avgUnitMargin as number;
  return m.items.filter((it) => it.class === 'plowhorse' && it.unitMargin !== null && it.qty >= PRICE_MIN_QTY)
    .map((it): Recommendation => {
      const gap = avg - (it.unitMargin as number);
      const rise = suggestedRise(gap, it.avgPrice);
      const monthly = Math.round(perMonth(it.qty, i.days));
      return {
        id: `price.${it.productId ?? it.name}`, kind: 'price',
        title: `Raise the price of ${it.name} by ${moneyText(rise, cur)}`,
        why: `It is a best seller (${qtyText(it.qty)} sold, number ${it.rank}) but leaves ${moneyText(it.unitMargin as number, cur)} each after its cost — ${moneyText(gap, cur)} below your average of ${moneyText(avg, cur)}.`,
        impact: Math.round(rise * monthly), impactPer: 'month', impactKind: 'gain',
        assumption: `If the same ${qtyText(monthly)} a month still sell at ${moneyText(it.avgPrice + rise, cur)}.`,
        confidence: it.qty >= 100 ? 'high' : 'medium', evidence: 'menu',
      };
    }).sort((a, b) => (b.impact ?? 0) - (a.impact ?? 0)).slice(0, PRICE_TOP);
}

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
    impact: Math.round((it.unitMargin as number) * extra), impactPer: 'month', impactKind: 'gain',
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
    impact: null, impactPer: null, impactKind: null,
    assumption: 'No KES estimate: a shorter menu saves prep, stock and waste, and points customers to your best items.',
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
    impact: Math.round(perMonth(block.revenue, i.days) * STAFF_UPLIFT), impactPer: 'month', impactKind: 'gain',
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
    impact: Math.round(perMonth(typical - q.revenue, i.days) * QUIET_FILL), impactPer: 'month', impactKind: 'gain',
    assumption: `If an offer fills a quarter of the gap to a typical two hours (sales, before the offer's cost).`,
    confidence: 'low', evidence: 'heatmap',
  }];
}

/** A flagged cashier (A549's flag: ≥ 2× the median, ≥ 5 events): a talk. Impact = what is above the median, a month. */
export function recLeaks(i: RecInput): Recommendation[] {
  const l = i.leaks; if (!l) return [];
  const cur = i.currency || 'KES';
  const out: Recommendation[] = [];
  for (const c of l.cashiers) {
    for (const f of c.flags) {
      const isVoid = f.kind === 'void';
      const value = isVoid ? c.voidValue + c.itemVoidValue : c.discountValue;
      const excess = f.rate > 0 ? value * Math.max(0, 1 - f.median / f.rate) : 0;
      const what = isVoid ? 'voids' : 'discounts';
      out.push({
        id: `leak.${f.kind}.${c.cashierId ?? c.name}`, kind: 'leak',
        title: `Talk to ${c.name} about ${what}`,
        why: f.multiple !== null
          ? `${qtyText(f.events)} ${what} (${moneyText(value, cur)}) in ${i.days} days — ${times(f.multiple)} the branch median rate.`
          : `${qtyText(f.events)} ${what} (${moneyText(value, cur)}) in ${i.days} days, while the typical cashier had none.`,
        impact: Math.round(perMonth(excess, i.days)), impactPer: 'month', impactKind: 'recover',
        assumption: `If their ${isVoid ? 'void' : 'discount'} rate comes down to the branch median (${pctText(f.median)}).`,
        confidence: isVoid ? 'high' : 'medium', evidence: 'leaks',
      });
    }
  }
  return out.sort((a, b) => (b.impact ?? 0) - (a.impact ?? 0)).slice(0, LEAK_TOP);
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
    impact: Math.round(perMonth(short, i.days)), impactPer: 'month', impactKind: 'recover',
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
    impact: Math.round(c.over60.amount), impactPer: 'once', impactKind: 'collect',
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
    why: `${andList(missing.length > shown.length ? [...shown, `${missing.length - shown.length} more`] : shown)} sold ${moneyText(revenue, cur)} in ${i.days} days with no cost price or recipe, so the margin is unknown.`,
    impact: null, impactPer: null, impactKind: null,
    assumption: 'No KES estimate: with a cost set, every margin on this page is complete.',
    confidence: 'medium', evidence: 'menu',
  }];
}

const CONFIDENCE_ORDER: Record<Confidence, number> = { high: 0, medium: 1, low: 2 };
/** Ranked by the KES at stake (a month, or once), biggest first; no estimate last; then by confidence. At most 7. */
export function rankRecommendations(recs: Recommendation[]): Recommendation[] {
  return [...recs].sort((a, b) => (b.impact ?? -1) - (a.impact ?? -1) || CONFIDENCE_ORDER[a.confidence] - CONFIDENCE_ORDER[b.confidence]
    || a.id.localeCompare(b.id)).slice(0, MAX_RECOMMENDATIONS);
}

/** Every rule, ranked. Upsell ("what sells together") is not here: it needs baskets, which no cheap aggregate gives. */
export function buildRecommendations(i: RecInput): Recommendation[] {
  return rankRecommendations([
    ...recPriceRise(i), ...recPromote(i), ...recRework(i), ...recStaffing(i), ...recQuietSlot(i),
    ...recLeaks(i), ...recDayClose(i), ...recCredit(i), ...recCostData(i),
  ]);
}

/** "Analytics found about KES X a month you could gain or recover" — the estimates added up (a month; once apart). */
export function valueFound(recs: Recommendation[]): { monthly: number; once: number; count: number } {
  const monthly = recs.filter((r) => r.impactPer === 'month').reduce((s, r) => s + (r.impact ?? 0), 0);
  const once = recs.filter((r) => r.impactPer === 'once').reduce((s, r) => s + (r.impact ?? 0), 0);
  return { monthly: Math.round(monthly), once: Math.round(once), count: recs.filter((r) => r.impact !== null).length };
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
