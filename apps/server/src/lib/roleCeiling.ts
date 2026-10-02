// roleCeiling.ts — who may hand out which role and which permission (A340, 2026-09-27).
//
// Owner, 2026-09-27: "i have seen the manager can create an owner that should not happen".
//
// Pure (no Supabase import) so the rule runs in a test. ONE rule, used by every staff route and by the role list the
// dashboard and the till draw their pickers from — so what a manager is offered and what the cloud accepts cannot drift:
//   - the OWNER (and admin, which the cloud treats as the owner) may assign any role and grant any permission;
//   - anyone else with staff.manage may assign only NON-elevated roles, and may grant a staff member only permissions
//     they hold themselves (the same ceiling C3 put on editing a role's permissions).
// Elevated = owner, admin, manager, supervisor, branch_manager — matched by name, case-insensitively.

export const ELEVATED_ROLE_NAMES = ['owner', 'admin', 'manager', 'supervisor', 'branch_manager'] as const;

export function isElevatedRoleName(name: string | null | undefined): boolean {
  return (ELEVATED_ROLE_NAMES as readonly string[]).includes(String(name ?? '').trim().toLowerCase());
}

/** May this caller give someone this role? An unknown role (no name) is refused to non-owners — fail closed. */
export function canAssignRole(callerIsOwner: boolean, roleName: string | null | undefined): boolean {
  if (callerIsOwner) return true;
  if (roleName == null || String(roleName).trim() === '') return false;
  return !isElevatedRoleName(roleName);
}

/** The permission keys a non-owner is trying to GRANT that they do not hold themselves. Empty = allowed. */
export function overridesBeyondCaller(callerIsOwner: boolean, callerKeys: string[], grantedKeys: string[]): string[] {
  if (callerIsOwner) return [];
  const held = new Set(callerKeys);
  if (held.has('*')) return [];
  return [...new Set(grantedKeys)].filter((k) => !held.has(k));
}
