/**
 * posInit.ts — A531: GET /api/pos/init's answer, built ONCE per catalogue version and kept in memory.
 *
 * Owner, 2026-10-19: "asking for the same 10 times an hour is not logical". Every till asked /init every 10 minutes and
 * the cloud rebuilt it from the database each time (~15 queries, the whole menu and the logo — Supabase egress). Now the
 * built answer (routes/pos.ts buildInit — the reads and rules as they always were) is kept per (business, requested
 * branch, catalogue version — migration 150's sync_versions): the next till of the business, and the next ask while
 * nothing changed, is answered with no database read. GET /api/pos/changes answers a settings change (`config`,
 * `branding`) from the same kept answer (lib/syncChanges.ts), rebuilt when it is older than that change.
 *
 * Nothing in it is per caller (checked 2026-10-19: no token, no device, no person, no permission is read — only the
 * business and the branch). The two per-caller things are applied by the route AFTER: the desktop licence gate (from the
 * kept operating branch) and the cost prices (removed for a till and for a person without menu.costs / reports.costs).
 *
 * Bounded: 200 answers / 50 MB, least recently used out first; each kept at most 10 minutes (an answer that depends on the
 * clock — the web POS's paid-until date — is never older than that; so is one whose change no version tracks: a variant
 * edited, which old tills took on their 10-minute pull before as well). Two tills asking at once for an answer not built
 * yet share one build. Before migration 150 (no version) it is built every time, as before. One server instance
 * (WEB_CONCURRENCY=1): one memory.
 */
import { traffic } from './trafficStats';
import { catalogueGen, memoEnabled } from './writeActivity';   // A591

type Err = { message: string; code?: string } | Error;
export type BuiltInit =
  | { ok: true; body: Record<string, unknown>; opBranch: { id?: string; desktop_licensed?: boolean } | null }
  | { ok: false; error: Err };
export type InitBuilder = (req: { businessId?: string | null }, requestedBranchId: string | null) => Promise<BuiltInit>;

let builder: InitBuilder | null = null;
/** routes/pos.ts hands in its buildInit (lib cannot import a route without a cycle). */
export function setInitBuilder(b: InitBuilder): void { builder = b; }

export const INIT_CACHE_MAX_ENTRIES = 200;
export const INIT_CACHE_MAX_BYTES = 50 * 1024 * 1024;
export const INIT_CACHE_MAX_AGE_MS = 10 * 60_000;
/**
 * A591: tills before 1.0.20 take the whole catalogue every 10 minutes, so a 10-minute memory was rebuilt (~15 reads and
 * the logo) on almost every ask. An answer is also used up to 60 minutes while NOTHING has been written for the business
 * through this server since it was built (lib/writeActivity.ts) — a variant edited, a setting changed, anything, and the
 * 10-minute rule applies again. A change made straight in SQL: up to an hour (a till also takes the whole menu daily).
 */
export const INIT_CACHE_QUIET_AGE_MS = 60 * 60_000;
interface Kept { body: Record<string, unknown>; opBranch: { id?: string; desktop_licensed?: boolean } | null; bytes: number; at: number; gen?: string }
const kept = new Map<string, Kept>();
const building = new Map<string, Promise<BuiltInit>>();
let keptBytes = 0;

function remember(key: string, v: Kept): void {
  const old = kept.get(key);
  if (old) { keptBytes -= old.bytes; kept.delete(key); }
  if (v.bytes > INIT_CACHE_MAX_BYTES) return;
  kept.set(key, v); keptBytes += v.bytes;
  while (kept.size > INIT_CACHE_MAX_ENTRIES || keptBytes > INIT_CACHE_MAX_BYTES) {
    const first = kept.keys().next().value;
    if (first === undefined) break;
    keptBytes -= kept.get(first)!.bytes; kept.delete(first);
  }
}

/**
 * /init's answer for (business, requested branch). `version` = the business's catalogue version (null: built, not kept).
 * `notBefore` (ms): a kept answer built before then is not used (a change written then — GET /changes).
 */
export async function initAnswer(businessId: string, requestedBranchId: string | null, version: number | null,
  o: { now?: number; notBefore?: number } = {}): Promise<BuiltInit> {
  const now = o.now ?? Date.now();
  const key = `${businessId}|${requestedBranchId ?? ''}|${version ?? ''}`;
  if (version !== null) {
    const hit = kept.get(key);
    const quiet = !!hit && memoEnabled() && hit.gen === catalogueGen(businessId) && now - hit.at < INIT_CACHE_QUIET_AGE_MS;   // A591
    if (hit && (now - hit.at < INIT_CACHE_MAX_AGE_MS || quiet) && hit.at >= (o.notBefore ?? 0)) {
      kept.delete(key); kept.set(key, hit);   // most recently used
      traffic.count('init.from_memory');
      return { ok: true, body: hit.body, opBranch: hit.opBranch };
    }
    const running = building.get(key);
    if (running && !o.notBefore) { traffic.count('init.joined'); return running; }
  }
  if (!builder) throw new Error('posInit: no builder (routes/pos.ts not loaded)');
  traffic.count('init.built');
  const startedAt = now;
  const gen = catalogueGen(businessId);   // A591: taken before the build
  const p = builder({ businessId }, requestedBranchId).then((b) => {
    if (b.ok && version !== null) {
      const good = b as { body: Record<string, unknown>; opBranch: Kept['opBranch'] };
      let bytes = 0;
      try { bytes = Buffer.byteLength(JSON.stringify(good.body)); } catch { bytes = INIT_CACHE_MAX_BYTES + 1; }
      remember(key, { body: good.body, opBranch: good.opBranch, bytes, at: startedAt, gen });
    }
    return b;
  });
  if (version !== null) {
    building.set(key, p);
    p.finally(() => { if (building.get(key) === p) building.delete(key); }).catch(() => { /* the caller sees it */ });
  }
  return p;
}

/** Test seam. */
export function _resetInitCache(): void { kept.clear(); building.clear(); keptBytes = 0; }
export function initCacheSize(): { entries: number; bytes: number } { return { entries: kept.size, bytes: keptBytes }; }
