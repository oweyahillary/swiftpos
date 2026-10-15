/**
 * lanTls.ts — A489: the branch server and its tills talk over TLS on the shop network.
 *
 * Owner, 2026-10-14 (branch server audit): the LAN carried every till's sign-in token, the branch access code (handed
 * out at join), staff PIN hashes (/node/roster) and every sale in plain HTTP — readable by anyone on the shop's wifi.
 *
 * How it works:
 *   - The branch server makes its own certificate once (ECDSA P-256, self-signed, 20 years) and keeps it in
 *     maintenance_state. No extra library: the certificate is a few hundred bytes of DER built here and signed with
 *     node:crypto. Nothing about it is secret except the key; `GET /node/tls` hands the certificate to anyone.
 *   - It answers plain HTTP and TLS on the SAME port (nodeServer looks at the first byte of each connection), so the
 *     firewall rule, the beacon and every saved address stay as they are, and a till on an older build keeps working.
 *   - A till PINS the certificate (the whole certificate, compared byte for byte — never a public CA, never a name):
 *       · a new till pins it when it joins: it fetches the certificate first and does the join itself over TLS;
 *         both screens show the same SECURITY CODE (from the certificate) for a person to compare;
 *       · a till already joined pins it by itself the first time it finds its server answering TLS (ensureNodeTls) —
 *         trust on first use, after which a different certificate is refused.
 *   - `node_url` stays `http://ip:port` as saved; the transport (lanFetch) sends a request for that address over TLS
 *     whenever a pin is held. Once pinned, a till NEVER falls back to plain HTTP: a server answering with another
 *     certificate is "the branch server's identity changed" on the Tech page, and only a person trusts it again.
 *   - Update downloads (electron-updater, Chromium's network stack) trust the pinned certificate through the
 *     'electron-updater' session's certificate check (trustPinnedNodeIn).
 */
import crypto from 'crypto';
import https from 'https';
import { getLocalDb } from './localDb';
import { getDeviceConfig, isNodeRole } from './deviceConfig';
import { logLine } from './logFile';

// ── A tiny DER writer — only what one self-signed certificate needs ─────────────────────────────────────────────────
const derLen = (n: number): Buffer => {
  if (n < 128) return Buffer.from([n]);
  const b: number[] = [];
  while (n > 0) { b.unshift(n & 0xff); n >>= 8; }
  return Buffer.from([0x80 | b.length, ...b]);
};
const tlv = (tag: number, body: Buffer) => Buffer.concat([Buffer.from([tag]), derLen(body.length), body]);
const seq = (...p: Buffer[]) => tlv(0x30, Buffer.concat(p));
const set = (...p: Buffer[]) => tlv(0x31, Buffer.concat(p));
const int = (b: Buffer) => tlv(0x02, b[0] & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b);
const oid = (s: string) => {
  const p = s.split('.').map(Number);
  const out = [40 * p[0] + p[1]];
  for (const v of p.slice(2)) {
    const b = [v & 0x7f]; let x = v >> 7;
    while (x > 0) { b.unshift(0x80 | (x & 0x7f)); x >>= 7; }
    out.push(...b);
  }
  return tlv(0x06, Buffer.from(out));
};
const utf8 = (s: string) => tlv(0x0c, Buffer.from(s, 'utf8'));
/** UTCTime — valid to 2049, and the certificate ends long before then. */
const utcTime = (d: Date) => tlv(0x17, Buffer.from(d.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z'));
const bitString = (b: Buffer) => tlv(0x03, Buffer.concat([Buffer.from([0]), b]));
const explicit = (n: number, b: Buffer) => tlv(0xa0 + n, b);
const octets = (b: Buffer) => tlv(0x04, b);
const TRUE = tlv(0x01, Buffer.from([0xff]));

const ECDSA_SHA256 = '1.2.840.10045.4.3.2';
const COMMON_NAME = '2.5.4.3';
const BASIC_CONSTRAINTS = '2.5.29.19';
export const CERT_YEARS = 20;
export const CERT_NOT_BEFORE = Date.UTC(2020, 0, 1);

const toPem = (der: Buffer) => `-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`;

/** A new key and self-signed certificate for a branch server. Pure apart from the randomness. */
export function makeServerIdentity(commonName = 'ZapTill branch server', now = Date.now()): { cert: string; key: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const alg = seq(oid(ECDSA_SHA256));
  const name = seq(set(seq(oid(COMMON_NAME), utf8(commonName.slice(0, 64)))));
  const serial = crypto.randomBytes(16); serial[0] &= 0x7f;
  const tbs = seq(
    explicit(0, int(Buffer.from([2]))),                                     // v3
    int(serial),
    alg,
    name,
    // From 2020, not from today: a till whose clock is wrong (a flat CMOS battery) would otherwise refuse the server
    // as "not yet valid". The dates protect nothing here — the till trusts this exact certificate, not a CA's word.
    seq(utcTime(new Date(CERT_NOT_BEFORE)), utcTime(new Date(now + CERT_YEARS * 365 * 86_400_000))),
    name,                                                                   // self-signed: subject = issuer
    publicKey.export({ type: 'spki', format: 'der' }) as Buffer,
    // CA:TRUE (critical): the certificate is its own trust anchor on the tills (it is what they pin).
    explicit(3, seq(seq(oid(BASIC_CONSTRAINTS), TRUE, octets(seq(TRUE))))),
  );
  const signature = crypto.sign('sha256', tbs, privateKey);
  return { cert: toPem(seq(tbs, alg, bitString(signature))), key: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string };
}

/** The certificate's DER bytes, or null when the text is not one certificate. */
export function certDer(pem: string | null | undefined): Buffer | null {
  try { return Buffer.from(new crypto.X509Certificate(String(pem ?? '')).raw); } catch { return null; }
}

/** What a person compares between the server and a till: 12 hex digits of the certificate's SHA-256, in threes. */
export function securityCode(pem: string | null | undefined): string | null {
  const der = certDer(pem);
  if (!der) return null;
  const h = crypto.createHash('sha256').update(der).digest('hex').slice(0, 12).toUpperCase();
  return `${h.slice(0, 4)}-${h.slice(4, 8)}-${h.slice(8, 12)}`;
}

const samePem = (a: string | null | undefined, b: string | null | undefined): boolean => {
  const x = certDer(a), y = certDer(b);
  return !!x && !!y && x.length === y.length && crypto.timingSafeEqual(x, y);
};

// ── Stored state (maintenance_state, a key/value table every till has) ───────────────────────────────────────────────
function readState(key: string): string | null {
  try { return (getLocalDb().prepare(`SELECT value FROM maintenance_state WHERE key = ?`).get(key) as { value?: string } | undefined)?.value ?? null; }
  catch { return null; }
}
function writeState(key: string, value: string | null): void {
  const db = getLocalDb();
  if (value === null) db.prepare(`DELETE FROM maintenance_state WHERE key = ?`).run(key);
  else db.prepare(`INSERT OR REPLACE INTO maintenance_state (key, value, updated_at) VALUES (?, ?, ?)`).run(key, value, new Date().toISOString());
}

/** The branch server's certificate and key — made on first use and kept. Throws only when the database cannot be read. */
export function serverIdentity(): { cert: string; key: string } {
  const cert = readState('node_tls_cert'), key = readState('node_tls_key');
  if (cert && key && certDer(cert)) return { cert, key };
  const made = makeServerIdentity();
  writeState('node_tls_key', made.key);
  writeState('node_tls_cert', made.cert);
  logLine('node', `A489: made this branch server's certificate — security code ${securityCode(made.cert)}`);
  return made;
}
/** The server's security code for its own screens; null when it has no certificate yet. */
export function serverSecurityCode(): string | null { return securityCode(readState('node_tls_cert')); }

/** The certificate this till pins for its branch server, or null (not pinned yet: plain HTTP, as before). */
export function tillPin(): string | null {
  const pem = readState('node_tls_pin');
  return pem && certDer(pem) ? pem : null;
}
/** Pin (or forget) the branch server's certificate. Forgetting clears a recorded identity mismatch too. */
export function setTillPin(pem: string | null): void {
  if (pem !== null && !certDer(pem)) throw new Error('That is not a certificate.');
  writeState('node_tls_pin', pem);
  agents.clear();
  mismatchAt = 0; mismatchError = null;
  if (pem) logLine('node', `A489: the branch server's certificate is pinned — security code ${securityCode(pem)}; its connection is encrypted`);
  else logLine('node', 'A489: the branch server\'s certificate is no longer pinned');
}

// ── The pinned client ───────────────────────────────────────────────────────────────────────────────────────────────
const agents = new Map<string, https.Agent>();
function agentFor(pin: string): https.Agent {
  const k = crypto.createHash('sha256').update(certDer(pin)!).digest('hex');
  let a = agents.get(k);
  if (!a) { a = new https.Agent({ keepAlive: true, maxSockets: 8, ca: pin }); agents.set(k, a); }
  return a;
}

/** Thrown when the server answered with a certificate other than the pinned one. */
export class NodeIdentityError extends Error {
  constructor(detail: string) { super(`fetch failed: the branch server's identity does not match this till's record (${detail})`); this.name = 'NodeIdentityError'; }
}
/** The server presented a certificate that is not the pinned one. */
const CERT_ERRORS = new Set(['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_SIGNATURE_FAILURE']);
/** The pinned certificate itself, refused for its dates — this till's clock is wrong, not the server's identity. */
const DATE_ERRORS = new Set(['CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID']);

/** A request body as bytes (and the type it implies) — strings and buffers as they are, anything else (FormData, a
 *  Blob, URLSearchParams) serialised exactly as fetch would. */
async function bodyBytes(body: unknown, headers: Record<string, string>): Promise<Buffer | undefined> {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  const r = new Request('http://x/', { method: 'POST', body: body as any, duplex: 'half' } as any);
  const type = r.headers.get('content-type');
  if (type && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['content-type'] = type;
  return Buffer.from(await r.arrayBuffer());
}

function plainHeaders(h: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  if (typeof (h as any).forEach === 'function' && !Array.isArray(h)) { (h as any).forEach((v: string, k: string) => { out[k] = v; }); return out; }
  if (Array.isArray(h)) { for (const [k, v] of h) out[String(k)] = String(v); return out; }
  for (const [k, v] of Object.entries(h as Record<string, unknown>)) if (v !== undefined && v !== null) out[k] = String(v);
  return out;
}

const NO_BODY = new Set([101, 103, 204, 205, 304]);
/** No answer at all for this long cuts the connection (a caller's own signal usually cuts it sooner). */
const IDLE_MS = 5 * 60_000;
/** The most of one answer read from the branch server (its largest is the reference bundle, a few MB). */
export const MAX_ANSWER = 100 * 1024 * 1024;

/**
 * fetch() over TLS to `url` (http:// is sent as https:// on the same host and port), trusting only `pin`.
 * Errors look like fetch's (a TypeError "fetch failed" with the cause), so every caller's existing catch applies;
 * a certificate that is not the pinned one rejects with NodeIdentityError.
 */
export async function pinnedFetch(url: string, init: any = {}, pin: string): Promise<Response> {
  const pinDer = certDer(pin);
  if (!pinDer) throw new TypeError('fetch failed: no certificate to trust');
  const u = new URL(url);
  const headers = plainHeaders(init.headers);
  const method = String(init.method ?? 'GET').toUpperCase();
  const body = method === 'GET' || method === 'HEAD' ? undefined : await bodyBytes(init.body, headers);
  if (body) headers['content-length'] = String(body.length);
  const signal: AbortSignal | undefined = init.signal ?? undefined;
  if (signal?.aborted) throw signal.reason ?? new DOMException('This operation was aborted', 'AbortError');

  return await new Promise<Response>((resolve, reject) => {
    let settled = false;
    const fail = (e: unknown) => { if (!settled) { settled = true; reject(e); } };
    const req = https.request({
      protocol: 'https:', host: u.hostname, port: u.port || 443, method, path: `${u.pathname}${u.search}`, headers,
      agent: agentFor(pin), ca: pin,
      // The chain is checked against the pin (ca); this checks it IS the pin, byte for byte, and skips the host name —
      // a shop's server is reached by its LAN address, which no certificate could name in advance.
      checkServerIdentity: (_host: string, cert: { raw?: Buffer }) => {
        const raw = cert?.raw ? Buffer.from(cert.raw) : null;
        return raw && raw.length === pinDer.length && crypto.timingSafeEqual(raw, pinDer) ? undefined : new NodeIdentityError('a different certificate');
      },
    }, (res) => {
      const h = new Headers();
      for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) h.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
      const status = res.statusCode ?? 502;
      const finish = (bytes: Buffer | null) => {
        if (settled) return;
        settled = true;
        try { resolve(new Response(bytes ? new Uint8Array(bytes) : null, { status: status < 200 || status > 599 ? 502 : status, statusText: res.statusMessage ?? '', headers: h })); }
        catch (e) { reject(e); }
      };
      if (NO_BODY.has(status) || method === 'HEAD') { res.resume(); return finish(null); }
      // The whole answer is read before it is handed over: a caller that only looks at the status (a health check)
      // would otherwise hold the connection out of the pool until garbage collection, and eight of those stall every
      // request to the server. The branch server's answers are JSON; MAX_ANSWER guards against anything else.
      const chunks: Buffer[] = []; let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_ANSWER) { res.destroy(); const err = new TypeError('fetch failed'); (err as any).cause = new Error(`the branch server's answer is over ${MAX_ANSWER} bytes`); fail(err); return; }
        chunks.push(c);
      });
      res.on('end', () => finish(Buffer.concat(chunks)));
      res.on('error', (e) => { const err = new TypeError('fetch failed'); (err as any).cause = e; fail(err); });
    });
    req.setTimeout(IDLE_MS, () => req.destroy(new Error('the branch server stopped answering')));
    const onAbort = () => req.destroy(signal?.reason ?? new DOMException('This operation was aborted', 'AbortError'));
    signal?.addEventListener('abort', onAbort, { once: true });
    req.on('close', () => signal?.removeEventListener('abort', onAbort));
    req.on('error', (e: any) => {
      if (e?.name === 'AbortError' || signal?.aborted) return fail(e);
      if (e instanceof NodeIdentityError || CERT_ERRORS.has(String(e?.code ?? ''))) return fail(e instanceof NodeIdentityError ? e : new NodeIdentityError(String(e.code)));
      if (DATE_ERRORS.has(String(e?.code ?? ''))) {
        const err = new TypeError('fetch failed'); (err as any).cause = new Error(`the branch server's certificate is outside its dates by this till's clock (${e.code}) — check this till's date and time`);
        return fail(err);
      }
      const err = new TypeError('fetch failed'); (err as any).cause = e; fail(err);
    });
    if (body) req.end(body); else req.end();
  });
}

// ── The till's transport ────────────────────────────────────────────────────────────────────────────────────────────
let mismatchAt = 0;
let mismatchError: string | null = null;

/** host:port of the configured branch server for a till that has one; null on a server / office / standalone till. */
function nodeOrigin(): { host: string; port: string } | null {
  const cfg = getDeviceConfig();
  if (!cfg?.node_url || isNodeRole(cfg.device_role)) return null;
  try { const u = new URL(cfg.node_url); return { host: u.hostname, port: u.port || (u.protocol === 'https:' ? '443' : '80') }; }
  catch { return null; }
}
const isNodeUrl = (url: string, o: { host: string; port: string }) => {
  try { const u = new URL(url); return u.hostname === o.host && (u.port || (u.protocol === 'https:' ? '443' : '80')) === o.port; }
  catch { return false; }
};

/**
 * fetch() for anything a till sends. A request for its branch server goes over TLS when the server's certificate is
 * pinned — and then never over plain HTTP; everything else (the cloud, a printer) is the ordinary fetch.
 */
export async function lanFetch(url: string, init: any = {}): Promise<Response> {
  const origin = nodeOrigin();
  const pin = origin && isNodeUrl(url, origin) ? tillPin() : null;
  if (!pin) return globalThis.fetch(url, init);
  try {
    const res = await pinnedFetch(url, init, pin);
    if (mismatchAt) { mismatchAt = 0; mismatchError = null; }
    return res;
  } catch (e: any) {
    if (e instanceof NodeIdentityError) {
      if (!mismatchAt) logLine('node', `A489: ${e.message} — nothing is sent to it; if the branch server was reinstalled, trust it again from the Tech page`);
      mismatchAt = mismatchAt || Date.now(); mismatchError = e.message;
    }
    throw e;
  }
}

/** The same address as https:// when this till pins its branch server (for clients that are not lanFetch). */
export function lanUrl(url: string): string {
  const origin = nodeOrigin();
  if (!origin || !isNodeUrl(url, origin) || !tillPin()) return url;
  return url.replace(/^http:\/\//i, 'https://');
}

/** A Chromium session (electron-updater's) trusts the pinned certificate for the branch server's address — only that
 *  certificate, only that host; everything else is Chromium's own verdict. */
export function trustPinnedNodeIn(session: { setCertificateVerifyProc: (proc: (req: any, cb: (code: number) => void) => void) => void }): void {
  session.setCertificateVerifyProc((req, cb) => {
    try {
      const origin = nodeOrigin();
      const pin = origin && req?.hostname === origin.host ? tillPin() : null;
      if (pin && samePem(req?.certificate?.data, pin)) return cb(0);
    } catch { /* fall through to Chromium's verdict */ }
    cb(-3);
  });
}

export type NodeTlsState = 'none' | 'plain' | 'encrypted' | 'old_server' | 'mismatch';
let lastOutcome: { state: NodeTlsState; at: number } = { state: 'none', at: 0 };

/** What the Tech page shows about this till's connection to its branch server. */
export function nodeTlsStatus(): { state: NodeTlsState; code: string | null; error: string | null } {
  if (!nodeOrigin()) return { state: 'none', code: null, error: null };
  const pin = tillPin();
  if (pin && mismatchAt) return { state: 'mismatch', code: securityCode(pin), error: mismatchError };
  if (pin) return { state: 'encrypted', code: securityCode(pin), error: null };
  return { state: lastOutcome.state === 'old_server' ? 'old_server' : 'plain', code: null, error: null };
}

/** The branch server's certificate as it hands it out (plain HTTP — it is public), or null (an older server / no answer). */
export async function readServerCert(base: string, timeoutMs = 4000): Promise<{ cert: string | null; old: boolean }> {
  try {
    const res = await globalThis.fetch(`${base.replace(/\/+$/, '')}/node/tls`, { signal: AbortSignal.timeout(timeoutMs) });
    if (res.status === 404) return { cert: null, old: true };
    if (!res.ok) return { cert: null, old: false };
    const b = await res.json().catch(() => null) as { cert?: unknown } | null;
    return { cert: typeof b?.cert === 'string' && certDer(b.cert) ? b.cert : null, old: false };
  } catch { return { cert: null, old: false }; }
}

const OLD_SERVER_RETRY_MS = 10 * 60_000;
/**
 * A till already joined (no pin yet) pins its server's certificate the first time the server answers TLS: it reads the
 * certificate, then proves it with an encrypted health check that the server accepts with this till's access code.
 * Trust on first use; from then on only that certificate. Called on the till's 60 s branch timer; cheap once pinned.
 */
export async function ensureNodeTls(headers: () => Record<string, string>, now = Date.now()): Promise<NodeTlsState> {
  const cfg = getDeviceConfig();
  if (!cfg?.node_url || isNodeRole(cfg.device_role)) return 'none';
  if (tillPin()) return mismatchAt ? 'mismatch' : 'encrypted';
  if (lastOutcome.state === 'old_server' && now - lastOutcome.at < OLD_SERVER_RETRY_MS) return 'old_server';
  const base = cfg.node_url.replace(/\/+$/, '');
  const got = await readServerCert(base);
  if (!got.cert) { lastOutcome = { state: got.old ? 'old_server' : 'plain', at: now }; return lastOutcome.state; }
  try {
    const res = await pinnedFetch(`${base}/node/health`, { headers: headers(), signal: AbortSignal.timeout(5000) }, got.cert);
    if (!res.ok) { await res.body?.cancel().catch(() => {}); lastOutcome = { state: 'plain', at: now }; return 'plain'; }
    await res.body?.cancel().catch(() => {});
  } catch { lastOutcome = { state: 'plain', at: now }; return 'plain'; }
  setTillPin(got.cert);
  lastOutcome = { state: 'encrypted', at: now };
  return 'encrypted';
}

/** Tests only. */
export function _resetLanTls(): void { agents.clear(); mismatchAt = 0; mismatchError = null; lastOutcome = { state: 'none', at: 0 }; }
