/**
 * CategoryPanel — A537: the till's categories in a collapsible left panel, with the business's menus as tabs on top.
 *
 * Owner, 2026-10-20: "the menu categories at the top, can we add them to the left like a hamburger, which can collapse,
 * and it should start collapsed by default? … some restaurants have different menus — food menu, non-alcoholic drinks
 * menu, alcoholic drinks menu, tea menu etc, can we include such?" Both POSes (the web POS's is
 * apps/dashboard/src/pages/pos/cashier/CategoryPanel.tsx); what the panel lists and which products a menu shows is ONE
 * pure helper both use (src/shared/menuFilter.ts, a copy of shared/menuFilter.ts).
 *
 *   ☰ at the left of the search opens it; it starts COLLAPSED. Picking a category closes it (unless pinned) and the
 *   chosen category shows by the search as "Burgers ✕". The pin keeps it open and pushes the grid aside (on a narrow
 *   window it lies over the grid). The chosen menu is remembered on THIS till (its own renderer store, localStorage —
 *   as Pager and the printer settings; every access in try/catch). A554: the pin is this session's only — the panel
 *   starts collapsed at every launch and sign-in, pinned or not. Touch first: 48 px rows, nothing on hover only. The till's dark styling and its `action-*` colours.
 *
 *   A566 (owner, 2026-10-22: "if a client has larger categories eg drinks, fast foods etc they should appear the way
 *   categories used to appear so that cashiers can easily pick the menu"): with menus, MenuBar puts them across the top
 *   of the grid as big tabs (as the categories were before A537) and the panel lists only the chosen menu's categories
 *   (`menuBar` — its own tabs drop out). No menus: no bar, the panel alone as before.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ALL_CATEGORIES, ALL_MENUS, PANEL_PREFS_KEY, categoryGroups, menuBarEdges, menuBarLabel, menuTabs, parsePanelPrefs,
  panelPrefsText, panelStartsOpen, panelOpenAfterPick, productCounts, resolveMenu, type MenuTab, type PanelPrefs,
} from '@zaptill/core/menuFilter';

function readPrefs(): PanelPrefs {
  try { return parsePanelPrefs(window.localStorage.getItem(PANEL_PREFS_KEY)); } catch { return parsePanelPrefs(null); }
}
function writePrefs(p: PanelPrefs): void {
  try { window.localStorage.setItem(PANEL_PREFS_KEY, panelPrefsText(p)); } catch { /* not remembered — still applied */ }
}

/** The panel's state: open (collapsed at every start — A554), the pin (this session) and the chosen menu (remembered on this till). */
export function useCategoryPanel() {
  const [prefs, setPrefs] = useState<PanelPrefs>(() => readPrefs());
  const [open, setOpen] = useState<boolean>(() => panelStartsOpen());   // A554: collapsed at every start and sign-in
  const save = useCallback((next: PanelPrefs) => { setPrefs(next); writePrefs(next); }, []);
  const setPinned = useCallback((pinned: boolean) => { save({ ...prefs, pinned }); if (pinned) setOpen(true); }, [prefs, save]);
  const setMenu = useCallback((menu: string) => save({ ...prefs, menu }), [prefs, save]);
  /** After a category is picked: an unpinned panel closes. */
  const picked = useCallback(() => setOpen(panelOpenAfterPick(prefs)), [prefs]);
  return { prefs, open, setOpen, setPinned, setMenu, picked };
}
export type CategoryPanelState = ReturnType<typeof useCategoryPanel>;

/** A till window too narrow to give the panel its own column beside the grid and the cart (the panel then lies over). */
export const NARROW_WINDOW_PX = 1100;
export function useNarrowWindow(): boolean {
  const read = () => { try { return window.innerWidth < NARROW_WINDOW_PX; } catch { return false; } };
  const [narrow, setNarrow] = useState<boolean>(read);
  useEffect(() => {
    const on = () => setNarrow(read());
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return narrow;
}

/** The ☰ button at the left of the search. */
export function PanelToggle({ panel }: { panel: CategoryPanelState }) {
  return (
    <button type="button" data-testid="category-panel-toggle" onClick={() => panel.setOpen(!panel.open)}
      aria-label={panel.open ? 'Close the categories' : 'Open the categories'} aria-expanded={panel.open}
      className={`flex-shrink-0 min-w-[44px] text-lg rounded-lg border transition-colors ${
        panel.open ? 'bg-gray-700 border-gray-600 text-white' : 'bg-gray-800 border-gray-700 text-gray-200 hover:border-gray-600'}`}>
      ☰
    </button>
  );
}

/** "Burgers ✕" by the search — the chosen category (or menu), one tap back to everything. */
export function CategoryChip({ label, onClear }: { label: string | null; onClear: () => void }) {
  if (!label) return null;
  return (
    <button type="button" data-testid="category-chip" onClick={onClear} aria-label={`Show every category (now ${label})`}
      className="flex-shrink-0 max-w-[12rem] flex items-center gap-1.5 rounded-full border border-gray-600 bg-gray-800 px-3 text-xs font-semibold text-gray-100">
      <span className="truncate">{label}</span><span aria-hidden className="text-gray-400">✕</span>
    </button>
  );
}

/**
 * A566: the menus across the top of the grid — "All", "Food", "Drinks" … — big tabs (48 px) as the categories were before
 * A537. Many menus: the row scrolls sideways (a swipe, the wheel, or the ‹ › arrows that show, with a fade, on the side
 * that hides more); the chosen tab is kept in view. Nothing when the business has no menus.
 */
// A573: `label` is the business's word for the menus — "Menus", "Departments", "Groups" (src/shared/businessTerms.ts).
/** A578: `hints` — a tab's small "until 11:00" (a menu with hours); `trailing` — the manager's "Show all" at the row's end
 *  (shown even when every menu is asleep, so it can bring them back). */
/** A580: `greyed` — the closed menus "Later" shows: greyed and dashed, still tappable (to LOOK at their items, nothing sold). */
export function MenuBar({ tabs, active, onPick, label = 'Menus', hints, trailing, greyed }: { tabs: MenuTab[]; active: string; onPick: (id: string) => void; label?: string; hints?: Record<string, string>; trailing?: ReactNode; greyed?: ReadonlySet<string> }) {
  const rowRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const measure = useCallback(() => {
    const el = rowRef.current;
    if (!el) return;
    const next = menuBarEdges(el.scrollLeft, el.scrollWidth, el.clientWidth);
    setEdges((cur) => (cur.left === next.left && cur.right === next.right ? cur : next));
  }, []);
  useEffect(() => {
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [measure, tabs]);
  const shown = resolveMenu(active, tabs);
  useEffect(() => {   // the chosen menu stays in view (a remembered one far along the row)
    try { (rowRef.current?.querySelector('[aria-selected="true"]') as HTMLElement | null)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }); } catch { /* fine */ }
  }, [shown]);
  if (tabs.length === 0 && !trailing) return null;
  const nudge = (dir: 1 | -1) => {
    const el = rowRef.current;
    if (el) el.scrollBy({ left: dir * Math.max(160, el.clientWidth * 0.6), behavior: 'smooth' });
  };
  const arrow = 'absolute inset-y-0 z-10 w-14 flex items-center text-2xl font-bold text-gray-100 from-gray-950 via-gray-950/90 to-transparent';
  return (
    <div data-testid="menu-bar" className="relative flex-shrink-0 border-b border-gray-800 flex items-center">
      <div className="relative flex-1 min-w-0">
      <div ref={rowRef} role="tablist" aria-label={label} onScroll={measure}
        className="flex gap-2 px-4 py-2.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {tabs.map((t) => {
          const on = t.id === shown;
          const later = !!greyed?.has(t.id);   // A580: a closed menu shown by "Later"
          return (
            <button key={t.id} type="button" role="tab" aria-selected={on} data-testid={later ? 'menu-bar-tab-later' : 'menu-bar-tab'} onClick={() => onPick(t.id)}
              data-later={later ? 'true' : undefined}
              className={`flex-shrink-0 min-h-[48px] min-w-[88px] px-5 rounded-xl text-base font-semibold whitespace-nowrap border transition-colors ${
                later ? `border-dashed opacity-60 grayscale ${on ? 'bg-gray-700 border-gray-400 text-gray-100' : 'bg-gray-900 border-gray-600 text-gray-400'}`
                : on ? 'bg-action-500 border-action-500 text-gray-950' : 'bg-gray-800 border-gray-700 text-gray-200 hover:text-white hover:border-gray-600'}`}>
              {t.icon && <span aria-hidden className="mr-1.5">{t.icon}</span>}{menuBarLabel(t)}
              {hints?.[t.id] && <span data-testid="menu-bar-hint" className={`ml-2 text-xs font-medium ${on && !later ? 'text-gray-900/80' : 'text-gray-400'}`}>{hints[t.id]}</span>}
            </button>
          );
        })}
      </div>
      {edges.left && (
        <button type="button" data-testid="menu-bar-left" aria-label={`More ${label.toLowerCase()} to the left`} onClick={() => nudge(-1)}
          className={`${arrow} left-0 justify-start pl-2 bg-gradient-to-r`}>‹</button>
      )}
      {edges.right && (
        <button type="button" data-testid="menu-bar-right" aria-label={`More ${label.toLowerCase()} to the right`} onClick={() => nudge(1)}
          className={`${arrow} right-0 justify-end pr-2 bg-gradient-to-l`}>›</button>
      )}
      </div>
      {trailing && <div className="flex-shrink-0 pr-3 flex items-center gap-2">{trailing}</div>}
    </div>
  );
}

/**
 * A580 (owner, 2026-10-23: "add a 'Later' button to the menu list to show closed menus in greyed-out form"): at the end of
 * the menu bar, for EVERY staff member, only while a menu is closed now. Tap: the closed menus join the bar greyed with
 * when they open; tap again: hidden. View only — nothing in them is sold (A578's refusal). Session only, never stored.
 * Not the manager's "Show all" (menu.edit, amber, "sell"), which lets them be sold.
 */
export function LaterButton({ on, onToggle, label = 'Menus' }: { on: boolean; onToggle: () => void; label?: string }) {
  return (
    <button type="button" data-testid="menu-later" aria-pressed={on} onClick={onToggle}
      title={on ? `Hide the closed ${label.toLowerCase()}` : `See the ${label.toLowerCase()} that open later (view only)`}
      className={`min-h-[40px] px-3 rounded-lg text-sm font-semibold whitespace-nowrap border border-dashed transition-colors ${on
        ? 'bg-gray-700 border-gray-400 text-gray-100' : 'bg-gray-900 border-gray-600 text-gray-300 hover:text-white'}`}>
      <span aria-hidden className="mr-1">🕒</span>{on ? 'Later ✕' : 'Later'}
    </button>
  );
}

interface Props {
  panel: CategoryPanelState;
  categories: any[];
  menus: any[];
  products: any[];
  activeMenu: string;
  activeCategory: string;
  onMenu: (id: string) => void;
  onCategory: (id: string) => void;
  /** Lies over the grid (a narrow window) instead of pushing it aside. */
  overlay: boolean;
  /** A566: the menus are across the top of the grid (MenuBar) — the panel lists the chosen menu's categories, no tabs of its own. */
  menuBar?: boolean;
  /** A573: the business's words — "Menus" / "All menus", "Departments" / "All departments", "Groups" / "All groups". */
  menusLabel?: string;
  allMenusLabel?: string;
}

export default function CategoryPanel({ panel, categories, menus, products, activeMenu, activeCategory, onMenu, onCategory, overlay, menuBar = false,
  menusLabel = 'Menus', allMenusLabel = 'All menus' }: Props) {
  const tabs = useMemo(() => menuTabs(menus, categories), [menus, categories]);
  const groups = useMemo(() => categoryGroups(categories, menus, activeMenu), [categories, menus, activeMenu]);
  const counts = useMemo(() => productCounts(products.filter((p: any) => p.status === 'active')), [products]);
  if (!panel.open) return null;

  const pick = (id: string) => { onCategory(id); panel.picked(); };
  const shownMenu = tabs.some((t) => t.id === activeMenu) ? activeMenu : ALL_MENUS;
  const rowClass = (on: boolean) => `w-full min-h-[48px] flex items-center gap-2.5 px-3 rounded-lg text-left text-sm transition-colors ${
    on ? 'bg-action-500 text-gray-950 font-semibold' : 'text-gray-200 hover:bg-gray-800'}`;

  const body = (
    <aside data-testid="category-panel" aria-label="Categories"
      className={`w-60 flex-shrink-0 flex flex-col min-h-0 bg-gray-900 border-r border-gray-800 ${
        overlay ? 'absolute inset-y-0 left-0 z-30 shadow-2xl' : ''}`}>
      <div className="flex items-center gap-1.5 px-3 pt-3 pb-2">
        <span className="flex-1 text-[11px] font-bold uppercase tracking-wider text-gray-400">Categories</span>
        <button type="button" data-testid="category-panel-pin" aria-pressed={panel.prefs.pinned}
          onClick={() => panel.setPinned(!panel.prefs.pinned)}
          title={panel.prefs.pinned ? 'Pinned — stays open' : 'Pin — keep it open'}
          className={`min-w-[44px] min-h-[40px] rounded-lg border text-sm transition-colors ${
            panel.prefs.pinned ? 'bg-action-500 border-action-500 text-gray-950' : 'border-gray-700 text-gray-300'}`}>📌</button>
        <button type="button" data-testid="category-panel-close" aria-label="Close the categories" onClick={() => panel.setOpen(false)}
          className="min-w-[44px] min-h-[40px] rounded-lg border border-gray-700 text-gray-300 text-sm">✕</button>
      </div>

      {tabs.length > 0 && !menuBar && (
        <div data-testid="menu-tabs" role="tablist" aria-label={menusLabel} className="flex gap-1.5 px-3 pb-2 overflow-x-auto flex-shrink-0">
          {tabs.map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={t.id === shownMenu} onClick={() => onMenu(t.id)}
              className={`flex-shrink-0 min-h-[40px] px-3 rounded-full text-xs font-semibold whitespace-nowrap border transition-colors ${
                t.id === shownMenu ? 'bg-action-500 border-transparent text-gray-950' : 'bg-gray-800 border-gray-700 text-gray-300'}`}>
              {t.icon && <span className="mr-1">{t.icon}</span>}{t.id === ALL_MENUS ? allMenusLabel : t.name}
            </button>
          ))}
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-2 pb-3">
        <button type="button" data-testid="category-all" onClick={() => pick(ALL_CATEGORIES)} className={rowClass(activeCategory === ALL_CATEGORIES)}>
          <span className="flex-1">{shownMenu !== ALL_MENUS ? `All ${tabs.find((t) => t.id === shownMenu)?.name ?? ''}` : 'All'}</span>
        </button>
        {groups.map((g) => (
          <div key={g.menu?.id ?? 'plain'}>
            {g.menu && groups.length > 1 && (
              <div className="px-3 pt-3 pb-1 text-[11px] font-bold uppercase tracking-wider text-gray-400">{g.menu.name}</div>
            )}
            {g.categories.map((c: any) => (
              <button key={c.id} type="button" data-testid="category-row" onClick={() => pick(c.id)} className={rowClass(activeCategory === c.id)}>
                <span aria-hidden className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: c.color ?? '#4b5563' }} />
                {c.icon && <span aria-hidden>{c.icon}</span>}
                <span className="flex-1 truncate">{c.name}</span>
                {(counts.get(c.id) ?? 0) > 0 && (
                  <span className={`text-[11px] ${activeCategory === c.id ? 'text-gray-900' : 'text-gray-400'}`}>{counts.get(c.id)}</span>
                )}
              </button>
            ))}
          </div>
        ))}
      </div>
    </aside>
  );

  if (!overlay) return body;
  return (
    <>
      {/* A tap outside closes an unpinned panel that lies over the grid. */}
      {!panel.prefs.pinned && <div aria-hidden onClick={() => panel.setOpen(false)} className="absolute inset-0 z-20 bg-black/40" />}
      {body}
    </>
  );
}
