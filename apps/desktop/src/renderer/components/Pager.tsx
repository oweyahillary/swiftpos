/**
 * Pager — A472: the till's Menu screen in pages.
 *
 * Owner, 2026-10-14: "can we paginate the menu". "Showing 51–100 of 1,234", a page-size choice (25 / 50 / 100, kept on
 * this till), First / Prev / 1 … 4 5 6 … 25 / Next / Last. The maths is shared/paginate.ts (the same file as the web's).
 *
 * Usage:
 *   const [size, setSize] = usePageSize('swiftpos.pageSize.menu');
 *   const paged = paginate(filtered, page, size);
 *   <Pager paged={paged} onPage={setPage} onSize={n => { setSize(n); setPage(1); }} />
 */
import { useCallback, useState } from 'react';
import { PAGE_SIZES, DEFAULT_PAGE_SIZE, cleanPageSize, pageWindow, rangeLabel, type Paged } from '../../shared/paginate';

/** The page size for one screen, remembered on this till. Storage may be unavailable: then 50. */
export function usePageSize(key: string): [number, (n: number) => void] {
  const [size, setSize] = useState<number>(() => {
    try { return cleanPageSize(localStorage.getItem(key)); } catch { return DEFAULT_PAGE_SIZE; }
  });
  const set = useCallback((n: number) => {
    const c = cleanPageSize(n);
    setSize(c);
    try { localStorage.setItem(key, String(c)); } catch { /* not remembered — still applied */ }
  }, [key]);
  return [size, set];
}

const BTN = 'min-w-[2rem] px-2 py-1 rounded-md text-xs transition-colors disabled:opacity-40 disabled:cursor-not-allowed';
const IDLE = 'bg-gray-800 text-gray-300 hover:text-white';

export default function Pager({ paged, onPage, onSize, noun = 'items' }: {
  paged: Paged<unknown>;
  onPage: (page: number) => void;
  onSize: (size: number) => void;
  noun?: string;
}) {
  const { page, pages, size } = paged;
  const first = page <= 1, last = page >= pages;
  return (
    <nav data-testid="pager" aria-label="Pages"
      className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 border-t border-gray-800 text-xs">
      <div className="flex items-center gap-3">
        <span data-testid="pager-range" className="text-gray-400 tabular-nums">{rangeLabel(paged)}</span>
        <label className="flex items-center gap-1.5 text-gray-400">
          Per page
          <select data-testid="pager-size" aria-label={`${noun} a page`} value={size} onChange={e => onSize(Number(e.target.value))}
            className="bg-gray-900 border border-gray-700 rounded-md px-1.5 py-1 text-white text-xs">
            {PAGE_SIZES.map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
      </div>
      {pages > 1 && (
        <div className="flex flex-wrap items-center gap-1">
          <button type="button" data-testid="pager-first" className={`${BTN} ${IDLE}`} disabled={first} onClick={() => onPage(1)}>First</button>
          <button type="button" data-testid="pager-prev" className={`${BTN} ${IDLE}`} disabled={first} onClick={() => onPage(page - 1)}>Prev</button>
          {pageWindow(page, pages).map((slot, i) => slot === 'gap'
            ? <span key={`gap-${i}`} className="px-1 text-gray-500" aria-hidden>…</span>
            : (
              <button key={slot} type="button" data-testid="pager-page" aria-current={slot === page ? 'page' : undefined}
                onClick={() => onPage(slot)}
                className={`${BTN} tabular-nums ${slot === page ? 'bg-action-500/10 text-action-400 font-semibold' : IDLE}`}>
                {slot}
              </button>
            ))}
          <button type="button" data-testid="pager-next" className={`${BTN} ${IDLE}`} disabled={last} onClick={() => onPage(page + 1)}>Next</button>
          <button type="button" data-testid="pager-last" className={`${BTN} ${IDLE}`} disabled={last} onClick={() => onPage(pages)}>Last</button>
        </div>
      )}
    </nav>
  );
}
