/**
 * Pager — A472 / A475: a list in pages, on the web (the dashboard's lists, the web POS's stock) and on the desktop POS
 * (Menu, the manager's lists).
 *
 * Owner, 2026-10-14: "can we paginate the menu". "Showing 51–100 of 1,234", a page-size choice (25 / 50 / 100, kept per
 * screen), First / Prev / 1 … 4 5 6 … 25 / Next / Last. The maths is @zaptill/core/paginate.
 *
 * Shared components batch F (docs/SHARED-COMPONENTS-PLAN.md section 8e): one pager and one usePageSize for both apps.
 * Each app keeps its own look — the class names, in its own components/Pager.tsx, where its Tailwind build finds them
 * (this file holds no class names, so neither app's stylesheet changes). The look's optional parts are the web's phone
 * layout: given, the node is drawn (the short range, "Per page" in its own span, the numbered pages in their own span);
 * left out, it is not (the desktop's pager, as before).
 *
 * Usage (through the app's own components/Pager.tsx, which passes its look):
 *   const [size, setSize] = usePageSize('swiftpos.pageSize.products');
 *   const paged = paginate(filtered, page, size);
 *   <Pager paged={paged} onPage={setPage} onSize={n => { setSize(n); setPage(1); }} />
 */
import { useCallback, useState } from 'react';
import { PAGE_SIZES, DEFAULT_PAGE_SIZE, cleanPageSize, pageWindow, rangeLabel, type Paged } from '@zaptill/core/paginate';

/** The page size for one screen, remembered on this device. Storage may be blocked (a private window): then 50. */
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

/** The class names one app draws the pager with. */
export interface PagerLook {
  nav: string;
  /** The range and the size picker. */
  sizeRow: string;
  range: string;
  /** The short range for a phone: its class and its text (@zaptill/core/paginate rangeShort, "51–100 of 1,234"); left
   *  out, it is not drawn. The text comes with the look so that an app without it (the desktop) never bundles
   *  rangeShort: the desktop POS's main chunk, which holds the page maths, stays the same size. */
  rangeShort?: { className: string; text: (paged: Paged<unknown>) => string };
  label: string;
  /** "Per page" in its own span; left out, it is plain text in the label. */
  perPage?: string;
  select: string;
  buttons: string;
  /** First / Last. */
  edge: string;
  /** Prev / Next. */
  step: string;
  /** The numbered pages in their own span; left out, they sit straight in the row. */
  pages?: string;
  gap: string;
  page: string;
  pageOn: string;
}

export interface PagerProps {
  paged: Paged<unknown>;
  onPage: (page: number) => void;
  onSize: (size: number) => void;
  /** What a page holds, for the size picker's label ("50 products a page"). */
  noun?: string;
}

export default function Pager({ paged, onPage, onSize, noun = 'items', look }: PagerProps & { look: PagerLook }) {
  const { page, pages, size } = paged;
  // Owner, 2026-10-17: the pager shows only when there is more than one page — not "Showing 1–4 of 4" under a short list.
  if (pages <= 1) return null;
  const first = page <= 1, last = page >= pages;
  const numbered = pageWindow(page, pages).map((slot, i) => slot === 'gap'
    ? <span key={`gap-${i}`} className={look.gap} aria-hidden>…</span>
    : (
      <button key={slot} type="button" data-testid="pager-page" aria-current={slot === page ? 'page' : undefined}
        onClick={() => onPage(slot)}
        className={slot === page ? look.pageOn : look.page}>
        {slot}
      </button>
    ));
  return (
    <nav data-testid="pager" aria-label="Pages" className={look.nav}>
      <div className={look.sizeRow}>
        <span data-testid="pager-range" className={look.range}>{rangeLabel(paged)}</span>
        {look.rangeShort !== undefined && <span data-testid="pager-range-short" className={look.rangeShort.className}>{look.rangeShort.text(paged)}</span>}
        <label className={look.label}>
          {look.perPage !== undefined ? <span className={look.perPage}>Per page</span> : 'Per page'}
          <select data-testid="pager-size" aria-label={`${noun} a page`} value={size} onChange={e => onSize(Number(e.target.value))}
            className={look.select}>
            {PAGE_SIZES.map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
      </div>
      {pages > 1 && (
        <div className={look.buttons}>
          <button type="button" data-testid="pager-first" className={look.edge} disabled={first} onClick={() => onPage(1)}>First</button>
          <button type="button" data-testid="pager-prev" className={look.step} disabled={first} onClick={() => onPage(page - 1)}>Prev</button>
          {look.pages !== undefined ? <span className={look.pages}>{numbered}</span> : numbered}
          <button type="button" data-testid="pager-next" className={look.step} disabled={last} onClick={() => onPage(page + 1)}>Next</button>
          <button type="button" data-testid="pager-last" className={look.edge} disabled={last} onClick={() => onPage(pages)}>Last</button>
        </div>
      )}
    </nav>
  );
}
