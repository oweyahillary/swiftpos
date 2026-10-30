/**
 * forecourt.ts — A588: the petrol POS's pumps screen, worked out. Pure: no imports. Copied verbatim to the till
 * (apps/desktop/src/shared) and the web POS (apps/dashboard/src/lib) — scripts/check-shared-sync.mjs.
 *
 * Owner, 2026-10-24: "FIX the petrol pos shop item, make it feel petrol-like, you can add gauges".
 *
 *   - a colour per fuel grade (Super red, V-Power purple, Diesel amber, Kerosene blue (#3f6fb5), gas teal), else the grade's
 *     category colour (the owner's own, set in the dashboard), else one of a few fixed colours by position;
 *   - the keypad: an amount (KES, 2 decimals) or litres (3 decimals) typed, the other worked out from the price per
 *     litre exactly as the fuel path always did (litres = amount ÷ price at full precision; amount = litres × price);
 *   - a gauge per grade: the tanks' level when this POS knows it (the cloud's fuel tanks), else the litres this POS sold
 *     today against yesterday — nothing is shown as known that is not.
 */
/** A pump as the POS holds it (the till's SQLite join; the web's /api/pumps with its fuel product). */
export interface ForecourtPump {
  id: string; name: string; status: string;
  fuel_product_id: string | null; fuel_product_name: string | null; price_per_litre: number | null;
}
/** What the gauges read: this POS's own fuel sales and, when known, the tanks (null = not known — never zeros). */
export interface ForecourtData {
  pumps: { pump_id: string; litres_today: number; last_sale_at: string | null; last_sale_litres: number | null; last_sale_amount: number | null }[];
  grades: { product_id: string; litres_today: number; litres_yesterday: number }[];
  tanks: { id: string; name: string; product_id: string; capacity_litres: number; current_level: number; reorder_level: number | null }[] | null;
  tanksAt: string | null;
}

/** Under this share of the tank the gauge warns (or at / under a tank's own reorder level). */
export const LOW_PCT = 20;
/** The quick amounts on the keypad (KES). "Full tank" switches to litres. */
export const QUICK_AMOUNTS = [500, 1000, 2000] as const;

const GRADE_RULES: { rx: RegExp; colour: string }[] = [
  { rx: /v[\s-]?power|premium|super\s*plus|\b(95|97|98)\b|\bplus\b/i, colour: '#9333ea' },   // a premium petrol
  { rx: /super|petrol|unleaded|gasoline|\bpms\b|\bmogas\b/i, colour: '#dc2626' },
  { rx: /diesel|\bago\b|gas\s*oil/i, colour: '#f59e0b' },
  { rx: /kerosene|paraffin|\bdpk\b|\bik\b|jet\s*a/i, colour: '#3f6fb5' },
  { rx: /\blpg\b|\bcng\b|\bgas\b|autogas/i, colour: '#0d9488' },
];
const FALLBACK = ['#0891b2', '#db2777', '#ea580c', '#7c3aed', '#ca8a04'];
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** The colour of a fuel grade: by its name, else its category's colour, else one of FALLBACK by position. */
export function gradeColour(name: string | null | undefined, categoryColour?: string | null, index = 0): string {
  const n = String(name ?? '');
  for (const r of GRADE_RULES) if (r.rx.test(n)) return r.colour;
  if (categoryColour && HEX.test(categoryColour.trim())) return categoryColour.trim();
  return FALLBACK[Math.abs(index) % FALLBACK.length];
}

// ── The keypad ───────────────────────────────────────────────────────────────────────────────────────────────────────
export type FuelField = 'amount' | 'litres';
const DECIMALS: Record<FuelField, number> = { amount: 2, litres: 3 };
const MAX_WHOLE = 7;   // 9,999,999 — more than any tank or till drawer

/** One key on the keypad: a digit, '.', 'back' or 'clear'. Never more decimals than the field takes. */
export function keyIn(current: string, key: string, field: FuelField): string {
  if (key === 'clear') return '';
  if (key === 'back') return current.slice(0, -1);
  if (key === '.') {
    if (current.includes('.')) return current;
    return current === '' ? '0.' : current + '.';
  }
  if (!/^[0-9]$/.test(key)) return current;
  const [whole, frac] = current.split('.');
  if (frac !== undefined) return frac.length >= DECIMALS[field] ? current : current + key;
  if (whole === '0') return key;   // no leading zeros
  return whole.length >= MAX_WHOLE ? current : current + key;
}

/** What the keypad's entry sells: the field typed is the truth, the other is worked out (the fuel path's own rule). */
export function fuelSale(field: FuelField, entry: string, pricePerLitre: number): { litres: number; amount: number } {
  const v = parseFloat(entry) || 0;
  const price = pricePerLitre > 0 ? pricePerLitre : 0;
  if (field === 'amount') return { amount: v, litres: price > 0 ? v / price : 0 };
  return { litres: v, amount: v * price };
}

export const litresText = (l: number) => `${(Number.isFinite(l) ? l : 0).toLocaleString('en-KE', { minimumFractionDigits: 3, maximumFractionDigits: 3 })} L`;
export function moneyText(n: number): string {
  return (Number.isFinite(n) ? n : 0).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ── Gauges ───────────────────────────────────────────────────────────────────────────────────────────────────────────
export type Gauge =
  | { kind: 'tank'; pct: number; left: number; capacity: number; low: boolean; tanks: number }
  | { kind: 'today'; pct: number; today: number; yesterday: number };

/** A grade's gauge: its tanks when known, else today's litres on this POS against yesterday's. null = still loading. */
export function gradeGauge(productId: string, data: ForecourtData | null): Gauge | null {
  if (!data) return null;
  const tanks = (data.tanks ?? []).filter((t) => t.product_id === productId);
  if (data.tanks && tanks.length > 0) {
    const left = tanks.reduce((s, t) => s + t.current_level, 0);
    const capacity = tanks.reduce((s, t) => s + t.capacity_litres, 0);
    const pct = capacity > 0 ? Math.min(100, Math.max(0, (left / capacity) * 100)) : 0;
    const low = pct < LOW_PCT || tanks.some((t) => t.reorder_level !== null && t.reorder_level > 0 && t.current_level <= t.reorder_level);
    return { kind: 'tank', pct, left, capacity, low, tanks: tanks.length };
  }
  const g = data.grades.find((r) => r.product_id === productId);
  const today = g?.litres_today ?? 0, yesterday = g?.litres_yesterday ?? 0;
  const pct = yesterday > 0 ? Math.min(100, (today / yesterday) * 100) : today > 0 ? 100 : 0;
  return { kind: 'today', pct, today, yesterday };
}

/** The grades on the pumps, once each, in the pumps' order. */
export function pumpGrades(pumps: ForecourtPump[]): { id: string; name: string; price: number | null }[] {
  const seen = new Map<string, { id: string; name: string; price: number | null }>();
  for (const p of pumps) {
    if (!p.fuel_product_id || seen.has(p.fuel_product_id)) continue;
    seen.set(p.fuel_product_id, { id: p.fuel_product_id, name: p.fuel_product_name ?? 'Fuel', price: p.price_per_litre ?? null });
  }
  return [...seen.values()];
}

export type PumpState = 'idle' | 'in_use' | 'selected' | 'off' | 'no_price';

/** A pump's state on the card: selected (its keypad open), in use (on this sale, or dispensing), idle, off or unpriced. */
export function pumpState(pump: ForecourtPump, selectedId: string | null, onSale: ReadonlySet<string>): PumpState {
  if (pump.status === 'inactive') return 'off';
  if (!pump.price_per_litre || pump.price_per_litre <= 0) return 'no_price';
  if (pump.id === selectedId) return 'selected';
  if (onSale.has(pump.id) || pump.status === 'dispensing') return 'in_use';
  return 'idle';
}

export const PUMP_STATE_LABEL: Record<PumpState, string> = {
  idle: 'Idle', in_use: 'In use', selected: 'Selected', off: 'Off', no_price: 'No price',
};

/** The point at `pct` (0–100) on a semicircle of radius r around (cx, cy), left to right over the top. */
export function arcPoint(pct: number, cx: number, cy: number, r: number): { x: number; y: number } {
  const a = Math.PI * (1 - Math.min(100, Math.max(0, pct)) / 100);
  return { x: cx + r * Math.cos(a), y: cy - r * Math.sin(a) };
}
