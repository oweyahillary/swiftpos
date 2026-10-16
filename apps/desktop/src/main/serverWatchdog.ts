/**
 * serverWatchdog.ts — A435 option (a) (owner, 2026-10-10: "let's work with your recommendation").
 *
 * The branch server starts after Windows sign-in (A513: the installer's sign-in task — lowImpactStart.ts). On its own
 * that does not bring it back after a crash or a Task Manager kill. So while this machine serves its branch, a Windows
 * scheduled task (the RESTART task) starts ZapTill every 5 minutes with `--watchdog`:
 *   - someone chose "Quit" in the tray → the task is disabled (and a flag says so, ending any launch at once — startGate)
 *     until ZapTill is next opened by hand (a deliberate quit stays quit).
 * The task runs while the Windows user is logged in — with the server PC set to log in by itself (the setup guide's
 * step), that is from power-on. Leaving server mode removes the task. A plain till never has one.
 *
 * A513 (owner, 2026-10-16: "the zap app keeps peeping on the taskbar even when closed"): the task used to be
 * `schtasks /SC MINUTE` — it LAUNCHED ZapTill every 5 minutes whatever was running, and each launch went through the
 * whole start before the single-instance lock ended it; and its default 72-hour limit could end a server it had started.
 * Now it is written from XML (watchdogTaskXml):
 *   - MultipleInstancesPolicy IgnoreNew — while the ZapTill the task started is running, Task Scheduler starts nothing;
 *     a launch happens only if ZapTill died (restarted within 5 minutes). The sign-in start hands over to this task
 *     (startGate.ts), so the running server is normally the task's own process;
 *   - ExecutionTimeLimit PT0S — never ended by Task Scheduler; normal priority (5), not the default below-normal (7);
 *   - a launch that does find ZapTill running (started by hand, or relaunched after an update) ends in startGate on the
 *     single-instance lock before anything loads — no window, no taskbar button.
 */
import { app } from 'electron';
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const WATCHDOG_ARG = '--watchdog';
export const WATCHDOG_EVERY_MINUTES = 5;

export function watchdogTaskName(appName: string): string {
  return appName.toLowerCase().includes('dev') ? 'ZapTill Dev branch server' : 'ZapTill branch server';
}

const xmlEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * A513: the restart task — every 5 minutes while this user is signed in, IgnoreNew, no time limit, normal priority,
 * starting ZapTill with --watchdog. `user` is DOMAIN\name (empty: Task Scheduler takes the registering user).
 */
export function watchdogTaskXml(exe: string, user: string): string {
  const who = user ? `<UserId>${xmlEscape(user)}</UserId>` : '';
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <RegistrationInfo><Description>Starts the ZapTill branch server again within 5 minutes if it stopped; never while it runs (A435, A513).</Description></RegistrationInfo>',
    `  <Triggers><TimeTrigger><StartBoundary>2020-01-01T00:00:00</StartBoundary><Enabled>true</Enabled><Repetition><Interval>PT${WATCHDOG_EVERY_MINUTES}M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition></TimeTrigger></Triggers>`,
    `  <Principals><Principal id="Author">${who}<LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>`,
    '  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowHardTerminate>true</AllowHardTerminate><StartWhenAvailable>false</StartWhenAvailable><RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable><IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings><AllowStartOnDemand>true</AllowStartOnDemand><Enabled>true</Enabled><Hidden>false</Hidden><RunOnlyIfIdle>false</RunOnlyIfIdle><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><Priority>5</Priority></Settings>',
    `  <Actions Context="Author"><Exec><Command>${xmlEscape(exe)}</Command><Arguments>${WATCHDOG_ARG}</Arguments><WorkingDirectory>${xmlEscape(path.win32.dirname(exe))}</WorkingDirectory></Exec></Actions>`,
    '</Task>',
    '',
  ].join('\r\n');
}

/** schtasks arguments: the task from its XML file, replacing any older copy (the A435 `/SC MINUTE` one included). */
export function watchdogCreateArgs(xmlFile: string, taskName: string): string[] {
  return ['/Create', '/F', '/TN', taskName, '/XML', xmlFile];
}
export function watchdogDeleteArgs(taskName: string): string[] {
  return ['/Delete', '/F', '/TN', taskName];
}
/** A513: a quit by hand switches the task off — nothing is launched every 5 minutes while it stays quit. */
export function watchdogDisableArgs(taskName: string): string[] {
  return ['/Change', '/TN', taskName, '/DISABLE'];
}

/** A launch by the task, after a quit from the tray: end at once. */
export function watchdogStaysDown(argv: readonly string[], quitByHand: boolean): boolean {
  return argv.includes(WATCHDOG_ARG) && quitByHand;
}

const flagPath = () => path.join(app.getPath('userData'), 'quit-by-hand.flag');
export function quitByHand(): boolean { try { return fs.existsSync(flagPath()); } catch { return false; } }
export function markQuitByHand(): void { try { fs.writeFileSync(flagPath(), new Date().toISOString()); } catch { /* best effort */ } }
export function clearQuitByHand(): void { try { fs.rmSync(flagPath(), { force: true }); } catch { /* best effort */ } }

function schtasks(args: string[], what: string, done?: (ok: boolean) => void): void {
  if (process.platform !== 'win32' || !app.isPackaged) { done?.(false); return; }
  execFile('schtasks', args, { windowsHide: true, timeout: 15_000 }, (err) => {
    if (err) console.warn(`[watchdog] ${what}:`, err.message);
    done?.(!err);
  });
}

export function installWatchdog(): void {
  if (process.platform !== 'win32' || !app.isPackaged) return;
  const file = path.join(app.getPath('userData'), 'restart-task.xml');
  try {
    const user = process.env.USERNAME ? (process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : process.env.USERNAME) : '';
    fs.writeFileSync(file, Buffer.from('﻿' + watchdogTaskXml(process.execPath, user), 'utf16le'));
  } catch (e: any) { console.warn('[watchdog] task file:', e?.message ?? e); return; }
  schtasks(watchdogCreateArgs(file, watchdogTaskName(app.getName())), 'install', () => { try { fs.rmSync(file, { force: true }); } catch { /* kept */ } });
}
export function removeWatchdog(): void {
  schtasks(watchdogDeleteArgs(watchdogTaskName(app.getName())), 'remove');
}
/** On the tray's Quit: synchronous — ZapTill quits right after, and the task must be off before it is gone. */
export function disableWatchdog(): void {
  if (process.platform !== 'win32' || !app.isPackaged) return;
  try { execFileSync('schtasks', watchdogDisableArgs(watchdogTaskName(app.getName())), { windowsHide: true, timeout: 5_000, stdio: 'ignore' }); }
  catch { /* the flag still ends every launch at once (startGate) */ }
}
