/**
 * permissions.ts — A490: ONE catalogue of what a person may see and do, everywhere (cloud, web, till, branch server).
 *
 * Owner, 2026-10-14: "come up with a way we can turn most of this features into permissions which can be set in one
 * place, if each report can be broken down to a permission stuff like that clean and single point of setting" — and,
 * 2026-10-15: "dont just focus on reports break even other views and how to limit what users see".
 *
 * WHAT IS HERE
 *   - PERMISSIONS: every FINE key — one per screen, report, action or sensitive figure — with the words the owner reads
 *     on Settings › Roles and permissions, the group it is listed under, where it applies (web / till) and whether a new
 *     business's Cashier and Manager roles get it.
 *   - LEGACY: the BROAD keys the product used before (reports.view, settings.manage, products.manage, …) and the fine
 *     keys each one stands for. A broad key is never checked any more: it is EXPANDED into its fine keys wherever
 *     permissions are read (expandKeys) — so a role saved before migration 134, an old token, an override row or a till
 *     on an older build keeps exactly what it had, and migration 134 rewrites the stored grants into fine keys once.
 *   - legacyKeysFor: the other way, for clients on an older build that still check broad keys — a broad key is reported
 *     held only when EVERY fine key it stands for is held, so an older till never shows more than the person may do.
 *
 * RULES
 *   - A check names a FINE key (has / requirePermission). check-permission-catalogue fails CI on a check of a legacy key.
 *   - '*' is everything (the owner). The owner is never refused anything (the cloud's isOwner, the till's owner role).
 *   - Keys are `module.action` — one dot, lowercase, underscores — so the CI scanners read them.
 *
 * Copies: shared/permissions.ts → apps/{server/src/lib, dashboard/src/lib, admin/src/lib, desktop/src/shared,
 * desktop/src/main}/permissions.ts, kept identical by scripts/check-shared-sync.mjs. Pure: no imports.
 */

export type PermissionSurface = 'web' | 'till' | 'both';
export type PermissionGroup =
  | 'selling' | 'drawer' | 'reports' | 'orders' | 'menu' | 'stock' | 'customers' | 'expenses' | 'staff'
  | 'front' | 'settings';

export interface PermissionDef {
  key: string;
  label: string;
  /** What it lets the person see or do, in the owner's words. */
  description: string;
  group: PermissionGroup;
  surface: PermissionSurface;
  /** Granted to a NEW business's roles of this kind (existing roles keep what migration 134 gives them). */
  cashier?: boolean;
  manager?: boolean;
}

export const PERMISSION_GROUPS: Array<{ id: PermissionGroup; label: string; description: string }> = [
  { id: 'selling',   label: 'Selling',             description: 'At the till and the web POS' },
  { id: 'drawer',    label: 'Drawers and the day', description: 'Cash drawers, approvals and closing the day' },
  { id: 'reports',   label: 'Reports',             description: 'Each report on its own — give only the ones a person needs' },
  { id: 'orders',    label: 'Orders',              description: 'The orders, shifts and turnover pages' },
  { id: 'menu',      label: 'Menu',                description: 'Products, prices, offers and recipes' },
  { id: 'stock',     label: 'Stock',               description: 'Stock levels, deliveries, counts and suppliers' },
  { id: 'customers', label: 'Customers',           description: 'Customer records, loyalty and credit' },
  { id: 'expenses',  label: 'Expenses',            description: 'Business expenses' },
  { id: 'staff',     label: 'Staff',               description: 'Staff, PINs, roles and permissions' },
  { id: 'front',     label: 'Front of house',      description: 'Reservations, parking and fuel' },
  { id: 'settings',  label: 'Settings',            description: 'How the business, its branches and its tills are set up' },
];

export const PERMISSIONS: PermissionDef[] = [
  // ── Selling ────────────────────────────────────────────────────────────────────────────────────────────────────
  { key: 'orders.create',        group: 'selling', surface: 'both', cashier: true, manager: true,
    label: 'Sell', description: 'Ring up sales, hold and recall bills, send orders to the kitchen and take payment' },
  { key: 'sales.discount',       group: 'selling', surface: 'both', cashier: true, manager: true,
    label: 'Give discounts', description: 'Give a discount on a sale, up to the business\'s discount limit' },
  { key: 'sales.void',           group: 'selling', surface: 'both', manager: true,
    label: 'Void sales', description: 'Void a sale within the void window (with a reason)' },
  { key: 'sales.refund',         group: 'selling', surface: 'both', manager: true,
    label: 'Refund sales', description: 'Refund a completed sale (with a reason)' },
  { key: 'sales.reprint',        group: 'selling', surface: 'both', manager: true,
    label: 'Reprint receipts', description: 'Reprint a receipt from the sales history' },
  { key: 'sales.history_all',    group: 'selling', surface: 'both', manager: true,
    label: 'See every cashier\'s sales', description: 'The sales history shows every cashier\'s sales, not only their own' },
  { key: 'invoice.create',       group: 'selling', surface: 'web', cashier: true, manager: true,
    label: 'Raise invoices', description: 'Raise an invoice for an order or a customer' },

  // ── Drawers and the day ──────────────────────────────────────────────────────────────────────────────────────────
  { key: 'shifts.cash_movements', group: 'drawer', surface: 'both', cashier: true, manager: true,
    label: 'Cash in, cash out and drawer expenses', description: 'Record money into or out of their drawer and expenses paid from it (cash out and expenses still need an approver)' },
  { key: 'shifts.confirm',       group: 'drawer', surface: 'both', manager: true,
    label: 'Approve with their PIN', description: 'Approve cash out, expenses and removing items sent to the kitchen, confirm cashiers\' drawers and see the expected cash' },
  { key: 'shifts.force_close',   group: 'drawer', surface: 'both', manager: true,
    label: 'Force-close a drawer', description: 'Close another person\'s drawer without a cash count (it shows as unreconciled)' },
  { key: 'shifts.close_day',     group: 'drawer', surface: 'both', manager: true,
    label: 'Close the day and the branch', description: 'Close the trading day on a till, and Close Branch on the branch server' },

  // ── Reports — one key per report ─────────────────────────────────────────────────────────────────────────────────
  { key: 'reports.overview',     group: 'reports', surface: 'both', manager: true,
    label: 'Overview', description: 'The Overview page: today\'s sales, orders and open drawers' },
  { key: 'reports.sales',        group: 'reports', surface: 'both', manager: true,
    label: 'Sales reports', description: 'Master / DSR, daily and hourly sales, payment methods and order channels' },
  { key: 'reports.items',        group: 'reports', surface: 'both', manager: true,
    label: 'Item mix and menu matrix', description: 'What sold, by product and category' },
  { key: 'reports.staff',        group: 'reports', surface: 'both', manager: true,
    label: 'Staff performance', description: 'Sales, voids and refunds by cashier' },
  { key: 'reports.shifts',       group: 'reports', surface: 'both', manager: true,
    label: 'Shift reports and Z-reports', description: 'Each drawer\'s report: expected cash, counted cash and the difference' },
  { key: 'reports.voids',        group: 'reports', surface: 'both', manager: true,
    label: 'Voids, refunds and exceptions', description: 'Voids and refunds, price differences on offline sales and other exceptions' },
  { key: 'reports.inventory',    group: 'reports', surface: 'both', manager: true,
    label: 'Inventory report', description: 'Stock movement and value over a period' },
  { key: 'reports.fuel',         group: 'reports', surface: 'both', manager: true,
    label: 'Fuel reports', description: 'Fuel sales, wet stock and the pump monitor' },
  { key: 'reports.tax',          group: 'reports', surface: 'web',
    label: 'Tax report', description: 'VAT and levy by branch and category, and eTIMS invoices' },
  { key: 'reports.costs',        group: 'reports', surface: 'both',
    label: 'Costs, margins and profit', description: 'Food cost, cost prices, margins, net profit and profit and loss' },
  { key: 'reports.labour',       group: 'reports', surface: 'web',
    label: 'Labour cost', description: 'Sales per labour hour and labour cost' },
  { key: 'reports.monthly_pack', group: 'reports', surface: 'both',
    label: 'Monthly pack', description: 'The monthly books: daily sales, expenses, cash and M-Pesa books' },
  { key: 'reports.payments',     group: 'reports', surface: 'web',
    label: 'Payment exceptions', description: 'M-Pesa payments that did not match a sale' },
  { key: 'reports.export',       group: 'reports', surface: 'both',
    label: 'Download reports', description: 'Download Excel and the exports (sales, items, shifts, profit and loss, expenses, audit)' },

  // ── Orders (back office) ─────────────────────────────────────────────────────────────────────────────────────────
  { key: 'orders.view_all',      group: 'orders', surface: 'both', manager: true,
    label: 'Orders, shifts and turnover pages', description: 'See every order of the branch, its shifts and table turnover' },

  // ── Menu ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  { key: 'products.view',        group: 'menu', surface: 'both', cashier: true, manager: true,
    label: 'See the menu', description: 'Read the menu and its prices' },
  { key: 'menu.edit',            group: 'menu', surface: 'both',
    label: 'Edit the menu', description: 'Add and change products, categories, variants, choices, extras and combos' },
  { key: 'menu.prices',          group: 'menu', surface: 'both',
    label: 'Change prices', description: 'Change selling prices, branch prices and bulk prices' },
  { key: 'menu.offers',          group: 'menu', surface: 'both', manager: true,
    label: 'Discounts and offers', description: 'Set up discounts, promotions and offers' },
  // A502: owner's by default (no role starts with it) — a promotion runs at every branch; the owner may give it to someone.
  { key: 'menu.promotions',      group: 'menu', surface: 'web',
    label: 'Promotions', description: 'Create, change and delete promotions, which run at every branch' },
  { key: 'menu.recipes',         group: 'menu', surface: 'web',
    label: 'Recipes and packaging', description: 'What each product uses from stock' },
  { key: 'menu.costs',           group: 'menu', surface: 'both',
    label: 'See cost prices', description: 'Cost prices and margins wherever they appear (menu, deliveries, stock)' },

  // ── Stock ────────────────────────────────────────────────────────────────────────────────────────────────────────
  { key: 'inventory.view',       group: 'stock', surface: 'both', cashier: true, manager: true,
    label: 'See stock levels', description: 'Stock levels of the branch' },
  { key: 'inventory.receive',    group: 'stock', surface: 'both', manager: true,
    label: 'Receive deliveries', description: 'Suppliers, purchase orders and receiving deliveries' },
  { key: 'inventory.transfer',   group: 'stock', surface: 'both', manager: true,
    label: 'Transfer stock', description: 'Send stock to another branch and receive transfers' },
  { key: 'inventory.count',      group: 'stock', surface: 'both', manager: true,
    label: 'Count stock', description: 'Take part in a stock count (they never see the expected figure)' },
  { key: 'inventory.waste',      group: 'stock', surface: 'both', manager: true,
    label: 'Record wastage', description: 'Write off spoiled, expired or damaged stock, with a reason' },
  // A502: owner's by default — whether a count stops sales of what is being counted.
  { key: 'inventory.count_freeze', group: 'stock', surface: 'web',
    label: 'Stock count freeze', description: 'Choose whether a stock count stops sales of the items being counted' },
  { key: 'inventory.adjust',     group: 'stock', surface: 'web',
    label: 'Adjust stock', description: 'Change a stock figure by hand, review counts and close batches' },
  { key: 'ingredients.manage',   group: 'stock', surface: 'web',
    label: 'Ingredient list', description: 'Add and change ingredients' },
  { key: 'payables.manage',      group: 'stock', surface: 'web',
    label: 'Supplier bills and payments', description: 'What is owed to suppliers, their bills and paying them' },

  // ── Customers ────────────────────────────────────────────────────────────────────────────────────────────────────
  { key: 'customers.view',       group: 'customers', surface: 'both', cashier: true, manager: true,
    label: 'See customers', description: 'Customer records, points and credit balances' },
  { key: 'customers.edit',       group: 'customers', surface: 'both', cashier: true, manager: true,
    label: 'Add and edit customers', description: 'Add customers and change their details' },
  { key: 'customers.credit',     group: 'customers', surface: 'both', manager: true,
    label: 'Customer credit', description: 'Approve sales on account with their PIN, set credit limits, record repayments and adjust balances' },   // A511

  // ── Expenses ─────────────────────────────────────────────────────────────────────────────────────────────────────
  { key: 'expenses.view',        group: 'expenses', surface: 'both', manager: true,
    label: 'See expenses', description: 'The expenses list and its totals' },
  { key: 'expenses.manage',      group: 'expenses', surface: 'both', manager: true,
    label: 'Record expenses', description: 'Record, change and remove expenses and expense types, and record entries in the monthly pack' },

  // ── Staff ────────────────────────────────────────────────────────────────────────────────────────────────────────
  { key: 'staff.view',           group: 'staff', surface: 'both', manager: true,
    label: 'See staff', description: 'The staff list of their branch' },
  { key: 'staff.edit',           group: 'staff', surface: 'both', manager: true,
    label: 'Add and edit staff', description: 'Add staff, set PINs and branches, and deactivate staff — never with more rights than they hold themselves' },
  { key: 'staff.roles',          group: 'staff', surface: 'web',
    label: 'Roles and permissions', description: 'Change what each role may see and do — never beyond what they hold themselves' },

  // ── Front of house ───────────────────────────────────────────────────────────────────────────────────────────────
  { key: 'reservations.manage',  group: 'front', surface: 'web', cashier: true, manager: true,
    label: 'Reservations and waitlist', description: 'Take and change reservations and the waitlist' },
  { key: 'parking.manage',       group: 'front', surface: 'both', cashier: true, manager: true,
    label: 'Parking', description: 'Open, close and void parking tickets' },
  { key: 'fuel.manage',          group: 'front', surface: 'both', cashier: true, manager: true,
    label: 'Fuel pumps and tanks', description: 'Set pumps active or idle, record tank deliveries and set up pumps and tanks' },

  // ── Settings ─────────────────────────────────────────────────────────────────────────────────────────────────────
  { key: 'settings.business',    group: 'settings', surface: 'both',
    label: 'Business settings', description: 'Business profile, receipt and history rules, opening hours and tax rates' },
  { key: 'settings.branches',    group: 'settings', surface: 'web',
    label: 'Branches', description: 'Branch details and each branch\'s own settings' },
  { key: 'settings.payments',    group: 'settings', surface: 'both',
    label: 'Payment methods', description: 'Which payment methods each branch takes, and the business\'s own methods' },
  { key: 'settings.mpesa',       group: 'settings', surface: 'till', manager: true,
    label: 'M-Pesa number', description: 'Set the branch M-Pesa number customers pay to (Buy Goods till number, or Paybill and account number), set on the till, and the owner is told of every change' },
  // A502: owner's by default — who may void and refund, the void window and the offline rules.
  { key: 'settings.reversals',   group: 'settings', surface: 'web',
    label: 'Void and refund rules', description: 'Who may void and refund, for how long after a sale, and what a till may do offline' },
  { key: 'settings.integrations', group: 'settings', surface: 'web',
    label: 'Integrations', description: 'Webhooks, QR ordering and scheduled report emails' },
  { key: 'settings.pos',         group: 'settings', surface: 'web',
    label: 'POS options', description: 'How the tills work: delivery fee and rider, pay later, pay before kitchen, sign-in codes and loyalty' },
  { key: 'receipt.manage',       group: 'settings', surface: 'both', manager: true,
    label: 'Receipt text', description: 'The receipt\'s header and footer lines' },
  { key: 'stations.manage',      group: 'settings', surface: 'both', manager: true,
    label: 'Printers and print stations', description: 'Printers, kitchen and bar stations and what prints where' },
  { key: 'tables.manage',        group: 'settings', surface: 'web', manager: true,
    label: 'Tables and zones', description: 'The dining tables and floor zones' },
  { key: 'devices.approve',      group: 'settings', surface: 'web', manager: true,
    label: 'Tills and devices', description: 'Approve, rename, retire and remove tills' },
  { key: 'etims.manage',         group: 'settings', surface: 'web',
    label: 'eTIMS / KRA', description: 'eTIMS set-up and KRA device registration' },
  { key: 'changes.approve',      group: 'settings', surface: 'web',
    label: 'Approve till changes', description: 'Approve or refuse menu and staff changes made on a till' },
];

/** Every fine key. */
export const PERMISSION_KEYS: readonly string[] = PERMISSIONS.map((p) => p.key);
const FINE = new Set(PERMISSION_KEYS);

/**
 * The broad keys used before A490, and the fine keys each stood for. Each list reproduces EVERYTHING the broad key
 * allowed anywhere (a route, a screen, a till check), measured from the code on 2026-10-15 — not what its label said.
 */
export const LEGACY: Readonly<Record<string, readonly string[]>> = {
  'reports.view':      ['reports.overview', 'reports.sales', 'reports.items', 'reports.staff', 'reports.shifts',
                        'reports.voids', 'reports.inventory', 'reports.fuel'],
  'reports.financial': ['reports.tax', 'reports.costs', 'reports.labour', 'reports.monthly_pack', 'reports.payments',
                        'reports.export'],
  // Voided, refunded, approved voids/refunds, confirmed drawers (callerMayConfirm), reprinted (isShiftManager).
  'orders.void':       ['sales.void', 'sales.refund', 'shifts.confirm', 'sales.reprint'],
  // Never registered, but checked (shifts.ts, shiftConfirm): confirming drawers and foreign cash.
  'shifts.manage':     ['shifts.confirm'],
  'products.manage':   ['menu.edit', 'menu.prices', 'menu.offers', 'menu.recipes', 'menu.costs',
                        'settings.payments', 'stations.manage'],
  'customers.manage':  ['customers.edit', 'customers.credit'],
  'staff.manage':      ['staff.view', 'staff.edit', 'staff.roles'],
  'settings.manage':   ['settings.business', 'settings.branches', 'settings.payments', 'settings.integrations',
                        'receipt.manage', 'stations.manage', 'tables.manage', 'devices.approve', 'etims.manage',
                        'changes.approve', 'shifts.force_close', 'shifts.close_day', 'shifts.confirm', 'sales.reprint',
                        'settings.mpesa'],
};

/** Keys that, before A490, EVERY signed-in person could use (no check existed). Migration 134 grants them to the
 *  roles that had them in practice; until it has run, expandKeys adds them to every person (`openBefore`). */
export const OPEN_BEFORE_A490: readonly string[] = [
  'sales.discount', 'sales.history_all', 'shifts.cash_movements', 'staff.view',
  'reservations.manage', 'parking.manage', 'fuel.manage',
];

export const isLegacyKey = (k: string): boolean => Object.prototype.hasOwnProperty.call(LEGACY, k);
export const isPermissionKey = (k: string): boolean => FINE.has(k);

/**
 * The fine keys a set of granted keys stands for. '*' stays '*'. Broad keys become their fine keys; unknown keys are
 * dropped. `openBefore` (true until migration 134 has run) adds OPEN_BEFORE_A490 — what nobody was ever refused.
 */
export function expandKeys(keys: Iterable<string> | null | undefined, openBefore = false): Set<string> {
  const out = new Set<string>();
  for (const k of keys ?? []) {
    if (k === '*') { out.add('*'); continue; }
    if (FINE.has(k)) out.add(k);
    const fine = LEGACY[k];
    if (fine) for (const f of fine) out.add(f);
  }
  if (openBefore) for (const k of OPEN_BEFORE_A490) out.add(k);
  return out;
}

/** Carried in every permission map the cloud sends from A490 on. A map WITHOUT it was made before (a till's cached
 *  sign-in, an older branch server's roster): its holder keeps what nobody was refused before (OPEN_BEFORE_A490). */
export const MAP_MARKER = 'catalogue.v2';

/** A permission map ({key: granted}, the shape tills and the web POS hold) as fine keys. A `false` (a per-person
 *  override taking a key away) removes what the key stands for. `openBefore` defaults to "the map predates A490". */
export function expandMap(map: Record<string, unknown> | null | undefined, openBefore?: boolean): Set<string> {
  if (openBefore === undefined) openBefore = !(map && (map as Record<string, unknown>)[MAP_MARKER] === true);
  const granted: string[] = [], denied: string[] = [];
  for (const [k, v] of Object.entries(map ?? {})) (v === true ? granted : v === false ? denied : []).push(k);
  const out = expandKeys(granted, openBefore);
  for (const k of expandKeys(denied)) if (k !== '*') out.delete(k);
  return out;
}

/** Does this person hold `key`? `held` are fine keys (expandKeys / expandMap). */
export function hasPermission(held: ReadonlySet<string> | readonly string[], key: string): boolean {
  const has = (k: string) => (Array.isArray(held) ? (held as readonly string[]).includes(k) : (held as ReadonlySet<string>).has(k));
  return has('*') || has(key);
}

/** Holds ANY of these keys. */
export function hasAnyPermission(held: ReadonlySet<string> | readonly string[], keys: readonly string[]): boolean {
  return keys.some((k) => hasPermission(held, k));
}

/** The broad keys an older client still checks, reported held only when EVERY fine key they stand for is held. */
export function legacyKeysFor(held: ReadonlySet<string>): string[] {
  if (held.has('*')) return [];
  return Object.entries(LEGACY).filter(([, fine]) => fine.length > 0 && fine.every((f) => held.has(f))).map(([k]) => k);
}

/**
 * What a client is sent as its permission map: the fine keys, the broad keys an older build checks (legacyKeysFor),
 * and '*' for the owner. Every value true — a key not held is simply absent.
 */
export function permissionMapFor(held: ReadonlySet<string>): Record<string, true> {
  const out: Record<string, true> = {};
  for (const k of held) out[k] = true;
  for (const k of legacyKeysFor(held)) out[k] = true;
  out[MAP_MARKER] = true;
  return out;
}

/** The default fine keys for a NEW business's role, by the kind of role it is created as. */
export function defaultKeysFor(kind: 'owner' | 'manager' | 'cashier' | 'none'): string[] {
  if (kind === 'owner') return [...PERMISSION_KEYS];
  if (kind === 'none') return [];
  return PERMISSIONS.filter((p) => (kind === 'manager' ? p.manager : p.cashier)).map((p) => p.key);
}

/**
 * A492: may this person set the branch's M-Pesa number? settings.mpesa — and, until migration 134 has run (`openBefore`,
 * or a map that predates A490), receipt.manage as well: that is who could set the receipt's payment line before.
 */
export function maySetMpesa(held: ReadonlySet<string> | readonly string[], openBefore = false): boolean {
  return hasPermission(held, 'settings.mpesa') || (openBefore && hasPermission(held, 'receipt.manage'));
}

/**
 * The keys of the shop floor — what a cashier's role holds by default. A person holding ANY key beyond these is
 * "back office" (isBackOffice): the web sends them to the manager portal, sign-in codes protect them, and their browser
 * needs no device approval. This replaces the role-name lists (manager / supervisor / branch_manager) everywhere.
 */
export const FLOOR_KEYS: readonly string[] = PERMISSIONS.filter((p) => p.cashier).map((p) => p.key);
/**
 * A499: what is used AT THE TILL by whoever sells — never a reason to send a person to the manager screens. Owner,
 * 2026-10-15 (1.0.15, a cashier landing on Settings › Staff): every cashier role held the old customers.manage (migration
 * 99), which stood for customers.edit AND customers.credit — credit is not a cashier default, so every cashier counted as
 * "back office" and the till opened the manager screens on them. Voids, refunds and reprints are the same: a cashier
 * trusted with them still sells.
 */
export const POS_ACTION_KEYS: readonly string[] = ['customers.credit', 'sales.void', 'sales.refund', 'sales.reprint'];
/** What makes nobody back office: the floor, what every person held before A490 (migration 134 keeps it on every role —
 *  the staff list, every cashier's sales — so it says nothing about who is a manager), and the POS actions. */
const FLOOR = new Set([...FLOOR_KEYS, ...OPEN_BEFORE_A490, ...POS_ACTION_KEYS]);

/** Holds anything beyond the shop floor (or is the owner). */
export function isBackOffice(held: ReadonlySet<string> | readonly string[]): boolean {
  const list = Array.isArray(held) ? held as readonly string[] : [...(held as ReadonlySet<string>)];
  return list.some((k) => k === '*' || (FINE.has(k) && !FLOOR.has(k)));
}

/**
 * The ceiling (A340, now by permission rather than role name): a person who is not the owner may give a role or a
 * person only keys they hold themselves. Returns the keys beyond them — empty means allowed.
 */
export function keysBeyond(held: ReadonlySet<string>, wanted: Iterable<string>): string[] {
  if (held.has('*')) return [];
  return [...expandKeys(wanted)].filter((k) => k !== '*' && !held.has(k));
}
