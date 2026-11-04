/**
 * Pager — A472: a management list in pages (the web Products page and every other list, A475).
 *
 * The pager itself and usePageSize are @zaptill/ui/Pager (shared with the desktop POS, docs/SHARED-COMPONENTS-PLAN.md
 * section 8e); this file is the web's look. On a phone it wraps, the numbered pages and First / Last go, and Prev / Next
 * with "51–100 of 1,234" stay. The class names stay here, where this app's Tailwind build finds them.
 *
 * Usage:
 *   const [size, setSize] = usePageSize('swiftpos.pageSize.products');
 *   const paged = paginate(filtered, page, size);
 *   <Pager paged={paged} onPage={setPage} onSize={n => { setSize(n); setPage(1); }} />
 */
import SharedPager, { type PagerLook, type PagerProps } from '@zaptill/ui/Pager';
import { rangeShort } from '@zaptill/core/paginate';

export { usePageSize } from '@zaptill/ui/Pager';

const BTN = 'min-w-[2.25rem] px-2.5 py-1.5 rounded-lg text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed';
const IDLE = 'bg-gray-800 text-gray-300 hover:bg-gray-700 hover:text-white';

const LOOK: PagerLook = {
  nav: 'flex flex-wrap items-center justify-between gap-2 sm:gap-3 px-4 py-3 border-t border-gray-800 text-sm',
  sizeRow: 'flex flex-wrap items-center gap-2 sm:gap-3',
  range: 'hidden sm:inline text-gray-400 tabular-nums',
  rangeShort: { className: 'sm:hidden text-gray-400 tabular-nums', text: rangeShort },
  label: 'flex items-center gap-1.5 text-gray-400',
  perPage: 'sr-only sm:not-sr-only',
  select: 'bg-gray-900 border border-gray-800 rounded-lg px-2 py-1 text-white text-sm focus:outline-none focus:border-swift',
  buttons: 'flex flex-wrap items-center gap-1',
  edge: `hidden sm:inline-block ${BTN} ${IDLE}`,
  step: `${BTN} ${IDLE}`,
  pages: 'hidden sm:flex items-center gap-1',
  gap: 'px-1 text-gray-500',
  page: `${BTN} tabular-nums ${IDLE}`,
  pageOn: `${BTN} tabular-nums bg-swift text-gray-950 font-semibold`,
};

export default function Pager(props: PagerProps) {
  return <SharedPager {...props} look={LOOK} />;
}
