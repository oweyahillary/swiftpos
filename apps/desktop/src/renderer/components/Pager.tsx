/**
 * Pager — A472: the POS's Menu screen in pages (and the manager's lists, A475).
 *
 * The pager itself and usePageSize are @zaptill/ui/Pager (shared with the web, docs/SHARED-COMPONENTS-PLAN.md section
 * 8e); this file is the desktop's look. The class names stay here, where this app's Tailwind build finds them.
 *
 * Usage:
 *   const [size, setSize] = usePageSize('swiftpos.pageSize.menu');
 *   const paged = paginate(filtered, page, size);
 *   <Pager paged={paged} onPage={setPage} onSize={n => { setSize(n); setPage(1); }} />
 */
import SharedPager, { type PagerLook, type PagerProps } from '@zaptill/ui/Pager';

export { usePageSize } from '@zaptill/ui/Pager';

const BTN = 'min-w-[2rem] px-2 py-1 rounded-md text-xs transition-colors disabled:opacity-40 disabled:cursor-not-allowed';
const IDLE = 'bg-gray-800 text-gray-300 hover:text-white';

const LOOK: PagerLook = {
  nav: 'flex flex-wrap items-center justify-between gap-2 px-3 py-2 border-t border-gray-800 text-xs',
  sizeRow: 'flex items-center gap-3',
  range: 'text-gray-400 tabular-nums',
  label: 'flex items-center gap-1.5 text-gray-400',
  select: 'bg-gray-900 border border-gray-700 rounded-md px-1.5 py-1 text-white text-xs',
  buttons: 'flex flex-wrap items-center gap-1',
  edge: `${BTN} ${IDLE}`,
  step: `${BTN} ${IDLE}`,
  gap: 'px-1 text-gray-500',
  page: `${BTN} tabular-nums ${IDLE}`,
  pageOn: `${BTN} tabular-nums bg-action-500/10 text-action-400 font-semibold`,
};

export default function Pager(props: PagerProps) {
  return <SharedPager {...props} look={LOOK} />;
}
