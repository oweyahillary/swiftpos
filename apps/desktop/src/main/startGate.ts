/**
 * startGate.ts — A513: the first thing ZapTill runs (index.ts imports it before anything else; CommonJS runs imports in
 * order, so nothing heavy has loaded yet — no database, no sync engine, no window).
 *
 *  1. An automatic launch that has nothing to do ends here, at once: the sign-in task's `--at-login` or the restart
 *     task's `--watchdog` on a till (no branch-server marker), or a `--watchdog` after a quit by hand (A435). No window,
 *     no taskbar button — the process is gone before Electron is ready. A546: except a till's sign-in launch with an
 *     approved, newer update waiting (update-waiting.json) — it goes on, installs it quietly, and ends (index.ts).
 *  2. The sign-in start of a branch server hands over to the restart task (serverWatchdog.ts): the task starts ZapTill
 *     itself, so the running server IS the task's process and Task Scheduler launches nothing more while it runs
 *     (MultipleInstancesPolicy IgnoreNew) — it launches again only if ZapTill died. Hand-over not possible (no task,
 *     disabled, an older Windows) → this process goes on as the server.
 *  3. A restart-task launch while ZapTill already runs ends at once on the single-instance lock — before the rest loads.
 *  4. Low-memory mode: on a machine with 4.5 GB or less, hardware acceleration is turned off before Electron is ready
 *     (less memory for the GPU process). A technician overrides it in gpu-mode.json ({"mode":"auto"|"on"|"off"}).
 */
import { app } from 'electron';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { gateDecision, startsAtSignIn, noteGraphicsLine, AT_LOGIN_ARG, markSignInHandoff, readUpdateWaiting, tillSignInInstallDue } from './lowImpactStart';

export const WATCHDOG_ARG = '--watchdog';   // = serverWatchdog.WATCHDOG_ARG (kept here so the gate loads nothing else)
export const LOW_MEMORY_BYTES = 4.5 * 1024 ** 3;
export const GPU_MODE_FILE = 'gpu-mode.json';

export type GpuMode = 'auto' | 'on' | 'off';
export function readGpuMode(userData: string): GpuMode {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(userData, GPU_MODE_FILE), 'utf8'))?.mode;
    return m === 'on' || m === 'off' ? m : 'auto';
  } catch { return 'auto'; }
}
/** Whether hardware acceleration goes off, and the one plain line that says so (logged once the log is up). */
export function gpuDecision(mode: GpuMode, totalBytes: number): { off: boolean; line: string } {
  const gb = (totalBytes / 1024 ** 3).toFixed(1);
  const how = `to change it, put {"mode":"on"} (or "off", or "auto") in ${GPU_MODE_FILE} in ZapTill's data folder and restart ZapTill`;
  if (mode === 'off') return { off: true, line: `graphics: hardware acceleration off (set by a technician) — ${how}` };
  if (mode === 'on') return { off: false, line: `graphics: hardware acceleration on (set by a technician, ${gb} GB memory) — ${how}` };
  return totalBytes <= LOW_MEMORY_BYTES
    ? { off: true, line: `graphics: low-memory mode — hardware acceleration off (${gb} GB memory) — ${how}` }
    : { off: false, line: `graphics: hardware acceleration on (${gb} GB memory)` };
}

export let gpuLine: string | null = null;
/** What the gate did — logged by index.ts once the log is up (this file cannot log: the log lives in userData). */
export let gateNote: string | null = null;

function quitByHandFlag(userData: string): boolean {
  try { return fs.existsSync(path.join(userData, 'quit-by-hand.flag')); } catch { return false; }
}

function restartTaskName(): string {
  return app.getName().toLowerCase().includes('dev') ? 'ZapTill Dev branch server' : 'ZapTill branch server';
}

function runGate(): void {
  let userData: string;
  try { userData = app.getPath('userData'); } catch { return; }
  const argv = process.argv;
  const server = startsAtSignIn(userData);
  // A546: a till's sign-in launch reads one small file — an approved, newer update waiting → it goes on to install it.
  const updateWaiting = !server && argv.includes(AT_LOGIN_ARG) && tillSignInInstallDue(readUpdateWaiting(userData), app.getVersion());
  const decision = gateDecision(argv, { server, quitByHand: quitByHandFlag(userData), updateWaiting });
  if (decision === 'exit') { process.exit(0); }
  if (decision === 'till-install') gateNote = 'a till\'s sign-in launch with an approved update waiting — it installs it quietly (no window), then ends';
  if (decision === 'handoff' && process.platform === 'win32' && app.isPackaged) {
    try {
      // The sign-in start is a deliberate start (as the old "start with Windows" was): a quit by hand before the
      // restart is forgotten, or the task's launch below would stay down.
      markSignInHandoff(userData);   // A541: the task's launch is the sign-in start (it installs a waiting update first)
      try { fs.rmSync(path.join(userData, 'quit-by-hand.flag'), { force: true }); } catch { /* best effort */ }
      execFileSync('schtasks', ['/Run', '/TN', restartTaskName()], { windowsHide: true, timeout: 10_000, stdio: 'ignore' });
      process.exit(0);
    } catch {
      gateNote = 'the restart task could not take the sign-in start (not there yet, or disabled) — this start runs the server itself';
    }
  }
  // A restart-task launch (or a sign-in start) while ZapTill already runs: end here, before the rest loads.
  if (argv.includes(WATCHDOG_ARG) || argv.includes(AT_LOGIN_ARG)) {
    if (!app.requestSingleInstanceLock()) process.exit(0);
  }
  try {
    const g = gpuDecision(readGpuMode(userData), os.totalmem());
    gpuLine = g.line;
    noteGraphicsLine(g.line);
    if (g.off) app.disableHardwareAcceleration();
  } catch { /* never stops a start */ }
}
runGate();
