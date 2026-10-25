/**
 * liveHub.ts — A531: the push channel. A till holds one WebSocket to /api/pos/live; the cloud says "changed" the moment
 * a change it needs is written, and the till asks GET /api/pos/changes for just those rows.
 *
 * Owner, 2026-10-19: "the till does not have to check, the trigger should happen instantly". And, for a branch with a
 * server: "for a setup like KRUNCH only the server does the communication to cloud, not all tills" — so at a branch only
 * the branch server holds a socket (its tills take the changes from it on the shop network).
 *
 *   - Sign-in: the first message, within 10 s — { type: 'hello', token } — checked by the SAME requireAuth every request
 *     goes through (a revoked, retired or blocked till is refused; an expired token too), and only a till's own session
 *     (a person's or a web session is refused: 4003). The token is never put in the URL (URLs are logged). The upgrade
 *     answer carries X-ZapTill-Server (A529: whose answer it is). Answered { type: 'ready', last_seq }.
 *   - The socket ends when the token does (+60 s): the till signs in again with its renewed token. A write through this
 *     server that changes the business's tills (a till blocked / retired / moved — forgetOnWrite `tills`) closes the
 *     business's sockets at once (4001), so a revoked till is refused on its reconnect. Every socket is checked again
 *     every 10 minutes as well (a change made outside this server).
 *   - A ping every 45 s; a socket that did not answer the last one is closed.
 *   - A554 (B Foods' log, 2026-10-21: "push channel closed (1006)" every ~13 minutes — the till renews its 15-minute
 *     token every 13, and this socket ended with the token it signed in with): after the hello the till may send
 *       { type: 'reauth', token } — its renewed token, checked as the hello is and for the SAME business and till →
 *       'reauthed' and the expiry moves to the new token's (refused → 4001, as before); and
 *       { type: 'ping' } → 'pong' (its own keepalive: a half-open line behind a proxy is found within seconds).
 *     `ready` lists them (features: ['ping', 'reauth']); a till before A554 sends neither and is unchanged.
 *   - How the server learns of a change: (a) at once after its own writes (forgetOnWrite → nudge(business): one read of
 *     that business's newest entry); (b) ONE read for every business every 5 s (sync_changes_heads) for a change made
 *     anywhere else — the SQL editor, a migration, another job. Only while at least one socket is open.
 *   - In memory: this server runs one instance (WEB_CONCURRENCY=1). A second instance would need a shared channel.
 * The push is only a doorbell ({ type: 'changed', last_seq, topics }): what changed is always read from /changes, so a
 * lost push costs nothing but time (a till without a socket asks every 5 minutes).
 *
 * A535 (stock and drawers):
 *   - A stock level changes on every sale (migration 153 logs it, topic stock). The 5 s read is per business AND branch
 *     (sync_changes_heads_by_branch): a change that is ONLY stock rings the sockets of THAT branch, at most once every
 *     STOCK_RING_MS per branch (a busy branch sells every few seconds: the levels ride along with any other ring, and a
 *     stock-only ring waits at most 5 minutes — they were re-read every 30). A stock change made through this server (a
 *     restock, a transfer, wastage, a count — routes/index.ts nudges for them) rings at once, as any other write.
 *   - ringDrawers(business): a drawer changed through this server (a web close, force-close, confirmation, a web sale —
 *     routes/index.ts) → { type: 'changed', topics: ['drawers'] } to the business's sockets ~1 s later (one ring per
 *     burst). The branch server then asks GET /api/pos/branch-drawers at once instead of waiting for its 60 s beat.
 *     Owner, 2026-10-19: "for a setup like KRUNCH only the server does the communication to cloud, not all tills".
 */
import type http from 'http';
import type { Duplex } from 'stream';
import { WebSocketServer, WebSocket } from 'ws';
import jwt from 'jsonwebtoken';
import cron from 'node-cron';
import { supabase } from './supabase';
import { requireAuth } from '../middleware/auth';
import { SERVER_SIGNATURE_HEADER, SERVER_SIGNATURE_VALUE } from './serverSignature';
import { latestSeq, forgetChangesOf } from './syncChanges';
import { traffic } from './trafficStats';

export const LIVE_PATH = '/api/pos/live';
export const HELLO_WAIT_MS = 10_000;
export const PING_EVERY_MS = 45_000;
export const RECHECK_EVERY_MS = 10 * 60_000;
export const HEADS_EVERY_MS = 5_000;
export const EXPIRY_GRACE_MS = 60_000;
/** A535: a stock-only change rings a branch at most this often (the levels also ride along with every other ring). */
export const STOCK_RING_MS = 5 * 60_000;
/** A535: a burst of drawer writes (a close is several requests) is one ring. */
export const DRAWERS_RING_DEBOUNCE_MS = 1_000;

interface Conn {
  ws: WebSocket;
  businessId: string;
  branchId: string | null;
  deviceId: string | null;
  token: string;
  alive: boolean;
  expiryTimer: NodeJS.Timeout | null;
  lastPushed: number;
}
const byBusiness = new Map<string, Set<Conn>>();
/** Per business: the newest entry pushed and how many entries the 5 s read last counted (a late commit adds one). */
const heads = new Map<string, { max: number; n: number }>();
let globalAfter: number | null = null;
/** A535: per business and branch (sync_changes_heads_by_branch); not asked while the database has no such function. */
const headsB = new Map<string, { max: number; n: number }>();
let byBranchUntil = 0;
/** A535: when each branch last heard a stock-only ring, and the ring that waits for its turn. */
const stockRungAt = new Map<string, number>();
const stockWaiting = new Map<string, { businessId: string; branchId: string; seq: number }>();
let timers: NodeJS.Timeout[] = [];

export interface AuthVerdict { ok: boolean; status: number; code?: string; businessId?: string; branchId?: string | null; deviceId?: string | null; isTill?: boolean; surface?: string | null }

/** The same requireAuth every request goes through, on a token alone. Exported for the tests. */
export function checkToken(token: string): Promise<AuthVerdict> {
  return new Promise((resolve) => {
    const req: any = { headers: { authorization: `Bearer ${token}` }, method: 'GET', path: LIVE_PATH, url: LIVE_PATH, originalUrl: LIVE_PATH, query: {} };
    let status = 200; let body: any = null; let settled = false;
    const done = (v: AuthVerdict) => { if (!settled) { settled = true; resolve(v); } };
    const res: any = {
      status(c: number) { status = c; return res; },
      json(b: unknown) { body = b; done({ ok: false, status, code: (body as { code?: string })?.code }); return res; },
      setHeader() { return res; }, set() { return res; }, getHeader() { return undefined; },
    };
    Promise.resolve(requireAuth(req, res, () => done({
      ok: true, status: 200, businessId: req.businessId, branchId: req.branchId ?? null, deviceId: req.deviceId ?? null,
      isTill: !!req.isTill, surface: req.surface ?? null,
    }))).catch(() => done({ ok: false, status: 503, code: 'AUTH_BACKEND_UNAVAILABLE' }));
  });
}

function send(c: Conn, msg: unknown): void {
  if (c.ws.readyState !== WebSocket.OPEN) return;
  try { c.ws.send(JSON.stringify(msg)); traffic.count('live.sent'); } catch { /* the close handler tidies */ }
}

/** A554: what a till may send after its hello (named in `ready`, so a till knows this cloud takes them). */
export const LIVE_FEATURES = ['ping', 'reauth'] as const;

/** The socket ends when its token does (+60 s) — set at the hello, moved by a reauth (A554). */
function armExpiry(c: Conn): void {
  if (c.expiryTimer) clearTimeout(c.expiryTimer);
  c.expiryTimer = null;
  const exp = Number((jwt.decode(c.token) as { exp?: number } | null)?.exp ?? 0) * 1000;
  if (exp) c.expiryTimer = setTimeout(() => { try { c.ws.close(4001, 'token expired'); } catch { /* gone */ } }, Math.max(1_000, exp - Date.now() + EXPIRY_GRACE_MS));
}

/** A554: a message on a signed-in socket — the till's keepalive, or its renewed token. */
async function onSignedIn(c: Conn, msg: any): Promise<void> {
  if (msg?.type === 'ping') { c.alive = true; send(c, { type: 'pong' }); return; }
  if (msg?.type !== 'reauth' || typeof msg.token !== 'string' || !msg.token) return;
  const v = await checkToken(msg.token);
  if (v.status === 503) return;   // the database is busy: the old token holds until its own expiry
  const same = v.ok && v.isTill && v.surface === 'desktop' && v.businessId === c.businessId && (v.deviceId ?? null) === c.deviceId;
  if (!same) { try { c.ws.close(4001, v.ok ? 'not the same POS' : (v.code ?? `refused ${v.status}`)); } catch { /* gone */ } return; }
  c.token = msg.token;
  c.branchId = v.branchId ?? c.branchId;
  armExpiry(c);
  traffic.count('live.reauth');
  send(c, { type: 'reauthed' });
}

function drop(c: Conn): void {
  if (c.expiryTimer) clearTimeout(c.expiryTimer);
  const set = byBusiness.get(c.businessId);
  if (set) { set.delete(c); if (!set.size) byBusiness.delete(c.businessId); }
}

/** How many sockets are open (the admin System page, the tests). */
export function liveCount(): number { let n = 0; for (const s of byBusiness.values()) n += s.size; return n; }

/** A535: tell the sockets of ONE branch of the business (and any socket that names no branch) — a stock-only change. */
export function pushChangedAtBranch(businessId: string, branchId: string, lastSeq: number, topics: string[] = ['stock']): number {
  const set = byBusiness.get(businessId);
  if (!set) return 0;
  forgetChangesOf(businessId);
  let n = 0;
  for (const c of set) {
    if (c.branchId && c.branchId !== branchId) continue;
    send(c, { type: 'changed', last_seq: lastSeq, topics }); c.lastPushed = Math.max(c.lastPushed, lastSeq); n++;
  }
  traffic.count('live.pushed_stock', n);
  return n;
}

/** A535: a stock-only change at a branch — now if its last stock ring is STOCK_RING_MS old, else when it is. */
function ringStock(businessId: string, branchId: string, seq: number, now: number): void {
  const k = `${businessId}|${branchId}`;
  if (now - (stockRungAt.get(k) ?? 0) >= STOCK_RING_MS) {
    stockWaiting.delete(k); stockRungAt.set(k, now);
    pushChangedAtBranch(businessId, branchId, seq);
  } else {
    const w = stockWaiting.get(k);
    stockWaiting.set(k, { businessId, branchId, seq: Math.max(seq, w?.seq ?? 0) });
  }
}
function flushStock(now: number): void {
  for (const [k, w] of [...stockWaiting]) {
    if (now - (stockRungAt.get(k) ?? 0) < STOCK_RING_MS) continue;
    stockWaiting.delete(k); stockRungAt.set(k, now);
    pushChangedAtBranch(w.businessId, w.branchId, w.seq);
  }
}

/**
 * A535: a drawer changed through this server (routes/index.ts: a web close / force-close / confirmation, a web sale, a
 * remote day close). The business's sockets hear { type: 'changed', topics: ['drawers'] } once per burst — a branch
 * server asks GET /api/pos/branch-drawers; any other till ignores it (its own drawer checks are its own).
 */
const drawersRinging = new Map<string, NodeJS.Timeout>();
export function ringDrawers(businessId: string | null): void {
  if (!businessId || !byBusiness.has(businessId) || drawersRinging.has(businessId)) return;
  const t = setTimeout(() => {
    drawersRinging.delete(businessId);
    const set = byBusiness.get(businessId);
    if (!set) return;
    const last = heads.get(businessId)?.max ?? 0;
    let n = 0;
    for (const c of set) { send(c, { type: 'changed', last_seq: last, topics: ['drawers'] }); n++; }
    traffic.count('live.drawers', n);
  }, DRAWERS_RING_DEBOUNCE_MS);
  t.unref?.();
  drawersRinging.set(businessId, t);
}

/** Tell every socket of the business that something changed (newest entry `lastSeq`). */
export function pushChanged(businessId: string, lastSeq: number, topics: string[] = []): number {
  const set = byBusiness.get(businessId);
  if (!set) return 0;
  forgetChangesOf(businessId);
  let n = 0;
  for (const c of set) { send(c, { type: 'changed', last_seq: lastSeq, topics }); c.lastPushed = Math.max(c.lastPushed, lastSeq); n++; }
  traffic.count('live.pushed', n);
  return n;
}

/**
 * A533: ZapTill support asked a device of this business for its log (lib/logRequests.ts). The business's sockets hear
 * { type: 'log_request', device_id } — a doorbell like 'changed': the till named asks GET /api/support/log-requests/mine
 * for the request itself; the others (and a branch server, for a till behind it) ignore it — that till asks on its own
 * 90 s beat. Never another business's sockets. Returns how many sockets heard it.
 */
export function ringLogRequest(businessId: string, deviceId: string): number {
  const set = byBusiness.get(businessId);
  if (!set) return 0;
  let n = 0;
  for (const c of set) { send(c, { type: 'log_request', device_id: deviceId }); n++; }
  traffic.count('live.log_request', n);
  return n;
}

/** A533 test seam: a socket stand-in (only what send() and the doorbells use). */
export function _addTestConn(businessId: string, deviceId: string | null, sink: (msg: unknown) => void, branchId: string | null = null): () => void {
  const ws = { readyState: WebSocket.OPEN, send: (s: string) => sink(JSON.parse(s)),
    close: (code?: number) => sink({ type: '__closed', code }) } as unknown as WebSocket;
  const c: Conn = { ws, businessId, branchId, deviceId, token: '', alive: true, expiryTimer: null, lastPushed: 0 };
  let set = byBusiness.get(businessId);
  if (!set) { set = new Set(); byBusiness.set(businessId, set); }
  set.add(c);
  return () => drop(c);
}

// ── (a) this server's own writes ────────────────────────────────────────────────────────────────────────────────────
const nudged = new Map<string, NodeJS.Timeout>();
/** A write this server handled for the business (forgetOnWrite): read its newest entry soon, push if it moved. */
export function nudge(businessId: string | null): void {
  if (!businessId) return;   // an admin write names no single business: the 5 s read finds it
  if (!byBusiness.has(businessId) || nudged.has(businessId)) return;
  // 300 ms: a save that writes several rows (a product and its options) is one push, after its transaction committed.
  nudged.set(businessId, setTimeout(async () => {
    nudged.delete(businessId);
    try {
      const seq = await latestSeq(businessId);
      const h = heads.get(businessId);
      if (!h || seq > h.max) { heads.set(businessId, { max: seq, n: h?.n ?? 0 }); pushChanged(businessId, seq); }
    } catch { /* the 5 s read */ }
  }, 300));
}

/** A change to the business's tills (blocked, retired, moved): its sockets sign in again — a revoked till is refused. */
export function recheckBusiness(businessId: string | null): void {
  const sets = businessId ? [byBusiness.get(businessId)].filter(Boolean) as Set<Conn>[] : [...byBusiness.values()];
  for (const set of sets) for (const c of [...set]) { try { c.ws.close(4001, 'sign in again'); } catch { /* gone */ } }
}

// ── (b) everything else: one read for every business every 5 s ─────────────────────────────────────────────────────
export async function headsTick(now = Date.now()): Promise<void> {
  if (!byBusiness.size) return;
  try {
    if (globalAfter === null) {
      const { data, error } = await supabase.from('sync_changes').select('seq').order('seq', { ascending: false }).limit(1).maybeSingle();
      if (error) return;
      globalAfter = Number((data as { seq?: number } | null)?.seq ?? 0) || 0;
    }
    flushStock(now);   // A535: a stock-only ring whose turn has come
    traffic.count('live.heads_read'); traffic.queries(1);
    // A535: per business and branch (migration 153) — a stock-only change rings its own branch, at most every 5 minutes.
    if (now >= byBranchUntil) {
      const { data, error } = await supabase.rpc('sync_changes_heads_by_branch', { p_after: globalAfter });
      if (!error && Array.isArray(data)) { applyBranchHeads(data as BranchHead[], now); return; }
      byBranchUntil = now + 10 * 60_000;   // before migration 153: the business-wide read below, asked again in 10 minutes
    }
    const { data, error } = await supabase.rpc('sync_changes_heads', { p_after: globalAfter });
    if (error) return;
    for (const r of (data ?? []) as Array<{ business_id: string; max_seq: number | string; n: number | string; topics: string[] }>) {
      const max = Number(r.max_seq) || 0; const n = Number(r.n) || 0;
      if (max > (globalAfter ?? 0)) globalAfter = max;
      const h = heads.get(r.business_id);
      const moved = !h || max > h.max || (max === h.max && n > h.n);
      heads.set(r.business_id, { max: Math.max(max, h?.max ?? 0), n });
      if (moved) pushChanged(r.business_id, max, r.topics ?? []);   // no socket of that business: nothing sent
    }
  } catch { /* next tick */ }
}

// ── the sockets ─────────────────────────────────────────────────────────────────────────────────────────────────────
function onConnection(ws: WebSocket): void {
  traffic.count('live.opened');
  let conn: Conn | null = null;
  const helloTimer = setTimeout(() => { if (!conn) { try { ws.close(4000, 'no hello'); } catch { /* gone */ } } }, HELLO_WAIT_MS);
  ws.on('pong', () => { if (conn) conn.alive = true; });
  ws.on('close', () => { clearTimeout(helloTimer); if (conn) drop(conn); });
  ws.on('error', () => { /* the close follows */ });
  ws.on('message', async (raw) => {
    let msg: any = null;
    try { msg = JSON.parse(String(raw)); } catch { /* ignored */ }
    if (conn) { await onSignedIn(conn, msg); return; }   // A554
    if (msg?.type !== 'hello' || typeof msg.token !== 'string') return;
    const token = msg.token as string;
    const v = await checkToken(token);
    if (!v.ok) { try { ws.close(4001, v.code ?? `refused ${v.status}`); } catch { /* gone */ } return; }
    if (!v.isTill || v.surface !== 'desktop') { try { ws.close(4003, 'a POS only'); } catch { /* gone */ } return; }
    clearTimeout(helloTimer);
    const c: Conn = { ws, businessId: v.businessId!, branchId: v.branchId ?? null, deviceId: v.deviceId ?? null, token, alive: true, expiryTimer: null, lastPushed: 0 };
    conn = c;
    armExpiry(c);
    let set = byBusiness.get(c.businessId);
    if (!set) { set = new Set(); byBusiness.set(c.businessId, set); }
    set.add(c);
    let last = 0;
    try { last = await latestSeq(c.businessId); } catch { last = 0; }
    send(c, { type: 'ready', last_seq: last, features: [...LIVE_FEATURES] });   // A554: features
  });
}

/** Mounts /api/pos/live on the HTTP server (same port: Render passes WebSocket upgrades through). */
export function attachLiveHub(server: http.Server): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  wss.on('headers', (headers) => { headers.push(`${SERVER_SIGNATURE_HEADER}: ${SERVER_SIGNATURE_VALUE}`); });
  wss.on('connection', onConnection);
  server.on('upgrade', (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = String(req.url ?? '').split('?')[0];
    if (path !== LIVE_PATH) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  const ping = setInterval(() => {
    for (const set of byBusiness.values()) for (const c of [...set]) {
      if (!c.alive) { try { c.ws.terminate(); } catch { /* gone */ } drop(c); continue; }
      c.alive = false;
      try { c.ws.ping(); } catch { /* gone */ }
    }
  }, PING_EVERY_MS);
  const recheck = setInterval(async () => {
    for (const set of [...byBusiness.values()]) for (const c of [...set]) {
      const v = await checkToken(c.token);
      if (!v.ok && v.status !== 503) { try { c.ws.close(4001, v.code ?? 'sign in again'); } catch { /* gone */ } }
    }
  }, RECHECK_EVERY_MS);
  const poll = setInterval(() => { void headsTick(); }, HEADS_EVERY_MS);
  for (const t of [ping, recheck, poll]) t.unref?.();
  timers.push(ping, recheck, poll);
  server.on('close', () => { for (const t of timers) clearInterval(t); timers = []; wss.close(); });
  return wss;
}

/** Old change-log entries go once a day (30 days kept). Never throws. */
export function startSyncChangePruneJob(): void {
  cron.schedule('17 3 * * *', async () => {
    try {
      const { data, error } = await supabase.rpc('prune_sync_changes', { p_keep_days: 30 });
      if (error) { console.warn(`[liveHub] prune_sync_changes: ${error.message} (migration 151?)`); return; }
      console.log(`[liveHub] change log: ${Number(data) || 0} entries older than 30 days removed`);
    } catch (e) { console.warn(`[liveHub] prune failed: ${(e as Error)?.message ?? e}`); }
  }, { timezone: 'UTC' });
}

interface BranchHead { business_id: string; branch_id: string | null; max_seq: number | string; n: number | string; topics: string[] | null }
/** A535: the 5 s read per business and branch. Anything but stock alone rings the whole business, as A531 did. */
function applyBranchHeads(rows: BranchHead[], now: number): void {
  const whole = new Map<string, { max: number; topics: Set<string> }>();
  for (const r of rows) {
    const max = Number(r.max_seq) || 0; const n = Number(r.n) || 0;
    if (max > (globalAfter ?? 0)) globalAfter = max;
    const k = `${r.business_id}|${r.branch_id ?? ''}`;
    const h = headsB.get(k);
    const moved = !h || max > h.max || (max === h.max && n > h.n);
    headsB.set(k, { max: Math.max(max, h?.max ?? 0), n });
    const b = heads.get(r.business_id);
    if (!b || max > b.max) heads.set(r.business_id, { max, n: b?.n ?? 0 });   // what nudge() compares with
    if (!moved) continue;
    const topics = r.topics ?? [];
    if (r.branch_id && topics.length && topics.every((t) => t === 'stock')) { ringStock(r.business_id, r.branch_id, max, now); continue; }
    const w = whole.get(r.business_id) ?? { max: 0, topics: new Set<string>() };
    w.max = Math.max(w.max, max); for (const t of topics) w.topics.add(t);
    whole.set(r.business_id, w);
  }
  for (const [biz, w] of whole) pushChanged(biz, w.max, [...w.topics]);   // no socket of that business: nothing sent
}

/** Test seam. */
export function _resetLiveHub(): void {
  byBusiness.clear(); heads.clear(); globalAfter = null; for (const t of nudged.values()) clearTimeout(t); nudged.clear();
  headsB.clear(); byBranchUntil = 0; stockRungAt.clear(); stockWaiting.clear();   // A535
  for (const t of drawersRinging.values()) clearTimeout(t); drawersRinging.clear();
}
/** Test seam (A554): each socket's till and when its token runs out (ms). */
export function _liveConnsForTest(): Array<{ deviceId: string | null; exp: number }> {
  const out: Array<{ deviceId: string | null; exp: number }> = [];
  for (const set of byBusiness.values()) for (const c of set) out.push({ deviceId: c.deviceId, exp: Number((jwt.decode(c.token) as { exp?: number } | null)?.exp ?? 0) * 1000 });
  return out;
}
