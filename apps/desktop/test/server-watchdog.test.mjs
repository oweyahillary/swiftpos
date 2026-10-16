/**
 * server-watchdog.test.mjs — A435 option (a): the branch server is started again within 5 minutes if it stops, a quit
 * from the tray stays quit, and the technician is told to set the PC to sign in by itself.
 * Owner, 2026-10-10: "let's work with your recommendation".
 *
 *   cd apps/desktop && npx tsc -p tsconfig.main.json && node test/server-watchdog.test.mjs
 *
 * RUNS the real compiled rules (dist/main/serverWatchdog.js) (the scheduled task, staying down after a hand quit) with a stand-in
 * for Electron, then pins the wiring (Electron is not run here).
 *
 * MUTATIONS TO CONFIRM BITE: the task without --watchdog → "the task launches with --watchdog" fails; watchdogStaysDown
 * ignoring the flag → "a quit from the tray stays quit" fails; second-instance showing the window for the watchdog →
 * "a running server's window is left as it is" fails; the tray Quit without markQuitByHand → its pin fails.
 * A513 (each verified by editing dist/main): the task XML with Parallel instead of IgnoreNew → "no launch while ZapTill
 * runs" fails; gateDecision without the quit-by-hand check → "a quit by hand stays down" fails; announceJoin bringing a
 * window forward when none is open → "no window: no window is made and nothing flashes" fails.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(DESKTOP, p), 'utf8').replace(/\r\n/g, '\n');
let pass = 0, fail = 0;
const ok = (n, f) => { try { f(); pass++; console.log(`  ok   ${n}`); } catch (e) { fail++; console.log(`  FAIL ${n}\n       ${e.message}`); } };

// A stand-in for Electron: its userData is a temp folder.
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptill-a435-'));
const shim = path.join(userData, 'electron-shim.cjs');
// A513: with a window stand-in and a Notification that records, so announceJoin runs for real.
fs.writeFileSync(shim, `
  const wins = (global.__wins = []); const notes = (global.__notes = []);
  class BrowserWindow {
    constructor() { this.flashed = 0; this.shown = 0; this.destroyed = false; this.handlers = {}; wins.push(this); }
    static getAllWindows() { return wins.filter((w) => !w.destroyed); }
    isDestroyed() { return this.destroyed; } isMinimized() { return false; } restore() {}
    show() { this.shown++; } focus() {} flashFrame(on) { if (on) this.flashed++; } on(e, f) { this.handlers[e] = f; }
  }
  class Notification {
    static isSupported() { return true; }
    constructor(o) { this.o = o; this.h = {}; this.shown = false; notes.push(this); }
    on(e, f) { this.h[e] = f; } show() { this.shown = true; }
  }
  module.exports = { app: { getPath: () => ${JSON.stringify(userData)}, getName: () => 'ZapTill', isPackaged: false, setAppUserModelId() {} },
    BrowserWindow, Notification, Menu: { buildFromTemplate: () => ({}) }, Tray: class { setToolTip() {} setContextMenu() {} on() {} destroy() {} },
    nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
    powerSaveBlocker: { start: () => 1, stop() {}, isStarted: () => true } };`);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) { return req === 'electron' ? shim : orig.call(this, req, parent, ...rest); };
const W = createRequire(import.meta.url)(path.join(DESKTOP, 'dist/main/serverWatchdog.js'));

console.log('\nThe scheduled task\n');
// A513 (owner, 2026-10-16: "the zap app keeps peeping on the taskbar even when closed"): the task is written from XML —
// it was `/SC MINUTE`, which launched ZapTill every 5 minutes whatever was running (and ended it after 72 h).
const xml = W.watchdogTaskXml('C:\\Program Files\\ZapTill\\ZapTill.exe', 'SHOP\\server');
ok('every 5 minutes, replacing any older copy (the A435 /SC MINUTE one too), starting ZapTill with --watchdog', () => {
  assert.deepEqual(W.watchdogCreateArgs('C:\\x\\restart-task.xml', 'ZapTill branch server'),
    ['/Create', '/F', '/TN', 'ZapTill branch server', '/XML', 'C:\\x\\restart-task.xml']);
  assert.ok(xml.includes('<Repetition><Interval>PT5M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition>'), 'every 5 min, for ever');
});
ok('the task launches with --watchdog (a path with spaces stays one path)', () => {
  assert.ok(xml.includes('<Command>C:\\Program Files\\ZapTill\\ZapTill.exe</Command><Arguments>--watchdog</Arguments>'), xml);
  assert.ok(xml.includes('<WorkingDirectory>C:\\Program Files\\ZapTill</WorkingDirectory>'));
});
ok('A513: no launch while ZapTill runs — IgnoreNew: Task Scheduler starts nothing while the ZapTill it started is running', () => {
  assert.ok(xml.includes('<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>'));
});
ok('A513: never ended by Task Scheduler (no 72-hour limit), normal priority, the signed-in user only', () => {
  assert.ok(xml.includes('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>') && xml.includes('<Priority>5</Priority>'));
  assert.ok(xml.includes('<UserId>SHOP\\server</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel>'));
  assert.ok(!/HighestAvailable|S-1-5-18/.test(xml), 'never elevated, never SYSTEM');
  assert.ok(W.watchdogTaskXml('C:\\a&b\\Z.exe', '').includes('<Command>C:\\a&amp;b\\Z.exe</Command>') && !W.watchdogTaskXml('C:\\Z.exe', '').includes('<UserId>'));
});
ok('A513: a quit by hand switches the task off', () => {
  assert.deepEqual(W.watchdogDisableArgs('ZapTill branch server'), ['/Change', '/TN', 'ZapTill branch server', '/DISABLE']);
});
ok('the dev build has its own task, so the two never remove each other\'s', () => {
  assert.equal(W.watchdogTaskName('ZapTill'), 'ZapTill branch server');
  assert.equal(W.watchdogTaskName('ZapTill Dev'), 'ZapTill Dev branch server');
  assert.deepEqual(W.watchdogDeleteArgs('ZapTill branch server'), ['/Delete', '/F', '/TN', 'ZapTill branch server']);
});

console.log('\nA quit from the tray stays quit\n');
ok('a quit from the tray stays quit: a watchdog launch ends at once', () => {
  W.clearQuitByHand();
  assert.equal(W.watchdogStaysDown(['zaptill.exe', '--watchdog'], W.quitByHand()), false, 'no quit: it starts');
  W.markQuitByHand();
  assert.equal(W.quitByHand(), true);
  assert.equal(W.watchdogStaysDown(['zaptill.exe', '--watchdog'], W.quitByHand()), true, 'after a hand quit: stays down');
});
ok('opened by hand (or at Windows sign-in) it starts — and clears the flag', () => {
  assert.equal(W.watchdogStaysDown(['zaptill.exe'], true), false);
  W.clearQuitByHand();
  assert.equal(W.quitByHand(), false);
});

console.log('\nA513: what a launch by the tasks does (the real gate rules, dist/main/lowImpactStart.js)\n');
const L = createRequire(import.meta.url)(path.join(DESKTOP, 'dist/main/lowImpactStart.js'));
ok('restart after a crash: a restart-task launch on a server (not quit by hand) starts ZapTill, in the tray', () => {
  assert.equal(L.gateDecision(['z.exe', '--watchdog'], { server: true, quitByHand: false }), 'go');
  assert.equal(L.startsWindowless(['z.exe', '--watchdog'], true), true, 'no window from the task');
});
ok('a quit by hand stays down: the launch ends at once, before anything loads', () => {
  assert.equal(L.gateDecision(['z.exe', '--watchdog'], { server: true, quitByHand: true }), 'exit');
});
ok('a till never gets the tasks\' starts: --watchdog or --at-login on a till ends at once', () => {
  assert.equal(L.gateDecision(['z.exe', '--watchdog'], { server: false, quitByHand: false }), 'exit');
  assert.equal(L.gateDecision(['z.exe', '--at-login'], { server: false, quitByHand: false }), 'exit');
  assert.equal(L.gateDecision(['z.exe'], { server: false, quitByHand: true }), 'go', 'opened by hand: as always');
});
ok('the sign-in start of a server hands over to the restart task (so IgnoreNew holds while it runs)', () => {
  assert.equal(L.gateDecision(['z.exe', '--at-login'], { server: true, quitByHand: true }), 'handoff');
  const gate = read('src/main/startGate.ts');
  assert.ok(/fs\.rmSync\(path\.join\(userData, 'quit-by-hand\.flag'\)[^\n]*\n\s*execFileSync\('schtasks', \['\/Run', '\/TN', restartTaskName\(\)\]/.test(gate), 'the flag is cleared before the task is run');
  assert.ok(/if \(argv\.includes\(WATCHDOG_ARG\) \|\| argv\.includes\(AT_LOGIN_ARG\)\) \{\s*if \(!app\.requestSingleInstanceLock\(\)\) process\.exit\(0\);/.test(gate), 'running already: ends before the rest loads');
  assert.ok(read('src/main/index.ts').startsWith("// A513: FIRST") && /\nimport '\.\/startGate';\n/.test(read('src/main/index.ts')), 'the gate is the first import');
});

console.log('\nA513: a join request with no window open\n');
{
  const M = createRequire(import.meta.url)(path.join(DESKTOP, 'dist/main/serverMode.js'));
  let made = 0;
  let main = null;
  const { BrowserWindow } = createRequire(import.meta.url)('electron');   // the stand-in
  M.setMainWindow(() => main, () => { made++; main = new BrowserWindow(); return main; });
  ok('no window: no window is made and nothing flashes — the Windows notification is raised (and kept referenced)', () => {
    M.announceJoin('FRONT-PC', '192.168.1.20');
    assert.equal(made, 0); assert.equal(globalThis.__wins.length, 0);
    const n = globalThis.__notes.at(-1);
    assert.ok(n && n.shown && /FRONT-PC/.test(n.o.body)); assert.equal(M._joinNotice(), n);
  });
  ok('clicking the notification opens the window (the join prompt is on top as it loads)', () => {
    globalThis.__notes.at(-1).h.click();
    assert.equal(made, 1); assert.equal(main.shown, 1);
  });
  ok('a window open: it comes forward and its taskbar button flashes', () => {
    M.announceJoin('BAR-PC', '192.168.1.21');
    assert.equal(made, 1, 'no second window'); assert.equal(main.flashed, 1); assert.equal(main.shown, 2);
  });
}

console.log('\nThe wiring\n');
const mode = read('src/main/serverMode.ts');
const index = read('src/main/index.ts');
ok('server mode installs the task; leaving server mode (not on the way out) removes it', () => {
  // A513: installed once the start-up sequence is over (no schtasks while the server starts), with the Run entry.
  assert.ok(/whenStartupSettled\(\(\) => \{\s*if \(!serving\) return;\s*installWatchdog\(\);[^\n]*\n\s*syncLoginEntry\(\);/.test(mode));
  // A512: written under one fixed name, the pre-1.0.5 entries removed (clearOldLoginItems) before the watchdog.
  assert.ok(/if \(app\.isPackaged && !quitting\) \{\s*try \{ app\.setLoginItemSettings\(\{ openAtLogin: false, name: loginItemName\(\) \}\); \}[^\n]*\n\s*clearOldLoginItems\(\);[^\n]*\n\s*removeWatchdog\(\);/.test(mode));
});
ok('the tray\'s Quit marks a quit by hand; Restart does not', () => {
  // A513: and switches the restart task off (synchronously — before ZapTill is gone).
  assert.ok(mode.includes("click: () => { quitting = true; markQuitByHand(); disableWatchdog(); app.quit(); } }"));
  assert.ok(mode.includes("{ label: 'Restart ZapTill', click: () => { quitting = true; app.relaunch(); app.quit(); } }"));
});
ok('a running server\'s window is left as it is when the watchdog checks', () => {
  assert.ok(/app\.on\('second-instance', \(_e, argv\) => \{\s*if \(argv\.includes\(WATCHDOG_ARG\)\) return;/.test(index));
});
ok('at start: stays down after a hand quit; a start by hand clears it', () => {
  assert.ok(index.includes('if (watchdogStaysDown(process.argv, quitByHand())) { app.exit(0); return; }'));
  assert.ok(index.includes('if (!process.argv.includes(WATCHDOG_ARG)) clearQuitByHand();'));
});
ok('the technician is told: sign in by itself, never sleep — at setup and in the console', () => {
  const steps = read('src/renderer/components/ServerKeepRunning.tsx');
  assert.ok(steps.includes('netplwiz') && steps.includes('Never'));
  assert.ok(read('src/renderer/pages/InstallPage.tsx').includes("{(role === 'node' || role === 'office') && <ServerKeepRunning />}"));
  assert.ok(read('src/renderer/pages/TechPage.tsx').includes("dev.device_role !== 'till' && <div className=\"mt-3\"><ServerKeepRunning /></div>"));
});

fs.rmSync(userData, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
