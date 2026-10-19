/**
 * nodeGateway.ts — A410: the branch server's side of "only the server talks to the cloud" (see cloudGateway.ts).
 *
 * `/node/cloud/api/<path>?<query>` from a till on the branch (already authenticated by the branch access code in
 * nodeServer) is passed to `<cloud>/api/<path>?<query>` as it came: same method, same body bytes, the till's own
 * Authorization / X-Device-Id / X-Idempotency-Key — so the cloud decides exactly what it would have decided had the till
 * called it itself. The answer goes back as it came (status, type, body — streamed, so an update download is not held
 * in memory), marked `X-Node-Gateway: 1`.
 *
 * Only `/api/…` on the configured cloud is reachable: the server is not an open proxy to the internet.
 * No internet here → 502 with `X-Node-Uplink: down`, which the till reads as "no connection" and retries later.
 */
import type http from 'http';
import { Readable } from 'stream';
import { GATEWAY_PREFIX, GATEWAY_MARK, UPLINK_DOWN } from './cloudGateway';

const MAX_BODY = 10 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 60_000;
/** A443: once the answer has started, it is cut only when no bytes arrive for this long (never on its total time). */
const UPSTREAM_IDLE_MS = 60_000;

/** Request headers never passed on: hop-by-hop, the LAN's own, and what fetch sets itself. */
const DROP_REQUEST = new Set([
  'host', 'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer',
  'content-length', 'accept-encoding', 'x-node-secret', 'origin', 'referer',
  'x-device-token',   // F7: a till's key for THIS server — never the cloud's business
]);
/** Response headers never passed back: the body is re-sent decoded, so length/encoding would lie. A529: never the cloud's
 *  X-ZapTill-Server — a till behind this server judges whose page an answer is by it (authTransport.ts), so it passes
 *  through unchanged; this server's own answers (the 502 X-Node-Uplink: down) carry none. */
const DROP_RESPONSE = new Set(['connection', 'keep-alive', 'transfer-encoding', 'content-encoding', 'content-length']);

/** The cloud URL for a gateway path, or null when the path is not one the gateway serves. Pure. */
export function upstreamUrl(rawUrl: string, serverUrl: string): string | null {
  const cloud = String(serverUrl ?? '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(cloud)) return null;
  if (!rawUrl.startsWith(`${GATEWAY_PREFIX}/`)) return null;
  const rest = rawUrl.slice(GATEWAY_PREFIX.length);              // "/api/…?…"
  const raw = rest.split('?')[0];
  // A496: decoded first (to a fixed point — %252e%252e is "..", twice encoded). The checks used to look at the raw path,
  // and fetch's URL parser reads %2e%2e as ".." — /node/cloud/api/%2e%2e/x reached <cloud>/x, outside the API.
  let pathOnly = raw;
  let settled = false;
  for (let i = 0; i < 4; i++) {
    let next: string;
    try { next = decodeURIComponent(pathOnly); } catch { return null; }
    if (next === pathOnly) { settled = true; break; }
    pathOnly = next;
  }
  if (!settled) return null;   // still encoded after four rounds: no real request looks like that
  // Only the cloud's API, and no climbing out of it.
  if (!pathOnly.startsWith('/api/') || pathOnly.includes('..') || pathOnly.includes('//') || pathOnly.includes('\\')) return null;
  // And the URL fetch will actually ask for is still inside the API (belt and braces: the URL parser's own reading).
  try { if (!new URL(`${cloud}${rest}`).pathname.startsWith('/api/')) return null; } catch { return null; }
  return `${cloud}${rest}`;
}

/** The till's headers as the cloud should see them. Pure. */
export function upstreamHeaders(h: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    if (v === undefined || DROP_REQUEST.has(k.toLowerCase())) continue;
    out[k] = Array.isArray(v) ? v.join(', ') : String(v);
  }
  return out;
}

function readRaw(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0;
    req.on('data', (c: Buffer) => { size += c.length; if (size > MAX_BODY) { req.destroy(); reject(new Error('body too large')); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res: http.ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), [GATEWAY_MARK]: '1', ...extra });
  res.end(payload);
}

export async function forwardToCloud(
  req: http.IncomingMessage, res: http.ServerResponse, serverUrl: string,
  deps: { fetch?: typeof fetch; timeoutMs?: number; idleMs?: number } = {},
): Promise<void> {
  const target = upstreamUrl(req.url ?? '', serverUrl);
  if (!target) return send(res, 400, { error: 'The branch server forwards only the ZapTill cloud API.' });

  const method = (req.method ?? 'GET').toUpperCase();
  let body: Buffer | undefined;
  try { body = method === 'GET' || method === 'HEAD' ? undefined : await readRaw(req); }
  catch { return send(res, 413, { error: 'Request too large for the branch server.' }); }

  // A443: the limit used to be AbortSignal.timeout(60 s) on the whole exchange — body included — so any answer that took
  // over a minute to pass on (an update installer on a shop line) was cut every time. Now: 60 s for the cloud to start
  // answering, then cut only when nothing arrives for 60 s.
  const ac = new AbortController();
  let timer: NodeJS.Timeout | null = setTimeout(() => ac.abort(), deps.timeoutMs ?? UPSTREAM_TIMEOUT_MS);
  const idleMs = deps.idleMs ?? UPSTREAM_IDLE_MS;
  const poke = () => { if (timer) clearTimeout(timer); timer = setTimeout(() => ac.abort(), idleMs); };
  const stop = () => { if (timer) clearTimeout(timer); timer = null; };
  let up: Response;
  try {
    up = await (deps.fetch ?? globalThis.fetch)(target, {
      method, headers: upstreamHeaders(req.headers), body: body && body.length ? body : undefined,
      redirect: 'follow', signal: ac.signal,
    } as RequestInit);
  } catch {
    stop();
    return send(res, 502, { error: 'The branch server cannot reach the cloud right now.' }, { [UPLINK_DOWN]: 'down' });
  }

  // Never throws from here on: a failure after the answer has started cuts the connection (the till sees no connection
  // and retries) rather than leaving nodeServer's own error reply to collide with a half-sent one.
  try {
    const headers: Record<string, string> = { [GATEWAY_MARK]: '1' };
    up.headers.forEach((v, k) => { if (!DROP_RESPONSE.has(k.toLowerCase())) headers[k] = v; });
    res.writeHead(up.status, headers);
    if (!up.body || method === 'HEAD') { stop(); res.end(); return; }
    poke();
    await new Promise<void>((resolve) => {
      const stream = Readable.fromWeb(up.body as any);
      stream.on('data', poke);
      stream.on('error', () => { stop(); res.destroy(); resolve(); });
      res.on('close', () => { stop(); resolve(); });
      stream.pipe(res);
    });
  } catch {
    stop();
    if (!res.headersSent) send(res, 502, { error: 'The branch server could not pass on the cloud\'s answer.' }, { [UPLINK_DOWN]: 'down' });
    else res.destroy();
  }
}
