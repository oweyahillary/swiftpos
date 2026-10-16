/**
 * activity.ts — A508: tells the main process the screen is in use, so an update installs on its own only when nobody is
 * there (main/activityTracker.ts). Fire-and-forget over `activity:ping` (window.swiftpos.activity, like logError).
 *
 *   - startActivityPings(): wired ONCE at the app root (main.tsx) — a key, a click or a touch sends { input: true }, at
 *     most one every 30 s. Passive, capture-phase listeners: nothing on the page can stop them, and they never block.
 *   - reportBusy(): the sale screen (POSPage) says when a cart has items or the payment screen is open — sent only when it
 *     changes.
 */
export const PING_EVERY_MS = 30_000;

type Bridge = (p: { input?: boolean; busy?: { cart?: boolean; payment?: boolean } }) => void;
const bridge = (): Bridge | null => {
  try { const f = (window as any).swiftpos?.activity; return typeof f === 'function' ? f : null; } catch { return null; }
};

let started = false;
/** Returns the number of listeners added (0 when already started or no bridge). */
export function startActivityPings(target: Pick<Window, 'addEventListener'> = window, now: () => number = Date.now): number {
  if (started) return 0;
  const send = bridge();
  if (!send) return 0;
  started = true;
  let last = 0;
  const ping = () => {
    const t = now();
    if (last && t - last < PING_EVERY_MS) return;
    last = t;
    try { send({ input: true }); } catch { /* never */ }
  };
  for (const ev of ['keydown', 'pointerdown', 'touchstart'] as const) target.addEventListener(ev, ping, { capture: true, passive: true });
  return 3;
}

let lastBusy = '';
export function reportBusy(b: { cart: boolean; payment: boolean }): void {
  const key = `${b.cart ? 1 : 0}${b.payment ? 1 : 0}`;
  if (key === lastBusy) return;
  lastBusy = key;
  try { bridge()?.({ busy: { cart: b.cart, payment: b.payment } }); } catch { /* never */ }
}
