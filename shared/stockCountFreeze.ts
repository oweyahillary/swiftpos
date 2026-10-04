/**
 * stockCountFreeze.ts — A394: items a stock count freezes at this till's branch (the owner's choice: "I would recommend
 * freeze but we leave that as a feature which the owner will decide").
 *
 * The cloud sends `stockCount` with /api/pos/init — `{ ref, productIds }` for a count that freezes, null when nothing
 * is frozen; an older cloud sends nothing (keep). The till caches it (device_config.stock_count_freeze) and the sale
 * screen refuses those products until they have been counted (the cloud releases each one as it is counted, and the
 * till hears within ~20 s through the catalogue-version check). Offline, the last list heard stays in force.
 *
 * Pure — the main process, the node relay and the renderer use the same parse.
 */
export interface StockCountFreeze { ref: string | null; productIds: string[] }

export const NO_FREEZE: StockCountFreeze = { ref: null, productIds: [] };

/** From the wire (an object) or the cache (a JSON string). Anything else → nothing frozen. */
export function parseStockCountFreeze(raw: unknown): StockCountFreeze {
  let v: unknown = raw;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return NO_FREEZE; } }
  if (!v || typeof v !== 'object') return NO_FREEZE;
  const o = v as { ref?: unknown; productIds?: unknown };
  const ids = Array.isArray(o.productIds) ? o.productIds.filter((x): x is string => typeof x === 'string' && x.length > 0) : [];
  if (!ids.length) return NO_FREEZE;
  return { ref: typeof o.ref === 'string' && o.ref ? o.ref.slice(0, 20) : null, productIds: [...new Set(ids)].slice(0, 5000) };
}

export function isFrozen(f: StockCountFreeze, productId: string | null | undefined): boolean {
  return !!productId && f.productIds.includes(productId);
}

export function frozenMessage(ref: string | null, name: string): string {
  return `${name} is being counted${ref ? ` (${ref})` : ''} — it can be sold again once it has been counted.`;
}
