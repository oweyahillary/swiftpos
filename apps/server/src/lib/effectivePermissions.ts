/**
 * effectivePermissions.ts — A490: what a person may do, worked out in ONE place.
 *
 * Before A490 six places built "role keys + per-person overrides" each in their own way (sign-in, PIN sign-in, the
 * till's staff roster, the approver check, the drawer-confirm check, till changes). They all come here now, and all
 * answer in FINE keys (shared permissions.ts): a role saved with a broad key (reports.view, settings.manage, …) is
 * expanded into the fine keys it stood for, so nobody gains or loses anything at the switch.
 *
 * Owner: a role named owner or admin is the business's owner (isOwnerRoleName) — everything, '*'.
 */
import { supabase } from './supabase';
import { permissionMapFor, PERMISSION_KEYS } from './permissions';
import { keysFromGrants, keysForRow, type GrantRow, type OverrideRow } from './effectiveKeys';
import { permissionsOpenBefore, splitsPending } from './permissionsState';

export type { GrantRow, OverrideRow } from './effectiveKeys';

/** The person's fine keys from their role's grants and their own overrides (an override wins for its key). */
export function effectiveKeys(roleGrants: GrantRow[] | null | undefined, overrides: OverrideRow[] | null | undefined,
  openBefore: boolean = permissionsOpenBefore(), partsBefore: boolean = splitsPending()): Set<string> {
  return keysFromGrants(roleGrants, overrides, openBefore, partsBefore);
}

/** A users row selected with `roles ( name, role_permissions ( permissions ( key ) ) ), user_permissions ( granted,
 *  permissions ( key ) )` — the select every caller already makes. The owner holds '*'. */
export function effectiveKeysForRow(row: Parameters<typeof keysForRow>[0], openBefore: boolean = permissionsOpenBefore(),
  partsBefore: boolean = splitsPending()): Set<string> {
  return keysForRow(row, openBefore, partsBefore);
}

/** Read and work out a person's fine keys (sign-in and token renewal). */
export async function loadEffectiveKeys(roleId: string | null, userId: string): Promise<Set<string>> {
  const [{ data: rp }, { data: up }] = await Promise.all([
    roleId ? supabase.from('role_permissions').select('permissions ( key )').eq('role_id', roleId)
      : Promise.resolve({ data: [] as GrantRow[] }),
    supabase.from('user_permissions').select('granted, permissions ( key )').eq('user_id', userId),
  ]);
  return effectiveKeys(rp as GrantRow[] | null, up as OverrideRow[] | null);
}

/** The keys a token carries (the cloud checks them): fine keys, or '*'. */
export function tokenKeys(held: ReadonlySet<string>): string[] {
  return held.has('*') ? ['*'] : [...held].filter((k) => PERMISSION_KEYS.includes(k));
}

/** The map a client is sent: fine keys, plus the broad keys an older till or web POS still checks (only when every
 *  fine key behind one is held), or {'*': true} for the owner. */
export function clientPermissionMap(held: ReadonlySet<string>): Record<string, true> {
  return held.has('*') ? { '*': true } : permissionMapFor(held);
}
