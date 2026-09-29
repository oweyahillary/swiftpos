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

import { app, BrowserWindow } from 'electron';
import { autoUpdater } from 'electron-updater';
import { getCloudUrl } from './deviceConfig';
import { readSessionTokens } from './tokenStore';
import { refreshAccessToken } from './syncEngine';

const ONE_HOUR = 60 * 60 * 1000;   // A348: the approval check is one small JSON call

let started = false;

export type UpdateState = 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'error';
export interface UpdateStatus { state: UpdateState; version: string | null; percent: number | null; }

let current: UpdateStatus = { state: 'idle', version: null, percent: null };

/** The renderer polls this on mount (in case it missed the push while loading). */
export function getUpdateStatus(): UpdateStatus { return current; }

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

/** The pieces a check needs — real ones in initAutoUpdate, fakes in the test. */
export interface UpdateCheckDeps {
  updater: {
    setFeedURL(opts: { provider: 'generic'; url: string }): void;
    requestHeaders: Record<string, string> | null;
    checkForUpdates(): Promise<unknown>;
  };
  fetch: typeof fetch;
  cloudUrl: () => string | null;
  token: () => string | null;
  refresh: () => Promise<boolean>;
  running: string;
  log?: (line: string) => void;
}
export interface UpdateCheckResult { decision: UpdateDecision | 'unreachable'; approved: string | null }

/** One A348 check: ask the cloud, and only for an approved NEWER version open the feed and check it. Never throws. */
export async function runUpdateCheck(d: UpdateCheckDeps): Promise<UpdateCheckResult> {
  const cloud = d.cloudUrl();
  const ask = async (tok: string) => d.fetch(`${String(cloud).replace(/\/+$/, '')}/api/desktop-update/status`, {
    headers: { Authorization: `Bearer ${tok}` }, signal: AbortSignal.timeout(10_000),
  });
  let token = d.token();
  if (!cloud || !token) return { decision: 'unreachable', approved: null };
  let approved: string | null = null;
  try {
    let res = await ask(token);
    if (res.status === 401 && await d.refresh().catch(() => false)) {
      token = d.token();
      if (token) res = await ask(token);
    }
    if (!res.ok) { d.log?.(`update status: HTTP ${res.status} — holding`); return { decision: 'unreachable', approved: null }; }
    const body = await res.json() as { approvedVersion?: unknown };
    approved = typeof body?.approvedVersion === 'string' ? body.approvedVersion : null;
  } catch (e: any) {
    d.log?.(`update status unreachable (${e?.message ?? e}) — holding`);
    return { decision: 'unreachable', approved: null };
  }
  const decision = decideUpdate(approved, d.running);
  if (decision !== 'update' || !approved || !token) return { decision, approved };
  d.updater.setFeedURL({ provider: 'generic', url: feedUrlFor(cloud, approved) });
  d.updater.requestHeaders = { Authorization: `Bearer ${token}` };
  try {
    const result = await d.updater.checkForUpdates() as { downloadPromise?: Promise<unknown> } | null | undefined;
    // A363: with autoDownload the check hands back a download promise that REJECTS when the network drops mid-download
    // (net::ERR_NETWORK_IO_SUSPENDED / ERR_CONNECTION_RESET in the log) — nobody caught it, so every drop was an
    // UnhandledPromiseRejection. The 'error' event already reports it; this only stops the rejection going unhandled.
    result?.downloadPromise?.catch((e: any) => d.log?.(`update download interrupted: ${e?.message ?? e} — it retries on the next check`));
  }
  catch (e: any) { d.log?.(`update check failed: ${e?.message ?? e}`); }
  return { decision, approved };
}

export function initAutoUpdate(): void {
  if (!app.isPackaged) return;                 // dev has no feed/installer to swap
  if (app.getName().toLowerCase().includes('dev')) {
    console.log('[autoUpdate] dev flavour — auto-update disabled');
    return;
  }
  if (started) return;                         // idempotent
  started = true;

  autoUpdater.autoDownload = true;             // fetch in the background
  autoUpdater.autoInstallOnAppQuit = true;     // still swap on a normal quit — never mid-run
  autoUpdater.allowPrerelease = false;

  autoUpdater.on('error', (err) => {
    // Never throw: an update failure must not stop a till trading.
    console.warn('[autoUpdate] check/download failed:', err?.message ?? err);
    set({ state: 'error' });
  });
  autoUpdater.on('checking-for-update', () => set({ state: 'checking' }));
  autoUpdater.on('update-available', (info) => {
    console.log('[autoUpdate] newer version available:', info?.version);
    set({ state: 'available', version: info?.version ?? null });
  });
  autoUpdater.on('update-not-available', () => set({ state: 'idle' }));
  autoUpdater.on('download-progress', (p) => set({ state: 'downloading', percent: Math.round(p?.percent ?? 0) }));
  autoUpdater.on('update-downloaded', (info) => {
    console.log('[autoUpdate] downloaded', info?.version, '— will install on next quit');
    set({ state: 'downloaded', version: info?.version ?? null, percent: 100 });
  });

  // A348: each download request goes through the cloud's approval check — no range-by-range differential download.
  autoUpdater.disableDifferentialDownload = true;

  let busy = false;
  const check = async () => {
    // Already fetching or holding a downloaded update: nothing to ask until it is installed.
    if (busy || current.state === 'downloading' || current.state === 'downloaded') return;
    busy = true;
    try {
      const r = await runUpdateCheck({
        updater: autoUpdater as any,
        fetch,
        cloudUrl: () => { try { return getCloudUrl(); } catch { return null; } },
        token: () => readSessionTokens().token || null,
        refresh: () => refreshAccessToken(),
        running: app.getVersion(),
        log: (line) => console.log('[autoUpdate]', line),
      });
      if (r.decision !== 'update') console.log(`[autoUpdate] ${r.decision}${r.approved ? ` (approved ${r.approved})` : ''} — nothing to download`);
    } finally { busy = false; }
  };

  void check();
  setInterval(() => { void check(); }, ONE_HOUR);
}
