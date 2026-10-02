/**
 * productDays.ts — 0.6.31: a product SHOWN only on chosen days (still sold any day).
 *
 * Owner, 2026-10-02 (a pizza client's offer, Tuesday and Thursday): "show products only on chosen days, but the product
 * should be able to sell anyday not just the selected day". So `show_days` decides only whether the product is on the
 * POS grid (till, web POS) and the customer QR menu that day. On any other day it is off the grid but still found by
 * SEARCH and by barcode / PLU, and rings at its normal price — nothing about selling it changes.
 *
 *   show_days = null (or every day) → shown every day (every product before 0.6.31).
 *   show_days = [2, 4]              → shown on Tuesday and Thursday. 0 = Sunday … 6 = Saturday (Date.getDay()).
 *
 * ONE file: shared/productDays.ts, copied to the till, the web and the cloud (scripts/check-shared-sync.mjs).
 */

export const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const DAY_WORDS: Record<string, number> = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6,
};

/**
 * The days a product is shown, cleaned: sorted, de-duplicated, 0–6. `null` = every day (no days, or all seven).
 * Accepts an array of numbers or day names, JSON text of one, or text like "Tue, Thu" / "tue thu".
 * `undefined` = not a list of days at all (the caller refuses it).
 */
export function cleanShowDays(raw: unknown): number[] | null | undefined {
  if (raw === null || raw === undefined) return null;
  let v: unknown = raw;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s || /^(every ?day|all|daily)$/i.test(s)) return null;
    try { v = JSON.parse(s); } catch { v = s.split(/[\s,;/]+/).filter(Boolean); }
  }
  if (v === null) return null;
  if (!Array.isArray(v)) return undefined;
  const out = new Set<number>();
  for (const d of v) {
    if (typeof d === 'number' || (typeof d === 'string' && /^\d$/.test(d.trim()))) {
      const n = Number(d);
      if (!Number.isInteger(n) || n < 0 || n > 6) return undefined;
      out.add(n);
    } else if (typeof d === 'string' && d.trim().toLowerCase() in DAY_WORDS) {
      out.add(DAY_WORDS[d.trim().toLowerCase()]);
    } else {
      return undefined;
    }
  }
  if (out.size === 0 || out.size === 7) return null;
  return [...out].sort((a, b) => a - b);
}

/** Is the product on the grid on this day? (A bad stored value shows it — never hide a product by mistake.) */
export function showsOnDay(showDays: unknown, day: number): boolean {
  const d = cleanShowDays(showDays);
  return !d || d.includes(day);
}

/** Is the product on the grid today (this machine's day)? */
export function showsToday(showDays: unknown, now: Date = new Date()): boolean {
  return showsOnDay(showDays, now.getDay());
}

/**
 * The grid's rule: with a search typed, every product that matches (any day); without one, only today's. A product
 * hidden today is still sold — the cashier searches for it (or scans it).
 */
export function onGrid(showDays: unknown, searching: boolean, now: Date = new Date()): boolean {
  return searching || showsToday(showDays, now);
}

/** "Every day", or "Tue, Thu". */
export function showDaysLabel(showDays: unknown): string {
  const d = cleanShowDays(showDays);
  return d ? d.map((n) => DAY_SHORT[n]).join(', ') : 'Every day';
}
