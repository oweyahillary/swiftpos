/**
 * stockCountFreeze.ts — A394: items a stock count freezes at this till's branch (the owner's choice: "I would recommend
 * freeze but we leave that as a feature which the owner will decide").
 *
 * The cloud sends `stockCount` with /api/pos/init — `{ ref, productIds }` for a count that freezes, null when nothing
 * is frozen; an older cloud sends nothing (keep). The till caches it (device_config.stock_count_freeze) and the sale
 * screen refuses those products until they have been counted (the cloud releases each one as it is counted, and the
 * till hears within ~20 s through the catalogue-version check). Offline, the last list heard stays in force.
 *
 * A521 (owner, 2026-10-17: "nothing may wait on a till that is switched off"): the list carries `heard_at` — when the
 * cloud last confirmed it (a branch server passes its own on). Past FREEZE_MAX_AGE_MS without hearing it again (the till,
 * or its server, offline that long) the freeze lifts by itself — a count is never held open for days by a till that
 * cannot hear it ended. Before that a manager's PIN may sell a frozen item (the cloud accepts a till's sale of one).
 *
 * Pure — the main process, the node relay and the renderer use the same parse.
 */
export interface StockCountFreeze { ref: string | null; productIds: string[]; heard_at?: string | null }

export const NO_FREEZE: StockCountFreeze = { ref: null, productIds: [] };

/** A521: a freeze not confirmed by the cloud for this long lifts by itself. */
export const FREEZE_MAX_AGE_MS = 12 * 3_600_000;

/** From the wire (an object) or the cache (a JSON string). Anything else → nothing frozen. */
export function parseStockCountFreeze(raw: unknown): StockCountFreeze {
  let v: unknown = raw;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return NO_FREEZE; } }
  if (!v || typeof v !== 'object') return NO_FREEZE;
  const o = v as { ref?: unknown; productIds?: unknown; heard_at?: unknown };
  const ids = Array.isArray(o.productIds) ? o.productIds.filter((x): x is string => typeof x === 'string' && x.length > 0) : [];
  if (!ids.length) return NO_FREEZE;
  const out: StockCountFreeze = { ref: typeof o.ref === 'string' && o.ref ? o.ref.slice(0, 20) : null, productIds: [...new Set(ids)].slice(0, 5000) };
  if (typeof o.heard_at === 'string' && Number.isFinite(Date.parse(o.heard_at))) out.heard_at = o.heard_at;
  return out;
}

/** A521: has this freeze gone unconfirmed past FREEZE_MAX_AGE_MS? A list with no `heard_at` is not judged here. */
export function freezeExpired(f: StockCountFreeze, nowMs: number = Date.now()): boolean {
  if (!f.productIds.length || !f.heard_at) return false;
  const t = Date.parse(f.heard_at);
  return Number.isFinite(t) && nowMs - t > FREEZE_MAX_AGE_MS;
}

export function isFrozen(f: StockCountFreeze, productId: string | null | undefined): boolean {
  return !!productId && f.productIds.includes(productId);
}

export function frozenMessage(ref: string | null, name: string): string {
  return `${name} is being counted${ref ? ` (${ref})` : ''} — it can be sold again once it has been counted, or ask a manager.`;
}
