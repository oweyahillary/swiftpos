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
import { app, BrowserWindow, Menu, Tray, nativeImage, powerSaveBlocker } from 'electron';
import path from 'path';

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
  if (app.isPackaged) {
    try { app.setLoginItemSettings({ openAtLogin: true }); } catch (e) { console.warn('[serverMode] login item:', e); }
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
        { label: 'Quit (the tills lose their server)', click: () => { quitting = true; app.quit(); } },
      ]));
      tray.on('click', showWindow);
      tray.on('double-click', showWindow);
    } catch (e) { console.warn('[serverMode] tray:', e); }
  }
}

export function leaveServerMode(): void {
  serving = false;
  if (app.isPackaged) {
    try { app.setLoginItemSettings({ openAtLogin: false }); } catch { /* best effort */ }
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
