/**
 * serverLoad.ts — A589: is the server overloaded? How late the event loop runs a 500 ms timer (a blocked or saturated
 * process answers nothing while it is late), since the last watchdog run. Near-free: one timer, one number a tick, kept
 * in memory (at most 2 400 — 20 minutes). The answer times are counted in lib/watchdogCounters.ts; the rule is
 * lib/watchdogRules.ts serverOverload.
 */
const TICK_MS = 500;
const MAX_SAMPLES = 2400;
let timer: NodeJS.Timeout | null = null;
let samples: number[] = [];

/** Start measuring (the watchdog job calls it once). */
export function startLoopMonitor(): void {
  if (timer) return;
  let expected = Date.now() + TICK_MS;
  timer = setInterval(() => {
    const now = Date.now();
    recordLoopDelay(Math.max(0, now - expected));
    expected = now + TICK_MS;
  }, TICK_MS);
  timer.unref();   // never keeps the process alive
}

/** One measured delay (ms) — the timer, or a test. */
export function recordLoopDelay(ms: number): void {
  samples.push(ms);
  if (samples.length > MAX_SAMPLES) samples = samples.slice(-MAX_SAMPLES);
}

/** The 99th-percentile delay (ms) since the last call, then start again; null when nothing was measured. */
export function takeLoopLag(): number | null {
  if (!samples.length) return null;
  const s = [...samples].sort((a, b) => a - b);
  samples = [];
  return s[Math.min(s.length - 1, Math.ceil(s.length * 0.99) - 1)];
}
