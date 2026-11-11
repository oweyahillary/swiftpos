/**
 * offlineReads.ts — Till stage 2 COLD-START (docs/ANDROID-APP-DESIGN.md §4.7): the catalogue the selling screen needs to
 * OPEN — pos/init, tables/bays, pumps, printers, the restaurant order-mode setting — kept from the last time each was
 * fetched online, so the Shop POS opens and sells from a COLD BOOT with no connection. (A disconnect MID-shift already
 * keeps an open screen selling — offlineWrites; this is the boot-offline case, where usePOSData has nothing yet.)
 *
 * This is the READ half of the offline seam; offlineWrites is the write half, and both share the ONE window.fetch wrap
 * (installOfflineWrites). Online, a whitelisted GET is cached as it passes through — last-known-good, one row per
 * path+query. Offline, the same GET is answered from that cache instead of failing, so usePOSData loads the real catalogue
 * rather than erroring to a blank screen (or the wrong 'retail' default). NOTHING else is cached: the whitelist is exactly
 * the selling screen's own reads, so no unrelated or sensitive response is ever kept.
 *
 * Pure decisions (isCacheableRead, readCacheKey, cachedResponse) are split out so they are tested without a device; the
 * Preferences-backed store is a thin wrapper, cleared by Reset app with every other Preference.
 */

/** The selling screen's own catalogue reads (apps/dashboard usePOSData) — the ONLY GETs cached for a cold start. Matched
 *  on the PATH; the query (?branch_id=…, &slot_type=…) is part of the cache KEY, not the match. */
const CACHEABLE_READS = ['/api/pos/init', '/api/tables', '/api/pumps', '/api/printers', '/api/business/settings'];

export function isCacheableRead(path: string): boolean {
  const justPath = (path.split('?')[0] || '').replace(/\/+$/, '');
  return CACHEABLE_READS.includes(justPath);
}

/** The cache key: the full path AND query, so the dining /api/tables?branch_id=X and the parking-bay
 *  /api/tables?branch_id=X&slot_type=parking_bay never collide, and each branch keeps its own catalogue. */
export function readCacheKey(path: string): string {
  return path;
}

export interface CachedRead { status: number; body: string; at: string }

/** A Response the screens' fetch resolves with for a cached read while offline. The `x-zaptill-offline-cache` header marks
 *  it so a reader (or a test) can tell a served-from-cache answer from a live one. */
export function cachedResponse(entry: CachedRead): Response {
  return new Response(entry.body, {
    status: entry.status,
    headers: { 'Content-Type': 'application/json', 'x-zaptill-offline-cache': entry.at || '1' },
  });
}

export interface ReadCache {
  get(key: string): Promise<CachedRead | null>;
  put(key: string, status: number, body: string, at: string): Promise<void>;
}

const prefKey = (key: string) => `zaptill.read.${key}`;

/** The cold-start read cache, in Capacitor Preferences (cleared by Reset app). One row per whitelisted path+query. */
export function makeReadCache(): ReadCache {
  return {
    async get(key) {
      const { Preferences } = await import('@capacitor/preferences');
      const { value } = await Preferences.get({ key: prefKey(key) });
      if (!value) return null;
      try { return JSON.parse(value) as CachedRead; } catch { return null; }
    },
    async put(key, status, body, at) {
      const { Preferences } = await import('@capacitor/preferences');
      await Preferences.set({ key: prefKey(key), value: JSON.stringify({ status, body, at }) });
    },
  };
}
