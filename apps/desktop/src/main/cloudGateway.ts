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
import { lanFetch } from './lanTls';   // A489: the hop to the branch server is TLS once its certificate is pinned
import { noteChannelOk, noteChannelError } from './nodeHealth';   // A501
import { judgeCloudAnswer, noteCloudUnreachable, ForeignPageError, type SignatureStore } from './authTransport';   // A529
import { getLocalDb } from './localDb';   // A529: where "this cloud signs its answers" is kept
import { logLine } from './logFile';   // A529

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
  constructor(public status: number) { super(`fetch failed: the branch server refused this POS (HTTP ${status})`); this.name = 'NodeRefusedError'; }
}

// A448: the branch server's own refusal of this till (a wrong branch access code) — kept so the manager is TOLD, not just
// the log: sales were safe on the till, but nothing reached the cloud or the other tills, silently, until someone looked.
// A501: kept per REASON. A refusal of this till's device key is not an access-code problem (the notice told the manager
// to re-enter the code — it fixed nothing), a branch mismatch is neither, and a route that checks only the code (the
// gateway, /node/health) answering must not wipe a device-key or branch refusal that the keyed routes still give.
export type NodeRefusalReason = 'access_code' | 'device_key' | 'branch' | 'tls';
const refusals = new Map<NodeRefusalReason, { at: number; status: number }>();
const NODE_REFUSAL_SHOWN_MS = 5 * 60_000;
/** A501: what a refusal is about, from its status and the server's own words. */
export function refusalReasonFor(status: number, error?: string | null): NodeRefusalReason {
  if (status === 403) return 'branch';
  if (status === 426) return 'tls';
  const e = String(error ?? '');
  if (/X-Node-Secret|access code/i.test(e)) return 'access_code';
  // A586: a server on 1.0.20 says "POS"; an older one "till" — both are read.
  if (/device key|not joined|Update this (till|POS)|two different (tills|points of sale)/i.test(e)) return 'device_key';
  return 'access_code';
}
/** The branch server refused this till (status) — cleared by the next answer that proves the same thing is fixed. */
export function noteNodeRefused(status: number, now = Date.now(), reason: NodeRefusalReason = refusalReasonFor(status)): void {
  refusals.set(reason, { at: now, status });
}
/**
 * The branch server accepted a request. `scope` — 'any': a route that checks only the access code (the gateway,
 * /node/health) — clears the access-code and encryption refusals; 'keyed' (the default): a route that also checks this
 * till's device key and branch — clears every refusal.
 */
export function noteNodeAccepted(scope: 'any' | 'keyed' = 'keyed'): void {
  if (scope === 'keyed') { refusals.clear(); return; }
  refusals.delete('access_code'); refusals.delete('tls');
}
export function nodeRefusal(now = Date.now()): { status: number; since: string; reason: NodeRefusalReason } | null {
  let best: { status: number; since: string; reason: NodeRefusalReason } | null = null;
  let bestAt = 0;
  for (const [reason, r] of refusals) {
    if (now - r.at < NODE_REFUSAL_SHOWN_MS && r.at > bestAt) { bestAt = r.at; best = { status: r.status, since: new Date(r.at).toISOString(), reason }; }
  }
  return best;
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
export async function cloudFetch(url: string, init: any = {}, deps: { fetch?: typeof fetch; cfg?: GatewayConfig | null; now?: () => number; log?: (l: string) => void; signatures?: SignatureStore | null } = {}): Promise<Response> {
  const f = deps.fetch ?? lanFetch;
  const cfg = deps.cfg !== undefined ? deps.cfg : getDeviceConfig();
  const now = (deps.now ?? Date.now)();
  const route = routeCloudRequest(url, cfg);
  // A529: an answer to a request for the cloud's address must be the cloud's (its X-ZapTill-Server signature) — see
  // authTransport.ts. A test passing its own config keeps "seen to sign" in memory only, unless it passes a store.
  const cloudOrigin = originOf(String(cfg?.server_url ?? ''));
  const forCloud = !!cloudOrigin && originOf(url) === cloudOrigin;
  const store = deps.signatures !== undefined ? deps.signatures : (deps.cfg === undefined ? dbSignatureStore : null);
  const judged = (res: Response): Response => forCloud ? judgeAnswer(res, url, cloudOrigin!, store, now) : res;
  const direct = async (): Promise<Response> => {
    try { return judged(await f(url, init)); }
    catch (e: any) {
      if (forCloud && e?.name !== 'ForeignPageError') noteCloudUnreachable(`no answer (${e?.cause?.code ?? e?.message ?? e})`, now);
      throw e;
    }
  };
  if (!route.viaNode || now < oldNodeUntil) return direct();

  let res: Response;
  try { res = await f(route.url, { ...init, headers: mergeHeaders(init.headers, route.headers) }); }
  catch (e: any) {
    // A501: the gateway channel's record for the Tech page (the caller still sees the thrown fetch, as before).
    if (e?.name !== 'AbortError') noteChannelError('gateway', null, `the branch server did not answer (${e?.cause?.code ?? e?.cause?.message ?? e?.message ?? e})`, now);
    throw e;
  }
  if (res.headers.get(UPLINK_DOWN) === 'down') {
    noteChannelError('gateway', res.status, 'the branch server cannot reach the cloud right now', now);
    noteCloudUnreachable('the branch server cannot reach the cloud', now);   // A529: the manager's notice
    throw new UplinkDownError();
  }
  if (!res.headers.get(GATEWAY_MARK)) {
    if (res.status === 404) {
      oldNodeUntil = now + OLD_NODE_RETRY_MS;
      (deps.log ?? console.warn)('[gateway] the branch server is on an older build with no cloud gateway — this POS calls the cloud itself until it updates');
      return direct();
    }
    // Not the cloud's answer — the branch server's own (a wrong branch access code is a 401). Passed on, a 401 would read
    // as the till's sign-in being refused and start the lost-session recovery (A407). It is a connection problem.
    // A501: by what the server said — the gateway checks the access code (401) and, when the server requires it,
    // encryption (426); its words name which.
    const said = await res.clone().json().then((b: any) => (typeof b?.error === 'string' ? b.error : null)).catch(() => null);
    const reason = refusalReasonFor(res.status, said);
    (deps.log ?? console.warn)(`[gateway] the branch server refused the request (HTTP ${res.status})${said ? `: ${said}` : " — check this POS's branch access code"}`);
    if (res.status === 401 || res.status === 403 || res.status === 426) noteNodeRefused(res.status, now, reason);
    noteChannelError('gateway', res.status, said ?? `the branch server refused the request (HTTP ${res.status})`, now);
    throw new NodeRefusedError(res.status);
  }
  noteNodeAccepted('any');
  noteChannelOk('gateway', now);
  // A529: the branch server passed the answer on unchanged (nodeGateway.ts keeps X-ZapTill-Server) — whose page it is,
  // is the cloud's signature, as for a till that calls the cloud itself.
  return judged(res);
}

// ── A529: whose answer is it? ─────────────────────────────────────────────────────────────────────────────────────────
/** "This cloud signs its answers", per cloud origin, kept in maintenance_state so a till restarted DURING an outage still
 *  knows (authTransport.ts). A read or write that fails leaves the memory answer for this run. */
const SIGNS_KEY = (origin: string) => `cloud_signs:${origin}`;
export const dbSignatureStore: SignatureStore = {
  load: (origin) => !!(getLocalDb().prepare(`SELECT value FROM maintenance_state WHERE key = ?`).get(SIGNS_KEY(origin)) as { value?: string } | undefined)?.value,
  save: (origin) => {
    const at = new Date().toISOString();
    getLocalDb().prepare(`INSERT OR REPLACE INTO maintenance_state (key, value, updated_at) VALUES (?, ?, ?)`).run(SIGNS_KEY(origin), at, at);
    logLine('sync', `A529: the cloud ${origin} signs its answers - from now on a page without its signature counts as no connection`);
  },
  forget: (origin) => {
    getLocalDb().prepare(`DELETE FROM maintenance_state WHERE key = ?`).run(SIGNS_KEY(origin));
    logLine('sync', `A529: the cloud ${origin} answered without its signature (a JSON answer: a build from before A529) - its answers are judged by their status again`);
  },
};

/** The one route where our cloud hands a till over to another host (the update files are redirects to GitHub). */
const REDIRECTING_PATH = /^\/api\/desktop-update\//;
let _foreignLogged = { at: 0, status: 0 };

function judgeAnswer(res: Response, url: string, cloudOrigin: string, store: SignatureStore | null, now: number): Response {
  // The update files: the cloud redirects each to GitHub, so the file itself rightly comes from another host (followed
  // here, or by the branch server's gateway before it reaches a till). A file taken there is passed on — the updater
  // checks its sha512 against the cloud's own latest.yml. Any other redirect (a captive portal's) is judged where it landed.
  let path = '';
  try { path = new URL(url).pathname; } catch { path = ''; }
  if (REDIRECTING_PATH.test(path) && res.status >= 200 && res.status < 300) return res;
  const verdict = judgeCloudAnswer(res, cloudOrigin, store, now);
  if (verdict !== 'foreign') return res;
  // One line a minute per status: a pulled log explains an outage without a line per 15-s poll.
  if (now - _foreignLogged.at > 60_000 || _foreignLogged.status !== res.status) {
    _foreignLogged = { at: now, status: res.status };
    logLine('sync', `A529: HTTP ${res.status} at ${cloudOrigin} was not the cloud's page (no X-ZapTill-Server) - treated as no connection`);
  }
  try { void (res as any)?.body?.cancel?.().catch?.(() => {}); } catch { /* nothing to release */ }
  throw new ForeignPageError(res.status);
}

/** Tests only. */
export function _resetGatewayMemory(): void { oldNodeUntil = 0; noteNodeAccepted(); }
