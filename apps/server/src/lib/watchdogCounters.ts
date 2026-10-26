/**
 * watchdogCounters.ts — A383: what the watchdog cannot read from the database, counted in this process.
 *
 * Server errors (5xx, for the "burst" alert), failed sign-ins and the till writes the write guard flags (A159) — for the
 * morning digest. In memory: a deploy or restart starts the counts again (the digest says "since" when). One Render
 * instance (render.yaml), so one process sees every request.
 */

const KEEP_MS = 60 * 60_000;
const MAX_ERRORS = 2000;

const errorTimes: number[] = [];
const errorPaths: string[] = [];
let since = new Date().toISOString();
let serverErrors = 0;
let failedSignIns = 0;
let writeGuard = 0;

/** A response went out with a 5xx. */
export function recordServerError(path: string, at = Date.now()): void {
  serverErrors++;
  errorTimes.push(at);
  errorPaths.push(path.split('?')[0]);
  const cut = at - KEEP_MS;
  while (errorTimes.length && (errorTimes[0] < cut || errorTimes.length > MAX_ERRORS)) { errorTimes.shift(); errorPaths.shift(); }
}

// ── A392: who keeps failing to sign in — per account and per address, the last SIGNIN_KEEP_MS ────────────────────────
const SIGNIN_KEEP_MS = 30 * 60_000;
export interface SignInFailure { at: number; account: string; ip: string; where: 'admin' | 'dashboard' | 'web_pos' | 'till' }
const signInFailures: SignInFailure[] = [];

/** Which screen a sign-in route belongs to. */
export function signInWhere(path: string): SignInFailure['where'] {
  const p = path.split('?')[0];
  if (p.startsWith('/api/admin/')) return 'admin';
  if (/\/auth\/login\/?$/.test(p)) return 'dashboard';
  if (/\/auth\/pos-login\/?$/.test(p)) return 'web_pos';
  return 'till';
}

/** A sign-in (password, PIN or one-time code) was refused. */
export function recordFailedSignIn(meta?: { path?: string; account?: string; ip?: string }, at = Date.now()): void {
  failedSignIns++;
  if (!meta) return;
  signInFailures.push({
    at, where: signInWhere(meta.path ?? ''),
    account: String(meta.account ?? '').trim().toLowerCase().slice(0, 120), ip: String(meta.ip ?? '').slice(0, 64),
  });
  const cut = at - SIGNIN_KEEP_MS;
  while (signInFailures.length && (signInFailures[0].at < cut || signInFailures.length > 5000)) signInFailures.shift();
}

export function recentSignInFailures(): SignInFailure[] { return [...signInFailures]; }

// ── A392: tills whose sync the cloud refuses — per till, the last SYNC_KEEP_MS ──────────────────────────────────────
const SYNC_KEEP_MS = 3 * 60 * 60_000;
export interface SyncAttempt { at: number; deviceId: string; businessId: string | null; ok: boolean; status: number;
  code?: string | null; error?: string | null; rejected?: number }
const syncAttempts = new Map<string, SyncAttempt[]>();

/** One push from a till (/api/sync/push, /api/orders): what the cloud answered. */
export function recordSyncAttempt(a: Omit<SyncAttempt, 'at'>, at = Date.now()): void {
  if (!a.deviceId) return;
  const id = a.deviceId.split(',')[0].trim().slice(0, 64);
  const list = syncAttempts.get(id) ?? [];
  list.push({ ...a, deviceId: id, at, error: a.error ? String(a.error).slice(0, 300) : null });
  const cut = at - SYNC_KEEP_MS;
  while (list.length && (list[0].at < cut || list.length > 200)) list.shift();
  syncAttempts.set(id, list);
  if (syncAttempts.size > 5000) syncAttempts.delete(syncAttempts.keys().next().value as string);
}

export function recentSyncAttempts(): SyncAttempt[][] { return [...syncAttempts.values()].map((l) => [...l]); }

// ── A579: what each till says it still has to send (X-Sync-Pending / X-Sync-Failed on its /api/sync/push) ───────────
// From 1.0.20 a till reports its queue on every push, the idle heartbeat included. Kept here, in memory, rather than in a
// new user_devices column: the watchdog (same process) only needs the latest report, and a restart loses at most one
// heartbeat's worth (15 min) — the rule falls back to the till's version until the next report.
export interface SyncQueueReport { pending: number; failed: number; at: number; /** when `pending` last went above 0 */ pendingSince: number | null }
const queueReports = new Map<string, SyncQueueReport>();

/** A header value as a count (0 … 1 000 000), or null when absent / not a number. */
export function parseQueueCount(v: unknown): number | null {
  const s = String(Array.isArray(v) ? v[0] : (v ?? '')).split(',')[0].trim();
  if (!/^\d{1,7}$/.test(s)) return null;
  const n = Number(s);
  return n <= 1_000_000 ? n : null;
}

/** A till's push carried its queue. Nothing is recorded without a pending count. */
export function recordSyncQueue(deviceId: string, pending: number | null, failed: number | null, at = Date.now()): void {
  const id = String(deviceId ?? '').split(',')[0].trim().slice(0, 64);
  if (!id || pending === null) return;
  const prev = queueReports.get(id);
  const pendingSince = pending > 0 ? (prev && prev.pending > 0 && prev.pendingSince ? prev.pendingSince : at) : null;
  queueReports.set(id, { pending, failed: failed ?? 0, at, pendingSince });
  if (queueReports.size > 5000) queueReports.delete(queueReports.keys().next().value as string);
}

/** The latest queue report per till device id. */
export function syncQueueReports(): Record<string, SyncQueueReport> {
  return Object.fromEntries([...queueReports].map(([k, v]) => [k, { ...v }]));
}

// ── A589: how long the answers take — the overload signal (p95 over the window since the last watchdog run) ─────────
// A ring of the last MAX_DURATIONS answers (time, ms), in memory. Cheap: one number per request, no database.
const MAX_DURATIONS = 5000;
const DURATION_KEEP_MS = 15 * 60_000;
const durations: Array<{ at: number; ms: number }> = [];

/** A request was answered after `ms` (streams and downloads are left out by the caller). */
export function recordRequestDuration(ms: number, at = Date.now()): void {
  if (!Number.isFinite(ms) || ms < 0) return;
  durations.push({ at, ms });
  const cut = at - DURATION_KEEP_MS;
  while (durations.length && (durations[0].at < cut || durations.length > MAX_DURATIONS)) durations.shift();
}

/** The answers in the last `windowMin` minutes: how many, and the 95th-percentile time (null with none). */
export function requestLoad(windowMin = 10, now = Date.now()): { requests: number; p95Ms: number | null } {
  const since = now - windowMin * 60_000;
  const list = durations.filter((d) => d.at >= since && d.at <= now).map((d) => d.ms).sort((a, b) => a - b);
  if (!list.length) return { requests: 0, p95Ms: null };
  return { requests: list.length, p95Ms: list[Math.min(list.length - 1, Math.ceil(list.length * 0.95) - 1)] };
}

/** For tests: start again. */
export function resetCounters(): void {
  durations.length = 0;
  queueReports.clear();
  signInFailures.length = 0; syncAttempts.clear(); errorTimes.length = 0; errorPaths.length = 0;
  serverErrors = 0; failedSignIns = 0; writeGuard = 0;
}

/** The write guard flagged (dry-run) or blocked (enforced) a till's write. */
export function recordWriteGuard(): void { writeGuard++; }

/** The recent 5xx times and their newest paths (newest last) — for the burst rule. */
export function recentErrors(): { times: number[]; paths: string[] } {
  return { times: [...errorTimes], paths: errorPaths.slice(-5).reverse() };
}

/** The digest's counts since the last digest; `reset` starts the next period. */
export function digestCounters(reset = false): { writeGuard: number; failedSignIns: number; serverErrors: number; since: string } {
  const out = { writeGuard, failedSignIns, serverErrors, since };
  if (reset) { writeGuard = 0; failedSignIns = 0; serverErrors = 0; since = new Date().toISOString(); }
  return out;
}

/** A392: a till's push — the routes a till syncs through (the web POS sends no device id, so it never counts). */
export function isTillSync(method: string, path: string): boolean {
  if (method !== 'POST') return false;
  const p = path.split('?')[0];
  return /^\/api\/sync\/push\/?$/.test(p) || /^\/api\/orders\/?$/.test(p);
}

/** Is this refused request a sign-in attempt? (401 on a sign-in route — wrong password, PIN or code.) */
export function isSignInFailure(method: string, path: string, status: number): boolean {
  if (status !== 401 || method !== 'POST') return false;
  const p = path.split('?')[0];
  return /^\/api\/(admin\/)?auth\/(login|pos-login|verify-pin)\/?$/.test(p) || /^\/api\/staff\/clock\/?$/.test(p);
}
