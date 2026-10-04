/**
 * stockTakeRules.ts — A394: the rules of a stock count (pure; routes/stockTakes.ts does the database work).
 *
 * Owner, 2026-10-04: "We are missing a stock take module" — "Yes the count should be blind, I would recommend freeze but
 * we leave that as a feature which the owner will decide".
 *
 * HOW A COUNT WORKS
 *   counting → (submit) → review → (post) → posted;  review → (recount some items) → counting;  open → cancelled.
 *   Blind: the person counting types what is on the shelf and never sees what the system expects. The cloud records
 *   what the system held at the moment each item was counted (expected_qty), so the shop can keep trading while it
 *   counts — a sale after the item was counted is a sale after the count, not a shortage.
 *   Till sales made BEFORE the item was counted that only reach the cloud afterwards (a till offline) would make the
 *   item look short; at review and post those late sales are found and taken off what was expected (lateSales).
 *   Posting changes stock by the difference (a delta, never "set to"), so sales and deliveries after the count stay.
 *   Freeze (the owner's setting): an item being counted cannot be sold until it has been counted.
 */

export type StockTakeStatus = 'counting' | 'review' | 'posted' | 'cancelled';
export type StockTakeAction = 'count' | 'submit' | 'recount' | 'post' | 'cancel';

/** The status a count must be in for each step. */
export const ALLOWED_FROM: Record<StockTakeAction, StockTakeStatus[]> = {
  count:   ['counting'],
  submit:  ['counting'],
  recount: ['review'],
  post:    ['review'],
  cancel:  ['counting', 'review'],
};

export function canDo(status: string, action: StockTakeAction): boolean {
  return (ALLOWED_FROM[action] as string[]).includes(status);
}

export function isOpen(status: string): boolean {
  return status === 'counting' || status === 'review';
}

/** ST-0001, ST-0002 … per business. */
export function stockTakeRef(previousCount: number): string {
  return `ST-${String(Math.max(0, Math.floor(previousCount)) + 1).padStart(4, '0')}`;
}

export const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * What the person typed, as a quantity: a number ≥ 0 with at most 2 decimals; a whole number for an item counted in
 * pieces. null = not a count (empty, negative, letters).
 */
export function parseCount(value: unknown, byPiece: boolean): number | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim().replace(/,/g, '');
  if (s === '' || !/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0 || n > 10_000_000) return null;
  if (byPiece && !Number.isInteger(n)) return null;
  return round2(n);
}

export interface SaleMovement {
  quantity_change: number | string;
  created_at: string;               // when the cloud deducted it
  reference_id: string | null;      // the order
}

/**
 * Till sales of this item made before it was counted that reached the cloud after it was counted. Returned as the
 * (negative) stock change they made — add it to what was expected. `orderMadeAt` maps order id → when the sale was made
 * (orders.created_at is the till's time). A movement with no order, or an order not found, is not counted as late.
 */
export function lateSales(moves: SaleMovement[], orderMadeAt: Map<string, string>, countedAt: string): number {
  const counted = Date.parse(countedAt);
  if (!Number.isFinite(counted)) return 0;
  let sum = 0;
  for (const m of moves) {
    if (Date.parse(m.created_at) <= counted) continue;           // already in what the system held
    const made = m.reference_id ? orderMadeAt.get(m.reference_id) : undefined;
    if (!made || Date.parse(made) > counted) continue;           // sold after the count — not late
    sum += Number(m.quantity_change) || 0;
  }
  return round2(sum);
}

export interface LineOutcome {
  expectedFinal: number;
  variance: number;         // counted − expected: below 0 = short, above 0 = more than expected
  varianceValue: number;    // variance × unit cost (0 when no cost is known)
  delta: number;            // what posting adds to stock (= variance)
}

export function lineOutcome(counted: number, expectedAtCount: number, late: number, unitCost: number | null, byPiece: boolean): LineOutcome {
  let expectedFinal = round2(Number(expectedAtCount) + Number(late));
  if (byPiece) expectedFinal = Math.round(expectedFinal);
  const variance = round2(counted - expectedFinal);
  const varianceValue = unitCost != null && Number.isFinite(Number(unitCost)) ? round2(variance * Number(unitCost)) : 0;
  return { expectedFinal, variance, varianceValue, delta: variance };
}

export interface SummaryLine {
  counted_qty: number | string | null;
  variance?: number | string | null;
  variance_value?: number | string | null;
}

export interface CountSummary {
  items: number;
  counted: number;
  notCounted: number;
  withVariance: number;
  shortValue: number;       // ≤ 0
  overValue: number;        // ≥ 0
  netValue: number;
}

export function summarise(lines: SummaryLine[]): CountSummary {
  const s: CountSummary = { items: lines.length, counted: 0, notCounted: 0, withVariance: 0, shortValue: 0, overValue: 0, netValue: 0 };
  for (const l of lines) {
    if (l.counted_qty === null || l.counted_qty === undefined) { s.notCounted++; continue; }
    s.counted++;
    const v = Number(l.variance ?? 0);
    const val = Number(l.variance_value ?? 0);
    if (v !== 0) s.withVariance++;
    if (val < 0) s.shortValue += val; else s.overValue += val;
  }
  s.shortValue = round2(s.shortValue); s.overValue = round2(s.overValue); s.netValue = round2(s.shortValue + s.overValue);
  return s;
}

export interface FreezeTake { status: string; freeze: boolean }
export interface FreezeLine { item_kind: string; product_id: string | null; counted_qty: number | string | null }

/**
 * Products that may not be sold right now because of this count: a frozen, open count's products not yet counted.
 * Once an item is counted its sales are after the count, so it is released at once.
 */
export function frozenProductIds(take: FreezeTake | null | undefined, lines: FreezeLine[]): string[] {
  if (!take || !take.freeze || !isOpen(take.status)) return [];
  return lines
    .filter((l) => l.item_kind === 'product' && l.product_id && (l.counted_qty === null || l.counted_qty === undefined))
    .map((l) => String(l.product_id));
}

/** The fields a person counting may see — never what the system expects or the difference. */
const BLIND_HIDDEN = ['expected_qty', 'late_sales', 'expected_final', 'variance', 'variance_value', 'posted_delta', 'previous_count'] as const;

export function blindLine<T extends Record<string, unknown>>(line: T): Omit<T, typeof BLIND_HIDDEN[number]> {
  const out: Record<string, unknown> = { ...line };
  for (const k of BLIND_HIDDEN) delete out[k];
  return out as Omit<T, typeof BLIND_HIDDEN[number]>;
}

/** The owner's setting: is an item being counted frozen? Stored by POST /business/settings as a JSON string. */
export const STOCK_COUNT_FREEZE_KEY = 'stock_count_freeze';

export function freezeSetting(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === 'string') {
    const s = value.trim().replace(/^"|"$/g, '').toLowerCase();
    return s === 'true' || s === '1' || s === 'yes' || s === 'on';
  }
  return false;
}
