/**
 * roleKeys.ts — A490: roles and permission rows by FINE key (the roles API, the staff routes, the ceiling).
 *
 *   permissionIds(keys)   key → permissions.id, registering a catalogue key first when its row is missing (a key has an
 *                         id only once ensurePermissionsRegistered — or this — has inserted it)
 *   roleKeyMap(roleIds)   role id → the fine keys its grants stand for (a broad grant expanded, as everywhere)
 *   personKeys(userId)    a person's effective fine keys (role + overrides; the owner's role '*')
 */
import { supabase } from './supabase';
import { expandKeys, isPermissionKey, partsOf } from '@zaptill/core/permissions';
import { PERMISSION_CATALOGUE } from './permissionCatalogue';
import { effectiveKeysForRow } from './effectivePermissions';
import { splitsPending } from './permissionsState';   // A595

/** key → permissions.id for the given keys. A catalogue key with no row yet is registered first. */
export async function permissionIds(keys: Iterable<string>): Promise<Map<string, string>> {
  const wanted = [...new Set(keys)];
  const out = new Map<string, string>();
  if (!wanted.length) return out;
  const read = async () => {
    const { data, error } = await supabase.from('permissions').select('id, key').in('key', wanted);
    if (error) throw error;
    for (const r of (data ?? []) as Array<{ id: string; key: string }>) out.set(r.key, r.id);
  };
  await read();
  const missing = wanted.filter((k) => !out.has(k));
  if (missing.length) {
    const rows = PERMISSION_CATALOGUE.filter((p) => missing.includes(p.key));
    if (rows.length) {
      const { error } = await supabase.from('permissions').upsert(rows, { onConflict: 'key', ignoreDuplicates: true });
      if (error) throw error;
      await read();
    }
  }
  return out;
}

/** role id → the fine keys its stored grants stand for. */
export async function roleKeyMap(roleIds: string[]): Promise<Map<string, Set<string>>> {
  const map = new Map<string, Set<string>>();
  for (const id of roleIds) map.set(id, new Set());
  if (!roleIds.length) return map;
  const { data, error } = await supabase.from('role_permissions').select('role_id, permission_id, permissions ( key )').in('role_id', roleIds);
  if (error) throw error;
  const raw = new Map<string, string[]>();
  for (const r of (data ?? []) as Array<{ role_id: string; permissions?: { key?: string | null } | null }>) {
    const k = r.permissions?.key;
    if (k) (raw.get(r.role_id) ?? raw.set(r.role_id, []).get(r.role_id)!).push(k);
  }
  // A595: until migration 176 is recorded a broad grant still brings its parts (what the role could do).
  const partsBefore = splitsPending();
  for (const [id, keys] of raw) map.set(id, expandKeys(keys, false, partsBefore));
  return map;
}

export interface RoleRow { id: string; name: string; description?: string | null; is_default?: boolean | null; business_id?: string | null }

/** One role of this business with its fine keys, or null. */
export async function loadRole(businessId: string, roleId: string): Promise<(RoleRow & { keys: Set<string> }) | null> {
  const { data: role, error } = await supabase.from('roles').select('id, name, description, is_default, business_id')
    .eq('id', roleId).eq('business_id', businessId).maybeSingle();
  if (error) throw error;
  if (!role) return null;
  const keys = (await roleKeyMap([roleId])).get(roleId) ?? new Set<string>();
  return { ...(role as RoleRow), keys };
}

/** A person's effective fine keys (no OPEN_BEFORE keys — what they were GIVEN), or null when not of this business. */
export async function personKeys(businessId: string, userId: string): Promise<{ keys: Set<string>; roleName: string | null } | null> {
  const { data, error } = await supabase.from('users')
    .select('id, role_id, roles ( name, role_permissions ( permissions ( key ) ) ), user_permissions ( granted, permissions ( key ) )')
    .eq('id', userId).eq('business_id', businessId).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as { roles?: { name?: string | null; role_permissions?: any[] | null } | null; user_permissions?: any[] | null };
  return { keys: effectiveKeysForRow(row as any, false), roleName: row.roles?.name ?? null };
}

/** Fine keys only (unknown and broad keys expanded, '*' dropped) from what a client sent. */
export function fineKeysOf(keys: unknown): string[] {
  if (!Array.isArray(keys)) return [];
  return [...expandKeys(keys.filter((k): k is string => typeof k === 'string'))].filter((k) => k !== '*' && isPermissionKey(k));
}

/**
 * A595: a parent key ticked for the FIRST time (not in `before`) by a client that does not know the split rights brings
 * its parts — what ticking it meant before the split (shared permissions.ts SPLITS) — unless the client named one of its
 * parts itself. Only parts within the caller's own keys are added (the ceiling): a manager ticking "See customers" without
 * holding their phone numbers gives the list, not the numbers.
 */
export function withNewParentParts(wanted: string[], before: ReadonlySet<string>, held: ReadonlySet<string>): string[] {
  const out = new Set(wanted);
  for (const k of wanted) {
    if (before.has(k)) continue;
    const parts = partsOf(k);
    if (!parts.length || parts.some((c) => out.has(c))) continue;
    for (const c of parts) if (held.has('*') || held.has(c)) out.add(c);
  }
  return [...out];
}

/** A595: the parts of every parent in a person's overrides, with the parent's value (given or taken). */
export function overridePartsOf(want: ReadonlyMap<string, boolean>): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const [k, v] of want) for (const c of partsOf(k)) if (!out.has(c) || v) out.set(c, v);
  return out;
}
