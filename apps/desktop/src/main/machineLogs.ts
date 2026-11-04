/**
 * machineLogs.ts — A622: the logs on this PC that are not ZapTill's own swiftpos.log / auth.log, for a support bundle.
 *
 * Owner, 2026-11-04, after TJS T1's update failed twice and the pulled log could not say why: "how can we get all logs
 * the app generates not just running logs". Besides swiftpos.log and auth.log (supportLogs.ts) ZapTill leaves:
 *   - the updater's own log (%ProgramFiles%\ZapTill Updater\updater.log — what the updater task checked, installed, and
 *     the installer's exit code when an install fails) and its last answer (updater-status.json);
 *   - Windows' Application event log: ZapTill crashing ("Application Error", "Windows Error Reporting"), a hang, the
 *     installer or the updater failing — the events in the window that name ZapTill.
 * Each part is one section of the bundle; the caller passes them to buildSupportText (BuildOptions.sections), so the
 * same redaction and size cap apply. A part that cannot be read says so in one line instead of failing the bundle.
 */
import { execFile } from 'child_process';
import { defaultTaskDeps, logFile, statusFile, type TaskDeps } from './updaterTask';
import { windowOfLog } from './supportLogs';

export interface LogSection { title: string; text: string }

/** At most this many Windows events, and this many characters of each. */
export const MAX_EVENTS = 40;
export const EVENT_CHARS = 400;
const UPDATER_CAP_BYTES = 128 * 1024;

/** The updater's log lines in the window (its lines start "2026-11-04T08:10:49Z  …"), then its last answer. Pure but for reading. */
export function updaterSections(d: Pick<TaskDeps, 'readFile' | 'dir'>, nowMs: number, windowMs: number): LogSection[] {
  const log = d.readFile(logFile(d.dir));
  const status = d.readFile(statusFile(d.dir));
  const lines = log ? windowOfLog([log.replace(/^﻿/, '')], nowMs, windowMs, UPDATER_CAP_BYTES).text : '';
  return [
    { title: 'updater.log (the ZapTill Updater task)', text: log === null ? '(no updater log on this PC — no updater task, or never used)' : lines || '(nothing in the window)' },
    { title: 'updater-status.json (its last answer)', text: status === null ? '(none)' : status.replace(/^﻿/, '').trim() },
  ];
}

/** The PowerShell that lists the Application events naming ZapTill since `hours` ago, one line each, newest last. */
export function eventScript(hours: number): string {
  const h = Math.max(1, Math.min(24 * 31, Math.round(hours)));
  return [
    `$since = (Get-Date).AddHours(-${h})`,
    `$ev = Get-WinEvent -FilterHashtable @{ LogName = 'Application'; StartTime = $since; Level = 1,2,3 } -ErrorAction SilentlyContinue`,
    `$ev | Where-Object { $_.Message -match 'ZapTill' -or $_.ProviderName -match 'ZapTill' } | Select-Object -First ${MAX_EVENTS} | Sort-Object TimeCreated | ForEach-Object {`,
    `  $m = ($_.Message -replace '\\s+', ' ').Trim()`,
    `  if ($m.Length -gt ${EVENT_CHARS}) { $m = $m.Substring(0, ${EVENT_CHARS}) }`,
    `  $_.TimeCreated.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ') + '  ' + $_.LevelDisplayName + ' ' + $_.ProviderName + ' ' + $_.Id + ': ' + $m`,
    `}`,
  ].join('\n');
}

export type RunScript = (script: string) => Promise<{ code: number; out: string }>;

function runPowerShell(script: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: 25_000, maxBuffer: 1024 * 1024 },
      (err, out) => resolve({ code: err ? 1 : 0, out: String(out ?? '') }));
  });
}

/** Windows' Application events naming ZapTill in the window (a crash, a hang, the installer). Never throws. */
export async function windowsEventSection(windowMs: number, run: RunScript = runPowerShell, platform = process.platform): Promise<LogSection> {
  const title = 'Windows Application events naming ZapTill (errors and warnings)';
  if (platform !== 'win32') return { title, text: '(not Windows)' };
  try {
    const r = await run(eventScript(windowMs / 3_600_000));
    const text = r.out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join('\n');
    if (text) return { title, text };
    return { title, text: r.code === 0 ? '(none in the window)' : '(the event log could not be read)' };
  } catch {
    return { title, text: '(the event log could not be read)' };
  }
}

/** Everything above, for the window. Never throws. */
export async function machineLogSections(nowMs: number, windowMs: number): Promise<LogSection[]> {
  const out: LogSection[] = [];
  if (process.platform === 'win32') {
    try { out.push(...updaterSections(defaultTaskDeps(), nowMs, windowMs)); } catch { /* skipped */ }
  }
  out.push(await windowsEventSection(windowMs));
  return out;
}
