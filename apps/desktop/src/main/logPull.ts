/**
 * logPull.ts — A533: ZapTill support pulls this till's (or this branch server's) log from the admin portal.
 *
 * Owner, 2026-10-19: "add a feature where we can pull local logs of a server or a till to cloud so that we can be
 * investigating such issues" — and, on the admin portal's Desktop updates tab: "how do I pull logs". Until now (A519) a
 * log reached support only when someone at the shop pressed "Send logs to support" on the Tech page.
 *
 * How the till learns of a request (no new poll loop):
 *   - the doorbell: the cloud rings the business's push channel (A531, liveSync.ts) with { type: 'log_request',
 *     device_id }; the till named asks GET /api/support/log-requests/mine (its own session) for the request itself;
 *   - the 90 s beat the till already runs for remote closes (A521, syncEngine remoteCloseBeat) asks the same GET — a
 *     till behind a branch server holds no push channel of its own, and a till whose channel is down still hears within
 *     about 90 s. On a till behind a branch server both calls go through the server's gateway (A410), unchanged.
 *     An older cloud without the route (its 404) is not asked again for an hour.
 *
 * How it answers: A519's bundle (supportLogs.ts — the same redaction, gzip and 900 kB cap) for the request's window (24
 * hours, 3 days or 7 days) read lazily across the rolled files, auth.log only when asked, and a diagnostics block
 * (version, role, branch, sync state with what waits per table, the change-triggered sync's topics and push channel,
 * printer errors in the window, disk free). Uploaded with POST /api/support/logs + request_id — the cloud links it and
 * marks the request delivered. One upload at a time (single-flight); a failing upload is tried at most MAX_TRIES times
 * in this run, then left (the request stays waiting — the next start tries again). A closed request (cancelled,
 * expired, another till's: 403 / 404 / 409) is never tried again. The shop's own log says it happened: "logs pulled by
 * ZapTill support (request …)".
 */
import os from 'os';
import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import { getLocalDb } from './localDb';
import { getDeviceConfig, isNodeRole } from './deviceConfig';
import { logLine, getLogPath, getAuthLogPath, KEEP_FILES, AUTH_KEEP_FILES } from './logFile';
import { liveCloudGet, liveCloudPost, getSyncStatus, setLogPullBeat } from './syncEngine';
import { liveStatus, setLogRequestBell } from './liveSync';
import { lastStartupLine } from './lowImpactStart';
import { channelHealth } from './nodeHealth';
import {
  buildSupportText, packSupportText, lazyLogFiles, rolledPaths, rangeLabel, syncSummary, sendVerdict, type SupportHeader,
} from './supportLogs';

export const MAX_TRIES = 3;
/** A pull reads further back than the Tech page's button (2 MB): 3 MB of log text — under the cloud's 4 MB unpack limit. */
export const PULL_LOG_CAP_BYTES = 3 * 1024 * 1024;
export const NOT_SERVED_WAIT_MS = 60 * 60_000;
const RANGES = new Set([24, 72, 168]);

export interface LogRequest { id: string; range_hours: number; include?: { auth?: boolean } | null; requested_at?: string | null }

const tries = new Map<string, number>();
const closed = new Set<string>();
let running: Promise<number> | null = null;
let again = false;
let notServedUntil = 0;
let started = false;

/** The bundle's header — as the Tech page's (ipcHandlers supportText), "sent by" ZapTill support. */
function header(r: LogRequest): SupportHeader {
  const cfg = getDeviceConfig();
  let sess: any = null; let branch: string | null = null;
  try { sess = getLocalDb().prepare(`SELECT business_id, business_name FROM session WHERE id=1`).get(); } catch { sess = null; }
  try { branch = (getLocalDb().prepare(`SELECT name FROM branches WHERE id = ?`).get(cfg?.branch_id ?? '') as any)?.name ?? null; } catch { branch = null; }
  return {
    business: sess?.business_name ?? null, businessId: sess?.business_id ?? null, branch, branchId: cfg?.branch_id ?? null,
    terminal: cfg?.terminal_code ?? null, deviceId: cfg?.device_id ?? null, deviceName: cfg?.device_name ?? null,
    role: cfg?.device_role ?? 'till', version: app.getVersion(),
    os: `${os.platform()} ${os.release()} ${os.arch()}`,
    ramGb: Math.round(os.totalmem() / 1024 ** 3 * 10) / 10, freeGb: Math.round(os.freemem() / 1024 ** 3 * 10) / 10,
    startup: safe(() => lastStartupLine(), null),
    sync: cfg?.node_url && !isNodeRole(cfg.device_role) ? safe(() => syncSummary(channelHealth()), []) : [],
    tech: `ZapTill support — a pull from the admin portal (request ${r.id})`, at: new Date().toISOString(),
  };
}
function safe<T>(f: () => T, dflt: T): T { try { return f(); } catch { return dflt; } }

/** The diagnostics block: what support asks first, in a few lines. Exported for the tests. */
export function diagnostics(r: LogRequest): string[] {
  const cfg = getDeviceConfig();
  const lines: string[] = [];
  const range = rangeLabel(r.range_hours * 3_600_000);
  lines.push(`Request ${r.id}, asked ${r.requested_at ?? '?'} — the last ${range}${r.include?.auth ? ', with the sign-in history (auth.log)' : ''}`);
  lines.push(`Version ${safe(() => app.getVersion(), '?')} · ${cfg?.device_role ?? 'till'} · branch ${cfg?.branch_id ?? '?'} · terminal ${cfg?.terminal_code ?? '?'} · ${cfg?.node_url && !isNodeRole(cfg?.device_role ?? null) ? 'behind a branch server' : 'talks to the cloud itself'}`);
  const s = safe(() => getSyncStatus(), null as ReturnType<typeof getSyncStatus> | null);
  if (s) {
    const per = Object.entries(s.pendingBreakdown ?? {}).filter(([, n]) => Number(n) > 0).map(([t, n]) => `${t} ${n}`).join(', ');
    lines.push(`Sync: ${s.online ? 'online' : 'offline'} · nothing waiting last at ${s.lastSyncedAt ?? 'never'} · pending ${s.pendingCount}${per ? ` (${per})` : ''} · failed ${s.failedCount}${s.failedReason ? ` — ${String(s.failedReason).slice(0, 160)}` : ''} · parked ${s.parkedCount ?? 0}`);
    if (s.nodeBacklog) lines.push(`Owed to the branch server: ${s.nodeBacklog.pending} pending, ${s.nodeBacklog.failed} failed`);
    lines.push(`Cloud: ${s.cloudUnreachable ? `unreachable since ${s.cloudUnreachable.since} (${s.cloudUnreachable.why})` : 'reachable'}${s.pullError ? ` · pull error: ${String(s.pullError).slice(0, 160)}` : ''}`);
  }
  const live = safe(() => liveStatus(), null as ReturnType<typeof liveStatus> | null);
  if (live) {
    lines.push(`Change-triggered sync (A531): ${live.mode}, channel ${live.channel}, last change ${live.seq ?? 'none'}, last whole pull ${live.lastFullAt ?? 'never'}, waiting ${live.waiting}${live.error ? `, error: ${live.error}` : ''}`);
    const topics = live.topics.filter((t) => t.seq !== null).map((t) => `${t.topic} ${t.seq} at ${t.at ?? '?'}`).join(' · ');
    lines.push(`Topics: ${topics || '(none applied yet)'}`);
  }
  const disk = diskFree();
  if (disk) lines.push(`Disk: ${disk}`);
  return lines;
}

function diskFree(): string | null {
  try {
    const statfs = (fs as any).statfsSync as ((p: string) => { bavail: number; blocks: number; bsize: number }) | undefined;
    if (typeof statfs !== 'function') return null;
    const st = statfs(path.dirname(getLogPath()));
    const gb = (n: number) => Math.round(n * st.bsize / 1024 ** 3 * 10) / 10;
    return `${gb(st.bavail)} GB free of ${gb(st.blocks)} GB`;
  } catch { return null; }
}

/** The text sent for one request (every secret removed — supportLogs.buildSupportText). Exported for the tests. */
export function pullText(r: LogRequest, nowMs = Date.now()): string {
  const windowMs = r.range_hours * 3_600_000;
  const since = nowMs - windowMs;
  return buildSupportText(header(r),
    lazyLogFiles(rolledPaths(getLogPath(), KEEP_FILES), since),
    r.include?.auth ? lazyLogFiles(rolledPaths(getAuthLogPath(), AUTH_KEEP_FILES), since) : [],
    nowMs, { windowMs, logCap: PULL_LOG_CAP_BYTES, includeAuth: r.include?.auth === true, diagnostics: diagnostics(r) }).text;
}

type Outcome = 'sent' | 'closed' | 'failed' | 'skipped';
async function answer(r: LogRequest): Promise<Outcome> {
  if (closed.has(r.id)) return 'skipped';
  const n = tries.get(r.id) ?? 0;
  if (n >= MAX_TRIES) return 'skipped';
  const range = rangeLabel(r.range_hours * 3_600_000);
  if (n === 0) logLine('tech', `A533: ZapTill support asked for this till's log (request ${r.id}, the last ${range}${r.include?.auth ? ', with the sign-in history' : ''}) — sending`);
  let status: number | null = null; let body: any = null;
  try {
    const packed = packSupportText(pullText(r));
    const res = await liveCloudPost('/api/support/logs', { log_gz_b64: packed.b64, bytes: packed.bytes, trimmed: packed.trimmed,
      terminal_code: getDeviceConfig()?.terminal_code ?? null, app_version: safe(() => app.getVersion(), null), request_id: r.id });
    status = res.status; body = await res.json().catch(() => null);
  } catch { status = null; }
  const v = sendVerdict(status, body);
  if (v.ok) {
    closed.add(r.id); tries.delete(r.id);
    logLine('tech', `A533: logs pulled by ZapTill support (request ${r.id}) — the last ${range}, reference ${v.reference}`);
    return 'sent';
  }
  if (status === 403 || status === 404 || status === 409) {
    // Cancelled, expired, answered already, or not this till's: never again.
    closed.add(r.id); tries.delete(r.id);
    logLine('tech', `A533: log request ${r.id} not answered — the cloud says ${body?.code ?? status}${body?.status ? ` (${body.status})` : ''}`);
    return 'closed';
  }
  const t = n + 1;
  tries.set(r.id, t);
  logLine('tech', t >= MAX_TRIES
    ? `A533: log request ${r.id} — sending failed ${t} times (${v.message}); not tried again until the till starts again (the request stays waiting)`
    : `A533: log request ${r.id} — sending failed (try ${t} of ${MAX_TRIES}): ${v.message}`);
  return 'failed';
}

async function checkOnce(why: string): Promise<number> {
  if (Date.now() < notServedUntil) return 0;
  let res: Response;
  try { res = await liveCloudGet('/api/support/log-requests/mine'); } catch { return 0; }
  if (res.status === 404) {
    notServedUntil = Date.now() + NOT_SERVED_WAIT_MS;
    logLine('tech', 'A533: the cloud takes no log requests yet (an older cloud) — asked again in an hour');
    return 0;
  }
  if (!res.ok) return 0;
  const body = await res.json().catch(() => null) as { requests?: LogRequest[] } | null;
  const list = (body?.requests ?? []).filter((r) => r && typeof r.id === 'string' && RANGES.has(Number(r.range_hours)))
    .map((r) => ({ ...r, range_hours: Number(r.range_hours) }));
  let sent = 0;
  for (const r of list) {
    if ((await answer(r)) === 'sent') sent++;   // answer() skips a closed request and one tried MAX_TRIES times
  }
  if (sent) logLine('tech', `A533: ${sent} log request(s) answered (${why})`);
  return sent;
}

/** Ask for this till's waiting log requests and answer them. Single-flight: a ring during a run gets one more run. */
export function checkLogRequests(why = 'asked'): Promise<number> {
  if (running) { again = true; return running; }
  running = (async () => {
    let n = 0;
    do { again = false; n += await checkOnce(why); } while (again);
    return n;
  })().finally(() => { running = null; });
  return running;
}

/** Wire the doorbell (liveSync) and the 90 s beat (syncEngine). Idempotent. */
export function startLogPull(): void {
  if (started) return;
  started = true;
  setLogRequestBell((deviceId) => {
    const me = getDeviceConfig()?.device_id ?? '';
    if (!deviceId || deviceId !== me) return;   // another device's request: that device asks for it
    notServedUntil = 0;   // the cloud that rang serves the route
    void checkLogRequests('the cloud rang').catch(() => { /* the 90 s beat */ });
  });
  setLogPullBeat((why) => checkLogRequests(why));
}
export function stopLogPull(): void { started = false; setLogRequestBell(null); setLogPullBeat(null); }

/** Tests only. */
export function _resetLogPull(): void { tries.clear(); closed.clear(); running = null; again = false; notServedUntil = 0; }
