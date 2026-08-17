/**
 * autoUpdate.ts — self-updating for the desktop till (register D3).
 *
 * SCAFFOLD — NOT YET BENCH-VERIFIED. This wires electron-updater correctly, but
 * it cannot run or even type-check until `electron-updater` is a dependency and
 * an electron-builder `publish` target exists (see docs/DESKTOP-AUTOUPDATE.md).
 * Until then every release is a hand-installed .exe per till, which the register
 * calls the tax on every other desktop fix.
 *
 * Behaviour, deliberately minimal and silent:
 *   - Dev builds never self-update (app.isPackaged guard) — `npm run dev` is
 *     unaffected.
 *   - On launch and every 6 hours it checks the configured feed, downloads a
 *     newer version in the background, and installs it on the NEXT quit. A till
 *     is never interrupted mid-service; it comes up updated the next morning.
 *   - Nothing is forced and nothing blocks trading: a failed check is logged and
 *     the app carries on selling on the current version, which is the whole point
 *     of an offline till.
 *
 * A visible "update ready — restart to apply" prompt is intentionally NOT here:
 * it needs a preload channel and would entangle this with check-ipc-parity. Add
 * it as a follow-up once the release pipeline itself is proven.
 */

import { app } from 'electron';
// eslint-disable-next-line import/no-unresolved -- dependency added as part of D3; see runbook.
import { autoUpdater } from 'electron-updater';

const SIX_HOURS = 6 * 60 * 60 * 1000;

let started = false;

export function initAutoUpdate(): void {
  // Only a packaged, installed app can replace itself. In dev there is no
  // update feed and no installer to swap, so this is a no-op.
  if (!app.isPackaged) return;
  if (started) return;                 // idempotent — safe if called twice
  started = true;

  autoUpdater.autoDownload = true;             // fetch in the background
  autoUpdater.autoInstallOnAppQuit = true;     // swap on quit, never mid-run
  autoUpdater.allowPrerelease = false;

  autoUpdater.on('error', (err) => {
    // Never throw out of here: an update failure must not stop a till trading.
    console.warn('[autoUpdate] check/download failed:', err?.message ?? err);
  });
  autoUpdater.on('update-available', (info) => {
    console.log('[autoUpdate] newer version available:', info?.version);
  });
  autoUpdater.on('update-not-available', () => {
    console.log('[autoUpdate] up to date');
  });
  autoUpdater.on('update-downloaded', (info) => {
    console.log('[autoUpdate] downloaded', info?.version, '— will install on next quit');
  });

  const check = () =>
    autoUpdater.checkForUpdates().catch((err) =>
      console.warn('[autoUpdate] check failed:', err?.message ?? err));

  check();
  setInterval(check, SIX_HOURS);
}
