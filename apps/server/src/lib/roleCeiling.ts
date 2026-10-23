// roleCeiling.ts — who may hand out which role and which permission (A340, 2026-09-27; by permission since A490).
//
// Owner, 2026-09-27: "i have seen the manager can create an owner that should not happen".
//
// Pure (no Supabase import) so the rule runs in a test. ONE rule, used by every staff route, the role routes and the
// role list the dashboard and the till draw their pickers from — so what a manager is offered and what the cloud accepts
// cannot drift:
//   - the OWNER ('*') may assign any role and grant any permission;
//   - the owner's role (named owner / admin — lib/ownerRole.ts) is the owner's: nobody assigns it (A562: not even the owner);
//   - anyone else may assign a role, edit a role, grant a person a permission or manage a person only within what
//     they hold themselves: keysBeyond(caller, those keys) must be empty (shared permissions.ts).
// A490: this used to match role NAMES (owner, admin, manager, supervisor, branch_manager) — a role called "Shift lead"
// holding everything passed, and a "Manager" role holding nothing was untouchable. Now the keys decide.
import { keysBeyond } from './permissions';
import { isOwnerRoleName } from './ownerRole';

export interface RoleLike { name?: string | null; keys: Iterable<string> }

/** The caller's keys as the ceiling reads them: the owner holds '*'. */
export function callerHeld(req: { isOwner?: boolean; permissionKeys?: string[] | null }): Set<string> {
  if (req.isOwner) return new Set(['*']);
  return new Set(req.permissionKeys ?? []);
}

export const isOwnerHeld = (held: ReadonlySet<string>): boolean => held.has('*');

/** May this caller give someone this role? The owner's role by NOBODY (A562 — the owner included); an unknown role (no
 *  name) never by anyone but the owner — fail closed; any other role only when it holds nothing beyond the caller.
 *  A562: the owner's role is everything, every branch, by its name (lib/ownerRole.ts) — a second person on it was a
 *  second owner (a business showed two "Owner" staff). The owner's own row gets it when the business is made (admin.ts,
 *  onboarding.ts, auth.ts ensureOwnerUserRow); someone who needs the owner's rights gets a role holding them (A550's
 *  General Manager, web dashboard access). */
export function canAssignRole(held: ReadonlySet<string>, role: RoleLike | null | undefined): boolean {
  if (role && isOwnerRoleName(role.name)) return false;
  if (isOwnerHeld(held)) return true;
  if (!role || role.name == null || String(role.name).trim() === '') return false;
  return keysBeyond(held, role.keys).length === 0;
}

/**
 * Why this caller may not change this role's keys (or name), or null. The owner's role is never edited (it is
 * everything by name — its rows mean nothing); a role holding more than the caller is not theirs to change; nor may
 * they give it more than they hold.
 */
export function roleEditRefusal(held: ReadonlySet<string>, role: RoleLike, wanted?: Iterable<string>): { error: string; missing?: string[] } | null {
  if (isOwnerRoleName(role.name)) return { error: 'The owner\'s role always has every permission — it cannot be changed.' };
  if (isOwnerHeld(held)) return null;
  const over = keysBeyond(held, role.keys);
  if (over.length) return { error: 'You cannot change a role that has permissions you do not hold', missing: over };
  if (wanted) {
    const missing = keysBeyond(held, wanted);
    if (missing.length) return { error: 'You cannot grant permissions you do not hold', missing };
  }
  return null;
}

/** The permission keys a non-owner is trying to GRANT that they do not hold themselves (fine keys). Empty = allowed. */
export function overridesBeyondCaller(held: ReadonlySet<string>, grantedKeys: Iterable<string>): string[] {
  return keysBeyond(held, grantedKeys);
}
