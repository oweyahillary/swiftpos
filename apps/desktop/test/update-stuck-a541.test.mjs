// A541 — tills and branch servers stuck on an old version since the A513 autostart (1.0.17) install their approved update.
//
// Owner, 2026-10-20: "Something I have noticed since we added the autostart feature most apps are not updating, they are
// stuck in the old version."
//
// RUNS the real compiled dist/main (electron and electron-updater shimmed, REAL SQLite):
//   cd apps/desktop && npm run build:main && TZ=UTC node --no-warnings test/update-stuck-a541.test.mjs
//
// Covers:
//   1. the branch server is busy only for real trading — every route a 1.0.19/1.0.20 till sends through the gateway,
//      classified (and every /api/ route named in src/main is in the table); a drawer's foreign-orders POST every 20 s
//      all night no longer keeps the server "in use"; a sale, a void, a drawer push with rows still do;
//   2. the start-up install — once, for a downloaded, approved, newer version on a start at Windows sign-in; never on a
//      start by hand, never for an unapproved / withdrawn / older version, never twice after a failure; the updater task
//      first, else the installer; an open drawer is kept (the local database) and logged; the sign-in hand-over marker;
//      index.ts asks it before the server serves and before any window;
//   3. the report carries the blocker, the server role, "waiting for the branch server's copy", since when;
//   4. the managers' notice after 3 days ready — a manager / the owner, never a cashier.
//
// MUTATIONS TO CONFIRM BITE (each verified by editing dist/main / the source and re-running):
//   - classifyGatewayCall back to "every non-GET is trading"                 → "foreign-orders all night: not busy" fails
//   - GATEWAY_TRADING without the orders route                               → "a sale through the gateway counts" fails
//   - startupInstallPlan without the signInStart check                       → "a start by hand: no install" fails
//   - startupInstallPlan without the triedVersion check                      → "not twice after a failure" fails
//   - runStartupInstall marking the try AFTER the install                    → "the try is recorded before the install" fails
//   - signInStartFrom ignoring the flag's age                                → "a stale hand-over marker: not a sign-in start" fails
//   - buildUpdateReport dropping the blocker                                 → "the report: the blocker" fails
//   - updateBarContent without the canRestart check                          → "a cashier never sees the notice" fails
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.join(here, '..');
const dist = path.join(desktop, 'dist', 'main');
const require = createRequire(import.meta.url);
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-a541-'));
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, `
  const handlers = (global.__handlers = {}); const listeners = (global.__listeners = {});
  module.exports = {
    app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '1.0.19', getName: () => 'ZapTill', on() {}, isPackaged: false },
    ipcMain: { handle(ch, fn) { handlers[ch] = fn; }, on(ch, fn) { listeners[ch] = fn; }, removeHandler() {} },
    BrowserWindow: class { static getAllWindows() { return []; } static getFocusedWindow() { return null; } },
    dialog: {}, shell: {}, screen: {}, Menu: {}, powerMonitor: { on() {}, getSystemIdleTime: () => 0 },
    safeStorage: { isEncryptionAvailable: () => false }, net: { isOnline: () => true },
    session: { fromPartition: () => ({ setCertificateVerifyProc() {} }) },
  };`);
const updaterShim = path.join(userData, 'updater-shim.cjs');
fs.writeFileSync(updaterShim, `module.exports = { autoUpdater: { on() {}, checkForUpdates: async () => null, setFeedURL() {}, quitAndInstall() {} } };`);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) {
  if (req === 'electron') return shim;
  if (req === 'electron-updater') return updaterShim;
  return orig.call(this, req, parent, ...rest);
};

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const read = (p) => fs.readFileSync(path.join(desktop, p), 'utf8').replace(/\r\n/g, '\n');

const L = require(path.join(dist, 'localDb.js'));
const db = L.getLocalDb();
const C = require(path.join(dist, 'deviceConfig.js'));
C.saveDeviceConfig({ deploy_mode: 'cloud', server_url: 'http://cloud', branch_id: 'br-1', device_id: 'dev-S1', device_role: 'node',
  terminal_code: 'S1', device_name: 'Server', configured: true });
const A = require(path.join(dist, 'activityTracker.js'));
const U = require(path.join(dist, 'autoUpdate.js'));
const R = require(path.join(dist, 'updateReport.js'));
const S = require(path.join(dist, 'lowImpactStart.js'));

// ── 1. The branch server is busy only for real trading ───────────────────────────────────────────────────────────────
console.log('\n1. The gateway: trading only (an allowlist)\n');
{
  // Every route a 1.0.19 / 1.0.20 till sends to the cloud (through the branch server's gateway when it has one) — from
  // src/main (syncEngine, ipcHandlers, liveSync, logPull, staffRoster, branchDrawers, techService, autoUpdate …).
  const T = 'trading', P = 'person', B = 'background';
  const ROUTES = [
    ['POST', 'orders', T], ['POST', 'orders/o-1/void', T], ['POST', 'orders/o-1/refund', T],
    ['POST', 'sync/push', T], ['POST', 'shifts/s-1/close', T], ['POST', 'shifts/s-1/force-close', T],
    ['POST', 'shifts/s-1/confirm', T], ['POST', 'shifts/s-1/manager-confirm', T], ['POST', 'wastage', T], ['POST', 'day-close/ack', T],
    // a manager's edit at a till — somebody is there
    ['POST', 'products', P], ['PATCH', 'products/p-1', P], ['POST', 'products/bulk', P], ['POST', 'combos', P], ['PATCH', 'combos/c-1', P],
    ['PUT', 'combos/c-1/items', P], ['POST', 'variants/groups', P], ['DELETE', 'variants/options/v-1', P], ['POST', 'modifiers/groups', P],
    ['DELETE', 'modifiers/groups/m-1', P], ['POST', 'payment-methods', P], ['PATCH', 'payment-methods/pm-1', P], ['POST', 'offers', P],
    ['DELETE', 'offers/of-1', P], ['POST', 'staff', P], ['PATCH', 'staff/u-1', P], ['POST', 'stock/transfers', P],
    ['PATCH', 'stock/transfers/t-1/status', P], ['POST', 'branch-prices/sync', P], ['POST', 'business/settings', P],
    ['PUT', 'business/branding', P], ['POST', 'branches/br-1/settings', P], ['PUT', 'branches/br-1/mpesa', P],
    ['POST', 'expenses/categories', P], ['POST', 'reports/monthly/movements', P], ['DELETE', 'reports/monthly/movements/x', P],
    ['PUT', 'stations/st-1/categories', P], ['POST', 'stations/seed-defaults', P],
    // background: read-only POSTs, sign-ins, support, telemetry, update — never trading
    ['POST', 'shifts/s-1/foreign-orders', B], ['POST', 'shifts/s-1/foreign-cash', B], ['POST', 'shifts/confirmer', B],
    ['POST', 'changes', B], ['POST', 'pos/join-code', B], ['POST', 'auth/verify-pin', B], ['POST', 'auth/refresh', B],
    ['POST', 'auth/refresh/ack', B], ['POST', 'auth/device-token', B], ['POST', 'auth/enrol/redeem', B], ['POST', 'auth/verify', B],
    ['POST', 'support/logs', B], ['POST', 'support/log', B], ['POST', 'tech/audit', B], ['POST', 'desktop-update/state', B],
    // reads
    ['GET', 'orders/o-1', B], ['GET', 'shifts/current', B], ['GET', 'shifts/state', B], ['GET', 'pos/changes', B], ['GET', 'pos/branch-drawers', B],
    ['GET', 'pos/branch-staff', B], ['GET', 'pos/init', B], ['GET', 'pos/catalogue-version', B], ['GET', 'pos/test-data-clears', B],
    ['GET', 'pos/branch', B], ['GET', 'changes/state', B], ['GET', 'day-close/pending', B], ['GET', 'inventory', B], ['GET', 'health', B],
    ['GET', 'support/log-requests/mine', B], ['GET', 'support/terminal-codes', B], ['GET', 'support/terminal', B], ['GET', 'tech/branch-config/br-1', B],
    ['GET', 'desktop-update/status', B], ['GET', 'desktop-update/v/1.0.20/latest.yml', B], ['GET', 'batches', B], ['GET', 'wastage/items', B],
    ['GET', 'tables', B], ['GET', 'pumps', B], ['GET', 'fuel-tanks', B], ['GET', 'stations', B], ['GET', 'categories', B], ['GET', 'branches', B], ['GET', 'payment', B],
    ['GET', 'staff/roles', B], ['GET', 'reports/monthly', B], ['GET', 'reports/monthly/export', B], ['GET', 'expenses/categories', B],
    ['GET', 'stations/unassigned', B], ['GET', 'products', B], ['GET', 'combos', B], ['GET', 'offers', B], ['GET', 'modifiers/groups', B],
    ['GET', 'variants/groups', B], ['GET', 'shifts', B], ['GET', 'shifts/s-1/zreport', B], ['GET', 'shifts/s-1/confirm-view', B],
    ['GET', 'shifts/branch-report', B], ['GET', 'stock/transfers', B], ['GET', 'payment-methods', B], ['GET', 'staff', B],
    ['POST', 'pos/live', B], ['POST', 'something-new', B],
    // A545: a manager confirming / disputing a credit sale at a till is a manager's edit; the list a read; the offline
    // replay (sent later by the sync, the till's own sign-in) background like /changes.
    ['POST', 'credit/sales/o-1/confirm', P], ['POST', 'credit/sales/o-1/dispute', P], ['GET', 'credit/sales', B],
    ['GET', 'credit/sales/count', B], ['POST', 'credit/sales/o-1/replay', B],
  ];
  const wrong = ROUTES.filter(([m, p, k]) => A.classifyGatewayCall(m, `/node/cloud/api/${p}`).kind !== k)
    .map(([m, p, k]) => `${m} ${p}: ${A.classifyGatewayCall(m, `/node/cloud/api/${p}`).kind} (want ${k})`);
  ok(`every till route through the gateway classified (${ROUTES.length} routes)`, wrong.length === 0, wrong.join('; '));

  // Every /api/<first segment> the till's main process names is in the table — a new route must be classified here.
  const segs = new Set();
  const walk = (dir) => { for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) walk(p); else if (/\.ts$/.test(f.name)) {
      for (const m of fs.readFileSync(p, 'utf8').matchAll(/\/api\/([a-z][a-z0-9-]*)/g)) segs.add(m[1]);
    } } };
  walk(path.join(desktop, 'src', 'main'));
  const known = new Set(ROUTES.map(([, p]) => p.split('/')[0]));
  const missing = [...segs].filter((s) => !known.has(s));
  ok('every /api/ route named in src/main is in the table (a new one must be classified)', missing.length === 0, missing.join(', '));

  // A drawer left open all night on a 1.0.19 till: foreign-orders every 20 s for 8 hours.
  A._resetActivity(0);
  const realNow = Date.now;
  let t = Date.UTC(2026, 9, 14, 22, 0, 0);
  try {
    Date.now = () => t;
    let counted = 0;
    for (let i = 0; i < 8 * 180; i++, t += 20_000) {
      if (A.noteGatewayCall('POST', '/node/cloud/api/shifts/s-1/foreign-orders')) counted++;
      if (i % 30 === 0 && A.noteGatewayCall('POST', '/node/cloud/api/auth/verify-pin')) counted++;
      if (i % 90 === 0 && A.noteGatewayCall('POST', '/node/cloud/api/support/logs')) counted++;
    }
    ok('foreign-orders all night: not busy (lastTill stays 0)', counted === 0 && A.activitySnapshot().lastTill === 0, `counted ${counted}`);
    const v = A.installVerdict({ running: '1.0.19', downloaded: '1.0.20', approved: true, downloadedAt: t - DAY, shareReady: true, blocker: null,
      busy: null, lastActivity: Math.max(0, A.activitySnapshot().lastTill), lastTill: A.activitySnapshot().lastTill, quietNow: true, syncSince: null }, t);
    ok('…so the server installs in its quiet hour', v.install === true, v.reason);
    ok('a sale through the gateway counts (lastTill)', A.noteGatewayCall('POST', '/node/cloud/api/orders') && A.activitySnapshot().lastTill === t);
    t += MIN;
    ok('a void counts', A.noteGatewayCall('POST', '/node/cloud/api/orders/o-1/void') && A.activitySnapshot().lastTill === t);
    t += MIN;
    ok('a drawer push with rows counts; one too small to carry a row does not; no size known counts',
      !A.noteGatewayCall('POST', '/node/cloud/api/sync/push', t, 77) && A.noteGatewayCall('POST', '/node/cloud/api/sync/push', t, 640)
      && A.noteGatewayCall('POST', '/node/cloud/api/sync/push', t, null) && A.activitySnapshot().lastTill === t);
    ok('the query string never changes the answer', A.classifyGatewayCall('POST', '/node/cloud/api/orders?x=1').kind === 'trading'
      && A.classifyGatewayCall('POST', '/node/cloud/api/shifts/s-1/foreign-orders?since=1').kind === 'background');
  } finally { Date.now = realNow; }
  const ns = read('src/main/nodeServer.ts');
  ok('the branch server passes the body size to noteGatewayCall', /noteGatewayCall\(req\.method, url, Date\.now\(\), Number\.isFinite\(n\) \? n : null\)/.test(ns)
    && /Number\(req\.headers\['content-length'\]\)/.test(ns));
}

// ── 2. The start-up install ─────────────────────────────────────────────────────────────────────────────────────────
console.log('\n2. Install at start-up (a start at Windows sign-in)\n');
{
  const staged = (o = {}) => ({ version: '1.0.20', installerPath: 'C:\\x\\ZapTill-1.0.20.exe', approved: true, at: '2026-10-18T01:00:00Z', ...o });
  const base = (o = {}) => ({ signInStart: true, updatedLaunch: false, running: '1.0.19', staged: staged(), installerExists: true,
    triedVersion: null, server: true, shareReady: true, ...o });
  const P = (o) => U.startupInstallPlan(base(o));
  ok('downloaded, approved, newer, a sign-in start → install', P({}).install === true, P({}).reason);
  ok('a start by hand: no install', P({ signInStart: false }).install === false);
  ok('the relaunch after an update: no install (no loop)', P({ updatedLaunch: true }).install === false);
  ok('not approved any more (A503): no install', P({ staged: staged({ approved: false }) }).install === false);
  ok('older / the same version: no install', P({ staged: staged({ version: '1.0.18' }) }).install === false && P({ staged: staged({ version: '1.0.19' }) }).install === false);
  ok('not twice after a failure (once per version)', P({ triedVersion: '1.0.20' }).install === false && P({ triedVersion: '1.0.18' }).install === true);
  ok('the cloud now holds, or approves an older one → withdrawn', P({ cloudApproved: null }).withdrawn === true && P({ cloudApproved: '1.0.19' }).withdrawn === true
    && P({ cloudApproved: '1.0.20' }).install === true && P({ cloudApproved: '1.0.21' }).install === true && P({ cloudApproved: undefined }).install === true);
  ok('the installer gone from disk: no install', P({ installerExists: false }).install === false);
  ok('a server without the branch\'s copy for its tills: waits', P({ shareReady: false }).install === false && P({ server: false, shareReady: false }).install === true);

  const run = async (o = {}, f = {}) => {
    const calls = [];
    const r = await U.runStartupInstall({
      input: () => base(o),
      askCloud: async () => ('cloud' in f ? f.cloud : '1.0.20'),
      openDrawers: () => f.drawers ?? 0,
      markTried: (x) => calls.push(`tried:${x.version}`),
      withdraw: () => calls.push('withdraw'),
      task: async () => f.task ?? true,
      viaTask: async (v) => { calls.push(`task:${v}`); return f.taskOk === false ? { ok: false, reason: 'refused' } : { ok: true }; },
      prepareUpdater: async (v) => { calls.push(`prepare:${v}`); return f.prepOk === false ? { ok: false, reason: 'no feed' } : { ok: true, reason: 'ok' }; },
      record: (x) => calls.push(`record:${x.reason}:${x.from}->${x.to}`),
      beforeQuit: () => calls.push('beforeQuit'),
      quit: () => calls.push('quit'),
      quitAndInstall: () => calls.push('quitAndInstall'),
      log: (l) => calls.push(`log:${l}`),
    });
    return { r, calls, seq: calls.filter((c) => !c.startsWith('log:')) };
  };
  {
    const { r, seq } = await run();
    ok('a sign-in start: through the updater task — tried, recorded, closed, quit', r.installing === true
      && seq.join(',') === 'tried:1.0.20,task:1.0.20,record:startup:1.0.19->1.0.20,beforeQuit,quit', seq.join(','));
    ok('the try is recorded before the install', seq.indexOf('tried:1.0.20') === 0);
  }
  {
    const { r, seq } = await run({ signInStart: false });
    ok('a start by hand: nothing at all', r.installing === false && seq.length === 0, seq.join(','));
  }
  {
    const { r, seq } = await run({ triedVersion: '1.0.20' });
    ok('after a failed try: nothing at all (not at every start)', r.installing === false && seq.length === 0, seq.join(','));
  }
  {
    const { r, seq } = await run({}, { cloud: null });
    ok('the cloud put the business on hold: withdrawn, nothing installed', r.installing === false && seq.join(',') === 'withdraw', seq.join(','));
  }
  {
    const { r, seq } = await run({}, { cloud: undefined });
    ok('the cloud does not answer: the last answer stands (installs)', r.installing === true && seq.includes('quit'));
  }
  {
    const { r, seq } = await run({}, { task: false });
    ok('no updater task: the installer (validated first), then quitAndInstall', r.installing === true
      && seq.join(',') === 'tried:1.0.20,prepare:1.0.20,record:startup:1.0.19->1.0.20,beforeQuit,quitAndInstall', seq.join(','));
  }
  {
    const { r, seq } = await run({}, { taskOk: false });
    ok('the task refused: the installer instead', r.installing === true && seq.join(',') === 'tried:1.0.20,task:1.0.20,prepare:1.0.20,record:startup:1.0.19->1.0.20,beforeQuit,quitAndInstall', seq.join(','));
  }
  {
    const { r, seq } = await run({}, { task: false, prepOk: false });
    ok('the installer could not be checked: ZapTill starts as usual (nothing closed), the try is kept', r.installing === false
      && seq.join(',') === 'tried:1.0.20,prepare:1.0.20', seq.join(','));
  }
  {
    const { r, calls } = await run({}, { drawers: 1 });
    ok('an open drawer from before: installs anyway, and says the drawer is kept', r.installing === true
      && calls.some((c) => /1 drawer is open on this machine — kept as they are/.test(c)));
  }

  // The kept records, in the real database.
  U.recordStaged({ version: '1.0.20', installerPath: 'C:\\x\\a.exe', approved: true, at: '2026-10-18T01:00:00Z' });
  ok('the download is kept across restarts (maintenance_state)', U.readStaged()?.version === '1.0.20' && U.readStaged()?.approved === true);
  U.noteStagedApproval(false);
  ok('…and the cloud\'s answer with it (A503)', U.readStaged()?.approved === false);
  U.noteStagedApproval(true);
  U.recordStaged({ version: 'not-a-version', installerPath: null, approved: true, at: 'x' });
  ok('a bad version is never kept', U.readStaged()?.version === '1.0.20');

  // An open drawer survives the restart: it lives in the local database.
  db.prepare(`INSERT INTO shifts (id, business_id, branch_id, cashier_id, opened_at, status, opening_float, created_at) VALUES ('sh-1', 'biz', 'br-1', 'u-1', '2026-10-20T08:00:00Z', 'open', 500, '2026-10-20T08:00:00Z')`).run();
  L.closeLocalDb();
  const db2 = L.getLocalDb();
  const sh = db2.prepare(`SELECT status, opening_float FROM shifts WHERE id = 'sh-1'`).get();
  ok('an open drawer is still open after the database is closed and opened again (the restart)', sh?.status === 'open' && Number(sh.opening_float) === 500);

  // The sign-in hand-over marker.
  const W = '--watchdog';
  const now = Date.UTC(2026, 9, 21, 7, 0, 0);
  ok('--at-login is a sign-in start; --updated never is', S.signInStartFrom(['ZapTill.exe', '--at-login'], null, now) && !S.signInStartFrom(['x', '--at-login', '--updated'], null, now));
  ok('the restart task\'s launch just after a hand-over is a sign-in start', S.signInStartFrom(['x', W], now - 30_000, now));
  ok('a stale hand-over marker: not a sign-in start (a crash restart later)', !S.signInStartFrom(['x', W], now - 6 * MIN, now) && !S.signInStartFrom(['x', W], null, now));
  ok('a start by hand is never one', !S.signInStartFrom(['x'], now - 1000, now));
  S.markSignInHandoff(userData, Date.now());
  ok('the marker is used once', S.consumeSignInStart(['x', W], userData) === true && S.consumeSignInStart(['x', W], userData) === false);

  const idx = read('src/main/index.ts');
  const iInstall = idx.indexOf('await installAtStartIfDue(');
  ok('index.ts: the start-up install before the branch server serves and before any window',
    iInstall > 0 && iInstall < idx.indexOf('startNodeServer();') && iInstall < idx.indexOf('if (!windowless || windowAsked) createWindow();')
    && /const signInStart = consumeSignInStart\(process\.argv, app\.getPath\('userData'\)\)/.test(idx));
  ok('index.ts: closing to install returns before anything else starts', /if \(await installAtStartIfDue\([^\n]{0,120}\)\) \{[\s\S]{0,200}return;\s*\}/.test(idx));
  const gate = read('src/main/startGate.ts');
  ok('startGate: the marker is left before the hand-over to the restart task', gate.indexOf('markSignInHandoff(userData)') > 0
    && gate.indexOf('markSignInHandoff(userData)') < gate.indexOf("execFileSync('schtasks'"));
}

// ── 3. The report says why ──────────────────────────────────────────────────────────────────────────────────────────
console.log('\n3. The update report carries the blocker\n');
{
  const st = { state: 'downloaded', version: '1.0.20', percent: 100, note: null, checkedAt: null, approved: '1.0.20', downloadedAt: Date.UTC(2026, 9, 17) };
  const r = R.buildUpdateReport({ status: st, running: '1.0.19', stateAt: null, idleNote: 'x', task: false,
    blocker: 'Windows asks for permission (UAC) before an install, and nobody is there to give it', server: true, startupFailed: null });
  ok('the report: the blocker, the server role, since when (and task false)', r.blocker?.startsWith('Windows asks for permission') && r.server === true
    && r.task === false && r.downloaded_at === '2026-10-17T00:00:00.000Z' && r.startup_failed === false && r.waiting_server === false);
  const r2 = R.buildUpdateReport({ status: { ...st, state: 'idle', waitingServer: true }, running: '1.0.19', stateAt: null, idleNote: null, task: null, blocker: 'x' });
  ok('a till waiting for the branch server\'s copy says so (no blocker outside a download)', r2.waiting_server === true && r2.blocker === null && r2.server === false);
  ok('a new blocker is a change (sent at once)', R.reportKey(r) !== R.reportKey({ ...r, blocker: null }));
  const r3 = R.buildUpdateReport({ status: st, running: '1.0.19', stateAt: null, idleNote: null, task: true, startupFailed: '1.0.20' });
  ok('a start-up install that did not take is reported', r3.startup_failed === true);

  // The idle installer tells the blocker each minute.
  let told = 'unset';
  const idle = U.createIdleInstaller({
    running: '1.0.19', candidate: () => ({ version: '1.0.20', approved: true }), isServer: () => true, shareReady: () => true,
    blocker: async () => 'Windows asks for permission (UAC) before an install, and nobody is there to give it',
    activity: () => ({ lastUse: 0, lastUseWhat: null, lastTill: 0, busy: null }), quiet: () => true, downloadedAt: () => 0, syncSince: () => null,
    flush: async () => ({ pushed: 0, errors: [], timedOut: false }), markQuitting() {}, stopNodeServer() {}, record() {}, closeDb() {},
    quitAndInstall() {}, log() {}, onBlocker: (b) => { told = b; },
  });
  const v = await idle.tick();
  ok('the idle install hands the blocker to the report', v.install === false && /^Windows asks for permission/.test(String(told)), String(told));

  // A till behind a branch server waiting for the server's copy: the loop's status says so.
  let status = { state: 'idle', version: null, percent: null };
  const loop = U.createUpdateLoop({
    status: () => status, set: (p) => { status = { ...status, ...p }; }, running: '1.0.19', isServer: () => false, log() {},
    askServer: async () => null,
    checkDeps: () => ({ updater: { setFeedURL() {}, requestHeaders: null, checkForUpdates: async () => null },
      fetch: async () => new Response(JSON.stringify({ approvedVersion: '1.0.20' }), { status: 200 }),
      cloudUrl: () => 'http://cloud', token: () => 't', refresh: async () => false, running: '1.0.19',
      share: { prepare: async () => 'busy', route: () => null } }),
  });
  await loop.check('test');
  ok('the loop marks "waiting for the branch server\'s copy"', status.waitingServer === true, JSON.stringify(status));
}

// ── 4. The managers' notice after 3 days ────────────────────────────────────────────────────────────────────────────
console.log('\n4. The notice after 3 days ready — managers only\n');
{
  const bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-a541-b-'));
  require('esbuild').buildSync({ entryPoints: [path.join(desktop, 'src/renderer/lib/updateNotice.ts')], bundle: true, format: 'esm', platform: 'node',
    outfile: path.join(bundleDir, 'n.mjs'), logLevel: 'silent' });
  const N = await import(pathToFileURL(path.join(bundleDir, 'n.mjs')).href);
  const now = Date.UTC(2026, 9, 21, 12);
  const s = { state: 'downloaded', version: '1.0.20', percent: 100, downloadedAt: now - 73 * HOUR };
  const m = N.updateBarContent(s, true, now);
  ok('a manager, ready for 73 h: the notice, word for word, with "Restart now and install"', m.kind === 'stale'
    && m.text === 'ZapTill 1.0.20 is ready — close ZapTill tonight (tray icon → Quit) or restart Windows to install it.' && m.button === 'Restart now and install', JSON.stringify(m));
  const c = N.updateBarContent(s, false, now);
  ok('a cashier never sees the notice (the bar as before, no button)', c.kind === 'ready' && c.button === null && !/tonight/.test(c.text));
  const early = N.updateBarContent({ ...s, downloadedAt: now - 10 * HOUR }, true, now);
  ok('a manager before 3 days: the usual bar with "Restart & update now"', early.kind === 'ready' && early.button === 'Restart & update now');
  ok('no download time known: the usual bar', N.updateBarContent({ ...s, downloadedAt: null }, true, now).kind === 'ready');
  const banner = read('src/renderer/pages/UpdateBanner.tsx');
  ok('UpdateBanner shows it from updateBarContent with the A519 restart (main still checks back office)',
    /updateBarContent\(status, canRestart\)/.test(banner) && /stale\.kind === 'stale'[\s\S]{0,600}onClick=\{restartNow\}[\s\S]{0,200}\{stale\.button\}/.test(banner));
  ok('main sends since when (downloadedAt) with the status', /set\(\{ state: 'downloaded'[^\n]{0,200}downloadedAt: at \}\)/.test(read('src/main/autoUpdate.ts')));
  fs.rmSync(bundleDir, { recursive: true, force: true });
}

try { L.closeLocalDb(); } catch { /* */ }
try { fs.rmSync(userData, { recursive: true, force: true }); } catch { /* */ }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
