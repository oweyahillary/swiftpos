/**
 * effectiveKeys.ts — A490: a person's fine keys from their role's grants and their own overrides. PURE (no database, no
 * environment), so the approver / drawer-confirm rules that use it stay pure and their tests load them as they are.
 * lib/effectivePermissions.ts wraps these with the live "before migration 134" state.
 */
import { expandMap } from './permissions';
import { isOwnerRoleName } from './ownerRole';

export interface GrantRow { permissions?: { key?: string | null } | null }
export interface OverrideRow { granted?: boolean | null; permissions?: { key?: string | null } | null }

/** The person's fine keys from their role's grants and their own overrides (an override wins for its key). */
export function keysFromGrants(roleGrants: GrantRow[] | null | undefined, overrides: OverrideRow[] | null | undefined,
  openBefore: boolean): Set<string> {
  const map: Record<string, boolean> = {};
  for (const g of roleGrants ?? []) { const k = g?.permissions?.key; if (k) map[k] = true; }
  for (const o of overrides ?? []) { const k = o?.permissions?.key; if (k) map[k] = o.granted === true; }
  return expandMap(map, openBefore);
}

/** A users row selected with its role's grants and its overrides. The owner's role holds '*'. */
export function keysForRow(row: {
  roles?: { name?: string | null; role_permissions?: GrantRow[] | null } | null;
  user_permissions?: OverrideRow[] | null;
} | null | undefined, openBefore: boolean): Set<string> {
  if (!row) return new Set();
  if (isOwnerRoleName(row.roles?.name)) return new Set(['*']);
  return keysFromGrants(row.roles?.role_permissions, row.user_permissions, openBefore);
}
