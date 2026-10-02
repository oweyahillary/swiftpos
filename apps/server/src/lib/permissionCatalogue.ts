/**
 * permissionCatalogue — the single source of truth for every permission key the
 * app uses, plus a boot-time self-heal that guarantees the live DB catalogue is
 * complete.
 *
 * WHY (A213): permission keys were registered piecemeal across migrations. A
 * consolidated-dump bootstrap can mark those migrations "applied" while their rows
 * are absent (the A211/A212/A220 root), so the live `permissions` table ends up
 * missing keys. An unregistered key can never attach to a role, so
 * `requirePermission` fails closed and the matching nav item silently disappears —
 * exactly the manager-portal breakage we chased. `seedDefaultRolePermissions`
 * makes it worse: it derives grants from whatever is *live*, so a missing key is
 * silently never granted.
 *
 * The durable fix is here: one canonical list, registered idempotently on every
 * boot (INSERT ... ON CONFLICT (key) DO NOTHING). Any DB that is missing a key —
 * for any reason — heals on the next deploy, for every tenant at once (the
 * catalogue is global; it has no business_id). Adding a new permission is a
 * one-line edit here, and `check-permission-catalogue` fails CI if code ever
 * references a key that is not in this list.
 *
 * Registration only — this never grants anything and never overwrites an existing
 * row (DO NOTHING), so it can't disturb an owner's configured rights.
 */

import { supabase } from './supabase';

export interface PermissionDef {
  key: string;
  label: string;
  module: string;
  description: string;
}

/**
 * Every permission key in the system. Keep this in sync with the code — the
 * `check-permission-catalogue` gate enforces that every key referenced anywhere
 * (server enforcement, UI nav gates, hasPermission calls, the default-role sets)
 * appears here.
 */
export const PERMISSION_CATALOGUE: PermissionDef[] = [
  // Orders
  { key: 'orders.create',    label: 'Create orders',            module: 'orders',    description: 'Ring up and create orders at the POS' },
  { key: 'orders.view_all',  label: 'View all orders',          module: 'orders',    description: 'See every order, not only your own' },
  { key: 'orders.void',      label: 'Void orders',              module: 'orders',    description: 'Void or cancel an order' },
  { key: 'invoice.create',   label: 'Create invoices',          module: 'orders',    description: 'Raise an invoice for an order or customer' },
  // Products / menu
  { key: 'products.view',    label: 'View products & menu',     module: 'products',  description: 'Read-only view of the product/menu catalogue' },
  { key: 'products.manage',  label: 'Manage products',          module: 'products',  description: 'Create, edit and deactivate products' },
  // Inventory
  { key: 'inventory.view',     label: 'View inventory',                 module: 'inventory', description: 'See branch stock levels' },
  { key: 'inventory.receive',  label: 'Receive stock',                  module: 'inventory', description: 'Receive deliveries and incoming transfers' },
  { key: 'inventory.transfer', label: 'Transfer stock between branches', module: 'inventory', description: 'Create and receive branch stock transfers' },
  { key: 'inventory.adjust',   label: 'Adjust stock levels',            module: 'inventory', description: 'Manually change a stock quantity (owner-only by default)' },
  { key: 'ingredients.manage', label: 'Manage ingredient catalogue',    module: 'inventory', description: 'Create and edit the ingredient catalogue' },
  // Customers
  { key: 'customers.view',   label: 'View customers & credit',   module: 'customers', description: 'View customer records and credit balances' },
  { key: 'customers.manage', label: 'Manage customers & credit', module: 'customers', description: 'Create/edit customers and manage credit' },
  // Reports
  { key: 'reports.view',      label: 'View reports',            module: 'reports',   description: 'Operational reports (sales, shifts, item mix)' },
  { key: 'reports.financial', label: 'View financial reports',  module: 'reports',   description: 'Financial reports, margins, tax and exports (owner-only by default)' },
  // Expenses
  { key: 'expenses.view',    label: 'View expenses',            module: 'expenses',  description: 'View recorded expenses' },
  { key: 'expenses.manage',  label: 'Manage expenses',          module: 'expenses',  description: 'Record and edit expenses' },
  // Staff / shifts
  { key: 'staff.manage',       label: 'Manage staff',           module: 'staff',     description: 'Create staff, assign roles and PINs' },
  { key: 'shifts.force_close', label: 'Force-close a drawer',   module: 'shifts',    description: 'Force-close another user\u2019s open shift/drawer' },
  // Settings
  { key: 'settings.manage',  label: 'Manage business settings', module: 'settings',  description: 'Business configuration (owner-only by default)' },
  { key: 'stations.manage',  label: 'Manage print stations',    module: 'settings',  description: 'Configure printers and kitchen/bar routing' },
  { key: 'tables.manage',    label: 'Manage tables and zones',  module: 'settings',  description: 'Configure tables and floor zones' },
  { key: 'receipt.manage',   label: 'Edit receipt text',        module: 'settings',  description: 'Edit receipt header/footer text' },
  { key: 'devices.approve',  label: 'Approve and revoke terminals', module: 'settings', description: 'Approve or revoke POS terminals' },
  { key: 'etims.manage',     label: 'Manage eTIMS / KRA',       module: 'settings',  description: 'Configure eTIMS / KRA integration' },
];

/** All canonical keys, for quick membership checks. */
export const PERMISSION_KEYS: ReadonlySet<string> = new Set(PERMISSION_CATALOGUE.map(p => p.key));

/**
 * Idempotently register every canonical key in the live catalogue. Safe to run on
 * every boot: it never overwrites an existing row and never grants anything. Never
 * throws — a shop's tills must not fail to start over this (mirrors the other boot
 * diagnostics in index.ts).
 */
export async function ensurePermissionsRegistered(): Promise<void> {
  try {
    const { error } = await supabase
      .from('permissions')
      .upsert(PERMISSION_CATALOGUE, { onConflict: 'key', ignoreDuplicates: true });
    if (error) {
      console.warn('[permissionCatalogue] could not self-heal the permissions catalogue:', error.message);
      return;
    }
    console.log(`[permissionCatalogue] catalogue verified (${PERMISSION_CATALOGUE.length} keys ensured registered)`);
  } catch (e: any) {
    console.warn('[permissionCatalogue] self-heal threw (ignored):', e?.message ?? e);
  }
}
