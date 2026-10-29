// closeHooks.ts — A600 follow-up (owner, 2026-10-28): "back up every 6 hours" and right after the business day is closed.
// ─────────────────────────────────────────────────────────────────────────────
// dayService (closeDayCore — every day close: at this POS, from the branch server's Close Branch, adopted from the web,
// and the automatic close of an empty old day) and shiftService (closeShift / forceCloseShift) say "closed" here once the
// close is written. Who listens (the backup, wired from index.ts) is not their business, and nothing here imports
// electron or the database, so the two services stay testable on their own and gain no import cycle.
//
// A listener never runs inside the close: it is called on the next turn of the event loop, and a listener that throws
// never reaches the close (the close already happened).

export type CloseKind = 'day' | 'shift';
type Listener = (kind: CloseKind) => void;

const _listeners = new Set<Listener>();

/** Listen for closes. Returns the unsubscribe. */
export function onClosed(fn: Listener): () => void {
  _listeners.add(fn);
  return () => { _listeners.delete(fn); };
}

/** Called by dayService / shiftService after a close is written. Never throws. */
export function noteClosed(kind: CloseKind): void {
  if (!_listeners.size) return;
  setImmediate(() => {
    for (const fn of [..._listeners]) { try { fn(kind); } catch { /* a listener never reaches the close */ } }
  });
}
