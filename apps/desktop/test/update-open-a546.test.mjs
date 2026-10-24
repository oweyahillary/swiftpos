// A546 — a till installs a waiting approved update at Windows sign-in (quietly, no window) and, as a backup, when it is
// opened by hand.
//
// Owner, 2026-10-21, asked whether a till should also install when opened by hand: "yes, but what if it auto starts like a
// server — what happens?" Decided: (1) a till's sign-in launch installs a waiting update quietly and ends; (2) a manual
// open with an update waiting installs it first, as a backup.
//
// RUNS the real compiled dist/main (electron and electron-updater shimmed, REAL SQLite — A541's harness):
//   cd apps/desktop && npm run build:main && TZ=UTC node --no-warnings test/update-open-a546.test.mjs
//
// MUTATIONS TO CONFIRM BITE (each verified by editing dist/main / the source and re-running):
//   - gateDecision without the 'till-install' line                          → "a till's sign-in launch with an update waiting goes on" fails
//   - tillSignInInstallDue ignoring signinTried                              → "tried at sign-in once: the next sign-ins end at once" fails
//   - runStartupInstall passing relaunch true at a quiet sign-in             → "quiet sign-in: the task, relaunch false" fails
//   - runStartupInstall without the quiet no-task check (falls to prompt)    → "quiet sign-in without the task: no install, no prompt" fails
//   - startupInstallPlan without the openedByHand allowance                  → "a till opened by hand: install first" fails
//   - startupInstallPlan letting a server opened by hand install             → "a branch server opened by hand: unchanged" fails
//   - runStartupInstall without the sync wait                                → "a sync push in flight: waited for" fails
//   - index.ts without the app.exit after a quiet sign-in with nothing done  → "index.ts: the sign-in launch ends" fails
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.join(here, '..');
const dist = path.join(desktop, 'dist', 'main');
const require = createRequire(import.meta.url);
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-a546-'));
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
const read = (p) => fs.readFileSync(path.join(desktop, p), 'utf8').replace(/\r\n/g, '\n');

const L = require(path.join(dist, 'localDb.js'));
L.getLocalDb();
const C = require(path.join(dist, 'deviceConfig.js'));
C.saveDeviceConfig({ deploy_mode: 'cloud', server_url: 'http://cloud', branch_id: 'br-1', device_id: 'dev-T1', device_role: 'till',
  terminal_code: 'T1', device_name: 'POS 1', configured: true });
const U = require(path.join(dist, 'autoUpdate.js'));
const S = require(path.join(dist, 'lowImpactStart.js'));

// ── 1. The gate: a till's sign-in launch goes on only with an update waiting ───────────────────────────────────────────
console.log('\n1. The gate (a POS\'s sign-in launch)\n');
{
  const G = (argv, o) => S.gateDecision(['ZapTill.exe', ...argv], { server: false, quitByHand: false, ...o });
  ok('a till\'s sign-in launch with an update waiting goes on (till-install)', G(['--at-login'], { updateWaiting: true }) === 'till-install');
  ok('…and with nothing waiting it ends at once, as before (A513)', G(['--at-login'], { updateWaiting: false }) === 'exit' && G(['--at-login'], {}) === 'exit');
  ok('the restart task on a till still ends at once', G(['--watchdog'], { updateWaiting: true }) === 'exit');
  ok('the relaunch after an update never installs', G(['--at-login', '--updated'], { updateWaiting: true }) === 'exit');
  ok('a branch server: unchanged (hand-over, A541)', G(['--at-login'], { server: true, updateWaiting: true }) === 'handoff');
  ok('opened by hand: as always', G([], { updateWaiting: true }) === 'go');

  const w = (o = {}) => ({ version: '1.0.20', approved: true, signinTried: null, ...o });
  ok('due: newer, approved, not tried at sign-in', S.tillSignInInstallDue(w(), '1.0.19') === true);
  ok('not due: older / same / not approved / none', !S.tillSignInInstallDue(w({ version: '1.0.19' }), '1.0.19')
    && !S.tillSignInInstallDue(w({ version: '1.0.18' }), '1.0.19') && !S.tillSignInInstallDue(w({ approved: false }), '1.0.19')
    && !S.tillSignInInstallDue(null, '1.0.19'));
  ok('tried at sign-in once: the next sign-ins end at once', !S.tillSignInInstallDue(w({ signinTried: '1.0.20' }), '1.0.19')
    && S.tillSignInInstallDue(w({ signinTried: '1.0.18' }), '1.0.19'));
  ok('1.0.100 is newer than 1.0.99 (numbers, not text)', S.tillSignInInstallDue(w({ version: '1.0.100' }), '1.0.99'));

  // The file follows the kept download (the real database).
  U.recordStaged({ version: '1.0.20', installerPath: 'C:\\x\\a.exe', approved: true, at: '2026-10-21T01:00:00Z' });
  let f = S.readUpdateWaiting(userData);
  ok('a download kept → update-waiting.json for the gate', f?.version === '1.0.20' && f?.approved === true && !f?.signinTried, JSON.stringify(f));
  U.noteStagedApproval(false);
  ok('withdrawn (A503) → the file says so (the gate ends the launch)', S.readUpdateWaiting(userData)?.approved === false);
  U.noteStagedApproval(true);
  U.mirrorWaiting('1.0.20');
  ok('a sign-in try is kept in the file…', S.readUpdateWaiting(userData)?.signinTried === '1.0.20');
  U.noteStagedApproval(false); U.noteStagedApproval(true);
  ok('…across later approval answers for the same version', S.readUpdateWaiting(userData)?.signinTried === '1.0.20');
  U.recordStaged({ version: '1.0.21', installerPath: 'C:\\x\\b.exe', approved: true, at: '2026-10-22T01:00:00Z' });
  f = S.readUpdateWaiting(userData);
  ok('a newer download starts afresh (not tried at sign-in)', f?.version === '1.0.21' && !f?.signinTried && S.tillSignInInstallDue(f, '1.0.19'));
  fs.writeFileSync(path.join(userData, S.UPDATE_WAITING_FILE), 'not json');
  ok('a damaged file: nothing waiting (the launch ends)', S.readUpdateWaiting(userData) === null);

  const gate = read('src/main/startGate.ts');
  ok('startGate reads the file only for a till\'s sign-in launch, before the decision', /const updateWaiting = !server && argv\.includes\(AT_LOGIN_ARG\) && tillSignInInstallDue\(readUpdateWaiting\(userData\), app\.getVersion\(\)\)/.test(gate)
    && gate.indexOf('const updateWaiting') < gate.indexOf('const decision = gateDecision('));
}

// ── 2. The plan and the install ──────────────────────────────────────────────────────────────────────────────────────
console.log('\n2. The install: quietly at sign-in, or first when opened by hand\n');
const staged = (o = {}) => ({ version: '1.0.20', installerPath: 'C:\\x\\ZapTill-1.0.20.exe', approved: true, at: '2026-10-18T01:00:00Z', ...o });
const quietIn = (o = {}) => ({ signInStart: true, updatedLaunch: false, running: '1.0.19', staged: staged(), installerExists: true,
  triedVersion: null, server: false, shareReady: true, quiet: true, ...o });
const openIn = (o = {}) => ({ signInStart: false, updatedLaunch: false, running: '1.0.19', staged: staged(), installerExists: true,
  triedVersion: null, server: false, shareReady: true, openedByHand: true, ...o });
{
  const P = (i) => U.startupInstallPlan(i);
  ok('a till opened by hand: install first', P(openIn()).install === true && /before the POS opens/.test(P(openIn()).reason), P(openIn()).reason);
  ok('a branch server opened by hand: unchanged (A541 — no install)', P(openIn({ server: true })).install === false);
  ok('a start by hand that is not "opened by hand" (e.g. the restart task): no install', P(openIn({ openedByHand: false })).install === false);
  ok('opened by hand: once per version, approved, newer, not after an update', P(openIn({ triedVersion: '1.0.20' })).install === false
    && P(openIn({ staged: staged({ approved: false }) })).install === false && P(openIn({ staged: staged({ version: '1.0.19' }) })).install === false
    && P(openIn({ updatedLaunch: true })).install === false && P(openIn({ cloudApproved: null })).withdrawn === true);
  ok('a quiet sign-in on a till: install (quietly)', P(quietIn()).install === true && /quietly/.test(P(quietIn()).reason));
}

const run = async (input, f = {}) => {
  const calls = [];
  let t = 0;
  const r = await U.runStartupInstall({
    input: () => input,
    askCloud: async () => ('cloud' in f ? f.cloud : '1.0.20'),
    openDrawers: () => 0,
    markTried: (x) => calls.push(`tried:${x.version}`),
    withdraw: () => calls.push('withdraw'),
    task: async () => f.task ?? true,
    viaTask: async (v, relaunch) => { calls.push(`task:${v}:relaunch=${relaunch}`); return f.taskOk === false ? { ok: false, reason: 'refused' } : { ok: true }; },
    prepareUpdater: async (v) => { calls.push(`prepare:${v}`); return f.prepOk === false ? { ok: false, reason: 'no feed' } : { ok: true, reason: 'ok' }; },
    record: (x) => calls.push(`record:${x.reason}`),
    beforeQuit: () => calls.push('beforeQuit'),
    quit: () => calls.push('quit'),
    quitAndInstall: () => calls.push('quitAndInstall'),
    showUpdating: (v) => calls.push(`show:${v}`),
    hideUpdating: () => calls.push('hide'),
    syncSince: () => (f.syncUntil !== undefined && t < f.syncUntil ? 1 : null),
    sleep: async (ms) => { t += ms; },
    now: () => t,
    log: (l) => calls.push(`log:${l}`),
  });
  return { r, calls, seq: calls.filter((c) => !c.startsWith('log:')), t };
};
{
  let x = await run(quietIn());
  ok('quiet sign-in: the task, relaunch false — tried, recorded, closed, quit; no window, no prompt', x.r.installing === true
    && x.seq.join(',') === 'tried:1.0.20,task:1.0.20:relaunch=false,record:startup,beforeQuit,quit', x.seq.join(','));
  x = await run(quietIn(), { task: false });
  ok('quiet sign-in without the task: no install, no prompt, nothing tried (the next open installs it)', x.r.installing === false
    && x.seq.length === 0 && x.calls.some((c) => /no ZapTill Updater task on this PC — Windows would ask/.test(c))
    && x.calls.some((c) => /installs the next time ZapTill is opened \(Windows will ask\)/.test(c)), x.calls.join(' | '));
  x = await run(quietIn(), { taskOk: false });
  ok('quiet sign-in, the task refused: no installer, no prompt', x.r.installing === false
    && !x.seq.includes('prepare:1.0.20') && !x.seq.includes('quitAndInstall') && !x.seq.includes('quit'), x.seq.join(','));
  x = await run(quietIn({ staged: staged({ approved: false }) }));
  ok('quiet sign-in, not approved: nothing (the launch ends)', x.r.installing === false && x.seq.length === 0);
  x = await run(quietIn({ staged: staged({ version: '1.0.18' }) }));
  ok('quiet sign-in, an older download: nothing', x.r.installing === false && x.seq.length === 0);
  x = await run(quietIn(), { cloud: null });
  ok('quiet sign-in, the business now on hold: withdrawn, nothing installed', x.r.installing === false && x.seq.join(',') === 'withdraw');
  x = await run(quietIn({ triedVersion: '1.0.20' }));
  ok('quiet sign-in: once per version', x.r.installing === false && x.seq.length === 0);

  x = await run(openIn());
  ok('opened by hand: "Updating ZapTill" screen, then the task with relaunch', x.r.installing === true
    && x.seq.join(',') === 'show:1.0.20,tried:1.0.20,task:1.0.20:relaunch=true,record:startup,beforeQuit,quit', x.seq.join(','));
  x = await run(openIn(), { task: false });
  ok('opened by hand without the task: electron-updater with the Windows prompt (somebody is there)', x.r.installing === true
    && x.seq.join(',') === 'show:1.0.20,tried:1.0.20,prepare:1.0.20,record:startup,beforeQuit,quitAndInstall', x.seq.join(','));
  x = await run(openIn(), { task: false, prepOk: false });
  ok('opened by hand, the installer could not be checked: the screen closes, the till opens normally', x.r.installing === false
    && x.seq.join(',') === 'show:1.0.20,tried:1.0.20,prepare:1.0.20,hide', x.seq.join(','));
  x = await run(openIn({ triedVersion: '1.0.20' }));
  ok('opened by hand: once per version (no screen)', x.r.installing === false && x.seq.length === 0);
  x = await run(openIn({ updatedLaunch: true }));
  ok('the --updated relaunch: no install', x.r.installing === false && x.seq.length === 0);
  x = await run(openIn(), { syncUntil: 5_000 });
  ok('a sync push in flight: waited for, then the install', x.r.installing === true && x.t >= 5_000 && x.t < 6_000
    && x.seq.indexOf('show:1.0.20') < x.seq.indexOf('tried:1.0.20') && x.calls.some((c) => /the sync push under way finished/.test(c)), `${x.t} ${x.calls.join(' | ')}`);
  x = await run(openIn(), { syncUntil: 10 * 60_000 });
  ok('…at most 30 s', x.r.installing === true && x.t >= 30_000 && x.t < 31_000 && x.calls.some((c) => /still under way after 30 s/.test(c)), String(x.t));
  x = await run(quietIn(), { syncUntil: 5_000 });
  ok('the quiet sign-in does not show a screen', !x.seq.some((c) => c.startsWith('show:')));

  // A541's path for a branch server is unchanged: relaunch true through the task.
  x = await run({ ...quietIn({ server: true }), quiet: false });
  ok('a branch server at sign-in: the task with relaunch (A541, unchanged), no screen', x.r.installing === true
    && x.seq.join(',') === 'tried:1.0.20,task:1.0.20:relaunch=true,record:startup,beforeQuit,quit', x.seq.join(','));
  ok('the updating screen\'s words', U.updatingText('1.0.20') === 'Updating ZapTill to 1.0.20 — about a minute');
}

// ── 3. The wiring in index.ts and autoUpdate.ts ──────────────────────────────────────────────────────────────────────
console.log('\n3. index.ts / autoUpdate.ts\n');
{
  const idx = read('src/main/index.ts');
  const iQuiet = idx.indexOf('if (tillSignIn) {');
  ok('index.ts: a till\'s sign-in launch installs quietly right after the database opens — before IPC, printing, any window',
    iQuiet > idx.indexOf('getLocalDb();') && iQuiet < idx.indexOf('registerIpcHandlers();') && iQuiet < idx.indexOf('if (!windowless || windowAsked) createWindow();')
    && /installAtStartIfDue\(\{ signInStart: true, updatedLaunch: false, quiet: true \}\)/.test(idx));
  ok('index.ts: the sign-in launch ends when nothing installs (unless somebody opened ZapTill meanwhile)',
    /if \(!windowAsked\) \{[\s\S]{0,300}closeLocalDb\(\);[\s\S]{0,80}app\.exit\(0\);\s*return;/.test(idx));
  ok('index.ts: a till\'s sign-in launch is one with --at-login, no branch-server marker, not the restart task',
    /const tillSignIn = process\.argv\.includes\(AT_LOGIN_ARG\) && !server && !process\.argv\.includes\(WATCHDOG_ARG\);/.test(idx));
  ok('index.ts: opened by hand (no automatic-start argument) installs first, before the window',
    /openedByHand: !isAutoLaunch\(process\.argv\) \|\| openedDuringSignIn/.test(idx)
    && idx.indexOf('openedByHand: !isAutoLaunch') < idx.indexOf('if (!windowless || windowAsked) createWindow();'));
  const au = read('src/main/autoUpdate.ts');
  ok('autoUpdate.ts: the manual open keeps its own once-per-version record', /const triedKey = byHand \? OPEN_INSTALL_KEY : STARTUP_INSTALL_KEY;/.test(au)
    && /markTried: \(t\) => \{ writeKept\(triedKey, t\); \}/.test(au));
  ok('autoUpdate.ts: the task gets the relaunch it is given (false at a quiet sign-in)', /viaTask: async \(v, relaunch\) => \{[\s\S]{0,200}relaunch, timeoutMs: 90_000/.test(au));
  ok('autoUpdate.ts: a quiet sign-in marks the version tried in the gate\'s file', /if \(quiet\) mirrorWaiting\(readStaged\(\)\?\.version \?\? undefined\);/.test(au));
  const ps1 = read('updater/zaptill-update.ps1');
  ok('the updater script starts ZapTill again only when asked (relaunch)', /\$relaunch = \(\(Get-Field \$req 'relaunch'\) -eq \$true\)/.test(ps1) && /if \(\$relaunch\) \{/.test(ps1));
}

try { L.closeLocalDb(); } catch { /* */ }
try { fs.rmSync(userData, { recursive: true, force: true }); } catch { /* */ }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
