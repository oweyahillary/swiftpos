/**
 * kitchenLines.ts — 0.6.28: what has gone to the kitchen, and the record of what was taken back (kitchen voids).
 *
 * Owner, 2026-10-01: "when a cashier clicks send to kitchen thats an order already even when the customer has not paid
 * yet … they can click send to kitchen then cancel … the customer pays they pocket the money and the kitchen staff
 * proceed to prepare the meal". Decided: once sent, every item ends PAID or as a recorded KITCHEN VOID — never gone
 * without a trace. A void prints a VOID ticket in the kitchen and is on the Z-report; with the client's
 * 'kitchen_void_approval' switch a manager must approve it (no grace period — "the manager has to know and cancel") and a
 * shift cannot end while a sent order is unpaid. 'pay_before_kitchen': takeaway/delivery/counter orders go to the kitchen
 * only when paid.
 *
 * A cart line carries `sentQty` — how many of it are already on a kitchen ticket. Until 0.6.28 it carried only a
 * yes/no `kotSent`, cleared by any change, so a line of 2 that became 3 went out as 3 more (the kitchen cooked 5), and
 * one reduced from 3 to 2 went out as 2 more.
 *
 * ONE file: shared/kitchenLines.ts, copied to the till, the web and the cloud (scripts/check-shared-sync.mjs).
 */

export interface KitchenLineLike {
  quantity: number;
  sentQty?: number | null;
  kotSent?: boolean;
}

/** Why sent items are taken back. `cooked` is asked separately (food already made is a waste, not just a cancel). */
export const KITCHEN_VOID_REASONS = [
  { code: 'wrong_item',      label: 'Wrong item punched' },
  { code: 'wrong_quantity',  label: 'Wrong quantity punched' },
  { code: 'changed_mind',    label: 'Customer changed their mind' },
  { code: 'out_of_stock',    label: 'Out of stock' },
  { code: 'kitchen_mistake', label: 'Kitchen mistake' },
] as const;

export type KitchenVoidReason = (typeof KITCHEN_VOID_REASONS)[number]['code'];

export const KITCHEN_VOID_NOTE_MAX = 200;

const qty = (n: unknown) => Math.max(0, Math.round((Number(n) || 0) * 1000) / 1000);
const money = (n: unknown) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * How many of this line are already on a kitchen ticket. A line saved before 0.6.28 (a held tab) has only `kotSent`:
 * sent means all of it. Never more than the line holds.
 */
export function sentQtyOf(line: KitchenLineLike): number {
  const q = qty(line.quantity);
  const s = line.sentQty !== undefined && line.sentQty !== null ? qty(line.sentQty) : (line.kotSent ? q : 0);
  return Math.min(s, q);
}

/** How many of this line the kitchen has not heard about yet. */
export function unsentQtyOf(line: KitchenLineLike): number {
  return Math.max(0, qty(qty(line.quantity) - sentQtyOf(line)));
}

/** Does anything on this order sit on a kitchen ticket? */
export function anySent(lines: KitchenLineLike[]): boolean {
  return (lines ?? []).some((l) => sentQtyOf(l) > 0);
}

/**
 * Changing a line to `newQty` (0 = removing it): how many SENT items that takes back — 0 when only unsent ones go.
 * Anything above 0 is a kitchen void.
 */
export function voidQtyFor(line: KitchenLineLike, newQty: number): number {
  return Math.max(0, qty(sentQtyOf(line) - qty(newQty)));
}

/** May this order be sent to the kitchen before it is paid? Dine-in always; the rest unless 'pay_before_kitchen'. */
export function maySendBeforePay(payBeforeKitchen: boolean, orderType: string | null | undefined): boolean {
  return !payBeforeKitchen || orderType === 'dine_in';
}

/** A reason code as stored, or null when it is not one of ours. */
export function cleanVoidReason(raw: unknown): KitchenVoidReason | null {
  const s = String(raw ?? '').trim();
  return (KITCHEN_VOID_REASONS as readonly { code: string }[]).some((r) => r.code === s) ? (s as KitchenVoidReason) : null;
}

export function voidReasonLabel(code: string | null | undefined): string {
  return KITCHEN_VOID_REASONS.find((r) => r.code === code)?.label ?? String(code ?? '');
}

/** The optional note: trimmed, spaces squeezed, cut to KITCHEN_VOID_NOTE_MAX. Empty → null. */
export function cleanVoidNote(raw: unknown): string | null {
  const s = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, KITCHEN_VOID_NOTE_MAX).trim();
  return s || null;
}

export interface KitchenVoidRow {
  product_name?: string | null;
  quantity: unknown;
  amount: unknown;
  reason?: string | null;
  cooked?: unknown;
}

export interface KitchenVoidSummary {
  count: number;                       // void lines
  quantity: number;                    // items taken back
  value: number;                       // what they would have sold for
  cookedValue: number;                 // of which already cooked (food wasted)
  byReason: Array<{ reason: string; label: string; quantity: number; value: number }>;
}

/** The Z-report's "Kitchen voids" block — the same sums on the till and the cloud. */
export function summariseKitchenVoids(rows: KitchenVoidRow[]): KitchenVoidSummary {
  const by = new Map<string, { quantity: number; value: number }>();
  let quantity = 0, value = 0, cookedValue = 0;
  for (const r of rows ?? []) {
    const q = qty(r.quantity), v = money(r.amount);
    quantity += q; value += v;
    if (r.cooked === true || r.cooked === 1 || r.cooked === '1' || r.cooked === 'true') cookedValue += v;
    const k = String(r.reason ?? '');
    const b = by.get(k) ?? { quantity: 0, value: 0 };
    b.quantity += q; b.value += v;
    by.set(k, b);
  }
  return {
    count: (rows ?? []).length,
    quantity: qty(quantity),
    value: money(value),
    cookedValue: money(cookedValue),
    byReason: [...by.entries()]
      .map(([reason, b]) => ({ reason, label: voidReasonLabel(reason), quantity: qty(b.quantity), value: money(b.value) }))
      .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label)),
  };
}

/**
 * One kitchen void as the Z-report prints it: "2x Chicken — Wrong item punched; made; approved Jane, cashier Tom".
 * `made` only when the kitchen had already made it; the approver when there was one. Semicolons, not "·": a thermal
 * printer has no "·" (it is dropped) — the paper must read the same as the screen.
 */
export function kitchenVoidText(v: {
  quantity: unknown; product_name?: string | null; reason?: string | null; cooked?: unknown;
  approved_by_name?: string | null; cashier_name?: string | null;
}): string {
  const made = v.cooked === true || v.cooked === 1 || v.cooked === '1' || v.cooked === 'true';
  const who = [v.approved_by_name ? `approved ${v.approved_by_name}` : '', v.cashier_name ? `cashier ${v.cashier_name}` : '']
    .filter(Boolean).join(', ');
  return `${qty(v.quantity)}x ${String(v.product_name ?? 'Item')} — ${voidReasonLabel(v.reason)}${made ? '; made' : ''}` +
    (who ? `; ${who}` : '');
}
