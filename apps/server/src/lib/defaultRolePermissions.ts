import { supabase } from './supabase';
import { defaultKeysForRoleName, builtInRolesFor } from './permissions';
import { permissionIds } from './roleKeys';

// Default permission grants for the roles seeded at business creation.
//
// Both onboarding paths (self-service /api/onboarding and agent
// /api/admin/clients) create default roles but historically left them with NO
// role_permissions — so the roles screen showed empty rights and any staff on
// those roles had no access. (Owners are unaffected: the owner's role holds
// everything by its name — lib/ownerRole.ts.)
//
// A490: the grants are the shared catalogue's own defaults, in FINE keys only.
// A514: every built-in role's defaults live in ONE place — shared/permissions.ts BUILT_IN_ROLES (Manager, Cashier,
// Supervisor, Waiter, Kitchen, Storekeeper, Accountant, and Fuel attendant at a fuel business); migration 142 gives
// existing businesses the same roles with the same keys. Which role is which still comes from its name: these are the
// system's OWN roles being created at onboarding — seeding, not a check; from then on the owner decides per role on
// Settings › Roles and permissions.
//   • admin / owner        → every fine key
//   • a built-in role      → its BUILT_IN_ROLES keys (Branch manager → the Manager's)
//   • anything else        → nothing (a custom role the owner configures)

/**
 * A514: the roles a new business is created with — the owner's role (named as each path always named it: 'owner' from the
 * admin portal, 'Admin' from self-service onboarding), then every built-in role for its type.
 */
export function seededRoleRows(businessId: string, ownerRoleName: string, businessType: string | null | undefined):
  Array<{ business_id: string; name: string; description: string | null; is_default: true }> {
  return [
    { business_id: businessId, name: ownerRoleName, description: null, is_default: true },
    ...builtInRolesFor(businessType).map((r) => ({ business_id: businessId, name: r.name, description: r.description, is_default: true as const })),
  ];
}

export async function seedDefaultRolePermissions(
  roles: { id: string; name: string }[],
): Promise<void> {
  if (!roles?.length) return;

  const wanted = roles.map((r) => ({ id: r.id, keys: defaultKeysForRoleName(r.name) }));
  const ids = await permissionIds(wanted.flatMap((w) => w.keys));   // a key with no row yet is registered first

  const rows: { role_id: string; permission_id: string }[] = [];
  for (const w of wanted) {
    for (const k of w.keys) {
      const pid = ids.get(k);
      if (pid) rows.push({ role_id: w.id, permission_id: pid });
    }
  }

  if (rows.length) {
    const { error } = await supabase.from('role_permissions').insert(rows);
    if (error) throw error;
  }
}
