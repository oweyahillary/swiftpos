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
import { autoUpdater } from 'electron-updater';
import { getCloudUrl, getDeviceConfig } from './deviceConfig';
import { cloudFetch, cloudBaseFor } from './cloudGateway';
import { readSessionTokens } from './tokenStore';
import { refreshAccessToken } from './syncEngine';
import { isNodeRole } from './deviceConfig';
import { getNodePort } from './nodeServer';
import { prepareShare, shareDir, onShareWanted, noteApprovedForShare } from './updateShare';   // A443
import { lanFetch, lanUrl, trustPinnedNodeIn } from './lanTls';   // A489
import { logLine } from './logFile';

const ONE_HOUR = 60 * 60 * 1000;   // A348: the approval check is one small JSON call

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
}

let current: UpdateStatus = { state: 'idle', version: null, percent: null, note: null, checkedAt: null, approved: null };

/** The renderer polls this on mount (in case it missed the push while loading). */
export function getUpdateStatus(): UpdateStatus { return current; }

// ── A496: diagnostics — why a till did (not) update, in words a support person can read ─────────────────────────────
const diag: Array<{ at: string; line: string }> = [];
/** One decision, logged to the app log ('update' scope) and kept (the last 40) for the Tech page. */
export function noteUpdate(line: string, now = new Date()): void {
  diag.push({ at: now.toISOString(), line });
  if (diag.length > 40) diag.splice(0, diag.length - 40);
  try { logLine('update', line); } catch { /* logging never stops an update */ }
}
/** What the Tech page shows: the status, and the last decisions with their times (newest last). */
export function getUpdateDiagnostics(): { status: UpdateStatus; running: string | null; log: Array<{ at: string; line: string }> } {
  let running: string | null = null;
  try { running = app.getVersion(); } catch { /* tests */ }
  return { status: current, running, log: diag.slice() };
}
/** Tests only. */
export function _resetUpdateDiagnostics(): void { diag.length = 0; current = { state: 'idle', version: null, percent: null, note: null, checkedAt: null, approved: null }; }

function broadcast(): void {
  for (const w of BrowserWindow.getAllWindows()) {
    try { w.webContents.send('update:status', current); } catch { /* window gone; ignore */ }
  }
}

function set(patch: Partial<UpdateStatus>): void {
  current = { ...current, ...patch };
  broadcast();
}

/**
 * Apply a downloaded update NOW, with the NSIS progress visible and a relaunch after. Only
 * meaningful once state === 'downloaded'; a no-op otherwise so a stray call can never
 * half-restart a trading till. The manager gate is enforced in the IPC handler (isManager())
 * AND at the call site (banner PIN) — see ipcHandlers 'update:installNow'.
 */
export function installUpdateNow(): { ok: boolean; reason?: string } {
  if (!app.isPackaged) return { ok: false, reason: 'not packaged' };
  if (current.state !== 'downloaded') return { ok: false, reason: 'no update downloaded' };
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
    const body = await res.json() as { approvedVersion?: unknown };
    approved = typeof body?.approvedVersion === 'string' ? body.approvedVersion : null;
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
  if (!c || !node || isNodeRole(c.device_role ?? null)) return null;
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
      d.set({ checkedAt, approved: r.approved, note, ...(r.timedOut ? { state: 'error' as const } : {}) });
      return r;
    } finally { busy = false; }
  }

  /** A till behind a branch server: "is there a newer one?" — told yes, it checks now. */
  async function ask(): Promise<void> {
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

  return { check, ask, touch, stalled };
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

  autoUpdater.autoDownload = true;             // fetch in the background
  autoUpdater.autoInstallOnAppQuit = true;     // still swap on a normal quit — never mid-run
  autoUpdater.allowPrerelease = false;

  const running = app.getVersion();
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
    installOnQuit: (on) => { autoUpdater.autoInstallOnAppQuit = on; },
    askServer: () => askBranchServer({ cfg: getDeviceConfig() as any, running, fetch: lanFetch as typeof fetch }),
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
    set({ state: 'downloaded', version: info?.version ?? null, percent: 100, note: `${info?.version} downloaded — installs when ZapTill is closed` });
  });

  // A348: each download request goes through the cloud's approval check — no range-by-range differential download.
  autoUpdater.disableDifferentialDownload = true;

  void loop.check('start');
  setInterval(() => { void loop.check('hourly'); }, ONE_HOUR);
  // A443: a till behind a branch server asks it every 2 minutes (and now, at start — a till that was off asks as soon as
  // it is back): told of a newer version the server holds, it checks with the cloud at once and takes it from the server.
  void loop.ask();
  setInterval(() => { void loop.ask(); }, 2 * 60_000);
  // A443: a till asked this server for a version it does not hold yet — check now (at most every 5 minutes).
  let lastAsked = 0;
  onShareWanted(() => {
    if (Date.now() - lastAsked < 5 * 60_000) return;
    lastAsked = Date.now();
    void loop.check('a till asked for a version this server does not hold');
  });
}
