/**
 * chartMath.ts — A553 (Analytics v2): the small PURE transforms behind the analytics charts (no imports — the tests read
 * this file directly): the change badge on a KPI tile, the heatmap folded into "by hour" and "by weekday", the top items,
 * the leak stack per cashier, the credit buckets and the top debtors. Every figure is the cloud's; nothing is recomputed
 * beyond adding up what it sent.
 */

export type Direction = 'up' | 'down' | 'flat' | 'none';
export interface Delta { direction: Direction; text: string; good: boolean | null }

/**
 * The change badge: ▲ / ▼ with the change, and whether that is GOOD (up is good for sales, bad for money at risk). A change
 * under half a percent (or half a point) is flat; no previous figure is "none" (nothing to compare against).
 * `points`: the change is already in percentage points (the margin), shown as "pts".
 */
export function deltaOf(change: number | null | undefined, opts: { upIsGood: boolean; points?: boolean }): Delta {
  if (change === null || change === undefined || !Number.isFinite(change)) return { direction: 'none', text: 'no earlier figure', good: null };
  const pct = change * 100;
  if (Math.abs(pct) < 0.5) return { direction: 'flat', text: opts.points ? '0.0 pts' : '0%', good: null };
  const up = pct > 0;
  const size = Math.abs(pct);
  const text = opts.points ? `${size.toFixed(1)} pts` : `${size >= 100 ? Math.round(size).toLocaleString('en-US') : size.toFixed(1)}%`;
  return { direction: up ? 'up' : 'down', text: `${up ? '▲' : '▼'} ${text}`, good: up === opts.upIsGood };
}

/** A compact number for an axis tick: 950 · 1.2K · 34K · 1.5M. */
export function compact(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e6) return `${(n / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace(/\.0$/, '')}M`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(a >= 1e4 ? 0 : 1).replace(/\.0$/, '')}K`;
  return String(Math.round(n));
}

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const hh = (h: number) => `${String(h % 24).padStart(2, '0')}:00`;

/** The heatmap (weekday × hour) summed over the weekdays: one column per hour inside the trading hours. */
export function byHour(revenue: number[][], orders: number[][], hours: { from: number; to: number } | null): { hour: number; label: string; revenue: number; orders: number }[] {
  if (!hours) return [];
  const out = [];
  for (let h = hours.from; h <= hours.to; h++) {
    let r = 0, o = 0;
    for (let d = 0; d < 7; d++) { r += revenue[d]?.[h] ?? 0; o += orders[d]?.[h] ?? 0; }
    out.push({ hour: h, label: hh(h), revenue: Math.round(r * 100) / 100, orders: o });
  }
  return out;
}

/** The heatmap summed over the hours: one bar per weekday, Monday first. */
export function byWeekday(revenue: number[][], orders: number[][]): { day: string; revenue: number; orders: number }[] {
  return DAYS.map((day, d) => ({
    day,
    revenue: Math.round((revenue[d] ?? []).reduce((s, v) => s + (v || 0), 0) * 100) / 100,
    orders: (orders[d] ?? []).reduce((s, v) => s + (v || 0), 0),
  }));
}

/** The `n` best by `key`, biggest first (ties by name) — never more than there are. */
export function topBy<T extends { name: string }>(rows: T[], key: (r: T) => number, n = 10): T[] {
  return [...rows].filter((r) => key(r) > 0).sort((a, b) => key(b) - key(a) || a.name.localeCompare(b.name)).slice(0, n);
}

export interface LeakParts { voids: number; refunds: number; discounts: number; wastage: number }
/** One cashier's leaks as the four stacked parts (wastage 0 when its value is withheld). */
export function leakParts(c: { voidValue: number; itemVoidValue: number; refundValue: number; discountValue: number; wastageValue: number | null }): LeakParts {
  return { voids: c.voidValue + c.itemVoidValue, refunds: c.refundValue, discounts: c.discountValue, wastage: c.wastageValue ?? 0 };
}
export const leakTotal = (p: LeakParts) => p.voids + p.refunds + p.discounts + p.wastage;

/** Each slice's share of the whole (0..1), the slices with nothing dropped. */
export function shares<T extends { value: number }>(slices: T[]): (T & { share: number })[] {
  const total = slices.reduce((s, x) => s + (x.value > 0 ? x.value : 0), 0);
  return slices.filter((x) => x.value > 0).map((x) => ({ ...x, share: total > 0 ? x.value / total : 0 }));
}

/** The time axis label for a business date: "21 Oct". */
export function dayLabel(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  return `${d} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]}`;
}

// ── A558: plain words for the KPI tiles, the 10-row caps, the item heatmap ────

export interface ChangeWords { arrow: '▲' | '▼' | ''; text: string; good: boolean | null }
/**
 * A KPI's change as words a non-analyst reads: "9.5% more than the 30 days before", "about the same as …", "2.1 points
 * higher than …" (`points`: the change is already in percentage points). `good` follows `upIsGood` (money at risk: up
 * is bad); null when flat or nothing to compare against.
 */
export function changeWords(change: number | null | undefined, opts: { upIsGood: boolean; points?: boolean; compare: string }): ChangeWords {
  if (change === null || change === undefined || !Number.isFinite(change)) return { arrow: '', text: `no earlier figure to compare with`, good: null };
  const pct = change * 100;
  if (Math.abs(pct) < 0.5) return { arrow: '', text: `about the same as ${opts.compare}`, good: null };
  const up = pct > 0;
  const size = Math.abs(pct);
  const n = opts.points ? size.toFixed(1) : size >= 100 ? Math.round(size).toLocaleString('en-US') : size.toFixed(1);
  const text = opts.points ? `${n} points ${up ? 'higher' : 'lower'} than ${opts.compare}` : `${n}% ${up ? 'more' : 'less'} than ${opts.compare}`;
  return { arrow: up ? '▲' : '▼', text, good: up === opts.upIsGood };
}

/** "the 30 days before" / "the day before" — what a period is compared against. */
export const compareWords = (days: number) => (days === 1 ? 'the day before' : `the ${days} days before`);

/** Of every 100 sold, how much is left after the cost (a margin of 0.553 → 55). */
export const per100 = (margin: number | null | undefined) => (margin === null || margin === undefined || !Number.isFinite(margin) ? null : Math.round(margin * 100));

/** A table's rows capped at `n` (A558: every analytics table shows the top 10 and says so — no paging). */
export function capRows<T>(rows: T[], n = 10): { rows: T[]; total: number; capped: boolean } {
  const all = rows ?? [];
  return { rows: all.slice(0, n), total: all.length, capped: all.length > n };
}

/** One product's cells ([weekday 0–6, hour, qty, revenue]) as a 7 × 24 quantity grid, its busiest cell and its hours. */
export function itemGrid(cells: [number, number, number, number][]): { qty: number[][]; max: number; hours: { from: number; to: number } | null; peak: { dow: number; hour: number; qty: number } | null } {
  const qty = Array.from({ length: 7 }, () => Array(24).fill(0) as number[]);
  let max = 0, lo = 24, hi = -1;
  let peak: { dow: number; hour: number; qty: number } | null = null;
  for (const [d, h, q] of cells ?? []) {
    if (d < 0 || d > 6 || h < 0 || h > 23 || !(q > 0)) continue;
    qty[d][h] += q;
    if (qty[d][h] > max) max = qty[d][h];
    if (!peak || qty[d][h] > peak.qty) peak = { dow: d, hour: h, qty: qty[d][h] };
    lo = Math.min(lo, h); hi = Math.max(hi, h);
  }
  return { qty, max, hours: hi >= 0 ? { from: lo, to: hi } : null, peak };
}

// ── A561: the area tiles, the order-type mix, days left ──────────────────────

export type AreaKey = 'menu' | 'heatmap' | 'leaks' | 'credit' | 'stock' | 'branches' | 'customers' | 'costs';
/** The tiles' order: the four A549 areas, then stock, branches (A565), customers and costs. */
export const AREA_ORDER: AreaKey[] = ['menu', 'heatmap', 'leaks', 'credit', 'stock', 'branches', 'customers', 'costs'];
export interface AreaHook { text: string; alert: boolean; hidden: boolean }

/**
 * The tiles a person sees: a tile the cloud marks hidden goes (credit, costs); costs also go when costs are hidden. A565:
 * Branches shows only when the cloud says so (two or more branches and a viewer who sees every branch) — never by default.
 */
export function visibleAreas(hooks: Partial<Record<AreaKey, AreaHook>> | null | undefined, costsHidden: boolean): AreaKey[] {
  return AREA_ORDER.filter((k) => !(hooks?.[k]?.hidden) && !(k === 'costs' && costsHidden) && !(k === 'branches' && !hooks?.branches));
}

/** `?tab=stock` → the area, when it is one the person sees; anything else → null. */
export function areaFromQuery(search: string, allowed: AreaKey[]): AreaKey | null {
  const v = new URLSearchParams(search).get('tab');
  return v && (allowed as string[]).includes(v) ? (v as AreaKey) : null;
}

/** The tile the arrow keys move to (wrapping), Home / End to the first / last; any other key stays. */
export function nextArea(list: AreaKey[], current: AreaKey, key: string): AreaKey {
  if (!list.length) return current;
  const i = Math.max(0, list.indexOf(current));
  if (key === 'ArrowRight' || key === 'ArrowDown') return list[(i + 1) % list.length];
  if (key === 'ArrowLeft' || key === 'ArrowUp') return list[(i - 1 + list.length) % list.length];
  if (key === 'Home') return list[0];
  if (key === 'End') return list[list.length - 1];
  return current;
}

/** Days left in words: "out now", "under a day", "about 2 days", "about 3 weeks"; unknown → "—". */
export function daysLeftWords(d: number | null | undefined): string {
  if (d === null || d === undefined || !Number.isFinite(d)) return '—';
  if (d <= 0) return 'out now';
  if (d < 1) return 'under a day';
  if (d < 14) { const n = Math.round(d); return `about ${n} ${n === 1 ? 'day' : 'days'}`; }
  if (d < 70) return `about ${Math.round(d / 7)} weeks`;
  return 'over 10 weeks';
}

/** A change against the previous period in words for a table cell: "+25%", "−10%", "new", "—". */
export function changeCell(change: number | null | undefined, prev: number): string {
  if (change === null || change === undefined || !Number.isFinite(change)) return prev > 0 ? '—' : 'new';
  const p = Math.round(change * 100);
  return p === 0 ? 'same' : `${p > 0 ? '+' : '−'}${Math.abs(p)}%`;
}
