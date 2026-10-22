/**
 * personAccess.ts — A490: the till's ONE rule for "may this person see or do this" — the pure part (no database, no
 * electron), so pure modules (stationRouting, tillWastage, offlineReversal) and the tests run it as it is. tillAccess.ts
 * adds the signed-in person (staff_session) and re-exports all of this; read its header for the why.
 */
import {
  expandMap, hasPermission, hasAnyPermission, isBackOffice, keysBeyond, MAP_MARKER, OPEN_BEFORE_A490,
} from './permissions';

/** The owner's role — by name, as the cloud decides it (lib/ownerRole.ts). The only role-name rule on the till. */
export function isOwnerRole(roleName: string | null | undefined): boolean {
  return ['owner', 'admin'].includes(String(roleName ?? '').trim().toLowerCase());
}

/** A permission map from what a row or an answer carries: an object, or its JSON. Anything unreadable is {} (nothing). */
export function parseMap(raw: unknown): Record<string, unknown> {
  let v: unknown = raw;
  if (typeof v === 'string') { try { v = JSON.parse(v || '{}'); } catch { return {}; } }
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
}

/** Was this map made by a cloud that knows the catalogue (A490)? Without the marker, the before-migration rules apply. */
export function hasMarker(raw: unknown): boolean {
  return parseMap(raw)[MAP_MARKER] === true;
}

/** The fine keys a person holds. The owner's role → '*'. */
export function personKeys(roleName: string | null | undefined, permissions: unknown): Set<string> {
  if (isOwnerRole(roleName)) return new Set(['*']);
  return expandMap(parseMap(permissions) as Record<string, unknown>);
}

export interface PersonLike { roleName?: string | null; permissions?: unknown }

/** Does this person hold ANY of the keys? */
export function personCan(p: PersonLike | null | undefined, ...keys: string[]): boolean {
  if (!p) return false;
  return hasAnyPermission(personKeys(p.roleName, p.permissions), keys);
}

/**
 * "Back office": holds anything beyond the shop floor (or is the owner) — who the PIN screen sends to the manager
 * screens, who sees the sync notice. The keys nobody was refused before A490 (OPEN_BEFORE_A490: every cashier holds
 * them on a map from before the catalogue, and migration 134 gives the staff list to every role) do not make anyone
 * back office.
 */
export function backOffice(roleName: string | null | undefined, permissions: unknown): boolean {
  const held = personKeys(roleName, permissions);
  return isBackOffice([...held].filter((k) => !OPEN_BEFORE_A490.includes(k)));
}

// ── The two rules that were the admin portal's switches until migration 134 ──────────────────────────────────────

/**
 * Sees every cashier's sales in History (sales.history_all). A map from before the catalogue keeps today's rule: every
 * sale unless the 'cashier_own_history' switch is on — then only someone who may confirm drawers.
 */
export function seesAllHistory(p: PersonLike | null | undefined, cashierOwnHistory: boolean): boolean {
  if (!p) return false;
  const held = personKeys(p.roleName, p.permissions);
  if (held.has('*')) return true;
  if (hasMarker(p.permissions)) return hasPermission(held, 'sales.history_all');
  return !cashierOwnHistory || hasPermission(held, 'shifts.confirm');
}

/**
 * Records cash in / out and drawer expenses (shifts.cash_movements). A map from before the catalogue keeps today's rule:
 * anyone unless the 'cashier_no_money_out' switch is on — then only someone who may confirm drawers.
 */
export function mayMoveMoney(p: PersonLike | null | undefined, cashierNoMoneyOut: boolean): boolean {
  if (!p) return false;
  const held = personKeys(p.roleName, p.permissions);
  if (held.has('*')) return true;
  if (hasMarker(p.permissions)) return hasPermission(held, 'shifts.cash_movements');
  return !cashierNoMoneyOut || hasPermission(held, 'shifts.confirm');
}

// ── Roles this till saved (roles_cache) ─────────────────────────────────────────────────────────────────────────

/** A role from GET /api/staff/roles: `keys` (fine, A490) or the older `permissions` / `role_permissions` lists. */
export function isOwnerRoleEntry(role: any): boolean {
  return role?.is_owner_role === true || isOwnerRole(role?.name);
}

/** The permission map a person of this role holds — the shape staff_session / branch_staff keep. */
export function roleMap(role: any): Record<string, boolean> {
  if (isOwnerRoleEntry(role)) return { '*': true };
  const out: Record<string, boolean> = {};
  if (Array.isArray(role?.keys)) {
    for (const k of role.keys) if (typeof k === 'string' && k) out[k] = true;
    out[MAP_MARKER] = true;   // a cloud that sends fine keys knows the catalogue
    return out;
  }
  for (const p of (role?.permissions ?? role?.role_permissions ?? [])) {
    const k = p?.key ?? p?.permissions?.key;
    if (typeof k === 'string' && k) out[k] = true;
  }
  return out;
}

/** The fine keys a role holds ('*' for the owner's). */
export function roleKeys(role: any): Set<string> {
  if (isOwnerRoleEntry(role)) return new Set(['*']);
  // The role's own grants only — never the keys a map from before A490 is given on top (a ceiling compares grants).
  return expandMap(roleMap(role), false);
}

/** Why the signed-in person may not give this role (the A340 ceiling, by permission), or null when they may. */
export function roleCeilingRefusal(caller: PersonLike | null | undefined, role: any): string | null {
  if (!caller) return 'Sign in first.';
  if (isOwnerRoleEntry(role)) return 'The owner\'s role belongs to the owner alone — choose another role.';   // A562: the cloud gives it to nobody either
  const held = personKeys(caller.roleName, caller.permissions);
  const beyond = keysBeyond(held, roleKeys(role));
  return beyond.length ? `The ${role?.name ?? 'chosen'} role can do more than you can (${beyond.slice(0, 3).join(', ')}${beyond.length > 3 ? ', …' : ''}).` : null;
}

/** May the caller act on this person (a PIN, a role, a rename)? Never on someone who holds more than they do. */
export function mayActOn(caller: PersonLike | null | undefined, target: PersonLike | null | undefined): boolean {
  if (!caller) return false;
  if (!target) return true;   // someone this till does not hold — the cloud decides
  const held = personKeys(caller.roleName, caller.permissions);
  if (held.has('*')) return true;
  if (isOwnerRole(target.roleName)) return false;
  return keysBeyond(held, expandMap(parseMap(target.permissions) as Record<string, unknown>, false)).length === 0;
}

