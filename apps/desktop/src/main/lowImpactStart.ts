/**
 * lowImpactStart.ts — A513: a low-impact start (owner, 2026-10-16, a 4 GB / old i3 PC, Task Manager "High" startup
 * impact: "the window does not need to open, the user will open the app if needed, and load the sync sequential, no
 * need to check for updates immediately, it can do it after windows is fully loaded").
 *
 * Kept free of heavy imports (fs, path and the electron app only) — startGate.ts runs it before anything else loads.
 *
 *  - START AFTER SIGN-IN, NOT AT IT. The installer (build/installer.nsh, already elevated) registers one scheduled task,
 *    "<product> start at sign-in": a logon trigger 45 s after ANY user signs in, launching `ZapTill.exe --at-login`. A
 *    scheduled task is not a Startup app (Task Manager does not count it). The launch exits at once (startGate.ts,
 *    before the rest of ZapTill loads) unless THIS Windows user's ZapTill is a branch server — the marker file below,
 *    written by server mode. A machine whose installer could not register the task keeps a "start with Windows" (HKCU
 *    Run) entry, now `--at-login --login-wait`: the app waits LOGIN_WAIT_MS before it does anything.
 *  - NO WINDOW AT AUTO-START. A branch server started by the task, the watchdog or the updater's relaunch runs in the
 *    tray only; its window is made when somebody opens it.
 *  - SEQUENTIAL START. runStartupSequence: one step at a time, business-critical first, each step capped.
 *  - UPDATES LATER. whenStartupSettled: the first update check waits for the sequence and UPDATE_AFTER_LAUNCH_MS.
 *  - MEASURED. One 'startup' log line per start (the Tech page shows the last one).
 */
import fs from 'fs';
import path from 'path';

export const AT_LOGIN_ARG = '--at-login';
/** The Run-key fallback (no start task): the app waits before it starts its work. */
export const LOGIN_WAIT_ARG = '--login-wait';
export const LOGIN_WAIT_MS = 45_000;
/** A509's relaunch task starts ZapTill with this after an update. */
export const UPDATED_ARG = '--updated';
/** A435: the restart task's launches (serverWatchdog.WATCHDOG_ARG — repeated here so this file stays light). */
const WATCHDOG = '--watchdog';

/** The installer's logon task (build/installer.nsh: "${PRODUCT_NAME} start at sign-in"). */
export function startTaskName(appName: string): string {
  return appName.toLowerCase().includes('dev') ? 'ZapTill Dev start at sign-in' : 'ZapTill start at sign-in';
}

// ── The marker: "this Windows user's ZapTill is a branch server — it starts after sign-in" ─────────────────────────
export const MARKER_FILE = 'start-at-sign-in.flag';
export const markerPath = (userData: string) => path.join(userData, MARKER_FILE);
export function startsAtSignIn(userData: string): boolean {
  try { return fs.existsSync(markerPath(userData)); } catch { return false; }
}
export function setStartsAtSignIn(userData: string, on: boolean): void {
  try {
    if (on) fs.writeFileSync(markerPath(userData), new Date().toISOString());
    else fs.rmSync(markerPath(userData), { force: true });
  } catch { /* best effort — the next server start writes it again */ }
}

/** Started by Windows (the start task, the Run fallback), the restart task, or the updater — not by a person. */
export function isAutoLaunch(argv: readonly string[]): boolean {
  return argv.includes(AT_LOGIN_ARG) || argv.includes(WATCHDOG) || argv.includes(UPDATED_ARG);
}

/**
 * The very first decision of a launch (startGate.ts), from two tiny files and the arguments:
 *   'exit'    — an automatic start on a machine that does not start by itself (a till), or a restart-task launch
 *               after a quit by hand (A435: a quit from the tray stays quit);
 *   'handoff' — the sign-in start on a branch server: start the restart task instead, so the running server IS that
 *               task's process and Task Scheduler never launches another while it runs (IgnoreNew);
 *   'go'      — start as usual.
 */
export type GateDecision = 'exit' | 'handoff' | 'go';
export function gateDecision(argv: readonly string[], o: { server: boolean; quitByHand: boolean }): GateDecision {
  const atLogin = argv.includes(AT_LOGIN_ARG);
  const watchdog = argv.includes(WATCHDOG);
  if ((atLogin || watchdog) && !o.server) return 'exit';
  if (watchdog && o.quitByHand) return 'exit';
  // The Run fallback waits in this process (no start task means no restart task to hand to is likely either).
  if (atLogin && !argv.includes(LOGIN_WAIT_ARG)) return 'handoff';
  return 'go';
}

/** No window at start: an automatic start of a branch server. A till (and anything started by hand) opens its window. */
export function startsWindowless(argv: readonly string[], server: boolean): boolean {
  return server && isAutoLaunch(argv);
}

// ── The startup sequence ────────────────────────────────────────────────────────────────────────────────────────────
export interface StartupStep { name: string; what: string; run: () => unknown }
export interface StepResult { name: string; ms: number; outcome: 'done' | 'capped' | 'failed'; error?: string }
/** The most one step holds up the next (a hung step goes on in the background; the next one starts). */
export const STEP_CAP_MS = 20_000;

export async function runStartupSequence(steps: StartupStep[], o: {
  log: (line: string) => void; capMs?: number; now?: () => number;
}): Promise<StepResult[]> {
  const now = o.now ?? Date.now;
  const cap = o.capMs ?? STEP_CAP_MS;
  const out: StepResult[] = [];
  for (const s of steps) {
    const t = now();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const capped = Symbol('capped');
    let r: StepResult;
    try {
      const v = await Promise.race([
        Promise.resolve().then(() => s.run()),
        new Promise<typeof capped>((res) => { timer = setTimeout(() => res(capped), cap); }),
      ]);
      r = { name: s.name, ms: now() - t, outcome: v === capped ? 'capped' : 'done' };
    } catch (e: any) {
      r = { name: s.name, ms: now() - t, outcome: 'failed', error: String(e?.message ?? e) };
    } finally { if (timer) clearTimeout(timer); }
    out.push(r);
    o.log(r.outcome === 'done' ? `step ${s.name} (${s.what}): done in ${r.ms} ms`
      : r.outcome === 'capped' ? `step ${s.name} (${s.what}): still running after ${r.ms} ms — it goes on in the background, the next step starts`
      : `step ${s.name} (${s.what}): failed after ${r.ms} ms (${r.error}) — the next step starts`);
  }
  return out;
}

// ── "Startup is over" ───────────────────────────────────────────────────────────────────────────────────────────────
let settled = false;
let settle: (() => void) | null = null;
const settledP = new Promise<void>((r) => { settle = r; });
/** If the sequence never ran (a start-up error), the work waiting on it still begins after this long. */
export const SETTLE_BACKSTOP_MS = 10 * 60_000;
const backstop = setTimeout(() => markStartupSettled(), SETTLE_BACKSTOP_MS);
(backstop as any).unref?.();

export function markStartupSettled(): void {
  if (settled) return;
  settled = true;
  clearTimeout(backstop);
  settle?.();
}
export function startupSettled(): boolean { return settled; }

/** Run `fn` once startup is over and at least `minSinceLaunchMs` after the process began (and `afterMs` after that). */
export function whenStartupSettled(fn: () => void, o: { minSinceLaunchMs?: number; afterMs?: number } = {}): void {
  void settledP.then(() => {
    const wait = Math.max((o.minSinceLaunchMs ?? 0) - sinceLaunchMs(), o.afterMs ?? 0, 0);
    if (wait <= 0) { try { fn(); } catch (e) { console.error('[startup] deferred work:', e); } return; }
    setTimeout(() => { try { fn(); } catch (e) { console.error('[startup] deferred work:', e); } }, wait);
  });
}

/** A513 item 4: the first update check — after the sequence, and never before this long after launch. */
export const UPDATE_AFTER_LAUNCH_MS = 4 * 60_000;
export const UPDATE_AFTER_SETTLED_MS = 30_000;
export function updateCheckDelayMs(sinceLaunch: number): number {
  return Math.max(UPDATE_AFTER_LAUNCH_MS - sinceLaunch, UPDATE_AFTER_SETTLED_MS);
}

// ── Measuring ───────────────────────────────────────────────────────────────────────────────────────────────────────
const processStart = Date.now() - Math.round(process.uptime() * 1000);
export function sinceLaunchMs(now = Date.now()): number { return now - processStart; }
const marks: { ready?: number; window?: number; sequence?: number } = {};
export function markStartup(what: 'ready' | 'window' | 'sequence', now = Date.now()): void {
  if (marks[what] === undefined) marks[what] = sinceLaunchMs(now);
}
let lastLine: string | null = null;
export function lastStartupLine(): string | null { return lastLine; }

const secs = (ms: number | undefined) => (ms === undefined ? null : `${(ms / 1000).toFixed(1)} s`);
/** One plain line: how long to ready / first window / the end of the sequence, and the memory then. */
export function startupLine(o: { how: string; memoryKb: number | null; processes: number | null;
  m?: { ready?: number; window?: number; sequence?: number } }): string {
  const m = o.m ?? marks;
  const mem = o.memoryKb === null ? 'memory not known' : `memory ${Math.round(o.memoryKb / 1024)} MB in ${o.processes} process${o.processes === 1 ? '' : 'es'}`;
  return `start (${o.how}): ready ${secs(m.ready) ?? '?'}, window ${secs(m.window) ?? 'none'}, sync sequence done ${secs(m.sequence) ?? '?'}, ${mem}`;
}
export function noteStartupLine(line: string): void { lastLine = line; }
/** The graphics decision (startGate: low-memory mode), for the Tech page. */
let gfx: string | null = null;
export function noteGraphicsLine(line: string): void { gfx = line; }
export function graphicsLine(): string | null { return gfx; }

/** Tests only. */
export function _resetLowImpactStart(): void { for (const k of Object.keys(marks)) delete (marks as any)[k]; lastLine = null; }
