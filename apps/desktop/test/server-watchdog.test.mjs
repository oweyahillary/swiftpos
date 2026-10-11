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
fs.writeFileSync(shim, `module.exports = { app: { getPath: () => ${JSON.stringify(userData)}, getName: () => 'ZapTill', isPackaged: false } };`);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) { return req === 'electron' ? shim : orig.call(this, req, parent, ...rest); };
const W = createRequire(import.meta.url)(path.join(DESKTOP, 'dist/main/serverWatchdog.js'));

console.log('\nThe scheduled task\n');
ok('every 5 minutes, replacing any older copy, starting ZapTill with --watchdog', () => {
  const a = W.watchdogCreateArgs('C:\\Program Files\\ZapTill\\ZapTill.exe', 'ZapTill branch server');
  assert.deepEqual(a, ['/Create', '/F', '/SC', 'MINUTE', '/MO', '5', '/TN', 'ZapTill branch server',
    '/TR', '"C:\\Program Files\\ZapTill\\ZapTill.exe" --watchdog']);
});
ok('the task launches with --watchdog (a path with spaces stays one path)', () => {
  const tr = W.watchdogCreateArgs('C:\\A B\\Z.exe', 'T').at(-1);
  assert.ok(tr.startsWith('"C:\\A B\\Z.exe"') && tr.endsWith(' --watchdog'), tr);
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

console.log('\nThe wiring\n');
const mode = read('src/main/serverMode.ts');
const index = read('src/main/index.ts');
ok('server mode installs the task; leaving server mode (not on the way out) removes it', () => {
  assert.ok(/setLoginItemSettings\(\{ openAtLogin: true \}\)[^\n]*\n\s*installWatchdog\(\);/.test(mode));
  assert.ok(/if \(app\.isPackaged && !quitting\) \{\s*try \{ app\.setLoginItemSettings\(\{ openAtLogin: false \}\); \}[^\n]*\n\s*removeWatchdog\(\);/.test(mode));
});
ok('the tray\'s Quit marks a quit by hand; Restart does not', () => {
  assert.ok(mode.includes("click: () => { quitting = true; markQuitByHand(); app.quit(); } }"));
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
