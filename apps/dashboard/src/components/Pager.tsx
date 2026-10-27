/**
 * Pager — A472: a management list in pages (the web Products page).
 *
 * Owner, 2026-10-14: "can we paginate the menu". "Showing 51–100 of 1,234", a page-size choice (25 / 50 / 100, kept
 * per screen in this browser), First / Prev / 1 … 4 5 6 … 25 / Next / Last. On a phone it wraps, the numbered pages
 * and First / Last go, and Prev / Next with "51–100 of 1,234" stay. The maths is lib/paginate.ts (shared with the till).
 *
 * Usage:
 *   const [size, setSize] = usePageSize('swiftpos.pageSize.products');
 *   const paged = paginate(filtered, page, size);
 *   <Pager paged={paged} onPage={setPage} onSize={n => { setSize(n); setPage(1); }} />
 */
import { useCallback, useState } from 'react';
import { PAGE_SIZES, DEFAULT_PAGE_SIZE, cleanPageSize, pageWindow, rangeLabel, rangeShort, type Paged } from '@zaptill/core/paginate';

/** The page size for one screen, remembered in this browser. Storage may be blocked (a private window): then 50. */
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

const BTN = 'min-w-[2.25rem] px-2.5 py-1.5 rounded-lg text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed';
const IDLE = 'bg-gray-800 text-gray-300 hover:bg-gray-700 hover:text-white';

export default function Pager({ paged, onPage, onSize, noun = 'items' }: {
  paged: Paged<unknown>;
  onPage: (page: number) => void;
  onSize: (size: number) => void;
  /** What a page holds, for the size picker's label ("50 products a page"). */
  noun?: string;
}) {
  const { page, pages, size } = paged;
  // Owner, 2026-10-17: the pager shows only when there is more than one page — not "Showing 1–4 of 4" under a short list.
  if (pages <= 1) return null;
  const first = page <= 1, last = page >= pages;
  return (
    <nav data-testid="pager" aria-label="Pages"
      className="flex flex-wrap items-center justify-between gap-2 sm:gap-3 px-4 py-3 border-t border-gray-800 text-sm">
      <div className="flex flex-wrap items-center gap-2 sm:gap-3">
        <span data-testid="pager-range" className="hidden sm:inline text-gray-400 tabular-nums">{rangeLabel(paged)}</span>
        <span data-testid="pager-range-short" className="sm:hidden text-gray-400 tabular-nums">{rangeShort(paged)}</span>
        <label className="flex items-center gap-1.5 text-gray-400">
          <span className="sr-only sm:not-sr-only">Per page</span>
          <select data-testid="pager-size" aria-label={`${noun} a page`} value={size} onChange={e => onSize(Number(e.target.value))}
            className="bg-gray-900 border border-gray-800 rounded-lg px-2 py-1 text-white text-sm focus:outline-none focus:border-swift">
            {PAGE_SIZES.map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
      </div>
      {pages > 1 && (
        <div className="flex flex-wrap items-center gap-1">
          <button type="button" data-testid="pager-first" className={`hidden sm:inline-block ${BTN} ${IDLE}`} disabled={first} onClick={() => onPage(1)}>First</button>
          <button type="button" data-testid="pager-prev" className={`${BTN} ${IDLE}`} disabled={first} onClick={() => onPage(page - 1)}>Prev</button>
          <span className="hidden sm:flex items-center gap-1">
            {pageWindow(page, pages).map((slot, i) => slot === 'gap'
              ? <span key={`gap-${i}`} className="px-1 text-gray-500" aria-hidden>…</span>
              : (
                <button key={slot} type="button" data-testid="pager-page" aria-current={slot === page ? 'page' : undefined}
                  onClick={() => onPage(slot)}
                  className={`${BTN} tabular-nums ${slot === page ? 'bg-swift text-gray-950 font-semibold' : IDLE}`}>
                  {slot}
                </button>
              ))}
          </span>
          <button type="button" data-testid="pager-next" className={`${BTN} ${IDLE}`} disabled={last} onClick={() => onPage(page + 1)}>Next</button>
          <button type="button" data-testid="pager-last" className={`hidden sm:inline-block ${BTN} ${IDLE}`} disabled={last} onClick={() => onPage(pages)}>Last</button>
        </div>
      )}
    </nav>
  );
}
