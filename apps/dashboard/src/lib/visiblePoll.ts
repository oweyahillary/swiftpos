/**
 * visiblePoll.ts — A591: a page's timed refresh asks the cloud only while the page is on screen.
 *
 * Owner, 2026-10-26: Supabase's Free plan egress (5 GB) went over; projects restricted from 20 Nov. An Overview tab left
 * open in the background re-read today's, yesterday's and the week's sales every minute, all night — each read is the
 * server pulling those orders from Supabase. While the tab is hidden the timer's ask is skipped; when the tab is shown
 * again the page refreshes at once if its last refresh is older than its own interval (refreshOnShow). On screen, nothing
 * changes.
 */
export const pageHidden = (): boolean => typeof document !== 'undefined' && document.visibilityState === 'hidden';

/** The timer's callback, skipped while the page is hidden. */
export function whenVisible<A extends unknown[]>(fn: (...a: A) => void): (...a: A) => void {
  return (...a: A) => { if (!pageHidden()) fn(...a); };
}

/** When the page is shown again: `fn` once, if `lastAt()` is older than `everyMs`. Returns the remover. */
export function refreshOnShow(fn: () => void, lastAt: () => number, everyMs: number): () => void {
  if (typeof document === 'undefined') return () => {};
  const onShow = () => { if (!pageHidden() && Date.now() - lastAt() >= everyMs) fn(); };
  document.addEventListener('visibilitychange', onShow);
  return () => document.removeEventListener('visibilitychange', onShow);
}
