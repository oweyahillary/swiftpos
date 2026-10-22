/**
 * chartPalette.ts — A553 (Analytics v2): the ONE place the analytics charts take their colours from. PURE (no imports), so
 * tests/analytics-a553-charts.test.mjs reads it directly.
 *
 * Data colours, not actions (docs/A329-back-office-colour-classification.md): the back office's actions stay the SwiftPOS
 * teal (swift-*); these hues only tell series apart, show magnitude or show a state. The values are the dataviz reference
 * palette, each mode SELECTED for its own surface (the dashboard's cards: white in light mode, gray-900 #111827 in dark)
 * and checked with the dataviz validator (2026-10-21):
 *   - categorical, slots 1–5 in this fixed order (payment mix; leak types use 1–4): adjacent pairs pass in both modes,
 *     the donut's wrap-around pair too (worst CVD ΔE 9.1 light / 8.4 dark, normal vision ≥ 19.3); three light slots are
 *     under 3:1 on white, so every chart carries a legend and a table or direct labels;
 *   - the menu classes (a scatter: every pair is in play) — aqua · yellow · violet · red pass all-pairs in both modes with
 *     CVD in the 6–8 warn band, so each class ALSO has its own marker shape and its quadrant (secondary encoding);
 *   - the credit buckets use the fixed status colours good → warning → serious → critical (ageing is a state: older =
 *     worse), each with its label — never colour alone;
 *   - the heatmap is ONE hue (blue) light → dark; in dark mode the ramp runs from near the surface up to the light end.
 * Colour follows the entity (a cashier flagged, a class, a method), never its rank. Text never wears a series colour.
 */

export type ChartMode = 'light' | 'dark';
export type ClassKey = 'star' | 'plowhorse' | 'puzzle' | 'dog' | 'no_cost';
export type LeakKey = 'voids' | 'refunds' | 'discounts' | 'wastage';
export type PayKey = 'cash' | 'mpesa' | 'card' | 'account' | 'other';
export type BucketKey = 'd0_30' | 'd31_60' | 'd61_90' | 'd90_plus';
/** A561: the order-type mix (dine-in, takeaway, delivery, counter and other) */
export type OrderTypeKey = 'dine_in' | 'takeaway' | 'delivery' | 'other';

export interface ChartPalette {
  mode: ChartMode;
  surface: string; grid: string; axis: string; muted: string; ink: string; inkSoft: string;
  /** the single-series accent (trend, hours, weekdays, debtors) and the faint comparison line */
  accent: string; compare: string;
  categorical: string[];
  classes: Record<ClassKey, string>;
  /** a quadrant's wash behind the scatter (the class colour at low opacity) */
  quadrantOpacity: number;
  leaks: Record<LeakKey, string>;
  payments: Record<PayKey, string>;
  /** A561: the order-type mix — categorical slots 1–4 in their fixed order (adjacent pairs pass, as the payment mix) */
  orderTypes: Record<OrderTypeKey, string>;
  buckets: Record<BucketKey, string>;
  flagged: string;
  /** the heatmap ramp, from no sales to the busiest hour */
  ramp: string[];
  deltaGood: string; deltaBad: string;
  /** an insight card's stripe and icon by severity (status colours; low is the plain accent — information) */
  severity: Record<'high' | 'medium' | 'low', string>;
}

const LIGHT_CAT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];
const DARK_CAT = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];
const STATUS = { good: '#0ca30c', warning: '#fab219', serious: '#ec835a', critical: '#d03b3b' };
const BLUE_RAMP = ['#cde2fb', '#b7d3f6', '#9ec5f4', '#86b6ef', '#6da7ec', '#5598e7', '#3987e5', '#2a78d6', '#256abf', '#1c5cab', '#184f95', '#104281', '#0d366b'];

function build(mode: ChartMode): ChartPalette {
  const c = mode === 'light' ? LIGHT_CAT : DARK_CAT;
  const light = mode === 'light';
  return {
    mode,
    surface: light ? '#ffffff' : '#111827',
    grid: light ? '#e2e8f0' : '#1f2937',
    axis: light ? '#cbd5e1' : '#374151',
    muted: light ? '#64748b' : '#9ca3af',
    ink: light ? '#0f172a' : '#f9fafb',
    inkSoft: light ? '#475569' : '#d1d5db',
    accent: c[0],
    compare: light ? '#94a3b8' : '#6b7280',
    categorical: c.slice(0, 5),
    classes: {
      star: c[2], plowhorse: c[3], puzzle: light ? '#6250d6' : '#9085e9', dog: '#e34948',
      no_cost: light ? '#94a3b8' : '#6b7280',
    },
    quadrantOpacity: light ? 0.07 : 0.1,
    leaks: { voids: c[0], refunds: c[1], discounts: c[2], wastage: c[3] },
    payments: { cash: c[0], mpesa: c[1], card: c[2], account: c[3], other: c[4] },
    orderTypes: { dine_in: c[0], takeaway: c[1], delivery: c[2], other: c[3] },
    buckets: { d0_30: STATUS.good, d31_60: STATUS.warning, d61_90: STATUS.serious, d90_plus: STATUS.critical },
    flagged: STATUS.critical,
    ramp: light ? BLUE_RAMP : [...BLUE_RAMP.slice(3)].reverse(),
    deltaGood: light ? '#006300' : '#0ca30c',
    deltaBad: light ? '#b91c1c' : '#f87171',
    severity: { high: STATUS.critical, medium: STATUS.warning, low: c[0] },
  };
}

const PALETTES: Record<ChartMode, ChartPalette> = { light: build('light'), dark: build('dark') };
export function chartPalette(mode: ChartMode): ChartPalette { return PALETTES[mode] ?? PALETTES.dark; }

export const CLASS_ORDER: ClassKey[] = ['star', 'plowhorse', 'puzzle', 'dog', 'no_cost'];
/** Each class's marker shape on the scatter (recharts Scatter `shape`) — the secondary encoding beside the colour. */
export const CLASS_SHAPE: Record<ClassKey, 'circle' | 'diamond' | 'triangle' | 'square' | 'cross'> = {
  star: 'circle', plowhorse: 'square', puzzle: 'diamond', dog: 'triangle', no_cost: 'cross',
};
export const ORDER_TYPE_ORDER: OrderTypeKey[] = ['dine_in', 'takeaway', 'delivery', 'other'];
export const ORDER_TYPE_LABEL: Record<OrderTypeKey, string> = { dine_in: 'Dine-in', takeaway: 'Takeaway', delivery: 'Delivery', other: 'Counter and other' };
export const LEAK_ORDER: LeakKey[] = ['voids', 'refunds', 'discounts', 'wastage'];
export const LEAK_LABEL: Record<LeakKey, string> = { voids: 'Voids', refunds: 'Refunds', discounts: 'Discounts', wastage: 'Wastage' };
export const BUCKET_ORDER: BucketKey[] = ['d0_30', 'd31_60', 'd61_90', 'd90_plus'];
export const BUCKET_LABEL: Record<BucketKey, string> = { d0_30: '0–30 days', d31_60: '31–60 days', d61_90: '61–90 days', d90_plus: 'Over 90 days' };

/**
 * The heatmap cell colour for a value against the busiest cell: none for no sales; otherwise a step of the ramp, the
 * lowest sale one step in (so a slow hour is still visibly "some"), the busiest the far end.
 */
export function heatColour(p: ChartPalette, value: number, max: number): string | null {
  if (!(value > 0) || !(max > 0)) return null;
  const t = Math.min(1, value / max);
  const i = Math.max(1, Math.round(t * (p.ramp.length - 1)));
  return p.ramp[i];
}
