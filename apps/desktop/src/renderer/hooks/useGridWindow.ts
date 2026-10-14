/**
 * useGridWindow — A472: a POS grid draws a screenful of tiles, then more as the cashier scrolls.
 *
 * A cashier scrolls, so there are no page buttons: the grid draws GRID_STEP tiles, and GRID_STEP more each time the
 * sentinel at its end comes within 400 px of the bottom of the grid's own scroll box (IntersectionObserver, root =
 * that box). A new category or search (`resetKey`) starts again at the top. The observer is made again after each
 * step, so a tall screen whose sentinel is still in view keeps filling. With no IntersectionObserver, every tile.
 * Callback refs, not ref objects: the grid unmounts and returns (tables / pumps view) and the observer must follow it.
 */
import { useEffect, useState } from 'react';
import { GRID_STEP, nextGridCount } from '../../shared/paginate';

export function useGridWindow(total: number, resetKey: string, step: number = GRID_STEP) {
  const [shown, setShown] = useState(step);
  const [root, setRoot] = useState<HTMLElement | null>(null);
  const [sentinel, setSentinel] = useState<HTMLElement | null>(null);
  const canObserve = typeof IntersectionObserver !== 'undefined';

  useEffect(() => {
    setShown(step);
    if (root) root.scrollTop = 0;
  }, [resetKey, step]); // eslint-disable-line react-hooks/exhaustive-deps

  const count = canObserve ? Math.min(shown, total) : total;
  const more = count < total;

  useEffect(() => {
    if (!more || !sentinel || !canObserve) return;
    const io = new IntersectionObserver(
      entries => { if (entries.some(e => e.isIntersecting)) setShown(n => nextGridCount(n, total, step)); },
      { root, rootMargin: '0px 0px 400px 0px' },
    );
    io.observe(sentinel);
    return () => io.disconnect();
  }, [more, sentinel, root, total, step, shown, canObserve]);

  return { count, more, rootRef: setRoot, sentinelRef: setSentinel };
}
