/**
 * cloudGateway.ts — A410: at a branch with a server, only the server talks to the cloud.
 *
 * Owner, 2026-10-05: "if its a branch other tills rely on that server why would it save to cloud for other the server
 * should be the only till communicating with the cloud not other tills" — and "if such a setting exist remove it".
 * There was no setting: every till called the cloud directly as well as the branch server (sales, menu, sign-in
 * renewals, manager edits, updates). A till with no internet of its own could not save a change, and each till needed
 * its own way out.
 *
 * Now a till configured with a branch server (a peer) sends EVERY cloud request to the server instead
 * (`<node_url>/node/cloud/api/…`, with the branch access code), and the server forwards it to the cloud and passes the
 * answer straight back (nodeServer.ts). The cloud sees the same request — the till's own token, device and idempotency
 * headers — so nothing about what is allowed changes; only the route does.
 *
 *   - The branch server itself, an office PC, and a till with no branch server are unchanged: they call the cloud.
 *   - The server cannot reach the cloud → it answers 502 with `X-Node-Uplink: down`; the till treats that exactly like
 *     having no internet (sales queue, retried later). It does NOT go round the server.
 *   - The server cannot be reached on the network → the same: no connection.
 *   - The one exception is a branch server still on a build from before this one (it answers 404 without the
 *     `X-Node-Gateway` mark): the till calls the cloud itself so it is not stranded while the branch updates. Logged.
 */
import { getDeviceConfig, isNodeRole } from './deviceConfig';

export const GATEWAY_PREFIX = '/node/cloud';
/** Set by the branch server on every forwarded answer, so a till can tell it from an old server's 404. */
export const GATEWAY_MARK = 'x-node-gateway';
/** Set by the branch server when IT has no internet. */
export const UPLINK_DOWN = 'x-node-uplink';

export interface GatewayConfig {
  device_role?: string | null;
  node_url?: string | null;
  node_secret?: string | null;
  server_url?: string | null;
}

/** The till's branch server address when this till must go through it; null when it talks to the cloud itself. */
export function gatewayBase(cfg: GatewayConfig | null | undefined): string | null {
  if (!cfg || isNodeRole(cfg.device_role ?? null)) return null;
  const node = String(cfg.node_url ?? '').trim().replace(/\/+$/, '');
  return node ? `${node}${GATEWAY_PREFIX}` : null;
}

function originOf(u: string): string | null {
  try { return new URL(u).origin; } catch { return null; }
}

/**
 * Where a request for `url` goes. A cloud URL on a peer becomes the branch server's gateway address plus the branch
 * access code; anything else (a peer's own /node/* calls, a printer, another host) is left alone.
 */
export function routeCloudRequest(url: string, cfg: GatewayConfig | null | undefined):
  { url: string; headers: Record<string, string>; viaNode: boolean } {
  const base = gatewayBase(cfg);
  const cloud = originOf(String(cfg?.server_url ?? ''));
  const target = originOf(url);
  if (!base || !cloud || target !== cloud) return { url, headers: {}, viaNode: false };
  const u = new URL(url);
  return {
    url: `${base}${u.pathname}${u.search}`,
    headers: { 'X-Node-Secret': String(cfg?.node_secret ?? '') },
    viaNode: true,
  };
}

/** The cloud base URL a feed or a long-lived client should use (the gateway on a peer), and the headers it must send. */
export function cloudBaseFor(cloudUrl: string, cfg: GatewayConfig | null | undefined): { base: string; headers: Record<string, string> } {
  const r = routeCloudRequest(String(cloudUrl).replace(/\/+$/, '') + '/', cfg);
  return { base: r.url.replace(/\/+$/, ''), headers: r.headers };
}

/** Thrown for "the branch server has no internet" — callers already treat a thrown fetch as no connection. */
export class UplinkDownError extends Error {
  constructor() { super('fetch failed: the branch server cannot reach the cloud right now'); this.name = 'UplinkDownError'; }
}

/** The branch server itself refused (wrong access code, its own fault) — also "no connection" to the caller. */
export class NodeRefusedError extends Error {
  constructor(public status: number) { super(`fetch failed: the branch server refused this till (HTTP ${status})`); this.name = 'NodeRefusedError'; }
}

// A branch server on an older build has no gateway. Remembered for a while so every request does not pay a round trip.
let oldNodeUntil = 0;
const OLD_NODE_RETRY_MS = 10 * 60_000;

function mergeHeaders(h: any, extra: Record<string, string>): any {
  if (!Object.keys(extra).length) return h;
  if (h && typeof h.forEach === 'function' && !(h instanceof Array)) {
    const out: Record<string, string> = {};
    h.forEach((v: string, k: string) => { out[k] = v; });
    return { ...out, ...extra };
  }
  return { ...(h ?? {}), ...extra };
}

/**
 * fetch() for anything that may be a cloud call. On a peer the request goes through the branch server; see the header.
 * `deps` exists for tests.
 */
export async function cloudFetch(url: string, init: any = {}, deps: { fetch?: typeof fetch; cfg?: GatewayConfig | null; now?: () => number; log?: (l: string) => void } = {}): Promise<Response> {
  const f = deps.fetch ?? globalThis.fetch;
  const cfg = deps.cfg !== undefined ? deps.cfg : getDeviceConfig();
  const now = (deps.now ?? Date.now)();
  const route = routeCloudRequest(url, cfg);
  if (!route.viaNode || now < oldNodeUntil) return f(url, init);

  const res = await f(route.url, { ...init, headers: mergeHeaders(init.headers, route.headers) });
  if (res.headers.get(UPLINK_DOWN) === 'down') throw new UplinkDownError();
  if (!res.headers.get(GATEWAY_MARK)) {
    if (res.status === 404) {
      oldNodeUntil = now + OLD_NODE_RETRY_MS;
      (deps.log ?? console.warn)('[gateway] the branch server is on an older build with no cloud gateway — this till calls the cloud itself until it updates');
      return f(url, init);
    }
    // Not the cloud's answer — the branch server's own (a wrong branch access code is a 401). Passed on, a 401 would read
    // as the till's sign-in being refused and start the lost-session recovery (A407). It is a connection problem.
    (deps.log ?? console.warn)(`[gateway] the branch server refused the request (HTTP ${res.status}) — check this till's branch access code`);
    throw new NodeRefusedError(res.status);
  }
  return res;
}

/** Tests only. */
export function _resetGatewayMemory(): void { oldNodeUntil = 0; }
