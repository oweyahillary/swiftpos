// A513: FIRST — an automatic launch with nothing to do (a till's sign-in start, a restart-task check while ZapTill runs,
// a launch after a quit by hand) ends inside this import, before anything below loads. See startGate.ts.
import './startGate';
import { gpuLine, gateNote } from './startGate';
import { app, BrowserWindow, Menu, shell } from 'electron';
import { sendTillChangesNow } from './changeQueue';   // A448
import { tillBranchId } from './deviceConfig';   // A446
import { configureStaffRoster, startStaffRosterTimer, refreshStaffRosterNow } from './staffRoster';   // A446
import { isNodeRole } from './deviceConfig';
import path from 'path';
import fs from 'fs';
import { readSessionTokens, migratePlaintextTokens } from './tokenStore';
import { getLocalDb, closeLocalDb } from './localDb';
import { registerIpcHandlers } from './ipcHandlers';
import { startLiveSync, liveActive, startupCatalogue } from './liveSync';   // A531
import { startLogPull } from './logPull';   // A533
import { startBranchDrawers } from './branchDrawers';   // A535
import { initPrinting } from './print/printWorker';
import { configureSyncEngine, syncAll, syncPush, getSyncStatus, pullIfCatalogueChanged, onCataloguePulled, pullWebSales, pullShiftCloses, pullShiftConfirmations, onShiftClosedElsewhere, stationRoutingPending, pushStationRoutingNow, wastagePending, pushWastageNow, rosterCloudGet, pullCatalogueNow, refreshTechConfigNow, runRemoteInstructionsNow, testClearsBeforePush, remoteCloseBeat, REMOTE_CLOSE_BEAT_MS, learnCloudCloses } from './syncEngine';   // A523: learnCloudCloses
import { AT_LOGIN_ARG, LOGIN_WAIT_ARG, LOGIN_WAIT_MS, isAutoLaunch, startsAtSignIn, startsWindowless, runStartupSequence, markStartup, markStartupSettled, startupLine, noteStartupLine, type StartupStep } from './lowImpactStart';   // A513
import { consumeSignInStart } from './lowImpactStart';   // A541
import { takeSingleInstanceLock, sleepSync } from './singleInstance';   // A554
import { startIdleMonitor } from './idleMonitor';
import { getCloudUrl, getDeviceConfig } from './deviceConfig';
import { startNodeServer, onServingChange } from './nodeServer';
import { enterServerMode, leaveServerMode, keepServerWindowAlive, isServing, markQuitting, announceJoin, closeCleanlyOnSessionEnd, clearOldLoginItems, setMainWindow, showWindow, openMainWindow } from './serverMode';   // A427, A436, A437, A513
import { onJoinAsked } from './serverJoin';   // A436
import { WATCHDOG_ARG, watchdogStaysDown, quitByHand, clearQuitByHand } from './serverWatchdog';   // A435
import { pollNodeInstructions, ackNodeInstruction, pullNodeDistribution, nodeHeaders } from './nodeClient';
import { ensureNodeTls } from './lanTls';   // A489
import { reportDayState, executeCloseDay, executeConfirmShift, executeShiftMoney } from './branchClose';   // A520: reportDayState — never skips the poll
import { applyDistribution, distributionCursors, retryPeerQuarantine } from './nodeIngest';   // A501: the quarantine
import { nodeReplicationTick } from './syncEngine';   // F10: branch replication on its own beat
import { pruneIfDue, snapshotIfDue } from './maintenance';
import { initAutoUpdate } from './autoUpdate';
import { installAtStartIfDue } from './autoUpdate';   // A541
import { getBuildInfo } from './buildInfo';
import { installConsoleCapture, logLine } from './logFile';
import { loadMachineIdentity } from './machineFingerprint';   // A477
import { moveTillData, oldFolderNames, type MoveResult } from './userDataMove';   // A386
import { devToolsAllowed } from './techService';   // A494

const isDev = !app.isPackaged;

// D17 / A289: the window title. The DEV flavour (and unpackaged dev) ALWAYS show
// the enrolled cloud host — useful for setup/verification and to catch a dev till
// pointed at the wrong cloud. The PROD flavour NEVER shows it: prod is the
// client-facing build and a shop shouldn't see a technical URL in its title.
// (Wrong-cloud safety for prod, if ever needed, belongs in a one-time first-launch
// warning, not a permanent badge.) getCloudUrl() returns the enrolled cloud (rule 21).
function cloudBadgeTitle(): string {
  const base = app.getName();                 // 'SwiftPOS' or 'SwiftPOS Dev' (A284)
  const devFlavour = isDev || base.toLowerCase().includes('dev');
  if (!devFlavour) return base;               // prod: clean, no host
  try {
    const url = getCloudUrl();
    if (!url) return base;                     // not enrolled yet — nothing to badge
    return `${base} — ${new URL(url).host}`;   // dev: always show the cloud
  } catch {
    return base;
  }
}

/**
 * Moves the till's data folder to the app's current name, once (lib: userDataMove.ts).
 *
 * The app was renamed twice: %APPDATA%\desktop (no productName, before A284) → %APPDATA%\SwiftPOS → %APPDATA%\ZapTill
 * (0.6.36, A386). Each rename points Electron's userData at a new, empty folder; the till's database, log, backups and
 * the key to its saved sign-in (Chromium's Local State) are carried across here.
 *
 * Runs at the very top of startup — before the single-instance lock and before 'ready' — so Electron has not yet made a
 * fresh Local State in the new folder; if something did get there first, the old data wins. The result is logged once
 * the log is up (startup can't log to the file yet: the file lives in this very folder).
 */
let userDataMoveResult: MoveResult | null = null;
function migrateUserDataFolder(): void {
  const newDir = app.getPath('userData');            // ...\AppData\Roaming\ZapTill (or "ZapTill Dev")
  userDataMoveResult = moveTillData(newDir, oldFolderNames(path.basename(newDir)));
}
migrateUserDataFolder();

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
 * visible menu item a cashier can find by accident. A494: on an installed till only
 * while a technician's session is open (devToolsAllowed) — a console reads the
 * database and the screens' memory, so it is not a key combination away.
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
          click: (_i, win) => {
            if (!devToolsAllowed(app.isPackaged)) return;   // A494: a technician's session (or a dev build) only
            (win as BrowserWindow)?.webContents.toggleDevTools();
          },
        },
        { type: 'separator' },
        { label: `ZapTill ${app.getVersion()}`, enabled: false },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** A513: the main window — made at start on a till (and anything opened by hand), on demand on a branch server. */
let mainWin: BrowserWindow | null = null;
let windowShown: () => void = () => {};
const firstWindowShown = new Promise<void>((r) => { windowShown = r; });

function createWindow(): BrowserWindow {
  if (mainWin && !mainWin.isDestroyed()) return mainWin;
  const badgeTitle = cloudBadgeTitle(); // D17
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 600,
    title: badgeTitle,
    // Hidden, not absent — see installMenu(). Alt still reveals it if a
    // technician needs it.
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // A513: no spell checker — nothing on a till is spell-checked, and it loads (and downloads) dictionaries.
      // backgroundThrottling stays Electron's default (on): a server's window hidden in the tray costs less.
      spellcheck: false,
    },
  });
  mainWin = win;
  win.on('closed', () => { if (mainWin === win) mainWin = null; });
  win.once('ready-to-show', () => { markStartup('window'); windowShown(); });   // A513: measured once per start
  // A494: developer tools opened any other way on an installed till without a technician's session are closed at once.
  win.webContents.on('devtools-opened', () => {
    if (!devToolsAllowed(app.isPackaged)) win.webContents.closeDevTools();
  });

  win.setMenuBarVisibility(false);
  keepServerWindowAlive(win);   // A427: a branch server's window hides to the tray instead of closing
  // A437: Windows shutting down or logging off — close properly (the database closed, not cut), never hide. The LAN
  // server is NOT stopped through stopNodeServer: that announces "no longer serving", which would take ZapTill out of
  // start-with-Windows — the exit drops its sockets anyway.
  closeCleanlyOnSessionEnd(win, () => { closeLocalDb(); });

  // D17: hold the env-badged title even if the loaded page sets its own
  // document.title, so the enrolled cloud stays visible in the title bar.
  win.on('page-title-updated', (e) => { e.preventDefault(); win.setTitle(badgeTitle); });

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
  return win;
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
 *
 * A554: and it EXITS — process.exit, not app.quit(). Before Electron is ready app.quit() does not stop the start-up
 * ('ready' still fires and the whenReady handler below ran in the second launch too): B Foods' branch server ran a
 * second ZapTill beside the one in the tray, with a second branch server on 4101. The relaunch after an update waits
 * for the lock while the old ZapTill closes (singleInstance.ts).
 */
const gotTheLock = takeSingleInstanceLock({ request: () => app.requestSingleInstanceLock(), argv: process.argv, sleep: sleepSync });

if (!gotTheLock) {
  process.exit(0);   // A554: Windows has already handed this launch's arguments to the running ZapTill ('second-instance')
} else {
  app.on('second-instance', (_e, argv) => {
    if (argv.includes(WATCHDOG_ARG)) return;   // A435: the watchdog's check — ZapTill is running; leave the window be
    if (isAutoLaunch(argv)) return;   // A513: the sign-in task or the updater's relaunch — never a window from them
    // A427: a branch server's window may be hidden in the tray. A513: or not made yet (a server started at sign-in) —
    // made now; asked for while ZapTill is still starting, it is made once the start-up has registered its handlers.
    if (!startupReady) { windowAsked = true; return; }
    showWindow();
  });
}
/** A513: a window asked for (a second launch) before the IPC handlers were registered. */
let startupReady = false;
let windowAsked = false;

app.whenReady().then(async () => {
  if (!gotTheLock) return;   // A554: never the start-up of a launch that is not the one (belt and braces: it exited above)
  // A435: a watchdog launch after someone quit from the tray stays down; opening ZapTill by hand clears that.
  if (watchdogStaysDown(process.argv, quitByHand())) { app.exit(0); return; }
  if (!process.argv.includes(WATCHDOG_ARG)) clearQuitByHand();
  // A299: from here on, main's console.error / console.warn also go to
  // swiftpos.log — so a failure is in the file, not just a packaged console
  // nobody can read. Must run before the rest of startup can throw.
  installConsoleCapture();
  // A298: stamp the log with the build this till is actually running, so "is the
  // fix on this machine?" is answerable from the log, not just the Tech screen.
  { const b = getBuildInfo(); logLine('startup', `ZapTill ${app.getVersion()} build ${b.sha} @ ${b.time}`); }
  markStartup('ready');   // A513
  if (gateNote) logLine('startup', gateNote);   // A513 (startGate.ts could not log: the log lives in userData)
  if (gpuLine) logLine('startup', gpuLine);     // A513: low-memory mode, and how a technician changes it
  // A513: a branch server started by Windows, the restart task or the updater runs in the tray — no window until
  // someone opens it. A till, and anything started by hand, opens its window as before (straight to the PIN screen).
  const server = startsAtSignIn(app.getPath('userData'));
  const windowless = startsWindowless(process.argv, server);
  // A541: the start at Windows sign-in (also the restart task's launch the sign-in start handed over to) — read once.
  const signInStart = consumeSignInStart(process.argv, app.getPath('userData'));
  // A546: a till's sign-in launch (the gate let it go on: an approved update is waiting) — install quietly, then end.
  const tillSignIn = process.argv.includes(AT_LOGIN_ARG) && !server && !process.argv.includes(WATCHDOG_ARG);
  let openedDuringSignIn = false;
  const how = process.argv.includes(AT_LOGIN_ARG) ? 'after sign-in' : process.argv.includes(WATCHDOG_ARG) ? 'by the restart task'
    : process.argv.includes('--updated') ? 'after an update' : 'by hand';
  // A513: the "start with Windows" fallback (no sign-in task on this machine): wait before doing anything.
  if (process.argv.includes(AT_LOGIN_ARG) && process.argv.includes(LOGIN_WAIT_ARG)) {
    logLine('startup', `started at sign-in without the sign-in task — waiting ${LOGIN_WAIT_MS / 1000} s before starting`);
    await new Promise((r) => setTimeout(r, LOGIN_WAIT_MS));
  }
  // A477: read the machine's identity (MachineGuid, BIOS serial) in the background — never waited for here.
  void loadMachineIdentity(process.platform, path.join(app.getPath('userData'), 'machine-identity.json'));   // A512: read once, kept
  clearOldLoginItems();   // A512: a startup entry from before 1.0.5 (Windows started ZapTill twice) is removed on every machine
  // Session re-hydration and startup sync must never prevent the window from
  // opening — isolate them so a DB or network hiccup can't leave a blank screen.
  try {
    // A386: the data-folder move ran at the top of startup (before the lock and 'ready'); record what it did.
    if (userDataMoveResult?.moved) logLine('startup', `data folder moved from ${userDataMoveResult.from} (${userDataMoveResult.mode})`);
    else if (userDataMoveResult?.reason === 'failed') logLine('startup', `data folder move FAILED: ${userDataMoveResult.error}`);

    installMenu();

    // Init DB schema (runs additive migrations on older local DBs)
    getLocalDb();

    // A546 (owner, 2026-10-21, on a till installing a waiting update: "yes, but what if it auto starts like a server — what
    // happens?"): a till's sign-in launch reaches here only when the gate saw an approved, newer update waiting. It
    // installs it through the updater task — no window, no Windows prompt, ZapTill stays closed after (the next open runs
    // the new version) — and ends. No task, a refusal, withdrawn: it ends as before; the next open installs it.
    if (tillSignIn) {
      try { initAutoUpdate(); } catch (e) { console.error('[startup] autoUpdate init failed:', e); }
      if (await installAtStartIfDue({ signInStart: true, updatedLaunch: false, quiet: true })) {
        logLine('startup', "a till's sign-in launch: the waiting update is installing quietly — ZapTill stays closed until it is opened");
        return;
      }
      if (!windowAsked) {
        logLine('startup', "a till's sign-in launch: nothing installed — it ends here (the next open installs a waiting update)");
        try { closeLocalDb(); } catch { /* ending anyway */ }
        app.exit(0);
        return;
      }
      logLine('startup', 'ZapTill was opened while the sign-in launch was checking for an update — it starts as usual');
      openedDuringSignIn = true;
    }

    // Register all IPC handlers
    registerIpcHandlers();

    // ESC/POS print subsystem: spool, transport, station->printer assignments.
    // AFTER registerIpcHandlers so a channel collision surfaces here rather than
    // silently shadowing a legacy handler. Wrapped because a till with no
    // thermal printer configured must still open and sell.
    try {
      // A513: the main window, when there is one — not "the first window" (a hidden print window, or none at all on a
      // server started at sign-in). Printing itself needs no window: an HTML print makes its own hidden one.
      initPrinting(getLocalDb(), () => openMainWindow());
    } catch (e) { console.error('[startup] print subsystem init failed:', e); }

    // A427: whenever this machine starts or stops serving its branch — at start-up, at setup, on promotion — it
    // goes into or out of server mode (start with Windows, never sleep, stay in the tray). See serverMode.ts.
    onServingChange((on) => { if (on) enterServerMode(); else leaveServerMode(); });
    // A436: a till asking to join brings this server's window forward and raises a Windows notification.
    onJoinAsked(({ name, ip }) => announceJoin(name, ip));

    // A541 (owner, 2026-10-20: "since we added the autostart feature most apps are not updating, they are stuck in the
    // old version"): a start at Windows sign-in with an approved, newer update already downloaded installs it HERE —
    // before the branch server serves and before any window — through the updater task (no prompt), else the installer
    // (Windows may ask; somebody has just signed in). Once per version; a start by hand or after an update never does.
    // initAutoUpdate is idempotent (called again below as before); it starts nothing until the start-up is over.
    try { initAutoUpdate(); } catch (e) { console.error('[startup] autoUpdate init failed:', e); }
    // A546: and a till opened by hand installs a waiting update first, as a backup ("Updating ZapTill…", then the PIN screen).
    if (await installAtStartIfDue({ signInStart: signInStart && !tillSignIn, updatedLaunch: process.argv.includes('--updated'),
      openedByHand: !isAutoLaunch(process.argv) || openedDuringSignIn })) {
      logLine('startup', 'closing to install the waiting update before serving or opening — ZapTill starts again after the install');
      return;
    }

    // If this device is the branch aggregation node, start its LAN listener so
    // peer tills can push orders and read combined branch reports.
    try {
      const cfg = getDeviceConfig();
      if (isNodeRole(cfg?.device_role)) startNodeServer();
    } catch (e) { console.error('[startup] node server start failed:', e); }

    // Re-hydrate sync engine from persisted session if one exists
    const db = getLocalDb();
    // D5: wrap anything still sitting in plaintext, once, at startup - so an
    // upgraded till stops holding a usable credential in the clear within
    // seconds rather than waiting for the next refresh.
    migratePlaintextTokens();
    const session = readSessionTokens();
    if (session.token) {
      configureSyncEngine(getCloudUrl(), session.token, session.refreshToken);
      // A513: the start-up sync is the sequence below — one step at a time, the business's essentials first.
    }
  } catch (err) {
    console.error('[startup] initialization error (continuing to window):', err);
  }

  setMainWindow(() => mainWin, createWindow);   // A513: the tray, a notice, a second launch make it on demand
  startupReady = true;
  if (!windowless || windowAsked) createWindow();
  else logLine('startup', `started ${how} as the branch server — in the tray, no window until someone opens it`);

  // D3 / A348: on launch and every hour, ask the cloud which version this business is approved for (null = hold) and
  // download only an approved newer one; install on next quit.
  // No-op in dev (app.isPackaged) and on the "SwiftPOS Dev" flavour, so
  // `npm run dev` and dev-flavour tills are unaffected. Never throws — a failed
  // update must not stop a till trading.
  try { initAutoUpdate(); } catch (e) { console.error('[startup] autoUpdate init failed:', e); }

  // ── Background sync ──────────────────────────────────────────────────────
  // `app.on('network-connected')` is NOT a real Electron event (it never fired),
  // so offline orders previously sat in the queue until the next sale or an app
  // restart. Two real mechanisms replace it:
  //   1. A cheap push-only flush every 60s (no catalogue pull; self-guards
  //      against offline / unconfigured / already-syncing).
  //   2. A full pull+push every 10 minutes to keep the catalogue fresh.
  // The renderer additionally notifies us the instant the OS reports
  // online/offline (see 'net:changed' in ipcHandlers) for immediate flushes.
  // A52: lock the till when the MACHINE is idle, not when the app thinks it is.
  // See idleMonitor.ts for why OS idle is the only signal that cannot fire
  // mid-sale.
  startIdleMonitor();

  // A513: the regular beats below begin only once the start-up sequence (further down) has run — in three groups a few
  // seconds apart, never all in the first seconds. Sales and shift changes still push at once (order:create, shift:*).
  const startSyncTimers = () => {
  // Backstop for anything still pending (a retry after a network blip). Sales and shift changes push at once
  // (order:create, shift:* in ipcHandlers); 30 s, not 60, per the owner (2026-09-27).
  setInterval(() => {
    if (getSyncStatus().pendingCount > 0) syncPush().catch(console.error);
  }, 30_000);
  setInterval(() => {
    syncAll().catch(console.error);
  }, 10 * 60_000);
  // A521 (#19): a day closed on the web (the cloud's remote close) reaches this till on a 90 s beat, not the 10-min
  // sync above; the cloud's test-data clears are asked on the same beat (before the next push).
  setInterval(() => { remoteCloseBeat().catch(console.error); }, REMOTE_CLOSE_BEAT_MS);
  // A291: cheap freshness poll — a web edit reaches this till in ~20s instead of
  // waiting for the 10-min floor above. pullIfCatalogueChanged() only pulls when the
  // server's catalogue version actually moved, and self-guards on offline/in-flight.
  // A531: with a change log (liveSync.ts) the till is told of a change and takes only its rows — no version check.
  startLiveSync();
  // A533: ZapTill support's log pulls — the push channel's doorbell and the 90 s beat above (logPull.ts).
  startLogPull();
  // A535: at a branch with a server, the drawer checks below (web sales, web closes, confirmations, the 90 s beat) are
  // answered by the server's ONE branch-level poll — on a till over the shop network (branchDrawers.ts).
  startBranchDrawers();
  setInterval(() => {
    if (!liveActive()) pullIfCatalogueChanged().catch(console.error);
    // Cross-sync stage 1 (2026-09-27): a sale rung on the web as this till reaches it on the same ~20 s beat.
    pullWebSales().catch(console.error);
    // A401: a drawer force-closed (or closed) on the web closes here on the same beat.
    pullShiftCloses().catch(console.error);
    // A411: station routing saved on this till while the cloud was out of reach goes up on the same beat.
    if (stationRoutingPending()) pushStationRoutingNow().catch(console.error);
    // A414: wastage recorded on this till while offline goes up on the same beat.
    if (wastagePending()) pushWastageNow().catch(console.error);
    void sendTillChangesNow();   // A448: changes made on this till
  }, 20_000);
  };
  // A446: this till's own copy of its branch's staff list — every 10 s on a branch server, 20 s on any till, and at once
  // when staff change here (staffRoster.ts). A new cashier signs in on every till within seconds, offline too.
  tillBranchId();   // A446: a till that never recorded its branch takes its signed-in person's
  configureStaffRoster((path) => rosterCloudGet(path));
  const startStaffTimers = () => {
  // A513: the sequence's 'staff' step has just pulled it — the timer's first pull is its next beat.
  startStaffRosterTimer(false);
  // A433: a shift this till holds, confirmed on the web or another till, is confirmed here too — on its own 20 s beat.
  setInterval(() => { pullShiftConfirmations().catch(console.error); }, 20_000);
  };
  // A401: tell every window, so the cashier sees why selling stopped (POSPage shows the notice and re-reads the shift).
  onShiftClosedElsewhere((c) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('shift:closedElsewhere', { id: c.id, message: c.message });
    }
  });
  // A321: ANY successful pull (this check, the 10-min floor, startup, manual sync, post-edit sync…)
  // tells every open window to reload from the local DB. This used to be sent only by the check
  // above, and only to getAllWindows()[0] — changes from every other path waited for a sign-in/out.
  onCataloguePulled(() => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('catalogue:changed');
    }
  });

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
  // F12 (2026-10-14): keyed by the instruction's uid (its number only from a server on an older build), and the ack
  // carries uid + this till's id — a number alone restarts at 1 on a reinstalled server and matched another's.
  const pendingAcks = new Map<string, { id: number; uid: string | null; ack: { ok: boolean; error?: string; summary?: unknown } }>();
  const ackKey = (ins: { id: number; uid?: string | null }) => (ins.uid ? `u:${ins.uid}` : `n:${ins.id}`);
  const sendAck = async (ins: { id: number; uid?: string | null }, ack: { ok: boolean; error?: string; summary?: unknown }) => {
    if (!(await ackNodeInstruction(ins.id, ack, undefined, ins.uid ?? null))) pendingAcks.set(ackKey(ins), { id: ins.id, uid: ins.uid ?? null, ack });
  };
  const peerInstructionTick = async () => {   // A513: named — the sequence's 'pulls' step runs it once first
    const cfg = getDeviceConfig();
    if (!cfg?.node_url || isNodeRole(cfg.device_role)) return;
    try {
      for (const [key, p] of [...pendingAcks]) {
        if (await ackNodeInstruction(p.id, p.ack, undefined, p.uid)) pendingAcks.delete(key);
      }
      // A520: the poll is the till's "I am here" (Close Branch's last seen) — sent whatever the day gate says, and with
      // whatever of the report could be read (reportDayState never throws), so a locked till keeps reporting.
      const instructions = await pollNodeInstructions(reportDayState());
      if (!instructions) return;
      for (const ins of instructions) {
        if (pendingAcks.has(ackKey(ins))) continue;          // executed, ack in flight
        if (ins.kind === 'confirm_shift') {
          // A452: a manager on the branch server confirmed one of this till's shifts — recorded here, on its own books.
          const ack = executeConfirmShift(ins.payload);
          if (ack.ok) syncPush().catch(() => { /* the timer retries */ });
          await sendAck(ins, ack);
          continue;
        }
        if (ins.kind === 'shift_money') {
          // A465: a manager on the branch server recorded a cash in / out or an expense on one of this till's open
          // shifts — recorded here, on its own books; the drawer's figures on screen reload.
          const ack = executeShiftMoney(ins.payload);
          if (ack.ok && !ack.already) {
            syncPush().catch(() => { /* the timer retries */ });
            for (const w of BrowserWindow.getAllWindows()) {
              if (!w.isDestroyed()) w.webContents.send('shift:changedElsewhere', { id: ins.payload?.shift_id ?? null, kind: ins.payload?.kind ?? null });
            }
          }
          await sendAck(ins, ack);
          continue;
        }
        if (ins.kind !== 'close_day') {
          // Named, not ignored: an unknown kind means the node is on a newer
          // build — the manager must find out rather than watch it spin.
          const ack = { ok: false, error: `this till does not understand '${ins.kind}' — it is on an older build` };
          await sendAck(ins, ack);
          continue;
        }
        const ack = executeCloseDay(ins.payload);
        await sendAck(ins, ack);
      }
    } catch (err) {
      console.error('[branchClose] peer loop:', err);
    }
  };

  // A489: a till already joined to a branch server switches to an encrypted connection by itself — the first time the
  // server answers TLS (it runs 1.0.15+), the till pins its certificate. Cheap once pinned; nothing on a server.
  const tlsTick = () => { ensureNodeTls(() => nodeHeaders()).catch((e) => console.warn('[node] tls:', e?.message ?? e)); };

  const startBranchTimers = () => {
  setInterval(() => { void peerInstructionTick(); }, 15_000);
  // F10 (2026-10-14): branch replication on its own 15 s beat, whatever the cloud is doing — a till with no cloud
  // session (or no internet) still sends its rows to the branch server, and the server numbers its own rows so its
  // tills receive them (syncEngine.nodeReplicationTick). Self-guards: nothing to do without a branch server.
  // A513: its first run is the sequence's 'push' step (it was 5 s after launch).
  setInterval(() => { void nodeReplicationTick(); }, 15_000);
  // A513: the first TLS check is the sequence's last step (it was 8 s after launch).
  setInterval(tlsTick, 60_000);

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
        if (!res || !res.batches.length) break;
        applyDistribution(res.batches);
        if (!res.has_more) break;
      }
    } catch (err) {
      console.error('[distribution] pull:', err);
    }
    // A501: rows held back from an earlier pull (refused then, perhaps only for their order) are tried again when due —
    // every pass, whether or not this pull brought anything new, and whether or not the server answered.
    try { retryPeerQuarantine(); } catch (err) { console.error('[distribution] quarantine:', err); }
  }, 30_000);
  };

  // Phase 2c — maintenance. Hourly check, at-most-daily execution (the
  // functions gate themselves): peers prune expired replicas, the node takes
  // its nightly snapshot. Neither belongs on a tight timer, and both must
  // survive the app never being open at a specific hour — "due since
  // yesterday" runs on the next boot.
  setInterval(() => {
    try { pruneIfDue(); } catch (err) { console.error('[maintenance] prune:', err); }
    snapshotIfDue().catch(err => console.error('[maintenance] snapshot:', err));
  }, 3_600_000);
  // And once shortly after boot, for the till that is only on during service. A513: 90 s after the start-up sequence
  // (not after launch — on a slow PC a server's snapshot then ran while the sequence was still going).
  const startMaintenanceSoon = () => setTimeout(() => {
    try { pruneIfDue(); } catch (err) { console.error('[maintenance] prune:', err); }
    snapshotIfDue().catch(err => console.error('[maintenance] snapshot:', err));
  }, 90_000);

  // ── A513: the start-up sequence ─────────────────────────────────────────────────────────────────────────────────
  // One step at a time, the business's essentials first; each step waits at most STEP_CAP_MS for the one before (a
  // hung step goes on in the background). The branch server's LAN listener is already up (above) — tills depend on it.
  const steps: StartupStep[] = [
    { name: 'catalogue', what: 'menu, prices, offers, payment methods, M-Pesa and business settings',
      // The version first (the 20 s check then knows it and does not pull again); no version answer → pulled anyway.
      // A531: the change log first (only what changed since this till last ran; the whole catalogue the first time);
      // a cloud (or branch server) without one: as before.
      run: async () => {
        if (await startupCatalogue()) return;
        const r = await pullIfCatalogueChanged({ pullOnly: true }); if (!r.changed) await pullCatalogueNow();
      } },
    { name: 'staff', what: 'staff list, PINs and permissions', run: () => refreshStaffRosterNow('start') },
    { name: 'settings', what: 'the branch\'s technician settings', run: () => refreshTechConfigNow() },
    { name: 'push', what: 'sales, drawers and changes waiting on this till',
      run: async () => {
        // A521 (#15): the cloud's test-data clears before anything this till holds goes up (a till that was off during an
        // admin clear sent its unsent test sales back first — to the cloud, and to the branch server, which relays them).
        await testClearsBeforePush();
        // A523: what the cloud closed while this till was off (a drawer force-closed on the web, its day closed on the web
        // or as abandoned) is learned and adopted BEFORE anything decides the till is locked — the day gate reads it next.
        await learnCloudCloses();
        await nodeReplicationTick();   // to the branch server (the shop network) first
        await syncPush();
        await sendTillChangesNow();
        if (wastagePending()) await pushWastageNow();
      } },
    { name: 'pulls', what: 'web sales, shift closes, confirmations and instructions',
      run: async () => {
        await pullWebSales();
        await pullShiftCloses();
        await pullShiftConfirmations();
        await peerInstructionTick();
        await runRemoteInstructionsNow();
      } },
    { name: 'rest', what: 'the branch server\'s encrypted connection', run: () => ensureNodeTls(() => nodeHeaders()) },
  ];
  void runStartupSequence(steps, { log: (l) => logLine('startup', l) }).then(() => {
    markStartup('sequence');
    markStartupSettled();   // the update check, the scheduled tasks and the Run entry may begin (whenStartupSettled)
    // A server that is not serving after all (its port taken, the role changed) is never left running unseen.
    // 30 s of grace: the listener may still be finding a free port.
    if (windowless) setTimeout(() => {
      if (!isServing() && !openMainWindow()) { logLine('startup', 'not serving after the start — opening the window'); showWindow(); }
    }, 30_000);
    void logStartupLine(how, windowless);
    startSyncTimers();
    setTimeout(startStaffTimers, 3_000);
    setTimeout(startBranchTimers, 6_000);
    startMaintenanceSoon();
  }).catch((e) => { console.error('[startup] sequence:', e); markStartupSettled(); startSyncTimers(); startStaffTimers(); startBranchTimers(); });
});

/** A513: one line per start — how long to ready, to the first window, to the end of the sequence; the memory then. */
async function logStartupLine(how: string, windowless: boolean): Promise<void> {
  let kb: number | null = null, n: number | null = null;
  // A window made at start that has not painted yet: the line waits for it (at most a minute), so it is in the line.
  if (!windowless && mainWin) await Promise.race([firstWindowShown, new Promise((r) => setTimeout(r, 60_000))]);
  try {
    const m = app.getAppMetrics();
    kb = m.reduce((s, p) => s + (p.memory?.workingSetSize ?? 0), 0);
    n = m.length;
  } catch { /* not known */ }
  const line = startupLine({ how: `${how}${windowless ? ', no window' : ''}`, memoryKb: kb, processes: n });
  noteStartupLine(line);
  logLine('startup', line);
}

app.on('before-quit', () => { markQuitting(); });   // A427: a real quit (tray, update, shutdown) is let through

app.on('window-all-closed', () => {
  if (isServing()) return;   // A427: the branch server keeps running in the tray
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (!openMainWindow()) showWindow();   // A513: the main window, made if none (not "no window of any kind")
});
