/**
 * liveSync.ts — A531: the till takes a change when there IS one, and only the rows that changed.
 *
 * Owner, 2026-10-19: "this should only happen when there is a change, no need to keep asking for the same item … Critical
 * should be instant, non-critical can take effect after 1 hr or 30 min." Then: "the till does not have to check, the
 * trigger should happen instantly — if I change fries from 100 to 150 the trigger should only send the affected product
 * and price, not the whole menu … if Eugene's PIN changes only Eugene's change gets synced, not all 150 staff." And for a
 * branch with a server: "only the server does the communication to cloud, not all tills".
 *
 * Measured before (A528's System page): /api/pos 5.0 MB in 36 minutes across about 4 tills — every till took the whole
 * catalogue (/api/pos/init, ~300 KB with the logo, plus one request per product with options) every 10 minutes whether
 * anything had changed or not, and asked "has anything changed?" every 20 s.
 *
 * Now (three ways a till can be):
 *   direct  — a till with no branch server, or the branch server itself. It holds ONE WebSocket to the cloud
 *             (/api/pos/live): the cloud rings when the database has written a change for the business. Then it asks
 *             GET /api/pos/changes?since=<the last change it applied> and gets the changed rows themselves (or delete
 *             markers) — fries' new price is one product row, Eugene's PIN one staff row. No timer asks anything while the
 *             socket is up. Socket down: it reconnects (5 s → 5 min back-off) and asks /changes every 5 minutes (every
 *             20 s while a drawer is open or a sale was rung in the last 5 minutes).
 *   peer    — a till behind a branch server. It never asks the cloud for the menu, the staff or the changes: every 20 s
 *             it asks the SERVER (/node/live?since=, the shop network — free), which serves the changes it has applied,
 *             in the order it applied them.
 *   legacy  — the cloud (or the branch server) has no change log yet (an answer that is ours and says 404 — A529 decides
 *             whose answer it is): today's behaviour (the 20 s version check, the 10-minute whole pull). Asked again hourly.
 *
 * What is applied when (shared/syncTopics.ts): menu, staff, money — at once. look, setup — kept (persisted) and applied
 * when the till is idle (no drawer open — on a server: none open in the branch), at a shift opening or closing, or after
 * 30 minutes at most — and never while a sale is in the cart, the payment screen is open or a print is queued.
 * Safety: the whole catalogue once a day (and the first time, and when the till is further behind than the log keeps:
 * `full_resync_needed`). Stock levels (the manager's stock report: other tills' sales move them, which is not a change
 * the log carries) are re-read every 30 minutes when the till sells stock-tracked items — A535: only against a cloud
 * before migration 153; from 153 each level travels as its own change (topic stock, `serves: ['stock']` says so).
 * A535 also: a ring for `drawers` alone asks no /changes (a branch server asks GET /api/pos/branch-drawers —
 * branchDrawers.ts); a log request the cloud rings for one of a server's tills is passed on with that till's next
 * /node/live (`log_request: true`), and the till asks for it at once.
 * One log line per pull: the topics, the rows, the bytes on the wire. The Tech page shows each topic's last change.
 *
 * A554 (the first pulled till log, B Foods 2026-10-21: "push channel closed (1006)" about every 13 minutes, all day, each
 * one minute after "device token expires in 120s — refreshing ahead of the 401"): the cloud ends a socket when the token
 * it signed in with expires (+60 s), and the till renews its token every 13 minutes (2 minutes before the 15). Each
 * renewal therefore cost a dropped channel, a 5–20 s gap and a reconnect — and the close reached the till as 1006 (no
 * close frame: lost on the way, Render's proxy or the runtime's WebSocket) instead of the cloud's 4001. Now:
 *   - renewed token, open socket: an A554 cloud (its `ready` lists `reauth`) is told the new token on the open socket
 *     ({ type: 'reauth', token } → 'reauthed'): nothing closes. An older cloud: the till closes the socket itself and
 *     opens a new one with the new token at once (no 1006, no fallback polling) — before the old token runs out.
 *     A reauth not confirmed within REAUTH_WAIT_MS is the same planned reconnect.
 *   - keepalive: every KEEPALIVE_MS the till sends { type: 'ping' } (an A554 cloud answers 'pong'; any message counts);
 *     no answer within PONG_WAIT_MS → the socket is dead (a half-open line behind a proxy) and it reconnects at once.
 *     An older cloud (no `ping` in `ready`) is not pinged — it pings the till itself every 45 s (ws pings).
 */
import { getLocalDb } from './localDb';
import { getDeviceConfig, isNodeRole } from './deviceConfig';
import { logLine } from './logFile';
import { activitySnapshot } from './activityTracker';
import { lanFetch } from './lanTls';
import { nodeUrl, nodeHeaders } from './nodeClient';
import { applyChangeEntries, liveCloudGet, liveSocketTarget, liveWholePull, refreshStockLevels, setLiveCatalogue,
  refreshAccessToken } from './syncEngine';
import { readBranchStaffForServe } from './branchStaff';
import { refreshStaffRosterNow, setRosterLive } from './staffRoster';
import { isCriticalTopic, NON_CRITICAL_WAIT_MS, SYNC_TOPICS, DRAWERS_TOPIC, type ChangeEntry, type ChangesAnswer } from './syncTopics';

export const SOCKET_DOWN_POLL_MS = 5 * 60_000;
export const BUSY_POLL_MS = 20_000;
export const PEER_POLL_MS = 20_000;
export const DAILY_FULL_MS = 24 * 3600_000;
export const STOCK_REFRESH_MS = 30 * 60_000;
export const LEGACY_RETRY_MS = 60 * 60_000;
export const RECENT_KEEP_MS = 150_000;   // the cloud repeats the last 120 s (a late commit): what was applied is skipped
export const LIVE_LOG_KEEP_MS = 7 * 86_400_000;
const TICK_MS = 15_000;
/** A554: the till's keepalive on the push channel (well under a proxy's idle timeout). */
export const KEEPALIVE_MS = 25_000;
/** A554: no answer to a keepalive this long → the socket is dead; reconnect at once. */
export const PONG_WAIT_MS = 20_000;
/** A554: a reauth the cloud did not confirm this long → the planned reconnect with the new token. */
export const REAUTH_WAIT_MS = 15_000;
const KEEPALIVE_CHECK_MS = 5_000;
const BACKOFF = [5_000, 10_000, 30_000, 60_000, 120_000, 300_000];

export type LiveMode = 'unknown' | 'direct' | 'peer' | 'legacy';

// ── state (maintenance_state) ────────────────────────────────────────────────────────────────────────────────────────
const K = { seq: 'live_seq', recent: 'live_recent', pending: 'live_pending', full: 'live_full_at', topics: 'live_topics',
  local: 'live_node_local', stock: 'live_stock_at', floor: 'live_floor', scope: 'live_scope',
  serves: 'live_serves_stock' } as const;   // A535: '1' = stock levels arrive as changes (no 30-minute re-read)
function getKv(key: string): string | null {
  try { return (getLocalDb().prepare(`SELECT value FROM maintenance_state WHERE key = ?`).get(key) as { value?: string } | undefined)?.value ?? null; }
  catch { return null; }
}
function setKv(key: string, value: string | null): void {
  try {
    const db = getLocalDb();
    if (value === null) db.prepare(`DELETE FROM maintenance_state WHERE key = ?`).run(key);
    else db.prepare(`INSERT INTO maintenance_state (key, value, updated_at) VALUES (?, ?, ?)
                     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(key, value, new Date().toISOString());
  } catch { /* the next pass */ }
}
const json = <T>(key: string, dflt: T): T => { try { const v = getKv(key); return v ? JSON.parse(v) as T : dflt; } catch { return dflt; } };

interface Pending { entry: ChangeEntry; since: number }
interface TopicState { seq: number; at: string; rows: number; bytes: number }

let mode: LiveMode = 'unknown';
let legacyUntil = 0;
let lastPollAt = 0;
let lastFullTry = 0;
let lastDrawers = -1;
let inFlight: Promise<boolean> | null = null;
let again = false;
let timer: NodeJS.Timeout | null = null;
let socket: any = null;
let socketOpen = false;
let socketSince = 0;     // A542: when the push channel last opened (the Tech page's "connected since")
let lastRingAt = 0;      // A542: the cloud's last ring ('changed')
let fallbackEvery = 0;   // A542: the check interval while the channel is down (0 = not polling for it)
let socketTries = 0;
let socketRetryAt = 0;
// A554: the token the open socket signed in with, what its cloud said it can do (`ready`.features), the keepalive.
let socketToken = '';
let socketFeatures = new Set<string>();
let lastHeardAt = 0;      // the socket's last message (any message proves the line is alive)
let pingSentAt = 0;       // a keepalive waiting for its answer (0: none)
let reauthToken = '';     // the renewed token told to the cloud on the open socket, waiting for 'reauthed'
let reauthSentAt = 0;
let keepTimer: NodeJS.Timeout | null = null;
let lastError = '';
let started = false;

/** Which way this till takes its changes (null: no branch server / not configured). */
function shape(): 'direct' | 'peer' {
  const cfg = getDeviceConfig();
  if (!cfg) return 'direct';
  if (isNodeRole(cfg.device_role)) return 'direct';
  return nodeUrl() ? 'peer' : 'direct';
}
function isServer(): boolean { return isNodeRole(getDeviceConfig()?.device_role ?? null); }
/** The business and branch this till's change number belongs to. */
function scopeKey(): string {
  let biz = '';
  try { biz = String((getLocalDb().prepare(`SELECT business_id FROM session WHERE id = 1`).get() as { business_id?: string } | undefined)?.business_id ?? ''); } catch { biz = ''; }
  return `${biz}|${getDeviceConfig()?.branch_id ?? ''}`;
}

export function liveMode(): LiveMode { return mode; }
/** Change-triggered sync is on (the 20 s check and the 10-minute whole pull stand down). */
export function liveActive(): boolean { return mode === 'direct' || mode === 'peer'; }

// ── is the till busy? ────────────────────────────────────────────────────────────────────────────────────────────────
/** Open drawers: this till's own; on a branch server, every drawer of the branch (it holds its tills' shifts). */
export function openDrawers(): number {
  try {
    const db = getLocalDb();
    if (isServer()) return Number((db.prepare(`SELECT COUNT(*) AS n FROM shifts WHERE status = 'open'`).get() as { n: number }).n) || 0;
    return Number((db.prepare(`SELECT COUNT(*) AS n FROM shifts WHERE status = 'open' AND COALESCE(device_id,'') = COALESCE(?,'')`)
      .get(getDeviceConfig()?.device_id ?? null) as { n: number }).n) || 0;
  } catch { return 0; }
}
/** Mid-sale: a cart with items, the payment screen, a print still queued (activityTracker) — nothing is applied then. */
function midSale(): boolean { try { return activitySnapshot().busy !== null; } catch { return false; } }
function recentlyTrading(now: number): boolean {
  try { const a = activitySnapshot(); return (a.lastUseWhat === 'sale' || a.lastUseWhat === 'payment' || a.lastUseWhat === 'shift') && now - a.lastUse < 5 * 60_000; }
  catch { return false; }
}

// ── applying ─────────────────────────────────────────────────────────────────────────────────────────────────────────
function recordTopics(entries: ChangeEntry[], bytes: number): void {
  if (!entries.length) return;
  const t = json<Record<string, TopicState>>(K.topics, {});
  const at = new Date().toISOString();
  const per = new Map<string, ChangeEntry[]>();
  for (const e of entries) { const l = per.get(e.topic) ?? []; l.push(e); per.set(e.topic, l); }
  const total = entries.length;
  for (const [topic, list] of per) {
    const seq = Math.max(...list.map((e) => e.seq));
    const share = Math.round(bytes * (list.length / total));
    t[topic] = { seq, at, rows: list.length, bytes: share };
    const tables = [...new Set(list.map((e) => e.table))].map((x) => `${x} ${list.filter((e) => e.table === x).length}`).join(', ');
    logLine('sync', `A531: ${topic} — ${list.length} row(s) applied (${tables}), change ${seq}, ~${share} bytes`);
  }
  setKv(K.topics, JSON.stringify(t));
}

/** Apply now (and, on a branch server, log for its tills). */
function applyNow(entries: ChangeEntry[], bytes: number): number {
  if (!entries.length) return 0;
  const r = applyChangeEntries(entries);
  if (isServer()) appendLiveLog(entries);
  recordTopics(entries, bytes);
  return r.rows;
}

/** A look / setup change waits — kept on disk, one per row (the newest), from when it first waited. */
function keepForLater(entries: ChangeEntry[], now: number): void {
  if (!entries.length) return;
  const list = json<Pending[]>(K.pending, []);
  for (const e of entries) {
    const i = list.findIndex((p) => p.entry.table === e.table && p.entry.id === e.id);
    if (i >= 0) list[i] = { entry: e, since: list[i].since };
    else list.push({ entry: e, since: now });
  }
  setKv(K.pending, JSON.stringify(list));
  logLine('sync', `A531: ${entries.length} look/setup change(s) wait for an idle moment (at most 30 minutes)`);
}

/** The waiting look / setup changes, when due: idle, a shift opened or closed, or 30 minutes — never mid-sale. */
export function applyWaitingIfDue(now = Date.now(), o: { shiftEvent?: boolean; force?: boolean } = {}): number {
  const list = json<Pending[]>(K.pending, []);
  if (!list.length) return 0;
  if (midSale() && !o.force) return 0;
  const oldest = Math.min(...list.map((p) => p.since));
  const due = o.force || o.shiftEvent || openDrawers() === 0 || now - oldest >= NON_CRITICAL_WAIT_MS;
  if (!due) return 0;
  setKv(K.pending, null);
  return applyNow(list.map((p) => p.entry).sort((a, b) => a.seq - b.seq), 0);
}

/** One page of changes: what was applied already is skipped; menu / staff / money now, look / setup kept. */
function handle(a: ChangesAnswer, bytes: number, now: number): number {
  const recent = json<Array<[number, number]>>(K.recent, []).filter(([, at]) => now - at < RECENT_KEEP_MS);
  const seen = new Set(recent.map(([s]) => s));
  const fresh = (a.changes ?? []).filter((e) => !seen.has(e.seq));
  const crit = fresh.filter((e) => isCriticalTopic(e.topic));
  const later = fresh.filter((e) => !isCriticalTopic(e.topic));
  const n = applyNow(crit, bytes);
  keepForLater(later, now);
  for (const e of fresh) recent.push([e.seq, now]);
  setKv(K.recent, JSON.stringify(recent));
  return n + (later.length ? applyWaitingIfDue(now) : 0);
}

// ── where the changes come from ──────────────────────────────────────────────────────────────────────────────────────
type Fetched = { status: number; body?: ChangesAnswer & { local?: string | null }; bytes: number };
async function fetchChanges(since: number | null): Promise<Fetched> {
  const branch = getDeviceConfig()?.branch_id ?? null;
  if (shape() === 'peer') {
    const base = nodeUrl();
    if (!base) return { status: 0, bytes: 0 };
    const res = await lanFetch(`${base}/node/live${since === null ? '' : `?since=${since}`}`, { headers: nodeHeaders(), signal: AbortSignal.timeout(8_000) } as any);
    const text = res.ok ? await res.text() : '';
    return { status: res.status, body: res.ok ? JSON.parse(text) : undefined, bytes: Buffer.byteLength(text) };
  }
  const q = new URLSearchParams();
  if (since !== null) q.set('since', String(since));
  if (branch) q.set('branch_id', branch);
  const res = await liveCloudGet(`/api/pos/changes${q.toString() ? `?${q}` : ''}`);
  const text = res.ok ? await res.text() : '';
  const wire = Number(res.headers.get('content-length') ?? '') || Buffer.byteLength(text);
  return { status: res.status, body: res.ok ? JSON.parse(text) : undefined, bytes: wire };
}

/** The whole catalogue once, then the log from where it stood just before (nothing between is lost: rows are re-sent). */
async function fullResync(why: string, now: number): Promise<boolean> {
  const base = await fetchChanges(null);
  if (base.status === 404) { goLegacy(now); return false; }
  // A failed try is not repeated within the hour (the daily safety pull on a till whose cloud is down).
  if (!base.body || !Number.isFinite(Number(base.body.last_seq))) { lastFullTry = now; lastError = `the change log did not answer (HTTP ${base.status})`; return false; }
  noteServes(base.body);
  const ok = await liveWholePull(shape() === 'direct');
  if (!ok) { lastFullTry = now; lastError = 'the whole catalogue could not be taken'; return false; }
  if (shape() === 'direct') void refreshStaffRosterNow(`whole catalogue (${why})`);
  setKv(K.seq, String(Number(base.body.last_seq)));
  setKv(K.scope, scopeKey());
  setKv(K.pending, null);
  setKv(K.full, new Date(now).toISOString());
  if (base.body.local !== undefined) setKv(K.local, String(base.body.local ?? ''));
  if (isServer()) markLiveLogResync();
  logLine('sync', `A531: whole catalogue taken (${why}) — changes from ${base.body.last_seq} on`);
  return true;
}

/** A535: does the cloud (or, on a peer, the branch server) send stock levels as changes? Every answer says so. */
function noteServes(b: ChangesAnswer): void {
  const v = Array.isArray(b?.serves) && b.serves.includes('stock') ? '1' : '0';
  if (getKv(K.serves) !== v) {
    setKv(K.serves, v);
    logLine('sync', v === '1' ? 'A535: stock levels arrive as changes — no 30-minute re-read' : 'A535: stock levels are re-read every 30 minutes (this cloud does not send them as changes)');
  }
}
/** A535: stock levels arrive as changes (the 30-minute re-read stands down). */
export function stockTravelsOnChange(): boolean { return liveActive() && getKv(K.serves) === '1'; }

function goLegacy(now: number): void {
  if (mode !== 'legacy') logLine('sync', `A531: ${shape() === 'peer' ? 'the branch server' : 'the cloud'} keeps no change log yet — the till checks and pulls as before (asked again in an hour)`);
  mode = 'legacy'; legacyUntil = now + LEGACY_RETRY_MS;
  closeSocket();
}

/** Take what changed. Single-flight (a call during a run gets one more run after it). True when something was applied. */
export function catchUp(why = 'asked'): Promise<boolean> {
  if (inFlight) { again = true; return inFlight; }
  inFlight = (async () => {
    let any = false;
    do { again = false; any = (await catchUpOnce(why, Date.now())) || any; } while (again);
    return any;
  })().finally(() => { inFlight = null; });
  return inFlight;
}

async function catchUpOnce(why: string, now: number): Promise<boolean> {
  if (mode === 'legacy' && now < legacyUntil) return false;
  lastPollAt = now;
  try {
    const held = getKv(K.seq);
    // A number belongs to one business and branch: a till moved to another branch (or rejoined elsewhere) takes the whole
    // catalogue for where it is now, as the branch change always did.
    const moved = held !== null && getKv(K.scope) !== scopeKey();
    if (held === null || moved) {
      const ok = await fullResync(moved ? 'moved to another branch' : 'first start', now);
      if (ok && mode !== 'legacy') mode = shape();
      return ok;
    }
    let since = Number(held);
    let applied = 0;
    for (let page = 0; page < 20; page++) {
      const f = await fetchChanges(since);
      if (f.status === 404) { goLegacy(now); return false; }
      if (!f.body) { lastError = `changes: HTTP ${f.status}`; return applied > 0; }
      if (mode !== shape()) { mode = shape(); logLine('sync', `A531: change-triggered sync on (${mode === 'peer' ? 'from the branch server' : 'from the cloud'})`); }
      lastError = '';
      noteServes(f.body);
      // A535: ZapTill support asked THIS till for its log (the branch server heard the cloud's doorbell for it).
      if (shape() === 'peer' && f.body.log_request) { try { logRequestBell?.(getDeviceConfig()?.device_id ?? ''); } catch { /* the 90 s beat */ } }
      if (f.body.full_resync_needed) { await fullResync('behind the change log', now); return true; }
      if (shape() === 'peer' && f.body.local !== undefined) {
        // A448: a change made on another till of the branch (no internet) reached the server: its whole copy (LAN).
        const local = String(f.body.local ?? '');
        if (local !== (getKv(K.local) ?? '')) { if (await liveWholePull(false)) setKv(K.local, local); }
      }
      applied += handle(f.body, f.bytes, now);
      since = Math.max(since, Number(f.body.last_seq) || since);
      setKv(K.seq, String(since));
      if (!f.body.more) break;
    }
    return applied > 0;
  } catch (e: any) {
    lastError = e?.message ?? String(e);
    return false;
  }
}

/** A533: who hears the 'log_request' doorbell (logPull.ts hands it in — this module never imports it). */
let logRequestBell: ((deviceId: string) => void) | null = null;
export function setLogRequestBell(fn: ((deviceId: string) => void) | null): void { logRequestBell = fn; }

/** A535: who hears a 'drawers' ring on a branch server (branchDrawers.ts hands it in). */
let drawersBell: ((why: string) => void) | null = null;
export function setDrawersBell(fn: ((why: string) => void) | null): void { drawersBell = fn; }

/**
 * A535: ZapTill support's log requests for this server's tills, waiting to be passed on (device → when heard). Served once
 * on that till's next /node/live; kept at most PEER_BELL_KEEP_MS (the till's own 90 s beat asks anyway).
 */
export const PEER_BELL_KEEP_MS = 10 * 60_000;
const peerBells = new Map<string, number>();
export function notePeerLogRequest(deviceId: string, now = Date.now()): void {
  if (!deviceId) return;
  if (!peerBells.has(deviceId)) logLine('node', `A535: ZapTill support asked till ${deviceId} for its log — passed on at its next check`);
  peerBells.set(deviceId, now);
}
function takePeerBell(deviceId: string | null, now: number): boolean {
  for (const [d, at] of [...peerBells]) if (now - at > PEER_BELL_KEEP_MS) peerBells.delete(d);
  if (!deviceId || !peerBells.has(deviceId)) return false;
  peerBells.delete(deviceId);
  return true;
}

// ── the push channel (direct only) ───────────────────────────────────────────────────────────────────────────────────
function closeSocket(code?: number, reason?: string): void {
  const s = socket; socket = null; socketOpen = false;
  pingSentAt = 0; reauthSentAt = 0; reauthToken = '';
  try { if (code) s?.close(code, reason); else s?.close(); } catch { /* gone */ }
}
function sendOnSocket(msg: unknown): boolean {
  try { socket?.send(JSON.stringify(msg)); return true; } catch { return false; }
}

/**
 * A554: a planned reconnect — closed by the till itself (a normal close, so no "push channel closed" line and no fallback
 * polling) and opened again at once with the current token. The cloud's `ready` asks nothing unless the log moved.
 */
function renewSocket(now: number, why: string): void {
  logLine('sync', `A554: push channel signed in again (${why})`);
  closeSocket(1000, 'renewed');
  socketRetryAt = 0;
  openSocket(now);
}

/**
 * A554: run every few seconds while the push channel is open — the renewed token and the keepalive. Returns what it did
 * (the tests). Never throws.
 */
export function socketKeepalive(now = Date.now()): 'none' | 'ping' | 'dead' | 'reauth' | 'renew' {
  if (!socket || !socketOpen) return 'none';
  let target: { url: string; token: string } | null = null;
  try { target = liveSocketTarget(); } catch { target = null; }
  // The till renewed its token since this socket signed in: the cloud would end the socket when the old one runs out.
  if (target?.token && target.token !== socketToken) {
    if (!socketFeatures.has('reauth')) { renewSocket(now, 'the POS renewed its sign-in'); return 'renew'; }
    if (reauthToken !== target.token) {
      reauthToken = target.token; reauthSentAt = now;
      if (!sendOnSocket({ type: 'reauth', token: target.token })) { renewSocket(now, 'the renewed sign-in could not be sent'); return 'renew'; }
      return 'reauth';
    }
    if (now - reauthSentAt >= REAUTH_WAIT_MS) { renewSocket(now, 'the cloud did not confirm the renewed sign-in'); return 'renew'; }
  }
  if (!socketFeatures.has('ping')) return 'none';
  if (pingSentAt && now - pingSentAt >= PONG_WAIT_MS) {
    logLine('sync', `A554: the push channel did not answer for ${Math.round((now - pingSentAt) / 1000)} s — reconnecting now`);
    closeSocket(); socketRetryAt = 0;
    openSocket(now);
    return 'dead';
  }
  if (!pingSentAt && now - lastHeardAt >= KEEPALIVE_MS) {
    if (sendOnSocket({ type: 'ping' })) { pingSentAt = now; return 'ping'; }
  }
  return 'none';
}
function openSocket(now: number): void {
  if (socket || now < socketRetryAt || shape() !== 'direct' || mode === 'legacy') return;
  const WS = (globalThis as any).WebSocket;
  const target = liveSocketTarget();
  if (!WS || !target) return;
  let s: any;
  try { s = new WS(target.url); } catch { socketRetryAt = now + BACKOFF[Math.min(socketTries++, BACKOFF.length - 1)]; return; }
  socket = s;
  socketToken = target.token;   // A554: what this socket signs in with
  s.onopen = () => { try { s.send(JSON.stringify({ type: 'hello', token: target.token })); } catch { /* close follows */ } };
  s.onmessage = (ev: any) => {
    if (socket !== s) return;   // A554: a socket this till already replaced
    let m: any = null;
    try { m = JSON.parse(String(ev?.data ?? '')); } catch { return; }
    lastHeardAt = Date.now(); pingSentAt = 0;   // A554: any message — the line is alive
    if (m?.type === 'pong') return;
    if (m?.type === 'reauthed') {
      // A554: the cloud took the renewed token on this socket (its expiry moved with it).
      if (reauthToken) socketToken = reauthToken;
      reauthToken = ''; reauthSentAt = 0;
      return;
    }
    if (m?.type === 'ready') {
      socketOpen = true; socketTries = 0; socketSince = Date.now(); fallbackEvery = 0;
      socketFeatures = new Set(Array.isArray(m.features) ? m.features.map(String) : []);   // A554
      pingSentAt = 0; reauthToken = ''; reauthSentAt = 0;
      logLine('sync', 'A531: the cloud will ring when something changes (push channel open)');
      // Only when the log moved past what this till applied (a reconnect after a token renewal asks nothing).
      const held = getKv(K.seq);
      if (held === null || Number(m.last_seq) > Number(held)) void catchUp('connected');
    } else if (m?.type === 'changed') {
      lastRingAt = Date.now();   // A542
      // A535: a drawer changed on the web — a branch server asks the cloud about its branch's drawers at once
      // (branchDrawers.ts); nothing in the change log moved for it, so a ring for drawers ALONE asks no /changes.
      const topics: string[] = Array.isArray(m.topics) ? m.topics.map(String) : [];
      if (topics.includes(DRAWERS_TOPIC)) { try { if (isServer()) drawersBell?.('the cloud rang (drawers)'); } catch { /* the beat */ } }
      if (!(topics.length && topics.every((t) => t === DRAWERS_TOPIC))) void catchUp('the cloud rang');
    } else if (m?.type === 'log_request') {
      // A533: ZapTill support asked a device of this business for its log — a doorbell: the till named asks for the
      // request itself (logPull.ts, an authenticated GET); any other ignores it.
      const dev = String(m.device_id ?? '');
      try { logRequestBell?.(dev); } catch { /* the 90 s beat asks anyway */ }
      // A535: on a branch server, a request for one of ITS tills is passed on — that till hears it on its next /node/live
      // (20 s, the shop network) and asks for the request itself through the gateway, as before.
      if (isServer() && dev && dev !== (getDeviceConfig()?.device_id ?? '')) notePeerLogRequest(dev);
    }
  };
  s.onclose = (ev: any) => {
    if (socket !== s) return;
    socket = null;
    const was = socketOpen; socketOpen = false;
    const code = Number(ev?.code ?? 0);
    if (code === 4001) {
      // Its sign-in ended (renewed, or the till's standing changed): renew and come straight back.
      socketRetryAt = Date.now() + 1_000;
      void refreshAccessToken().catch(() => false);
    } else {
      socketRetryAt = Date.now() + BACKOFF[Math.min(socketTries++, BACKOFF.length - 1)];
    }
    if (was) logLine('sync', `A531: push channel closed (${code || 'no code'}) — checking every ${openDrawers() ? '20 s' : '5 minutes'} until it is back`);
  };
  s.onerror = () => { /* onclose follows */ };
}

// ── the beat ─────────────────────────────────────────────────────────────────────────────────────────────────────────
export async function liveTick(now = Date.now()): Promise<void> {
  const cfg = getDeviceConfig();
  if (!cfg?.device_id) return;
  if (mode === 'legacy') { if (now >= legacyUntil) { mode = 'unknown'; } else return; }
  if (mode === 'unknown') { await catchUp('start'); if (!liveActive()) return; }

  // A shift opened or closed here (on a server: in the branch) — a moment to apply what waits.
  const drawers = openDrawers();
  const shiftEvent = lastDrawers >= 0 && drawers !== lastDrawers;
  lastDrawers = drawers;
  applyWaitingIfDue(now, { shiftEvent });

  if (mode === 'peer') {
    if (now - lastPollAt >= PEER_POLL_MS) await catchUp('the branch server');
  } else {
    openSocket(now);
    if (!socketOpen) {
      const every = drawers > 0 || recentlyTrading(now) ? BUSY_POLL_MS : SOCKET_DOWN_POLL_MS;
      fallbackEvery = every;   // A542: shown on the Tech page
      if (now - lastPollAt >= every) await catchUp('no push channel');
    }
  }

  // Safety: the whole catalogue once a day — never mid-sale; not again within the hour after a failed try.
  const fullAt = Date.parse(getKv(K.full) ?? '') || 0;
  if (now - fullAt >= DAILY_FULL_MS && now - lastFullTry >= 3_600_000 && !midSale()) await fullResync('daily safety pull', now);

  // Stock levels (other tills' sales move them): every 30 minutes, when stock is tracked — A535: only when they do not
  // arrive as changes (a cloud before migration 153, or a branch server that does not pass them on).
  const stockAt = Number(getKv(K.stock) ?? 0) || 0;
  if (now - stockAt >= STOCK_REFRESH_MS && !midSale() && tracksStock() && !stockTravelsOnChange()) {
    setKv(K.stock, String(now));
    if (mode === 'peer') await liveWholePull(false);   // the branch server's copy carries its levels (LAN)
    else await refreshStockLevels();
  }
  if (isServer()) pruneLiveLog(now);
}
function tracksStock(): boolean {
  try { return !!getLocalDb().prepare(`SELECT 1 FROM products WHERE track_stock = 1 AND status = 'active' LIMIT 1`).get(); } catch { return false; }
}

/** At start-up: true when the change log answered (the catalogue is current); false = take it the old way. */
export async function startupCatalogue(): Promise<boolean> {
  await catchUp('start-up');
  return liveActive();
}

export function startLiveSync(): void {
  if (started) return;
  started = true;
  // syncAll's catalogue step: nothing to ask while the push channel is open (the cloud rings when something changes).
  setLiveCatalogue({ active: liveActive, catchUp: (why) => (socketOpen ? Promise.resolve(false) : catchUp(why)) });
  // The staff list: a change arrives as its own row; the whole list only every 30 minutes, from the server on a peer.
  setRosterLive({ quiet: liveActive, preferNode: () => mode === 'peer' });
  timer = setInterval(() => { void liveTick().catch(() => { /* next beat */ }); }, TICK_MS);
  timer.unref?.();
  // A554: the push channel's keepalive and the renewed token (a few seconds' look; sends nothing while all is well).
  keepTimer = setInterval(() => { try { socketKeepalive(); } catch { /* the next look */ } }, KEEPALIVE_CHECK_MS);
  keepTimer.unref?.();
  void liveTick().catch(() => { /* next beat */ });
}
export function stopLiveSync(): void {
  if (timer) clearInterval(timer);
  if (keepTimer) clearInterval(keepTimer);   // A554
  timer = null; keepTimer = null; started = false; closeSocket();
  setLiveCatalogue(null); setRosterLive(null);
}

/** The Tech page: each topic's last change applied, what waits, the channel. */
export function liveStatus(): {
  mode: LiveMode; channel: 'push' | 'polling' | 'branch server' | 'off'; seq: number | null; lastFullAt: string | null;
  waiting: number; topics: Array<{ topic: string; seq: number | null; at: string | null; rows: number; bytes: number }>; error: string | null;
  /** A542: the push line at a glance — open since when, the cloud's last ring, and (while it is down) how often this
   *  machine checks instead and when it tries the line again. Null fields: not known / not applicable. */
  push: { since: string | null; lastRingAt: string | null; fallbackEveryS: number | null; retryAt: string | null };
} {
  const t = json<Record<string, TopicState>>(K.topics, {});
  const seq = getKv(K.seq);
  const iso = (ms: number) => (ms ? new Date(ms).toISOString() : null);
  const down = mode === 'direct' && !socketOpen;
  return {
    push: {
      since: socketOpen ? iso(socketSince) : null,
      lastRingAt: iso(lastRingAt),
      fallbackEveryS: down && fallbackEvery ? Math.round(fallbackEvery / 1000) : null,
      retryAt: down && socketRetryAt > Date.now() ? iso(socketRetryAt) : null,
    },
    mode,
    channel: mode === 'peer' ? 'branch server' : mode === 'direct' ? (socketOpen ? 'push' : 'polling') : 'off',
    seq: seq === null ? null : Number(seq),
    lastFullAt: getKv(K.full),
    waiting: json<Pending[]>(K.pending, []).length,
    topics: SYNC_TOPICS.map((topic) => ({ topic, seq: t[topic]?.seq ?? null, at: t[topic]?.at ?? null, rows: t[topic]?.rows ?? 0, bytes: t[topic]?.bytes ?? 0 })),
    error: lastError || null,
  };
}

// ── the branch server's side: its log, served to its tills (/node/live) ──────────────────────────────────────────────
function appendLiveLog(entries: ChangeEntry[]): void {
  try {
    const db = getLocalDb();
    const ins = db.prepare(`INSERT INTO live_log (cloud_seq, topic, table_name, row_id, op, row, at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const at = new Date().toISOString();
    db.transaction(() => {
      for (const e of entries) {
        let row: any = e.row ?? null;
        // A staff row is kept without its PIN hash: the hash is served from branch_staff (wrapped there), to a proven till.
        if (e.table === 'staff' && row && typeof row === 'object' && row.roster) row = { ...row, roster: { ...row.roster, pin_hash: null } };
        ins.run(e.seq, e.topic, e.table, e.id, e.op, row === null ? null : JSON.stringify(row), at);
      }
    })();
  } catch (err: any) { logLine('node', `A531: could not log a change for the tills: ${err?.message ?? err}`); }
}
function maxLseq(): number {
  try { return Number((getLocalDb().prepare(`SELECT COALESCE(MAX(lseq), 0) AS m FROM live_log`).get() as { m: number }).m) || 0; } catch { return 0; }
}
/** After the server took the whole catalogue: its tills further back than this take the server's whole copy too. */
function markLiveLogResync(): void {
  try {
    const db = getLocalDb();
    const r = db.prepare(`INSERT INTO live_log (cloud_seq, topic, table_name, row_id, op, row, at) VALUES (0, 'setup', 'resync', '*', 'upsert', NULL, ?)`).run(new Date().toISOString());
    setKv(K.floor, String(Number(r.lastInsertRowid)));
  } catch { /* the next */ }
}
let prunedAt = 0;
function pruneLiveLog(now: number): void {
  if (now - prunedAt < 3_600_000) return;
  prunedAt = now;
  try {
    const db = getLocalDb();
    const cut = new Date(now - LIVE_LOG_KEEP_MS).toISOString();
    const top = Number((db.prepare(`SELECT COALESCE(MAX(lseq), 0) AS m FROM live_log WHERE at < ?`).get(cut) as { m: number }).m) || 0;
    if (!top) return;
    db.prepare(`DELETE FROM live_log WHERE lseq <= ?`).run(top);
    if (top > (Number(getKv(K.floor) ?? 0) || 0)) setKv(K.floor, String(top));
  } catch { /* the next hour */ }
}

/**
 * GET /node/live?since=<lseq> — the changes this server applied after `since`, in its order; a staff row with its PIN
 * hash from this server's list (for a proven till only — nodeServer checks). `local` = the A448 change counter.
 */
export function serveLiveLog(since: number | null, branchId: string | null, local: string | null, deviceId: string | null = null): ChangesAnswer & { local: string | null } {
  const last = maxLseq();
  // A535: what this server's cloud sends as changes (stock), and a log request for the asking till (once).
  const extra = { ...(getKv(K.serves) === '1' ? { serves: ['stock'] } : {}), ...(takePeerBell(deviceId, Date.now()) ? { log_request: true } : {}) };
  if (since === null || !Number.isFinite(since)) return { last_seq: last, changes: [], local, ...extra };
  const floor = Number(getKv(K.floor) ?? 0) || 0;
  if (since < floor) return { last_seq: last, changes: [], full_resync_needed: true, local, ...extra };
  const rows = getLocalDb().prepare(`SELECT * FROM live_log WHERE lseq > ? AND table_name <> 'resync' ORDER BY lseq LIMIT 501`).all(since) as any[];
  const more = rows.length > 500;
  const page = rows.slice(0, 500);
  const hashes = page.some((r) => r.table_name === 'staff') && branchId
    ? new Map(readBranchStaffForServe(branchId).map((s) => [s.staff_id, s.pin_hash])) : new Map<string, string | null>();
  const changes: ChangeEntry[] = page.map((r) => {
    let row: any = r.row ? JSON.parse(r.row) : undefined;
    if (r.table_name === 'staff' && row?.roster) row = { ...row, roster: { ...row.roster, pin_hash: hashes.get(String(r.row_id)) ?? null } };
    return { seq: Number(r.lseq), topic: r.topic, table: r.table_name, id: r.row_id, op: r.op, ...(row !== undefined ? { row } : {}) } as ChangeEntry;
  });
  const lastSeq = page.length ? Number(page[page.length - 1].lseq) : Math.max(since, 0);
  return { last_seq: more ? lastSeq : Math.max(lastSeq, since), changes, ...(more ? { more: true } : {}), local, ...extra };
}

/** Tests only. */
export function _resetLive(): void {
  mode = 'unknown'; legacyUntil = 0; lastPollAt = 0; lastFullTry = 0; lastDrawers = -1; inFlight = null; again = false;
  closeSocket(); socketTries = 0; socketRetryAt = 0; lastError = ''; prunedAt = 0; peerBells.clear();   // A535
  socketSince = 0; lastRingAt = 0; fallbackEvery = 0;   // A542
  socketToken = ''; socketFeatures = new Set(); lastHeardAt = 0;   // A554
  if (keepTimer) clearInterval(keepTimer); keepTimer = null;
  if (timer) clearInterval(timer); timer = null; started = false;
}
/** Tests only (A554): open the push channel now, as the beat would. */
export function _openLiveSocket(now = Date.now()): void { openSocket(now); }
