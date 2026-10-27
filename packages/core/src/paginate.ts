/**
 * paginate.ts — A472: the menu in pages, and the POS grid a screenful at a time.
 *
 * Owner, 2026-10-14: "can we paginate the menu". Every menu list drew every product at once — 1,000+ rows on the web
 * Products page and the till's Menu screen, 1,000+ tiles on both POS grids.
 *   - Management lists (web Products, till Menu) get real pages: 25 / 50 / 100 a page, "Showing 51–100 of 1,234",
 *     First / Prev / 1 … 4 5 6 … 25 / Next / Last.
 *   - The POS grids get no page buttons — a cashier scrolls. They draw GRID_STEP tiles, then GRID_STEP more each time
 *     the grid is scrolled near its end.
 * Pure, no imports. ONE file: shared/paginate.ts, copied to the web and the till (scripts/check-shared-sync.mjs).
 */

export const PAGE_SIZES = [25, 50, 100] as const;
export const DEFAULT_PAGE_SIZE = 50;
/** Tiles a POS grid draws first, and adds each time it is scrolled near its end. */
export const GRID_STEP = 60;

/** A remembered page size, cleaned: one of PAGE_SIZES, else the default (a stale or tampered value never sticks). */
export function cleanPageSize(v: unknown): number {
  const n = Number(v);
  return (PAGE_SIZES as readonly number[]).includes(n) ? n : DEFAULT_PAGE_SIZE;
}

/** How many pages `total` rows make — at least 1, so an empty list is "page 1 of 1". */
export function pageCount(total: number, size: number): number {
  const s = size > 0 ? Math.floor(size) : DEFAULT_PAGE_SIZE;
  return Math.max(1, Math.ceil(Math.max(0, total) / s));
}

/** A page number that exists: 1 … pageCount. The page you were on stays unless it is gone (then the last page). */
export function clampPage(page: number, total: number, size: number): number {
  const p = Number.isFinite(page) ? Math.floor(page) : 1;
  return Math.min(Math.max(1, p), pageCount(total, size));
}

export interface Paged<T> {
  items: T[];
  /** The page shown (clamped), 1-based. */
  page: number;
  pages: number;
  size: number;
  total: number;
  /** 1-based position of the first and last row shown; both 0 when there are none. */
  from: number;
  to: number;
}

/** One page of `items`. The page is clamped, so a delete that empties the last page shows the one before it. */
export function paginate<T>(items: readonly T[], page: number, size: number): Paged<T> {
  const s = size > 0 ? Math.floor(size) : DEFAULT_PAGE_SIZE;
  const total = items.length;
  const p = clampPage(page, total, s);
  const start = (p - 1) * s;
  const slice = items.slice(start, start + s);
  return { items: slice, page: p, pages: pageCount(total, s), size: s, total, from: slice.length ? start + 1 : 0, to: start + slice.length };
}

/**
 * The numbered buttons: always the first and last page, the current one and one either side, "gap" where pages are
 * skipped. Seven slots once there are more than seven pages, so the pager never changes width as you move:
 *   1 2 3 4 5 … 20  ·  1 … 9 10 11 … 20  ·  1 … 16 17 18 19 20
 */
export type PageSlot = number | 'gap';
export function pageWindow(current: number, total: number): PageSlot[] {
  const t = Math.max(1, Math.floor(total));
  const c = Math.min(Math.max(1, Math.floor(current)), t);
  if (t <= 7) return Array.from({ length: t }, (_, i) => i + 1);
  if (c <= 4) return [1, 2, 3, 4, 5, 'gap', t];
  if (c >= t - 3) return [1, 'gap', t - 4, t - 3, t - 2, t - 1, t];
  return [1, 'gap', c - 1, c, c + 1, 'gap', t];
}

/** 1234567 → "1,234,567" — the same on every machine (no locale). */
export function groupDigits(n: number): string {
  return String(Math.max(0, Math.floor(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** "51–100 of 1,234" (the phone's pager) — "0 of 0" for none. */
export function rangeShort(p: Pick<Paged<unknown>, 'from' | 'to' | 'total'>): string {
  return p.total ? `${groupDigits(p.from)}–${groupDigits(p.to)} of ${groupDigits(p.total)}` : '0 of 0';
}

/** "Showing 51–100 of 1,234". */
export function rangeLabel(p: Pick<Paged<unknown>, 'from' | 'to' | 'total'>): string {
  return p.total ? `Showing ${rangeShort(p)}` : 'Nothing to show';
}

/** POS grid: how many tiles to draw after the grid is scrolled near its end — GRID_STEP more, never past the list. */
export function nextGridCount(shown: number, total: number, step: number = GRID_STEP): number {
  return Math.min(Math.max(0, total), Math.max(0, shown) + Math.max(1, step));
}

/**
 * POS grid: when the cashier types a product's exact name (or its barcode / PLU), that product is the first tile —
 * so it is on screen at once even when the search also matches hundreds of others. Stable: everything else keeps its
 * order. No search, or no exact hit → the same list back.
 */
export function exactFirst<T>(items: readonly T[], query: string, keys: (t: T) => Array<string | null | undefined>): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return items as T[];
  const hit: T[] = [], rest: T[] = [];
  for (const it of items) (keys(it).some(k => String(k ?? '').trim().toLowerCase() === q) ? hit : rest).push(it);
  return hit.length ? hit.concat(rest) : (items as T[]);
}
