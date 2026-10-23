/**
 * autoUpdate.ts — self-updating for the desktop till (register D3; UX in A306).
 *
 * WIRED 2026-09-10 — electron-updater is a dependency, this is called from index.ts, and the
 * prod build publishes to GitHub Releases. Runs unsigned for now (docs/DESKTOP-AUTOUPDATE.md §4).
 *
 * Behaviour:
 *   - Dev builds never self-update (app.isPackaged guard + the "SwiftPOS Dev" flavour is skipped
 *     by name so a dev till never pulls a prod release).
 *   - On launch and every hour it asks the cloud (A348, below) and downloads an APPROVED newer version in the background.
 *   - It installs on the NEXT quit (autoInstallOnAppQuit) — a till is never interrupted
 *     mid-service and comes up updated when it is next closed (typically overnight).
 *   - A508: or on its own, silently, when nobody is using the machine (idle in one of its quiet hours, learned from its
 *     own sales) — createIdleInstaller below; a till left open and a branch server no longer wait for somebody to close them.
 *   - Nothing forced, nothing blocks trading: a failed check is logged and the till keeps
 *     selling on the current version.
 *
 * A306 — visible update UX (the follow-up the previous version of this file flagged):
 *   - Update status is broadcast to the renderer (update:status), which shows a non-blocking
 *     banner ("update ready — installs when you close SwiftPOS") plus a gentle reminder.
 *   - installUpdateNow() applies a downloaded update immediately with the NSIS progress window
 *     VISIBLE, so a manual update shows an "installing" screen and relaunches, instead of the
 *     app silently vanishing (the "broken shortcut for a few seconds" a till operator saw).
 *     Gated to a manager/tech PIN at the call site (renderer verifies before invoking).
 *
 * A348 (0.6.16) — the CLOUD decides, per business (owner, 2026-09-28: "hold by default, per business"):
 *   - The till no longer polls GitHub. Every hour (and at launch) it asks the cloud GET /api/desktop-update/status which
 *     version its business is approved for. null = HOLD: nothing is checked or downloaded. Older or equal to what it runs:
 *     nothing either (never a downgrade).
 *   - Only when the approved version is NEWER does it point electron-updater's generic feed at the cloud,
 *     /api/desktop-update/v/<approved>/ (latest.yml, installer, blockmap for exactly that version), with the till's own
 *     token. The cloud redirects each file to GitHub; the updater drops the token on that cross-host hop.
 *   - Any failure (offline, an older cloud without the route, a 401 after one refresh) is a hold, never an error on screen.
 *   - Differential download is off: every file request goes through the cloud's approval check, and a range-by-range
 *     download would make one check per block.
 */

import { app, BrowserWindow, session } from 'electron';
import type { AppUpdater } from 'electron-updater';   // A517: types only — the module itself loads at its first use (below)
import { getCloudUrl, getDeviceConfig } from './deviceConfig';
import { cloudFetch, cloudBaseFor } from './cloudGateway';
import { readSessionTokens } from './tokenStore';
import { refreshAccessToken } from './syncEngine';
import { isNodeRole } from './deviceConfig';
import { getNodePort } from './nodeServer';
import { prepareShare, shareDir, onShareWanted, noteApprovedForShare } from './updateShare';   // A443
import { lanFetch, lanUrl, trustPinnedNodeIn } from './lanTls';   // A489
import { logLine } from './logFile';
import { getLocalDb, closeLocalDb } from './localDb';
import { activitySnapshot, installVerdict, loadUsageProfile, hourOfWeek, downloadedSince, type ActivitySnapshot, type InstallState } from './activityTracker';   // A508
import { flushBeforeInstall, syncPushSince } from './syncEngine';   // A508
import { stopNodeServer } from './nodeServer';   // A508
import { readyVersion } from './updateShare';   // A508
import { markQuitting } from './serverMode';   // A508
import { execFile } from 'child_process';
import fs from 'fs';   // A541: the kept installer still on disk
import { defaultTaskDeps, hasUpdaterTask, requestTaskInstall, updaterLogTail, type TaskInstallResult } from './updaterTask';   // A509
import { whenStartupSettled, lastStartupLine, UPDATE_AFTER_LAUNCH_MS, UPDATE_AFTER_SETTLED_MS } from './lowImpactStart';   // A513
import { readUpdateWaiting, writeUpdateWaiting } from './lowImpactStart';   // A546
import { graphicsLine } from './lowImpactStart';   // A513
import { buildUpdateReport, createUpdateReporter, type UpdateStateReport } from './updateReport';   // A534

const ONE_HOUR = 60 * 60 * 1000;   // A348: the approval check is one small JSON call

// ── A517: electron-updater loads when it is first used, not at start ────────────────────────────────────────────────
// electron-updater and what it brings (semver, fs-extra, js-yaml, builder-util-runtime — about a hundred files) were
// required by index.ts's first lines, on every start, though A513 asks nothing of it for at least 4 minutes. Now the
// module loads the first time the updater is touched — the first approved download (runUpdateCheck), an install — and
// initAutoUpdate's settings and listeners are applied to it at that moment, before anything else uses it. A business on
// hold, or a till offline, never loads it at all. The rest of this file still writes `autoUpdater.x`: the stand-in
// below loads the real one on first touch.
let loadedUpdater: AppUpdater | null = null;
let onUpdaterLoaded: ((u: AppUpdater) => void) | null = null;
function realUpdater(): AppUpdater {
  if (!loadedUpdater) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    loadedUpdater = (require('electron-updater') as typeof import('electron-updater')).autoUpdater;
    const wire = onUpdaterLoaded;
    onUpdaterLoaded = null;
    if (wire) wire(loadedUpdater);
  }
  return loadedUpdater;
}
/** A517: the updater if it has been loaded, else null — read at quit, where loading it would only slow the close. */
export function updaterIfLoaded(): AppUpdater | null { return loadedUpdater; }
/** Tests only: the first use, now (test/lazy-load-a517.test.mjs). */
export function _updaterNow(): AppUpdater { return realUpdater(); }
const autoUpdater: AppUpdater = new Proxy({} as AppUpdater, {
  get: (_t, k) => { const u = realUpdater() as any; const v = u[k]; return typeof v === 'function' ? v.bind(u) : v; },
  set: (_t, k, v) => { (realUpdater() as any)[k] = v; return true; },
});

let started = false;

export type UpdateState = 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'error';
/**
 * A496: `note` is one plain sentence on why the till is where it is ("waiting: the branch server is still fetching
 * 1.0.16", "downloaded — installs when ZapTill is closed"); `checkedAt` when it last asked; `approved` what the cloud said.
 * Extra fields: a renderer that does not know them ignores them.
 */
export interface UpdateStatus {
  state: UpdateState; version: string | null; percent: number | null;
  note?: string | null; checkedAt?: string | null; approved?: string | null;
  /** A541: when this version was first seen downloaded on this machine (ms, kept across restarts) — the managers' notice. */
  downloadedAt?: number | null;
  /** A541: a till behind a branch server waiting for the server's copy of the approved version. */
  waitingServer?: boolean;
}

let current: UpdateStatus = { state: 'idle', version: null, percent: null, note: null, checkedAt: null, approved: null };

/**
 * The renderer polls this on mount (in case it missed the push while loading). A508: with the last idle install, for the
 * Tech page only — the update bar (UpdateBanner) reads state/version and shows nothing for it.
 */
export function getUpdateStatus(): UpdateStatus & { idleInstall: (IdleInstallRecord & { ok: boolean }) | null } {
  return { ...current, idleInstall: lastIdleInstall };
}

// ── A496: diagnostics — why a till did (not) update, in words a support person can read ─────────────────────────────
const diag: Array<{ at: string; line: string }> = [];
/** One decision, logged to the app log ('update' scope) and kept (the last 40) for the Tech page. */
export function noteUpdate(line: string, now = new Date()): void {
  diag.push({ at: now.toISOString(), line });
  if (diag.length > 40) diag.splice(0, diag.length - 40);
  try { logLine('update', line); } catch { /* logging never stops an update */ }
}
/** What the Tech page shows: the status, and the last decisions with their times (newest last). */
export function getUpdateDiagnostics(): {
  status: UpdateStatus; running: string | null; log: Array<{ at: string; line: string }>;
  /** A508: the last idle install (from → to, when, whether this machine now runs it) and why the next has not happened. */
  idleInstall: (IdleInstallRecord & { ok: boolean }) | null; idleNote: string | null;
  /** A509: whether the updater task is installed (null: not known yet), and the last lines of its own log. */
  updaterTask: { installed: boolean | null; log: string[] };
  /** A513: the last start's timing line, and the graphics (low-memory) mode. */
  startup: string | null; graphics: string | null;
} {
  let running: string | null = null;
  try { running = app.getVersion(); } catch { /* tests */ }
  let log: string[] = [];
  try { log = process.platform === 'win32' ? updaterLogTail(defaultTaskDeps()) : []; } catch { /* never */ }
  return { status: getUpdateStatus(), running, log: diag.slice(), idleInstall: lastIdleInstall, idleNote,
    updaterTask: { installed: taskKnown, log }, startup: lastStartupLine(), graphics: graphicsLine() };
}
/** Tests only. */
export function _resetUpdateDiagnostics(): void {
  diag.length = 0; current = { state: 'idle', version: null, percent: null, note: null, checkedAt: null, approved: null };
  lastIdleInstall = null; idleNote = null; taskKnown = null; taskCheckedAt = 0; taskInstallStarted = false; closeTaskDone = false;
  stateAt = null;   // A534
  idleBlocker = null; startupInstallFailed = null;   // A541
}

// ── A509: the updater task (updaterTask.ts) — an install with no Windows prompt ─────────────────────────────────────
/** Whether the "ZapTill Updater" task is there (null: not asked yet). Read synchronously at quit — kept fresh below. */
let taskKnown: boolean | null = null;
let taskCheckedAt = 0;
/** An install through the task has been handed over: nothing else may install (electron-updater's quit handler). */
let taskInstallStarted = false;
/** Install-on-close has had its turn (the task, or the old way): the next quit goes through. */
let closeTaskDone = false;

/** Asked at most every 10 minutes (a technician may reinstall meanwhile). Never throws. */
export async function updaterTaskAvailable(force = false): Promise<boolean> {
  if (process.platform !== 'win32') { taskKnown = false; return false; }
  if (!force && taskKnown !== null && Date.now() - taskCheckedAt < 10 * 60_000) return taskKnown;
  const was = taskKnown;
  taskKnown = await hasUpdaterTask(defaultTaskDeps()).catch(() => false);
  taskCheckedAt = Date.now();
  if (was !== taskKnown) {
    noteUpdate(taskKnown ? 'the ZapTill updater task is installed — updates install without a Windows prompt'
      : `no ZapTill updater task on this machine (installed before 1.0.16, or blocked) — updates install when ZapTill is closed, with Windows' prompt`);
  }
  return taskKnown;
}

/** The file electron-updater downloaded (BaseUpdater.installerPath — downloadedUpdateHelper.file), or null. */
function downloadedInstaller(): string | null {
  try { const p = (autoUpdater as any).installerPath; return typeof p === 'string' && p ? p : null; } catch { return null; }
}

/** Hand `version` to the updater task; on ok the caller quits (nothing else installs it). */
async function installThroughTask(version: string, relaunch: boolean, timeoutMs?: number): Promise<TaskInstallResult> {
  const r = await requestTaskInstall(defaultTaskDeps(), { version, installerPath: downloadedInstaller() ?? '', relaunch, timeoutMs });
  if (r.ok) {
    taskInstallStarted = true;
    autoUpdater.autoInstallOnAppQuit = false;   // no second install by electron-updater as ZapTill quits
    noteUpdate(`the updater task checked ${version} against the official release — ZapTill closes now and ${relaunch ? 'starts again' : 'stays closed'} after the install`);
  }
  return r;
}

function broadcast(): void {
  for (const w of BrowserWindow.getAllWindows()) {
    try { w.webContents.send('update:status', current); } catch { /* window gone; ignore */ }
  }
}

/** A534: when the current state began (downloaded at 14:02, failed at 14:10) — for the admin portal's report. */
let stateAt: string | null = null;
function set(patch: Partial<UpdateStatus>): void {
  if (patch.state && patch.state !== current.state) stateAt = new Date().toISOString();
  current = { ...current, ...patch };
  broadcast();
}
/** A534: what the till reports to the cloud (updateReport.ts) — the status, since when, the idle note, the task. */
export function currentUpdateReport(): UpdateStateReport {
  let running = '';
  try { running = app.getVersion(); } catch { /* tests */ }
  let server = false;
  try { server = isNodeRole(getDeviceConfig()?.device_role ?? null); } catch { /* tests */ }
  return buildUpdateReport({ status: current, running, stateAt, idleNote, task: taskKnown,
    blocker: idleBlocker, server, startupFailed: startupInstallFailed });   // A541
}
/** A541: why the downloaded update cannot install by itself here (silentInstallBlocker, a refusal), or null. */
let idleBlocker: string | null = null;
/** A541: the version a start-up install was tried for and did not take (this machine still runs the old one). */
let startupInstallFailed: string | null = null;

/** A546: the words of the small screen a till opened by hand shows while its waiting update installs. Pure. */
export function updatingText(version: string): string { return `Updating ZapTill to ${version} — about a minute`; }
/**
 * A546: a till opened by hand with an approved update waiting installs it before the PIN screen — this small screen says
 * so (owner, 2026-10-21: a till opened by hand installs a waiting update first, "as a backup"). Not a cashier banner: it
 * is the start of ZapTill, and it closes as ZapTill closes for the install. Never at a quiet sign-in install.
 */
function updatingWindow(version: string): BrowserWindow | null {
  try {
    const w = new BrowserWindow({ width: 460, height: 150, frame: false, resizable: false, center: true, show: true,
      skipTaskbar: false, title: 'Updating ZapTill', webPreferences: { sandbox: true, contextIsolation: true, javascript: false } });
    const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as Record<string, string>)[c]);
    const html = `<!doctype html><meta charset="utf-8"><title>Updating ZapTill</title><body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;font:16px Segoe UI,system-ui,sans-serif;background:#0f172a;color:#f8fafc">${esc(updatingText(version))}</body>`;
    void w.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    return w;
  } catch { return null; }
}

/**
 * Apply a downloaded update NOW, with the NSIS progress visible and a relaunch after. Only
 * meaningful once state === 'downloaded'; a no-op otherwise so a stray call can never
 * half-restart a trading till. A519: who may is decided in the IPC handler (a signed-in back-office person or a
 * technician — no PIN) and the bar shows the button only to them — see ipcHandlers 'update:installNow'.
 */
export async function installUpdateNow(): Promise<{ ok: boolean; reason?: string }> {
  if (!app.isPackaged) return { ok: false, reason: 'not packaged' };
  if (current.state !== 'downloaded') return { ok: false, reason: 'no update downloaded' };
  if (taskInstallStarted) return { ok: true };
  // A509: through the updater task — no Windows prompt; it starts ZapTill again after. Refused or no answer → as before.
  if (current.version && await updaterTaskAvailable()) {
    const r = await installThroughTask(current.version, true, 90_000);   // somebody is waiting at the till
    if (r.ok) { markQuitting(); app.quit(); return { ok: true }; }
    noteUpdate(`${r.reason} — installing ${current.version} the old way (Windows asks for permission)`);
  }
  closeTaskDone = true;   // A509: the quit below installs through electron-updater, not the close path
  // isSilent=false → show the installer progress window (no silent vanish);
  // isForceRunAfter=true → relaunch the till once the swap is done.
  autoUpdater.quitAndInstall(false, true);
  return { ok: true };
}

/** A348: what the cloud's approval means for a till running `running`. */
export type UpdateDecision = 'hold' | 'current' | 'update';
const VERSION_RE = /^(\d{1,4})\.(\d{1,4})\.(\d{1,4})$/;
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0) ? -1 : 1; }
  return 0;
}
export function decideUpdate(approved: unknown, running: string): UpdateDecision {
  if (typeof approved !== 'string' || !VERSION_RE.test(approved)) return 'hold';
  if (!VERSION_RE.test(running)) return 'hold';
  return compareVersions(approved, running) > 0 ? 'update' : 'current';
}
export function feedUrlFor(cloudUrl: string, version: string): string {
  return `${cloudUrl.replace(/\/+$/, '')}/api/desktop-update/v/${version}/`;
}

/** A496: what preparing the branch's copy came to. 'live': the till downloads THROUGH the server's gateway (the server
 *  could not fetch its own copy) — the request carries X-Update-Live so the server passes it on instead of a 503. */
export type ShareVerdict = 'ready' | 'busy' | 'failed' | 'live';
export const UPDATE_LIVE_HEADER = 'X-Update-Live';

/** The pieces a check needs — real ones in initAutoUpdate, fakes in the test. */
export interface UpdateCheckDeps {
  updater: {
    setFeedURL(opts: { provider: 'generic'; url: string }): void;
    requestHeaders: Record<string, string> | null;
    checkForUpdates(): Promise<unknown>;
  };
  fetch: typeof fetch;
  cloudUrl: () => string | null;
  /** A410: where the update download goes — the branch server's gateway on a till with one (plus its access code). */
  route?: (cloudUrl: string) => { base: string; headers: Record<string, string> };
  token: () => string | null;
  refresh: () => Promise<boolean>;
  running: string;
  log?: (line: string) => void;
  /**
   * A443: on a branch server — fetch the approved version for the branch's tills (whether or not this server needs it),
   * and take this server's own update from that copy (its own gateway) once it is ready.
   */
  share?: {
    prepare: (version: string) => Promise<ShareVerdict>;
    route: () => { base: string; headers: Record<string, string> } | null;
    /** A496: told what the cloud approved (null = hold), so the server offers its tills only that version. */
    approved?: (version: string | null) => void;
  };
  /**
   * A496: false while this machine's own download is under way — the branch's copy is still prepared (a branch server
   * keeps fetching for its tills whatever its own state), but the updater is not touched.
   */
  selfUpdate?: boolean;
  /** A496: told how to cancel the download a check started (a stalled download is cut and tried again). */
  onStarted?: (cancel: () => void) => void;
  /** A496: the most a check (latest.yml) may take — Electron's network stack has no timeout of its own. */
  checkTimeoutMs?: number;
  /** A534: told whether the cloud takes this machine's update state (`reportsState: true` on the status answer; an older
   *  cloud has no such field → false, and nothing is reported). */
  cloudReportsState?: (yes: boolean) => void;
}
export interface UpdateCheckResult {
  decision: UpdateDecision | 'unreachable'; approved: string | null; waiting?: boolean;
  /** A496: one plain sentence — what was decided and why. */
  reason?: string;
  timedOut?: boolean;
}

/** One A348 check: ask the cloud, and only for an approved NEWER version open the feed and check it. Never throws. */
export async function runUpdateCheck(d: UpdateCheckDeps): Promise<UpdateCheckResult> {
  const cloud = d.cloudUrl();
  const say = (r: UpdateCheckResult): UpdateCheckResult => { if (r.reason) d.log?.(r.reason); return r; };
  const ask = async (tok: string) => d.fetch(`${String(cloud).replace(/\/+$/, '')}/api/desktop-update/status`, {
    headers: { Authorization: `Bearer ${tok}` }, signal: AbortSignal.timeout(10_000),
  });
  let token = d.token();
  if (!cloud || !token) return say({ decision: 'unreachable', approved: null, reason: `not checked: ${!cloud ? 'no cloud address' : 'this till is not signed in to the cloud'}` });
  let approved: string | null = null;
  try {
    let res = await ask(token);
    if (res.status === 401 && await d.refresh().catch(() => false)) {
      token = d.token();
      if (token) res = await ask(token);
    }
    if (!res.ok) return say({ decision: 'unreachable', approved: null, reason: `update status: HTTP ${res.status} — holding` });
    const body = await res.json() as { approvedVersion?: unknown; reportsState?: unknown };
    approved = typeof body?.approvedVersion === 'string' ? body.approvedVersion : null;
    try { d.cloudReportsState?.(body?.reportsState === true); } catch { /* never stops a check */ }   // A534
  } catch (e: any) {
    return say({ decision: 'unreachable', approved: null, reason: `update status unreachable (${e?.message ?? e}) — holding` });
  }
  const decision = decideUpdate(approved, d.running);
  try { d.share?.approved?.(approved); } catch { /* never stops a check */ }
  let shared: { base: string; headers: Record<string, string> } | null = null;
  let live = false;
  if (d.share && approved && decision !== 'hold') {
    const st = await d.share.prepare(approved).catch(() => 'failed' as const);
    if (decision === 'update') {
      if (st === 'live') live = true;
      else if (st !== 'ready') return say({ decision, approved, waiting: true, reason: `update ${approved}: the branch's copy is not ready yet (${st}) — waiting` });
      else shared = d.share.route();
    }
  }
  if (decision === 'hold') return say({ decision, approved, reason: 'the business is on hold (no version approved) — nothing to download' });
  if (decision !== 'update' || !approved || !token) return say({ decision, approved, reason: `approved ${approved}, this machine runs ${d.running} — nothing to download` });
  if (d.selfUpdate === false) return say({ decision, approved, reason: `approved ${approved}: this machine's own download is already under way` });
  const via = shared ?? d.route?.(cloud) ?? { base: cloud, headers: {} };
  d.updater.setFeedURL({ provider: 'generic', url: feedUrlFor(via.base, approved) });
  d.updater.requestHeaders = { Authorization: `Bearer ${token}`, ...via.headers, ...(live ? { [UPDATE_LIVE_HEADER]: '1' } : {}) };
  d.log?.(`update ${approved}: downloading from ${shared ? 'this server\'s own copy' : live ? 'the cloud, through the branch server' : via.base === cloud ? 'the cloud' : 'the branch server'}`);
  const limit = d.checkTimeoutMs ?? 120_000;
  let timer: NodeJS.Timeout | null = null;
  try {
    const timedOut = Symbol('timeout');
    const result = await Promise.race([
      d.updater.checkForUpdates(),
      new Promise<typeof timedOut>((r) => { timer = setTimeout(() => r(timedOut), limit); }),
    ]);
    if (result === timedOut) {
      // A496: Electron's network stack never times a request out (electron-updater's timeout listens for a 'socket'
      // event Electron's requests do not emit) — a check that hangs would hold the updater's "check in progress" for
      // ever, and every later check would join it. Forgotten, so the next check asks afresh.
      try { (d.updater as any).checkForUpdatesPromise = null; } catch { /* a stand-in updater */ }
      return say({ decision, approved, timedOut: true, reason: `update ${approved}: no answer from the update feed in ${Math.round(limit / 1000)} s — asked again on the next check` });
    }
    const r = result as { downloadPromise?: Promise<unknown>; cancellationToken?: { cancel(): void } } | null | undefined;
    // A363: with autoDownload the check hands back a download promise that REJECTS when the network drops mid-download
    // (net::ERR_NETWORK_IO_SUSPENDED / ERR_CONNECTION_RESET in the log) — nobody caught it, so every drop was an
    // UnhandledPromiseRejection. The 'error' event already reports it; this only stops the rejection going unhandled.
    r?.downloadPromise?.catch((e: any) => d.log?.(`update download interrupted: ${e?.message ?? e} — it retries on the next check`));
    if (r?.cancellationToken) d.onStarted?.(() => r.cancellationToken!.cancel());
  }
  catch (e: any) { d.log?.(`update check failed: ${e?.message ?? e}`); }
  finally { if (timer) clearTimeout(timer); }
  return { decision, approved };
}

/** A496: what the branch server says about the update, as a till reads it. */
export interface BranchServerAnswer {
  version: string | null;
  newer: boolean;
  /** The server's own fetch of a version: how it is going (an older server sends nothing). */
  share?: { version: string; state: 'fetching' | 'failed' | 'ready'; failures: number; error: string | null } | null;
}

/**
 * A554: only a till BEHIND a branch server asks one about updates — never the branch server itself (role node/office:
 * it IS the server), and never a till with no server configured. Pure. Before A554 the 2-minute loop asked on every
 * machine and a branch server logged "the branch server did not answer the update question" every hour (B Foods,
 * 2026-10-21: a node with no other tills).
 */
export function asksBranchServer(cfg: { device_role?: string | null; node_url?: string | null } | null | undefined): boolean {
  if (!cfg || isNodeRole(cfg.device_role ?? null)) return false;
  return String(cfg.node_url ?? '').trim().replace(/\/+$/, '') !== '';
}

/**
 * A443: a till behind a branch server asks it "I run X — is there a newer version?". The server answers with the version
 * it holds ready (and notes this till's). Null when there is no server, or it cannot be reached (asked again later).
 * A496: `want` — the version the cloud approved for this till, so a server holding another one fetches it now.
 */
export async function askBranchServer(d: {
  cfg: { device_role?: string | null; node_url?: string | null; node_secret?: string | null; device_id?: string | null;
         device_name?: string | null; terminal_code?: string | null } | null;
  running: string;
  fetch: typeof fetch;
  want?: string | null;
}): Promise<BranchServerAnswer | null> {
  const c = d.cfg;
  const node = String(c?.node_url ?? '').trim().replace(/\/+$/, '');
  if (!c || !asksBranchServer(c)) return null;
  const q = new URLSearchParams({ device: String(c.device_id ?? ''), name: String(c.device_name || c.terminal_code || ''), v: d.running });
  if (d.want && VERSION_RE.test(d.want)) q.set('want', d.want);
  try {
    const res = await d.fetch(`${node}/node/update/ready?${q}`, {
      headers: { 'X-Node-Secret': String(c.node_secret ?? '') }, signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const b = await res.json() as { version?: unknown; newer?: unknown; share?: any };
    const sh = b?.share && typeof b.share === 'object' && typeof b.share.version === 'string' ? {
      version: String(b.share.version),
      state: (['fetching', 'failed', 'ready'].includes(b.share.state) ? b.share.state : 'failed') as 'fetching' | 'failed' | 'ready',
      failures: Number(b.share.failures) || 0, error: typeof b.share.error === 'string' ? b.share.error : null,
    } : null;
    return { version: typeof b?.version === 'string' ? b.version : null, newer: b?.newer === true, share: sh };
  } catch { return null; }
}

/** A496: after this long told "not ready" for one version (and the server not fetching it), a till goes through it live. */
export const TILL_WAIT_LIMIT_MS = 6 * 60 * 60_000;
/** A496: a server that failed this many times in a row to fetch a version lets its tills go through it live. */
export const SHARE_GIVE_UP_FAILURES = 3;

/**
 * A496: a till behind a branch server, about to download approved `v` — take it from the server's copy, wait, or (the
 * server cannot fetch it) download through the server live. Pure.
 *
 * Before: "the server holds v → ready, anything else → busy", for ever. A server that never fetched v (its own check
 * stuck, signed out of the cloud, a disk error) left every till of the branch waiting with no end and no reason shown.
 */
export function tillShareVerdict(a: BranchServerAnswer | null, v: string, waitingSince: number | null, now: number):
  { verdict: 'ready' | 'busy' | 'live'; reason: string } {
  if (!a) return { verdict: 'ready', reason: 'the branch server did not answer about updates (an older build, or not reachable) — downloading through it as before' };
  if (a.version === v) return { verdict: 'ready', reason: `the branch server holds ${v} — downloading it from the server` };
  const sh = a.share && a.share.version === v ? a.share : null;
  if (sh && sh.state === 'failed' && sh.failures >= SHARE_GIVE_UP_FAILURES) {
    return { verdict: 'live', reason: `the branch server could not fetch ${v} (${sh.failures} tries${sh.error ? `: ${sh.error}` : ''}) — downloading it through the server directly` };
  }
  if (waitingSince !== null && now - waitingSince >= TILL_WAIT_LIMIT_MS && sh?.state !== 'fetching') {
    return { verdict: 'live', reason: `waited ${Math.round((now - waitingSince) / 3_600_000)} h for the branch server to hold ${v} — downloading it through the server directly` };
  }
  if (sh?.state === 'fetching') return { verdict: 'busy', reason: `waiting: the branch server is fetching ${v}` };
  if (sh?.state === 'failed') return { verdict: 'busy', reason: `waiting: the branch server's fetch of ${v} failed (${sh.error ?? 'no detail'}) — it tries again` };
  return { verdict: 'busy', reason: a.version ? `waiting: the branch server holds ${a.version}, not ${v} — it fetches ${v} next` : `waiting: the branch server has no copy of ${v} yet — it fetches it next` };
}

// ── A496: the check loop (testable — initAutoUpdate wires Electron into it) ───────────────────────────────────────────

/** No progress for this long on a download (or a check) → it is cut and tried again. */
export const STALL_MS = 15 * 60_000;

export interface UpdateLoopDeps {
  status: () => UpdateStatus;
  set: (patch: Partial<UpdateStatus>) => void;
  running: string;
  /** This machine serves a branch (it prepares the branch's copy whatever its own state). */
  isServer: () => boolean;
  /** One check's pieces, read fresh (config, port, tokens) — `running` is the version this machine will run next. */
  checkDeps: (o: { running: string; selfUpdate: boolean }) => UpdateCheckDeps;
  /** A till behind a branch server asks it (null: none, or no answer). */
  askServer: () => Promise<BranchServerAnswer | null>;
  /**
   * A554: whether this machine sits behind a branch server at all (asksBranchServer). False — a branch server itself, or
   * a till with no server configured — the 2-minute question is not asked (and nothing is logged about it). Read on every
   * ask: a till joined to a server later starts asking at its next one. Omitted: asked (the tests before A554).
   */
  behindServer?: () => boolean;
  log: (line: string) => void;
  now?: () => number;
  stallMs?: number;
  /**
   * A503: whether the downloaded update may install when ZapTill closes (electron-updater's autoInstallOnAppQuit, read at
   * quit time). Set false when the version downloaded is no longer approved (a roll-back, or the business put on hold).
   */
  installOnQuit?: (on: boolean) => void;
}

/**
 * The hourly check, the till's 2-minute question to its server, and the watchdog — what initAutoUpdate used to hold
 * inline. A496 root causes it fixes (see test/update-delivery.test.mjs):
 *   - a machine holding a downloaded update never checked again — a branch server (never closed: server mode) then
 *     never fetched the NEXT version for its tills, and they waited for ever. Now a check always runs: the server
 *     prepares the branch's copy, and a newer approval than the one downloaded is downloaded in its place;
 *   - a download that stalled (no error, no bytes) left "downloading" for ever, and every check returned early —
 *     Electron's requests never time out. Now: no progress for STALL_MS → cancelled, the next check starts it again.
 */
export function createUpdateLoop(d: UpdateLoopDeps) {
  const now = d.now ?? Date.now;
  const stallMs = d.stallMs ?? STALL_MS;
  let busy = false;
  let lastActivity = now();
  let cancel: (() => void) | null = null;
  let quietAsks = 0;
  const inFlight = (s: UpdateStatus) => s.state === 'downloading' || s.state === 'available' || s.state === 'checking';
  // A503 (scenario audit, roll-back / hold): the version electron-updater holds to install at quit — remembered here, so
  // a download withdrawn below (shown as idle) is still known to be on disk and is never installed by a later check
  // that no longer sees 'downloaded'.
  let staged: string | null = null;
  // A508: false once the cloud withdrew the version downloaded (a roll-back, a hold) — true again when it approves it.
  let installable = true;
  const heldNewer = (s: UpdateStatus) => {
    if (s.state === 'downloaded' && s.version && VERSION_RE.test(s.version)) staged = s.version;
    return staged && VERSION_RE.test(d.running) && compareVersions(staged, d.running) > 0 ? staged : null;
  };

  /** Progress (a check began, an update was found, bytes arrived): the watchdog starts again. */
  const touch = () => { lastActivity = now(); };
  const stalled = () => inFlight(d.status()) && now() - lastActivity > stallMs;

  const unstick = () => {
    if (!stalled()) return;
    const s = d.status();
    d.log(`the ${s.state === 'checking' ? 'update check' : `download of ${s.version ?? 'the update'}`} has had no progress for ${Math.round((now() - lastActivity) / 60_000)} min — cancelled; it starts again now`);
    try { cancel?.(); } catch { /* already gone */ }
    cancel = null;
    d.set({ state: 'error', percent: null, note: 'the last download stalled — trying again' });
  };

  async function check(why: string): Promise<UpdateCheckResult | null> {
    if (busy) { d.log(`check (${why}) skipped — a check is already running`); return null; }
    unstick();
    const s = d.status();
    const downloading = inFlight(s);
    if (downloading && !d.isServer()) {
      d.log(`check (${why}) skipped — ${s.state === 'checking' ? 'a check' : `the download of ${s.version ?? 'the update'} (${s.percent ?? 0}%)`} is under way`);
      return null;
    }
    const held = heldNewer(s);
    busy = true;
    try {
      const r = await runUpdateCheck({
        ...d.checkDeps({ running: held ?? d.running, selfUpdate: !downloading }),
        selfUpdate: !downloading,
        onStarted: (c) => { cancel = c; touch(); },
      });
      const checkedAt = new Date(now()).toISOString();
      // A503: a downloaded update installs at quit only while the cloud still approves it (or a newer one). Admin rolled
      // the business back (approved older than the download) or put it on hold → it is NOT installed: a till never
      // closed for days used to install, at its next close, the very version that was pulled. An unanswered check
      // changes nothing; approval given back → it installs again.
      if (r.decision === 'hold' || r.decision === 'current' || r.decision === 'update') {
        const withdrawn = !!held && (r.decision === 'hold' || (!!r.approved && compareVersions(r.approved, held) < 0));
        installable = !withdrawn;   // A508: the idle install obeys the same answer
        try { d.installOnQuit?.(!withdrawn); } catch { /* never stops a check */ }
        if (withdrawn) {
          const why = r.decision === 'hold' ? 'the business is on hold' : `the approved version is now ${r.approved}`;
          d.log(`${held} was downloaded but is no longer approved (${why}) — it will not be installed`);
          d.set({ state: 'idle', percent: null, checkedAt, approved: r.approved, note: `${held} was downloaded but is no longer approved (${why}) — it will not be installed` });
          return r;
        }
        if (held && d.status().state === 'idle' && r.decision !== 'update') d.set({ state: 'downloaded', version: held, percent: 100 });   // approved again
      }
      const note = r.timedOut ? 'the update feed did not answer — asked again on the next check'
        : r.waiting ? (r.reason ?? 'waiting for the branch server')
        : held && r.decision !== 'update' ? `${held} downloaded — installs when ZapTill is closed`
        : r.decision === 'hold' ? 'updates are on hold for this business'
        : r.decision === 'current' ? `up to date (approved ${r.approved})`
        : r.decision === 'unreachable' ? (r.reason ?? 'the cloud could not be asked')
        : `downloading ${r.approved}`;
      d.set({ checkedAt, approved: r.approved, note, waitingServer: !!r.waiting, ...(r.timedOut ? { state: 'error' as const } : {}) });   // A541: waitingServer
      return r;
    } finally { busy = false; }
  }

  /** A till behind a branch server: "is there a newer one?" — told yes, it checks now. */
  async function ask(): Promise<void> {
    if (d.behindServer && !d.behindServer()) return;   // A554: a branch server (or a till with none) asks nobody
    if (busy) return;
    unstick();
    const s = d.status();
    if (inFlight(s)) return;
    const r = await d.askServer();
    if (!r) { if (quietAsks++ % 30 === 0) d.log('the branch server did not answer the update question (it is asked again every 2 minutes)'); return; }
    quietAsks = 0;
    const held = heldNewer(s);
    if (!r.newer || (held && r.version && compareVersions(r.version, held) <= 0)) return;
    d.log(`the branch server holds ${r.version} (this till runs ${d.running}${held ? `, has ${held} downloaded` : ''}) — checking now`);
    await check('the branch server holds a newer version');
  }

  /**
   * A508: the version that may be installed now, or null — downloaded (on disk and shown 'downloaded'), newer than what
   * runs, and not withdrawn by the cloud's last answer (A503). The idle install asks this and nothing else.
   */
  const installableVersion = (): string | null => {
    const s = d.status();
    if (s.state !== 'downloaded' || !installable) return null;
    const v = heldNewer(s);
    return v && s.version === v ? v : null;
  };

  return { check, ask, touch, stalled, installableVersion };
}

// ── A508: the idle install — a downloaded, still-approved update installs on its own when nobody is using the machine ──
//
// Owner, 2026-10-16: "some clients take forever to update unless am there". A till left open and a branch server (never
// closed) used to hold a downloaded update for ever: it installed only when ZapTill was closed. Now, checked every
// minute: installVerdict (activityTracker.ts) says when — not busy, idle long enough, in one of THIS machine's quiet
// hours (learned from its own sales) — and then: one sync push (at most 60 s), the record of what is being done, a
// branch server stops serving (its tills see a clean disconnect and retry), the database is closed, and electron-updater
// installs silently and starts ZapTill again (quitAndInstall(true, true)). It comes back to the normal start (the PIN
// screen), the open drawer and day untouched (they live in the local database), a server serving again (index.ts).
// The install-on-close and "Restart & update now" paths are unchanged.

/** What the idle install recorded before it restarted (maintenance_state), read back after the restart. */
export interface IdleInstallRecord { from: string; to: string; at: string; reason: 'idle' | 'startup'; why?: string; reported?: boolean }
const IDLE_INSTALL_KEY = 'update_idle_install';
let lastIdleInstall: (IdleInstallRecord & { ok: boolean }) | null = null;
let idleNote: string | null = null;

/** Written just before the install (the database is still open). Never throws. */
export function recordIdleInstall(r: IdleInstallRecord): void {
  try {
    getLocalDb().prepare(`INSERT OR REPLACE INTO maintenance_state (key, value, updated_at) VALUES (?, ?, ?)`)
      .run(IDLE_INSTALL_KEY, JSON.stringify(r), r.at);
  } catch (e: any) { try { logLine('update', `could not record the idle install: ${e?.message ?? e}`); } catch { /* never */ } }
}

/**
 * After a restart: what the last idle install did, as one plain sentence in the update log (once), and kept for the Tech
 * page (getUpdateStatus / getUpdateDiagnostics). Never a banner for the cashier — the owner does not want one.
 */
export function reportIdleInstall(running: string): (IdleInstallRecord & { ok: boolean }) | null {
  let r: IdleInstallRecord | null = null;
  try {
    const row = getLocalDb().prepare(`SELECT value FROM maintenance_state WHERE key = ?`).get(IDLE_INSTALL_KEY) as { value?: string } | undefined;
    r = row?.value ? JSON.parse(row.value) as IdleInstallRecord : null;
  } catch { r = null; }
  if (!r || typeof r.to !== 'string' || typeof r.from !== 'string') return null;
  const ok = running === r.to;
  const when = (() => { const d = new Date(r!.at); return isNaN(d.getTime()) ? r!.at : d.toLocaleString(); })();
  if (!r.reported) {
    const how = r.reason === 'startup' ? 'at start-up' : 'while idle';   // A541
    noteUpdate(ok ? `updated from ${r.from} to ${r.to} ${how} (${when}${r.why ? `, ${r.why}` : ''})`
      : `an install of ${r.to} ${how} was started at ${when}, but this machine still runs ${running} — it installs when ZapTill is next closed`);
    try {
      getLocalDb().prepare(`INSERT OR REPLACE INTO maintenance_state (key, value, updated_at) VALUES (?, ?, ?)`)
        .run(IDLE_INSTALL_KEY, JSON.stringify({ ...r, reported: true }), new Date().toISOString());
    } catch { /* logged twice at worst */ }
  }
  lastIdleInstall = { ...r, ok };
  return lastIdleInstall;
}

/** How the machine finds out whether Windows would stop an install nobody is there for. */
export interface ElevationProbe {
  platform: string;
  /** latest.yml's isAdminRightsRequired for the download (a per-machine install: true). Null: not known (taken as true). */
  adminRequired: boolean | null;
  /** Runs a Windows command; resolves with its exit code and output (never rejects). */
  run: (cmd: string, args: string[]) => Promise<{ code: number; out: string }>;
  /** A509: the "ZapTill Updater" task is installed — it installs with administrator rights, no prompt. */
  task?: () => Promise<boolean>;
}

/**
 * A508: why Windows would stop a SILENT install here (one phrase), or null when it would not. ZapTill installs per
 * machine (electron-builder.config.js nsis.perMachine — needed for the firewall rules in build/installer.nsh), so its
 * installer needs administrator rights and electron-updater starts it through elevate.exe. With nobody at the machine:
 *   - already elevated (net session succeeds), or an administrator account whose Windows elevates without asking
 *     (ConsentPromptBehaviorAdmin = 0) → no prompt: installs;
 *   - an administrator account with the usual UAC prompt, or a standard account (Windows asks for an administrator's
 *     password) → the prompt would wait on an empty shop with ZapTill already closed. Never done: it installs when
 *     ZapTill is next closed, as before, and the Tech page says why.
 */
export async function silentInstallBlocker(p: ElevationProbe): Promise<string | null> {
  if (p.platform !== 'win32') return null;
  if (p.adminRequired === false) return null;
  try {
    if (p.task && await p.task().catch(() => false)) return null;   // A509: the updater task installs with no prompt
    if ((await p.run('net', ['session'])).code === 0) return null;   // this process is already elevated
    const groups = await p.run('whoami', ['/groups']);
    if (groups.code !== 0) return 'Windows could not say whether it would ask for an administrator\'s permission';
    if (!/S-1-5-32-544/i.test(groups.out)) return 'this Windows account is not an administrator, so Windows would ask for an administrator\'s password';
    const q = await p.run('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System', '/v', 'ConsentPromptBehaviorAdmin']);
    const m = /ConsentPromptBehaviorAdmin\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(q.out);
    if (q.code === 0 && m && parseInt(m[1], 16) === 0) return null;   // administrators elevate without a prompt
    return 'Windows asks for permission (UAC) before an install, and nobody is there to give it';
  } catch (e: any) {
    return `Windows could not say whether it would ask for permission (${e?.message ?? e})`;
  }
}

export interface IdleInstallDeps {
  running: string;
  /** The update downloaded and ready (null: none), and whether the cloud still approves it (A503). */
  candidate: () => { version: string | null; approved: boolean };
  isServer: () => boolean;
  /** A496: a branch server holds the branch's copy of `version` ready for its tills. */
  shareReady: (version: string) => boolean;
  /** silentInstallBlocker for this download. */
  blocker: () => Promise<string | null>;
  activity: () => ActivitySnapshot;
  quiet: (now: number) => boolean;
  downloadedAt: (version: string) => number | null;
  syncSince: () => number | null;
  flush: (timeoutMs: number) => Promise<{ pushed: number; errors: string[]; timedOut: boolean }>;
  /** Lets the window close and keeps server mode's start-with-Windows (serverMode.markQuitting). */
  markQuitting: () => void;
  stopNodeServer: () => void;
  record: (r: IdleInstallRecord) => void;
  closeDb: () => void;
  quitAndInstall: (isSilent: boolean, isForceRunAfter: boolean) => void;
  log: (line: string) => void;
  /** Told the current "why not yet" (the Tech page). */
  note?: (line: string | null) => void;
  /** An idle install of `version` was started before and this machine came back on the old version. */
  failedBefore?: (version: string) => boolean;
  now?: () => number;
  flushMs?: number;
  /**
   * A509: install through the updater task — null: no task here (quitAndInstall, as before); ok: the script checked the
   * installer and waits for ZapTill to close; refused: ZapTill keeps running and installs the update when closed.
   */
  viaTask?: (version: string) => Promise<TaskInstallResult | null>;
  /** A509: electron-updater's autoInstallOnAppQuit — off once the task has the install (no double install). */
  installOnQuit?: (on: boolean) => void;
  /** A509: quit ZapTill (the task installs it once it has closed, and starts it again). */
  quit?: () => void;
  /** A541: told, each minute something is downloaded, why it cannot install by itself here (null: it can) — the report. */
  onBlocker?: (blocker: string | null) => void;
}

/** A509: after the updater task refused a version, the idle install does not ask again for this long. */
export const TASK_REFUSED_RETRY_MS = 6 * 60 * 60_000;

/** A508: the minute check. tick() → the verdict; when it says install, the install sequence runs (once). */
export function createIdleInstaller(d: IdleInstallDeps) {
  const now = d.now ?? Date.now;
  let installing = false;
  let lastSaid = '';
  let refused: { version: string; at: number; reason: string } | null = null;   // A509
  async function tick(): Promise<{ install: boolean; reason: string }> {
    if (installing) return { install: false, reason: 'the install is already under way' };
    const t = now();
    const c = d.candidate();
    const server = d.isServer();
    const a = d.activity();
    const v = c.version;
    const state: InstallState = {
      running: d.running, downloaded: v, approved: c.approved,
      downloadedAt: v ? d.downloadedAt(v) : null,
      shareReady: !v || !server || d.shareReady(v),
      blocker: null, busy: a.busy,
      lastActivity: server ? Math.max(a.lastUse, a.lastTill) : a.lastUse,
      lastTill: server ? a.lastTill : 0,
      quietNow: d.quiet(t), syncSince: d.syncSince(),
    };
    // The Windows question only once there is something to install (it runs three small commands, cached by the caller).
    if (v && c.approved) state.blocker = await d.blocker().catch((e: any) => `Windows could not be asked (${e?.message ?? e})`);
    // An idle install of this very version that did not take (the machine came back on the old one) is not tried again
    // and again — once is enough; it installs when ZapTill is closed.
    if (v && !state.blocker && d.failedBefore?.(v)) state.blocker = 'an earlier install of it while idle did not take';
    if (v && !state.blocker && refused && refused.version === v && t - refused.at < TASK_REFUSED_RETRY_MS) state.blocker = `the updater task refused it (${refused.reason})`;
    try { d.onBlocker?.(v && c.approved ? state.blocker : null); } catch { /* never stops the check */ }   // A541
    const verdict = installVerdict(state, t);
    if (!verdict.install) {
      d.note?.(v ? verdict.reason : null);
      // One line when the reason changes (not one a minute: "in use 3 min ago" → "4 min ago" is the same reason).
      const gist = verdict.reason.replace(/\d+/g, '#');
      if (v && gist !== lastSaid) { lastSaid = gist; d.log(`idle install of ${v}: ${verdict.reason}`); }
      return verdict;
    }
    installing = true;
    const r = await runIdleInstall(d, server, d.running, v!, verdict.reason, now);
    if (!r.started) {   // A509: the task refused — ZapTill kept running; not asked again for a while
      installing = false;
      refused = { version: v!, at: t, reason: r.reason };
      return { install: false, reason: r.reason };
    }
    return verdict;
  }
  return { tick, installing: () => installing };
}

/** The install itself: say it, push, record, stop serving, close the database, install silently and restart. */
export async function runIdleInstall(d: IdleInstallDeps, server: boolean, from: string, to: string, why: string,
                                     now: () => number = Date.now): Promise<{ started: boolean; reason: string }> {
  const step = (what: string, f: () => void) => { try { f(); } catch (e: any) { d.log(`idle install: ${what} failed (${e?.message ?? e}) — going on`); } };
  d.log(`installing ${to} now while nobody is using this ${server ? 'branch server' : 'till'} (${why}) — ZapTill restarts on its own in a minute or two`);
  d.note?.(`installing ${to} (${why})`);
  try {
    const f = await d.flush(d.flushMs ?? 60_000);
    if (f.timedOut || f.errors.length) d.log(`the sync before the install did not finish (${f.errors.slice(0, 2).join('; ') || 'no answer'}) — what is left is kept on this machine and goes up after the restart`);
  } catch (e: any) { d.log(`the sync before the install failed (${e?.message ?? e}) — what is left goes up after the restart`); }
  // A509: the updater task checks the download BEFORE anything is stopped — a refusal (offline, a policy, antivirus)
  // leaves ZapTill exactly as it was, still serving, and the update installs when it is next closed.
  let task: TaskInstallResult | null = null;
  if (d.viaTask) task = await d.viaTask(to).catch((e: any) => ({ ok: false as const, reason: `the updater task could not be asked (${e?.message ?? e})` }));
  if (task && !task.ok) {
    d.log(`idle install of ${to}: ${task.reason} — ZapTill keeps running; it installs when it is next closed`);
    d.note?.(`${task.reason} — it installs when ZapTill is closed`);
    return { started: false, reason: task.reason };
  }
  step('recording it', () => d.record({ from, to, at: new Date(now()).toISOString(), reason: 'idle', why }));
  step('leaving server mode open', () => d.markQuitting());
  if (server) step('stopping the branch server', () => d.stopNodeServer());   // its tills see a clean disconnect and retry
  step('closing the database', () => d.closeDb());
  if (task?.ok) {
    // The script holds the checked copy and waits for ZapTill to close; it installs and starts ZapTill again (the
    // "ZapTill Relaunch" task, in the user's session). electron-updater must not install it a second time at quit.
    step('turning off install-on-quit', () => d.installOnQuit?.(false));
    d.quit?.();
    return { started: true, reason: 'the updater task' };
  }
  d.quitAndInstall(true /* silent */, true /* start ZapTill again after */);
  return { started: true, reason: 'electron-updater' };
}

/**
 * A509: at quit — the version to hand to the updater task, or null (the quit goes on: nothing downloaded, already
 * handed over, electron-updater already installing, install-on-quit off (A503), no task, or this close had its turn).
 */
export function closeInstallPlan(s: {
  platform: string; taskKnown: boolean | null; taskInstallStarted: boolean; closeTaskDone: boolean; quitAndInstallCalled: boolean;
  installOnQuit: boolean; state: UpdateState; version: string | null; installerPath: string | null;
}): string | null {
  if (s.platform !== 'win32' || s.taskKnown !== true || s.taskInstallStarted || s.closeTaskDone || s.quitAndInstallCalled) return null;
  if (!s.installOnQuit || s.state !== 'downloaded' || !s.version || !VERSION_RE.test(s.version) || !s.installerPath) return null;
  return s.version;
}

// ── A541: install at start-up — a branch server started at Windows sign-in installs its waiting update first ─────────
//
// Owner, 2026-10-20: "Something I have noticed since we added the autostart feature most apps are not updating, they are
// stuck in the old version." Since A513 (1.0.17) a branch server starts itself after sign-in, lives in the tray and is
// never closed (window-all-closed keeps it serving) — "installs when ZapTill is closed" practically never comes, and on a
// machine without the A509 updater task the idle install is refused (Windows would ask for permission with nobody
// there). Now, when ZapTill starts at sign-in with an approved, newer update already downloaded, it installs it BEFORE it
// serves the branch: through the updater task (no prompt), else electron-updater's installer (Windows may ask — somebody
// has just signed in, so somebody is there). Once per version: the attempt is recorded before anything is installed, so
// an install that does not take is never tried again at every start (it installs when ZapTill is closed, or idle);
// the start after the install is not a sign-in start, and the new version is not newer — no loop.

/** What electron-updater downloaded, kept across restarts (it is otherwise known only after the first check, 4 min in). */
export interface StagedUpdate { version: string; installerPath: string | null; approved: boolean; at: string }
export const STAGED_KEY = 'update_staged';
export const STARTUP_INSTALL_KEY = 'update_startup_install';

function readKept<T>(key: string): T | null {
  try {
    const row = getLocalDb().prepare(`SELECT value FROM maintenance_state WHERE key = ?`).get(key) as { value?: string } | undefined;
    return row?.value ? JSON.parse(row.value) as T : null;
  } catch { return null; }
}
function writeKept(key: string, value: unknown): void {
  try {
    getLocalDb().prepare(`INSERT OR REPLACE INTO maintenance_state (key, value, updated_at) VALUES (?, ?, ?)`)
      .run(key, JSON.stringify(value), new Date().toISOString());
  } catch (e: any) { try { logLine('update', `could not keep ${key}: ${e?.message ?? e}`); } catch { /* never */ } }
}
/** Written when a download lands (update-downloaded). Never throws. */
export function recordStaged(s: StagedUpdate): void { if (VERSION_RE.test(s.version)) { writeKept(STAGED_KEY, s); mirrorWaiting(); } }
export function readStaged(): StagedUpdate | null {
  const s = readKept<StagedUpdate>(STAGED_KEY);
  return s && typeof s.version === 'string' && VERSION_RE.test(s.version) ? s : null;
}
/** A503's answer at each check (withdrawn → false), kept with the download so a sign-in start obeys it offline too. */
export function noteStagedApproval(on: boolean): void {
  const s = readStaged();
  if (s && s.approved !== on) { writeKept(STAGED_KEY, { ...s, approved: on }); mirrorWaiting(); }
}
/**
 * A546: the kept download mirrored to update-waiting.json — the gate (startGate.ts) reads it before anything loads, so a
 * till's sign-in launch goes on only when there is something to install. A sign-in try of the same version is kept.
 */
export function mirrorWaiting(signinTried?: string): void {
  try {
    const dir = app.getPath('userData');
    const s = readStaged();
    const was = readUpdateWaiting(dir);
    const tried = signinTried ?? (was && s && was.version === s.version ? was.signinTried ?? null : null);
    writeUpdateWaiting(dir, s ? { version: s.version, approved: s.approved, signinTried: tried } : null);
  } catch { /* best effort — never stops an update */ }
}
export interface StartupInstallTry { version: string; from: string; at: string }
export function readStartupInstallTry(): StartupInstallTry | null {
  const t = readKept<StartupInstallTry>(STARTUP_INSTALL_KEY);
  return t && typeof t.version === 'string' ? t : null;
}

export interface StartupInstallInput {
  /** Started by Windows at sign-in (lowImpactStart.consumeSignInStart) — not by hand, not the restart task after a crash. */
  signInStart: boolean;
  /** The relaunch after an install (--updated). */
  updatedLaunch: boolean;
  running: string;
  staged: StagedUpdate | null;
  installerExists: boolean;
  /** The version a start-up install was already tried for (once per version). */
  triedVersion: string | null;
  server: boolean;
  /** A branch server holds the branch's copy of the version for its tills (A496 — never leave them without it). */
  shareReady: boolean;
  /** The cloud's answer now: the approved version, null = hold, undefined = not answered (the last answer stands). */
  cloudApproved?: string | null;
  /**
   * A546: a person opened the till (not Windows, not the restart task, not the relaunch after an update) — the backup:
   * an approved update waiting installs first, before the PIN screen ("Updating ZapTill…"). Never on a branch server.
   */
  openedByHand?: boolean;
  /**
   * A546: a till's sign-in launch — quiet: through the updater task only (no window, no Windows prompt — nobody may be
   * there), and ZapTill stays closed after (the next open runs the new version).
   */
  quiet?: boolean;
}

/** Pure: install the waiting update now, at start-up? */
export function startupInstallPlan(s: StartupInstallInput): { install: boolean; reason: string; withdrawn?: boolean } {
  const no = (reason: string, withdrawn = false) => ({ install: false, reason, ...(withdrawn ? { withdrawn } : {}) });
  if (s.updatedLaunch) return no('ZapTill has just been updated');
  if (s.openedByHand && s.server) return no('a branch server opened by hand — it installs at the next Windows sign-in, or when closed');   // A546: unchanged (A541)
  if (!s.signInStart && !s.openedByHand) return no('not a start at Windows sign-in (started by hand, or by the restart task) — only a sign-in start installs first');
  const v = s.staged?.version ?? null;
  if (!v || !VERSION_RE.test(v)) return no('no update downloaded');
  if (!VERSION_RE.test(s.running) || compareVersions(v, s.running) <= 0) return no(`${v} is not newer than ${s.running}`);
  if (s.triedVersion === v) return no(`an install of ${v} at start-up was tried once already and did not take — it installs when ZapTill is closed`);
  if (!s.staged!.approved) return no(`${v} is no longer approved — it will not be installed`);
  if (s.cloudApproved === null) return no(`the business is now on hold — ${v} will not be installed`, true);
  if (typeof s.cloudApproved === 'string' && VERSION_RE.test(s.cloudApproved) && compareVersions(s.cloudApproved, v) < 0) {
    return no(`the approved version is now ${s.cloudApproved} — ${v} will not be installed`, true);
  }
  if (!s.installerExists) return no(`the downloaded installer of ${v} is no longer on this machine — the next check downloads it again`);
  if (s.server && !s.shareReady) return no(`waiting: the branch's copy of ${v} for the tills is not ready yet`);
  return { install: true, reason: `${v} is downloaded and approved — installing it before ${s.server ? 'this server serves the branch' : s.quiet ? 'anyone opens the till (quietly, at Windows sign-in)' : 'the till opens'}` };
}

export interface StartupInstallDeps {
  input: () => StartupInstallInput;
  /** GET /api/desktop-update/status: the approved version, null = hold, undefined = no answer (offline, an error). */
  askCloud: () => Promise<string | null | undefined>;
  /** Drawers open on this machine (they are in the local database — a restart keeps them). */
  openDrawers: () => number;
  markTried: (t: StartupInstallTry) => void;
  withdraw: () => void;
  task: () => Promise<boolean>;
  /** A546: `relaunch` false at a till's quiet sign-in install (ZapTill stays closed; the next open runs the new version). */
  viaTask: (version: string, relaunch: boolean) => Promise<TaskInstallResult>;
  /** A546: a till opened by hand — the small "Updating ZapTill to 1.0.20 — about a minute" screen, and its close on a failure. */
  showUpdating?: (version: string) => void;
  hideUpdating?: () => void;
  /** A546 / A508: since when a sync push has been in flight (null: none) — a till opened by hand waits for it, at most 30 s. */
  syncSince?: () => number | null;
  sleep?: (ms: number) => Promise<void>;
  /** electron-updater: validate the download it holds (latest.yml from the cloud, the cached file's checksum). */
  prepareUpdater: (version: string) => Promise<{ ok: boolean; reason: string }>;
  record: (r: IdleInstallRecord) => void;
  /** Lets the window close and closes the database (markQuitting, closeLocalDb). */
  beforeQuit: () => void;
  /** The task holds the install: quit (it installs and starts ZapTill again). */
  quit: () => void;
  /** electron-updater's install with its progress visible and a start after (quitAndInstall(false, true)). */
  quitAndInstall: () => void;
  log: (line: string) => void;
  now?: () => number;
}

/** A541: the start-up install. Resolves installing=true when ZapTill is closing to install (the caller starts nothing). */
export async function runStartupInstall(d: StartupInstallDeps): Promise<{ installing: boolean; reason: string }> {
  const now = d.now ?? Date.now;
  const in0 = d.input();
  const first = startupInstallPlan(in0);
  if (!first.install) {
    // Said only when something newer is waiting at a sign-in start (not at every start by hand).
    const waiting = in0.signInStart && !in0.updatedLaunch && !!in0.staged && VERSION_RE.test(in0.running) && compareVersions(in0.staged.version, in0.running) > 0;
    if (waiting) d.log(`start-up install: ${first.reason}`);
    return { installing: false, reason: first.reason };
  }
  const cloudApproved = await d.askCloud().catch(() => undefined);
  const input = { ...d.input(), cloudApproved };
  const plan = startupInstallPlan(input);
  if (!plan.install) {
    if (plan.withdrawn) { try { d.withdraw(); } catch { /* never */ } }
    d.log(`start-up install: ${plan.reason}`);
    return { installing: false, reason: plan.reason };
  }
  const v = input.staged!.version;
  const from = input.running;
  // A546: a till's quiet sign-in launch installs through the updater task only — without it Windows would ask, and
  // nobody may be at the till (owner: no window at start). Asked BEFORE the try is recorded: nothing was tried, so the
  // till opened by hand later still installs it (with the Windows prompt — somebody is there).
  const quiet = input.quiet === true;
  const byHand = !quiet && input.openedByHand === true && !input.signInStart;
  if (quiet && !(await d.task().catch(() => false))) {
    const why = 'no ZapTill Updater task on this PC — Windows would ask for permission and nobody may be at the till';
    d.log(`start-up install: ${v} not installed at Windows sign-in: ${why}; it installs the next time ZapTill is opened (Windows will ask)`);
    return { installing: false, reason: why };
  }
  d.log(`start-up install: ${plan.reason}${cloudApproved === undefined ? ' (the cloud did not answer — the last answer stands)' : ''}`);
  if (byHand) {
    try { d.showUpdating?.(v); } catch { /* never stops the install */ }
    // A508's rule: a sync push under way is never cut — waited for here, at most 30 s (sales are safe in SQLite anyway).
    const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const t0 = now();
    let waited = false;
    while (d.syncSince && d.syncSince() !== null && now() - t0 < OPEN_SYNC_WAIT_MS) { waited = true; await sleep(500); }
    if (waited) d.log(`start-up install: ${d.syncSince?.() === null ? 'the sync push under way finished' : `a sync push still under way after ${OPEN_SYNC_WAIT_MS / 1000} s — what is left goes up after the update`}`);
  }
  let drawers = 0;
  try { drawers = d.openDrawers(); } catch { /* not known */ }
  if (drawers > 0) d.log(`start-up install: ${drawers} drawer${drawers === 1 ? ' is' : 's are'} open on this machine — kept as they are (the local database); ZapTill comes back with ${drawers === 1 ? 'it' : 'them'} open`);
  // Once per version, recorded BEFORE anything is installed — an install that does not take is not tried at every start.
  d.markTried({ version: v, from, at: new Date(now()).toISOString() });
  const when = quiet ? 'at Windows sign-in (quietly)' : byHand ? 'when ZapTill was opened' : 'at sign-in';
  const go = (how: string) => {
    try { d.record({ from, to: v, at: new Date(now()).toISOString(), reason: 'startup', why: how }); } catch { /* never */ }
    try { d.beforeQuit(); } catch (e: any) { d.log(`start-up install: closing for the install: ${e?.message ?? e} — going on`); }
  };
  const failed = (reason: string) => {
    if (byHand) { try { d.hideUpdating?.(); } catch { /* never */ } }
    return { installing: false, reason };
  };
  if (await d.task().catch(() => false)) {
    const r = await d.viaTask(v, !quiet).catch((e: any) => ({ ok: false as const, reason: `the updater task could not be asked (${e?.message ?? e})` }));
    if (r.ok) { go(`the updater task, ${when}`); d.quit(); return { installing: true, reason: 'the updater task' }; }
    if (quiet) {
      d.log(`start-up install: ${r.reason} — not installed at Windows sign-in (no prompt with nobody there); it installs the next time ZapTill is opened`);
      return failed(r.reason);
    }
    d.log(`start-up install: ${r.reason} — trying the installer instead (Windows may ask for permission; somebody is at the ${byHand ? 'till' : 'machine — they have just signed in'})`);
  }
  const p = await d.prepareUpdater(v).catch((e: any) => ({ ok: false, reason: String(e?.message ?? e) }));
  if (!p.ok) {
    d.log(`start-up install of ${v} not done: ${p.reason} — ZapTill starts as usual; it installs when ZapTill is closed`);
    return failed(p.reason);
  }
  go(`the installer, ${when}`);
  d.quitAndInstall();
  return { installing: true, reason: 'electron-updater' };
}
/** A546: a till opened by hand waits at most this long for a sync push under way before it installs. */
export const OPEN_SYNC_WAIT_MS = 30_000;
/** A546: the manual-open install's own record (once per version, apart from A541's sign-in one). */
export const OPEN_INSTALL_KEY = 'update_open_install';

/** Set by initAutoUpdate (a packaged build only): the start-up install with the real pieces. */
/** A546: how this start came about — `quiet`: a till's sign-in launch; `openedByHand`: a person opened the till. */
export interface StartInstallMode { signInStart: boolean; updatedLaunch: boolean; openedByHand?: boolean; quiet?: boolean }
let startupInstaller: ((o: StartInstallMode) => Promise<boolean>) | null = null;
/**
 * A541: called by index.ts after the database is open and BEFORE the branch server serves or a window opens. True: ZapTill
 * is closing to install its update (index.ts starts nothing more). Never throws; false in dev and on a manual start.
 */
export async function installAtStartIfDue(o: StartInstallMode): Promise<boolean> {
  if (!startupInstaller) return false;
  try { return await startupInstaller(o); } catch (e: any) { noteUpdate(`start-up install failed: ${e?.message ?? e} — ZapTill starts as usual`); return false; }
}

export function initAutoUpdate(): void {
  if (!app.isPackaged) return;                 // dev has no feed/installer to swap
  if (app.getName().toLowerCase().includes('dev')) {
    console.log('[autoUpdate] dev flavour — auto-update disabled');
    return;
  }
  if (started) return;                         // idempotent
  started = true;

  // A489: a till behind a branch server downloads its update from the server over TLS — electron-updater's own session
  // (partition 'electron-updater', created exactly as electron-updater creates it) trusts the pinned certificate.
  // A496: verified under Electron (test/update-delivery-electron.test.mjs) — net.request on that session accepts the
  // pinned certificate and refuses any other.
  try { trustPinnedNodeIn(session.fromPartition('electron-updater', { cache: false })); }
  catch (e: any) { console.warn('[autoUpdate] could not trust the branch server certificate for downloads:', e?.message ?? e); }

  const running = app.getVersion();
  // A534: where this machine's update is, told to the cloud (admin portal › Desktop updates) — only once the cloud says it
  // takes it (the status answer's reportsState), on a change, and at least every 30 minutes. Through the branch server's
  // gateway on a till behind one (cloudFetch, A410), with the till's own session (renewed once on a 401).
  const reporter = createUpdateReporter({
    build: () => currentUpdateReport(),
    post: async (body) => {
      const cloud = (() => { try { return getCloudUrl(); } catch { return null; } })();
      if (!cloud) return { status: 0 };
      const go = (tok: string) => cloudFetch(`${String(cloud).replace(/\/+$/, '')}/api/desktop-update/state`, {
        method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
      });
      let tok = readSessionTokens().token;
      if (!tok) return { status: 0 };
      let res = await go(tok);
      if (res.status === 401 && await refreshAccessToken().catch(() => false)) {
        tok = readSessionTokens().token;
        if (tok) res = await go(tok);
      }
      return { status: res.status };
    },
    log: noteUpdate,
  });
  // A496: per version, since when the branch server has said "not ready" (a till stops waiting after TILL_WAIT_LIMIT_MS).
  const waitingSince = new Map<string, number>();
  const loop = createUpdateLoop({
    status: () => current,
    set,
    running,
    // A496: by ROLE, never by "the listener has bound yet" — at launch the server's port was still null, so its first
    // check went straight to the cloud for itself and never fetched the branch's copy.
    isServer: () => isNodeRole(getDeviceConfig()?.device_role ?? null),
    log: noteUpdate,
    // A503: read by electron-updater when ZapTill quits — a download no longer approved is not installed.
    // A517: not loaded yet → nothing downloaded in this run (withdrawn needs one), and it loads with install-on-quit on —
    // an up-to-date or held till's check never loads electron-updater just to set it.
    installOnQuit: (on) => {
      if (updaterIfLoaded()) autoUpdater.autoInstallOnAppQuit = on;
      noteStagedApproval(on);   // A541: a sign-in start obeys the last answer, offline too
    },
    askServer: () => askBranchServer({ cfg: getDeviceConfig() as any, running, fetch: lanFetch as typeof fetch }),
    behindServer: () => asksBranchServer(getDeviceConfig() as any),   // A554
    checkDeps: ({ running: next }) => {
      const cfg = getDeviceConfig();
      const server = isNodeRole(cfg?.device_role ?? null);
      return {
        updater: autoUpdater as any,
        fetch: ((u: any, i: any) => cloudFetch(String(u), i)) as typeof fetch,   // A410: through the branch server on a peer
        // A489: the branch server's address as https:// once this till pins its certificate.
        route: (c) => { const r = cloudBaseFor(c, getDeviceConfig()); return { ...r, base: lanUrl(r.base) }; },
        cloudUrl: () => { try { return getCloudUrl(); } catch { return null; } },
        token: () => readSessionTokens().token || null,
        refresh: () => refreshAccessToken(),
        running: next,
        log: noteUpdate,
        cloudReportsState: (yes) => reporter.setCloudTakes(yes),   // A534
        // A443: the branch server fetches the approved version once for the branch and updates itself from that copy.
        // A443: a till behind a branch server waits until the server holds the approved version (it then downloads it
        // from the server over the shop network). A server that does not answer the question (an older build) → as before.
        // A496: and never waits for ever (tillShareVerdict).
        share: !server && cfg?.node_url ? {
          prepare: async (v) => {
            const a = await askBranchServer({ cfg: cfg as any, running, fetch: lanFetch as typeof fetch, want: v });
            const since = a && a.version !== v ? (waitingSince.get(v) ?? Date.now()) : null;
            if (since !== null) waitingSince.set(v, since); else waitingSince.delete(v);
            const t = tillShareVerdict(a, v, since, Date.now());
            noteUpdate(t.reason);
            return t.verdict;
          },
          route: () => null,
        } : server && cfg?.node_secret ? {
          prepare: (v) => prepareShare(v, {
            fetch: globalThis.fetch, dir: shareDir(),
            cloudUrl: () => { try { return getCloudUrl(); } catch { return null; } },
            token: () => readSessionTokens().token || null,
            refresh: () => refreshAccessToken(),
            log: noteUpdate,
          }),
          approved: (v) => noteApprovedForShare(v),
          // A496: the port read when the route is needed (null in the first moments after launch → the cloud directly).
          route: () => {
            const port = getNodePort();
            return port ? { base: `http://127.0.0.1:${port}/node/cloud`, headers: { 'X-Node-Secret': String(cfg.node_secret) } } : null;
          },
        } : undefined,
      };
    },
  });

  let lastPct = -1;
  // A517: applied the moment electron-updater loads (realUpdater above) — before its first check or download. The
  // parameter is the real updater, so these lines read as they did when it was imported at the top.
  onUpdaterLoaded = (autoUpdater) => {
  autoUpdater.autoDownload = true;             // fetch in the background
  autoUpdater.autoInstallOnAppQuit = true;     // still swap on a normal quit — never mid-run
  autoUpdater.allowPrerelease = false;
  autoUpdater.on('error', (err) => {
    // Never throw: an update failure must not stop a till trading.
    noteUpdate(`check/download failed: ${err?.message ?? err} — tried again on the next check`);
    set({ state: 'error', note: `the last attempt failed: ${String(err?.message ?? err).slice(0, 160)}` });
  });
  autoUpdater.on('checking-for-update', () => { loop.touch(); set({ state: 'checking' }); });
  autoUpdater.on('update-available', (info) => {
    loop.touch();
    noteUpdate(`newer version available: ${info?.version} — downloading`);
    set({ state: 'available', version: info?.version ?? null, note: `downloading ${info?.version}` });
  });
  autoUpdater.on('update-not-available', () => set({ state: 'idle' }));
  autoUpdater.on('download-progress', (p) => {
    loop.touch();
    const pct = Math.round(p?.percent ?? 0);
    if (Math.floor(pct / 25) !== Math.floor(lastPct / 25)) noteUpdate(`downloading ${current.version ?? ''}: ${pct}%`);
    lastPct = pct;
    set({ state: 'downloading', percent: pct });
  });
  autoUpdater.on('update-downloaded', (info) => {
    noteUpdate(`downloaded ${info?.version} — it installs when ZapTill is next closed`);
    // A541: kept across restarts (a sign-in start installs it before serving), and since when (the managers' notice).
    const v = typeof info?.version === 'string' ? info.version : null;
    let at: number | null = null;
    if (v && VERSION_RE.test(v)) {
      const file = typeof (info as any)?.downloadedFile === 'string' ? (info as any).downloadedFile as string : downloadedInstaller();
      recordStaged({ version: v, installerPath: file, approved: true, at: new Date().toISOString() });
      at = downloadedSince(v);
    }
    set({ state: 'downloaded', version: info?.version ?? null, percent: 100, note: `${info?.version} downloaded — installs when ZapTill is closed`, downloadedAt: at });
  });

  // A348: each download request goes through the cloud's approval check — no range-by-range differential download.
  autoUpdater.disableDifferentialDownload = true;
  // A509 / A513: the updater task is asked once there is something to install (see below).
  autoUpdater.on('update-downloaded', () => { void updaterTaskAvailable(); });
  };

  // A508: what the last idle install did (logged once after its restart; the Tech page shows it).
  try { reportIdleInstall(running); } catch { /* never stops the updater */ }
  // A508: every minute — may the downloaded update install now, with nobody there? (installVerdict)
  let elevation: { version: string; at: number; answer: Promise<string | null> } | null = null;
  const idle = createIdleInstaller({
    running,
    candidate: () => {
      const v = current.state === 'downloaded' ? current.version : null;
      return { version: v, approved: !!v && loop.installableVersion() === v };
    },
    isServer: () => isNodeRole(getDeviceConfig()?.device_role ?? null),
    shareReady: (v) => !!readyVersion(shareDir(), v),
    // Asked once per download and again every 6 hours (a technician may change the account or UAC meanwhile).
    blocker: () => {
      const v = current.version ?? '';
      if (!elevation || elevation.version !== v || Date.now() - elevation.at > 6 * ONE_HOUR) {
        const info = (autoUpdater as any).downloadedUpdateHelper?.downloadedFileInfo;
        elevation = { version: v, at: Date.now(), answer: silentInstallBlocker({
          platform: process.platform,
          task: () => updaterTaskAvailable(),   // A509
          adminRequired: typeof info?.isAdminRightsRequired === 'boolean' ? info.isAdminRightsRequired : null,
          run: (cmd, args) => new Promise((resolve) => {
            execFile(cmd, args, { windowsHide: true, timeout: 15_000 }, (err, out) => resolve({ code: err ? (typeof (err as any).code === 'number' ? (err as any).code : 1) : 0, out: String(out ?? '') }));
          }),
        }) };
      }
      return elevation.answer;
    },
    activity: () => activitySnapshot(),
    quiet: (t) => {
      const cfg = getDeviceConfig();
      return loadUsageProfile({ server: isNodeRole(cfg?.device_role ?? null), deviceId: cfg?.device_id ?? null }, t).quiet[hourOfWeek(t)];
    },
    downloadedAt: (v) => downloadedSince(v),
    syncSince: () => syncPushSince(),
    flush: (ms) => flushBeforeInstall(ms),
    markQuitting: () => markQuitting(),
    stopNodeServer: () => stopNodeServer(),
    record: (r) => recordIdleInstall(r),
    closeDb: () => closeLocalDb(),
    // A509: through the updater task when this machine has it (no Windows prompt), else quitAndInstall below.
    viaTask: async (v) => (await updaterTaskAvailable()) ? installThroughTask(v, true) : null,
    installOnQuit: (on) => { autoUpdater.autoInstallOnAppQuit = on; },
    quit: () => {
      app.quit();
      // A quit held up (a window refusing to close) must not leave the script waiting: ZapTill is ended after a minute.
      setTimeout(() => app.exit(0), 60_000);
    },
    quitAndInstall: (silent, runAfter) => {
      closeTaskDone = true;   // A509: this install goes through electron-updater, not the close path
      autoUpdater.quitAndInstall(silent, runAfter);
      // The installer did not start (electron-updater found no file, or refused): ZapTill is not left half-shut — the
      // database closed and the server stopped — it starts again as it was, and the update waits for the next chance.
      setTimeout(() => {
        noteUpdate('the idle install did not start — ZapTill restarts as it was; the update installs when it is next closed');
        app.relaunch(); app.exit(0);
      }, 2 * 60_000);
    },
    log: noteUpdate,
    note: (line) => { idleNote = line; },
    onBlocker: (b) => { idleBlocker = b; },   // A541: the report says why it cannot install by itself
    // A541: an idle install that did not take (a start-up one that did not is tried again once while idle).
    failedBefore: (v) => !!lastIdleInstall && !lastIdleInstall.ok && lastIdleInstall.to === v && lastIdleInstall.reason !== 'startup',
  });
  const startIdleTicks = () => setInterval(() => { void idle.tick().catch((e: any) => noteUpdate(`idle install check failed: ${e?.message ?? e}`)); }, 60_000);

  // A541: the start-up install (index.ts asks it before the branch server serves) — see runStartupInstall.
  {
    // A546: a try when the till was opened by hand counts too (its own record).
    for (const tried of [readStartupInstallTry(), readKept<StartupInstallTry>(OPEN_INSTALL_KEY)]) {
      if (tried && typeof tried.version === 'string' && VERSION_RE.test(tried.version) && compareVersions(tried.version, running) > 0) startupInstallFailed = tried.version;
    }
  }
  mirrorWaiting();   // A546: the gate's file follows the kept download (a till upgraded to this build has none yet)
  startupInstaller = async ({ signInStart, updatedLaunch, openedByHand, quiet }) => {
    // A546: the manual open has its own once-per-version record — a quiet sign-in try that did not take does not stop it.
    const byHand = !signInStart && !quiet && openedByHand === true;
    const triedKey = byHand ? OPEN_INSTALL_KEY : STARTUP_INSTALL_KEY;
    let splash: BrowserWindow | null = null;
    const r = await runStartupInstall({
      input: () => {
        const staged = readStaged();
        const cfg = getDeviceConfig();
        const server = isNodeRole(cfg?.device_role ?? null);
        let exists = false;
        try { exists = !!staged?.installerPath && fs.existsSync(staged.installerPath); } catch { exists = false; }
        return { signInStart, updatedLaunch, running, staged, installerExists: exists,
          triedVersion: readKept<StartupInstallTry>(triedKey)?.version ?? null, server,
          shareReady: !staged || !server || !!readyVersion(shareDir(), staged.version),
          openedByHand: byHand, quiet: quiet === true };
      },
      askCloud: async () => {
        const cloud = (() => { try { return getCloudUrl(); } catch { return null; } })();
        const tok = readSessionTokens().token;
        if (!cloud || !tok) return undefined;
        const res = await cloudFetch(`${String(cloud).replace(/\/+$/, '')}/api/desktop-update/status`, {
          headers: { Authorization: `Bearer ${tok}` }, signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) return undefined;
        const b = await res.json() as { approvedVersion?: unknown };
        return typeof b?.approvedVersion === 'string' ? b.approvedVersion : b?.approvedVersion === null ? null : undefined;
      },
      openDrawers: () => Number((getLocalDb().prepare(`SELECT COUNT(*) AS n FROM shifts WHERE status = 'open' AND COALESCE(device_id,'') = COALESCE(?,'')`).get(getDeviceConfig()?.device_id ?? null) as { n?: number } | undefined)?.n ?? 0),   // this machine's own drawers
      markTried: (t) => { writeKept(triedKey, t); },
      withdraw: () => noteStagedApproval(false),
      task: () => updaterTaskAvailable(true),
      viaTask: async (v, relaunch) => {
        const s = readStaged();
        const r = await requestTaskInstall(defaultTaskDeps(), { version: v, installerPath: s?.installerPath ?? '', relaunch, timeoutMs: 90_000 });
        if (r.ok) { taskInstallStarted = true; noteUpdate(`the updater task checked ${v} against the official release — ZapTill closes now and ${relaunch ? 'starts again' : 'stays closed (a till at Windows sign-in: the next open runs the new version)'} after the install`); }
        return r;
      },
      // A546: a till opened by hand — a small screen while it installs (somebody is there), never at a quiet sign-in.
      showUpdating: (v) => { splash = updatingWindow(v); },
      hideUpdating: () => { try { splash?.destroy(); } catch { /* gone */ } splash = null; },
      syncSince: () => syncPushSince(),
      prepareUpdater: async (v) => {
        // The one cloud-gated check (runUpdateCheck, A348): latest.yml for the approved version from the cloud, then
        // electron-updater finds its cached file (checksum) and says 'update-downloaded'. No share: before serving, a
        // server asks the cloud itself (its own copy is the same release).
        const r = await runUpdateCheck({
          updater: autoUpdater as any,
          fetch: ((u: any, i: any) => cloudFetch(String(u), i)) as typeof fetch,
          route: (c) => { const x = cloudBaseFor(c, getDeviceConfig()); return { ...x, base: lanUrl(x.base) }; },
          cloudUrl: () => { try { return getCloudUrl(); } catch { return null; } },
          token: () => readSessionTokens().token || null,
          refresh: () => refreshAccessToken(),
          running, log: noteUpdate, checkTimeoutMs: 60_000,
        });
        if (r.decision !== 'update' || r.timedOut) return { ok: false, reason: r.reason ?? `the update feed did not offer ${v}` };
        if (r.approved !== v) return { ok: false, reason: `the cloud now approves ${r.approved} — it downloads that instead` };
        const until = Date.now() + 60_000;
        while (Date.now() < until) {
          if (current.state === 'downloaded' && current.version === v) return { ok: true, reason: 'the download is checked' };
          if (current.state === 'error') break;
          await new Promise((r) => setTimeout(r, 500));
        }
        return { ok: false, reason: current.state === 'downloading' ? `${v} is being downloaded again (${current.percent ?? 0}%)` : `the download of ${v} could not be checked (${current.note ?? current.state})` };
      },
      record: (r) => recordIdleInstall(r),
      beforeQuit: () => { markQuitting(); closeLocalDb(); },
      quit: () => { const u = updaterIfLoaded(); if (u) u.autoInstallOnAppQuit = false; app.quit(); setTimeout(() => app.exit(0), 60_000); },
      quitAndInstall: () => {
        closeTaskDone = true;
        autoUpdater.quitAndInstall(false /* the progress shows — somebody has just signed in */, true);
        setTimeout(() => { noteUpdate('the start-up install did not start — ZapTill starts again as it was'); app.relaunch(); app.exit(0); }, 2 * 60_000);
      },
      log: noteUpdate,
    });
    // A546: a till's sign-in launch tries each version once — installed, or not (no updater task, a refusal, withdrawn):
    // the next sign-ins end at once again; the next open by hand installs it.
    if (quiet) mirrorWaiting(readStaged()?.version ?? undefined);
    return r.installing;
  };

  // A509: install-on-close through the updater task too (no Windows prompt when the till is shut at night). ZapTill is
  // held open (its windows already gone) while the script checks the download — at most 90 s; refused or no answer →
  // electron-updater installs it as before (elevate.exe: Windows asks — somebody is closing it).
  // A513: asked only once there is something to install (a schtasks at every start, and every hour, for nothing
  // before) — when the download lands (the 'update-downloaded' listener set when the updater loads, above), and hourly
  // while it waits; the idle install's own check asks it too.
  setInterval(() => { if (current.state === 'downloaded') void updaterTaskAvailable(); }, ONE_HOUR);
  app.on('will-quit', (e) => {
    // A517: electron-updater never loaded in this run → nothing was downloaded, nothing to install; not loaded to say so.
    const loaded = updaterIfLoaded();
    if (!loaded) return;
    const plan = closeInstallPlan({
      platform: process.platform, taskKnown, taskInstallStarted, closeTaskDone,
      quitAndInstallCalled: !!(loaded as any).quitAndInstallCalled,
      installOnQuit: loaded.autoInstallOnAppQuit, state: current.state, version: current.version,
      installerPath: downloadedInstaller(),
    });
    if (!plan) return;
    e.preventDefault();
    closeTaskDone = true;
    noteUpdate(`ZapTill is closing with ${plan} downloaded — installing it through the updater task`);
    void installThroughTask(plan, false, 90_000).then((r) => {
      if (!r.ok) noteUpdate(`${r.reason} — installing ${plan} the old way as ZapTill closes (Windows asks for permission)`);
    }).catch(() => { /* the old way */ }).finally(() => app.quit());
  });

  // A513: nothing at launch. The first check (and the server question, the hourly beat, the idle install's minute)
  // begins once the start-up sequence is over AND at least UPDATE_AFTER_LAUNCH_MS after launch — Windows and the
  // till's own start come first. The idle install never sees the start-up as idle (activityTracker counts a launch
  // as use, and nothing is downloaded before this first check).
  whenStartupSettled(() => {
    noteUpdate('the first update check, now that ZapTill has started');
    void loop.check('start');
    setInterval(() => { void loop.check('hourly'); }, ONE_HOUR);
    // A443: a till behind a branch server asks it every 2 minutes (and now, at start — a till that was off asks as soon as
    // it is back): told of a newer version the server holds, it checks with the cloud at once and takes it from the server.
    void loop.ask();
    setInterval(() => { void loop.ask(); }, 2 * 60_000);
    // A534: the update state to the cloud — a look every minute; sent only on a change or every 30 minutes.
    setInterval(() => { void reporter.tick(); }, 60_000);
    startIdleTicks();
  }, { minSinceLaunchMs: UPDATE_AFTER_LAUNCH_MS, afterMs: UPDATE_AFTER_SETTLED_MS });
  // A443: a till asked this server for a version it does not hold yet — check now (at most every 5 minutes).
  let lastAsked = 0;
  onShareWanted(() => {
    if (Date.now() - lastAsked < 5 * 60_000) return;
    lastAsked = Date.now();
    void loop.check('a till asked for a version this server does not hold');
  });
}
