/**
 * CategoryPanel — A537: the POS's categories in a collapsible left panel, with the business's menus as tabs on top; the
 * ☰ toggle, the "Burgers ✕" chip, A566's menu bar and A580's Later button.
 *
 * The panel and its pieces (what they draw, what they do, the menu remembered on this POS) are
 * @zaptill/ui/CategoryPanel — shared with the web POS (docs/SHARED-COMPONENTS-PLAN.md section 8g). This file is the
 * desktop's look: the dark styling and the `action-*` colours, as class names, kept here where this app's Tailwind build
 * finds them. Touch first: 48 px rows and menu tabs, 40+ px pin / close / panel tabs, nothing on hover only.
 * useNarrowWindow (the panel lies over the grid in a narrow window) is lib/useNarrowWindow.ts, re-exported here.
 */
import SharedCategoryPanel, {
  CategoryChip as SharedCategoryChip, LaterButton as SharedLaterButton, MenuBar as SharedMenuBar, PanelToggle as SharedPanelToggle, withLook,
  type CategoryChipProps, type CategoryPanelLook, type CategoryPanelProps, type LaterButtonProps, type MenuBarProps, type PanelToggleProps,
} from '@zaptill/ui/CategoryPanel';

export { useCategoryPanel, type CategoryPanelState } from '@zaptill/ui/CategoryPanel';
export { useNarrowWindow, NARROW_WINDOW_PX } from '../lib/useNarrowWindow';

/** The small upper-case labels: the panel's title and a menu's heading in the list. */
const LABEL = 'text-[11px] font-bold uppercase tracking-wider text-gray-400';
/** The pin and the close button. */
const HEAD_BUTTON = 'min-w-[44px] min-h-[40px] rounded-lg border';
/** A greyed (closed) menu that is chosen, and the Later button when on. */
const GREY_ON = 'bg-gray-700 border-gray-400 text-gray-100';
/** The ‹ › arrows over the menu bar's ends, fading into the background. */
const ARROW = 'absolute inset-y-0 z-10 w-14 flex items-center text-2xl font-bold text-gray-100 from-gray-950 via-gray-950/90 to-transparent';

const LOOK: CategoryPanelLook = {
  toggle: (open) => `flex-shrink-0 min-w-[44px] text-lg rounded-lg border transition-colors ${
    open ? 'bg-gray-700 border-gray-600 text-white' : 'bg-gray-800 border-gray-700 text-gray-200 hover:border-gray-600'}`,
  chip: 'flex-shrink-0 max-w-[12rem] flex items-center gap-1.5 rounded-full border border-gray-600 bg-gray-800 px-3 text-xs font-semibold text-gray-100',
  chipText: 'truncate',
  chipClear: 'text-gray-400',

  bar: 'relative flex-shrink-0 border-b border-gray-800 flex items-center',
  barScroller: 'relative flex-1 min-w-0',
  barRow: 'flex gap-2 px-4 py-2.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
  // A580: a closed menu shown by "Later" — greyed, dashed.
  barTab: (on, later) => `flex-shrink-0 min-h-[48px] min-w-[88px] px-5 rounded-xl text-base font-semibold whitespace-nowrap border transition-colors ${
    later ? `border-dashed opacity-60 grayscale ${on ? GREY_ON : 'bg-gray-900 border-gray-600 text-gray-400'}`
    : on ? 'bg-action-500 border-action-500 text-gray-950' : 'bg-gray-800 border-gray-700 text-gray-200 hover:text-white hover:border-gray-600'}`,
  barTabIcon: 'mr-1.5',
  barHint: (on, later) => `ml-2 text-xs font-medium ${on && !later ? 'text-gray-900/80' : 'text-gray-400'}`,
  barArrow: (side) => (side === 'left' ? `${ARROW} left-0 justify-start pl-2 bg-gradient-to-r` : `${ARROW} right-0 justify-end pr-2 bg-gradient-to-l`),
  barTrailing: 'flex-shrink-0 pr-3 flex items-center gap-2',

  later: (on) => `min-h-[40px] px-3 rounded-lg text-sm font-semibold whitespace-nowrap border border-dashed transition-colors ${
    on ? GREY_ON : 'bg-gray-900 border-gray-600 text-gray-300 hover:text-white'}`,
  laterIcon: 'mr-1',

  panel: (overlay) => `w-60 flex-shrink-0 flex flex-col min-h-0 bg-gray-900 border-r border-gray-800 ${
    overlay ? 'absolute inset-y-0 left-0 z-30 shadow-2xl' : ''}`,
  header: 'flex items-center gap-1.5 px-3 pt-3 pb-2',
  title: `flex-1 ${LABEL}`,
  pin: (pinned) => `${HEAD_BUTTON} text-sm transition-colors ${pinned ? 'bg-action-500 border-action-500 text-gray-950' : 'border-gray-700 text-gray-300'}`,
  close: `${HEAD_BUTTON} border-gray-700 text-gray-300 text-sm`,
  tabs: 'flex gap-1.5 px-3 pb-2 overflow-x-auto flex-shrink-0',
  tab: (on) => `flex-shrink-0 min-h-[40px] px-3 rounded-full text-xs font-semibold whitespace-nowrap border transition-colors ${
    on ? 'bg-action-500 border-transparent text-gray-950' : 'bg-gray-800 border-gray-700 text-gray-300'}`,
  tabIcon: 'mr-1',
  list: 'flex-1 overflow-y-auto px-2 pb-3',
  row: (on) => `w-full min-h-[48px] flex items-center gap-2.5 px-3 rounded-lg text-left text-sm transition-colors ${
    on ? 'bg-action-500 text-gray-950 font-semibold' : 'text-gray-200 hover:bg-gray-800'}`,
  rowLabel: 'flex-1',
  heading: `px-3 pt-3 pb-1 ${LABEL}`,
  // The category's own colour (grey when it has none) — the one inline style.
  dot: (colour) => ({ className: 'w-2.5 h-2.5 rounded-full flex-shrink-0', style: { backgroundColor: colour ?? '#4b5563' } }),
  name: 'flex-1 truncate',
  count: (on) => `text-[11px] ${on ? 'text-gray-900' : 'text-gray-400'}`,
  backdrop: 'absolute inset-0 z-20 bg-black/40',
};

/** The ☰ button at the left of the search. */
export const PanelToggle = withLook<PanelToggleProps>(SharedPanelToggle, LOOK);

/** "Burgers ✕" by the search — the chosen category (or menu), one tap back to everything. */
export const CategoryChip = withLook<CategoryChipProps>(SharedCategoryChip, LOOK);

/** A566: the menus across the top of the grid. A573: `label` is the business's word for them (@zaptill/core/businessTerms). */
export const MenuBar = withLook<MenuBarProps>(SharedMenuBar, LOOK);

/** A580: "Later" at the end of the menu bar — the closed menus, greyed, view only. Not the manager's amber "Show all". */
export const LaterButton = withLook<LaterButtonProps>(SharedLaterButton, LOOK);

export default withLook<CategoryPanelProps>(SharedCategoryPanel, LOOK);
