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
  /** A550: it only lets the person SEE something (a list, a report, a figure, a download) — it changes nothing. Decides
   *  the built-in Auditor (VIEW_KEYS); a new key says which it is here. */
  view?: boolean;
  /** A595: it shows or sets PERSONAL data (Kenya Data Protection Act 2019): phone numbers, e-mails, what a customer bought,
   *  PINs, pay. A "personal data" badge on the Roles screen; never part of the built-in Auditor (VIEW_KEYS). */
  personal?: boolean;
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
  { key: 'sales.discount',       group: 'selling', surface: 'both', manager: true,   // A595 D6 (owner, 2026-10-27): typed discounts off cashiers (set-up ones stay)
    label: 'Give discounts', description: 'Give a discount on a sale, up to the business\'s discount limit' },
  // A595 (owner, 2026-10-26: "break down any right that you feel is too big and exposes data - some can be broken down to
  // view and edit etc."): each key marked as a PART below is one part of a key that exists (SPLITS). The parent keeps its
  // name - a 1.0.21 desktop POS checks it by that name - and migration 176 gives every holder of a parent all its parts.
  { key: 'sales.discount_preset', group: 'selling', surface: 'both', cashier: true, manager: true,
    label: 'Apply set-up discounts and promo codes', description: 'Apply a discount or a promo code the business has set up (typing an amount needs Give discounts)' },
  { key: 'sales.void',           group: 'selling', surface: 'both', manager: true,
    label: 'Void sales', description: 'Void a sale within the void window (with a reason)' },
  { key: 'sales.refund',         group: 'selling', surface: 'both', manager: true,
    label: 'Refund sales', description: 'Refund a completed sale (with a reason)' },
  { key: 'sales.reprint',        group: 'selling', surface: 'both', manager: true,
    label: 'Reprint receipts', description: 'Reprint a receipt from the sales history' },
  { key: 'sales.history_all',    group: 'selling', surface: 'both', view: true, manager: true,
    label: 'See every cashier\'s sales', description: 'The sales history shows every cashier\'s sales, not only their own' },
  { key: 'sales.approve_kitchen_void', group: 'selling', surface: 'both', manager: true,
    label: 'Approve removing items sent to the kitchen', description: 'Approve with their PIN taking an item off an order after it was sent to the kitchen or bar' },
  { key: 'invoice.create',       group: 'selling', surface: 'web', cashier: true, manager: true,
    label: 'Raise invoices', description: 'Raise an invoice for an order or a customer' },

  // ── Drawers and the day ──────────────────────────────────────────────────────────────────────────────────────────
  // A594 (owner, 2026-10-26: "turn off that option for cashiers by default unless allowed" — then "we need to break those
  // permissions further"): A453's switch 'cashier_no_money_out' as three keys, none a cashier default. The key is still
  // named shifts.cash_movements (a 1.0.21 desktop POS checks it by that name) and now means Record cash in; migration 175
  // relabels it and carries every role over (scripts/test-migration-175.mjs). Without a key the POS asks a manager's PIN
  // on the spot for that cash in, cash out or expense — the approver is kept on the entry.
  { key: 'shifts.cash_movements', group: 'drawer', surface: 'both', manager: true,
    label: 'Record cash in', description: 'Put cash into their drawer, with a reason, with nobody approving it (without this, a manager approves each cash in with their PIN)' },
  { key: 'shifts.cash_out',      group: 'drawer', surface: 'both', manager: true,
    label: 'Record cash out / pay-outs', description: 'Take cash out of their drawer, with a reason - a manager approves every one with their PIN' },
  { key: 'expenses.record',      group: 'drawer', surface: 'both', manager: true,
    label: 'Record expenses', description: 'Record an expense paid from their drawer - a manager approves every one with their PIN' },
  { key: 'shifts.confirm',       group: 'drawer', surface: 'both', manager: true,
    label: 'Approve with their PIN', description: 'Approve cash out, expenses and removing items sent to the kitchen, confirm cashiers\' drawers and see the expected cash' },
  { key: 'shifts.approve_payout', group: 'drawer', surface: 'both', manager: true,
    label: 'Approve cash out and drawer expenses with their PIN', description: 'Approve with their PIN a cash out, a pay-out or an expense paid from a drawer, and a cash in by someone without Record cash in' },
  { key: 'shifts.force_close',   group: 'drawer', surface: 'both', manager: true,
    label: 'Force-close a drawer', description: 'Close another person\'s drawer without a cash count (it shows as unreconciled)' },
  // A520 (owner, 2026-10-17: "break close day and close branch as two, supervisor can have close day but not branch, a
  // manager can both"): Close Day is one till's own day (and the day lock's way out); Close Branch closes every till's.
  { key: 'shifts.close_day',     group: 'drawer', surface: 'both', manager: true,
    label: 'Close the day', description: 'Close the trading day on a till (Close Day) - the way out of the day lock' },
  { key: 'shifts.close_branch',  group: 'drawer', surface: 'till', manager: true,
    label: 'Close the branch', description: 'Close Branch on the branch server: confirm the day totals of every till and close every till day' },

  // ── Reports — one key per report ─────────────────────────────────────────────────────────────────────────────────
  { key: 'reports.overview',     group: 'reports', surface: 'both', view: true, manager: true,
    label: 'Overview', description: 'The Overview page: today\'s sales, orders and open drawers' },
  { key: 'reports.sales',        group: 'reports', surface: 'both', view: true, manager: true,
    label: 'Sales reports', description: 'Master / DSR, daily and hourly sales, payment methods and order channels' },
  { key: 'reports.analytics',    group: 'reports', surface: 'web', view: true, manager: true,
    label: 'Analytics', description: 'The Analytics pages: trends, menu engineering, branch comparisons and recommendations (money leaks also need Voids, refunds and exceptions)' },
  { key: 'reports.items',        group: 'reports', surface: 'both', view: true, manager: true,
    label: 'Item mix and menu matrix', description: 'What sold, by product and category' },
  { key: 'reports.staff',        group: 'reports', surface: 'both', view: true, manager: true,
    label: 'Staff performance', description: 'Sales, voids and refunds by cashier' },
  { key: 'reports.shifts',       group: 'reports', surface: 'both', view: true, manager: true,
    label: 'Shift reports and Z-reports', description: 'Each drawer\'s report: expected cash, counted cash and the difference' },
  { key: 'reports.voids',        group: 'reports', surface: 'both', view: true, manager: true,
    label: 'Voids, refunds and exceptions', description: 'Voids and refunds, price differences on offline sales and other exceptions' },
  { key: 'reports.audit',        group: 'reports', surface: 'web', view: true, manager: true,
    label: 'Audit trail', description: 'Download the audit trail of voids, refunds, discounts and other changes, with who made them' },
  { key: 'reports.inventory',    group: 'reports', surface: 'both', view: true, manager: true,
    label: 'Inventory report', description: 'Stock movement and value over a period' },
  { key: 'reports.fuel',         group: 'reports', surface: 'both', view: true, manager: true,
    label: 'Fuel reports', description: 'Fuel sales, wet stock and the pump monitor' },
  { key: 'reports.tax',          group: 'reports', surface: 'web', view: true,
    label: 'Tax report', description: 'VAT and levy by branch and category, and eTIMS invoices' },
  { key: 'reports.costs',        group: 'reports', surface: 'both', view: true,
    label: 'Costs, margins and profit', description: 'Food cost, cost prices, margins, net profit and profit and loss' },
  { key: 'reports.labour',       group: 'reports', surface: 'web', view: true,
    label: 'Labour cost', description: 'Sales per labour hour and labour cost' },
  { key: 'reports.monthly_pack', group: 'reports', surface: 'both', view: true,
    label: 'Monthly pack', description: 'The monthly books: daily sales, expenses, cash and M-Pesa books' },
  { key: 'reports.payments',     group: 'reports', surface: 'web', view: true,
    label: 'Payment exceptions', description: 'M-Pesa payments that did not match a sale' },
  { key: 'reports.export',       group: 'reports', surface: 'both', view: true,
    label: 'Download reports', description: 'Download Excel and the exports (sales, items, shifts, profit and loss, expenses, audit)' },

  // ── Orders (back office) ─────────────────────────────────────────────────────────────────────────────────────────
  { key: 'orders.view_all',      group: 'orders', surface: 'both', view: true, manager: true,
    label: 'Orders, shifts and turnover pages', description: 'See every order of the branch, its shifts and table turnover' },

  // ── Menu ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  { key: 'products.view',        group: 'menu', surface: 'both', view: true, cashier: true, manager: true,
    label: 'See the menu', description: 'Read the menu and its prices' },
  { key: 'menu.edit',            group: 'menu', surface: 'both',
    label: 'Edit the menu', description: 'Add and change products, categories, variants, choices, extras and combos' },
  { key: 'menu.delete',          group: 'menu', surface: 'both',
    label: 'Delete products, categories and menus', description: 'Delete products, categories, menus, variants, choices, extras and combos' },
  { key: 'menu.bulk',            group: 'menu', surface: 'both',
    label: 'Bulk changes to the menu', description: 'Import products from a spreadsheet, change the tax or stock tracking of many items at once and generate barcodes' },
  { key: 'menu.prices',          group: 'menu', surface: 'both',
    label: 'Change prices', description: 'Change selling prices, branch prices and bulk prices' },
  { key: 'menu.offers',          group: 'menu', surface: 'both', manager: true,
    label: 'Discounts and offers', description: 'Set up discounts, promotions and offers' },
  // A502: owner's by default (no role starts with it) — a promotion runs at every branch; the owner may give it to someone.
  { key: 'menu.promotions',      group: 'menu', surface: 'web',
    label: 'Promotions', description: 'Create, change and delete promotions, which run at every branch' },
  { key: 'menu.recipes',         group: 'menu', surface: 'web',
    label: 'Recipes and packaging', description: 'What each product uses from stock' },
  { key: 'menu.costs',           group: 'menu', surface: 'both', view: true,
    label: 'See cost prices', description: 'Cost prices and margins wherever they appear (menu, deliveries, stock)' },
  { key: 'menu.costs_edit',      group: 'menu', surface: 'both',
    label: 'Change cost prices', description: 'Change the cost price of products, one at a time or many at once' },

  // ── Stock ────────────────────────────────────────────────────────────────────────────────────────────────────────
  { key: 'inventory.view',       group: 'stock', surface: 'both', view: true, cashier: true, manager: true,
    label: 'See stock levels', description: 'Stock levels of the branch' },
  { key: 'inventory.receive',    group: 'stock', surface: 'both', manager: true,
    label: 'Receive deliveries', description: 'Suppliers, purchase orders and receiving deliveries' },
  { key: 'suppliers.manage',     group: 'stock', surface: 'both', manager: true,
    label: 'Add, change and remove suppliers', description: 'Supplier records: names, contacts and payment details (seeing the suppliers comes with Receive deliveries)' },
  { key: 'inventory.order',      group: 'stock', surface: 'both', manager: true,
    label: 'Purchase orders', description: 'Raise, change and cancel purchase orders to suppliers' },
  { key: 'inventory.reorder',    group: 'stock', surface: 'both', manager: true,
    label: 'Reorder levels', description: 'Set the low-stock level of products and ingredients' },
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
  { key: 'inventory.count_review', group: 'stock', surface: 'web',
    label: 'Review and post stock counts', description: 'See the expected figures of a stock count, ask for a recount and post the count to stock' },
  { key: 'ingredients.manage',   group: 'stock', surface: 'web',
    label: 'Ingredient list', description: 'Add and change ingredients' },
  { key: 'payables.manage',      group: 'stock', surface: 'web',
    label: 'Supplier bills and payments', description: 'What is owed to suppliers, their bills and paying them' },
  { key: 'payables.pay',         group: 'stock', surface: 'web',
    label: 'Pay suppliers', description: 'Record a payment to a supplier and void one' },
  // A518: read-only supplier accounts (the Accountant's). Whoever holds payables.manage sees them already.
  { key: 'payables.view',        group: 'stock', surface: 'web', view: true,
    label: 'See supplier bills', description: 'See supplier bills, payments and returns, without recording or paying them' },

  // ── Customers ────────────────────────────────────────────────────────────────────────────────────────────────────
  { key: 'customers.view',       group: 'customers', surface: 'both', view: true, cashier: true, manager: true,
    label: 'See customers', description: 'Customer records, points and credit balances' },
  { key: 'customers.contacts',   group: 'customers', surface: 'both', view: true, personal: true, cashier: true, manager: true,   // A595 D1: cashiers keep them
    label: 'See customer phone numbers and e-mails', description: 'Full phone numbers and e-mail addresses wherever customers appear: lists, credit, orders, M-Pesa payers and Analytics (without it they are masked - finding a customer by typing their number still works)' },
  { key: 'customers.history',    group: 'customers', surface: 'both', view: true, personal: true, cashier: true, manager: true,   // A595 D1
    label: 'See what a customer bought', description: 'A customer purchases, visits and insights' },
  { key: 'customers.edit',       group: 'customers', surface: 'both', cashier: true, manager: true,
    label: 'Add and edit customers', description: 'Add customers and change their details' },
  { key: 'customers.delete',     group: 'customers', surface: 'web', manager: true,
    label: 'Remove customers', description: 'Remove a customer record (also how a request to erase the data of a customer is honoured)' },
  { key: 'customers.credit',     group: 'customers', surface: 'both', manager: true,
    label: 'Customer credit', description: 'Approve sales on account with their PIN, set credit limits, record repayments and adjust balances' },   // A511
  { key: 'customers.credit_payment', group: 'customers', surface: 'both', manager: true,
    label: 'Record credit repayments', description: 'Record a payment a customer makes towards what they owe on account' },
  { key: 'customers.credit_adjust', group: 'customers', surface: 'both', /* A595 D9: not a new Manager's */
    label: 'Adjust or write off credit balances', description: 'Correct the balance of a customer on account or write it off, with a reason' },
  // A595: was a rule by role NAME (lib/creditApprovers.ts, A585 / A587); migration 176 gives it to exactly who set limits.
  { key: 'customers.credit_limit', group: 'customers', surface: 'both', manager: true,
    label: 'Set credit limits', description: 'Give, change or remove the credit limit of a customer on account' },

  // ── Expenses ─────────────────────────────────────────────────────────────────────────────────────────────────────
  { key: 'expenses.view',        group: 'expenses', surface: 'both', view: true, manager: true,
    label: 'See expenses', description: 'The expenses list and its totals' },
  { key: 'expenses.manage',      group: 'expenses', surface: 'both', manager: true,
    label: 'Record expenses', description: 'Record, change and remove expenses and expense types, and record entries in the monthly pack' },
  { key: 'expenses.edit',        group: 'expenses', surface: 'both', /* A595 D9: not a new Manager's */
    label: 'Change or remove recorded expenses', description: 'Change or remove an expense that was already recorded' },
  { key: 'expenses.types',       group: 'expenses', surface: 'both', manager: true,
    label: 'Expense types', description: 'Add, rename and remove expense types' },
  { key: 'expenses.monthly',     group: 'expenses', surface: 'both', /* A595 D9: not a new Manager's */
    label: 'Monthly pack entries', description: 'Record and remove entries in the cash and M-Pesa books of the monthly pack' },

  // ── Staff ────────────────────────────────────────────────────────────────────────────────────────────────────────
  { key: 'staff.view',           group: 'staff', surface: 'both', view: true, manager: true,
    label: 'See staff', description: 'The staff list of their branch' },
  { key: 'staff.contacts',       group: 'staff', surface: 'both', view: true, personal: true, manager: true,
    label: 'See staff phone numbers and e-mails', description: 'Phone numbers and e-mail addresses on the staff list (without it they are hidden)' },
  { key: 'staff.edit',           group: 'staff', surface: 'both', manager: true,
    label: 'Add and edit staff', description: 'Add staff, set PINs and branches, and deactivate staff — never with more rights than they hold themselves' },
  { key: 'staff.pins',           group: 'staff', surface: 'both', personal: true, manager: true,
    label: 'Set and reset PINs and sign-in codes', description: 'Set the PIN and the approval PIN of staff and reset their sign-in codes' },
  { key: 'staff.access',         group: 'staff', surface: 'both', /* A595 D9: not a new Manager's */
    label: 'Give a person their own rights', description: 'Give or take away rights for one person beyond their role - never more than they hold themselves' },
  { key: 'staff.pay',            group: 'staff', surface: 'web', personal: true, /* A595 D9: not a new Manager's */
    label: 'Set staff pay rates', description: 'The hourly pay rate of each person' },
  { key: 'staff.roles',          group: 'staff', surface: 'web',
    label: 'Roles and permissions', description: 'Change what each role may see and do — never beyond what they hold themselves' },

  // ── Front of house ───────────────────────────────────────────────────────────────────────────────────────────────
  { key: 'reservations.manage',  group: 'front', surface: 'web', cashier: true, manager: true,
    label: 'Reservations and waitlist', description: 'Take and change reservations and the waitlist' },
  { key: 'parking.manage',       group: 'front', surface: 'both', cashier: true, manager: true,
    label: 'Parking', description: 'Open, close and void parking tickets' },
  { key: 'parking.void',         group: 'front', surface: 'both', manager: true,
    label: 'Void parking tickets', description: 'Void a parking ticket, with a reason' },
  { key: 'fuel.manage',          group: 'front', surface: 'both', cashier: true, manager: true,
    label: 'Fuel pumps and tanks', description: 'Set pumps active or idle, record tank deliveries and set up pumps and tanks' },
  { key: 'fuel.deliveries',      group: 'front', surface: 'both', manager: true,
    label: 'Record fuel deliveries', description: 'Record a delivery of fuel into a tank' },
  { key: 'fuel.setup',           group: 'front', surface: 'both', manager: true,
    label: 'Set up pumps and tanks', description: 'Add, change and remove pumps and tanks' },

  // ── Settings ─────────────────────────────────────────────────────────────────────────────────────────────────────
  { key: 'settings.business',    group: 'settings', surface: 'both',
    label: 'Business settings', description: 'Business profile, receipt and history rules, opening hours and tax rates' },
  { key: 'settings.tax',         group: 'settings', surface: 'both',
    label: 'Tax rates', description: 'The VAT and levy rates' },
  { key: 'settings.sales_rules',  group: 'settings', surface: 'both',
    label: 'Discount limit and selling rules', description: 'The discount limit, continuous operation and how the sales history is shown to cashiers' },
  { key: 'settings.branches',    group: 'settings', surface: 'web',
    label: 'Branches', description: 'Branch details and each branch\'s own settings' },
  { key: 'settings.payments',    group: 'settings', surface: 'both',
    label: 'Payment methods', description: 'Which payment methods each branch takes, and the business\'s own methods' },
  { key: 'settings.mpesa',       group: 'settings', surface: 'till', /* A595 D9: not a new Manager's */
    label: 'M-Pesa number', description: 'Set the branch M-Pesa number customers pay to (Buy Goods till number, or Paybill and account number), set on the till, and the owner is told of every change' },
  // A502: owner's by default — who may void and refund, the void window and the offline rules.
  { key: 'settings.reversals',   group: 'settings', surface: 'web',
    label: 'Void and refund rules', description: 'Who may void and refund, for how long after a sale, and what a till may do offline' },
  { key: 'settings.integrations', group: 'settings', surface: 'web',
    label: 'Integrations', description: 'Webhooks, QR ordering and scheduled report emails' },
  { key: 'settings.webhooks',    group: 'settings', surface: 'web',
    label: 'Webhooks (send sales to another system)', description: 'Send every sale, with customer details, to another system at an address they choose' },
  { key: 'settings.report_emails', group: 'settings', surface: 'web',
    label: 'Scheduled report e-mails', description: 'E-mail reports on a schedule to any address' },
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
  { key: 'devices.view',         group: 'settings', surface: 'web', view: true, manager: true,
    label: 'See the POS devices', description: 'The list of POS devices, their state and the fleet' },
  { key: 'devices.retire',       group: 'settings', surface: 'web', /* A595 D9: not a new Manager's */
    label: 'Retire, remove or hand over POS devices', description: 'Retire a POS device, bring one back, remove one or authorise a hand-over to new hardware' },
  { key: 'etims.manage',         group: 'settings', surface: 'web',
    label: 'eTIMS / KRA', description: 'eTIMS set-up and KRA device registration' },
  { key: 'changes.approve',      group: 'settings', surface: 'web',
    label: 'Approve till changes', description: 'Approve or refuse menu and staff changes made on a till' },
  { key: 'changes.approve_staff', group: 'settings', surface: 'web',
    label: 'Approve staff changes made on a POS', description: 'Approve or refuse new staff and PIN changes made on a POS' },
];

/** Every fine key. */
export const PERMISSION_KEYS: readonly string[] = PERMISSIONS.map((p) => p.key);
const FINE = new Set(PERMISSION_KEYS);
/** A550: the keys that only show something (`view`) — everything a non-owner can be given to SEE, nothing that changes.
 *  A595: and nothing personal (`personal`) — an outside auditor needs the figures, not phone numbers. */
export const VIEW_KEYS: readonly string[] = PERMISSIONS.filter((p) => p.view && !p.personal).map((p) => p.key);
/** A595: the keys that show or set personal data (the Roles screen's "personal data" badge). */
export const PERSONAL_KEYS: readonly string[] = PERMISSIONS.filter((p) => p.personal).map((p) => p.key);

/**
 * A595 — the keys that were too broad, and their PARTS. Owner, 2026-10-26: "implement the changes and break down any right
 * that you feel is too big and exposes data — some can be broken down to view and edit etc." (docs/PERMISSIONS-AUDIT.md).
 *
 * A parent keeps its name and what a 1.0.21 desktop POS checks by it; each part guards one piece the parent used to guard
 * too (the cloud checks the part). Nobody gains or loses anything on the day: migration 176 gives every role and every
 * per-person override holding a parent all of its parts (a taken-away parent becomes taken-away parts), and until 176 is
 * recorded — and for a token or a map made before A595 — the parent still brings its parts (withParts). After that the
 * owner unticks a part per role or per person. inventory.reorder is a part of two parents (reorder levels were open to
 * both receiving and adjusting); staff.contacts of two (the staff list, and editing staff, showed them).
 */
export const SPLITS: Readonly<Record<string, readonly string[]>> = {
  'sales.discount':        ['sales.discount_preset'],
  'shifts.confirm':        ['shifts.approve_payout', 'sales.approve_kitchen_void'],
  'reports.sales':         ['reports.analytics'],
  'reports.voids':         ['reports.audit'],
  'menu.edit':             ['menu.delete', 'menu.bulk'],
  'menu.costs':            ['menu.costs_edit'],
  'inventory.receive':     ['suppliers.manage', 'inventory.order', 'inventory.reorder'],
  'inventory.adjust':      ['inventory.count_review', 'inventory.reorder'],
  'payables.manage':       ['payables.pay'],
  'customers.view':        ['customers.contacts', 'customers.history'],
  'customers.edit':        ['customers.delete'],
  'customers.credit':      ['customers.credit_payment', 'customers.credit_adjust'],
  'expenses.manage':       ['expenses.edit', 'expenses.types', 'expenses.monthly'],
  'staff.view':            ['staff.contacts'],
  'staff.edit':            ['staff.contacts', 'staff.pins', 'staff.access', 'staff.pay'],
  'parking.manage':        ['parking.void'],
  'fuel.manage':           ['fuel.deliveries', 'fuel.setup'],
  'settings.business':     ['settings.tax', 'settings.sales_rules'],
  'settings.integrations': ['settings.webhooks', 'settings.report_emails'],
  'devices.approve':       ['devices.view', 'devices.retire'],
  'changes.approve':       ['changes.approve_staff'],
};
/** A595: the parents of each part (most have one). */
export const PARENTS_OF: Readonly<Record<string, readonly string[]>> = (() => {
  const out: Record<string, string[]> = {};
  for (const [parent, parts] of Object.entries(SPLITS)) for (const c of parts) (out[c] ??= []).push(parent);
  return out;
})();
/** A595: the parts of a key (none for a key that was not split). */
export const partsOf = (key: string): readonly string[] => SPLITS[key] ?? [];
/** A595: the parent a part is listed under on the Roles screen (its first parent), or null for a key that is not a part. */
export const parentOf = (key: string): string | null => PARENTS_OF[key]?.[0] ?? null;
/**
 * A595: the keys with every part of a held parent added — what a parent meant before the split. Used only where the old
 * meaning must hold: until migration 176 is recorded (the cloud's splitsPending), for a token or map made before A595, and
 * for a broad key (LEGACY). Never on stored grants after 176: there a part not held was taken away on purpose.
 */
export function withParts(keys: Iterable<string>): Set<string> {
  const out = new Set(keys);
  for (const k of [...out]) for (const c of partsOf(k)) out.add(c);
  return out;
}
/**
 * A595: the Roles screen's three columns per area — SEE (a list, a report, a figure), DO (add, change, sell, record) and
 * APPROVE (with their PIN, or someone else's request). Display only: it decides nothing.
 */
export type PermissionKind = 'see' | 'do' | 'approve';
const APPROVE_KEYS = new Set(['shifts.confirm', 'shifts.approve_payout', 'sales.approve_kitchen_void', 'customers.credit',
  'changes.approve', 'changes.approve_staff', 'devices.approve']);
export function permissionKind(key: string): PermissionKind {
  if (APPROVE_KEYS.has(key)) return 'approve';
  return PERMISSIONS.find((p) => p.key === key)?.view ? 'see' : 'do';
}

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
export function expandKeys(keys: Iterable<string> | null | undefined, openBefore = false, partsBefore = false): Set<string> {
  const out = new Set<string>();
  for (const k of keys ?? []) {
    if (k === '*') { out.add('*'); continue; }
    if (FINE.has(k)) out.add(k);
    const fine = LEGACY[k];
    // A595: a broad key stood for everything its fine keys did before the split — their parts too.
    if (fine) for (const f of withParts(fine)) out.add(f);
  }
  if (openBefore) for (const k of OPEN_BEFORE_A490) out.add(k);
  // A595: before migration 176 (or for a token made before A595) a parent still brings its parts.
  if (partsBefore) for (const k of withParts(out)) out.add(k);
  return out;
}

/** Carried in every permission map the cloud sends from A490 on. A map WITHOUT it was made before (a till's cached
 *  sign-in, an older branch server's roster): its holder keeps what nobody was refused before (OPEN_BEFORE_A490). */
export const MAP_MARKER = 'catalogue.v2';

/** A permission map ({key: granted}, the shape tills and the web POS hold) as fine keys. A `false` (a per-person
 *  override taking a key away) removes what the key stands for. `openBefore` defaults to "the map predates A490". */
export function expandMap(map: Record<string, unknown> | null | undefined, openBefore?: boolean, partsBefore = false): Set<string> {
  if (openBefore === undefined) openBefore = !(map && (map as Record<string, unknown>)[MAP_MARKER] === true);
  const granted: string[] = [], denied: string[] = [];
  for (const [k, v] of Object.entries(map ?? {})) (v === true ? granted : v === false ? denied : []).push(k);
  const out = expandKeys(granted, openBefore);
  for (const k of expandKeys(denied)) if (k !== '*') out.delete(k);
  // A595: before the split (partsBefore) every parent still held brings its parts — so a taken-away parent takes away
  // what only it brought, and a part another held parent brings stays (staff.contacts: seeing OR editing staff). A part
  // taken away by its own entry stays away.
  if (partsBefore) for (const k of withParts(out)) if (!denied.includes(k)) out.add(k);
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
/**
 * A580 (owner, 2026-10-23: "how can shops have waiter and kitchen roles unless requested keep them off we only have
 * cashier and other roles"): the business types that run a kitchen and serve at tables (shared/businessTerms.ts
 * FOOD_SERVICE_TYPES). Only these get the built-in Waiter, Kitchen and Kitchen Manager roles; a shop (retail, minimart),
 * a petrol station, a car park or "other" does not. Migration 169 takes the unused ones off existing shops.
 */
export const FOOD_BUSINESS_TYPES: readonly string[] = ['restaurant', 'cafe'];

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
 *
 * A550 (owner, 2026-10-21, with partner login: "add general manager, ops manager, accountant and any user you feel will be
 * needed") — five more, for the people an owner lets into the web dashboard (web dashboard access, lib/webPartners.ts) as
 * well as for the till. Migration 159 adds them to every existing business (scripts/test-migration-159.mjs compares).
 * Nothing that is the OWNER's by design is a key, so no role can carry it: the owner's password, account and role, giving
 * or taking web dashboard access, the M-Pesa credentials, the sign-in-code switch and the kitchen display key stay the
 * owner's whatever a role holds.
 *   General Manager — runs the whole business day to day: EVERY key of the catalogue (PERMISSION_KEYS), the three the owner
 *     keeps by default (A502: menu.promotions, inventory.count_freeze, settings.reversals) included — the role an owner
 *     means by "full rights like an owner". Still never the owner: the ceiling (lib/roleCeiling.ts) keeps them from the
 *     owner's role and from anyone holding more than they do, and they never change their own access.
 *   Operations Manager — runs operations: the menu (menu.edit, menu.prices, menu.offers, menu.recipes; menu.costs because
 *     deliveries and recipes carry cost prices), stock (receive, transfer, count, waste, inventory.adjust — the count review
 *     — and the ingredient list), the kitchen and the floor (stations.manage, tables.manage, changes.approve for menu and
 *     staff changes made on a till), drawers and the day (shifts.close_day, shifts.close_branch, shifts.force_close), the
 *     staff list and staff (staff.view, staff.edit — within their own keys), front of house (reservations, parking,
 *     fuel.manage), and the operational reports (overview, sales, items, inventory, shifts, voids, fuel, the orders pages,
 *     every cashier's sales). NOT finance: no tax, cost / profit, labour, monthly-pack, payment or download reports, no
 *     supplier bills (payables.*), no expenses, no shifts.confirm (it approves cash out and expenses), no customer credit,
 *     no roles (staff.roles), no business, payment, M-Pesa, receipt or integration settings, no devices, no selling.
 *   Finance Manager — the Accountant who also acts: every Accountant key, plus payables.manage (supplier bills and paying
 *     them), expenses.manage (recording expenses), customers.view and customers.credit (credit limits, repayments,
 *     adjustments, approving sales on account) and shifts.confirm (confirming drawers — the cash side of reconciling — and
 *     approving cash out and expenses; it also approves a kitchen removal with their PIN, which the catalogue keeps in the
 *     same key). Payment reconciliation is the Accountant's reports.payments. No selling, menu, stock edits or staff.
 *   Auditor — reads everything a non-owner can be shown and changes nothing: exactly VIEW_KEYS (each key's `view` flag —
 *     every report and the downloads, the orders and shifts pages, every cashier's sales, the menu and cost prices, stock
 *     levels, supplier bills, customers, expenses and the staff list). The catalogue has no settings-view key, so the
 *     settings pages are not theirs. For an outside auditor given web dashboard access.
 *   Kitchen Manager — runs the kitchen: the menu (products.view, menu.edit, menu.recipes, menu.costs) and its ingredients
 *     (ingredients.manage), receiving, counting and writing off stock (inventory.view, .receive, .count, .waste), the stock
 *     report (reports.inventory), and the kitchen and bar print stations (stations.manage — the kitchen display key itself
 *     is the owner's). No prices, money, selling, transfers or staff.
 */
const CASHIER_DEFAULT_KEYS: readonly string[] = PERMISSIONS.filter((p) => p.cashier).map((p) => p.key);
const MANAGER_DEFAULT_KEYS: readonly string[] = PERMISSIONS.filter((p) => p.manager).map((p) => p.key);
const ACCOUNTANT_KEYS: readonly string[] = ['reports.overview', 'reports.sales', 'reports.items', 'reports.staff', 'reports.shifts',
  'reports.voids', 'reports.inventory', 'reports.fuel', 'reports.tax', 'reports.costs', 'reports.labour', 'reports.monthly_pack',
  'reports.payments', 'reports.export', 'orders.view_all', 'expenses.view', 'payables.view',
  'reports.analytics', 'reports.audit'];   // A595: the parts of reports.sales / reports.voids an accountant reads
export const BUILT_IN_ROLES: readonly BuiltInRole[] = [
  { name: 'Manager', description: 'Runs a branch', keys: MANAGER_DEFAULT_KEYS },
  { name: 'Cashier', description: 'Sells at the till', keys: CASHIER_DEFAULT_KEYS },
  { name: 'Supervisor', description: 'Sells, and approves voids, refunds, sales on account and drawers with their PIN',
    keys: [...CASHIER_DEFAULT_KEYS, 'sales.discount', 'shifts.cash_movements', 'shifts.cash_out', 'expenses.record', 'sales.void',   // A594
      'sales.refund', 'sales.reprint', 'sales.history_all', 'customers.credit', 'shifts.confirm', 'reports.sales', 'reports.shifts', 'shifts.close_day',   // A520: Close Day, not Close Branch
      // A595: repayments and the two PIN approvals; not Analytics (the premium area is for managers).
      'customers.credit_payment', 'shifts.approve_payout', 'sales.approve_kitchen_void'] },
  { name: 'Waiter', description: 'Takes orders, sends them to the kitchen and takes payment',
    keys: ['orders.create', 'sales.discount', 'sales.discount_preset', 'products.view', 'inventory.view', 'customers.view', 'customers.contacts', 'customers.history', 'customers.edit',
      'reservations.manage'], types: FOOD_BUSINESS_TYPES },   // A580: restaurants and cafés only
  { name: 'Kitchen', description: 'Kitchen staff - reads the menu (the kitchen display has its own sign-in)',
    keys: ['products.view'], types: FOOD_BUSINESS_TYPES },   // A580
  { name: 'Storekeeper', description: 'Receives deliveries, transfers, counts and writes off stock',
    keys: ['products.view', 'inventory.view', 'inventory.receive', 'inventory.transfer', 'inventory.count',
      'inventory.waste', 'reports.inventory', 'menu.costs', 'inventory.reorder'] },   // A595: sees cost prices, never changes them
  { name: 'Accountant', description: 'Reads the books - every report, the orders and the expenses, changes nothing',
    keys: ACCOUNTANT_KEYS },
  { name: 'Fuel attendant', description: 'Sells fuel at the pumps', keys: ['orders.create', 'products.view', 'fuel.manage'],
    types: FUEL_BUSINESS_TYPES },
  // ── A550 ──
  { name: 'General Manager', description: 'Runs the whole business day to day - every permission, never the owner',
    // A595 D3 (owner, 2026-10-27): webhooks are the owner's alone; who receives the report e-mails the owner's and partners'.
    keys: PERMISSION_KEYS.filter((k) => k !== 'settings.webhooks' && k !== 'settings.report_emails') },
  { name: 'Operations Manager', description: 'Runs operations - menu, stock, kitchen, shifts and the day, staff and the operational reports',
    keys: ['products.view', 'menu.edit', 'menu.prices', 'menu.offers', 'menu.recipes', 'menu.costs',
      'inventory.view', 'inventory.receive', 'inventory.transfer', 'inventory.count', 'inventory.waste', 'inventory.adjust',
      'ingredients.manage', 'stations.manage', 'tables.manage', 'changes.approve',
      'shifts.close_day', 'shifts.close_branch', 'shifts.force_close', 'staff.view', 'staff.edit',
      'reservations.manage', 'parking.manage', 'fuel.manage',
      'reports.overview', 'reports.sales', 'reports.items', 'reports.inventory', 'reports.shifts', 'reports.voids',
      'reports.fuel', 'orders.view_all', 'sales.history_all',
      // A595: the operational parts — not per-person rights, pay rates, the audit trail or approving staff changes.
      'menu.costs_edit', 'menu.delete', 'menu.bulk', 'suppliers.manage', 'inventory.order', 'inventory.reorder',
      'inventory.count_review', 'staff.contacts', 'staff.pins', 'parking.void', 'fuel.deliveries', 'fuel.setup',
      'reports.analytics', 'devices.view'] },
  { name: 'Finance Manager', description: 'The accountant who acts - pays suppliers, records expenses, customer credit and drawer checks',
    keys: [...ACCOUNTANT_KEYS, 'payables.manage', 'expenses.manage', 'customers.view', 'customers.credit', 'shifts.confirm',
      // A595: paying suppliers, every expense part, phone numbers (to chase a balance), credit repayments and write-offs,
      // pay-out approvals and pay rates — not kitchen removals (finance confirms drawers, not the kitchen).
      'payables.pay', 'expenses.edit', 'expenses.types', 'expenses.monthly', 'customers.contacts', 'customers.credit_payment',
      'customers.credit_adjust', 'shifts.approve_payout', 'staff.pay'] },
  { name: 'Auditor', description: 'Sees every report, list and figure a non-owner can be shown, changes nothing',
    keys: VIEW_KEYS },
  { name: 'Kitchen Manager', description: 'Runs the kitchen - the menu and recipes, receiving, counting and writing off stock',
    keys: ['products.view', 'menu.edit', 'menu.recipes', 'menu.costs', 'ingredients.manage', 'inventory.view',
      'inventory.receive', 'inventory.count', 'inventory.waste', 'reports.inventory', 'stations.manage',
      'menu.costs_edit', 'inventory.order', 'inventory.reorder'],   // A595: not deleting the menu, bulk changes or suppliers
    types: FOOD_BUSINESS_TYPES },   // A580
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
const FLOOR = withParts([...FLOOR_KEYS, ...OPEN_BEFORE_A490, ...POS_ACTION_KEYS]);   // A595: and their parts (176 gives them to every cashier)

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
