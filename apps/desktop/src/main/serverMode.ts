/**
 * serverMode.ts — A427: the branch server keeps running whenever the computer is on.
 *
 * Owner, 2026-10-09: "we need to add the server as a service that never sleeps when the computer is on; when the app
 * is closed the app remains open in the task panel, never closes". While this machine serves its branch:
 *   - it starts with Windows (login item), so after a power cut the branch has its server back without anyone;
 *   - the computer is kept from sleeping (powerSaveBlocker 'prevent-app-suspension'; the screen may still turn off);
 *   - closing the window hides it to the taskbar tray instead of quitting — the tray icon says it is running and
 *     opens it again. Quitting is only from the tray menu ("Restart ZapTill" also installs a downloaded update).
 * A plain till behaves exactly as before.
 */
import { app, BrowserWindow, Menu, Notification, Tray, nativeImage, powerSaveBlocker } from 'electron';
import path from 'path';
import { installWatchdog, removeWatchdog, markQuitByHand } from './serverWatchdog';   // A435

let tray: Tray | null = null;
let blockerId: number | null = null;
let serving = false;
let quitting = false;

export function isServing(): boolean { return serving; }
export function isQuitting(): boolean { return quitting; }
export function markQuitting(): void { quitting = true; }

function showWindow(): void {
  const [win] = BrowserWindow.getAllWindows();
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
}

export function enterServerMode(): void {
  serving = true;
  // A436: Windows shows a notification only for an app with its installed id (the installer's appId).
  if (process.platform === 'win32') {
    try { app.setAppUserModelId(app.getName().toLowerCase().includes('dev') ? 'com.swiftpos.desktop.dev' : 'com.swiftpos.desktop'); } catch { /* best effort */ }
  }
  if (app.isPackaged) {
    try { app.setLoginItemSettings({ openAtLogin: true }); } catch (e) { console.warn('[serverMode] login item:', e); }
    installWatchdog();   // A435: started again within 5 minutes after a crash (serverWatchdog.ts)
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
        { label: 'Open ZapTill', click: showWindow },
        { label: 'Restart ZapTill', click: () => { quitting = true; app.relaunch(); app.quit(); } },
        // A435: a quit from here stays quit — the watchdog does not start it again until it is opened by hand.
        { label: 'Quit (the tills lose their server)', click: () => { quitting = true; markQuitByHand(); app.quit(); } },
      ]));
      tray.on('click', showWindow);
      tray.on('double-click', showWindow);
    } catch (e) { console.warn('[serverMode] tray:', e); }
  }
}

export function leaveServerMode(): void {
  serving = false;
  // A437: on the way out (shutdown, tray Quit) the server still starts with Windows next time.
  if (app.isPackaged && !quitting) {
    try { app.setLoginItemSettings({ openAtLogin: false }); } catch { /* best effort */ }
    removeWatchdog();   // A435
  }
  if (blockerId !== null) { try { powerSaveBlocker.stop(blockerId); } catch { /* stopped */ } blockerId = null; }
  if (tray) { tray.destroy(); tray = null; }
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
export function announceJoin(name: string, ip: string): void {
  showWindow();
  const [win] = BrowserWindow.getAllWindows();
  try { win?.flashFrame(true); } catch { /* best effort */ }
  try {
    if (!Notification.isSupported()) return;
    const n = new Notification({
      title: 'A till wants to join this branch server',
      body: `${name} (${ip}) is asking to join. Open ZapTill on this computer and press Allow — or Deny if you do not know it.`,
    });
    n.on('click', showWindow);
    n.show();
  } catch (e) { console.warn('[serverMode] join notice:', e); }
}

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
