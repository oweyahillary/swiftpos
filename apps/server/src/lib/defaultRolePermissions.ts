import { supabase } from './supabase';
import { roleTier } from './roleTier';
import { defaultKeysFor } from './permissions';
import { permissionIds } from './roleKeys';

// Default permission grants for the roles seeded at business creation.
//
// Both onboarding paths (self-service /api/onboarding and agent
// /api/admin/clients) create default roles but historically left them with NO
// role_permissions — so the roles screen showed empty rights and any staff on
// those roles had no access. (Owners are unaffected: the owner's role holds
// everything by its name — lib/ownerRole.ts.)
//
// A490: the grants are the shared catalogue's own defaults (permissions.ts defaultKeysFor — each fine key says whether a
// new business's Cashier and Manager get it), in FINE keys only. Which kind a seeded role is still comes from its name
// (roleTier): these are the system's OWN roles being created at onboarding — seeding, not a check; from then on the
// owner decides per role on Settings › Roles and permissions.
//   • admin / owner                          → every fine key
//   • manager / supervisor / branch_manager → the catalogue's manager defaults
//   • cashier                               → the catalogue's cashier defaults (the shop floor)
//   • anything else                         → nothing (a custom role the owner configures)

export function defaultKindFor(name: string): 'owner' | 'manager' | 'cashier' | 'none' {
  const tier = roleTier(name);
  return tier === 'full' ? 'owner' : tier;
}

export async function seedDefaultRolePermissions(
  roles: { id: string; name: string }[],
): Promise<void> {
  if (!roles?.length) return;

  const wanted = roles.map((r) => ({ id: r.id, keys: defaultKeysFor(defaultKindFor(r.name)) }));
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
