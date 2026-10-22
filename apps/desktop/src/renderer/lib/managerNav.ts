/**
 * managerNav.ts — A351 (2026-09-28): the manager sidebar, grouped.
 *
 * Owner, on v0.6.16: "this menu is too long can we collapse some items like settings can have printer and staff, close
 * branch and close day, orders and shift" → "go with it". Eleven sidebar items become at most seven; a group opens as
 * ONE page with tabs across the top (one tap, the sidebar never moves under the cashier's finger):
 *
 *   Overview · Sales [Orders · Item Mix · Current shift · Shift report · Monthly pack] · Expenses · Close [Close Day · Close Branch]
 *   · Menu · Settings [General · Printing · Staff] · Stock
 *
 * Rules:
 *   - A490: every tab is gated by its own FINE key (NavAccess); a group shows only the tabs the person may open,
 *     drops its tab bar when one is left, and leaves the sidebar when none is;
 *   - a group opens on the tab last used in it (while the manager screen is open), else its first — Close opens on
 *     Close Day, the everyday one; Close Branch is a deliberate second tap;
 *   - pages reached from inside another page (Menu → Import) stay in their group.
 *
 * Pure (no React, no posApi) so the test runs the real rules.
 */

export type TabKey =
  | 'overview' | 'orders' | 'items' | 'shift' | 'zreport' | 'expenses' | 'dayclose' | 'branchclose'
  | 'menu' | 'offers' | 'prices' | 'combos' | 'import' | 'settings' | 'printers' | 'staff' | 'stock' | 'wastage' | 'transfers' | 'monthly'
  | 'credit' | 'branchstock' | 'labels';

export type GroupKey = 'overview' | 'sales' | 'expenses' | 'close' | 'menu' | 'settings' | 'stock';

export interface NavTab { key: TabKey; label: string }
export interface NavGroup { key: GroupKey; label: string; tabs: NavTab[] }

/**
 * A490: what the person may open — each a FINE key of the catalogue (lib/access.ts `can`), never a role's name. A person
 * with no key for a page simply does not see it; a group with no page leaves the sidebar.
 */
export interface NavAccess {
  isRestaurant: boolean;
  /** reports.overview — the Overview page. */
  canOverview: boolean;
  /** orders.view_all — Orders. */
  canOrders: boolean;
  /** reports.items — Item Mix (restaurant). */
  canItems: boolean;
  /** reports.shifts or shifts.confirm — Current shift and Shift report. */
  canShifts: boolean;
  /** A466 / A481: reports.monthly_pack or expenses.manage — the monthly pack (A455), from the cloud. */
  canMonthly?: boolean;
  /** A545: customers.credit — Credit sales (every sale on account, confirmed or disputed by a manager). */
  canCredit?: boolean;
  /** expenses.view or expenses.manage — Expenses. */
  canExpenses: boolean;
  /** shifts.close_day — Close Day (dayService mayCloseDay's rule). */
  canCloseDay: boolean;
  /** A520: shifts.close_branch — Close Branch (dayService mayCloseBranch). Absent = as close_day (an older caller). */
  canCloseBranch?: boolean;
  /** A520 (owner, 2026-10-17: "Server should not have close day, it should have close branch only, it's confusing to the
   *  manager"): this machine is the branch server (device_role node / office) — Close shows Close Branch alone; its own
   *  day (and an open drawer on it) is closed there. A plain till keeps Close Day. */
  isBranchServer?: boolean;
  /** menu.edit or menu.prices — the Menu page. */
  canMenu: boolean;
  /** menu.offers — Offers (with the online licence). */
  canOffers: boolean;
  /** settings.business or settings.payments — Settings › General (each panel by its own key). */
  canSettings: boolean;
  /** stations.manage or the receipt text (receipt.manage) (A90). */
  canPrinting: boolean;
  /** staff.view — Staff (adding and changing them is staff.edit, on the page). */
  canStaff: boolean;
  /** Web POS on, something stock-tracked (A346) and inventory.view. */
  showStock: boolean;
  /** A414: inventory.waste — record wastage on the till. */
  canWaste?: boolean;
  /** A460: the client has the online licence — offers, wastage and transfers are shown only then. */
  online?: boolean;
  /** A197: inventory.transfer — send and receive stock between branches (online licence). */
  canTransfer?: boolean;
  /** A564: inventory.view — Other branches: another branch's stock (and, with inventory.transfer, asking for it). */
  canBranchStock?: boolean;
  /** A564: requests from other branches waiting for this branch's answer — shown on the tab (none: the plain label). */
  branchRequests?: number;
  /** A571: menu.edit or inventory.view — Labels: barcode labels on any printer (online licence, as the other Stock pages). */
  canLabels?: boolean;
}

/** Pages opened from inside a group's page, not tabs of their own. */
const HIDDEN_MEMBERS: Partial<Record<TabKey, GroupKey>> = { import: 'menu', prices: 'menu', combos: 'menu' };

export function buildManagerNav(a: NavAccess): NavGroup[] {
  const groups: NavGroup[] = [
    { key: 'overview', label: 'Overview', tabs: a.canOverview ? [{ key: 'overview', label: 'Overview' }] : [] },
    { key: 'sales', label: 'Sales', tabs: [
      ...(a.canOrders ? [{ key: 'orders' as TabKey, label: 'Orders' }] : []),
      ...(a.isRestaurant && a.canItems ? [{ key: 'items' as TabKey, label: 'Item Mix' }] : []),   // restaurant only (A105)
      ...(a.canShifts ? [{ key: 'shift' as TabKey, label: 'Current shift' }, { key: 'zreport' as TabKey, label: 'Shift report' }] : []),
      ...(a.canMonthly ? [{ key: 'monthly' as TabKey, label: 'Monthly pack' }] : []),   // A466: the web's Monthly pack (A455)
      ...(a.canCredit ? [{ key: 'credit' as TabKey, label: 'Credit sales' }] : []),   // A545: a manager confirms every sale on account
    ] },
    { key: 'expenses', label: 'Expenses', tabs: a.canExpenses ? [{ key: 'expenses', label: 'Expenses' }] : [] },   // 0.6.11
    // Close Day is the escape route for the trading-day gate — shifts.close_day.
    // A520: Close Day is shifts.close_day, Close Branch shifts.close_branch; the branch server shows Close Branch alone.
    { key: 'close', label: 'Close', tabs: [
      ...(a.canCloseDay && !a.isBranchServer ? [{ key: 'dayclose' as TabKey, label: 'Close Day' }] : []),
      ...((a.canCloseBranch ?? a.canCloseDay) ? [{ key: 'branchclose' as TabKey, label: 'Close Branch' }] : []),
    ] },
    // A445: Offers beside the menu. A460: only with the online licence (a premium feature — never shown without it).
    { key: 'menu', label: 'Menu', tabs: [
      ...(a.canMenu ? [{ key: 'menu' as TabKey, label: 'Menu' }] : []),
      ...(a.online && a.canOffers ? [{ key: 'offers' as TabKey, label: 'Offers' }] : []),
    ] },
    { key: 'settings', label: 'Settings', tabs: [
      ...(a.canSettings ? [{ key: 'settings' as TabKey, label: 'General' }] : []),
      ...(a.canPrinting ? [{ key: 'printers' as TabKey, label: 'Printing' }] : []),
      ...(a.canStaff ? [{ key: 'staff' as TabKey, label: 'Staff' }] : []),
    ] },
    { key: 'stock', label: 'Stock', tabs: [
      ...(a.showStock ? [{ key: 'stock' as TabKey, label: 'Stock' }] : []),
      ...(a.online && a.canWaste ? [{ key: 'wastage' as TabKey, label: 'Wastage' }] : []),   // A414; A460: online licence
      ...(a.online && a.canTransfer ? [{ key: 'transfers' as TabKey, label: 'Transfers' }] : []),   // A197 (A460: online licence)
      // A564: another branch's stock, and requests from other branches (online licence) — the count waiting on the tab.
      ...(a.online && a.canBranchStock ? [{ key: 'branchstock' as TabKey,
        label: a.branchRequests && a.branchRequests > 0 ? `Other branches (${a.branchRequests})` : 'Other branches' }] : []),
      // A571: barcode labels — any label printer (driver, TSPL, ZPL) or the receipt printer (online licence).
      ...(a.online && a.canLabels ? [{ key: 'labels' as TabKey, label: 'Labels' }] : []),
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

/** A490: the page to open first — the one asked for when the person has it, else the first page they have (null: none). */
export function firstTab(nav: NavGroup[], wanted?: TabKey | null): TabKey | null {
  if (wanted && groupOf(nav, wanted)) return wanted;
  return nav[0]?.tabs[0]?.key ?? null;
}
