import { app, BrowserWindow, net } from 'electron';
import path from 'path';
import { getLocalDb } from './localDb';
import { registerIpcHandlers } from './ipcHandlers';
import { configureSyncEngine, syncAll, syncPush, getSyncStatus } from './syncEngine';
import { getServerUrl } from './deviceConfig';

const isDev = !app.isPackaged;

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 600,
    title: 'SwiftPOS',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (isDev) {
    win.loadURL('http://localhost:5174');
    win.webContents.openDevTools();
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(() => {
  // Session re-hydration and startup sync must never prevent the window from
  // opening — isolate them so a DB or network hiccup can't leave a blank screen.
  try {
    // Init DB schema (runs additive migrations on older local DBs)
    getLocalDb();

    // Register all IPC handlers
    registerIpcHandlers();

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
