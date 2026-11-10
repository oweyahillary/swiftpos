/**
 * offlineWrites.ts — Till stage 2 (docs/ANDROID-APP-DESIGN.md §4.7): the seam that catches the web POS screens' writes
 * while the Shop POS is offline and puts them in the buffer, handing the screens a provisional answer so the sale goes
 * through and prints. Online, nothing changes — the call reaches the cloud as in Till stage 1.
 *
 * Why a seam and not a change to the shared api.ts: the one-POS rule keeps shared code untouched, and the app already
 * routes fetch through CapacitorHttp natively. `installOfflineWrites` wraps window.fetch and is OPT-IN — the ShopPos
 * entry calls it only inside a Shop POS, so Till stage 1 and the web/desktop are unaffected. The decision and the
 * provisional answer are pure (offlineDecision, provisionalOrderResponse), so they are tested without a device; the exact
 * response shape the screens need is reconciled on hardware (the stage's "test slowly").
 *
 * This one wrap is also the READ half of the seam (cold start): when a read cache is given (shop/offlineReads.ts), the
 * selling screen's catalogue GETs are cached online and served from cache offline, so the POS opens from a cold boot.
 */
import { bufferableKind, orderUuidOf } from '@zaptill/core/tillBuffer';
import { type BufferStore, enqueue } from './buffer';
import { type ReadCache, isCacheableRead, readCacheKey, cachedResponse } from './offlineReads';

/** What to do with a call while offline. A read is left to the screens (they show "needs connection"); a bufferable write
 *  is queued; any other write is refused so nothing a Shop POS cannot replay silently vanishes. */
export type OfflineAction = 'buffer' | 'refuse' | 'read';

export function offlineDecision(method: string, path: string): OfflineAction {
  const m = String(method || 'GET').toUpperCase();
  if (m === 'GET' || m === 'HEAD') return 'read';
  return bufferableKind(m, path) ? 'buffer' : 'refuse';
}

/** A provisional answer for an offline write so the screens proceed. For an order it carries the tablet's own uuid as the
 *  id (the server dedupes on it), a provisional number (reconciled on sync — numbering never blocks a sale, §4.7) and
 *  `offline: true`. Minimal and honest; the real shape per screen is settled on hardware. Pure. */
export function provisionalOrderResponse(path: string, body: unknown, at: string): Record<string, unknown> {
  const kind = bufferableKind('POST', path) ?? 'order';
  const orderUuid = orderUuidOf(kind, path, body) ?? (globalThis.crypto?.randomUUID?.() ?? `off-${Date.now()}`);
  const b = (body && typeof body === 'object' ? body as Record<string, unknown> : {});
  const orderNumber = (b.order_number as string | undefined) ?? `OFF-${String(orderUuid).slice(0, 6).toUpperCase()}`;
  return {
    ...b,
    // The web POS reads camelCase { orderId, orderNumber } (apps/dashboard PaymentModal), exactly as the server returns on
    // a real save — without these the receipt shows a blank number and the cart never clears. snake fields kept for any
    // other reader.
    orderId: orderUuid,
    orderNumber,
    id: orderUuid,
    uuid: orderUuid,
    order_number: orderNumber,
    status: b.status ?? 'completed',
    created_at: at,
    offline: true,
  };
}

/** A synthetic Response the screens' fetch resolves with for a buffered write (200 + the provisional body). */
export function okResponse(bodyObj: unknown): Response {
  return new Response(JSON.stringify(bodyObj), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

/** A synthetic refusal for a write a Shop POS may not take offline. */
export function refuseResponse(): Response {
  return new Response(JSON.stringify({ error: "This cannot be done offline — reconnect to do it.", code: 'OFFLINE_NOT_ALLOWED' }),
    { status: 503, headers: { 'Content-Type': 'application/json' } });
}

export interface OfflineWritesDeps {
  store: BufferStore;
  /** True while there is no usable connection (shop/connection.ts useOnline, read live). */
  isOffline: () => boolean;
  /** The cloud base the screens call, so only those requests are considered (config API_URL). */
  cloudBase: string;
  /** The cold-start read cache (shop/offlineReads.ts). When given, the selling screen's catalogue GETs are cached online
   *  and served from cache offline, so the POS opens from a cold boot. Omit it and reads just pass through (Till stage 1). */
  reads?: ReadCache;
  now?: () => string;
}

/**
 * Wrap window.fetch so offline writes to the cloud are buffered (OPT-IN — call once inside a Shop POS). Returns a function
 * that restores the original fetch. Online, or for requests not to the cloud, the original fetch is used unchanged.
 */
export function installOfflineWrites(deps: OfflineWritesDeps): () => void {
  const original = globalThis.fetch?.bind(globalThis);
  if (!original) return () => {};
  const now = deps.now ?? (() => new Date().toISOString());

  const wrapped: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')) || 'GET';
    const isCloud = typeof url === 'string' && url.startsWith(deps.cloudBase);
    if (!isCloud) return original(input as RequestInfo, init);                // not the cloud: untouched
    const path = url.slice(deps.cloudBase.length);

    // ── Reads (cold start) ────────────────────────────────────────────────────────────────────────────────────────────
    // The selling screen's catalogue GETs are cached as they pass through online, and answered from that cache offline, so
    // the POS opens from a cold boot (opt-in: only when deps.reads is given). Every other read passes straight through.
    const m = method.toUpperCase();
    if (m === 'GET' || m === 'HEAD') {
      if (m === 'GET' && deps.reads && isCacheableRead(path)) {
        const key = readCacheKey(path);
        if (deps.isOffline()) {
          const hit = await deps.reads.get(key);
          return hit ? cachedResponse(hit) : original(input as RequestInfo, init);   // no cache yet → the screen's own error
        }
        const res = await original(input as RequestInfo, init);
        if (res.ok) { try { await deps.reads.put(key, res.status, await res.clone().text(), now()); } catch { /* cache is best-effort */ } }
        return res;
      }
      return original(input as RequestInfo, init);
    }

    // ── Writes ────────────────────────────────────────────────────────────────────────────────────────────────────────
    if (!deps.isOffline()) return original(input as RequestInfo, init);       // online: the sale reaches the cloud (Till stage 1)
    const action = offlineDecision(method, path);                            // offline: 'buffer' a sale, 'refuse' anything else
    if (action === 'refuse') return refuseResponse();

    let body: unknown = undefined;
    try { body = init?.body ? JSON.parse(String(init.body)) : undefined; } catch { body = undefined; }
    const at = now();
    // Stamp the tablet's ring-up time into the body so the REPLAYED call is priced and de-stocked as of WHEN the sale
    // happened (apps/server orders.ts anchors to created_at), not whenever the queue later drains.
    const stamped = body && typeof body === 'object' ? { ...(body as Record<string, unknown>), created_at: at } : body;
    const row = await enqueue(deps.store, { method, path, body: stamped }, at);
    if (!row) return refuseResponse();
    return okResponse(provisionalOrderResponse(path, stamped, at));
  };

  globalThis.fetch = wrapped;
  return () => { globalThis.fetch = original; };
}
