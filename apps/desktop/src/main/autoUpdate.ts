/**
 * autoUpdate.ts — self-updating for the desktop till (register D3; UX in A306).
 *
 * WIRED 2026-09-10 — electron-updater is a dependency, this is called from index.ts, and the
 * prod build publishes to GitHub Releases. Runs unsigned for now (docs/DESKTOP-AUTOUPDATE.md §4).
 *
 * Behaviour:
 *   - Dev builds never self-update (app.isPackaged guard + the "SwiftPOS Dev" flavour is skipped
 *     by name so a dev till never pulls a prod release).
 *   - On launch and every 6h it checks the feed and downloads a newer version in the background.
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
 */

import { app, BrowserWindow } from 'electron';
import { autoUpdater } from 'electron-updater';

const SIX_HOURS = 6 * 60 * 60 * 1000;

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

  const check = () =>
    autoUpdater.checkForUpdates().catch((err) =>
      console.warn('[autoUpdate] check failed:', err?.message ?? err));

  check();
  setInterval(check, SIX_HOURS);
}
