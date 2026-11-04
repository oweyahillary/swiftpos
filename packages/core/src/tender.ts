/**
 * tender.ts — the payment screen's helpers, one set for both POS (owner decision 2026-11-04: one design for both POS
 * screens, the desktop POS as the base; docs/POS-SCREEN-COMPARISON.html).
 *
 * - quickTenders: the quick cash buttons — Exact, the next notes up (50, 100, 200, 500, 1,000) and the next round
 *   100 / 1,000 — exactly the web POS's rule since A151.
 * - TIP_PERCENTS / tipAt / tipPercentOf: the tip buttons, 5 / 10 / 15 % of the bill.
 * - evenShares / itemShares: split the bill evenly per person, or by item per guest (A151's rules: the legs always add
 *   up to the bill exactly — the cloud refuses a set that does not).
 * - pointsEarned: the loyalty points a sale earns, as the web POS has shown them (1 point per KES 10, times the tier).
 * - pointsAfterSale: what the desktop POS shows after a sale to a loyalty customer — the points earned, the new balance.
 *
 * Pure: no imports, no network. Used by @zaptill/ui's QuickCash, TipPicker and BillSplit, and by both payment screens.
 */

/** Cents, as the money rules elsewhere round them. */
export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

const NOTES = [50, 100, 200, 500, 1000];

/**
 * The quick cash amounts for what is due: Exact (rounded up to the shilling), the next two notes up, the next round
 * 100 and, above 1,000, the next round 1,000 — at most four, smallest first, never below what is due.
 */
export function quickTenders(due: number): number[] {
  if (!(due > 0)) return [];
  const set = new Set<number>();
  set.add(Math.ceil(due));
  NOTES.filter((n) => n >= due).slice(0, 2).forEach((n) => set.add(n));
  set.add(Math.ceil(due / 100) * 100);
  if (due > 1000) set.add(Math.ceil(due / 1000) * 1000);
  return Array.from(set).filter((v) => v >= due).sort((a, b) => a - b).slice(0, 4);
}

/** Is this quick amount the "Exact" one (the bill rounded up to the shilling)? */
export const isExactTender = (amount: number, due: number) => amount === Math.ceil(due);

/** The tip buttons. */
export const TIP_PERCENTS = [5, 10, 15] as const;

/** A tip of `pct` % of the bill, to the cent. */
export const tipAt = (base: number, pct: number) => round2((Math.max(0, base) * pct) / 100);

/** Which tip button this tip is (it matches one to the cent), or null: none, or a typed amount. */
export function tipPercentOf(tip: number, base: number): number | null {
  if (!(tip > 0)) return null;
  return TIP_PERCENTS.find((p) => Math.abs(tip - tipAt(base, p)) < 0.005) ?? null;
}

/**
 * The bill split evenly between `people` (at least 2): equal shares to the cent, the rounding left over on person 1, so
 * the shares add up to the bill exactly.
 */
export function evenShares(total: number, people: number): number[] {
  const n = Math.max(2, Math.floor(people));
  const share = Math.floor((total / n) * 100) / 100;
  const rest = round2(total - share * n);
  return Array.from({ length: n }, (_, i) => (i === 0 ? round2(share + rest) : share));
}

/**
 * The bill split by item: `assign[i]` is the guest (0-based) line i is on. A guest's share is their lines' totals,
 * scaled so that the shares add up to the bill (the discount, offers and tip make the lines differ from it); the
 * rounding left over goes on the first guest who has something. A guest with no line pays 0.
 */
export function itemShares(lineAmounts: number[], assign: number[], guests: number, total: number): number[] {
  const raw = Array.from({ length: guests }, (_, g) =>
    lineAmounts.reduce((s, a, i) => (assign[i] === g ? s + a : s), 0));
  const rawSum = round2(raw.reduce((s, r) => s + r, 0));
  const scaled = raw.map((r) => (rawSum > 0 ? round2((total * r) / rawSum) : 0));
  const delta = round2(total - scaled.reduce((s, a) => s + a, 0));
  const first = scaled.findIndex((a) => a > 0);
  if (first >= 0) scaled[first] = round2(scaled[first] + delta);
  return scaled;
}

/** A by-item split may be charged when at least two guests have something and the shares add up to the bill. */
export function itemSplitReady(shares: number[], total: number): boolean {
  const sum = round2(shares.reduce((s, a) => s + a, 0));
  return shares.filter((a) => a > 0).length >= 2 && Math.abs(sum - total) < 0.01;
}

/** The loyalty points a sale of `charged` earns (1 point per KES 10, times the customer's tier multiplier) — `earnRate`
 *  points per KES 10 where the business set one (the cloud's rule when it credits them; the desktop POS passes it). */
export const pointsEarned = (charged: number, multiplier = 1, earnRate = 1) =>
  Math.max(0, Math.floor(Math.floor(Math.max(0, charged) / 10) * (earnRate > 0 ? earnRate : 1) * (multiplier > 0 ? multiplier : 1)));

/**
 * Owner, 2026-11-04: after a sale to a customer the desktop POS shows the points it earns and the customer's new balance
 * (as the web's payment screen), from the points they had before the sale (an online look-up). `charged` is the bill the
 * cloud credits points on (after discounts, without the tip).
 */
export function pointsAfterSale(before: { points: number; multiplier: number; earnRate: number }, charged: number): { earned: number; balance: number } {
  const earned = pointsEarned(charged, before.multiplier, before.earnRate);
  return { earned, balance: Math.max(0, Math.floor(before.points)) + earned };
}
