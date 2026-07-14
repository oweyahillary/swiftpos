import { supabase } from './supabase';

// Default permission grants for the roles seeded at business creation.
//
// Both onboarding paths (self-service /api/onboarding and agent
// /api/admin/clients) create default roles but historically left them with NO
// role_permissions — so the roles screen showed empty rights and any staff on
// those roles had no access. (Owners are unaffected: the auth middleware grants
// the Supabase owner wildcard permissions regardless of role.)
//
// Tiers, by role name (case-insensitive):
//   • admin / owner            → every permission in the catalogue
//   • manager / supervisor / branch_manager → everything except the owner-only
//                                deny-list below (owner can grant more later)
//   • cashier                  → a POS-floor subset
//   • anything else            → nothing (a custom role the owner configures)
//
// The grant is future-proof: it reads the live permissions catalogue, so any
// permission added later is automatically included for admin/manager unless it
// is on MANAGER_DENY.

const CASHIER_KEYS = new Set([
  'orders.create', 'products.view', 'inventory.view',
  'customers.view', 'customers.manage', 'invoice.create',
]);

// Owner-only permissions. Managers/supervisors do NOT get these by default.
//   • settings.manage    — business configuration
//   • inventory.adjust   — manual stock changes (where shrinkage/theft hides;
//                          managers RECEIVE against a delivery, only the owner
//                          can silently change a number)
//   • ingredients.manage — the ingredient catalogue is a business-level
//                          definition the owner owns
const MANAGER_DENY = new Set([
  'settings.manage',
  'inventory.adjust',
  'ingredients.manage',
]);

export async function seedDefaultRolePermissions(
  roles: { id: string; name: string }[],
): Promise<void> {
  if (!roles?.length) return;

  const { data: perms } = await supabase.from('permissions').select('id, key');
  if (!perms?.length) return;

  const rows: { role_id: string; permission_id: string }[] = [];
  for (const role of roles) {
    const nm = (role.name || '').toLowerCase();
    const isFull    = nm === 'admin' || nm === 'owner';
    const isManager = nm === 'manager' || nm === 'supervisor' || nm === 'branch_manager';
    const isCashier = nm === 'cashier';

    for (const p of perms) {
      const grant =
        isFull    ? true :
        isManager ? !MANAGER_DENY.has(p.key) :
        isCashier ? CASHIER_KEYS.has(p.key) :
        false;
      if (grant) rows.push({ role_id: role.id, permission_id: p.id });
    }
  }

  if (rows.length) {
    const { error } = await supabase.from('role_permissions').insert(rows);
    if (error) throw error;
  }
}
