/**
 * serverMode.ts — A427: the branch server keeps running whenever the computer is on.
 *
 * Owner, 2026-10-09: "we need to add the server as a service that never sleeps when the computer is on; when the app
 * is closed the app remains open in the task panel, never closes". While this machine serves its branch:
 *   - it starts with Windows, so after a power cut the branch has its server back without anyone (A513: 45 s after
 *     sign-in, by the installer's sign-in task, in the tray with no window — the Run entry only where that task is not);
 *   - the computer is kept from sleeping (powerSaveBlocker 'prevent-app-suspension'; the screen may still turn off);
 *   - closing the window hides it to the taskbar tray instead of quitting — the tray icon says it is running and
 *     opens it again. Quitting is only from the tray menu ("Restart ZapTill" also installs a downloaded update).
 * A plain till behaves exactly as before.
 */
import { app, BrowserWindow, Menu, Notification, Tray, nativeImage, powerSaveBlocker } from 'electron';
import path from 'path';
import { execFile } from 'child_process';
import { installWatchdog, removeWatchdog, markQuitByHand, disableWatchdog } from './serverWatchdog';   // A435
import { setStartsAtSignIn, startTaskName, whenStartupSettled, AT_LOGIN_ARG, LOGIN_WAIT_ARG } from './lowImpactStart';   // A513

let tray: Tray | null = null;
let blockerId: number | null = null;
let serving = false;
let quitting = false;

export function isServing(): boolean { return serving; }
export function isQuitting(): boolean { return quitting; }
export function markQuitting(): void { quitting = true; }

/**
 * A513: the main window is made on demand (a branch server starts with none). index.ts tells this module how to make
 * it and which window it is — never "the first window", which may be a hidden print window.
 */
let mainWindow: () => BrowserWindow | null = () => BrowserWindow.getAllWindows()[0] ?? null;
let makeWindow: (() => BrowserWindow) | null = null;
export function setMainWindow(get: () => BrowserWindow | null, make: () => BrowserWindow): void { mainWindow = get; makeWindow = make; }
/** The main window if one is open (not destroyed). */
export function openMainWindow(): BrowserWindow | null {
  const w = mainWindow();
  return w && !w.isDestroyed() ? w : null;
}

/** The tray's "Open ZapTill", a click on it or on a notice, a second launch: the window shown — made if there is none. */
export function showWindow(): BrowserWindow | null {
  let win = openMainWindow();
  if (!win && makeWindow) win = makeWindow();
  if (!win) return null;
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
  return win;
}

/**
 * A512: ZapTill's "start with Windows" entry (HKCU Run) is named after the app id at the moment it is written — before
 * 1.0.5 (A436 set the id) that was Electron's default, electron.app.ZapTill (and electron.app.SwiftPOS before the rename),
 * so a server set up then has TWO entries for the same exe and Windows started ZapTill twice at every sign-in (the second
 * closes at once — the single-instance lock — but Task Manager counts both). One fixed name, and the old ones removed.
 */
function loginItemName(): string {
  return app.getName().toLowerCase().includes('dev') ? 'com.swiftpos.desktop.dev' : 'com.swiftpos.desktop';
}
const OLD_LOGIN_ITEM_NAMES = ['electron.app.ZapTill', 'electron.app.ZapTill Dev', 'electron.app.SwiftPOS', 'electron.app.SwiftPOS Dev'];
export function clearOldLoginItems(): void {
  if (process.platform !== 'win32' || !app.isPackaged) return;
  for (const name of OLD_LOGIN_ITEM_NAMES) {
    try { app.setLoginItemSettings({ openAtLogin: false, name }); } catch { /* not there */ }
  }
}

/**
 * A513: start after sign-in, not at it. The installer registers "<product> start at sign-in" (a logon task, 45 s after
 * sign-in — not a Startup app in Task Manager). Where it is there, ZapTill's "start with Windows" (HKCU Run) entry is
 * removed; where it is not (the installer could not register it), the Run entry stays as the fallback — with
 * `--at-login --login-wait`, so ZapTill waits before it does anything (index.ts).
 */
export function loginEntryPlan(startTaskThere: boolean): { openAtLogin: boolean; args?: string[] } {
  return startTaskThere ? { openAtLogin: false } : { openAtLogin: true, args: [AT_LOGIN_ARG, LOGIN_WAIT_ARG] };
}
function syncLoginEntry(): void {
  if (process.platform !== 'win32' || !app.isPackaged) return;
  execFile('schtasks', ['/Query', '/TN', startTaskName(app.getName())], { windowsHide: true, timeout: 15_000 }, (err) => {
    const plan = loginEntryPlan(!err);
    try { app.setLoginItemSettings({ ...plan, name: loginItemName() }); } catch (e) { console.warn('[serverMode] login item:', e); }
    clearOldLoginItems();   // A512
  });
}

export function enterServerMode(): void {
  serving = true;
  // A436: Windows shows a notification only for an app with its installed id (the installer's appId).
  if (process.platform === 'win32') {
    try { app.setAppUserModelId(app.getName().toLowerCase().includes('dev') ? 'com.swiftpos.desktop.dev' : 'com.swiftpos.desktop'); } catch { /* best effort */ }
  }
  // A513: this Windows user's ZapTill starts after sign-in (the marker the sign-in task's launch looks for, startGate).
  setStartsAtSignIn(app.getPath('userData'), true);
  if (app.isPackaged) {
    // A513: the scheduled tasks and the Run entry after the start-up sequence — no schtasks while the server starts.
    whenStartupSettled(() => {
      if (!serving) return;
      installWatchdog();   // A435: started again within 5 minutes after a crash (serverWatchdog.ts) — A513: IgnoreNew
      syncLoginEntry();
    });
  }
  if (blockerId === null || !powerSaveBlocker.isStarted(blockerId)) {
    try { blockerId = powerSaveBlocker.start('prevent-app-suspension'); } catch (e) { console.warn('[serverMode] power:', e); }
  }
  if (!tray) {
    try {
      const icon = nativeImage.createFromPath(path.join(__dirname, '../../resources', app.getName().toLowerCase().includes('dev') ? 'icon.dev.png' : 'icon.png'));
      tray = new Tray(icon.isEmpty() ? icon : icon.resize({ width: 16, height: 16 }));
      tray.setToolTip('ZapTill branch server — running');
      tray.setContextMenu(Menu.buildFromTemplate([
        { label: 'ZapTill branch server is running', enabled: false },
        { type: 'separator' },
        { label: 'Open ZapTill', click: () => { showWindow(); } },
        { label: 'Restart ZapTill', click: () => { quitting = true; app.relaunch(); app.quit(); } },
        // A435: a quit from here stays quit — the watchdog does not start it again until it is opened by hand.
        // A513: and the restart task is switched off, so nothing is launched every 5 minutes meanwhile.
        { label: 'Quit (the tills lose their server)', click: () => { quitting = true; markQuitByHand(); disableWatchdog(); app.quit(); } },
      ]));
      tray.on('click', () => { showWindow(); });
      tray.on('double-click', () => { showWindow(); });
    } catch (e) { console.warn('[serverMode] tray:', e); }
  }
}

export function leaveServerMode(): void {
  serving = false;
  // A437: on the way out (shutdown, tray Quit) the server still starts with Windows next time.
  if (!quitting) setStartsAtSignIn(app.getPath('userData'), false);   // A513: a till's sign-in launch ends at once
  if (app.isPackaged && !quitting) {
    try { app.setLoginItemSettings({ openAtLogin: false, name: loginItemName() }); } catch { /* best effort */ }
    clearOldLoginItems();   // A512
    removeWatchdog();   // A435
  }
  if (blockerId !== null) { try { powerSaveBlocker.stop(blockerId); } catch { /* stopped */ } blockerId = null; }
  if (tray) { tray.destroy(); tray = null; }
  // A513: a server running with no window (started at sign-in) that stops serving would be left running unseen,
  // with no tray icon — its window opens instead.
  if (!quitting && !openMainWindow() && makeWindow) showWindow();
}

/** Closing the server's window hides it; the server goes on serving. Wire once per window. */
export function keepServerWindowAlive(win: BrowserWindow): void {
  win.on('close', (e) => {
    if (serving && !quitting) { e.preventDefault(); win.hide(); }
  });
}

/**
 * A436 (found 2026-10-10; owner: "proceed"): a till asked to join. The server's window is usually hidden in the tray,
 * so it comes forward with the Allow / Deny prompt on top, its taskbar button flashes, and Windows shows a notification
 * that opens it when clicked — whoever is near the server sees it before the request runs out (10 minutes).
 */
// A513: kept referenced — a notification nothing holds is garbage-collected, and its click then does nothing.
let joinNotice: Notification | null = null;
export function announceJoin(name: string, ip: string): void {
  // A513: a server started at sign-in has no window: none is made here (the notification says it); the window that
  // IS open comes forward with the prompt on top, and only then does the taskbar button flash.
  const open = openMainWindow();
  if (open) {
    const win = showWindow();
    try { win?.flashFrame(true); } catch { /* best effort */ }
  }
  try {
    if (!Notification.isSupported()) return;
    const n = new Notification({
      title: 'A till wants to join this branch server',
      body: `${name} (${ip}) is asking to join. Open ZapTill on this computer and press Allow — or Deny if you do not know it.`,
    });
    n.on('click', () => { showWindow(); });   // made if there is none — the join prompt is on top as it loads
    joinNotice = n;
    n.show();
  } catch (e) { console.warn('[serverMode] join notice:', e); }
}
export function _joinNotice(): Notification | null { return joinNotice; }

/**
 * A437 (found 2026-10-10; owner: "proceed with your recommendation"): Windows is shutting down, restarting or logging
 * off. A branch server's window would only hide (keepServerWindowAlive) and Windows would wait on it ("this app is
 * preventing shutdown"); and Windows ends the process right after session-end, so nothing asynchronous would run.
 * So: on query-session-end the window is let close (never vetoed); on session-end the caller's clean-up runs at once —
 * the database closed, not cut mid-write — and the app exits. It stays a login item for the next start. Every till, not only a server.
 */
export function closeCleanlyOnSessionEnd(win: BrowserWindow, cleanup: () => void): void {
  win.on('query-session-end', () => { quitting = true; });
  win.on('session-end', () => {
    quitting = true;
    try { cleanup(); } catch (e) { console.error('[serverMode] session end clean-up:', e); }
    app.exit(0);
  });
}
