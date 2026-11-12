/**
 * branchGateway.ts — Till stage 3, Slice A (docs/SCOPE-TILL-STAGE-3.md, docs/BUILD-TILL-STAGE-3A.md).
 *
 * When this Shop POS has JOINED a branch server (a ServerLink is saved — shop/branchServer.ts), its cloud calls go
 * THROUGH that server's gateway (`<server>/node/cloud/api/…`, A410) instead of straight to the cloud, exactly as a
 * desktop peer does (apps/desktop/src/main/cloudGateway.ts). The hop is over the pinned TLS of the server this POS
 * joined (the native BranchServer.request), never plain fetch — the certificate is trusted byte-for-byte (A489).
 *
 * A410 is a PREFERENCE here, not a lock-in (owner decision, 2026-11-12): any server problem — unreachable, its own
 * internet down, a build too old to have a gateway, or refusing this POS — is reported to the caller, which falls back
 * to the tablet's OWN cloud when it has internet and to the Till-stage-2 buffer when it does not. A POS with no
 * ServerLink is untouched (`via: 'none'`).
 *
 * Slice A ROUTES a cloud call. It does NOT add branch-held buffering (/node/sync) or cross-device state (/node/since) —
 * that is Slice B. Only GET and POST are routed; any other method falls back to the cloud (Android's HttpsURLConnection
 * cannot PATCH — revisited in Slice B).
 */
import { API_URL } from '../config';
import { BranchServer } from '../native/plugins';
import { readServerLink, type ServerLink } from './branchServer';
import { deviceId } from './tillSession';

/** Where a cloud call ended up. */
export type GatewayVia =
  | 'none'               // no branch server joined (or not a cloud URL) — the caller does its ordinary cloud call
  | 'gateway'            // the server forwarded the cloud's own answer — use it
  | 'server-unreachable' // the server did not answer on the network, or its identity changed
  | 'uplink-down'        // the server is up but cannot reach the cloud right now
  | 'old-server'         // the server is on a build with no cloud gateway
  | 'server-refused';    // the server refused this POS (wrong branch access code / device key)

export interface GatewayResult { via: GatewayVia; status?: number; body?: string; headers?: Record<string, string> }

/** The branch server sets this on every answer it forwards, so a real forward is told from an old server's 404. */
const GATEWAY_MARK = 'x-node-gateway';
/** The branch server sets this when IT has no internet. */
const UPLINK_DOWN = 'x-node-uplink';
const GATEWAY_PREFIX = '/node/cloud';

/** Trailing slashes off a base URL (linear — no regex backtracking). */
function noTrailingSlash(s: string): string {
  let end = s.length;
  while (end > 0 && s[end - 1] === '/') { end--; }
  return s.slice(0, end);
}

/**
 * Classify a raw TLS answer from the server's gateway (pure — tested without a device). `server-unreachable` is not here:
 * it comes from the request throwing, handled in gatewayFetch.
 */
export function readGatewayVia(status: number, headers: Record<string, string>): Exclude<GatewayVia, 'none' | 'server-unreachable'> {
  if (String(headers[UPLINK_DOWN] ?? '').toLowerCase() === 'down') return 'uplink-down';
  if (!headers[GATEWAY_MARK]) return status === 404 ? 'old-server' : 'server-refused';
  return 'gateway';
}

/** The gateway address for a full cloud URL: `<server>/node/cloud` + the cloud's own /api path and query. null when
 *  `cloudUrl` is not a call to this app's cloud (then it is left alone). Pure. */
export function gatewayTarget(serverUrl: string, cloudUrl: string): string | null {
  if (!cloudUrl.startsWith(API_URL)) return null;
  const tail = cloudUrl.slice(API_URL.length);
  const rest = tail.startsWith('/') ? tail : `/${tail}`;      // '/api/orders?…' (also '/' when the url is exactly the base)
  return `${noTrailingSlash(serverUrl)}${GATEWAY_PREFIX}${rest}`;
}

// ── Reachability gate ────────────────────────────────────────────────────────────────────────────────────────────────
// A server last seen unreachable (or on an old build) is skipped until the next probe, so a write does not pay a TLS
// timeout each time — the desktop keeps the same kind of memo (cloudGateway.ts oldNodeUntil / nodeHealth).
let serverDownUntil = 0;
const SERVER_DOWN_MS = 60_000;
let lastGateway: { at: number; via: GatewayVia } | null = null;

function markServerDown(now: number) { serverDownUntil = now + SERVER_DOWN_MS; }
/** The health check, or a forwarded answer, proves the server is answering again. */
export function noteServerReachable() { serverDownUntil = 0; }
/** What the last gateway call did (for the This-device page). */
export function lastGatewayState(): { at: number; via: GatewayVia } | null { return lastGateway; }

// The ServerLink (Keystore) read is cached for a few seconds so the hot path — every cloud call — does not read secure
// storage each time, and a POS with no branch server (the common case) skips it entirely most of the time.
let linkCache: { at: number; link: ServerLink | null } | null = null;
const LINK_TTL_MS = 5000;
async function cachedLink(now: number): Promise<ServerLink | null> {
  if (linkCache && now - linkCache.at < LINK_TTL_MS) return linkCache.link;
  const link = await readServerLink();
  linkCache = { at: now, link };
  return link;
}

// ── Protocol handshake (GET /node/health) ────────────────────────────────────────────────────────────────────────────
/** This POS's branch-server protocol — matches the desktop peers' NODE_PROTOCOL (apps/desktop nodeHealth.ts). */
export const TILL_PROTOCOL = 2;

export interface ServerHealth { protocol: number; minTillProtocol: number; capabilities: string[]; tooOldForServer: boolean; serverTooOld: boolean }

/** Parse /node/health (pure). A server before A501 reports no protocol → protocol 1. */
export function readServerHealth(body: unknown): ServerHealth {
  const b = (body && typeof body === 'object' ? body as Record<string, unknown> : {});
  const proto = Number(b.protocol);
  const minTill = Number(b.min_till_protocol);
  const protocol = Number.isInteger(proto) && proto > 0 ? proto : 1;
  const minTillProtocol = Number.isInteger(minTill) && minTill > 0 ? minTill : 1;
  const capabilities = Array.isArray(b.capabilities) ? (b.capabilities as unknown[]).filter((c) => typeof c === 'string') as string[] : [];
  return { protocol, minTillProtocol, capabilities, tooOldForServer: minTillProtocol > TILL_PROTOCOL, serverTooOld: protocol < TILL_PROTOCOL };
}

let health: ServerHealth | null = null;
export function serverHealth(): ServerHealth | null { return health; }
/** True when this POS is older than the server requires — it must NOT route through the gateway (update this POS). */
export function gatewayBlockedByProtocol(): boolean { return !!health?.tooOldForServer; }

/** The three IO calls, injectable so gatewayFetch/checkServerHealth are tested without a device (the codebase's style). */
export interface GatewayDeps {
  request?: (o: { url: string; method: 'GET' | 'POST'; headers?: Record<string, string>; body?: string; cert: string; timeoutMs?: number }) => Promise<{ status: number; body: string; headers?: Record<string, string> }>;
  link?: () => Promise<ServerLink | null>;
  device?: () => Promise<string>;
}

/** Ask the joined server what it speaks. Clears the down-memo on success. Call on POS open and on reconnect. */
export async function checkServerHealth(now: number = Date.now(), deps: GatewayDeps = {}): Promise<ServerHealth | null> {
  const request = deps.request ?? BranchServer.request;
  const getLink = deps.link ?? (() => cachedLink(now));
  const link = await getLink();
  if (!link) { health = null; return null; }
  try {
    const r = await request({ url: `${noTrailingSlash(link.url)}/node/health`, method: 'GET', cert: link.cert, timeoutMs: 6000 });
    if (r.status !== 200) { markServerDown(now); return health; }
    let parsed: unknown = {};
    try { parsed = r.body ? JSON.parse(r.body) : {}; } catch { parsed = {}; }
    health = readServerHealth(parsed);
    noteServerReachable();
    return health;
  } catch { markServerDown(now); return health; }
}

/**
 * Send one cloud call through the branch server if this POS joined one. `fullUrl` is the ordinary cloud URL the app would
 * have called (must start with API_URL); `headers` are the caller's own (Authorization, x-idempotency-key, …).
 */
export async function gatewayFetch(fullUrl: string, method: string, bodyString: string | undefined,
  headers: Record<string, string>, now: number = Date.now(), deps: GatewayDeps = {}): Promise<GatewayResult> {
  const request = deps.request ?? BranchServer.request;
  const getLink = deps.link ?? (() => cachedLink(now));
  const getDevice = deps.device ?? deviceId;
  const m = method.toUpperCase();
  if (m !== 'GET' && m !== 'POST') return { via: 'none' };     // Android cannot PATCH/PUT/DELETE natively → cloud-direct
  if (health?.tooOldForServer) return { via: 'none' };          // this POS is older than the server needs → cloud-direct
  const link = await getLink();
  if (!link) return { via: 'none' };
  const target = gatewayTarget(link.url, fullUrl);
  if (!target) return { via: 'none' };
  if (now < serverDownUntil) return { via: 'server-unreachable' };   // known down — don't hang this call

  let r: { status: number; body: string; headers?: Record<string, string> };
  try {
    r = await request({
      url: target, method: m as 'GET' | 'POST', cert: link.cert,
      headers: { ...headers, 'X-Node-Secret': link.nodeSecret, 'x-device-id': await getDevice(), 'x-device-token': link.deviceToken },
      ...(bodyString !== undefined ? { body: bodyString } : {}),
      timeoutMs: 8000,
    });
  } catch {
    markServerDown(now);
    lastGateway = { at: now, via: 'server-unreachable' };
    return { via: 'server-unreachable' };
  }
  const via = readGatewayVia(r.status, r.headers ?? {});
  lastGateway = { at: now, via };
  if (via === 'old-server') markServerDown(now);
  if (via === 'gateway') { noteServerReachable(); return { via, status: r.status, body: r.body, headers: r.headers }; }
  return { via, status: r.status };
}

/** Tests only. */
export function _resetBranchGateway(): void { serverDownUntil = 0; lastGateway = null; health = null; linkCache = null; }
