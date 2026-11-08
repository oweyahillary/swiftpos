/**
 * reporter.ts — crash and error reports to the ZapTill cloud, which puts them on the admin portal's alerts
 * (POST /api/app-errors; category "Android app crashes and errors").
 *
 *   - a native crash: the crash handler (CrashReporter.java) keeps it on disk; it is sent at the next start
 *   - a script error, or a promise nobody caught, in the app's own screens
 * At most MAX_PER_RUN reports a run and each message once, so a loop of errors never floods the cloud. Reports wait until
 * the device's mode is known (a report names its surface). A report that cannot be sent is dropped — never retried in a
 * loop; a native crash stays on disk until it has been read.
 */
import { APP_ERROR_LIMITS, type AndroidSurface, type AppErrorReport } from '@zaptill/core/androidApp';
import { cloudPost } from '../cloud/client';
import { CrashReports } from '../native/plugins';

const MAX_PER_RUN = 5;

type Problem = Pick<AppErrorReport, 'kind' | 'message' | 'stack'>;

let surface: AndroidSurface | null = null;
let appVersion = '0.0.0';
let device = '';
let sent = 0;
const seen = new Set<string>();
const waiting: Problem[] = [];

async function send(p: Problem): Promise<void> {
  if (!surface) { if (waiting.length < MAX_PER_RUN) waiting.push(p); return; }
  if (sent >= MAX_PER_RUN || seen.has(p.message)) return;
  seen.add(p.message); sent++;
  const report: AppErrorReport = { surface, appVersion, ...(device ? { device } : {}), ...p };
  try { await cloudPost('/app-errors', report); } catch { /* dropped: no retry loop */ }
}

const clip = (v: unknown, max: number) => String(v ?? '').slice(0, max);

function problemOf(reason: unknown): Problem {
  const e = reason instanceof Error ? reason : null;
  return {
    kind: 'error',
    message: clip(e ? `${e.name}: ${e.message}` : reason, APP_ERROR_LIMITS.message) || 'Unknown error',
    ...(e?.stack ? { stack: clip(e.stack, APP_ERROR_LIMITS.stack) } : {}),
  };
}

/** Listen for the app's own script errors. Called once, before the first screen. */
export function listenForErrors(): void {
  window.addEventListener('error', (e) => { void send(problemOf(e.error ?? e.message)); });
  window.addEventListener('unhandledrejection', (e) => { void send(problemOf(e.reason)); });
}

/** The device's mode is known (on first launch: once chosen): send what waited, and the native crash kept from last run. */
export async function startReporting(s: AndroidSurface, version: string): Promise<void> {
  surface = s; appVersion = version;
  try { device = (await CrashReports.deviceSummary()).summary; } catch { device = ''; }
  for (const p of waiting.splice(0)) await send(p);
  try {
    const { crash } = await CrashReports.takePendingCrash();
    if (crash) await send({ kind: 'crash', message: clip(crash.message, APP_ERROR_LIMITS.message), stack: clip(crash.stack, APP_ERROR_LIMITS.stack) });
  } catch { /* not on Android (a browser preview) */ }
}

/** Reset app: the mode is gone, so reports wait again. */
export function stopReporting(): void { surface = null; }
