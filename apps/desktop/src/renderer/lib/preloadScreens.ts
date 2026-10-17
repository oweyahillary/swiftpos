/**
 * preloadScreens.ts — A517: the manager screens fetched in the background, once the till is quiet.
 *
 * The manager screens (Overview, reports, staff, stock, offers, close day…) are their own chunk since A517: the PIN
 * screen and the POS no longer wait for them, nor hold them in memory. A manager opening them would then wait for the
 * chunk to load — so, on a machine with memory to spare, it is fetched in the background a few seconds after the PIN
 * screen or the POS has settled, at an idle moment. Never during the start-up sequence (A513: main says when it is
 * over), never on a 4 GB machine (navigator.deviceMemory, and main's own reading of the machine's memory) — there the
 * chunk loads when somebody opens the manager screens, and only then.
 */

/** What main says (idle:mayPreload): the start-up sequence is over, and the machine has the memory. */
export interface MainPreloadAnswer { ok: boolean; settled: boolean; why: string }

/** Chromium's navigator.deviceMemory: the machine's memory in GB, rounded down to a power of two and capped at 8. */
export const LOW_DEVICE_MEMORY_GB = 4;
/** The quiet moment: this long after the screen settled, then the browser's next idle period. */
export const PRELOAD_AFTER_MS = 8_000;
/** Main not done starting yet: asked again this much later (a few times, then given up — it loads when opened). */
export const PRELOAD_RETRY_MS = 30_000;
export const PRELOAD_TRIES = 10;

export type PreloadVerdict = 'load' | 'later' | 'never';

/** Pure: may the manager chunk be fetched now? */
export function preloadVerdict(deviceMemoryGb: number | undefined | null, main: MainPreloadAnswer | null): PreloadVerdict {
  if (typeof deviceMemoryGb === 'number' && deviceMemoryGb > 0 && deviceMemoryGb <= LOW_DEVICE_MEMORY_GB) return 'never';
  if (!main) return 'never';             // main could not be asked (an older main): loaded when opened, as before
  if (!main.settled) return 'later';     // A513: the start-up sequence is still going
  return main.ok ? 'load' : 'never';     // low memory on this machine → only when opened
}

export interface PreloadDeps {
  load: () => Promise<unknown>;
  ask: () => Promise<MainPreloadAnswer | null>;
  deviceMemory: () => number | undefined;
  /** setTimeout / requestIdleCallback stand-ins (tests). */
  wait: (ms: number, fn: () => void) => () => void;
  idle: (fn: () => void) => void;
  log?: (line: string) => void;
}

/**
 * Starts the background fetch: PRELOAD_AFTER_MS, then an idle moment, then main is asked. Returns a cancel (the screen
 * changed before the moment came). The chunk is fetched at most once per run — `done` is shared through the caller.
 */
export function schedulePreload(d: PreloadDeps, state: { done: boolean }): () => void {
  let cancelled = false;
  let stop: () => void = () => {};
  const attempt = (tries: number) => {
    stop = d.wait(tries === 0 ? PRELOAD_AFTER_MS : PRELOAD_RETRY_MS, () => {
      d.idle(() => {
        if (cancelled || state.done) return;
        void d.ask().catch(() => null).then((main) => {
          if (cancelled || state.done) return;
          const v = preloadVerdict(d.deviceMemory(), main);
          if (v === 'later' && tries + 1 < PRELOAD_TRIES) { attempt(tries + 1); return; }
          if (v !== 'load') { state.done = true; d.log?.(`manager screens not preloaded (${main?.why ?? 'low memory'}) — they load when opened`); return; }
          state.done = true;
          d.load().catch(() => { state.done = false; /* loaded when opened */ });
        });
      });
    });
  };
  if (!state.done) attempt(0);
  return () => { cancelled = true; stop(); };
}

/** The browser's pieces: setTimeout, requestIdleCallback (2 s at most), navigator.deviceMemory. */
export function browserPreloadDeps(load: () => Promise<unknown>, ask: () => Promise<MainPreloadAnswer | null>): PreloadDeps {
  return {
    load, ask,
    deviceMemory: () => (navigator as unknown as { deviceMemory?: number }).deviceMemory,
    wait: (ms, fn) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); },
    idle: (fn) => {
      const ric = (window as unknown as { requestIdleCallback?: (f: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
      if (ric) ric(fn, { timeout: 2_000 }); else setTimeout(fn, 0);
    },
  };
}
