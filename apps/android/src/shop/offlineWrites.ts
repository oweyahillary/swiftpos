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

/** The URL of a fetch input. */
function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return (input as Request).url;
}

/** The caller's body as a string (the web POS sends JSON strings); undefined for anything else, so it is left untouched. */
function bodyStringOf(init?: RequestInit): string | undefined {
  const b = init?.body;
  return typeof b === 'string' ? b : undefined;
}

/** The request's headers as a plain object (Headers / array / object), so the branch gateway can forward them. */
function headersOf(init: RequestInit | undefined, input: RequestInfo | URL): Record<string, string> {
  const out: Record<string, string> = {};
  const src = init?.headers ?? (input instanceof Request ? input.headers : undefined);
  if (!src) return out;
  if (Array.isArray(src)) {
    for (const [k, v] of src as [string, string][]) { out[k] = String(v); }
    return out;
  }
  if (typeof (src as Headers).forEach === 'function') {
    (src as Headers).forEach((v, k) => { out[k] = v; });
    return out;
  }
  for (const [k, v] of Object.entries(src as Record<string, string>)) { out[k] = String(v); }
  return out;
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
  /** Till stage 3: route a cloud call through the joined branch server (shop/branchGateway.ts). Returns a Response when
   *  the server forwarded the cloud's own answer, or null to fall back to the cloud (online) or the buffer (offline).
   *  Omit it and nothing routes — Till stage 1/2 is unchanged. Tried before the cloud, so a POS with no internet of its
   *  own still sells when the branch server has internet. */
  gateway?: (fullUrl: string, method: string, body: string | undefined, headers: Record<string, string>) => Promise<Response | null>;
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

  // Till stage 3: try the joined branch server first. A Response = the server forwarded the cloud's answer; null (or no
  // gateway) = fall back to the cloud / the buffer here. Tried for reads and writes alike, online or not.
  const viaBranch = (url: string, method: string, init?: RequestInit, input?: RequestInfo | URL): Promise<Response | null> =>
    deps.gateway ? deps.gateway(url, method, bodyStringOf(init), headersOf(init, input ?? url)) : Promise.resolve(null);

  // A read: the branch server's answer if it forwarded one, else the cloud; the selling screen's catalogue GETs are
  // cached as they pass through (online or via the server) and served from that cache offline, for a cold boot.
  const serveRead = async (m: string, path: string, init: RequestInit | undefined, input: RequestInfo | URL, fromServer: Response | null): Promise<Response> => {
    const cacheable = m === 'GET' && !!deps.reads && isCacheableRead(path);
    if (cacheable && !fromServer && deps.isOffline()) {
      const hit = await deps.reads!.get(readCacheKey(path));
      return hit ? cachedResponse(hit) : original(input as RequestInfo, init);       // no cache yet → the screen's own error
    }
    const res = fromServer ?? await original(input as RequestInfo, init);
    if (cacheable && res.ok) { try { await deps.reads!.put(readCacheKey(path), res.status, await res.clone().text(), now()); } catch { /* cache is best-effort */ } }
    return res;
  };

  // A write the cloud/server could not take: buffer a sale (stamped with the ring-up time so the REPLAY is priced and
  // de-stocked as of WHEN it happened — apps/server orders.ts anchors to created_at), refuse anything else.
  const bufferWrite = async (method: string, path: string, init?: RequestInit): Promise<Response> => {
    if (offlineDecision(method, path) === 'refuse') return refuseResponse();
    let body: unknown = undefined;
    try { body = init?.body ? JSON.parse(String(init.body)) : undefined; } catch { body = undefined; }
    const at = now();
    const stamped = body && typeof body === 'object' ? { ...(body as Record<string, unknown>), created_at: at } : body;
    const row = await enqueue(deps.store, { method, path, body: stamped }, at);
    if (!row) return refuseResponse();
    return okResponse(provisionalOrderResponse(path, stamped, at));
  };

  const wrapped: typeof fetch = async (input, init) => {
    const url = urlOf(input);
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')) || 'GET';
    if (!url.startsWith(deps.cloudBase)) return original(input as RequestInfo, init);   // not the cloud: untouched
    const path = url.slice(deps.cloudBase.length);
    const m = method.toUpperCase();

    const fromServer = await viaBranch(url, m, init, input);                  // the joined branch server, when present
    if (m === 'GET' || m === 'HEAD') return serveRead(m, path, init, input, fromServer);
    if (fromServer) return fromServer;                                       // the server forwarded the write (own internet or not)
    if (!deps.isOffline()) return original(input as RequestInfo, init);      // online: the sale reaches the cloud (Till stage 1)
    return bufferWrite(method, path, init);                                  // offline and the server could not help: buffer
  };

  globalThis.fetch = wrapped;
  return () => { globalThis.fetch = original; };
}
