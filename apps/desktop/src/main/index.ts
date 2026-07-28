import { app, BrowserWindow, Menu, net, shell } from 'electron';
import path from 'path';
import { getLocalDb } from './localDb';
import { registerIpcHandlers } from './ipcHandlers';
import { configureSyncEngine, syncAll, syncPush, getSyncStatus } from './syncEngine';
import { getServerUrl, getDeviceConfig } from './deviceConfig';
import { startNodeServer } from './nodeServer';

const isDev = !app.isPackaged;

/**
 * Replaces Electron's default menu with a minimal hidden one.
 *
 * The stock menu ships File / Edit / View / Window / Help — and View holds
 * "Reload" and "Toggle Developer Tools", Window holds "Close". On a till, on a
 * touchscreen, mid-service, those are one mis-tap from a blank screen or a
 * developer console in front of a customer.
 *
 * NOT Menu.setApplicationMenu(null), which would be simpler but breaks
 * copy/paste: on Windows the Ctrl+C / Ctrl+V accelerators are wired up by the
 * Edit menu's roles, and the install wizard has fields people paste a server URL
 * and a node secret into. So the roles stay and the menu bar is hidden instead.
 *
 * DevTools remain reachable on Ctrl+Shift+I for support, but are no longer a
 * visible menu item a cashier can find by accident.
 */
function installMenu() {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'Support',
      submenu: [
        {
          label: 'Developer tools',
          accelerator: 'CmdOrCtrl+Shift+I',
          click: (_i, win) => (win as BrowserWindow)?.webContents.toggleDevTools(),
        },
        { type: 'separator' },
        { label: `SwiftPOS ${app.getVersion()}`, enabled: false },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 600,
    title: 'SwiftPOS',
    // Hidden, not absent — see installMenu(). Alt still reveals it if a
    // technician needs it.
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.setMenuBarVisibility(false);

  // Anything that would navigate away from the app opens in the real browser
  // instead. A till that has wandered off to a web page is a till that cannot
  // sell, and there is no address bar to get back.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  if (isDev) {
    win.loadURL('http://localhost:5174');
    win.webContents.openDevTools();
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

/**
 * One SwiftPOS per machine.
 *
 * Two instances share one SQLite file and one session row, and that is not
 * merely untidy — it revokes the till.
 *
 * Refresh tokens are single-use with replay detection: present one twice and the
 * server revokes EVERY session for that user, deliberately, because a reused
 * token is what a stolen one looks like. Two instances both refreshing on launch
 * is exactly that pattern. The result is "This till was signed out", and getting
 * back in needs the owner's email and password — which nobody on the floor has
 * at seven in the morning.
 *
 * On a till, a double-clicked shortcut is enough to cause it. So the second
 * launch focuses the first window and exits, rather than starting a rival.
 */
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

app.whenReady().then(() => {
  // Session re-hydration and startup sync must never prevent the window from
  // opening — isolate them so a DB or network hiccup can't leave a blank screen.
  try {
    installMenu();

    // Init DB schema (runs additive migrations on older local DBs)
    getLocalDb();

    // Register all IPC handlers
    registerIpcHandlers();

    // If this device is the branch aggregation node, start its LAN listener so
    // peer tills can push orders and read combined branch reports.
    try {
      const cfg = getDeviceConfig();
      if (cfg?.device_role === 'node') startNodeServer();
    } catch (e) { console.error('[startup] node server start failed:', e); }

    // Re-hydrate sync engine from persisted session if one exists
    const db = getLocalDb();
    const session = db.prepare(`SELECT token, refresh_token FROM session WHERE id=1`).get() as any;
    if (session?.token) {
      configureSyncEngine(getServerUrl(), session.token, session.refresh_token ?? '');
      // Sync on startup if online
      if (net.isOnline()) {
        syncAll().catch(console.error);
      }
    }
  } catch (err) {
    console.error('[startup] initialization error (continuing to window):', err);
  }

  createWindow();

  // ── Background sync ──────────────────────────────────────────────────────
  // `app.on('network-connected')` is NOT a real Electron event (it never fired),
  // so offline orders previously sat in the queue until the next sale or an app
  // restart. Two real mechanisms replace it:
  //   1. A cheap push-only flush every 60s (no catalogue pull; self-guards
  //      against offline / unconfigured / already-syncing).
  //   2. A full pull+push every 10 minutes to keep the catalogue fresh.
  // The renderer additionally notifies us the instant the OS reports
  // online/offline (see 'net:changed' in ipcHandlers) for immediate flushes.
  setInterval(() => {
    if (getSyncStatus().pendingCount > 0) syncPush().catch(console.error);
  }, 60_000);
  setInterval(() => {
    syncAll().catch(console.error);
  }, 10 * 60_000);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
