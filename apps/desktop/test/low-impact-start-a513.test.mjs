// A513 — a low-impact start (owner, 2026-10-16, a 4 GB / old-i3 PC, Task Manager "High" startup impact): "the window
// does not need to open, the user will open the app if needed, and load the sync sequential, no need to check for
// updates immediately … important items like menu change, staff change, things that affect the business" first; and
// "disable anything else that needs a lot [at start up]".
//
// RUNS the real compiled dist/main — the whole of index.ts in a child process with Electron stood in (REAL SQLite), and
// the start-up pieces in this process:
//   cd apps/desktop && npm run build:main && TZ=UTC node --no-warnings test/low-impact-start-a513.test.mjs
//
// MUTATIONS TO CONFIRM BITE (each verified by editing dist/main and re-running):
//   - gateDecision returning 'go' for --at-login without the marker         → "a till: --at-login ends at once" fails
//   - index.ts creating the window whatever startsWindowless says          → "a server at sign-in: no window" fails
//   - second-instance not making a window when none is open                 → "a second launch makes the window" fails
//   - runStartupSequence without the per-step cap (await s.run() alone)     → "a hung step never blocks the next" fails
//   - the steps' order changed (staff before catalogue)                     → "the order: catalogue → staff → …" fails
//   - whenStartupSettled running fn at once (not after the settle)          → "no update check before the start is over" fails
//   - spellcheck: false removed                                             → "spellcheck off" fails
//   - gpuDecision with >= 8 GB as the low-memory line                       → "low-memory mode at 4 GB, not at 8 GB" fails
//   - keptGeometry ignoring the 30-day age                                  → "a kept size older than 30 days is measured again" fails
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.join(here, '..');
const dist = path.join(desktop, 'dist', 'main');
const require = createRequire(import.meta.url);
const read = (p) => fs.readFileSync(path.join(desktop, p), 'utf8').replace(/\r\n/g, '\n');
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };

// This process's stand-in for Electron (packaged, prod flavour), set before any dist module loads; userData is global.__ud.
const ownUd = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-a513-own-'));
globalThis.__ud = ownUd;
const ownShim = path.join(ownUd, 'electron-shim.cjs');
fs.writeFileSync(ownShim, `module.exports = {
  app: { getPath: () => global.__ud, getVersion: () => '1.0.17', getName: () => 'ZapTill', on() {}, isPackaged: true, exit() {}, quit() {}, relaunch() {},
    requestSingleInstanceLock: () => true, setAppUserModelId() {}, disableHardwareAcceleration() { global.__gpuOff = (global.__gpuOff || 0) + 1; } },
  ipcMain: { handle() {}, on() {} }, BrowserWindow: class { static getAllWindows() { return []; } static getFocusedWindow() { return null; } },
  dialog: {}, shell: {}, Menu: { buildFromTemplate: () => ({}) }, powerMonitor: { on() {}, getSystemIdleTime: () => 0 }, safeStorage: { isEncryptionAvailable: () => false },
  net: { isOnline: () => false }, session: { fromPartition: () => ({ setCertificateVerifyProc() {} }) }, Notification: class {}, Tray: class {},
  nativeImage: {}, powerSaveBlocker: {} };`);
const ownUpd = path.join(ownUd, 'updater-shim.cjs');
fs.writeFileSync(ownUpd, `module.exports = { autoUpdater: { on() {}, checkForUpdates: async () => null, setFeedURL() {}, quitAndInstall() {} } };`);
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) { return req === 'electron' ? ownShim : req === 'electron-updater' ? ownUpd : origResolve.call(this, req, ...rest); };

// ── The child: the whole real index.ts under a stand-in Electron ──────────────────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-a513-'));
const harness = path.join(tmp, 'harness.cjs');
fs.writeFileSync(harness, String.raw`
const Module = require('module'); const path = require('path'); const fs = require('fs');
const [dist, userData, argvJson, role] = process.argv.slice(2);
process.argv = ['ZapTill.exe', ...JSON.parse(argvJson)];
const wins = []; const appOn = {}; let go; const ready = new Promise((r) => { go = r; });
const wc = () => ({ on() {}, once() {}, send() {}, setWindowOpenHandler() {}, openDevTools() {}, closeDevTools() {}, toggleDevTools() {}, isDestroyed: () => false });
class BrowserWindow {
  constructor(o) { this.o = o; this.webContents = wc(); this.destroyed = false; this.shown = 0; wins.push(this); }
  static getAllWindows() { return wins.filter((w) => !w.destroyed); } static getFocusedWindow() { return null; }
  on() {} once(e, f) { if (e === 'ready-to-show') setTimeout(f, 5); } setMenuBarVisibility() {} setTitle() {} loadURL() {} loadFile() {}
  isDestroyed() { return this.destroyed; } isMinimized() { return false; } restore() {} show() { this.shown++; } focus() {} flashFrame() {}
}
const shim = path.join(userData, 'electron-shim.cjs');
global.__electron = {
  app: { getPath: () => userData, getVersion: () => '1.0.17', getName: () => 'ZapTill', isPackaged: false, whenReady: () => ready,
    on(e, f) { (appOn[e] = appOn[e] || []).push(f); }, requestSingleInstanceLock: () => true,
    getAppMetrics: () => [{ memory: { workingSetSize: 120 * 1024 } }, { memory: { workingSetSize: 60 * 1024 } }],
    setLoginItemSettings() {}, exit(c) { process.exit(c); }, quit() {}, relaunch() {}, setAppUserModelId() {}, disableHardwareAcceleration() {} },
  BrowserWindow, ipcMain: { handle() {}, on() {}, removeHandler() {} }, dialog: {}, shell: { openExternal() {} },
  net: { isOnline: () => false }, Menu: { buildFromTemplate: () => ({}), setApplicationMenu() {} },
  Tray: class { setToolTip() {} setContextMenu() {} on() {} destroy() {} }, Notification: class { static isSupported() { return false; } },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) }, powerSaveBlocker: { start: () => 1, stop() {}, isStarted: () => true },
  powerMonitor: { on() {}, getSystemIdleTime: () => 0 }, safeStorage: { isEncryptionAvailable: () => false },
  session: { fromPartition: () => ({ setCertificateVerifyProc() {} }), defaultSession: { setCertificateVerifyProc() {} } }, screen: {},
};
fs.writeFileSync(shim, 'module.exports = global.__electron;');
const updaterShim = path.join(userData, 'updater-shim.cjs');
fs.writeFileSync(updaterShim, 'module.exports = { autoUpdater: { on() {}, checkForUpdates: async () => null, setFeedURL() {}, quitAndInstall() {} } };');
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) { return req === 'electron' ? shim : req === 'electron-updater' ? updaterShim : orig.call(this, req, ...rest); };
if (role) {
  require(path.join(dist, 'deviceConfig.js')).saveDeviceConfig({ deploy_mode: 'cloud', server_url: 'http://127.0.0.1:9', branch_id: 'br-1',
    device_id: 'dev-1', device_role: role, terminal_code: 'T1', device_name: 'Back office', configured: true });
}
require(path.join(dist, 'index.js'));
process.stdout.write('LOADED\n');
go();
const logFile = path.join(userData, 'swiftpos.log');
const until = Date.now() + 15000;
(function wait() {
  const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
  if (!/start \(/.test(log) && Date.now() < until) return setTimeout(wait, 50);
  const atStart = wins.length;
  const opts = wins[0] ? wins[0].o : null;
  for (const f of appOn['second-instance'] || []) f({}, ['ZapTill.exe', '--at-login']);
  const afterAuto = wins.length;
  for (const f of appOn['second-instance'] || []) f({}, ['ZapTill.exe']);
  const afterHand = wins.length;
  const spell = wins[0] ? wins[0].o.webPreferences.spellcheck : undefined;
  process.stdout.write('RESULT ' + JSON.stringify({ atStart, afterAuto, afterHand, spell, shown: wins[0] ? wins[0].shown : 0, hadOpts: !!opts }) + '\n');
  process.exit(0);
})();
`);
const NODE_PATH = process.env.NODE_PATH ?? '';
function runChild(name, argv, { role = null, marker = false, quit = false } = {}) {
  const ud = fs.mkdtempSync(path.join(tmp, `${name}-`));
  if (marker) fs.writeFileSync(path.join(ud, 'start-at-sign-in.flag'), 'x');
  if (quit) fs.writeFileSync(path.join(ud, 'quit-by-hand.flag'), 'x');
  const r = spawnSync(process.execPath, ['--no-warnings', harness, dist, ud, JSON.stringify(argv), role ?? ''], {
    encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, NODE_PATH, SWIFTPOS_NODE_PORT: String(40000 + Math.floor(Math.random() * 20000)), TZ: 'UTC' },
  });
  const log = fs.existsSync(path.join(ud, 'swiftpos.log')) ? fs.readFileSync(path.join(ud, 'swiftpos.log'), 'utf8') : '';
  const m = /RESULT (.*)/.exec(r.stdout ?? '');
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '', log, res: m ? JSON.parse(m[1]) : null };
}

console.log('\n1. Start after sign-in, not at it — the gate (startGate.ts runs before anything else loads)\n');
{
  const till = runChild('till', ['--at-login']);
  ok('a till: --at-login ends at once — before the rest of ZapTill loads (no window, no log, nothing)',
    till.code === 0 && !till.out.includes('LOADED') && !till.log, JSON.stringify({ code: till.code, out: till.out.slice(0, 200), err: till.err.slice(0, 400) }));
  const wd = runChild('quit', ['--watchdog'], { marker: true, quit: true });
  ok('a restart-task launch after a quit by hand: ends at once too', wd.code === 0 && !wd.out.includes('LOADED') && !wd.log, JSON.stringify({ code: wd.code, out: wd.out.slice(0, 200) }));
}
{
  const L = require(path.join(dist, 'lowImpactStart.js'));
  ok('the decisions: till → exit; server --at-login → hand over to the restart task; the Run fallback → go (it waits)',
    L.gateDecision(['z', '--at-login'], { server: false, quitByHand: false }) === 'exit'
    && L.gateDecision(['z', '--at-login'], { server: true, quitByHand: false }) === 'handoff'
    && L.gateDecision(['z', '--at-login', '--login-wait'], { server: true, quitByHand: false }) === 'go'
    && L.gateDecision(['z'], { server: false, quitByHand: false }) === 'go');
  ok('the start task\'s name matches the installer\'s, per flavour',
    L.startTaskName('ZapTill') === 'ZapTill start at sign-in' && L.startTaskName('ZapTill Dev') === 'ZapTill Dev start at sign-in'
    && read('build/installer.nsh').includes('schtasks /Create /TN "${PRODUCT_NAME} start at sign-in" /XML "$PLUGINSDIR\\start-task.xml" /F'));
  const inst = read('build/installer.nsh');
  ok('the installer\'s sign-in task: a logon trigger 45 s after sign-in, ZapTill.exe --at-login, the signed-in user (Users, least privilege), no time limit, normal priority',
    inst.includes('<Triggers><LogonTrigger><Enabled>true</Enabled><Delay>PT45S</Delay></LogonTrigger></Triggers>')
    && inst.includes('<Principal id="Author"><GroupId>S-1-5-32-545</GroupId><RunLevel>LeastPrivilege</RunLevel></Principal>')
    && inst.includes('<Command>"$INSTDIR\\${APP_EXECUTABLE_FILENAME}"</Command><Arguments>--at-login</Arguments>')
    && /start-task\.xml[\s\S]*<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit><Priority>5<\/Priority>/.test(inst));
  ok('…registered for BOTH flavours (outside the prod-only A509 block), removed on a real uninstall only',
    inst.indexOf('start-task.xml') < inst.indexOf('!if "${PRODUCT_NAME}" == "ZapTill"')
    && /\$\{ifNot\} \$\{isUpdated\}\s*nsExec::ExecToLog 'schtasks \/Delete \/TN "\$\{PRODUCT_NAME\} start at sign-in" \/F'/.test(inst));
  const S = require(path.join(dist, 'serverMode.js'));
  ok('the Run entry: removed where the sign-in task is there; kept as "--at-login --login-wait" where it is not',
    JSON.stringify(S.loginEntryPlan(true)) === '{"openAtLogin":false}'
    && JSON.stringify(S.loginEntryPlan(false)) === '{"openAtLogin":true,"args":["--at-login","--login-wait"]}');
  const idx = read('src/main/index.ts');
  ok('the Run fallback waits 45 s before anything starts', L.LOGIN_WAIT_MS === 45_000
    && /if \(process\.argv\.includes\(AT_LOGIN_ARG\) && process\.argv\.includes\(LOGIN_WAIT_ARG\)\) \{\n[^\n]*\n\s*await new Promise\(\(r\) => setTimeout\(r, LOGIN_WAIT_MS\)\);/.test(idx));
  const sm = read('src/main/serverMode.ts');
  ok('server mode writes the marker; leaving it (not on the way out) removes it — a till\'s sign-in launch then ends',
    sm.includes("setStartsAtSignIn(app.getPath('userData'), true);") && sm.includes("if (!quitting) setStartsAtSignIn(app.getPath('userData'), false);"));
}

console.log('\n2. No window at auto-start — the whole real index.ts\n');
{
  const srv = runChild('server', ['--at-login'], { role: 'node', marker: true });
  const r = srv.res;
  ok('a server started at sign-in: ZapTill starts, no window is created', !!r && r.atStart === 0, JSON.stringify({ r, err: srv.err.slice(-600) }));
  ok('…the log says it runs in the tray', /started after sign-in as the branch server — in the tray, no window until someone opens it/.test(srv.log));
  ok('a second launch by the sign-in task (or the updater) makes no window', !!r && r.afterAuto === 0);
  ok('a second launch by hand makes the window (and shows it)', !!r && r.afterHand === 1 && r.shown >= 1, JSON.stringify(r));
  ok('spellcheck off in the window', !!r && r.spell === false);
  const order = [...srv.log.matchAll(/step (\w+) \(/g)].map((m) => m[1]);
  ok('the sequence ran in order: catalogue → staff → settings → push → pulls → rest',
    JSON.stringify(order) === JSON.stringify(['catalogue', 'staff', 'settings', 'push', 'pulls', 'rest']), JSON.stringify(order));
  ok('one plain line per step with its ms', /step catalogue \(menu, prices, offers, payment methods, M-Pesa and business settings\): done in \d+ ms/.test(srv.log));
  ok('the timing line: ready / window / sequence / memory summed over the processes',
    /start \(after sign-in, no window\): ready \d+\.\d s, window none, sync sequence done \d+\.\d s, memory 180 MB in 2 processes/.test(srv.log), srv.log.split('\n').filter((l) => /start \(/.test(l)).join(' | '));

  const till = runChild('hand', [], { role: 'till' });
  ok('a till opened by hand opens its window at once, as before', !!till.res && till.res.atStart === 1, JSON.stringify({ r: till.res, err: till.err.slice(-400) }));
  ok('…and its timing line has the window', /start \(by hand\): ready \d+\.\d s, window \d+\.\d s, sync sequence done/.test(till.log));
  const tillWd = runChild('tillwd', ['--updated'], { role: 'till' });
  ok('a till relaunched after an update (no marker) opens its window', !!tillWd.res && tillWd.res.atStart === 1);
}
{
  const sm = read('src/main/serverMode.ts');
  const idx = read('src/main/index.ts');
  ok('the tray\'s Open / click make the window if there is none (showWindow → makeWindow)',
    /if \(!win && makeWindow\) win = makeWindow\(\);/.test(sm) && sm.includes("{ label: 'Open ZapTill', click: () => { showWindow(); } }"));
  ok('printing never needs the main window: its notices go to the main window when there is one (not "the first window")',
    idx.includes('initPrinting(getLocalDb(), () => openMainWindow());'));
  ok('a server that stops serving with no window open opens it (never left running unseen)',
    sm.includes('if (!quitting && !openMainWindow() && makeWindow) showWindow();') && idx.includes("if (!isServing() && !openMainWindow()) { logLine('startup', 'not serving after the start — opening the window'); showWindow(); }"));
  ok('no spell-checker languages set anywhere (no dictionary download)', !/setSpellCheckerLanguages|setSpellCheckerDictionaryDownloadURL/.test(
    fs.readdirSync(path.join(desktop, 'src/main')).filter((f) => f.endsWith('.ts')).map((f) => read(`src/main/${f}`)).join('\n')));
}

console.log('\n3. The sequence — one step at a time, each capped\n');
{
  const L = require(path.join(dist, 'lowImpactStart.js'));
  const seen = []; const lines = [];
  // Raced against 3 s here: without the cap the sequence never ends, and this test says so instead of hanging.
  const HUNG = [{ name: 'never', ms: -1, outcome: 'never' }, { name: 'never', ms: -1, outcome: 'never' }, {}, {}];
  const r = await Promise.race([L.runStartupSequence([
    { name: 'a', what: 'A', run: async () => { seen.push('a+'); await new Promise((x) => setTimeout(x, 20)); seen.push('a-'); } },
    { name: 'hung', what: 'H', run: () => new Promise(() => { seen.push('hung'); }) },
    { name: 'bad', what: 'B', run: () => { throw new Error('boom'); } },
    { name: 'z', what: 'Z', run: () => { seen.push('z'); } },
  ], { log: (l) => lines.push(l), capMs: 150 }), new Promise((x) => setTimeout(() => x(HUNG), 3000))]);
  ok('one step at a time: the first finishes before the next starts', JSON.stringify(seen) === '["a+","a-","hung","z"]', JSON.stringify(seen));
  ok('a hung step never blocks the next (capped, the next starts)', r[1].outcome === 'capped' && r[1].ms >= 140 && r[1].ms < 1000, JSON.stringify(r[1]));
  ok('a failing step: the next still runs', r[2].outcome === 'failed' && r[3].outcome === 'done');
  ok('one plain line per step', lines.length === 4 && /^step a \(A\): done in \d+ ms$/.test(lines[0]) && /still running after \d+ ms/.test(lines[1]) && /failed after \d+ ms \(boom\)/.test(lines[2]), lines.join(' | '));
  ok('the cap is 20 s', L.STEP_CAP_MS === 20_000);
  const idx = read('src/main/index.ts');
  ok('the regular beats begin only after the sequence, in groups (none in the first seconds)',
    /markStartupSettled\(\);[\s\S]{0,600}startSyncTimers\(\);\s*setTimeout\(startStaffTimers, 3_000\);\s*setTimeout\(startBranchTimers, 6_000\);/.test(idx)
    && !/setTimeout\(\(\) => \{ void nodeReplicationTick\(\); \}, 5_000\)/.test(idx) && !/setTimeout\(tlsTick, 8_000\)/.test(idx)
    && !/syncAll\(\)\.catch\(console\.error\);\s*\}\s*\}/.test(idx));
}

console.log('\n4. The update check later — after the start, and not before ~4 minutes\n');
{
  const L = require(path.join(dist, 'lowImpactStart.js'));
  ok('the first check: 4 min after launch at the earliest, and 30 s after the start is over',
    L.updateCheckDelayMs(10_000) === 230_000 && L.updateCheckDelayMs(10 * 60_000) === 30_000);
  const au = read('src/main/autoUpdate.ts');
  ok('wired: check, server question, hourly beat and the idle install\'s minute all inside whenStartupSettled',
    /whenStartupSettled\(\(\) => \{[\s\S]*?void loop\.check\('start'\);[\s\S]*?void loop\.ask\(\);[\s\S]*?startIdleTicks\(\);\s*\}, \{ minSinceLaunchMs: UPDATE_AFTER_LAUNCH_MS, afterMs: UPDATE_AFTER_SETTLED_MS \}\);/.test(au)
    && (au.match(/void loop\.check\('start'\)/g) || []).length === 1);
  ok('the updater task is asked only once something is downloaded (no schtasks at start or every hour before)',
    !/\n  void updaterTaskAvailable\(\);\n/.test(au) && au.includes("autoUpdater.on('update-downloaded', () => { void updaterTaskAvailable(); });")
    && au.includes("setInterval(() => { if (current.state === 'downloaded') void updaterTaskAvailable(); }, ONE_HOUR);"));
}

// The real initAutoUpdate (packaged, prod flavour): nothing until settled, then the first check after the delay.
{
  const L = require(path.join(dist, 'lowImpactStart.js'));
  const U = require(path.join(dist, 'autoUpdate.js'));
  const first = () => U.getUpdateDiagnostics().log.some((l) => /the first update check/.test(l.line));
  const realSetTimeout = globalThis.setTimeout; const held = [];
  U.initAutoUpdate();
  await new Promise((r) => realSetTimeout(r, 50));
  ok('no update check before the start is over', !first());
  ok('the updater task is not asked at start (not known yet)', U.getUpdateDiagnostics().updaterTask.installed === null, JSON.stringify(U.getUpdateDiagnostics().updaterTask));
  globalThis.setTimeout = (fn, ms, ...a) => { if (ms >= 30_000) { held.push({ fn, ms }); return { unref() {} }; } return realSetTimeout(fn, ms, ...a); };
  L.markStartupSettled();
  await new Promise((r) => realSetTimeout(r, 50));
  globalThis.setTimeout = realSetTimeout;
  ok('…settled: still not at once — held for the rest of the 4 minutes', !first() && held.some((h) => h.ms >= 200_000), JSON.stringify(held.map((h) => h.ms)));
  try { held.find((h) => h.ms >= 200_000)?.fn(); } catch { /* the check itself fails soft offline */ }
  await new Promise((r) => realSetTimeout(r, 50));
  ok('…then the first check runs', first());
  ok('the Tech page gets the startup line and the graphics line', 'startup' in U.getUpdateDiagnostics() && 'graphics' in U.getUpdateDiagnostics());
}

console.log('\n5. A lighter renderer, and nothing heavy at start\n');
{
  const idx = read('src/main/index.ts');
  ok('spellcheck: false in the window\'s webPreferences (backgroundThrottling left at its default)', /webPreferences: \{[^}]*spellcheck: false,[^}]*\}/.test(idx) && !/backgroundThrottling:/.test(idx));
  ok('the old start-up syncAll (everything at once, before the window) is gone', !/if \(net\.isOnline\(\)\) \{\s*syncAll\(\)/.test(idx));
  const G = (() => {
    const ud = fs.mkdtempSync(path.join(tmp, 'gpu-'));
    globalThis.__ud = ud; globalThis.__gpuOff = 0;
    delete require.cache[require.resolve(path.join(dist, 'startGate.js'))];
    const g = require(path.join(dist, 'startGate.js'));
    return { g, ud };
  })();
  const GB = 1024 ** 3;
  ok('low-memory mode at 4 GB, not at 8 GB (auto)', G.g.gpuDecision('auto', 4 * GB).off === true && G.g.gpuDecision('auto', 8 * GB).off === false
    && /low-memory mode — hardware acceleration off \(4\.0 GB memory\)/.test(G.g.gpuDecision('auto', 4 * GB).line));
  ok('a technician\'s override wins: "on" keeps the GPU on a 4 GB machine; "off" turns it off on any',
    G.g.gpuDecision('on', 4 * GB).off === false && G.g.gpuDecision('off', 16 * GB).off === true && /gpu-mode\.json/.test(G.g.gpuDecision('on', 4 * GB).line));
  fs.writeFileSync(path.join(G.ud, 'gpu-mode.json'), '{"mode":"on"}');
  ok('gpu-mode.json read synchronously; anything else is "auto"', G.g.readGpuMode(G.ud) === 'on'
    && (fs.writeFileSync(path.join(G.ud, 'gpu-mode.json'), '{bad'), G.g.readGpuMode(G.ud) === 'auto'));
  ok('the gate turned it off (or not) by this machine\'s memory, before ready, and said so',
    (os.totalmem() <= G.g.LOW_MEMORY_BYTES) === (globalThis.__gpuOff === 1) && typeof G.g.gpuLine === 'string');
  ok('…logged once the log is up', idx.includes("if (gpuLine) logLine('startup', gpuLine);"));
}

console.log('\n6. Printer paper size kept across restarts; Get-Printer only on the printers screen\n');
{
  const ud = fs.mkdtempSync(path.join(tmp, 'geo-'));
  const cp = require('node:child_process');
  const realExecFile = cp.execFile; let spawned = 0;
  cp.execFile = (cmd, args, opts, cb) => { spawned++; setImmediate(() => cb(new Error('no printer here'), '', '')); return { on() {} }; };
  const P = require(path.join(dist, 'printService.js'));
  const file = path.join(ud, 'printer-geometry.json');
  P._setGeometryFile(file);
  const g = { paperMm: 80, printableMm: 72.1, offsetMm: 4 };
  fs.writeFileSync(file, JSON.stringify({ printers: ['XP-80'], entries: { 'XP-80': { g, at: Date.now() - 86_400_000 } } }));
  ok('a size measured on an earlier start is used (no PowerShell)', JSON.stringify(P.keptGeometry('XP-80')) === JSON.stringify(g));
  if (process.platform === 'win32') {
    const got = await P.probeGeometry('XP-80');
    ok('…probeGeometry answers from it without spawning anything', JSON.stringify(got) === JSON.stringify(g) && spawned === 0, `spawned ${spawned}`);
  }
  fs.writeFileSync(file, JSON.stringify({ printers: ['XP-80'], entries: { 'XP-80': { g, at: Date.now() - 31 * 86_400_000 } } }));
  ok('a kept size older than 30 days is measured again', P.keptGeometry('XP-80') === undefined);
  fs.writeFileSync(file, JSON.stringify({ printers: ['XP-80'], entries: { 'XP-80': { g, at: Date.now() } } }));
  P._setGeometryFile(file);
  P.forgetGeometry('XP-80');
  ok('a failed print to that printer: measured again next time', P.keptGeometry('XP-80') === undefined);
  fs.writeFileSync(file, JSON.stringify({ printers: ['XP-80'], entries: { 'XP-80': { g, at: Date.now() } } }));
  ok('the same printer list: kept', P.notePrinterList(['XP-80']) === false && !!P.keptGeometry('XP-80'));
  ok('the printer list changed: every size measured again', P.notePrinterList(['XP-80', 'Kitchen']) === true && P.keptGeometry('XP-80') === undefined);
  ok('"could not tell" (null) is never kept', /if \(g\) keepGeometry\(deviceName, g\);/.test(read('src/main/printService.ts')));
  ok('wired: a failed HTML print forgets; the printer list from Windows is noted',
    /if \(!r\.ok && opts\.deviceName\) \{ try \{ forgetGeometry\(opts\.deviceName\); \}/.test(read('src/main/printService.ts'))
    && /if \(printers\.length\) \{ try \{ notePrinterList\(printers\.map\(p => p\.name\)\); \}/.test(read('src/main/printService.ts')));
  cp.execFile = realExecFile;
  const ipc = read('src/main/ipcHandlers.ts');
  ok('Get-Printer (printerShares) runs only when the printers screen asks — never at start',
    (ipc.match(/printerShares\(\)/g) || []).length === 1 && ipc.includes("handle('print:shares', async () => await printerShares());")
    && !/printerShares|probeGeometry/.test(read('src/main/index.ts'))
    && /useEffect/.test(read('src/renderer/screens/PrinterSetupScreen.tsx')));
  ok('the machine identity (A512) is still read once and kept', read('src/main/index.ts').includes("loadMachineIdentity(process.platform, path.join(app.getPath('userData'), 'machine-identity.json'))"));
}

fs.rmSync(tmp, { recursive: true, force: true });
try { fs.rmSync(ownUd, { recursive: true, force: true }); } catch { /* the DB may still be open */ }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
