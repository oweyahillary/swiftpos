/**
 * singleInstance.ts — A554: one ZapTill per machine, and a launch that is not the one ends before anything loads.
 *
 * B Foods' log, 2026-10-21 (a branch server, no other tills):
 *   16:55:01 [startup] … started by the restart task as the branch server — in the tray
 *   16:55:45 [startup] ZapTill 1.0.19 build 0d25b43 …
 *   16:55:45 [console.warn] [node] port 4100 in use, trying 4101
 * A second launch 44 s later ran the WHOLE start-up beside the one in the tray — its own database handle, its own sync,
 * a second branch server on 4101. The cause (index.ts before A554): the launch that did not get the single-instance
 * lock called app.quit() — which, before Electron is ready, does not stop the start-up: 'ready' still fires, and the
 * app.whenReady() handler was registered for every launch, not only the one holding the lock. Now the launch without
 * the lock ends at once (process.exit, as startGate.ts's restart-task check always did) after Windows has handed its
 * arguments to the running ZapTill (which shows its window for a launch by hand — 'second-instance').
 *
 * One exception waits instead of ending: the relaunch after an update (--updated). The installer starts it as the old
 * ZapTill is closing; ending it then could leave the machine with no ZapTill at all. It asks for the lock again every
 * LOCK_RETRY_MS, for at most LOCK_WAIT_MS, then ends (the old one is evidently still running — it stays the one).
 *
 * Pure decision plus a loop with its pieces handed in (the test drives both); no Electron here.
 */
import { UPDATED_ARG } from './lowImpactStart';

export const LOCK_WAIT_MS = 30_000;
export const LOCK_RETRY_MS = 500;

/** A launch that did not get the lock: wait for it (the relaunch after an update, within LOCK_WAIT_MS) or end. */
export function secondLaunchStep(argv: readonly string[], waitedMs: number): 'wait' | 'exit' {
  return argv.includes(UPDATED_ARG) && waitedMs < LOCK_WAIT_MS ? 'wait' : 'exit';
}

/** Ask for the lock (and, for the relaunch after an update, keep asking while the old ZapTill closes). */
export function takeSingleInstanceLock(d: {
  request: () => boolean; argv: readonly string[]; sleep: (ms: number) => void; now?: () => number;
}): boolean {
  const now = d.now ?? Date.now;
  const t0 = now();
  for (;;) {
    if (d.request()) return true;
    if (secondLaunchStep(d.argv, now() - t0) === 'exit') return false;
    d.sleep(LOCK_RETRY_MS);
  }
}

/** A short wait before Electron is ready (nothing else runs yet — no window, no timers to starve). */
export function sleepSync(ms: number): void {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* no wait: the next ask comes at once */ }
}
