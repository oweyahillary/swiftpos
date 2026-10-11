/**
 * serverWatchdog.ts — A435 option (a) (owner, 2026-10-10: "let's work with your recommendation").
 *
 * The branch server starts with Windows as a login item (A427). On its own that does not bring it back after a crash
 * or a Task Manager kill. So while this machine serves its branch, a Windows scheduled task starts ZapTill every 5
 * minutes with `--watchdog`:
 *   - ZapTill running → the launch meets the single-instance lock and ends at once, the window left as it is;
 *   - ZapTill not running → it starts, and the branch has its server back within 5 minutes;
 *   - someone chose "Quit" in the tray → a flag says so, and a watchdog launch ends at once until ZapTill is next
 *     opened by hand (a deliberate quit stays quit).
 * The task runs while the Windows user is logged in — with the server PC set to log in by itself (the setup guide's
 * step), that is from power-on. Leaving server mode removes the task. A plain till never has one.
 */
import { app } from 'electron';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const WATCHDOG_ARG = '--watchdog';
export const WATCHDOG_EVERY_MINUTES = 5;

export function watchdogTaskName(appName: string): string {
  return appName.toLowerCase().includes('dev') ? 'ZapTill Dev branch server' : 'ZapTill branch server';
}

/** schtasks arguments: every 5 minutes, as the logged-in user, replacing any older copy. */
export function watchdogCreateArgs(exe: string, taskName: string): string[] {
  return ['/Create', '/F', '/SC', 'MINUTE', '/MO', String(WATCHDOG_EVERY_MINUTES), '/TN', taskName,
    '/TR', `"${exe}" ${WATCHDOG_ARG}`];
}
export function watchdogDeleteArgs(taskName: string): string[] {
  return ['/Delete', '/F', '/TN', taskName];
}

/** A launch by the task, after a quit from the tray: end at once. */
export function watchdogStaysDown(argv: readonly string[], quitByHand: boolean): boolean {
  return argv.includes(WATCHDOG_ARG) && quitByHand;
}

const flagPath = () => path.join(app.getPath('userData'), 'quit-by-hand.flag');
export function quitByHand(): boolean { try { return fs.existsSync(flagPath()); } catch { return false; } }
export function markQuitByHand(): void { try { fs.writeFileSync(flagPath(), new Date().toISOString()); } catch { /* best effort */ } }
export function clearQuitByHand(): void { try { fs.rmSync(flagPath(), { force: true }); } catch { /* best effort */ } }

function schtasks(args: string[], what: string): void {
  if (process.platform !== 'win32' || !app.isPackaged) return;
  execFile('schtasks', args, { windowsHide: true, timeout: 15_000 }, (err) => {
    if (err) console.warn(`[watchdog] ${what}:`, err.message);
  });
}

export function installWatchdog(): void {
  schtasks(watchdogCreateArgs(process.execPath, watchdogTaskName(app.getName())), 'install');
}
export function removeWatchdog(): void {
  schtasks(watchdogDeleteArgs(watchdogTaskName(app.getName())), 'remove');
}
