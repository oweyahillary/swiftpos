/**
 * CategoryPanel — A537: the POS's categories in a collapsible left panel, with the business's menus as tabs on top; and
 * the pieces around it on the sale screen (the ☰ toggle, the "Burgers ✕" chip, A566's menu bar, A580's Later button).
 * Used by the web POS (apps/dashboard/src/pages/pos/cashier/CategoryPanel.tsx) and the desktop POS
 * (apps/desktop/src/renderer/components/CategoryPanel.tsx).
 *
 * Owner, 2026-10-20: "the menu categories at the top, can we add them to the left like a hamburger, which can collapse,
 * and it should start collapsed by default? … some restaurants have different menus — food menu, non-alcoholic drinks
 * menu, alcoholic drinks menu, tea menu etc, can we include such?" What the panel lists and which products a menu shows
 * is @zaptill/core/menuFilter.
 *
 *   ☰ at the left of the search opens it; it starts COLLAPSED. Picking a category closes it (unless pinned) and the
 *   chosen category shows by the search as "Burgers ✕". The pin keeps it open (and pushes the grid aside; on a narrow
 *   screen it lies over the grid). The chosen menu is remembered on this device (localStorage, every access in
 *   try/catch). A554: the pin is this session's only — the panel starts collapsed at every start and sign-in.
 *   Touch first: big tap targets, nothing on hover only.
 *
 *   A566 (owner, 2026-10-22: "if a client has larger categories eg drinks, fast foods etc they should appear the way
 *   categories used to appear so that cashiers can easily pick the menu"): with menus, MenuBar puts them across the top
 *   of the grid as big tabs (as the categories were before A537) and the panel lists only the chosen menu's categories
 *   (`menuBar` — its own tabs drop out). No menus: no bar, the panel alone as before.
 *
 * Shared components batch G (docs/SHARED-COMPONENTS-PLAN.md section 8g): one structure and one behaviour for both POS.
 * Each app keeps its own look — how every element is painted — in its own CategoryPanel.tsx: the desktop's Tailwind
 * class names (where its Tailwind build finds them; this file holds none, so neither stylesheet changes), the web's
 * inline styles on its theme tokens (--act-strong, --pos-*). A look entry that depends on the state (a tab chosen, a
 * menu greyed, the pin on) is a function of it.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement, type ReactNode } from 'react';
import {
  ALL_CATEGORIES, ALL_MENUS, PANEL_PREFS_KEY, categoryGroups, menuBarEdges, menuBarLabel, menuTabs, parsePanelPrefs,
  panelPrefsText, panelStartsOpen, panelOpenAfterPick, productCounts, resolveMenu,
  type CategoryLike, type MenuLike, type MenuTab, type PanelPrefs, type ProductLike,
} from '@zaptill/core/menuFilter';

function readPrefs(): PanelPrefs {
  try { return parsePanelPrefs(window.localStorage.getItem(PANEL_PREFS_KEY)); } catch { return parsePanelPrefs(null); }
}
function writePrefs(p: PanelPrefs): void {
  try { window.localStorage.setItem(PANEL_PREFS_KEY, panelPrefsText(p)); } catch { /* not remembered — still applied */ }
}

/** The panel's state: open (collapsed at every start — A554), the pin (this session) and the chosen menu (remembered). */
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

/** How one element is painted: class names (a string — the desktop), or an inline style and / or class names (the web's
 *  styles; the desktop's colour dot, whose colour is the category's). */
export type Paint = string | { className?: string; style?: CSSProperties };

/** A Paint as the element's props. */
function painted(paint: Paint): { className?: string; style?: CSSProperties } {
  return typeof paint === 'string' ? { className: paint } : paint;
}

/** One of this file's pieces with an app's look: what the app's own CategoryPanel.tsx exports in its place, so the
 *  screens that use it pass no look. */
export function withLook<P>(Piece: (props: P & { look: CategoryPanelLook }) => ReactElement | null, look: CategoryPanelLook): (props: P) => ReactElement | null {
  // Called as a function, not drawn as an element: the app's export IS the piece (the same tree as before the move).
  return (props) => Piece({ ...props, look });
}

/** How one app paints the panel and its pieces, element by element. */
export interface CategoryPanelLook {
  /** ☰ */
  toggle: (open: boolean) => Paint;
  /** "Burgers ✕": the chip, its text, its ✕. */
  chip: Paint;
  chipText: Paint;
  chipClear: Paint;
  /** The menu bar: the whole bar, the scrolling part (holds the arrows), the row of tabs, a tab, its icon, its hint
   *  ("until 11:00"), the ‹ › arrows, and the part at the row's end (Later, the manager's Show all). */
  bar: Paint;
  barScroller: Paint;
  barRow: Paint;
  barTab: (on: boolean, later: boolean) => Paint;
  barTabIcon: Paint;
  barHint: (on: boolean, later: boolean) => Paint;
  barArrow: (side: 'left' | 'right') => Paint;
  barTrailing: Paint;
  /** A580's Later button and its 🕒. */
  later: (on: boolean) => Paint;
  laterIcon: Paint;
  /** The panel: itself (over the grid or beside it), its header (title, pin, close), its own menu tabs, the list. */
  panel: (overlay: boolean) => Paint;
  header: Paint;
  title: Paint;
  pin: (pinned: boolean) => Paint;
  close: Paint;
  tabs: Paint;
  tab: (on: boolean) => Paint;
  tabIcon: Paint;
  list: Paint;
  /** A category row ("All" too), its label, a menu's heading in the list, the colour dot, the name, the count. */
  row: (on: boolean) => Paint;
  rowLabel: Paint;
  heading: Paint;
  dot: (colour: string | null | undefined) => Paint;
  name: Paint;
  count: (on: boolean) => Paint;
  /** Behind a panel that lies over the grid: a tap closes it. */
  backdrop: Paint;
}

export interface PanelToggleProps { panel: CategoryPanelState }

/** The ☰ button at the left of the search. */
export function PanelToggle({ panel, look }: PanelToggleProps & { look: CategoryPanelLook }) {
  return (
    <button type="button" data-testid="category-panel-toggle" aria-label={panel.open ? 'Close the categories' : 'Open the categories'}
      aria-expanded={panel.open} onClick={() => panel.setOpen(!panel.open)} {...painted(look.toggle(panel.open))}>☰</button>
  );
}

export interface CategoryChipProps { label: string | null; onClear: () => void }

/** "Burgers ✕" by the search — the chosen category (or menu), one tap back to everything. */
export function CategoryChip({ label, onClear, look }: CategoryChipProps & { look: CategoryPanelLook }) {
  if (!label) return null;
  return (
    <button type="button" data-testid="category-chip" onClick={onClear} aria-label={`Show every category (now ${label})`} {...painted(look.chip)}>
      <span {...painted(look.chipText)}>{label}</span><span aria-hidden {...painted(look.chipClear)}>✕</span>
    </button>
  );
}

export interface MenuBarProps {
  tabs: MenuTab[];
  active: string;
  onPick: (id: string) => void;
  /** A573: the business's word for the menus — "Menus", "Departments", "Groups" (@zaptill/core/businessTerms). */
  label?: string;
  /** A578: a tab's small "until 11:00" (a menu with hours). */
  hints?: Record<string, string>;
  /** A578: the manager's "Show all" at the row's end (shown even when every menu is asleep, so it can bring them back). */
  trailing?: ReactNode;
  /** A580: the closed menus "Later" shows: greyed and dashed, still tappable (to LOOK at their items, nothing sold). */
  greyed?: ReadonlySet<string>;
}

/**
 * A566: the menus across the top of the grid — "All", "Food", "Drinks" … — big tabs as the categories were before A537.
 * Many menus: the row scrolls sideways (a swipe, the wheel, or the ‹ › arrows that show, with a fade, on the side that
 * hides more); the chosen tab is kept in view. Nothing when the business has no menus.
 */
export function MenuBar({ tabs, active, onPick, label = 'Menus', hints, trailing, greyed, look }: MenuBarProps & { look: CategoryPanelLook }) {
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
  const word = label.toLowerCase();
  const nudge = (dir: 1 | -1) => {
    const el = rowRef.current;
    if (el) el.scrollBy({ left: dir * Math.max(160, el.clientWidth * 0.6), behavior: 'smooth' });
  };
  return (
    <div data-testid="menu-bar" {...painted(look.bar)}>
      <div {...painted(look.barScroller)}>
        <div ref={rowRef} role="tablist" aria-label={label} onScroll={measure} {...painted(look.barRow)}>
          {tabs.map((t) => {
            const on = t.id === shown;
            const later = !!greyed?.has(t.id);   // A580: a closed menu shown by "Later" — greyed, dashed
            return (
              <button key={t.id} type="button" role="tab" aria-selected={on} data-testid={later ? 'menu-bar-tab-later' : 'menu-bar-tab'} onClick={() => onPick(t.id)}
                data-later={later ? 'true' : undefined} {...painted(look.barTab(on, later))}>
                {t.icon && <span aria-hidden {...painted(look.barTabIcon)}>{t.icon}</span>}{menuBarLabel(t)}
                {hints?.[t.id] && <span data-testid="menu-bar-hint" {...painted(look.barHint(on, later))}>{hints[t.id]}</span>}
              </button>
            );
          })}
        </div>
        {edges.left && <button type="button" data-testid="menu-bar-left" aria-label={`More ${word} to the left`} onClick={() => nudge(-1)} {...painted(look.barArrow('left'))}>‹</button>}
        {edges.right && <button type="button" data-testid="menu-bar-right" aria-label={`More ${word} to the right`} onClick={() => nudge(1)} {...painted(look.barArrow('right'))}>›</button>}
      </div>
      {trailing && <div {...painted(look.barTrailing)}>{trailing}</div>}
    </div>
  );
}

export interface LaterButtonProps { on: boolean; onToggle: () => void; label?: string }

/**
 * A580 (owner, 2026-10-23: "add a 'Later' button to the menu list to show closed menus in greyed-out form"): at the end of
 * the menu bar, for EVERY staff member, only while a menu is closed now. Tap: the closed menus join the bar greyed with
 * when they open; tap again: hidden. View only — nothing in them is sold (A578's refusal). Session only, never stored.
 * Not the manager's "Show all" (menu.edit, "sell"), which lets them be sold.
 */
export function LaterButton({ on, onToggle, label = 'Menus', look }: LaterButtonProps & { look: CategoryPanelLook }) {
  return (
    <button type="button" data-testid="menu-later" aria-pressed={on} onClick={onToggle}
      title={on ? `Hide the closed ${label.toLowerCase()}` : `See the ${label.toLowerCase()} that open later (view only)`}
      {...painted(look.later(on))}>
      <span aria-hidden {...painted(look.laterIcon)}>🕒</span>{on ? 'Later ✕' : 'Later'}
    </button>
  );
}

/** A category as the panel shows it. */
export interface PanelCategory extends CategoryLike { name: string; color?: string | null; icon?: string | null }

export interface CategoryPanelProps {
  panel: CategoryPanelState;
  categories: readonly PanelCategory[];
  menus: readonly MenuLike[];
  products: readonly (ProductLike & { status?: string | null })[];
  activeMenu: string;
  activeCategory: string;
  onMenu: (id: string) => void;
  onCategory: (id: string) => void;
  /** Lies over the grid (a narrow screen) instead of pushing it aside. */
  overlay: boolean;
  /** A566: the menus are across the top of the grid (MenuBar) — the panel lists the chosen menu's categories, no tabs of its own. */
  menuBar?: boolean;
  /** A573: the business's words — "Menus" / "All menus", "Departments" / "All departments", "Groups" / "All groups". */
  menusLabel?: string;
  allMenusLabel?: string;
}

export default function CategoryPanel({ panel, categories, menus, products, activeMenu, activeCategory, onMenu, onCategory, overlay, menuBar = false,
  menusLabel = 'Menus', allMenusLabel = 'All menus', look }: CategoryPanelProps & { look: CategoryPanelLook }) {
  const tabs = useMemo(() => menuTabs(menus, categories), [menus, categories]);
  const groups = useMemo(() => categoryGroups(categories, menus, activeMenu), [categories, menus, activeMenu]);
  const counts = useMemo(() => productCounts(products.filter((p) => p.status === 'active')), [products]);
  if (!panel.open) return null;

  const pick = (id: string) => { onCategory(id); panel.picked(); };
  const shownMenu = tabs.some((t) => t.id === activeMenu) ? activeMenu : ALL_MENUS;

  const body = (
    <aside data-testid="category-panel" aria-label="Categories" {...painted(look.panel(overlay))}>
      <div {...painted(look.header)}>
        <span {...painted(look.title)}>Categories</span>
        <button type="button" data-testid="category-panel-pin" aria-pressed={panel.prefs.pinned}
          onClick={() => panel.setPinned(!panel.prefs.pinned)}
          title={panel.prefs.pinned ? 'Pinned — stays open' : 'Pin — keep it open'}
          {...painted(look.pin(panel.prefs.pinned))}>📌</button>
        <button type="button" data-testid="category-panel-close" aria-label="Close the categories" onClick={() => panel.setOpen(false)}
          {...painted(look.close)}>✕</button>
      </div>

      {tabs.length > 0 && !menuBar && (
        <div data-testid="menu-tabs" role="tablist" aria-label={menusLabel} {...painted(look.tabs)}>
          {tabs.map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={t.id === shownMenu} onClick={() => onMenu(t.id)} {...painted(look.tab(t.id === shownMenu))}>
              {t.icon && <span {...painted(look.tabIcon)}>{t.icon}</span>}{t.id === ALL_MENUS ? allMenusLabel : t.name}
            </button>
          ))}
        </div>
      )}

      <div {...painted(look.list)}>
        <button type="button" data-testid="category-all" onClick={() => pick(ALL_CATEGORIES)} {...painted(look.row(activeCategory === ALL_CATEGORIES))}>
          <span {...painted(look.rowLabel)}>{shownMenu !== ALL_MENUS ? `All ${tabs.find((t) => t.id === shownMenu)?.name ?? ''}` : 'All'}</span>
        </button>
        {groups.map((g) => (
          <div key={g.menu?.id ?? 'plain'}>
            {g.menu && groups.length > 1 && <div {...painted(look.heading)}>{g.menu.name}</div>}
            {g.categories.map((c) => (
              <button key={c.id} type="button" data-testid="category-row" onClick={() => pick(c.id)} {...painted(look.row(activeCategory === c.id))}>
                <span aria-hidden {...painted(look.dot(c.color))} />
                {c.icon && <span aria-hidden>{c.icon}</span>}
                <span {...painted(look.name)}>{c.name}</span>
                {(counts.get(c.id) ?? 0) > 0 && <span {...painted(look.count(activeCategory === c.id))}>{counts.get(c.id)}</span>}
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
      {!panel.prefs.pinned && <div aria-hidden onClick={() => panel.setOpen(false)} {...painted(look.backdrop)} />}
      {body}
    </>
  );
}
