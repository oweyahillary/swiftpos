/**
 * stockGate.ts — A563: what happens to an item when its stock reaches zero (the owner's choice).
 *
 * Owner, 2026-10-22: "add a feature where an owner can enable not to prevent items with zero stock from appearing in the
 * inventory or if they do they cannot be sold". One owner setting (Settings › Business › POS options, "When an item's
 * stock reaches zero"), three choices:
 *
 *   sell      Sell as normal (the default — what every till did before): zero or negative stock is still sold.
 *   sold_out  Show as sold out: the item stays on the menu, greyed with a "Sold out" badge, and cannot be sold.
 *   hide      Hide when out of stock: the item is not on the menu while its stock at the branch is 0 or less; it comes
 *             back when stock comes in. It cannot be sold either (a held order that holds it is refused at Charge).
 *
 * Stored as two POS switches (feature_flags 'stock_zero_sold_out' and 'stock_zero_hide', shared/posFeatures.ts), so it
 * reaches the tills, the branch server and the web POS the way every POS switch does — no migration. 'stock_zero_hide'
 * wins when both are on; neither = sell.
 *
 * ONLY products that track stock. The caller builds `levels` from tracked products alone: an item that does not track
 * stock is never in it, so it is never sold out. An item with NO known level (never stocked at the branch, or the level
 * not heard yet) is UNKNOWN — and unknown always sells: a till never refuses what it cannot verify.
 *
 * A combo (A400: selling it uses up its items) is sold out when a tracked item in it is out; its own level counts too
 * when it tracks stock. One level, as A400 (an item that is itself a combo counts as a product).
 *
 * Not per variant: an option's linked product (variant_options.linked_product_id) is not on the till, so a variant is
 * judged by its product alone.
 *
 * The source of truth on a till is the till's OWN copy of its branch's levels (stock_levels: the cloud's level, kept
 * current by the change log, A535, less this till's own sales that have not reached the cloud yet). Two tills selling the
 * last item while offline both see 1 and both sell it — each knows only what it has synced; the level goes to -1 and the
 * next sync shows it. A till's sale is never refused by the cloud: it already happened.
 *
 * Pure — the cloud, the till (main and screen) and the web POS use the same rules.
 * Copied verbatim: shared/, apps/server/src/lib/, apps/desktop/src/main/, apps/desktop/src/shared/, apps/dashboard/src/lib/.
 */

export type OutOfStockMode = 'sell' | 'sold_out' | 'hide';

/** The two switches that carry the choice (feature_flags keys; shared/posFeatures.ts lists them). */
export const STOCK_ZERO_SOLD_OUT_KEY = 'stock_zero_sold_out';
export const STOCK_ZERO_HIDE_KEY = 'stock_zero_hide';

/** The three choices as the owner reads them, in the order the setting shows them. */
export const OUT_OF_STOCK_MODES: ReadonlyArray<{ mode: OutOfStockMode; label: string; description: string }> = [
  { mode: 'sell', label: 'Sell as normal',
    description: 'Items stay on the menu and can be sold at zero or below (the stock goes negative). How it has always worked.' },
  { mode: 'sold_out', label: 'Show as sold out',
    description: 'Items at zero stay on the menu, greyed with a "Sold out" badge, and cannot be sold until stock comes in.' },
  { mode: 'hide', label: 'Hide when out of stock',
    description: 'Items at zero leave the till menu and the web POS, and come back by themselves when stock comes in.' },
];

export function isOutOfStockMode(v: unknown): v is OutOfStockMode {
  return v === 'sell' || v === 'sold_out' || v === 'hide';
}

/** The choice from the POS switches (anything carrying them: PosFeatures, a plain object). Only a real `true` counts. */
export function outOfStockMode(features: Partial<Record<string, unknown>> | null | undefined): OutOfStockMode {
  const f = features ?? {};
  if (f[STOCK_ZERO_HIDE_KEY] === true) return 'hide';
  if (f[STOCK_ZERO_SOLD_OUT_KEY] === true) return 'sold_out';
  return 'sell';
}

/** The two switches for a choice (what the cloud writes). */
export function outOfStockFlags(mode: OutOfStockMode): Record<string, boolean> {
  return { [STOCK_ZERO_SOLD_OUT_KEY]: mode === 'sold_out', [STOCK_ZERO_HIDE_KEY]: mode === 'hide' };
}

/**
 * What is known about stock at one branch.
 *   levels  product id → its stock there. TRACKED products only, and only where a level is known. Absent = unknown.
 *   combos  combo product id → its items (product id and how many of each one combo uses).
 */
export interface StockView {
  levels: Record<string, number>;
  combos?: Record<string, Array<{ product_id: string; quantity: number }>>;
}

export const NO_STOCK_VIEW: StockView = { levels: {}, combos: {} };

function knownLevel(view: StockView, productId: string): number | null {
  const v = view.levels[productId];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * How many of this product can be sold at the branch, or null when that is not known (untracked, no level, no tracked
 * item in a combo). A combo: the fewest whole combos its tracked items allow, and its own level when it has one.
 */
export function availableOf(view: StockView, productId: string | null | undefined): number | null {
  if (!productId) return null;
  let best: number | null = knownLevel(view, productId);
  for (const part of view.combos?.[productId] ?? []) {
    if (!part?.product_id || part.product_id === productId) continue;
    const lvl = knownLevel(view, part.product_id);
    if (lvl === null) continue;
    const per = Number(part.quantity) > 0 ? Number(part.quantity) : 1;
    const can = lvl <= 0 ? 0 : Math.floor(lvl / per);
    best = best === null ? can : Math.min(best, can);
  }
  return best;
}

/** Out of stock at the branch, known for certain (a tracked level at 0 or below, or a combo whose tracked item is). */
export function isOutOfStock(view: StockView, productId: string | null | undefined): boolean {
  const a = availableOf(view, productId);
  return a !== null && a <= 0;
}

/** Shown greyed with "Sold out" and not sold — the sold-out choice only (the hide choice takes it off the menu). */
export function showsSoldOut(mode: OutOfStockMode, view: StockView, productId: string | null | undefined): boolean {
  return mode === 'sold_out' && isOutOfStock(view, productId);
}

/** Off the till menu and the web POS (search too) — the hide choice only. */
export function hiddenOutOfStock(mode: OutOfStockMode, view: StockView, productId: string | null | undefined): boolean {
  return mode === 'hide' && isOutOfStock(view, productId);
}

export function soldOutMessage(name: string): string {
  return `${name || 'This item'} is sold out.`;
}

/** A line of a sale, as the gate reads it. */
export interface GateLine { product_id: string | null | undefined; name?: string | null; quantity: number }

export interface StockRefusal { index: number; product_id: string; name: string; available: number; message: string }

/** How much of each product the lines use: their own quantity plus what each combo uses of its items. */
export function stockDemand(lines: GateLine[], view: StockView): Map<string, number> {
  const out = new Map<string, number>();
  const add = (id: string, q: number) => { if (id && q > 0) out.set(id, (out.get(id) ?? 0) + q); };
  for (const l of lines ?? []) {
    const pid = l?.product_id ? String(l.product_id) : '';
    const q = Number(l?.quantity) || 0;
    if (!pid || q <= 0) continue;
    add(pid, q);
    for (const part of view.combos?.[pid] ?? []) {
      if (!part?.product_id || part.product_id === pid) continue;
      add(part.product_id, q * (Number(part.quantity) > 0 ? Number(part.quantity) : 1));
    }
  }
  return out;
}

/**
 * The lines of a sale the owner's choice refuses — none with "sell". A line is refused only when stock is KNOWN not to
 * cover it: its product's (or a tracked combo item's) level is below what the whole sale uses of it. Unknown sells.
 */
export function stockRefusals(mode: OutOfStockMode, view: StockView, lines: GateLine[]): StockRefusal[] {
  if (mode === 'sell') return [];
  const demand = stockDemand(lines, view);
  const out: StockRefusal[] = [];
  (lines ?? []).forEach((l, index) => {
    const pid = l?.product_id ? String(l.product_id) : '';
    if (!pid || !((Number(l?.quantity) || 0) > 0)) return;
    const name = String(l?.name ?? '').trim() || 'This item';
    const own = knownLevel(view, pid);
    if (own !== null && (demand.get(pid) ?? 0) > own) {
      out.push({ index, product_id: pid, name, available: Math.max(0, own),
        message: own <= 0 ? soldOutMessage(name) : `Only ${own} of ${name} left.` });
      return;
    }
    for (const part of view.combos?.[pid] ?? []) {
      if (!part?.product_id || part.product_id === pid) continue;
      const lvl = knownLevel(view, part.product_id);
      if (lvl === null || (demand.get(part.product_id) ?? 0) <= lvl) continue;
      out.push({ index, product_id: pid, name, available: 0,
        message: lvl <= 0 ? `${name} is sold out (an item in it is out of stock).` : `${name}: not enough stock left of an item in it.` });
      return;
    }
  });
  return out;
}

/** One sentence for a refused sale ("Chips is sold out. Only 2 of Soda left."). */
export function refusalText(refusals: StockRefusal[]): string {
  return [...new Set(refusals.map((r) => r.message))].slice(0, 5).join(' ') + ' Remove it from the order to continue.';
}
