/**
 * commandDestinations.ts — A627 (owner, 2026-11-26: "add a search functionality that they can use to navigate the system,
 * web specifically"): every place the global search (CommandPalette) can jump to — each sidebar page and report, plus the
 * buried Settings tabs (Business profile, Roles and permissions, Payments…) so a switch the owner can't find is one search
 * away. Mirrors DashboardLayout's NAV and the routes in App.tsx.
 *
 * Each entry is gated exactly like the sidebar: `keys` — ANY of them grants it (usePermissions().can; absent = everyone) —
 * and `verticals` — the business types it applies to (absent = every business). The page still guards every request, so
 * this only decides what the search OFFERS.
 */
import { FOOD_SERVICE_TYPES } from '@zaptill/core/businessTerms';

export interface Destination {
  to: string;
  label: string;
  /** The breadcrumb shown in the palette, e.g. "Settings · Business". */
  group: string;
  /** Extra words to match on (synonyms the owner might type). */
  keywords?: string[];
  /** ANY of these permission keys grants it; absent = everyone. */
  keys?: string[];
  /** Business types it applies to; absent = every business. */
  verticals?: string[];
}

const FOOD: string[] = [...FOOD_SERVICE_TYPES];
const REPORT_KEYS = ['reports.overview', 'reports.sales', 'reports.items', 'reports.staff', 'reports.shifts', 'reports.voids',
  'reports.inventory', 'reports.fuel', 'reports.tax', 'reports.costs', 'reports.labour', 'reports.monthly_pack',
  'reports.payments', 'reports.export'];
const BUSINESS_SECTION = ['settings.business', 'settings.branches', 'settings.payments', 'settings.reversals',
  'settings.integrations', 'settings.pos', 'receipt.manage', 'tables.manage', 'etims.manage', 'settings.tax',
  'settings.sales_rules', 'settings.webhooks', 'settings.report_emails', 'settings.pos_layout'];
const DEVICES_SECTION = ['devices.view', 'devices.approve', 'stations.manage'];

export const DESTINATIONS: Destination[] = [
  // ── Top level ──────────────────────────────────────────────────────────────────────────────────────────────────
  { to: '/dashboard',               label: 'Overview',        group: 'Dashboard', keywords: ['home', 'dashboard', 'today'] },
  { to: '/dashboard/analytics',     label: 'Analytics',       group: 'Dashboard', keywords: ['trends', 'insights', 'menu engineering'], keys: ['reports.analytics'] },
  { to: '/dashboard/watch-list',    label: 'Watch list',      group: 'Dashboard', keywords: ['loss prevention', 'alerts', 'unusual', 'fraud', 'exceptions'], keys: ['reports.voids'] },
  { to: '/dashboard/attendance',    label: 'Attendance',      group: 'Dashboard', keywords: ['clock in', 'punches', 'hours', 'who came in'], keys: ['attendance.view'] },
  { to: '/dashboard/pos',           label: 'Open POS',        group: 'Dashboard', keywords: ['till', 'sell', 'point of sale', 'cashier'], keys: ['orders.create'] },
  { to: '/kds',                     label: 'Kitchen display (KDS)', group: 'Dashboard', keywords: ['kitchen', 'orders screen', 'kds'], keys: ['stations.manage'], verticals: FOOD },
  { to: '/dashboard/inventory',     label: 'Inventory',       group: 'Stock', keywords: ['stock on hand', 'packaged goods'], keys: ['inventory.view'] },
  { to: '/dashboard/approvals',     label: 'Approvals',       group: 'Dashboard', keywords: ['pos changes', 'approve', 'pending changes'], keys: ['changes.approve'] },
  { to: '/dashboard/reservations',  label: 'Reservations',    group: 'Dashboard', keywords: ['bookings', 'waitlist', 'table booking'], keys: ['reservations.manage'], verticals: FOOD },

  // ── Menu / Catalogue ───────────────────────────────────────────────────────────────────────────────────────────
  { to: '/dashboard/menus',         label: 'Menus',           group: 'Menu', keywords: ['menu', 'departments', 'groups', 'catalogue'], keys: ['products.view', 'menu.edit'] },
  { to: '/dashboard/categories',    label: 'Categories',      group: 'Menu', keywords: ['category', 'sections'], keys: ['products.view', 'menu.edit'] },
  { to: '/dashboard/products',      label: 'Products',        group: 'Menu', keywords: ['items', 'menu items', 'prices', 'what you sell'], keys: ['products.view', 'menu.edit'] },
  { to: '/dashboard/products/labels', label: 'Print labels',  group: 'Menu', keywords: ['barcode', 'labels', 'shelf labels'], keys: ['products.view', 'menu.edit', 'inventory.view'] },
  { to: '/dashboard/discounts',     label: 'Discounts',       group: 'Menu', keywords: ['discount', 'promo code'], keys: ['menu.offers'] },
  { to: '/dashboard/offers',        label: 'Offers',          group: 'Menu', keywords: ['offers', 'specials', 'deals'], keys: ['menu.offers'] },
  { to: '/dashboard/combos',        label: 'Combo meals',     group: 'Menu', keywords: ['combo', 'set meal', 'bundle'], keys: ['menu.edit'], verticals: FOOD },

  // ── Stock ──────────────────────────────────────────────────────────────────────────────────────────────────────
  { to: '/dashboard/stock/ingredients',     label: 'Ingredients',     group: 'Stock', keywords: ['raw materials', 'recipe stock'], keys: ['ingredients.manage', 'inventory.view'], verticals: FOOD },
  { to: '/dashboard/stock/purchase-orders', label: 'Purchase orders', group: 'Stock', keywords: ['po', 'order stock', 'buy stock'], keys: ['inventory.receive'] },
  { to: '/dashboard/stock/suppliers',       label: 'Suppliers',       group: 'Stock', keywords: ['vendors', 'supplier bills'], keys: ['inventory.receive', 'payables.view', 'payables.manage'] },
  { to: '/dashboard/stock/transfers',       label: 'Stock transfers', group: 'Stock', keywords: ['move stock', 'transfer'], keys: ['inventory.transfer'] },
  { to: '/dashboard/stock/other-branches',  label: 'Other branches',  group: 'Stock', keywords: ['branch stock', 'request stock'], keys: ['inventory.view', 'inventory.transfer'] },
  { to: '/dashboard/stock/counts',          label: 'Stock counts',    group: 'Stock', keywords: ['stock take', 'count', 'blind count'], keys: ['inventory.count', 'inventory.adjust'] },
  { to: '/dashboard/stock/wastage',         label: 'Wastage',         group: 'Stock', keywords: ['waste', 'spoiled', 'write off', 'damaged'], keys: ['inventory.waste', 'reports.inventory'] },
  { to: '/dashboard/stock/expiry',          label: 'Expiry',          group: 'Stock', keywords: ['batches', 'expiry dates', 'expiring'], keys: ['inventory.view'] },

  // ── Finance ────────────────────────────────────────────────────────────────────────────────────────────────────
  { to: '/dashboard/orders',        label: 'Orders',          group: 'Finance', keywords: ['sales', 'transactions', 'order history'], keys: ['orders.view_all'] },
  { to: '/dashboard/expenses',      label: 'Expenses',        group: 'Finance', keywords: ['costs', 'spending', 'pay outs'], keys: ['expenses.view', 'expenses.manage'] },
  { to: '/dashboard/reports',       label: 'Reports',         group: 'Finance', keywords: ['dsr', 'sales report', 'z report', 'daily report'], keys: REPORT_KEYS },
  { to: '/dashboard/shift-reports', label: 'Shift reports',   group: 'Finance', keywords: ['z report', 'drawer report', 'cashier shift', 'close shift'], keys: ['reports.shifts', 'shifts.confirm'] },
  { to: '/dashboard/turnover',      label: 'Table turnover',  group: 'Finance', keywords: ['tables', 'covers', 'seating'], keys: ['orders.view_all'], verticals: FOOD },
  { to: '/dashboard/open-drawers',  label: 'Open drawers',    group: 'Finance', keywords: ['drawer', 'cash drawer', 'force close'], keys: ['shifts.force_close', 'shifts.confirm'] },
  { to: '/dashboard/tills-days',    label: 'POS & days',      group: 'Finance', keywords: ['close day', 'open day', 'pos days', 'close branch'], keys: ['shifts.close_day', 'shifts.force_close'] },

  // ── Customers ──────────────────────────────────────────────────────────────────────────────────────────────────
  { to: '/dashboard/customers',         label: 'Customers',        group: 'Customers', keywords: ['crm', 'loyalty', 'contacts'], keys: ['customers.view'] },
  { to: '/dashboard/customers/credit',  label: 'Credit accounts',  group: 'Customers', keywords: ['on account', 'debtors', 'owing', 'credit'], keys: ['customers.credit', 'customers.view'] },

  // ── Settings · Users and access ───────────────────────────────────────────────────────────────────────────────
  { to: '/dashboard/settings/users/staff',    label: 'Staff members',          group: 'Settings · Users', keywords: ['employees', 'add staff', 'team', 'pins'], keys: ['staff.view', 'staff.edit'] },
  { to: '/dashboard/settings/users/roles',    label: 'Roles and permissions',  group: 'Settings · Users', keywords: ['rights', 'access', 'permissions', 'who can', 'role'], keys: ['staff.roles'] },
  { to: '/dashboard/settings/users/security', label: 'My sign-in and security', group: 'Settings · Users', keywords: ['password', 'sign in code', 'my account'] },

  // ── Settings · Devices and printers ───────────────────────────────────────────────────────────────────────────
  { to: '/dashboard/settings/devices/terminals',      label: 'Terminals (POS devices)', group: 'Settings · Devices', keywords: ['tills', 'devices', 'fleet', 'approve device'], keys: DEVICES_SECTION },
  { to: '/dashboard/settings/devices/printers',       label: 'Printers',                group: 'Settings · Devices', keywords: ['printer', 'receipt printer', 'thermal'], keys: DEVICES_SECTION },
  { to: '/dashboard/settings/devices/stations',       label: 'Print stations',          group: 'Settings · Devices', keywords: ['kitchen printer', 'bar', 'station', 'where it prints'], keys: DEVICES_SECTION },
  { to: '/dashboard/settings/devices/kitchen-display', label: 'Kitchen display',        group: 'Settings · Devices', keywords: ['kds', 'kitchen screen'], keys: ['stations.manage'], verticals: FOOD },

  // ── Settings · Business ───────────────────────────────────────────────────────────────────────────────────────
  { to: '/dashboard/settings/business/profile',   label: 'Business profile',        group: 'Settings · Business', keywords: ['receipt rules', 'history', 'cashier sees sales', 'shift sales', 'blind close', 'hours', 'opening hours', 'name'], keys: ['settings.business'] },
  { to: '/dashboard/settings/business/branding',  label: 'Branding and theme',      group: 'Settings · Business', keywords: ['logo', 'colours', 'colors', 'theme'], keys: ['settings.business'] },
  { to: '/dashboard/settings/business/branches',  label: 'Branches',                group: 'Settings · Business', keywords: ['branch', 'outlet', 'location', 'add branch'], keys: ['settings.branches'] },
  { to: '/dashboard/settings/business/payments',  label: 'Payment methods',         group: 'Settings · Business', keywords: ['tender', 'mpesa', 'card', 'cash', 'pay method'], keys: ['settings.payments'] },
  { to: '/dashboard/settings/business/voids-refunds', label: 'Void and refund rules', group: 'Settings · Business', keywords: ['void', 'refund', 'void window', 'offline rules'], keys: ['settings.reversals'] },
  { to: '/dashboard/settings/business/pos-options', label: 'POS options',           group: 'Settings · Business', keywords: ['delivery fee', 'pay later', 'sign-in codes', 'loyalty', 'web pos', 'online pos'], keys: ['settings.pos'] },
  { to: '/dashboard/settings/business/loss-alerts', label: 'Loss-prevention alerts', group: 'Settings · Business', keywords: ['watch list', 'alerts', 'loss'], keys: ['settings.business', 'reports.voids'] },
  { to: '/dashboard/settings/business/credit-approvals', label: 'Credit approvals',  group: 'Settings · Business', keywords: ['who approves credit', 'credit limit'], keys: ['customers.credit'] },
  { to: '/dashboard/settings/business/scale-labels', label: 'Scale labels',         group: 'Settings · Business', keywords: ['weighing', 'scale', 'barcode scale'], keys: ['settings.business'] },
  { to: '/dashboard/settings/business/setup',     label: 'Vertical setup',          group: 'Settings · Business', keywords: ['restaurant setup', 'parking setup', 'petrol setup', 'minimart setup'], keys: ['settings.business'] },
  { to: '/dashboard/settings/business/integrations',         label: 'Integrations',  group: 'Settings · Business', keywords: ['mpesa', 'kra', 'etims', 'webhooks', 'qr ordering'], keys: ['settings.integrations'] },
  { to: '/dashboard/settings/business/integrations/mpesa',   label: 'M-Pesa number', group: 'Settings · Business', keywords: ['mpesa', 'paybill', 'buy goods', 'store number'], keys: ['settings.mpesa', 'settings.integrations'] },
  { to: '/dashboard/settings/business/integrations/kra',     label: 'KRA eTIMS',     group: 'Settings · Business', keywords: ['kra', 'etims', 'tax', 'vat', 'fiscal'], keys: ['etims.manage'] },
  { to: '/dashboard/settings/business/integrations/webhooks', label: 'Webhooks',     group: 'Settings · Business', keywords: ['webhook', 'send sales', 'api', 'scheduled report emails'], keys: ['settings.webhooks', 'settings.integrations'] },
];

const typeKey = (t: string | null | undefined): string => String(t ?? '').trim().toLowerCase();

/** The destinations a person may reach: gated by `keys` (ANY, via `can`) and the business `vertical` — exactly as the
 *  sidebar is. An entry with no keys shows for everyone; with no verticals, for every business. */
export function visibleDestinations(
  can: (key: string) => boolean,
  vertical: string | null | undefined,
): Destination[] {
  const v = typeKey(vertical);
  const known = v !== '';
  return DESTINATIONS.filter((d) => {
    if (d.verticals && known && !d.verticals.map(typeKey).includes(v)) return false;
    return !d.keys || d.keys.some((k) => can(k));
  });
}

/** Rank the destinations against the typed query: a label prefix beats a label word-start, which beats any substring in
 *  the label, keywords or group. Empty query keeps the natural order. Returns at most `limit`. */
export function rankDestinations(list: Destination[], query: string, limit = 12): Destination[] {
  const q = query.trim().toLowerCase();
  if (!q) return list.slice(0, limit);
  const score = (d: Destination): number => {
    const label = d.label.toLowerCase();
    if (label.startsWith(q)) return 0;
    if (label.split(/\s+/).some((w) => w.startsWith(q))) return 1;
    if (label.includes(q)) return 2;
    if ((d.keywords ?? []).some((k) => k.toLowerCase().includes(q))) return 3;
    if (d.group.toLowerCase().includes(q)) return 4;
    return 99;
  };
  return list
    .map((d) => ({ d, s: score(d) }))
    .filter((x) => x.s < 99)
    .sort((a, b) => a.s - b.s || a.d.label.localeCompare(b.d.label))
    .slice(0, limit)
    .map((x) => x.d);
}
