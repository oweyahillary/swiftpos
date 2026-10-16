/**
 * updaterTask.ts — A509: install a downloaded update through the "ZapTill Updater" scheduled task, so Windows never
 * asks for permission (UAC) on a till nobody is at.
 *
 * The installer (build/installer.nsh, already elevated) registers the task: SYSTEM, highest privileges, no trigger, one
 * fixed script ("%ProgramFiles%\ZapTill Updater\zaptill-update.ps1", only administrators can write there) and no
 * arguments; signed-in users may RUN it, never change it. The app, as the user, only:
 *   1. writes request\update-request.json — { id, version, installerPath, relaunch } — which the script treats as
 *      UNTRUSTED (no downgrade; the installer copied into a SYSTEM-only folder and that copy checked against latest.yml
 *      read over HTTPS from the official release);
 *   2. starts the task (schtasks /Run);
 *   3. waits for the script's answer in updater-status.json (same id): 'ready' (checked — it waits for ZapTill to close,
 *      installs, and starts ZapTill again through the "ZapTill Relaunch" task in the user's session) or 'refused' (with
 *      the reason, e.g. offline). ZapTill closes only on 'ready': a refusal, or no answer, leaves it running and the
 *      update installs on close the old way (electron-updater through elevate.exe — Windows' prompt).
 * Machines installed before 1.0.16 have no task until their next install — the old way, unchanged.
 */
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { randomUUID } from 'crypto';

export const UPDATER_TASK = 'ZapTill Updater';
export const RELAUNCH_TASK = 'ZapTill Relaunch';

/** "%ProgramFiles%\ZapTill Updater" — the 64-bit Program Files on 64-bit Windows, even from the 32-bit build. */
export function updaterDir(env: NodeJS.ProcessEnv = process.env): string {
  const pf = env.ProgramW6432 || env.ProgramFiles || 'C:\\Program Files';
  return path.win32.join(pf, 'ZapTill Updater');
}

export interface TaskDeps {
  platform: string;
  dir: string;
  /** Runs a command; resolves with its exit code and output (never rejects). */
  run: (cmd: string, args: string[]) => Promise<{ code: number; out: string }>;
  writeFile: (file: string, text: string) => void;
  readFile: (file: string) => string | null;
  exists: (file: string) => boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  newId?: () => string;
}

export function defaultTaskDeps(): TaskDeps {
  return {
    platform: process.platform,
    dir: updaterDir(),
    run: (cmd, args) => new Promise((resolve) => {
      execFile(cmd, args, { windowsHide: true, timeout: 20_000 }, (err, out) =>
        resolve({ code: err ? (typeof (err as any).code === 'number' ? (err as any).code : 1) : 0, out: String(out ?? '') }));
    }),
    writeFile: (f, t) => fs.writeFileSync(f, t, 'utf8'),
    readFile: (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } },
    exists: (f) => { try { return fs.existsSync(f); } catch { return false; } },
  };
}

export const requestFile = (dir: string) => path.win32.join(dir, 'request', 'update-request.json');
export const statusFile = (dir: string) => path.win32.join(dir, 'updater-status.json');
export const logFile = (dir: string) => path.win32.join(dir, 'updater.log');

/** Is the updater task there (registered, and its script installed)? Windows only. Never throws. */
export async function hasUpdaterTask(d: TaskDeps): Promise<boolean> {
  if (d.platform !== 'win32') return false;
  try {
    if (!d.exists(path.win32.join(d.dir, 'zaptill-update.ps1'))) return false;
    return (await d.run('schtasks', ['/Query', '/TN', UPDATER_TASK])).code === 0;
  } catch { return false; }
}

export interface UpdateRequest { id: string; version: string; installerPath: string; relaunch: boolean; at: string }

export function buildRequest(o: { id: string; version: string; installerPath: string; relaunch: boolean; now: number }): UpdateRequest {
  return { id: o.id, version: o.version, installerPath: o.installerPath, relaunch: o.relaunch, at: new Date(o.now).toISOString() };
}

export type TaskInstallResult = { ok: true } | { ok: false; reason: string };

/** The most the script may take to check the download (read latest.yml, copy and hash the installer). */
export const TASK_READY_TIMEOUT_MS = 3 * 60_000;

function parseStatus(text: string | null): { id?: string; state?: string; reason?: string } | null {
  if (!text) return null;
  try { return JSON.parse(text.replace(/^\uFEFF/, '')); } catch { return null; }
}

/**
 * Ask the task to install `version` from `installerPath`: write the request, start the task, wait for its answer.
 * ok → the script checked the installer and now waits for ZapTill to close (the caller quits). Never throws.
 */
export async function requestTaskInstall(d: TaskDeps, o: { version: string; installerPath: string; relaunch: boolean; timeoutMs?: number; pollMs?: number }): Promise<TaskInstallResult> {
  const now = d.now ?? Date.now;
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  if (d.platform !== 'win32') return { ok: false, reason: 'not Windows' };
  if (!/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(o.version)) return { ok: false, reason: `not a plain version (${o.version})` };
  if (!o.installerPath) return { ok: false, reason: 'the downloaded installer was not found' };
  const id = (d.newId ?? randomUUID)();
  try {
    d.writeFile(requestFile(d.dir), JSON.stringify(buildRequest({ id, version: o.version, installerPath: o.installerPath, relaunch: o.relaunch, now: now() })));
  } catch (e: any) { return { ok: false, reason: `the update request could not be written (${e?.message ?? e})` }; }
  const r = await d.run('schtasks', ['/Run', '/TN', UPDATER_TASK]).catch((e: any) => ({ code: 1, out: String(e?.message ?? e) }));
  if (r.code !== 0) return { ok: false, reason: `the updater task could not be started (schtasks exit ${r.code})` };
  const until = now() + (o.timeoutMs ?? TASK_READY_TIMEOUT_MS);
  while (now() < until) {
    await sleep(o.pollMs ?? 1_000);
    const s = parseStatus(d.readFile(statusFile(d.dir)));
    if (!s || s.id !== id) continue;   // an older answer, or not started yet
    if (s.state === 'ready') return { ok: true };
    if (s.state === 'refused' || s.state === 'failed') return { ok: false, reason: `the updater task refused it: ${s.reason || 'no reason given'}` };
  }
  return { ok: false, reason: `the updater task did not answer in ${Math.round((o.timeoutMs ?? TASK_READY_TIMEOUT_MS) / 1000)} s (blocked by policy or antivirus?)` };
}

/** The last lines of the updater's own log (the Tech page). Never throws. */
export function updaterLogTail(d: Pick<TaskDeps, 'readFile' | 'dir'>, lines = 20): string[] {
  const t = d.readFile(logFile(d.dir));
  if (!t) return [];
  return t.replace(/^\uFEFF/, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-lines);
}
