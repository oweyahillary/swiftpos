/**
 * managerNav.ts — A351 (2026-09-28): the manager sidebar, grouped.
 *
 * Owner, on v0.6.16: "this menu is too long can we collapse some items like settings can have printer and staff, close
 * branch and close day, orders and shift" → "go with it". Eleven sidebar items become at most seven; a group opens as
 * ONE page with tabs across the top (one tap, the sidebar never moves under the cashier's finger):
 *
 *   Overview · Sales [Orders · Item Mix · Current shift · Shift report] · Expenses · Close [Close Day · Close Branch]
 *   · Menu · Settings [General · Printing · Staff] · Stock
 *
 * Rules:
 *   - every tab keeps the permission it had as its own sidebar item; a group shows only the tabs its role may open,
 *     drops its tab bar when one is left, and leaves the sidebar when none is;
 *   - a group opens on the tab last used in it (while the manager screen is open), else its first — Close opens on
 *     Close Day, the everyday one; Close Branch is a deliberate second tap;
 *   - pages reached from inside another page (Menu → Import) stay in their group.
 *
 * Pure (no React, no posApi) so the test runs the real rules.
 */

export type TabKey =
  | 'overview' | 'orders' | 'items' | 'shift' | 'zreport' | 'expenses' | 'dayclose' | 'branchclose'
  | 'menu' | 'prices' | 'combos' | 'import' | 'settings' | 'printers' | 'staff' | 'stock' | 'wastage';

export type GroupKey = 'overview' | 'sales' | 'expenses' | 'close' | 'menu' | 'settings' | 'stock';

export interface NavTab { key: TabKey; label: string }
export interface NavGroup { key: GroupKey; label: string; tabs: NavTab[] }

export interface NavAccess {
  isRestaurant: boolean;
  /** Close Day / Close Branch: role or settings.manage (dayService.isManager's rule). */
  isManagerRole: boolean;
  canManageProducts: boolean;
  canManageStaff: boolean;
  canManageSettings: boolean;
  /** stations.manage or the receipt text (A90). */
  canPrinting: boolean;
  /** Web POS on and something stock-tracked (A346). */
  showStock: boolean;
  /** A414: inventory.waste or inventory.adjust — record wastage on the till. */
  canWaste?: boolean;
}

/** Pages opened from inside a group's page, not tabs of their own. */
const HIDDEN_MEMBERS: Partial<Record<TabKey, GroupKey>> = { import: 'menu', prices: 'menu', combos: 'menu' };

export function buildManagerNav(a: NavAccess): NavGroup[] {
  const groups: NavGroup[] = [
    { key: 'overview', label: 'Overview', tabs: [{ key: 'overview', label: 'Overview' }] },
    { key: 'sales', label: 'Sales', tabs: [
      { key: 'orders', label: 'Orders' },
      ...(a.isRestaurant ? [{ key: 'items' as TabKey, label: 'Item Mix' }] : []),   // restaurant only (A105)
      { key: 'shift', label: 'Current shift' },
      { key: 'zreport', label: 'Shift report' },
    ] },
    { key: 'expenses', label: 'Expenses', tabs: [{ key: 'expenses', label: 'Expenses' }] },   // 0.6.11
    // Manager-only: Close Day is the escape route for the trading-day gate.
    { key: 'close', label: 'Close', tabs: a.isManagerRole
      ? [{ key: 'dayclose', label: 'Close Day' }, { key: 'branchclose', label: 'Close Branch' }] : [] },
    { key: 'menu', label: 'Menu', tabs: a.canManageProducts ? [{ key: 'menu', label: 'Menu' }] : [] },
    { key: 'settings', label: 'Settings', tabs: [
      ...((a.canManageSettings || a.canManageProducts) ? [{ key: 'settings' as TabKey, label: 'General' }] : []),
      ...(a.canPrinting ? [{ key: 'printers' as TabKey, label: 'Printing' }] : []),
      ...(a.canManageStaff ? [{ key: 'staff' as TabKey, label: 'Staff' }] : []),
    ] },
    { key: 'stock', label: 'Stock', tabs: [
      ...(a.showStock ? [{ key: 'stock' as TabKey, label: 'Stock' }] : []),
      ...(a.canWaste ? [{ key: 'wastage' as TabKey, label: 'Wastage' }] : []),   // A414
    ] },
  ];
  return groups.filter((g) => g.tabs.length > 0);
}

/** The group a page belongs to (its sidebar item), or null when no visible group holds it. */
export function groupOf(nav: NavGroup[], tab: TabKey): NavGroup | null {
  const owner = HIDDEN_MEMBERS[tab];
  if (owner) return nav.find((g) => g.key === owner) ?? null;
  return nav.find((g) => g.tabs.some((t) => t.key === tab)) ?? null;
}

/** Where a sidebar tap lands: the group's last-used tab if still visible, else its first. */
export function openGroup(group: NavGroup, last: Partial<Record<GroupKey, TabKey>>): TabKey {
  const remembered = last[group.key];
  return remembered && group.tabs.some((t) => t.key === remembered) ? remembered : group.tabs[0].key;
}
