import { app, BrowserWindow, Menu, net, shell } from 'electron';
import { isNodeRole } from './deviceConfig';
import path from 'path';
import fs from 'fs';
import { getLocalDb } from './localDb';
import { registerIpcHandlers } from './ipcHandlers';
import { configureSyncEngine, syncAll, syncPush, getSyncStatus } from './syncEngine';
import { getServerUrl, getDeviceConfig } from './deviceConfig';
import { startNodeServer } from './nodeServer';
import { pollNodeInstructions, ackNodeInstruction, pullNodeDistribution } from './nodeClient';
import { ownDayState, executeCloseDay } from './branchClose';
import { applyDistribution, distributionCursors } from './nodeIngest';
import { pruneIfDue, snapshotIfDue } from './maintenance';

const isDev = !app.isPackaged;

/**
 * Moves the data folder from the old name to the new one, once.
 *
 * Electron derives userData from package.json's top-level `productName`, or
 * `name` when that is absent. It was absent, so every till has been storing its
 * database in %APPDATA%\desktop\ — a generic folder name for a point-of-sale
 * system, undiscoverable for support and easy to mistake for something else.
 *
 * Setting productName fixes new installs but STRANDS existing ones: the app
 * would look in %APPDATA%\SwiftPOS\, find nothing, and present the install
 * wizard to a till that is already configured and may hold unsynced sales. So
 * the old folder is moved across on first launch.
 *
 * Runs before anything opens the database — which is why getDbPath() had to
 * become lazy. Deliberately conservative:
 *   - only when the new folder does NOT already exist, so it can never
 *     overwrite a working install
 *   - a rename, not a copy, so there is no window where both exist and a till
 *     could be opened against the wrong one
 *   - a failure is logged and swallowed; a folder move must never stop a till
 *     from starting, and the worst case is a re-run of the wizard
 */
function migrateUserDataFolder(): void {
  try {
    const newDir = app.getPath('userData');            // ...\AppData\Roaming\SwiftPOS
    const oldDir = path.join(path.dirname(newDir), 'desktop');

    if (newDir === oldDir) return;                     // nothing to do
    if (fs.existsSync(newDir)) return;                 // already migrated, or a fresh install
    if (!fs.existsSync(path.join(oldDir, 'swiftpos.db'))) return;  // not ours — don't touch it

    fs.renameSync(oldDir, newDir);
    console.log(`[userData] moved ${oldDir} -> ${newDir}`);
  } catch (err) {
    console.error('[userData] migration failed, continuing with a fresh folder:', (err as Error).message);
  }
}

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
    // MUST come before anything opens the database.
    migrateUserDataFolder();

    installMenu();

    // Init DB schema (runs additive migrations on older local DBs)
    getLocalDb();

    // Register all IPC handlers
    registerIpcHandlers();

    // If this device is the branch aggregation node, start its LAN listener so
    // peer tills can push orders and read combined branch reports.
    try {
      const cfg = getDeviceConfig();
      if (isNodeRole(cfg?.device_role)) startNodeServer();
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

  // Central day close (Phase 4) — the peer side. Every 15s: tell the node how
  // this till is doing, collect any instruction, execute it, ack the outcome.
  // 15s because a manager is standing at the node screen watching this happen;
  // the 60s sync tick would make a working feature read as a hung one. Runs on
  // every till WITH a node configured that is not the node itself; self-guards
  // cost one cheap LAN request.
  //
  // Unacked outcomes are retried from `pendingAcks` on the next tick — an
  // instruction the node never hears back about is re-offered forever, so
  // losing the ack quietly would make the peer close once and be asked again.
  // (Re-asking is safe — the executor acks 'already closed' — but the manager
  // would watch a spinner that never resolves.)
  const pendingAcks = new Map<number, { ok: boolean; error?: string; summary?: unknown }>();
  setInterval(async () => {
    const cfg = getDeviceConfig();
    if (!cfg?.node_url || isNodeRole(cfg.device_role)) return;
    try {
      for (const [id, ack] of [...pendingAcks]) {
        if (await ackNodeInstruction(id, ack)) pendingAcks.delete(id);
      }
      const instructions = await pollNodeInstructions(ownDayState());
      if (!instructions) return;
      for (const ins of instructions) {
        if (pendingAcks.has(ins.id)) continue;          // executed, ack in flight
        if (ins.kind !== 'close_day') {
          // Named, not ignored: an unknown kind means the node is on a newer
          // build — the manager must find out rather than watch it spin.
          const ack = { ok: false, error: `this till does not understand '${ins.kind}' — it is on an older build` };
          if (!(await ackNodeInstruction(ins.id, ack))) pendingAcks.set(ins.id, ack);
          continue;
        }
        const ack = executeCloseDay(ins.payload);
        if (!(await ackNodeInstruction(ins.id, ack))) pendingAcks.set(ins.id, ack);
      }
    } catch (err) {
      console.error('[branchClose] peer loop:', err);
    }
  }, 15_000);

  // Phase 2a — distribution pull. Every 30s a peer asks the node for every
  // OTHER device's new rows and runs them through applyPeerRows under each
  // origin's identity — so the whole branch lives on every till, and the same
  // refusals that guard the node's ingest guard this direction. 30s, not 15:
  // replication is not a person watching a screen, and the instruction poll
  // above already carries the time-critical traffic. Drains has_more in the
  // same tick (bounded) so a till that was off for a day catches up in
  // minutes, not hours.
  setInterval(async () => {
    const cfg = getDeviceConfig();
    if (!cfg?.node_url || isNodeRole(cfg.device_role)) return;
    try {
      for (let round = 0; round < 10; round++) {
        const res = await pullNodeDistribution(distributionCursors());
        if (!res || !res.batches.length) return;
        applyDistribution(res.batches);
        if (!res.has_more) return;
      }
    } catch (err) {
      console.error('[distribution] pull:', err);
    }
  }, 30_000);

  // Phase 2c — maintenance. Hourly check, at-most-daily execution (the
  // functions gate themselves): peers prune expired replicas, the node takes
  // its nightly snapshot. Neither belongs on a tight timer, and both must
  // survive the app never being open at a specific hour — "due since
  // yesterday" runs on the next boot.
  setInterval(() => {
    try { pruneIfDue(); } catch (err) { console.error('[maintenance] prune:', err); }
    snapshotIfDue().catch(err => console.error('[maintenance] snapshot:', err));
  }, 3_600_000);
  // And once shortly after boot, for the till that is only on during service.
  setTimeout(() => {
    try { pruneIfDue(); } catch (err) { console.error('[maintenance] prune:', err); }
    snapshotIfDue().catch(err => console.error('[maintenance] snapshot:', err));
  }, 90_000);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
