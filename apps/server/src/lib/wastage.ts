/**
 * wastage.ts — A399: the wastage log's rules (pure; routes/wastage.ts does the database work).
 *
 * Owner, 2026-10-05: "i will work with your pic" — the wastage log: spoiled, expired or dropped items, each with a
 * reason, and what it cost.
 *
 *   An entry — one item written off at one branch: quantity, reason, value (quantity × unit cost, a snapshot).
 *   Stock    — a stock-tracked product or an ingredient leaves the branch at once; an item that is not stock-tracked (a
 *              burger made to order) is recorded for its value only.
 *   A void   — puts the stock back; the entry stays, marked void, and no longer counts.
 */
const round2 = (n: number): number => Math.round((Number(n) || 0) * 100) / 100;

export const WASTE_REASONS = [
  { key: 'expired',         label: 'Expired' },
  { key: 'spoiled',         label: 'Spoiled / gone off' },
  { key: 'damaged',         label: 'Damaged / dropped' },
  { key: 'kitchen_mistake', label: 'Kitchen mistake' },
  { key: 'returned',        label: 'Returned by a customer' },
  { key: 'staff_meal',      label: 'Staff meal' },
  { key: 'other',           label: 'Other' },
] as const;
export type WasteReason = (typeof WASTE_REASONS)[number]['key'];

export function cleanReason(value: unknown): WasteReason | null {
  const s = String(value ?? '').trim().toLowerCase();
  return (WASTE_REASONS as readonly { key: string }[]).some((r) => r.key === s) ? (s as WasteReason) : null;
}

export function reasonLabel(key: string): string {
  return WASTE_REASONS.find((r) => r.key === key)?.label ?? key;
}

/** "Other" needs a note saying what happened; the rest may have one. */
export function noteProblem(reason: WasteReason, note: string): string | null {
  return reason === 'other' && !note.trim() ? 'Say what happened (the reason is "Other").' : null;
}

/** WST-0001 … per business — one per recording (several items recorded together share it). */
export function wastageRef(previousRefs: number): string {
  return `WST-${String(Math.max(0, Math.floor(previousRefs)) + 1).padStart(4, '0')}`;
}

export function entryValue(quantity: number, unitCost: number | null): number {
  return unitCost === null || !Number.isFinite(unitCost) ? 0 : round2(quantity * unitCost);
}

export interface EntryLike {
  name: string; item_kind: string; product_id: string | null; ingredient_id: string | null;
  quantity: number | string; value: number | string; reason: string; voided_at?: string | null; created_at: string;
}

export interface WastageSummary {
  total: number;           // value of the entries that count (not void)
  entries: number;
  byReason: Array<{ reason: string; label: string; value: number; entries: number }>;
  byItem: Array<{ name: string; kind: string; quantity: number; value: number; entries: number }>;   // top 20 by value
}

/** What was written off in a period: the total, by reason and by item (most costly first). Void entries do not count. */
export function wastageSummary(rows: EntryLike[]): WastageSummary {
  const live = rows.filter((r) => !r.voided_at);
  const reasons = new Map<string, { value: number; entries: number }>();
  const items = new Map<string, { name: string; kind: string; quantity: number; value: number; entries: number }>();
  for (const r of live) {
    const v = Number(r.value) || 0, q = Number(r.quantity) || 0;
    const a = reasons.get(r.reason) ?? { value: 0, entries: 0 };
    a.value += v; a.entries++; reasons.set(r.reason, a);
    const key = `${r.item_kind}:${r.product_id ?? r.ingredient_id ?? r.name}`;
    const b = items.get(key) ?? { name: r.name, kind: r.item_kind, quantity: 0, value: 0, entries: 0 };
    b.quantity += q; b.value += v; b.entries++; items.set(key, b);
  }
  return {
    total: round2(live.reduce((s, r) => s + (Number(r.value) || 0), 0)),
    entries: live.length,
    byReason: [...reasons].map(([reason, a]) => ({ reason, label: reasonLabel(reason), value: round2(a.value), entries: a.entries }))
      .sort((x, y) => y.value - x.value || y.entries - x.entries),
    byItem: [...items.values()].map((b) => ({ ...b, quantity: Math.round(b.quantity * 1000) / 1000, value: round2(b.value) }))
      .sort((x, y) => y.value - x.value || y.quantity - x.quantity).slice(0, 20),
  };
}
