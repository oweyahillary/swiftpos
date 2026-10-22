/**
 * CategoryPanel — A537: the web POS's categories in a collapsible left panel, with the business's menus as tabs on top.
 *
 * Owner, 2026-10-20: "the menu categories at the top, can we add them to the left like a hamburger, which can collapse,
 * and it should start collapsed by default? … some restaurants have different menus — food menu, non-alcoholic drinks
 * menu, alcoholic drinks menu, tea menu etc, can we include such?" Both POSes (the till's is
 * apps/desktop/src/renderer/components/CategoryPanel.tsx); what the panel lists and which products a menu shows is ONE
 * pure helper both use (lib/menuFilter.ts, a copy of shared/menuFilter.ts).
 *
 *   ☰ at the left of the search opens it; it starts COLLAPSED. Picking a category closes it (unless pinned) and the
 *   chosen category shows by the search as "Burgers ✕". The pin keeps it open (and pushes the grid aside on a wide
 *   screen; on a narrow one it lies over the grid). The chosen menu is remembered in this browser (localStorage, every
 *   access in try/catch). A554: the pin is this session's only — the panel starts collapsed at every sign-in.
 *   Big tap targets, nothing on hover only (touch screens).
 *
 *   A566 (owner, 2026-10-22: "if a client has larger categories eg drinks, fast foods etc they should appear the way
 *   categories used to appear so that cashiers can easily pick the menu"): with menus, MenuBar puts them across the top
 *   of the grid as big tabs and the panel lists only the chosen menu's categories (`menuBar` — its own tabs drop out).
 *   No menus: no bar, the panel alone as before. The theme (--act-strong) and the POS's light / dark tokens (--pos-*).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { Category, Menu, Product } from '../../../types';
import {
  ALL_CATEGORIES, ALL_MENUS, PANEL_PREFS_KEY, categoryGroups, menuBarEdges, menuBarLabel, menuTabs, parsePanelPrefs,
  panelPrefsText, panelStartsOpen, panelOpenAfterPick, productCounts, resolveMenu, type MenuTab, type PanelPrefs,
} from '../../../lib/menuFilter';

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

const ACT = 'rgb(var(--act-strong, 15 118 110))';

/** The ☰ button at the left of the search. */
export function PanelToggle({ panel, style }: { panel: CategoryPanelState; style?: CSSProperties }) {
  return (
    <button type="button" data-testid="category-panel-toggle" aria-label={panel.open ? 'Close the categories' : 'Open the categories'}
      aria-expanded={panel.open} onClick={() => panel.setOpen(!panel.open)}
      style={{ flexShrink: 0, minWidth: 44, minHeight: 38, borderRadius: 8, border: '1px solid var(--pos-input-border, #334155)',
               background: panel.open ? 'var(--pos-surface, #1e293b)' : 'var(--pos-input, #0f172a)', color: 'var(--pos-text, #f1f5f9)',
               fontSize: 18, cursor: 'pointer', ...style }}>☰</button>
  );
}

/** "Burgers ✕" by the search — the chosen category (and menu), one tap back to everything. */
export function CategoryChip({ label, onClear }: { label: string | null; onClear: () => void }) {
  if (!label) return null;
  return (
    <button type="button" data-testid="category-chip" onClick={onClear} aria-label={`Show every category (now ${label})`}
      style={{ flexShrink: 0, maxWidth: 200, minHeight: 38, display: 'flex', alignItems: 'center', gap: 6, padding: '0 12px',
               borderRadius: 999, border: '1px solid var(--pos-border, #334155)', background: 'var(--pos-surface, #1e293b)',
               color: 'var(--pos-text, #f1f5f9)', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      <span aria-hidden style={{ color: 'var(--pos-text3, #94a3b8)' }}>✕</span>
    </button>
  );
}

/**
 * A566: the menus across the top of the grid — "All", "Food", "Drinks" … — big tabs (46 px) as the categories were before
 * A537. Many menus: the row scrolls sideways (a swipe, the wheel, or the ‹ › arrows that show, with a fade, on the side
 * that hides more); the chosen tab is kept in view. Nothing when the business has no menus.
 */
export function MenuBar({ tabs, active, onPick }: { tabs: MenuTab[]; active: string; onPick: (id: string) => void }) {
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
  if (tabs.length === 0) return null;
  const nudge = (dir: 1 | -1) => {
    const el = rowRef.current;
    if (el) el.scrollBy({ left: dir * Math.max(160, el.clientWidth * 0.6), behavior: 'smooth' });
  };
  const arrow = (side: 'left' | 'right'): CSSProperties => ({
    position: 'absolute', top: 0, bottom: 0, [side]: 0, zIndex: 2, width: 52, display: 'flex', alignItems: 'center',
    justifyContent: side === 'left' ? 'flex-start' : 'flex-end', padding: side === 'left' ? '0 0 0 8px' : '0 8px 0 0',
    border: 'none', cursor: 'pointer', fontSize: 24, fontWeight: 700, color: 'var(--pos-text, #f1f5f9)',
    background: `linear-gradient(to ${side === 'left' ? 'right' : 'left'}, var(--pos-bg, #0f172a) 45%, transparent)`,
  });
  return (
    <div data-testid="menu-bar" style={{ position: 'relative', flexShrink: 0, borderBottom: '1px solid var(--pos-border-l, #1e293b)' }}>
      <div ref={rowRef} role="tablist" aria-label="Menus" onScroll={measure}
        style={{ display: 'flex', gap: 8, padding: '8px 12px', overflowX: 'auto', scrollbarWidth: 'none' }}>
        {tabs.map((t) => {
          const on = t.id === shown;
          return (
            <button key={t.id} type="button" role="tab" aria-selected={on} data-testid="menu-bar-tab" onClick={() => onPick(t.id)}
              style={{ flexShrink: 0, minHeight: 46, minWidth: 84, padding: '0 18px', borderRadius: 10, cursor: 'pointer', whiteSpace: 'nowrap',
                       fontSize: 15, fontWeight: 700, border: `1px solid ${on ? ACT : 'var(--pos-border, #334155)'}`,
                       background: on ? ACT : 'var(--pos-surface, #1e293b)', color: on ? '#fff' : 'var(--pos-text, #f1f5f9)' }}>
              {t.icon && <span aria-hidden style={{ marginRight: 6 }}>{t.icon}</span>}{menuBarLabel(t)}
            </button>
          );
        })}
      </div>
      {edges.left && <button type="button" data-testid="menu-bar-left" aria-label="More menus to the left" onClick={() => nudge(-1)} style={arrow('left')}>‹</button>}
      {edges.right && <button type="button" data-testid="menu-bar-right" aria-label="More menus to the right" onClick={() => nudge(1)} style={arrow('right')}>›</button>}
    </div>
  );
}

interface Props {
  panel: CategoryPanelState;
  categories: Category[];
  menus: Menu[];
  products: Product[];
  activeMenu: string;
  activeCategory: string;
  onMenu: (id: string) => void;
  onCategory: (id: string) => void;
  /** Lies over the grid (a narrow screen) instead of pushing it aside. */
  overlay: boolean;
  /** A566: the menus are across the top of the grid (MenuBar) — the panel lists the chosen menu's categories, no tabs of its own. */
  menuBar?: boolean;
}

export default function CategoryPanel({ panel, categories, menus, products, activeMenu, activeCategory, onMenu, onCategory, overlay, menuBar = false }: Props) {
  const tabs = useMemo(() => menuTabs(menus, categories), [menus, categories]);
  const groups = useMemo(() => categoryGroups(categories, menus, activeMenu), [categories, menus, activeMenu]);
  const counts = useMemo(() => productCounts(products.filter((p) => p.status === 'active')), [products]);
  if (!panel.open) return null;

  const pick = (id: string) => { onCategory(id); panel.picked(); };
  const row = (selected: boolean): CSSProperties => ({
    width: '100%', minHeight: 44, display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderRadius: 10,
    border: '1px solid transparent', textAlign: 'left', cursor: 'pointer', fontSize: 14, fontWeight: selected ? 700 : 500,
    background: selected ? ACT : 'transparent', color: selected ? '#fff' : 'var(--pos-text, #f1f5f9)',
  });

  const body = (
    <aside data-testid="category-panel" aria-label="Categories"
      style={{ width: 248, flexShrink: 0, display: 'flex', flexDirection: 'column', minHeight: 0, background: 'var(--pos-panel, #0f172a)',
               borderRight: '1px solid var(--pos-border-l, #1e293b)',
               ...(overlay ? { position: 'absolute', top: 0, left: 0, bottom: 0, zIndex: 31, boxShadow: '8px 0 24px rgba(0,0,0,0.35)' } : {}) }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '10px 10px 6px' }}>
        <span style={{ flex: 1, fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--pos-text3, #94a3b8)' }}>
          Categories
        </span>
        <button type="button" data-testid="category-panel-pin" aria-pressed={panel.prefs.pinned}
          onClick={() => panel.setPinned(!panel.prefs.pinned)}
          title={panel.prefs.pinned ? 'Pinned — stays open' : 'Pin — keep it open'}
          style={{ minWidth: 40, minHeight: 36, borderRadius: 8, cursor: 'pointer', fontSize: 15,
                   border: `1px solid ${panel.prefs.pinned ? ACT : 'var(--pos-border, #334155)'}`,
                   background: panel.prefs.pinned ? ACT : 'transparent', color: panel.prefs.pinned ? '#fff' : 'var(--pos-text3, #94a3b8)' }}>📌</button>
        <button type="button" data-testid="category-panel-close" aria-label="Close the categories" onClick={() => panel.setOpen(false)}
          style={{ minWidth: 40, minHeight: 36, borderRadius: 8, cursor: 'pointer', fontSize: 15, border: '1px solid var(--pos-border, #334155)',
                   background: 'transparent', color: 'var(--pos-text3, #94a3b8)' }}>✕</button>
      </div>

      {tabs.length > 0 && !menuBar && (
        <div data-testid="menu-tabs" role="tablist" aria-label="Menus"
          style={{ display: 'flex', gap: 6, padding: '4px 10px 8px', overflowX: 'auto', flexShrink: 0 }}>
          {tabs.map((t) => {
            const on = t.id === (tabs.some((x) => x.id === activeMenu) ? activeMenu : ALL_MENUS);
            return (
              <button key={t.id} type="button" role="tab" aria-selected={on} onClick={() => onMenu(t.id)}
                style={{ flexShrink: 0, minHeight: 36, padding: '0 12px', borderRadius: 999, cursor: 'pointer', whiteSpace: 'nowrap',
                         fontSize: 12, fontWeight: 600, border: `1px solid ${on ? 'transparent' : 'var(--pos-border, #334155)'}`,
                         background: on ? ACT : 'var(--pos-surface, #1e293b)', color: on ? '#fff' : 'var(--pos-text3, #94a3b8)' }}>
                {t.icon && <span style={{ marginRight: 4 }}>{t.icon}</span>}{t.name}
              </button>
            );
          })}
        </div>
      )}

      <div style={{ flex: 1, overflowY: 'auto', padding: '2px 8px 12px' }}>
        <button type="button" data-testid="category-all" onClick={() => pick(ALL_CATEGORIES)} style={row(activeCategory === ALL_CATEGORIES)}>
          <span style={{ flex: 1 }}>{tabs.length > 0 && activeMenu !== ALL_MENUS && tabs.some((t) => t.id === activeMenu)
            ? `All ${tabs.find((t) => t.id === activeMenu)?.name ?? ''}` : 'All'}</span>
        </button>
        {groups.map((g) => (
          <div key={g.menu?.id ?? 'plain'}>
            {g.menu && groups.length > 1 && (
              <div style={{ padding: '12px 12px 4px', fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase',
                            color: 'var(--pos-text3, #94a3b8)' }}>{g.menu.name}</div>
            )}
            {g.categories.map((c) => (
              <button key={c.id} type="button" data-testid="category-row" onClick={() => pick(c.id)} style={row(activeCategory === c.id)}>
                <span aria-hidden style={{ width: 10, height: 10, borderRadius: 999, flexShrink: 0, background: c.color ?? 'var(--pos-border, #334155)' }} />
                {c.icon && <span aria-hidden>{c.icon}</span>}
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
                {(counts.get(c.id) ?? 0) > 0 && (
                  <span style={{ fontSize: 11, color: activeCategory === c.id ? '#fff' : 'var(--pos-text3, #94a3b8)' }}>{counts.get(c.id)}</span>
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
      {!panel.prefs.pinned && (
        <div aria-hidden onClick={() => panel.setOpen(false)}
          style={{ position: 'absolute', inset: 0, zIndex: 30, background: 'rgba(0,0,0,0.35)' }} />
      )}
      {body}
    </>
  );
}
