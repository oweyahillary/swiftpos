/**
 * menuFilter.ts — A537: the POS's category side panel and the business's menus (Food, Soft drinks, Alcohol, Tea …).
 *
 * Owner, 2026-10-20: "the menu categories at the top, can we add them to the left like a hamburger, which can collapse,
 * and it should start collapsed by default? … some restaurants have different menus — food menu, non-alcoholic drinks
 * menu, alcoholic drinks menu, tea menu etc, can we include such?" Decisions: both the desktop till and the web POS;
 * plain menus (no hours or days for now); one menu per category (categories.menu_id, migration 155).
 *
 * What the panel shows, worked out here so the till and the web POS cannot disagree:
 *   - no active menu that holds a category  → exactly the plain category list (a business that does not use menus sees
 *     no change);
 *   - otherwise a row of menu tabs: "All menus", each menu that holds a category (sort order, then name), and "Other"
 *     when some category has no menu (or names a menu that is off or gone);
 *   - a menu chosen → its categories in the list, and only their products on the grid ("Other" also takes the products
 *     with no category); "All menus" → every category, grouped under each menu's name, "Other" last;
 *   - the panel starts collapsed — A554: at EVERY start and sign-in, pinned or not; a pin keeps it open for this
 *     session only, and only the chosen menu is remembered per till / per browser (parsePanelPrefs / panelPrefsText —
 *     the caller wraps the storage in try/catch).
 *
 * A566 (owner, 2026-10-22: "if a client has larger categories eg drinks, fast foods etc they should appear the way
 * categories used to appear so that cashiers can easily pick the menu"): with menus, the menus are ALSO a row of big tabs
 * across the top of the grid ("All", "Food", "Drinks" …, menuBarTabs / menuBarLabel) — the panel then lists only the
 * chosen menu's categories, for drilling further, and drops its own tabs; a search looks through every menu
 * (gridMenuScope). With no menus nothing changes: the panel alone, as A537 built it.
 *
 * Pure (no React, no storage), so the tests run it. Copied verbatim: shared/, apps/desktop/src/shared/ (the till's sale
 * screen), apps/dashboard/src/lib/ (the web POS) — scripts/check-shared-sync.mjs.
 */

export const ALL_MENUS = 'all';
export const OTHER_MENU = 'other';
export const ALL_CATEGORIES = 'all';
/** Where the pin and the chosen menu are remembered (localStorage on the web, the till's own renderer store). */
export const PANEL_PREFS_KEY = 'zaptill.categoryPanel.v1';

export interface MenuLike {
  id: string;
  name: string;
  sort_order?: number | null;
  active?: boolean | number | null;
  deleted_at?: string | null;
  color?: string | null;
  icon?: string | null;
}
export interface CategoryLike {
  id: string;
  name?: string;
  menu_id?: string | null;
}
export interface ProductLike {
  category_id?: string | null;
}

/** A tab at the top of the panel. `id` is a menu's id, ALL_MENUS or OTHER_MENU. */
export interface MenuTab { id: string; name: string; color: string | null; icon: string | null }
/** One heading of the category list ("Food", "Other"); `menu` null = no heading (the plain list). */
export interface CategoryGroup<C> { menu: MenuTab | null; categories: C[] }

const on = (v: unknown): boolean => v === undefined || v === null ? true : v === true || v === 1 || v === '1' || v === 'true';

/** The menus that are on (active, not deleted), in the owner's order (sort_order, then name). */
export function liveMenus<M extends MenuLike>(menus: readonly M[] | null | undefined): M[] {
  return (Array.isArray(menus) ? menus : [])
    .filter((m) => m && typeof m.id === 'string' && m.id && on(m.active) && !m.deleted_at)
    .slice()
    .sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0) || String(a.name ?? '').localeCompare(String(b.name ?? '')));
}

/** The menu a category is under — null when it has none, or its menu is off or gone. */
export function menuOfCategory(c: CategoryLike, live: ReadonlySet<string>): string | null {
  const m = c?.menu_id ?? null;
  return m && live.has(m) ? m : null;
}

/** The tabs at the top of the panel; [] = the business does not use menus (no tabs, the plain list). */
export function menuTabs(menus: readonly MenuLike[] | null | undefined, categories: readonly CategoryLike[]): MenuTab[] {
  const live = liveMenus(menus);
  const ids = new Set(live.map((m) => m.id));
  const used = new Set(categories.map((c) => menuOfCategory(c, ids)).filter((x): x is string => !!x));
  const shown = live.filter((m) => used.has(m.id));
  if (shown.length === 0) return [];
  const tabs: MenuTab[] = [{ id: ALL_MENUS, name: 'All menus', color: null, icon: null }];
  for (const m of shown) tabs.push({ id: m.id, name: String(m.name ?? ''), color: m.color ?? null, icon: m.icon ?? null });
  if (categories.some((c) => menuOfCategory(c, ids) === null)) tabs.push({ id: OTHER_MENU, name: 'Other', color: null, icon: null });
  return tabs;
}

/** The menu to show: the one asked for when it is still a tab, else All menus. */
export function resolveMenu(menuId: string | null | undefined, tabs: readonly MenuTab[]): string {
  return menuId && tabs.some((t) => t.id === menuId) ? menuId : ALL_MENUS;
}

/** The categories in the list for a menu (All menus or no menus = every category), in the order given. */
export function categoriesForMenu<C extends CategoryLike>(categories: readonly C[], menus: readonly MenuLike[] | null | undefined, menuId: string): C[] {
  const tabs = menuTabs(menus, categories);
  const m = resolveMenu(menuId, tabs);
  if (tabs.length === 0 || m === ALL_MENUS) return categories.slice();
  const ids = new Set(liveMenus(menus).map((x) => x.id));
  return categories.filter((c) => (m === OTHER_MENU ? menuOfCategory(c, ids) === null : menuOfCategory(c, ids) === m));
}

/** The list under its headings: no menus → one group without a heading; a menu → that menu's; All → each menu, Other last. */
export function categoryGroups<C extends CategoryLike>(categories: readonly C[], menus: readonly MenuLike[] | null | undefined, menuId: string): CategoryGroup<C>[] {
  const tabs = menuTabs(menus, categories);
  if (tabs.length === 0) return [{ menu: null, categories: categories.slice() }];
  const m = resolveMenu(menuId, tabs);
  if (m !== ALL_MENUS) return [{ menu: tabs.find((t) => t.id === m) ?? null, categories: categoriesForMenu(categories, menus, m) }];
  return tabs.filter((t) => t.id !== ALL_MENUS)
    .map((t) => ({ menu: t, categories: categoriesForMenu(categories, menus, t.id) }))
    .filter((g) => g.categories.length > 0);
}

/**
 * Which products the grid may show for a menu: null = no narrowing (no menus, or All menus); otherwise the category ids,
 * and whether a product with no category belongs (the Other tab).
 */
export interface MenuScope { categoryIds: Set<string>; uncategorised: boolean }
export function menuScope(categories: readonly CategoryLike[], menus: readonly MenuLike[] | null | undefined, menuId: string): MenuScope | null {
  const tabs = menuTabs(menus, categories);
  const m = resolveMenu(menuId, tabs);
  if (tabs.length === 0 || m === ALL_MENUS) return null;
  return { categoryIds: new Set(categoriesForMenu(categories, menus, m).map((c) => c.id)), uncategorised: m === OTHER_MENU };
}

/** Is the product on the grid under this scope (null = every product)? */
export function inMenuScope(p: ProductLike, scope: MenuScope | null): boolean {
  if (!scope) return true;
  const c = p?.category_id ?? null;
  return c ? scope.categoryIds.has(c) : scope.uncategorised;
}

// ── A566: the menus as tabs across the top of the grid ───────────────────────────────────────────────────────────────
/** The row of menus across the top of the grid: the menu tabs when the business uses menus, else [] (no row — the ☰ panel
 *  alone, exactly as before). */
export function menuBarTabs(menus: readonly MenuLike[] | null | undefined, categories: readonly CategoryLike[]): MenuTab[] {
  return menuTabs(menus, categories);
}
/** A top tab's words: "All" for every menu (the panel's "All menus"), else the menu's name. */
export function menuBarLabel(t: MenuTab): string {
  return t.id === ALL_MENUS ? 'All' : t.name;
}
/** A search looks through every menu: while the cashier types, the chosen menu does not narrow the grid. */
export function gridMenuScope(scope: MenuScope | null, search: string | null | undefined): MenuScope | null {
  return String(search ?? '').trim() ? null : scope;
}
/** Which ends of the sideways menu row hide more tabs (an arrow and a fade show there) — from the row's scroll box. */
export function menuBarEdges(scrollLeft: number, scrollWidth: number, clientWidth: number): { left: boolean; right: boolean } {
  const l = Number(scrollLeft) || 0, w = Number(scrollWidth) || 0, c = Number(clientWidth) || 0;
  return { left: l > 4, right: l + c < w - 4 };
}

/** The category to keep chosen: still in the list → it, else All (a menu change can take it away). */
export function resolveCategory(categoryId: string, shown: readonly CategoryLike[]): string {
  return categoryId !== ALL_CATEGORIES && shown.some((c) => c.id === categoryId) ? categoryId : ALL_CATEGORIES;
}

/** How many products each category holds (the panel's optional count). */
export function productCounts(products: readonly ProductLike[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const p of products) { const c = p?.category_id; if (c) out.set(c, (out.get(c) ?? 0) + 1); }
  return out;
}

// ── The panel's remembered state ─────────────────────────────────────────────────────────────────────────────────────
// A554 (the owner, 2026-10-21: the categories panel "must START COLLAPSED" — it did not): the pin was remembered in the
// till's (and the browser's) storage, and a pinned panel opened at every start — once anybody had pinned it, every launch
// and every sign-in began with it open. Now the pin lasts for the session only (the panel's own state) and is never
// stored; a pin an older build stored is not honoured. Only the chosen menu is remembered.
export interface PanelPrefs { pinned: boolean; menu: string }
/** Collapsed and All menus until the cashier pins it ("it should start collapsed by default"). */
export const DEFAULT_PANEL_PREFS: PanelPrefs = { pinned: false, menu: ALL_MENUS };

/** What storage held (anything, or nothing) → the prefs; anything unreadable is the default. */
export function parsePanelPrefs(raw: unknown): PanelPrefs {
  let v: unknown = raw;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return { ...DEFAULT_PANEL_PREFS }; } }
  if (!v || typeof v !== 'object') return { ...DEFAULT_PANEL_PREFS };
  const o = v as Record<string, unknown>;
  const menu = typeof o.menu === 'string' && o.menu.length > 0 && o.menu.length <= 64 ? o.menu : ALL_MENUS;
  return { pinned: false, menu };   // A554: a stored pin (an older build) is not honoured — the pin is this session's
}
/** What is stored: the chosen menu only (A554: never the pin). */
export function panelPrefsText(p: PanelPrefs): string {
  return JSON.stringify({ menu: typeof p.menu === 'string' && p.menu ? p.menu : ALL_MENUS });
}
/** A554: the panel starts collapsed at every start and sign-in — pinned or not. */
export function panelStartsOpen(): boolean { return false; }
/** After a category is picked: open only while pinned (an unpinned panel closes). */
export function panelOpenAfterPick(p: PanelPrefs): boolean { return p.pinned === true; }
