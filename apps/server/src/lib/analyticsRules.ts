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
