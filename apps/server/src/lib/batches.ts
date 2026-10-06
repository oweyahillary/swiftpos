/**
 * batches.ts — A413: stock batches and expiry dates — the rules (pure; routes/batches.ts does the database work).
 *
 * Owner, 2026-10-06: "Batch and expiry-date tracking for stock". Decided: batches for products and ingredients; what is
 * left in each batch is WORKED OUT, oldest expiry first, from the branch's stock level.
 *
 * A batch is one delivery of one item at one branch (how much came in, its expiry date, the supplier's lot number). It
 * holds no running balance. What is left in each batch is the branch's CURRENT stock laid over the batches from the
 * newest-expiring back: whatever stock has gone (sold, used in recipes, wasted, counted short) is taken to have gone
 * from the oldest-expiring batch first — first expired, first out. So sales, tills, recipes and offline sync change not
 * at all, and the batch figures can never disagree with the stock level.
 *
 * Stock beyond what the open batches account for was there before anyone recorded batches ("no batch recorded"): it is
 * the oldest, so it is taken to go first.
 */

export interface BatchLike {
  id: string;
  quantity_received: number | string;
  expiry_date: string | null;       // YYYY-MM-DD
  received_at: string;              // ISO
}

export interface Allocated<B extends BatchLike> { batch: B; remaining: number }

const q3 = (n: number): number => Math.round((Number(n) || 0) * 1000) / 1000;

/**
 * The order stock leaves in: earliest expiry first; a batch with no expiry date after every dated one; then the earlier
 * delivery first.
 */
export function consumptionOrder<B extends BatchLike>(batches: B[]): B[] {
  return batches.slice().sort((a, b) => {
    const ea = a.expiry_date ?? '9999-12-31', eb = b.expiry_date ?? '9999-12-31';
    if (ea !== eb) return ea < eb ? -1 : 1;
    if (a.received_at !== b.received_at) return a.received_at < b.received_at ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * What is left in each batch, given what the branch holds now. Filled from the LAST batch to leave back to the first:
 * each takes at most what it received. What is left over is stock with no batch recorded.
 */
export function allocateBatches<B extends BatchLike>(held: number, batches: B[]): { batches: Allocated<B>[]; unbatched: number } {
  const order = consumptionOrder(batches);
  let left = Math.max(0, Number(held) || 0);
  const remaining = new Map<string, number>();
  for (let i = order.length - 1; i >= 0; i--) {
    const take = Math.min(left, Math.max(0, Number(order[i].quantity_received) || 0));
    remaining.set(order[i].id, q3(take));
    left = q3(left - take);
  }
  return { batches: order.map((b) => ({ batch: b, remaining: remaining.get(b.id) ?? 0 })), unbatched: q3(left) };
}

export type ExpiryStatus = 'expired' | 'soon' | 'ok' | 'none';

/** Whole days from `today` to the expiry date (0 = expires today; negative = already expired). Null without a date. */
export function daysLeft(expiry: string | null, today: string): number | null {
  if (!expiry || !/^\d{4}-\d{2}-\d{2}$/.test(expiry) || !/^\d{4}-\d{2}-\d{2}$/.test(today)) return null;
  return Math.round((Date.parse(`${expiry}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
}

/** Expired: its date has passed (an item is good through its expiry date). Soon: within `soonDays`. */
export function expiryStatus(expiry: string | null, today: string, soonDays = 7): ExpiryStatus {
  const d = daysLeft(expiry, today);
  if (d === null) return 'none';
  if (d < 0) return 'expired';
  if (d <= soonDays) return 'soon';
  return 'ok';
}

/** A date the person typed: YYYY-MM-DD, a real calendar day, within 20 years either way. Null when blank or bad. */
export function cleanExpiry(value: unknown, today: string): string | null | 'bad' {
  if (value === undefined || value === null || value === '') return null;
  const s = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return 'bad';
  const t = Date.parse(`${s}T00:00:00Z`);
  if (!Number.isFinite(t) || new Date(t).toISOString().slice(0, 10) !== s) return 'bad';
  const d = daysLeft(s, today);
  return d === null || Math.abs(d) > 366 * 20 ? 'bad' : s;
}

export function cleanBatchNo(value: unknown): string | null {
  const s = typeof value === 'string' ? value.trim().slice(0, 60) : '';
  return s || null;
}

/** Turn a received quantity into the unit the branch's stock is held in (a by-piece product holds pieces). */
export function heldUnits(quantity: number, byPiece: boolean, piecesPerUnit: number | null | undefined): number {
  return q3(byPiece ? quantity * Math.max(1, Number(piecesPerUnit) || 1) : quantity);
}

export interface ExpiryRow {
  status: ExpiryStatus; remaining: number; unit_cost: number | null;
}

/** The headline: how many batches (with stock left) have expired or expire soon, and what that stock is worth. */
export function expirySummary(rows: ExpiryRow[]): { expired: number; soon: number; expiredValue: number; soonValue: number } {
  let expired = 0, soon = 0, expiredValue = 0, soonValue = 0;
  for (const r of rows) {
    if (!(r.remaining > 0)) continue;
    const v = r.unit_cost === null ? 0 : r.remaining * r.unit_cost;
    if (r.status === 'expired') { expired++; expiredValue += v; }
    else if (r.status === 'soon') { soon++; soonValue += v; }
  }
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return { expired, soon, expiredValue: r2(expiredValue), soonValue: r2(soonValue) };
}
