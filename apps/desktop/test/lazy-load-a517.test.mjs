// A517 — a lighter start for slow PCs (4 GB, an old i3): load less at start.
//
// Owner, 2026-10-16: "there are some items you haven't done about start up can you start working on them" — the one left
// from the agreed plan: "load rarely used screens only when they're opened, so the PIN screen and POS appear sooner and
// use less memory", and the same in the main process.
//
// Measured before the change (this repo, a dev PC): the screens were ONE 757.5 kB chunk (gzip 210.5 kB) — the manager
// screens, the Tech page, setup and help parsed at every start; main required 744 files before 'ready' (exceljs ~600 of
// them, ~290 ms; electron-updater and its packages ~100 ms), 360-560 ms of require under Electron. After: the main chunk
// 402.6 kB (gzip 121.9 kB) with the PIN screen, the POS and what a sale needs; the manager screens (274.6 kB), Tech page,
// install, enrolment and help their own chunks; main 123 files, 80-115 ms.
//
//   cd apps/desktop && npm run build:main && node test/lazy-load-a517.test.mjs
//
// RUNS: (1) the real renderer build (vite, in memory — nothing written to dist/) and reads which modules land in which
// chunk; the source rules that keep it so; (2) the real background-preload rule (lib/preloadScreens.ts, bundled with
// esbuild); (3) the whole real compiled index.ts under a stand-in Electron (packaged, prod flavour, REAL SQLite), with
// every require watched — exceljs and electron-updater are not required by the start, and are at their first use.
//
// MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted):
//   - App.tsx importing ManagerPage statically again                     → "the main chunk holds no manager screen" fails
//   - App.tsx rendering a lazy screen without <Lazy> (no Suspense)       → "every lazy screen is rendered inside <Lazy>" fails
//   - dailySalesReport.ts `import ExcelJS from 'exceljs'` at the top     → "exceljs is not required by the start" fails
//   - autoUpdate.ts `import { autoUpdater } from 'electron-updater'`     → "electron-updater is not required by the start" fails
//   - initAutoUpdate's settings / listeners not applied on first load    → "…its settings and listeners are applied" fails
//   - preloadVerdict ignoring navigator.deviceMemory                      → "a 4 GB machine never preloads" fails
//   - preloadAnswer ignoring `settled`                                    → "not while ZapTill is still starting" fails
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.join(here, '..');
const dist = path.join(desktop, 'dist', 'main');
const require = createRequire(import.meta.url);
const read = (p) => fs.readFileSync(path.join(desktop, p), 'utf8').replace(/\r\n/g, '\n');
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${d}`); fail++; } };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-a517-'));

// ── 1. The screens: what is in the main chunk ───────────────────────────────────────────────────────────────────────
console.log('\n1. Rarely used screens load when opened — the PIN screen and the POS do not wait for them\n');
const LAZY = { ManagerPage: 'pages/ManagerPage', TechPage: 'pages/TechPage', InstallPage: 'pages/InstallPage',
  EnrolPage: 'pages/EnrolPage', HelpScreen: 'components/HelpScreen' };
{
  const app = read('src/renderer/App.tsx');
  for (const [name, p] of Object.entries(LAZY)) {
    ok(`${name}: never imported statically by App.tsx`, !new RegExp(`^import\\s+${name}\\b[^\\n]*from\\s+'\\./${p}'`, 'm').test(app)
      && !new RegExp(`^import[^\\n]*'\\./${p}'`, 'm').test(app));
  }
  ok('…each a React.lazy dynamic import', /const loadManagerPage = \(\) => import\('\.\/pages\/ManagerPage'\);\nconst ManagerPage = lazy\(loadManagerPage\);/.test(app)
    && ['TechPage', 'InstallPage', 'EnrolPage'].every((n) => app.includes(`const ${n} = lazy(() => import('./pages/${n}'));`))
    && app.includes("const HelpScreen = lazy(() => import('./components/HelpScreen'));"));
  ok('a Suspense fallback: the dark screen and spinner of the start (no layout jump); an overlay for help',
    app.includes('<Suspense fallback={<ScreenLoading overlay={overlay} />}>{children}</Suspense>')
    && /function ScreenLoading[\s\S]*?min-h-screen bg-gray-950[\s\S]*?border-action-400 border-t-transparent rounded-full animate-spin/.test(app)
    && /<Lazy overlay[^\n]*?><HelpScreen/.test(app));   // A519: the help overlay's boundary names it and closes it
  const tags = [...app.matchAll(/<(ManagerPage|TechPage|InstallPage|EnrolPage|HelpScreen)\b/g)].map((m) => m.index);
  ok('every lazy screen is rendered inside <Lazy> (a Suspense boundary)', tags.length === 5 && tags.every((i) => {
    const before = app.slice(0, i); return before.lastIndexOf('<Lazy') > before.lastIndexOf('</Lazy>');
  }), `${tags.length} tags`);
  for (const f of ['src/renderer/pages/POSPage.tsx', 'src/renderer/pages/PinPage.tsx', 'src/renderer/main.tsx']) {
    const s = read(f);
    ok(`${path.basename(f)} imports none of the lazy screens`, !/from '[^']*\/(ManagerPage|TechPage|InstallPage|EnrolPage|HelpScreen|ManageTabs)'/.test(s));
  }
  ok('the chunks load from file:// — vite base is relative', /base: '\.\/'/.test(read('vite.config.ts')));
  ok('…and every chunk is packaged (electron-builder takes dist/ wholesale)', /files: \[\s*'dist\/\*\*\/\*'/.test(read('electron-builder.config.js')));
}

let vite = null;
try { vite = await import(pathToFileURL(require.resolve('vite', { paths: [desktop] })).href); } catch { /* not installed */ }
if (!vite) {
  console.log('  SKIPPED the build check — vite is not installed here (npm ci in apps/desktop)');
} else {
  const out = await vite.build({ root: desktop, configFile: path.join(desktop, 'vite.config.ts'), logLevel: 'silent',
    build: { write: false, emptyOutDir: false } });
  const output = (Array.isArray(out) ? out[0] : out).output;
  const chunks = output.filter((o) => o.type === 'chunk');
  const entry = chunks.find((c) => c.isEntry);
  const mods = (c) => Object.keys(c.modules).map((m) => m.replace(/\\/g, '/'));
  const inEntry = (rel) => mods(entry).some((m) => m.endsWith(`/src/renderer/${rel}`));
  const kb = (c) => (c.code.length / 1024).toFixed(1);
  console.log(`  (built: main chunk ${kb(entry)} kB; ${chunks.filter((c) => !c.isEntry).map((c) => `${c.name} ${kb(c)} kB`).join(', ')})`);
  ok('the main chunk holds the PIN screen, the POS and what a sale needs',
    ['pages/PinPage.tsx', 'pages/POSPage.tsx', 'components/PaymentModal.tsx', 'pages/ShiftPanel.tsx', 'components/HeldOrdersModal.tsx',
      'lib/printReceipt.ts', 'lib/cart.ts', 'components/LockCurtain.tsx'].every(inEntry));
  const managerOnly = ['pages/ManagerPage.tsx', 'pages/ManageTabs.tsx', 'pages/MenuWorkbench.tsx', 'pages/BranchCloseTab.tsx',
    'pages/DayCloseTab.tsx', 'components/SettingsPanel.tsx', 'components/MonthlyPackTab.tsx', 'components/TransfersTab.tsx',
    'screens/OffersScreen.tsx', 'screens/PrintersScreen.tsx', 'components/TillWastage.tsx'];
  ok('the main chunk holds no manager screen (Overview, reports, staff, stock, wastage, offers, close day, settings…)',
    !managerOnly.some(inEntry), managerOnly.filter(inEntry).join(', '));
  ok('…nor the Tech page, setup (install, enrolment) or help', !['pages/TechPage.tsx', 'pages/BrandingEditor.tsx', 'pages/InstallPage.tsx',
    'pages/EnrolPage.tsx', 'components/HelpScreen.tsx'].some(inEntry));
  const dyn = (rel) => chunks.find((c) => c.isDynamicEntry && mods(c).some((m) => m.endsWith(`/src/renderer/${rel}`)));
  ok('each is its own chunk, loaded on demand', Object.values(LAZY).every((p) => dyn(`${p}.tsx`)));
  ok('the main chunk is under 450 kB (757.5 kB before A517)', entry.code.length < 450 * 1024, `${kb(entry)} kB`);
  ok('the lazy chunks are imported by a relative path (file:// in the packaged app)',
    /import\("\.\/ManagerPage-[\w-]+\.js"\)/.test(entry.code) && !/import\("\/assets\//.test(entry.code));
  const html = output.find((o) => o.fileName === 'index.html');
  ok('index.html loads the main chunk relatively', !!html && /src="\.\/assets\/index-[\w-]+\.js"/.test(String(html.source)));
}

// ── 2. The background preload of the manager screens ────────────────────────────────────────────────────────────────
console.log('\n2. The manager screens fetched in the background — once the till is quiet, never on a 4 GB machine\n');
{
  const outFile = path.join(tmp, 'preloadScreens.mjs');
  require('esbuild').buildSync({ entryPoints: [path.join(desktop, 'src/renderer/lib/preloadScreens.ts')], bundle: true, format: 'esm',
    outfile: outFile, logLevel: 'silent' });
  const P = await import(pathToFileURL(outFile).href);
  const yes = { ok: true, settled: true, why: 'ok' };
  ok('a 4 GB machine never preloads (navigator.deviceMemory 4, 2, 0.5)', [4, 2, 0.5].every((m) => P.preloadVerdict(m, yes) === 'never'));
  ok('8 GB (or not reported) with main\'s yes → load', P.preloadVerdict(8, yes) === 'load' && P.preloadVerdict(undefined, yes) === 'load');
  ok('main still starting → later; main says low memory → never; main not answering → never',
    P.preloadVerdict(8, { ok: false, settled: false, why: 'starting' }) === 'later'
    && P.preloadVerdict(8, { ok: false, settled: true, why: 'low' }) === 'never' && P.preloadVerdict(8, null) === 'never');
  const run = async (answers, mem = 8) => {
    const timers = []; let loads = 0; let asks = 0; let idles = 0;
    const d = { load: async () => { loads++; }, ask: async () => answers[Math.min(asks++, answers.length - 1)], deviceMemory: () => mem,
      wait: (ms, fn) => { timers.push(ms); queueMicrotask(fn); return () => {}; }, idle: (fn) => { idles++; fn(); } };
    const state = { done: false };
    P.schedulePreload(d, state);
    for (let i = 0; i < 40; i++) await new Promise((r) => setImmediate(r));
    return { timers, loads, asks, idles, state };
  };
  const a = await run([yes]);
  ok(`the first fetch: ${P.PRELOAD_AFTER_MS / 1000} s after the screen settles, at an idle moment, then main is asked`,
    a.timers[0] === P.PRELOAD_AFTER_MS && a.idles === 1 && a.asks === 1 && a.loads === 1 && a.state.done === true, JSON.stringify(a));
  const b = await run([{ ok: false, settled: false, why: 'ZapTill is still starting' }, yes]);
  ok('during the start-up sequence: nothing fetched; asked again 30 s later', b.loads === 1 && b.asks === 2 && b.timers[1] === P.PRELOAD_RETRY_MS, JSON.stringify(b));
  const c = await run([{ ok: false, settled: false, why: 'starting' }]);
  ok(`…and given up after ${P.PRELOAD_TRIES} tries (it loads when opened)`, c.loads === 0 && c.asks === P.PRELOAD_TRIES);
  const e = await run([yes], 4);
  ok('a 4 GB machine: never fetched', e.loads === 0 && e.state.done === true);
  const again = { done: true }; let n = 0;
  P.schedulePreload({ load: async () => { n++; }, ask: async () => yes, deviceMemory: () => 8, wait: (ms, fn) => { fn(); return () => {}; }, idle: (fn) => fn() }, again);
  await new Promise((r) => setImmediate(r));
  ok('once per run (already fetched → nothing)', n === 0);
  const app = read('src/renderer/App.tsx');
  ok('App: only on the PIN screen and the POS, with the same import the manager screen uses',
    /if \(state !== 'pin' && state !== 'pos'\) return;[\s\S]{0,200}schedulePreload\(browserPreloadDeps\(loadManagerPage, \(\) => ask\(\)\), preloaded\.current\)/.test(app));
  ok('the browser\'s idle moment (requestIdleCallback) and deviceMemory are used', /requestIdleCallback/.test(read('src/renderer/lib/preloadScreens.ts'))
    && /navigator as unknown as \{ deviceMemory\?: number \}/.test(read('src/renderer/lib/preloadScreens.ts')));

  const L = require(path.join(dist, 'lowImpactStart.js'));
  const GB = 1024 ** 3;
  ok('main: not while ZapTill is still starting (A513 sequence)', L.preloadAnswer({ settled: false, totalBytes: 16 * GB, freeBytes: 8 * GB }).ok === false
    && L.preloadAnswer({ settled: false, totalBytes: 16 * GB, freeBytes: 8 * GB }).settled === false);
  ok('main: not on a 4 GB machine, nor with under 1 GB free; yes on 8 GB',
    L.preloadAnswer({ settled: true, totalBytes: 4 * GB, freeBytes: 2 * GB }).ok === false
    && L.preloadAnswer({ settled: true, totalBytes: 8 * GB, freeBytes: 0.5 * GB }).ok === false
    && L.preloadAnswer({ settled: true, totalBytes: 8 * GB, freeBytes: 2 * GB }).ok === true);
  ok('bridged: idle:mayPreload (preload, schema, handler)', read('src/main/preload.ts').includes("mayPreload: ()                                  => ipcRenderer.invoke('idle:mayPreload'),")
    && read('src/main/ipcSchemas.ts').includes("'idle:mayPreload': NO_PAYLOAD,")
    && read('src/main/ipcHandlers.ts').includes("handle('idle:mayPreload', async () => preloadAnswer({ settled: startupSettled(), totalBytes: os.totalmem(), freeBytes: os.freemem() }));"));
}

// ── 3. Main: the start requires neither exceljs nor electron-updater ────────────────────────────────────────────────
console.log('\n3. Main loads less at start — exceljs and electron-updater at their first use\n');
{
  const harness = path.join(tmp, 'harness.cjs');
  fs.writeFileSync(harness, String.raw`
const Module = require('module'); const path = require('path'); const fs = require('fs');
const [dist, userData] = process.argv.slice(2);
process.argv = ['ZapTill.exe'];
const requested = new Set();
const origLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (!req.startsWith('.') && !path.isAbsolute(req) && !req.startsWith('node:')) requested.add(req.split('/').slice(0, req.startsWith('@') ? 2 : 1).join('/'));
  return origLoad.apply(this, arguments);
};
let go; const ready = new Promise((r) => { go = r; });
const handlers = {};
const wc = () => ({ on() {}, once() {}, send() {}, setWindowOpenHandler() {}, openDevTools() {}, closeDevTools() {}, toggleDevTools() {}, isDestroyed: () => false });
class BrowserWindow {
  constructor(o) { this.webContents = wc(); }
  static getAllWindows() { return []; } static getFocusedWindow() { return null; }
  on() {} once(e, f) { if (e === 'ready-to-show') setTimeout(f, 5); } setMenuBarVisibility() {} setTitle() {} loadURL() {} loadFile() {}
  isDestroyed() { return false; } isMinimized() { return false; } restore() {} show() {} focus() {} flashFrame() {}
}
global.__electron = {
  app: { getPath: () => userData, getVersion: () => '1.0.18', getName: () => 'ZapTill', isPackaged: true, whenReady: () => ready,
    on() {}, requestSingleInstanceLock: () => true, getAppMetrics: () => [], setLoginItemSettings() {}, getLoginItemSettings: () => ({}),
    exit(c) { process.exit(c); }, quit() {}, relaunch() {}, setAppUserModelId() {}, disableHardwareAcceleration() {} },
  BrowserWindow, ipcMain: { handle(ch, fn) { handlers[ch] = fn; }, on() {}, removeHandler() {} }, dialog: {}, shell: { openExternal() {} },
  net: { isOnline: () => false }, Menu: { buildFromTemplate: () => ({}), setApplicationMenu() {} },
  Tray: class { setToolTip() {} setContextMenu() {} on() {} destroy() {} }, Notification: class { static isSupported() { return false; } },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) }, powerSaveBlocker: { start: () => 1, stop() {}, isStarted: () => true },
  powerMonitor: { on() {}, getSystemIdleTime: () => 0 }, safeStorage: { isEncryptionAvailable: () => false },
  session: { fromPartition: () => ({ setCertificateVerifyProc() {} }), defaultSession: { setCertificateVerifyProc() {} } }, screen: {},
};
const shim = path.join(userData, 'electron-shim.cjs');
fs.writeFileSync(shim, 'module.exports = global.__electron;');
const updaterShim = path.join(userData, 'updater-shim.cjs');
fs.writeFileSync(updaterShim, 'const ev = []; module.exports = { autoUpdater: { ev, on(e) { ev.push(e); return this; }, checkForUpdates: async () => null, setFeedURL() {}, quitAndInstall() {} } };');
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) { return req === 'electron' ? shim : req === 'electron-updater' ? updaterShim : orig.call(this, req, ...rest); };
require(path.join(dist, 'index.js'));
go();
const logFile = path.join(userData, 'swiftpos.log');
const until = Date.now() + 30000;
(async function wait() {
  const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
  if (!/start \(/.test(log) && Date.now() < until) return setTimeout(wait, 50);
  const atStart = [...requested].sort();
  const handled = Object.keys(handlers).length;
  const may = await handlers['idle:mayPreload']?.({}, undefined).catch((e) => ({ error: String(e) }));
  // First use: a workbook built, the updater touched.
  let excelOk = false;
  try { const R = require(path.join(dist, 'dailySalesReport.js')); const { wb } = await R.buildDailySalesWorkbook({ preset: 'today' }); excelOk = !!wb && typeof wb.addWorksheet === 'function'; } catch (e) { excelOk = String(e); }
  const afterExcel = requested.has('exceljs');
  const U = require(path.join(dist, 'autoUpdate.js'));
  const loadedBefore = U.updaterIfLoaded() !== null;
  const u = U._updaterNow();
  const wired = { autoDownload: u.autoDownload, autoInstallOnAppQuit: u.autoInstallOnAppQuit, allowPrerelease: u.allowPrerelease,
    disableDifferentialDownload: u.disableDifferentialDownload, ev: u.ev };
  process.stdout.write('RESULT ' + JSON.stringify({ atStart, handled, may, excelOk, afterExcel, loadedBefore, afterUpdater: requested.has('electron-updater'), wired, log: /start \(/.test(log) }) + '\n');
  process.exit(0);
})();
`);
  const ud = fs.mkdtempSync(path.join(tmp, 'start-'));
  const r = spawnSync(process.execPath, ['--no-warnings', harness, dist, ud], { encoding: 'utf8', timeout: 90_000,
    env: { ...process.env, NODE_PATH: process.env.NODE_PATH ?? '', SWIFTPOS_NODE_PORT: String(40000 + Math.floor(Math.random() * 20000)), TZ: 'UTC' } });
  const m = /RESULT (.*)/.exec(r.stdout ?? '');
  const res = m ? JSON.parse(m[1]) : null;
  ok('the whole start ran (window, IPC handlers, the start-up sequence and its timing line)', !!res && res.log && res.handled > 100,
    JSON.stringify({ code: r.status, err: (r.stderr ?? '').slice(-800) }));
  ok('exceljs is not required by the start', !!res && !res.atStart.includes('exceljs'), JSON.stringify(res?.atStart));
  ok('electron-updater is not required by the start (initAutoUpdate ran: packaged, prod flavour)', !!res && !res.atStart.includes('electron-updater'), JSON.stringify(res?.atStart));
  ok('…what the start does require: the database driver, the printing package', !!res && res.atStart.includes('better-sqlite3') && res.atStart.includes('@swiftpos/printing'));
  ok('IPC handlers still all registered at start (the report and update handlers among them)', !!res && res.handled > 100);
  ok('idle:mayPreload answers after the start-up sequence (settled)', !!res && res.may && res.may.settled === true && typeof res.may.ok === 'boolean', JSON.stringify(res?.may));
  ok('exceljs loads at the first workbook, which builds as before', !!res && res.excelOk === true && res.afterExcel === true, JSON.stringify(res?.excelOk));
  ok('electron-updater loads at its first use (not before)', !!res && res.loadedBefore === false && res.afterUpdater === true);
  ok('…its settings and listeners are applied the moment it loads (download in the background, install on quit, no differential)',
    !!res && res.wired.autoDownload === true && res.wired.autoInstallOnAppQuit === true && res.wired.allowPrerelease === false
    && res.wired.disableDifferentialDownload === true
    && JSON.stringify(res.wired.ev) === JSON.stringify(['error', 'checking-for-update', 'update-available', 'update-not-available', 'download-progress', 'update-downloaded', 'update-downloaded']),
    JSON.stringify(res?.wired));
  const au = read('src/main/autoUpdate.ts');
  const ds = read('src/main/dailySalesReport.ts');
  ok('source: types only at the top (import type), the modules required at first use',
    au.includes("import type { AppUpdater } from 'electron-updater';") && !/^import \{[^}]*\} from 'electron-updater'/m.test(au)
    && ds.includes("import type ExcelTypes from 'exceljs';") && !/^import ExcelJS from 'exceljs'/m.test(ds)
    && /require\('exceljs'\)/.test(ds) && /require\('electron-updater'\)/.test(au));
  ok('quitting before the updater ever loaded does not load it (nothing downloaded, nothing to install)',
    /app\.on\('will-quit', \(e\) => \{\n[^\n]*\n\s*const loaded = updaterIfLoaded\(\);\n\s*if \(!loaded\) return;/.test(au));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
