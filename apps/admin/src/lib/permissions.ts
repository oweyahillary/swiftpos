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
  // A520 (owner, 2026-10-17: "break close day and close branch as two, supervisor can have close day but not branch, a
  // manager can both"): Close Day is one till's own day (and the day lock's way out); Close Branch closes every till's.
  { key: 'shifts.close_day',     group: 'drawer', surface: 'both', manager: true,
    label: 'Close the day', description: 'Close the trading day on a till (Close Day) - the way out of the day lock' },
  { key: 'shifts.close_branch',  group: 'drawer', surface: 'till', manager: true,
    label: 'Close the branch', description: 'Close Branch on the branch server: confirm the day totals of every till and close every till day' },

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
  // A518: read-only supplier accounts (the Accountant's). Whoever holds payables.manage sees them already.
  { key: 'payables.view',        group: 'stock', surface: 'web',
    label: 'See supplier bills', description: 'See supplier bills, payments and returns, without recording or paying them' },

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
                        'settings.mpesa', 'shifts.close_branch'],   // A520: settings.manage closed the branch before
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
 * A514: the business types that sell fuel (businesses.type — the admin portal's and onboarding's VALID_TYPES). Only these
 * get the built-in Fuel attendant role.
 */
export const FUEL_BUSINESS_TYPES: readonly string[] = ['petrol_station'];

export interface BuiltInRole {
  /** The role's name as a new business sees it. Matched case- and space-insensitively (lower(trim(name))). */
  name: string;
  /** Shown on Settings › Roles and permissions under the name. */
  description: string;
  /** Its default fine keys — least privilege; the owner may tick more or fewer per role. */
  keys: readonly string[];
  /** Only for these business types (none = every business). */
  types?: readonly string[];
}

/**
 * A514 — the built-in roles every business gets besides the owner's role (owner, 2026-10-16: "Supervisor, Waiter, Kitchen,
 * Storekeeper and any other that a good system should have" — with Accountant and, at a fuel business, Fuel attendant).
 * The ONE place their defaults live: new businesses are seeded from it (lib/defaultRolePermissions.ts) and migration 142
 * adds whichever is missing to every existing business with exactly these keys (scripts/test-migration-142.mjs compares).
 * They are ordinary roles: the owner renames, edits or deletes them on Settings › Roles and permissions.
 *   Manager / Cashier — the catalogue's own manager / cashier defaults (each key's `manager` / `cashier` flag), as before.
 *   Supervisor — sells like a cashier, and approves voids, refunds and sales on account with their PIN, confirms drawers,
 *     closes a till's day (shifts.close_day, A520 — never the branch: shifts.close_branch is the Manager's),
 *     sees every cashier's sales and the branch's sales and shift reports. No settings, staff, roles, costs or stock.
 *   Waiter — takes orders, sends them to the kitchen and takes payment, discounts within the limit. Not the staff list,
 *     not customer credit, no refunds, no reports, no drawer money (the cashier's back-office-free subset).
 *   Kitchen — reads the menu. The kitchen display signs in with its own display token (Settings › Kitchen display), not a
 *     person's keys, so a kitchen role needs nothing more; it never sells, never touches money or customers.
 *   Storekeeper — stock levels, deliveries (suppliers, purchase orders, receiving), transfers, counts, wastage, the stock
 *     report, and cost prices (deliveries carry them). Not inventory.adjust: changing a figure by hand and reviewing
 *     counts is the check ON the storekeeper's counts, so it stays with the owner / manager. No selling.
 *   Accountant — every report (read-only, costs and tax included, and downloads), the orders / shifts pages and the
 *     expenses list, and the supplier bills read-only (payables.view, A518 — migration 143 gives it to the Accountant
 *     roles 142 made). No selling, no edits, no settings, no staff, no paying suppliers (payables.manage).
 *   Fuel attendant — pump sales and the pumps (fuel.manage: active / idle, tank deliveries) and the menu. No discounts,
 *     refunds, reports or drawer money.
 */
const CASHIER_DEFAULT_KEYS: readonly string[] = PERMISSIONS.filter((p) => p.cashier).map((p) => p.key);
const MANAGER_DEFAULT_KEYS: readonly string[] = PERMISSIONS.filter((p) => p.manager).map((p) => p.key);
export const BUILT_IN_ROLES: readonly BuiltInRole[] = [
  { name: 'Manager', description: 'Runs a branch', keys: MANAGER_DEFAULT_KEYS },
  { name: 'Cashier', description: 'Sells at the till', keys: CASHIER_DEFAULT_KEYS },
  { name: 'Supervisor', description: 'Sells, and approves voids, refunds, sales on account and drawers with their PIN',
    keys: [...CASHIER_DEFAULT_KEYS, 'sales.void', 'sales.refund', 'sales.reprint', 'sales.history_all', 'customers.credit',
      'shifts.confirm', 'reports.sales', 'reports.shifts', 'shifts.close_day'] },   // A520: Close Day, not Close Branch
  { name: 'Waiter', description: 'Takes orders, sends them to the kitchen and takes payment',
    keys: ['orders.create', 'sales.discount', 'products.view', 'inventory.view', 'customers.view', 'customers.edit',
      'reservations.manage'] },
  { name: 'Kitchen', description: 'Kitchen staff - reads the menu (the kitchen display has its own sign-in)',
    keys: ['products.view'] },
  { name: 'Storekeeper', description: 'Receives deliveries, transfers, counts and writes off stock',
    keys: ['products.view', 'inventory.view', 'inventory.receive', 'inventory.transfer', 'inventory.count',
      'inventory.waste', 'reports.inventory', 'menu.costs'] },
  { name: 'Accountant', description: 'Reads the books - every report, the orders and the expenses, changes nothing',
    keys: ['reports.overview', 'reports.sales', 'reports.items', 'reports.staff', 'reports.shifts', 'reports.voids',
      'reports.inventory', 'reports.fuel', 'reports.tax', 'reports.costs', 'reports.labour', 'reports.monthly_pack',
      'reports.payments', 'reports.export', 'orders.view_all', 'expenses.view', 'payables.view'] },
  { name: 'Fuel attendant', description: 'Sells fuel at the pumps', keys: ['orders.create', 'products.view', 'fuel.manage'],
    types: FUEL_BUSINESS_TYPES },
];

const roleNameKey = (name: string | null | undefined): string => String(name ?? '').trim().toLowerCase().replace(/[\s_]+/g, ' ');

/** A514: the built-in roles a business of this type gets (besides the owner's role), in the order they are listed. */
export function builtInRolesFor(businessType: string | null | undefined): BuiltInRole[] {
  const t = String(businessType ?? '').trim().toLowerCase();
  return BUILT_IN_ROLES.filter((r) => !r.types || r.types.includes(t));
}

/**
 * A514: the default keys of a role being SEEDED by this name — the owner's role (owner / admin) everything, a built-in role
 * its own keys (Branch manager is the Manager), anything else nothing (a role the owner sets up). Seeding only: from then
 * on the owner decides per role.
 */
export function defaultKeysForRoleName(name: string | null | undefined): string[] {
  const n = roleNameKey(name);
  if (n === 'owner' || n === 'admin') return [...PERMISSION_KEYS];
  const r = BUILT_IN_ROLES.find((b) => roleNameKey(b.name) === n) ?? (n === 'branch manager' ? BUILT_IN_ROLES[0] : undefined);
  return r ? [...new Set(r.keys)] : [];
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
