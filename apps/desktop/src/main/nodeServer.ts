// nodeServer.ts — branch aggregation node (main process)
// ─────────────────────────────────────────────────────────────────────────────
// Runs ONLY on the device whose role is 'node' (the branch server). Other tills
// on the LAN push their completed orders here so this machine holds the whole
// branch's data and the manager can see combined totals.
//
// ── WHAT THIS NODE IS AND IS NOT (corrected 2026-08-09, register A18) ────────
// This header used to state that the node was "the SOLE uplink to the cloud",
// that "peer tills never push to the cloud directly", and that received peer
// orders were "re-enqueued into this node's sync_queue so the existing cloud
// push forwards them". NONE of that is true any more, and it had not been for
// some time — see syncEngine.ts:1138-1151, which records the change and its
// reason, and nodeIngest.ts:414-418.
//
// What is true now:
//
//   * A till pushes its own orders to TWO INDEPENDENT destinations — the cloud
//     via `sync_queue`, and the node via `node_queue`. One status column cannot
//     hold two destinations' opinions; the attempt to make it do so is what let
//     a peer close its shift against a server that did not have the sales.
//   * The node is a REPLICA first. Since A19 it ALSO forwards a peer's sale to the cloud: an order applied from a
//     till it knows (F7) is put in this node's own sync_queue with the peer's original payload
//     (nodeIngest.enqueuePeerRelay), and pushed under the peer's id as the idempotency key. The till still queues
//     the same sale for the cloud itself — two paths, one cloud row.
//   * Duplicates are prevented by stable client-generated UUIDs and
//     upsert-by-id / X-Idempotency-Key, NOT by there being a single path.
//
// CONSEQUENCE, and it is open as register A19: a peer till with no internet
// reaches the node over LAN, so branch totals here are right — but its own
// `sync_queue` never drains and nothing else drains it, so the CLOUD never sees
// those sales. Read A17/A19 before designing anything that assumes a peer can
// stay offline indefinitely; today it cannot, because auth is cloud-only too.
// (A548, 2026-10-21: the paragraph above predates A410 — read the A410 section below, which is how it works now:
// a peer's cloud leg runs through this server, so a peer without internet of its own still reaches the cloud.)
//
// A node is also a normal till; its own sales use the usual local path. Received
// peer orders are upserted into the same local tables so reports aggregate.
//
// ── A410 (2026-10-05): THE NODE IS NOW THE BRANCH'S ONLY LINK TO THE CLOUD ──────
// Owner: "the server should be the only till communicating with the cloud not other tills". Every cloud request a
// peer makes (sales, menu, sign-in renewals, manager edits, update downloads) now comes HERE, to /node/cloud/api/…,
// and this server forwards it (nodeGateway.ts; the peer side is cloudGateway.ts). What is said above still holds for
// the two outboxes — a peer offers its rows to this node's replica AND queues them for the cloud — but the cloud leg
// now also travels through this machine. Peers no longer need internet of their own.
//
// Transport: Node's built-in http (no extra dependency). LAN-local; scoped by
// branch_id so a stray device from another branch can't inject orders.
//
// A489 (2026-10-14): and TLS on the same port. Each connection's first byte says which it is (0x16 opens a TLS
// handshake); the same request handler serves both. This server's certificate is its own (lanTls.ts) and its tills pin
// it; plain HTTP stays open for tills on an older build, each logged so the branch can see who still needs updating.

import http from 'http';
import https from 'https';
import net from 'net';
import { serverIdentity, securityCode, requireTlsForTills, noteTillTransport } from './lanTls';
import { isNodeRole } from './deviceConfig';
import crypto from 'crypto';
import { getLocalDb, applyPulledBranding } from './localDb';
import { getDeviceConfig, ensureNodeSecret } from './deviceConfig';
import { codesFromBranchDb, normaliseCode, CODE_RE } from './terminalCodes';   // A519
import { getSalesSummary, getTopProducts, getRecentOrders, getStockLevels } from './managerReports';
import { applyPeerRows, isReplicatedTable, listPeers, collectDistribution, applyPendingEvents, retryRefusedAfterEvents,
  checkDeviceKey, isKnownTill, issueDeviceKey, joinVerdict, prepareDeviceEnrolment, type DeviceKeyVerdict } from './nodeIngest';
import { verifyPinAtNodeAsync, readBranchStaffForServe, vetRelayedStaffChanges } from './branchStaff';
import { logLine } from './logFile';
import { collectInstructions, recordAck, recordPeerState } from './branchClose';
import { buildReferenceBundle } from './referenceBundle';
import { buildRosterSnapshot } from './rosterSnapshot';
import { forwardToCloud } from './nodeGateway';
import { refreshStaffRosterNow } from './staffRoster';   // A446
import { acceptRelayedChanges, acceptForwardOnly, changeVersion, bumpChangeVersion } from './localChanges';   // A448 (+ A381)
import { tillSecrets as nodeSecrets } from './changeQueue';   // A448
import { serveSharedUpdate, shareDir, shareWanted, offeredVersion, noteTillVersion, readyAnswer, shareProgress } from './updateShare';   // A443
import { GATEWAY_PREFIX, cloudFetch } from './cloudGateway';   // A529: cloudFetch for the renewal it brokers
import { startBeacon, stopBeacon } from './serverBeacon';   // A427
import { createJoinRequest, readJoin, JOIN_PROOF_HEADER } from './serverJoin';   // A427, A503
import { NODE_PROTOCOL, NODE_CAPABILITIES, MIN_TILL_PROTOCOL } from './nodeHealth';   // A501
import { noteGatewayCall, noteTillSync } from './activityTracker';   // A508
import { liveMode, liveActive, serveLiveLog } from './liveSync';   // A531
import { answerDrawers } from './branchDrawers';   // A535

const NODE_PORT = Number(process.env.SWIFTPOS_NODE_PORT ?? 4100);

// Tried in order when the one before is already in use. Kept short and
// contiguous deliberately: a human has to be able to read the number off one
// screen and type it into another, and a wide random range makes that worse.
const PORT_FALLBACKS = [NODE_PORT, NODE_PORT + 1, NODE_PORT + 2, NODE_PORT + 3];
let portAttempt = 0;
let boundPort: number | null = null;

let server: net.Server | null = null;
/** A501: the connections the listening socket accepted (closed with the server). */
const openSockets = new Set<net.Socket>();
/** A489: the two protocol handlers the listening socket hands each connection to. */
let plainServer: http.Server | null = null;
let tlsServer: https.Server | null = null;
/** A489: this server's certificate (what GET /node/tls hands out), or null when it could not be made — plain only. */
let tlsCert: string | null = null;

// A427: told when this machine starts or stops serving the branch — index.ts keeps a server awake and in the tray.
// A hook rather than an import so this module still loads without Electron's window and tray (the gateway test).
let servingHook: ((serving: boolean) => void) | null = null;
export function onServingChange(cb: (serving: boolean) => void): void { servingHook = cb; }
const announce = (serving: boolean) => { try { servingHook?.(serving); } catch (e) { console.error('[node] serving hook:', e); } };

function lanAddress(req: http.IncomingMessage): string {
  return String(req.socket?.remoteAddress ?? '').replace(/^::ffff:/, '');
}

/** A489: did this request come over TLS? */
const encrypted = (req: http.IncomingMessage): boolean => !!(req.socket as any)?.encrypted;

/** A489: a till still talking plain HTTP — logged once per 30 minutes per till (or address), never refused. */
const warnedPlain = new Map<string, number>();
function notePlainTill(req: http.IncomingMessage): void {
  const addr = lanAddress(req);
  if (encrypted(req) || addr === '127.0.0.1' || addr === '::1') return;   // this machine's own calls stay on loopback
  const k = headerDevice(req) ?? addr;
  const now = Date.now();
  if ((warnedPlain.get(k) ?? 0) > now - 30 * 60_000) return;
  warnedPlain.set(k, now);
  if (warnedPlain.size > 200) for (const [key, t] of warnedPlain) if (t < now - 30 * 60_000) warnedPlain.delete(key);
  logLine('node', `A489: ${k} (${addr}) talks to this server unencrypted — it switches to an encrypted connection by itself once it runs 1.0.15 or later`);
}

/** What the beacon says: the port that bound, and names a person recognises. Nothing secret. */
function beaconInfo() {
  if (!boundPort) return null;
  const c = getDeviceConfig();
  let business: string | null = null;
  try { business = (getLocalDb().prepare(`SELECT business_name FROM session WHERE id=1`).get() as any)?.business_name ?? null; } catch { /* not joined yet */ }
  // A501: and WHICH server — its certificate's security code (public: the certificate is handed to anyone on /node/tls).
  // A till whose server moved to a new address (DHCP, the port fallback) finds it by this, and proves it over TLS
  // against the certificate it pinned before it follows (nodeFollow.ts).
  return { port: boundPort, business, server: c?.device_name || (c?.terminal_code ? `Server ${c.terminal_code}` : null),
    fp: tlsCert ? securityCode(tlsCert) : null };
}

/** The most this server reads of one request. */
export const NODE_BODY_LIMIT = 5_000_000;

/** F14: a body over the limit — answered 413 by name, so the till sends smaller instead of the same batch forever. */
class BodyTooLarge extends Error { constructor() { super(`request body over ${NODE_BODY_LIMIT} bytes`); } }

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = '';
    let over = false;
    req.on('data', (c) => {
      if (over) return;                       // the rest is drained and dropped, never held
      data += c;
      if (data.length > NODE_BODY_LIMIT) { over = true; data = ''; reject(new BodyTooLarge()); req.resume(); }
    });
    req.on('end', () => { if (over) return; try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

// ── F7: which till is asking ──────────────────────────────────────────────────
// The branch code proves "a till of this branch"; the device key (nodeIngest.checkDeviceKey) proves WHICH. A request
// naming a device that holds a key here must present it. One that names a device and presents no key is an older till.
function presentedKey(req: http.IncomingMessage): string | null {
  const raw = req.headers['x-device-token'];
  const v = Array.isArray(raw) ? raw[0] : raw;
  return typeof v === 'string' && v ? v : null;
}
function headerDevice(req: http.IncomingMessage): string | null {
  const raw = req.headers['x-device-id'];
  const v = Array.isArray(raw) ? raw[0] : raw;
  return typeof v === 'string' && v ? v : null;
}
/** The device a request speaks for, and whether it proved it. A header and body that disagree prove nothing. */
function whoIsAsking(req: http.IncomingMessage, bodyDevice?: unknown): { device: string | null; verdict: DeviceKeyVerdict | 'conflict' } {
  const fromHeader = headerDevice(req);
  const fromBody = bodyDevice ? String(bodyDevice) : null;
  if (fromHeader && fromBody && fromHeader !== fromBody) return { device: fromBody, verdict: 'conflict' };
  const device = fromBody ?? fromHeader;
  return { device, verdict: checkDeviceKey(device, presentedKey(req)) };
}
const proven = (v: DeviceKeyVerdict | 'conflict') => v === 'ok' || v === 'enrolled';
// A521 (#3): it told the person to forget the till and let it reconnect — a forgotten till could never reconnect on its own (its key
// and its right to record one went with it). Re-joining is two steps, said in order.
const KEY_REFUSED = 'This till\'s device key does not match the branch server\'s record. To re-join: on the branch server, Close Branch → Show tills → Revoke this till; then on this till, Find my server (Setup) and allow it at the server.';
/** A496: a device this server never knew, presenting a key of its own making — it must join (Find my server). */
const NOT_JOINED = 'This till has not joined this branch server — join it from the till\'s setup (Find my server), and allow it at the server.';
/** A496: a verdict that refuses the request outright, on any route. */
const refusedVerdict = (v: DeviceKeyVerdict | 'conflict') => v === 'conflict' || v === 'mismatch' || v === 'missing' || v === 'unknown';
const refusalText = (v: DeviceKeyVerdict | 'conflict') =>
  v === 'conflict' ? 'the request names two different tills'
  : v === 'unknown' ? NOT_JOINED
  : v === 'absent' ? 'Update this till — the branch server answers this only to tills with a device key.'
  : KEY_REFUSED;

/**
 * A496: the routes that hand out the branch's data (its staff list, sales, other tills' rows, catalogue, the tech
 * session) or change it — only for a till that proves which it is. Answers the refusal itself and returns null; an older
 * till (no key) is logged.
 */
function requireProven(req: http.IncomingMessage, res: http.ServerResponse, route: string, bodyDevice?: unknown):
  { device: string } | null {
  const who = whoIsAsking(req, bodyDevice);
  if (proven(who.verdict) && who.device) return { device: who.device };
  if (who.verdict === 'absent') warnOlderTill(who.device, route);
  else logLine('node', `${route} refused for ${who.device ?? '?'} (${who.verdict}) from ${lanAddress(req)}`);
  json(res, 401, { error: refusalText(who.verdict) });
  return null;
}

/**
 * A496: a tech token is stored for the branch only when it IS one — signed by the tech key this server holds, unexpired,
 * for this branch (the same check techService.openTechSession makes, without opening a session here).
 */
export function isRealTechToken(token: unknown, branchId: string | null | undefined, now = Date.now()): boolean {
  if (typeof token !== 'string' || token.length > 512_000) return false;
  try {
    const pub = (getLocalDb().prepare(`SELECT public_key FROM tech_state WHERE id = 1`).get() as { public_key?: string } | undefined)?.public_key;
    if (!pub) return false;
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== 'st2') return false;
    if (!crypto.verify(null, Buffer.from(parts[1]), pub, Buffer.from(parts[2], 'base64url'))) return false;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString()) as { exp?: number; branchId?: string };
    if (!Number.isFinite(payload?.exp) || Math.floor(now / 1000) > Number(payload.exp)) return false;
    return !branchId || payload.branchId === branchId;
  } catch { return false; }
}

const warnedOld = new Map<string, number>();
function warnOlderTill(device: string | null, route: string): void {
  const k = `${device ?? '?'}|${route}`;
  const now = Date.now();
  if ((warnedOld.get(k) ?? 0) > now - 10 * 60_000) return;   // once per 10 minutes per till and route
  warnedOld.set(k, now);
  logLine('node', `F7: ${route} from ${device ?? 'a till that names no device'} with no device key — an older till; accepted for now. Update it.`);
}

// ── F16: PIN attempts per till (or address) ───────────────────────────────────
export const PIN_ATTEMPTS_PER_MINUTE = 10;
const pinAttempts = new Map<string, number[]>();
/** True when this caller may try another PIN now. Exported for the test. */
export function pinAttemptAllowed(key: string, now: number = Date.now()): boolean {
  const recent = (pinAttempts.get(key) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= PIN_ATTEMPTS_PER_MINUTE) { pinAttempts.set(key, recent); return false; }
  recent.push(now);
  pinAttempts.set(key, recent);
  if (pinAttempts.size > 500) for (const [k, v] of pinAttempts) if (!v.some((t) => now - t < 60_000)) pinAttempts.delete(k);
  return true;
}
/** Tests only. */
export function _resetPinAttempts(): void { pinAttempts.clear(); }

// ── LAN authentication ───────────────────────────────────────────────────────
// Every /node/* request must present the branch secret in X-Node-Secret.
//
// This server binds to all interfaces on port 4100. Before this check existed,
// anyone on the same network — which in a shop means the customer wifi — could
// POST a fabricated order (ingested locally AND forwarded to Supabase as a real
// sale), GET the branch's full sales report, and read or overwrite the live
// tech token. The branch_id comparison in the orders handler is not a substitute:
// it compares against a value the caller supplies.
//
// Fails closed. No secret configured means no requests served, rather than
// falling back to the previous open behaviour.
function authorised(req: http.IncomingMessage): boolean {
  const expected = getDeviceConfig()?.node_secret;
  if (!expected) return false;

  const raw = req.headers['x-node-secret'];
  const presented = Array.isArray(raw) ? raw[0] : raw;
  if (!presented) return false;

  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  // timingSafeEqual throws on a length mismatch, so compare lengths first. That
  // leaks only the length of a secret whose length is fixed and public anyway.
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function json(res: http.ServerResponse, status: number, body: any, extra: Record<string, string> = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...extra });
  res.end(payload);
}

// Order ingest now goes through /node/sync like every other replicated table,
// so the bespoke ingestOrder path that used to live here is gone. It carried its
// own column list, its own dedupe and its own attribution rules, all of which
// had to agree with the ones in nodeIngest and had no way of proving they did.
//
// The bill-number conflict it handled (a reinstalled till restarting its counter
// and re-minting numbers this node already holds) surfaces through the ordinary
// rejection path now — applyPeerRows reports the insert error against the row,
// the peer escalates it to 'failed' after five attempts, and the reason reaches
// a person instead of a count that never clears.

export function startNodeServer(): void {
  if (server) return;                              // already running
  const cfg = getDeviceConfig();
  if (!isNodeRole(cfg?.device_role)) return;        // node OR office — both serve the branch

  // Mint on first start if absent — covers installs upgraded from a build that
  // predates the node_secret column, which would otherwise come up unauthenticated.
  // Logged so the code is recoverable from the node's own machine if the install
  // slip is lost; see also the SQLite query in the deploy notes.
  const secret = ensureNodeSecret();
  console.log(`[node] branch access code: ${secret}`);
  // A496: write down the tills known before device keys, before anything can ask to record a key.
  try { prepareDeviceEnrolment(); } catch (e: any) { logLine('node', `could not note the known tills: ${e?.message ?? e}`); }

  const handler = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    try {
      const url = (req.url ?? '').split('?')[0];

      // A489: this server's certificate — public by nature (a till pins it, then trusts nothing else), so open like
      // the join routes. Served over either protocol.
      if (req.method === 'GET' && url === '/node/tls') {
        if (!tlsCert) return json(res, 404, { error: 'this branch server has no certificate' });
        return json(res, 200, { cert: tlsCert, code: securityCode(tlsCert) });
      }

      // A427: the only two routes open WITHOUT the access code — a till being installed has none yet. A request only
      // queues a question for the person at this server (serverJoin.ts); nothing is handed out until they allow it,
      // and then only to the holder of that request's private token.
      if (req.method === 'POST' && url === '/node/join') {
        // A496: a device that already holds a key here is not joined again until the person at the server forgets it —
        // A503: unless its key was never used (the till never got its grant) or it proves it holds that key
        // (X-Join-Proof, bound to this server's certificate). See serverJoin.ts.
        const proofRaw = req.headers[JOIN_PROOF_HEADER];
        const proof = Array.isArray(proofRaw) ? proofRaw[0] : proofRaw;
        const code = tlsCert ? securityCode(tlsCert) : null;
        const r = createJoinRequest(await readBody(req).catch(() => ({})), lanAddress(req), Date.now(), {
          holdsKey: (id) => {
            const v = joinVerdict(id, proof ?? null, code);
            if (v === 'unused' || v === 'proven') logLine('node', `A503: ${id.slice(0, 8)} asks to join again (${v === 'unused' ? 'its key from the last join was never used' : 'it proved the key it holds here'}) — the person at the server is asked`);
            return v === 'held';
          },
        });
        return r.ok ? json(res, 202, { id: r.id, token: r.token }) : json(res, r.status, { error: r.error });
      }
      if (req.method === 'GET' && url === '/node/join/status') {
        const q = new URL(req.url ?? '', 'http://x').searchParams;
        const r = readJoin(q.get('id') ?? '', q.get('token') ?? '');
        // F7: a till allowed to join gets its own device key with the grant (the server keeps only its hash).
        if (r.status === 'approved' && r.grant && r.device_id) {
          let device_token: string | undefined;
          try { device_token = issueDeviceKey(r.device_id); } catch (e: any) { logLine('node', `could not issue a device key: ${e?.message ?? e}`); }
          // A519: the terminal codes this branch's tills use (this server's own too; the joining device's left out), so
          // the till being set up is not given one of them (terminalCodes.ts).
          let terminal_codes: string[] | undefined;
          try {
            const own = normaliseCode(getDeviceConfig()?.terminal_code);
            terminal_codes = [...new Set([...codesFromBranchDb(getLocalDb(), r.device_id), ...(CODE_RE.test(own) ? [own] : [])])].sort();
          } catch { terminal_codes = undefined; }
          return json(res, 200, { status: r.status, grant: { ...r.grant, ...(device_token ? { device_token } : {}), ...(terminal_codes ? { terminal_codes } : {}) } });
        }
        return json(res, 200, { status: r.status, ...(r.grant ? { grant: r.grant } : {}) });
      }

      // Applied before routing, so it covers health, orders, report and the
      // tech-session pair without any route being able to opt out by omission.
      if (!authorised(req)) {
        return json(res, 401, { error: 'unauthorised — bad or missing X-Node-Secret' });
      }
      notePlainTill(req);
      // A496: once the person at the server turns it on (every till encrypted — see lanTls.tillTransports), an
      // authenticated request over plain HTTP from another machine is refused. Off by default.
      {
        const addr = lanAddress(req);
        const loopback = addr === '127.0.0.1' || addr === '::1';
        if (!loopback) noteTillTransport(headerDevice(req) ?? addr, encrypted(req));
        if (!loopback && !encrypted(req) && requireTlsForTills()) {
          return json(res, 426, { error: 'This branch server accepts only encrypted connections — update this till (1.0.15 or later), or trust the server again from its Tech page.' }, { Upgrade: 'TLS/1.2' });
        }
      }

      // A410: the branch's tills reach the cloud ONLY through this server. Raw pass-through of the till's own request
      // (its token, device and idempotency headers) to the cloud, and the answer straight back. See nodeGateway.ts.
      if (url.startsWith(`${GATEWAY_PREFIX}/`)) {
        // A443: a till's update files come from this server's own copy (fetched once for the branch), not live.
        if (serveSharedUpdate(req, res, shareDir(), shareWanted)) return;
        // A508: a till trading through the server keeps the server from installing. A541: trading only (an allowlist —
        // activityTracker.classifyGatewayCall); the body size tells an empty sync push from one carrying rows.
        { const n = Number(req.headers['content-length']); noteGatewayCall(req.method, url, Date.now(), Number.isFinite(n) ? n : null); }
        const serverUrl = getDeviceConfig()?.server_url ?? '';
        return await forwardToCloud(req, res, serverUrl);
      }

      // A443: a till asks "I run X — is there a newer version?" (every 2 minutes, at start, back online). The server
      // remembers what each till runs (its screen lists them) and answers with the version it holds ready to share; a
      // till told of a newer one checks with the cloud at once and downloads it from here.
      if (req.method === 'GET' && url === '/node/update/ready') {
        const q = new URL(req.url ?? '', 'http://x').searchParams;
        const v = String(q.get('v') ?? '');
        const want = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(String(q.get('want') ?? '')) ? String(q.get('want')) : null;
        noteTillVersion(String(q.get('device') ?? ''), q.get('name'), v);
        // A496: only the version the cloud approved (a copy left from before a roll-back or a hold is never offered), and
        // a till that names the version it was approved for gets the server to fetch it now if it holds another.
        const ready = offeredVersion(shareDir());
        if (!ready || (want && want !== ready)) shareWanted(want ?? v);   // the server checks what is approved (at most every 5 min)
        return json(res, 200, { ...readyAnswer(ready, v), share: shareProgress(want ?? ready) });
      }

      // Health — tills probe this to decide reachability.
      if (req.method === 'GET' && url === '/node/health') {
        const c = getDeviceConfig();
        // A501: and what this server speaks — a till older than it expects, or newer than it, says so on its Tech page.
        return json(res, 200, { ok: true, branch_id: c?.branch_id ?? null, device_id: c?.device_id ?? null, role: 'node',
          protocol: NODE_PROTOCOL, min_till_protocol: MIN_TILL_PROTOCOL, capabilities: NODE_CAPABILITIES });
      }

      // Receive a peer till's cash records: shifts, floats, expenses, trading
      // days — and orders, once the till stops routing them through the cloud
      // branch below.
      //
      // This is the endpoint that makes a branch cash reconciliation possible.
      // Until now only orders crossed the LAN, so a manager could see the
      // branch's sales and none of the drawers behind them.
      //
      // Every row keeps the PEER's device_id and the PEER's seq. Stamping this
      // node's own would make peer drawers indistinguishable from its own in
      // getOpenShift, which the sell gate reads. applyPeerRows refuses rather
      // than guesses; see nodeIngest.ts.
      // PHASE5 §4c (A17): authenticate a peer's cashier against this node's
      // roster when the cloud is unreachable. Guarded by the same X-Node-Secret
      // + branch scope as every /node/* route (checked centrally above). Scans
      // all candidates and refuses on two, exactly as the server does. No JWT is
      // minted — the peer gets the identity + permissions and pushes orders under
      // its own till token with this cashier_id, unchanged from the online path.
      if (req.method === 'POST' && url === '/node/verify-pin') {
        const body = await readBody(req);
        const c = getDeviceConfig();
        const branchId = String(body?.branch_id ?? c?.branch_id ?? '');
        const pin = String(body?.pin ?? '');
        if (c?.branch_id && body?.branch_id && body.branch_id !== c.branch_id) {
          return json(res, 403, { error: 'branch mismatch' });
        }
        if (!pin || !branchId) return json(res, 400, { error: 'pin and branch_id are required' });
        // F7: only a till that proves which it is. 503 — not 401 — for one that cannot: the till then treats this
        // server as unreachable and checks the PIN against its own copy / the cloud, instead of a final "no".
        const who = whoIsAsking(req);
        if (!proven(who.verdict)) {
          if (who.verdict === 'absent') warnOlderTill(who.device, '/node/verify-pin');
          return json(res, 503, { ok: false, reason: 'unavailable',
            error: who.verdict === 'absent' ? 'Update this till — the branch server checks PINs only for tills with a device key.' : refusalText(who.verdict) });
        }
        // F16: at most 10 PINs a minute from one till — A496: and from one ADDRESS, whatever devices it names (a guessing
        // loop that rotates device ids from one machine was not limited at all).
        const byDevice = pinAttemptAllowed(`dev:${who.device ?? lanAddress(req)}`);
        const byAddress = pinAttemptAllowed(`ip:${lanAddress(req)}`);
        if (!byDevice || !byAddress) {
          logLine('node', `verify-pin: too many attempts from ${who.device ?? lanAddress(req)} — refused for a minute`);
          return json(res, 429, { ok: false, reason: 'rate_limited', error: 'Too many PIN attempts — wait a minute and try again.' });
        }

        const verdict = await verifyPinAtNodeAsync(pin, branchId);
        if (verdict.ok) return json(res, 200, { ok: true, staff: verdict.staff });
        // A rejection is FINAL (the peer must not fall back to another authority
        // on a 'no'): 401 for a bad/ambiguous PIN, 503 only when the node cannot
        // read its own roster (a transport-like failure the peer may retry).
        const status = verdict.reason === 'unavailable' ? 503 : 401;
        return json(res, status, { ok: false, reason: verdict.reason, error: verdict.message });
      }

      // A160: broker a token refresh for a peer that can't reach the cloud but can
      // reach this node. Proxy the peer's refresh token upstream and pass the
      // cloud's verdict straight back (200 = new pair, 401 = revoked). If THIS
      // node can't reach the cloud either, 503 so the peer keeps trading offline
      // and retries. Authenticated by X-Node-Secret (checked above). Only the
      // node needs the internet.
      // A477: the renewal's ack goes the same way (/node/refresh/ack → /api/auth/refresh/ack), and both pass the till's
      // own X-Device-* headers on (its id, its machine, a lost device secret) — the cloud checks the PEER's machine, not
      // this server's.
      if (req.method === 'POST' && (url === '/node/refresh' || url === '/node/refresh/ack')) {
        const body = await readBody(req);
        const token = body?.refreshToken;
        if (!token) return json(res, 400, { error: 'refreshToken is required' });
        const serverUrl = getDeviceConfig()?.server_url;
        if (!serverUrl) return json(res, 503, { error: 'node has no cloud URL configured' });
        const peerHeaders: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) {
          // F7: never the till's key for THIS server (X-Device-Token) — that is not the cloud's.
          if (/^x-device-/i.test(k) && k.toLowerCase() !== 'x-device-token' && typeof v === 'string' && v) peerHeaders[k] = v;
        }
        try {
          // A529: through cloudFetch — this server is the branch's server, so it goes to the cloud directly, and an answer
          // that is not the cloud's (another server's page) throws: 503 below, so the till keeps its sign-in and retries,
          // never reading a portal's 401/404 as the cloud refusing its renewal.
          const up = await cloudFetch(`${serverUrl.replace(/\/+$/, '')}/api/auth/${url === '/node/refresh' ? 'refresh' : 'refresh/ack'}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...peerHeaders },
            body: JSON.stringify({ refreshToken: token }),
            signal: AbortSignal.timeout(10_000),   // A446: the till waits 12 s for this; never hang it
          });
          const data = await up.json().catch(() => ({}));
          return json(res, up.status, data);
        } catch {
          return json(res, 503, { error: 'node cannot reach the cloud right now' });
        }
      }

      if (req.method === 'POST' && url === '/node/sync') {
        const body = await readBody(req);
        const c = getDeviceConfig();
        const peerDeviceId = String(body?.device_id ?? '');

        if (c?.branch_id && body.branch_id && body.branch_id !== c.branch_id) {
          return json(res, 403, { error: 'branch mismatch' });
        }
        // F7: the device the rows claim must be the device asking. Older tills (no key at all) keep working here —
        // only here — with a warning in the log; see nodeIngest's device keys.
        const who = whoIsAsking(req, peerDeviceId || null);
        if (refusedVerdict(who.verdict)) {
          logLine('node', `/node/sync refused for ${peerDeviceId || '?'} (${who.verdict}) from ${lanAddress(req)}`);
          return json(res, 401, { error: refusalText(who.verdict) });
        }
        if (who.verdict === 'absent') warnOlderTill(peerDeviceId || null, '/node/sync');
        // A19 relay to the cloud only for a till this server knows (joined: a device key here, or it reports to the
        // Close Branch poll) — never for a device id first seen in this very request. A496: "knows" = a join, a key from
        // a device known before device keys, or such a device itself (isKnownTill) — no longer one a poll made known.
        const relay = proven(who.verdict) || isKnownTill(peerDeviceId);
        noteTillSync(body?.tables);   // A508: a till pushing its sales — the branch is in use

        const results: Record<string, any> = {};
        for (const [table, rows] of Object.entries(body?.tables ?? {})) {
          if (!isReplicatedTable(table)) {
            // Named rather than ignored. A peer on a newer build sending a table
            // this node does not replicate must find out, or it will mark those
            // rows delivered and never offer them again.
            results[table] = { applied: 0, duplicate: 0, cursor: 0,
                               rejected: [{ id: '*', table, reason: 'this branch server does not replicate that table' }] };
            continue;
          }
          if (!Array.isArray(rows)) continue;
          results[table] = applyPeerRows(table, peerDeviceId, rows, { relay });
          // F7: who relayed what, on record.
          if (results[table].relayed) logLine('node', `relayed ${results[table].relayed} sale(s) to the cloud for till ${peerDeviceId.slice(0, 8)}`);
        }
        // Phase 2b: newly-ingested events mutate their replicas now, and any
        // event that arrived BEFORE its target row gets another chance —
        // repetition after every ingest is the whole answer to cross-table
        // ordering. Idempotent, so a round with nothing to do costs one SELECT.
        applyPendingEvents();
        // A501: and the other way round — a row refused only because the event it needed came later in the same batch (a
        // till's new trading day ahead of the event closing its last one) is tried once more now, and the answer says so.
        for (const [table, rows] of Object.entries(body?.tables ?? {})) {
          if (!isReplicatedTable(table) || !Array.isArray(rows) || !results[table]?.rejected?.length) continue;
          const before = results[table].rejected.length;
          results[table] = retryRefusedAfterEvents(table, peerDeviceId, rows, results[table], { relay });
          const now = results[table].rejected.length;
          if (now < before) { logLine('node', `A501: ${before - now} ${table} row(s) from ${peerDeviceId.slice(0, 8)} taken after the event sweep (they came ahead of the event they needed)`); applyPendingEvents(); }
        }
        return json(res, 200, { ok: true, results });
      }

      // What this node already holds from a given device, per table. A peer that
      // was reinstalled, or one whose outbox cursor was lost, can resume from
      // here instead of re-offering its whole history.
      if (req.method === 'GET' && url === '/node/cursors') {
        const device = new URL(req.url ?? '', 'http://node').searchParams.get('device');
        // A496: only for a proven till, and only its own (an older till: none — it re-offers, which is idempotent).
        const me = requireProven(req, res, '/node/cursors', device || null);
        if (!me) return;
        const all = listPeers();
        return json(res, 200, {
          cursors: device ? all.filter(p => p.device_id === device) : all,
        });
      }

      // Central day close (Phase 4) — a peer collects its pending instructions
      // and reports its own day state in the same request. PULL, never push:
      // the node cannot reach a peer, so this poll is the only channel, and the
      // piggybacked state is what the manager screen shows instead of the
      // node's replicated copies (which go stale after a close).
      if (req.method === 'POST' && url === '/node/instructions/poll') {
        const body = await readBody(req);
        const deviceId = String(body?.device_id ?? '');
        if (!deviceId) return json(res, 400, { error: 'device_id is required' });
        const c = getDeviceConfig();
        if (c?.branch_id && body.branch_id && body.branch_id !== c.branch_id) {
          return json(res, 403, { error: 'branch mismatch' });
        }
        // F7: a till's instructions (and the state the Close Branch screen trusts) only to that till.
        const who = whoIsAsking(req, deviceId);
        if (refusedVerdict(who.verdict)) {
          return json(res, 401, { error: refusalText(who.verdict) });
        }
        // A496: a device this server does not know is not recorded (that made it "known", and so relayed for, A19).
        if (body.state && (proven(who.verdict) || isKnownTill(deviceId))) recordPeerState(deviceId, body.state);
        else if (body.state) logLine('node', `/node/instructions/poll: ${deviceId.slice(0, 8)} is not a till this server knows — its state is not recorded`);
        return json(res, 200, { instructions: collectInstructions(deviceId) });
      }

      // The peer's verdict. Only an ack retires an instruction — delivery alone
      // never does, so a peer that crashed mid-execution is re-offered it.
      if (req.method === 'POST' && url === '/node/instructions/ack') {
        const body = await readBody(req);
        const id = Number(body?.instruction_id);
        const uid = typeof body?.instruction_uid === 'string' && body.instruction_uid ? body.instruction_uid : null;
        if (!Number.isInteger(id) && !uid) return json(res, 400, { error: 'instruction_id is required' });
        // F12: matched on the uid and the till that answers (an older till sends neither — the number, as before).
        // A496: the till that answers must prove it. An older till (it names no device, or one with no key here) keeps the
        // old path — logged; a device that holds a key must present it.
        const deviceId = typeof body?.device_id === 'string' && body.device_id ? body.device_id : null;
        const who = whoIsAsking(req, deviceId);
        if (refusedVerdict(who.verdict)) return json(res, 401, { error: refusalText(who.verdict) });
        if (!proven(who.verdict)) warnOlderTill(who.device, '/node/instructions/ack');
        recordAck(Number.isInteger(id) ? id : null, {
          ok: body?.ok === true,
          error: body?.error ?? undefined,
          summary: body?.summary ?? undefined,
          ...(body?.wait === true ? { wait: true } : {}),   // A521: "not yet" — a close that waits for money on the till
        }, { deviceId, uid });
        return json(res, 200, { ok: true });
      }

      // Phase 2a — distribution. A peer pulls every OTHER device's rows so the
      // whole branch lives on every till. Origin device_id and seq are served
      // as held; the requester's own rows are excluded at the source.
      if (req.method === 'POST' && url === '/node/since') {
        const body = await readBody(req);
        const deviceId = String(body?.device_id ?? '');
        if (!deviceId) return json(res, 400, { error: 'device_id is required' });
        const c = getDeviceConfig();
        if (c?.branch_id && body.branch_id && body.branch_id !== c.branch_id) {
          return json(res, 403, { error: 'branch mismatch' });
        }
        if (!requireProven(req, res, '/node/since', deviceId)) return;   // A496: the branch's rows only to a proven till
        const out = collectDistribution(deviceId, body?.cursors ?? {}, Number(body?.limit) || 500);
        return json(res, 200, out);
      }

      // A24 — DOWNSTREAM reference snapshot. A peer pulls the branch's catalogue,
      // prices, variants, modifiers, stock, tables, pumps and print routing from
      // the node instead of the cloud, so an offline peer stays current. Served
      // from THIS node's own local tables (populated by its cloud sync) in the
      // shapes pullCatalogue already consumes — so the peer's write path is
      // unchanged whether the source is cloud or node. Non-credential only: the
      // roster (A20) rides the same channel in a later change, behind the owner's
      // trust-domain decision. Branch-scoped like every /node/* route.
      //
      // No cursors yet — a full snapshot the peer applies wholesale (same as the
      // roster and stations already are). Delta-by-version is a later optimisation
      // (A24 step 2); a full pull is correct, just chattier.
      if (req.method === 'POST' && url === '/node/reference') {
        const body = await readBody(req);
        const c = getDeviceConfig();
        if (c?.branch_id && body.branch_id && body.branch_id !== c.branch_id) {
          return json(res, 403, { error: 'branch mismatch' });
        }
        if (!requireProven(req, res, '/node/reference')) return;   // A496
        return json(res, 200, buildReferenceBundle(getLocalDb(), c));
      }

      // A20: serve this node's staff roster so a peer can authenticate cashiers
      // and open the shop on failover. Branch-gated + X-Node-Secret like every
      // /node/* route. PIN hashes are unwrapped to raw bcrypt for transport (the
      // node's safeStorage wrapping is machine-bound); the peer re-wraps with its
      // own. The owner has accepted that this puts the branch's hashes on every
      // peer (PHASE5 §10.1) with the PIN-rotation runbook as mitigation.
      // A448: a till of this branch hands over a change made on it (a printer station, a category, a product, a cashier, a
      // PIN): applied here too — the branch's other tills see it with no internet — and sent to the cloud from here as well
      // (the cloud recognises a change sent twice by its id).
      if (req.method === 'POST' && url === '/node/changes') {
        // F7: only from a till that proves which it is (an older till's changes still reach the cloud from that till).
        const who = whoIsAsking(req);
        if (!proven(who.verdict)) {
          if (who.verdict === 'absent') warnOlderTill(who.device, '/node/changes');
          return json(res, 401, { error: who.verdict === 'absent' ? 'Update this till to hand changes to the branch server.' : refusalText(who.verdict) });
        }
        const body = await readBody(req);
        // F7: a staff change's role and permissions come from THIS server's roles, never from the change; no relayed
        // change makes anyone more than a cashier (A490: by permission) or changes such a person's PIN (branchStaff.vetRelayedStaffChanges).
        const vetted = vetRelayedStaffChanges(Array.isArray(body?.changes) ? body.changes.slice(0, 50) : [], getDeviceConfig()?.branch_id ?? null);
        for (const r of vetted.refused) logLine('node', `/node/changes from ${who.device}: refused ${r.id} — ${r.reason}`);
        // A496: applied here only — never queued for the cloud under THIS server's session (the till that made the change
        // sends it itself, under its own); see localChanges.acceptRelayedChanges.
        // A521 (#6): and forwarded to the cloud from here as well (pushLocalChanges), named as the maker's (the cloud checks
        // the maker's own proof — A494 — never this server's session) and as relayed for this till; a PIN or a new person
        // is only forwarded, never applied here. The till that made it may be switched off before it reaches the cloud.
        const n = acceptRelayedChanges(getLocalDb(), vetted.accepted, nodeSecrets, who.device);
        const fwd = acceptForwardOnly(getLocalDb(), vetted.forward, nodeSecrets, who.device);
        if (fwd) logLine('node', `/node/changes from ${who.device}: ${fwd} PIN / new-person change(s) kept to forward to the cloud (not applied here)`);
        return json(res, 200, { accepted: n, refused: vetted.refused, version: changeVersion(getLocalDb()) });
      }
      // A381: a till set the business's logo / accent — applied here (the branch's other tills take it with their next pull
      // from this server; the change counter tells a till with no internet to pull now). The till sends it to the cloud.
      if (req.method === 'POST' && url === '/node/branding') {
        if (!requireProven(req, res, '/node/branding')) return;   // A496
        const body = await readBody(req);
        const str = (v: unknown) => (typeof v === 'string' ? v : null);
        if (str(body?.logoPng) && !/^[A-Za-z0-9+/=]+$/.test(String(body.logoPng))) return json(res, 400, { error: 'logoPng must be base64' });
        // A496: the receipt logo and the accent are checked too (they were written as given).
        if (str(body?.logoReceipt) && !/^[A-Za-z0-9+/=]+$/.test(String(body.logoReceipt))) return json(res, 400, { error: 'logoReceipt must be base64' });
        if (str(body?.accentHex) && !/^#[0-9A-Fa-f]{6}$/.test(String(body.accentHex))) return json(res, 400, { error: 'accentHex must be #RRGGBB' });
        applyPulledBranding({ accentHex: str(body?.accentHex), logoPng: str(body?.logoPng), logoReceipt: str(body?.logoReceipt),
          receiptLogoEnabled: body?.receiptLogoEnabled === true });
        return json(res, 200, { ok: true, version: bumpChangeVersion(getLocalDb()) });
      }
      // A531: the cloud's row changes this server has applied, in the order it applied them — its tills take them from
      // here (owner, 2026-10-19: "only the server does the communication to cloud, not all tills"). Same shape as the
      // cloud's GET /api/pos/changes; a staff row carries its PIN hash from this server's list, so only to a proven till.
      // 404 while this server itself takes changes the old way (its cloud keeps no change log): its tills do the same.
      if (req.method === 'GET' && url === '/node/live') {
        const me = requireProven(req, res, '/node/live');
        if (!me) return;
        if (liveMode() === 'legacy') return json(res, 404, { error: 'This branch server takes changes the old way.', code: 'CHANGES_UNAVAILABLE' });
        if (!liveActive()) return json(res, 503, { error: 'The branch server is starting - ask again shortly.' });
        const raw = new URL(req.url ?? '', 'http://node').searchParams.get('since');
        const since = raw === null || raw === '' ? null : Number(raw);
        // A535: the asking till (proven) — a ZapTill log request for it rides this answer.
        return json(res, 200, serveLiveLog(since, getDeviceConfig()?.branch_id ?? null, changeVersion(getLocalDb()), me.device));
      }
      // A535: a till's drawer checks — the web's sales on its drawer, whether the web closed or a manager confirmed it, and
      // what its 90 s beat needs — answered from this server's ONE branch-level poll of the cloud (branchDrawers.ts), never
      // forwarded one by one. Only a proven till, only about its OWN drawers. 404 while this server's cloud does not answer
      // the branch-level call (the till asks through the gateway as before); 503 while this server's copy is stale.
      if (req.method === 'POST' && url === '/node/drawers') {
        const me = requireProven(req, res, '/node/drawers');
        if (!me) return;
        const body = await readBody(req);
        const a = answerDrawers(me.device, body ?? {});
        return json(res, a.status, a.body);
      }
      if (req.method === 'GET' && url === '/node/changes/version') {
        return json(res, 200, { version: changeVersion(getLocalDb()) });
      }

      // A446: a till changed staff (created a cashier, set a PIN) — this server pulls the branch's staff list from the
      // cloud now, so its other tills have it on their next ask (and the PIN check here knows the new cashier at once).
      if (req.method === 'POST' && url === '/node/roster/refresh') {
        void refreshStaffRosterNow('a till changed staff');
        return json(res, 202, { ok: true });
      }

      if (req.method === 'POST' && url === '/node/roster') {
        const body = await readBody(req);
        const c = getDeviceConfig();
        if (c?.branch_id && body.branch_id && body.branch_id !== c.branch_id) {
          return json(res, 403, { error: 'branch mismatch' });
        }
        const branchId = String(body?.branch_id ?? c?.branch_id ?? '');
        if (!branchId) return json(res, 400, { error: 'branch_id is required' });
        // A496: the branch's PIN hashes only to a till that proves which it is (the branch code alone was enough).
        if (!requireProven(req, res, '/node/roster')) return;
        return json(res, 200, buildRosterSnapshot(branchId, readBranchStaffForServe(branchId)));
      }

      // Node-served time.
      //
      // Peers compare this against their own clock and warn above two minutes'
      // drift. The failure it heads off is not cosmetic: business_date is taken
      // from each till's own clock, so two tills that disagree by a few minutes
      // either side of midnight put the same evening's takings into two
      // different trading days, and no report will ever reconcile them.
      //
      // Advisory only — the node does not set anyone's clock, and a till whose
      // time is wrong keeps selling. A POS that stops trading because of NTP is
      // worse than one that reports a date its manager can correct.
      if (req.method === 'GET' && url === '/node/time') {
        // F15: and the zone — two tills on the same instant but different time zones date their days differently.
        return json(res, 200, { now: new Date().toISOString(), tz_offset: new Date().getTimezoneOffset() });
      }

      // Combined branch report — any till's manager view reads this.
      if (req.method === 'GET' && url === '/node/report') {
        if (!requireProven(req, res, '/node/report')) return;   // A496: the branch's sales only to a proven till
        return json(res, 200, {
          salesSummary: getSalesSummary(),
          topProducts:  getTopProducts(),
          recentOrders: getRecentOrders(),
          stockLevels:  getStockLevels(),
          source: 'node',
        });
      }

      // Tech session broadcast: hold the latest tech token so peers can pick it
      // up and verify it themselves (self-validating, so no shared clock needed).
      if (req.method === 'POST' && url === '/node/tech-session') {
        if (!requireProven(req, res, '/node/tech-session')) return;   // A496
        const body = await readBody(req);
        // A496: only a real tech token is held for the branch (anything was stored and handed to every till before);
        // null still clears it.
        if (body?.token !== null && body?.token !== undefined && !isRealTechToken(body.token, getDeviceConfig()?.branch_id)) {
          logLine('node', '/node/tech-session: refused a token that is not a valid tech token for this branch');
          return json(res, 400, { error: 'not a valid tech token for this branch' });
        }
        setNodeTechToken(body?.token ?? null);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'GET' && url === '/node/tech-session') {
        if (!requireProven(req, res, '/node/tech-session')) return;   // A496
        return json(res, 200, { token: getNodeTechToken() });
      }

      json(res, 404, { error: 'not found' });
    } catch (err: any) {
      if (res.headersSent) return;
      // F14: named, and the connection closed (the rest of an oversized body is not waited for).
      if (err instanceof BodyTooLarge) return json(res, 413, { error: `The batch is too large for the branch server (over ${NODE_BODY_LIMIT} bytes) — send fewer rows at a time.` }, { Connection: 'close' });
      json(res, 500, { error: err?.message ?? 'node error' });
    }
  };

  // A489: one port, both protocols. Made once per start; a certificate that cannot be made (the database unreadable)
  // leaves this server on plain HTTP, as before, rather than not serving the branch at all.
  plainServer = http.createServer(handler);
  tlsServer = null; tlsCert = null;
  try {
    const id = serverIdentity();
    tlsServer = https.createServer({ key: id.key, cert: id.cert }, handler);
    tlsServer.on('tlsClientError', () => { /* a till with the wrong certificate pinned, or a port scan — nothing to do */ });
    tlsCert = id.cert;
  } catch (e: any) {
    logLine('node', `A489: no certificate for this branch server (${e?.message ?? e}) — serving plain HTTP only`);
  }
  server = net.createServer((sock) => {
    sock.on('error', () => { /* a till that went away mid-connection — never an uncaught error */ });
    // A501: every connection is known, so stopping the server ends them too. A connection handed to the TLS handler
    // outlived stopNodeServer (closeAllConnections does not reach it) and kept being answered by the stopped server —
    // and tills now keep their connections open (lanTls, A501), so a stopped or stepped-down server must close them.
    openSockets.add(sock);
    sock.on('close', () => openSockets.delete(sock));
    // Nothing said within 15 s: dropped (the handlers' own timeouts start only once a protocol is chosen).
    sock.setTimeout(15_000, () => sock.destroy());
    sock.once('data', (first: Buffer) => {
      sock.setTimeout(0);
      sock.pause();
      sock.unshift(first);
      const target = first[0] === 0x16 && tlsServer ? tlsServer : plainServer;
      if (!target) { sock.destroy(); return; }
      target.emit('connection', sock);
      process.nextTick(() => sock.resume());
    });
  });

  // ── Port conflict ────────────────────────────────────────────────────────
  // This used to null the server and log to a console nobody reads on a shop
  // floor PC. If 4100 was already taken — another SwiftPOS instance, a portable
  // build left running, any unrelated service — the branch server silently did
  // not start, and tills 2 and 3 then failed with 'node unreachable' every 60
  // seconds with nothing on any screen explaining why.
  //
  // Now it walks up to the next few ports and REMEMBERS which one it got, so the
  // setup screen can show the address the other tills actually need to enter.
  // A branch server on a non-default port is unusual but recoverable; a branch
  // server that is not running at all is neither.
  server.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'EADDRINUSE' && portAttempt < PORT_FALLBACKS.length - 1) {
      portAttempt++;
      const next = PORT_FALLBACKS[portAttempt];
      console.warn(`[node] port ${PORT_FALLBACKS[portAttempt - 1]} in use, trying ${next}`);
      setTimeout(() => server?.listen(next), 150);
      return;
    }
    console.error('[node] server error', e);
    boundPort = null;
    server = null;
  });

  server.listen(PORT_FALLBACKS[portAttempt], () => {
    boundPort = PORT_FALLBACKS[portAttempt];
    if (boundPort !== NODE_PORT) {
      console.warn(`[node] listening on :${boundPort} — NOT the default ${NODE_PORT}. ` +
                   `Other tills must use this port in their branch server address.`);
    } else {
      console.log(`[node] aggregation node listening on :${boundPort}`);
    }
    startBeacon(beaconInfo);   // A427: tell the shop network this server is here
    announce(true);
  });
}

/**
 * The port the node server actually bound to, or null if it is not running.
 *
 * The setup screen shows this rather than the constant, because the number the
 * other tills need is the one that succeeded, not the one that was asked for.
 */
export function getNodePort(): number | null {
  return boundPort;
}

export function stopNodeServer(): void {
  const was = !!server;
  if (server) { server.close(); server = null; }
  // A489: the connections already handed to a protocol handler are closed too (the listening socket alone does not).
  for (const s of [plainServer, tlsServer]) { try { s?.closeAllConnections(); s?.close(); } catch { /* already closed */ } }
  for (const sock of openSockets) { try { sock.destroy(); } catch { /* gone */ } }   // A501
  openSockets.clear();
  plainServer = null; tlsServer = null;
  stopBeacon();
  boundPort = null;
  portAttempt = 0;
  if (was) announce(false);
}

// ── Broadcast tech token store (singleton row on the node) ──────────────────
function ensureNodeState() {
  getLocalDb().exec(`
    CREATE TABLE IF NOT EXISTS node_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      tech_token TEXT,
      updated_at TEXT
    );
    INSERT OR IGNORE INTO node_state (id, updated_at) VALUES (1, datetime('now'));
  `);
}
function setNodeTechToken(token: string | null) {
  ensureNodeState();
  getLocalDb().prepare(`UPDATE node_state SET tech_token=?, updated_at=datetime('now') WHERE id=1`).run(token);
}
function getNodeTechToken(): string | null {
  ensureNodeState();
  return (getLocalDb().prepare(`SELECT tech_token FROM node_state WHERE id=1`).get() as any)?.tech_token ?? null;
}
