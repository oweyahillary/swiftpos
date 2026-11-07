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
 */
import { bufferableKind, orderUuidOf } from '@zaptill/core/tillBuffer';
import { type BufferStore, enqueue } from './buffer';

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
  return {
    ...b,
    id: orderUuid,
    uuid: orderUuid,
    order_number: b.order_number ?? `OFF-${String(orderUuid).slice(0, 6).toUpperCase()}`,
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
    if (!isCloud || !deps.isOffline()) return original(input as RequestInfo, init);

    const path = url.slice(deps.cloudBase.length);
    const action = offlineDecision(method, path);
    if (action === 'read') return original(input as RequestInfo, init);     // the screens handle "needs connection"
    if (action === 'refuse') return refuseResponse();

    let body: unknown = undefined;
    try { body = init?.body ? JSON.parse(String(init.body)) : undefined; } catch { body = undefined; }
    const at = now();
    const row = await enqueue(deps.store, { method, path, body }, at);
    if (!row) return refuseResponse();
    return okResponse(provisionalOrderResponse(path, body, at));
  };

  globalThis.fetch = wrapped;
  return () => { globalThis.fetch = original; };
}
