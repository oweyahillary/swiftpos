/**
 * activityTracker.ts — A508: when is this machine in use, and when may it install its update on its own?
 *
 * Owner, 2026-10-16: "some clients take forever to update unless am there we need to find a way of silently updating
 * tills and server" — and, on a fixed 02:00–05:00 window: "can the till or server check if its in use track usage because
 * sometimes the establishment might never be in 24hrs operation or that 2-5 its in use".
 *
 * Before: an approved update (A348/A493) downloaded in the background and installed only when ZapTill was CLOSED
 * (autoInstallOnAppQuit). A till left open for days, and a branch server (never closed: server mode, A427), never
 * installed — somebody had to be there to close it.
 *
 * Now, three things, each small:
 *   1. Activity — the last time somebody used this machine: the screen (a throttled `activity:ping` from the renderer on
 *      a key, a click or a touch — at most one every 30 s), and the main-process events that mean trading (a sale, a
 *      payment, a print queued, a bill held, a drawer opened or closed). On a branch server also its tills: a till
 *      pushing rows to /node/sync, or sending a sale / close / edit to the cloud through the gateway (a till's background
 *      polls — catalogue, update question, token renewal — are NOT use: tills left open all night would keep the server
 *      "busy" for ever). Plus BUSY: the renderer says a cart has items or the payment screen is open; main knows a print
 *      is still queued. Kept in memory only — a restart is a fresh start.
 *   2. The usage profile — this machine's sales (a server: every branch sale it holds) over the last 28 days, counted per
 *      hour of the week (168 buckets, local time). The quietest 25% of those hours are the "quiet hours". A shop that is
 *      never open 02:00–05:00 gets its night; a 24-hour one gets its slowest hours; with under 7 days of sales,
 *      01:00–05:00 is taken as quiet.
 *   3. The verdict (installVerdict, pure) — see its comment. Checked every minute by autoUpdate.ts, which runs the install.
 */
import { getLocalDb } from './localDb';

// ── 1. Activity ──────────────────────────────────────────────────────────────────────────────────────────────────────

export type ActivityKind = 'input' | 'sale' | 'payment' | 'print' | 'held' | 'shift' | 'till-sync' | 'till-cloud';

/** A508: the renderer sends an input ping at most this often (and main takes at most one this often). */
export const PING_THROTTLE_MS = 30_000;

// The screen or a trading event on this machine. Starts at launch: a machine that has just started counts as in use, so
// it never installs the moment it comes up (somebody may have just opened it).
let lastUse = Date.now();
let lastUseWhat: ActivityKind | null = null;
let lastTill = 0;              // a branch server: one of its tills trading
let lastInputPing = 0;         // the throttle on the renderer's input pings
let pingsTaken = 0;
const rendererBusy: { cart: boolean; payment: boolean } = { cart: false, payment: false };
let printPending: (() => number) | null = null;

/** One event that means "somebody is using this machine (or, on a server, the branch)". Never throws. */
export function noteActivity(kind: ActivityKind, now = Date.now()): void {
  if (kind === 'till-sync' || kind === 'till-cloud') { lastTill = Math.max(lastTill, now); return; }
  if (now >= lastUse) { lastUse = now; lastUseWhat = kind; }
}

/**
 * The renderer's `activity:ping` (ipcRenderer.send — fire and forget). `{ input: true }` is a key, a click or a touch
 * (throttled: one in PING_THROTTLE_MS is taken, the rest ignored); `{ busy: { cart, payment } }` is the sale screen's
 * state, taken every time it changes. Anything else is ignored. Returns whether an input ping was taken (tests).
 */
export function noteRendererPing(payload: unknown, now = Date.now()): boolean {
  const p = (payload && typeof payload === 'object') ? payload as { input?: unknown; busy?: unknown } : {};
  if (p.busy && typeof p.busy === 'object') {
    const b = p.busy as { cart?: unknown; payment?: unknown };
    if (typeof b.cart === 'boolean') rendererBusy.cart = b.cart;
    if (typeof b.payment === 'boolean') rendererBusy.payment = b.payment;
    noteActivity('input', now);   // the cashier changed the cart: somebody is there
  }
  if (p.input !== true) return false;
  if (lastInputPing && now - lastInputPing < PING_THROTTLE_MS) return false;
  lastInputPing = now;
  pingsTaken++;
  noteActivity('input', now);
  return true;
}

/**
 * A branch server: a till's request through the gateway (/node/cloud/…). Only a till TRADING counts — a request that
 * writes (POST/PUT/PATCH/DELETE: a sale, a close, an edit). Reads and the background traffic every open till makes all
 * night (the catalogue poll, a token renewal, the update question and its download) do not: a till left on overnight
 * would otherwise keep its server from ever installing. Returns whether it counted (tests).
 */
export function noteGatewayCall(method: string | undefined, url: string | undefined, now = Date.now()): boolean {
  const m = String(method ?? 'GET').toUpperCase();
  const u = String(url ?? '');
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return false;
  if (/\/api\/(auth\/refresh|desktop-update\/|devices?\/(heartbeat|ping))/i.test(u)) return false;
  noteActivity('till-cloud', now);
  return true;
}

/** A branch server: a till pushed rows to /node/sync — counted only when it carried rows (an empty pass is a poll). */
export function noteTillSync(tables: unknown, now = Date.now()): boolean {
  if (!tables || typeof tables !== 'object') return false;
  const rows = Object.values(tables as Record<string, unknown>).reduce<number>((n, r) => n + (Array.isArray(r) ? r.length : 0), 0);
  if (rows <= 0) return false;
  noteActivity('till-sync', now);
  return true;
}

/** The print queue's "jobs still waiting" (printService / printWorker register theirs). */
export function setPrintPendingProbe(probe: () => number): void {
  const prev = printPending;
  printPending = prev ? () => (safeCount(prev) + safeCount(probe)) : probe;
}
function safeCount(f: () => number): number { try { return Math.max(0, Number(f()) || 0); } catch { return 0; } }

export interface ActivitySnapshot {
  /** The last use of this machine (ms), 0 = none since start. */
  lastUse: number;
  lastUseWhat: ActivityKind | null;
  /** A branch server: the last time one of its tills traded (ms), 0 = none since start. */
  lastTill: number;
  /** Why the machine is busy right now (one plain phrase), or null. */
  busy: string | null;
}
export function activitySnapshot(): ActivitySnapshot {
  const prints = printPending ? safeCount(printPending) : 0;
  const busy = rendererBusy.payment ? 'the payment screen is open'
    : rendererBusy.cart ? 'a sale is in the cart'
    : prints > 0 ? `${prints} print job${prints === 1 ? ' is' : 's are'} still queued`
    : null;
  return { lastUse, lastUseWhat, lastTill, busy };
}

/** Tests only. */
export function _resetActivity(startedAt = 0): void {
  lastUse = startedAt; lastUseWhat = null; lastTill = 0; lastInputPing = 0; pingsTaken = 0;
  rendererBusy.cart = false; rendererBusy.payment = false; printPending = null;
}
export function _pingsTaken(): number { return pingsTaken; }

// ── 2. The usage profile ─────────────────────────────────────────────────────────────────────────────────────────────

export const PROFILE_DAYS = 28;
export const PROFILE_MIN_DAYS = 7;
export const QUIET_SHARE = 0.25;
/** A508: with under PROFILE_MIN_DAYS of sales, these local hours are quiet (01:00–05:00). */
export const FALLBACK_QUIET_HOURS = [1, 2, 3, 4];

/** Hour of the week in LOCAL time: Sunday 00:00 = 0 … Saturday 23:00 = 167. */
export function hourOfWeek(at: Date | number): number {
  const d = typeof at === 'number' ? new Date(at) : at;
  return d.getDay() * 24 + d.getHours();
}

export interface UsageProfile {
  /** Sales per hour of the week (168). */
  buckets: number[];
  /** Quiet hours of the week (168). */
  quiet: boolean[];
  /** Days between the oldest sale counted and now. */
  days: number;
  /** True when there were under PROFILE_MIN_DAYS of sales and 01:00–05:00 was taken instead. */
  fallback: boolean;
}

/**
 * A508: the quiet hours from sale times (ms). Pure. Counts the sales of the last PROFILE_DAYS per hour of the week; the
 * quiet hours are the QUIET_SHARE (42 of 168) with the fewest sales. Ties go to the EARLIER hour of the day first, then
 * the earlier day — a shop shut every night has many hours at 0, and taking them Sunday-first would make Sunday and
 * Monday nights quiet and Friday's not; by the hour, it is the same early-morning hours every night.
 */
export function usageProfile(saleTimes: number[], now: number): UsageProfile {
  const buckets = new Array<number>(168).fill(0);
  const from = now - PROFILE_DAYS * 86_400_000;
  let oldest = Infinity;
  for (const t of saleTimes) {
    if (!Number.isFinite(t) || t < from || t > now) continue;
    buckets[hourOfWeek(t)]++;
    if (t < oldest) oldest = t;
  }
  const days = Number.isFinite(oldest) ? (now - oldest) / 86_400_000 : 0;
  const quiet = new Array<boolean>(168).fill(false);
  if (days < PROFILE_MIN_DAYS) {
    for (let day = 0; day < 7; day++) for (const h of FALLBACK_QUIET_HOURS) quiet[day * 24 + h] = true;
    return { buckets, quiet, days, fallback: true };
  }
  const order = buckets.map((n, i) => ({ n, i, hour: i % 24, day: Math.floor(i / 24) }))
    .sort((a, b) => a.n - b.n || a.hour - b.hour || a.day - b.day);
  const take = Math.round(168 * QUIET_SHARE);
  for (const b of order.slice(0, take)) quiet[b.i] = true;
  return { buckets, quiet, days, fallback: false };
}

/**
 * The profile from this machine's own database: a till counts its own sales (device_id), a branch server every sale it
 * holds (the branch's). Read at most once an hour (cached). Never throws: no table, no rows → the fallback night.
 */
let cached: { at: number; key: string; profile: UsageProfile } | null = null;
export function loadUsageProfile(o: { server: boolean; deviceId: string | null }, now = Date.now()): UsageProfile {
  const key = `${o.server ? 'server' : 'till'}:${o.deviceId ?? ''}`;
  if (cached && cached.key === key && now - cached.at < 60 * 60_000 && now >= cached.at) return cached.profile;
  let times: number[] = [];
  try {
    const since = new Date(now - PROFILE_DAYS * 86_400_000).toISOString();
    const rows = (o.server
      ? getLocalDb().prepare(`SELECT created_at FROM orders WHERE created_at >= ?`).all(since)
      : getLocalDb().prepare(`SELECT created_at FROM orders WHERE created_at >= ? AND (device_id = ? OR device_id IS NULL)`).all(since, o.deviceId ?? '')
    ) as Array<{ created_at: string }>;
    times = rows.map((r) => Date.parse(r.created_at)).filter((t) => Number.isFinite(t));
  } catch { times = []; }
  const profile = usageProfile(times, now);
  cached = { at: now, key, profile };
  return profile;
}
export function _resetProfileCache(): void { cached = null; }

// ── 3. The verdict ───────────────────────────────────────────────────────────────────────────────────────────────────

/** Idle at least this long, in a quiet hour → install. */
export const IDLE_QUIET_MS = 20 * 60_000;
/** Idle at least this long → install, quiet hour or not. */
export const IDLE_LONG_MS = 90 * 60_000;
/** A download older than this (a shop never quiet long enough) → a quiet hour and IDLE_STALE_MS suffice. */
export const STALE_DOWNLOAD_MS = 72 * 60 * 60_000;
export const IDLE_STALE_MS = 10 * 60_000;
/** A sync push in flight for less than this → wait for it (longer: presumed hung on the network; the flush caps it). */
export const SYNC_GRACE_MS = 2 * 60_000;

export interface InstallState {
  /** The version this machine runs. */
  running: string;
  /** The version downloaded and ready to install (null: none). */
  downloaded: string | null;
  /** A503: the cloud still approves it (a roll-back or a hold → false: never installed). */
  approved: boolean;
  /** When it was first downloaded (ms) — kept across restarts. */
  downloadedAt: number | null;
  /** A496: a branch server has the branch's copy of it ready for its tills (a till: true). */
  shareReady: boolean;
  /** Windows would stop a silent install (an administrator's permission it cannot get) — one phrase, or null. */
  blocker: string | null;
  /** activitySnapshot().busy. */
  busy: string | null;
  /** The last use of this machine (ms) — a server also counts its tills (pass the later of the two). */
  lastActivity: number;
  /** A branch server: the last time a till traded (for the reason only; already in lastActivity). */
  lastTill?: number;
  /** This hour is one of the machine's quiet hours. */
  quietNow: boolean;
  /** A sync push in flight since (ms), or null. */
  syncSince: number | null;
}

const VERSION_RE = /^(\d{1,4})\.(\d{1,4})\.(\d{1,4})$/;
function newer(a: string, b: string): boolean {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] > pb[i];
  return false;
}
const mins = (ms: number) => Math.floor(ms / 60_000);

/**
 * A508: may the downloaded update install NOW, with nobody there? Pure. In this order:
 *   - a downloaded, newer version that the cloud STILL approves (A503) — and, on a branch server, the branch's copy ready
 *     for its tills (A496), so the server never leaves its tills without the update it is installing;
 *   - Windows can install it without asking anybody (blocker null — see silentInstallBlocker in autoUpdate.ts);
 *   - not busy (a cart, the payment screen, a print queued), no sync push just started;
 *   - idle (no input, no sale, no print; a server: no till trading either) at least 20 min in a quiet hour, or at least
 *     90 min at any hour; a download older than 72 h (a shop never quiet that long): a quiet hour and 10 min idle.
 */
export function installVerdict(s: InstallState, now: number): { install: boolean; reason: string } {
  const no = (reason: string) => ({ install: false, reason });
  const v = s.downloaded;
  if (!v || !VERSION_RE.test(v)) return no('no update downloaded');
  if (!VERSION_RE.test(s.running) || !newer(v, s.running)) return no(`${v} is not newer than ${s.running}`);
  if (!s.approved) return no(`${v} is no longer approved — it will not be installed`);
  if (!s.shareReady) return no(`waiting: the branch's copy of ${v} for the tills is not ready yet`);
  if (s.blocker) return no(`${v} cannot install on its own: ${s.blocker} — it installs when ZapTill is closed`);
  if (s.busy) return no(`waiting: ${s.busy}`);
  if (s.syncSince !== null && now - s.syncSince >= 0 && now - s.syncSince < SYNC_GRACE_MS) return no('waiting: a sync push is under way');
  const idle = Math.max(0, now - s.lastActivity);
  const stale = s.downloadedAt !== null && now - s.downloadedAt >= STALE_DOWNLOAD_MS;
  const what = s.lastTill && s.lastTill >= s.lastActivity ? ' (a till was trading)' : '';
  if (s.quietNow && idle >= IDLE_QUIET_MS) return { install: true, reason: `idle ${mins(idle)} min in a quiet hour` };
  if (idle >= IDLE_LONG_MS) return { install: true, reason: `idle ${mins(idle)} min` };
  if (stale && s.quietNow && idle >= IDLE_STALE_MS) {
    return { install: true, reason: `downloaded ${Math.floor((now - (s.downloadedAt ?? now)) / 3_600_000)} h ago and idle ${mins(idle)} min in a quiet hour` };
  }
  return no(`waiting: in use ${mins(idle)} min ago${what} — installs after ${s.quietNow ? mins(stale ? IDLE_STALE_MS : IDLE_QUIET_MS) : mins(IDLE_LONG_MS)} min idle${s.quietNow ? '' : ' (or 20 min in a quiet hour)'}`);
}

// ── Kept across restarts: when a version was first downloaded (the 72-h fallback) ────────────────────────────────────

const DOWNLOADED_KEY = 'update_downloaded_at';
/** When `version` was first seen downloaded on this machine (ms); records now if it is new. Null on a database error. */
export function downloadedSince(version: string, now = Date.now()): number | null {
  try {
    const db = getLocalDb();
    const row = db.prepare(`SELECT value FROM maintenance_state WHERE key = ?`).get(DOWNLOADED_KEY) as { value?: string } | undefined;
    const kept = row?.value ? JSON.parse(row.value) as { version?: string; at?: number } : null;
    if (kept?.version === version && Number.isFinite(kept.at)) return Number(kept.at);
    db.prepare(`INSERT OR REPLACE INTO maintenance_state (key, value, updated_at) VALUES (?, ?, ?)`)
      .run(DOWNLOADED_KEY, JSON.stringify({ version, at: now }), new Date(now).toISOString());
    return now;
  } catch { return null; }
}
