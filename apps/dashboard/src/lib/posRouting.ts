// Central routing logic — one source of truth used everywhere (PIN sign-in, the manager portal's guard, the web POS).
import { expandMap, isBackOffice, OPEN_BEFORE_A490 } from '@zaptill/core/permissions';   // A490

export type POSRoute = '/pos/cashier' | '/manager' | '/';

export interface PermissionMap {
  [key: string]: boolean;
}

/**
 * Given a person's permission map, return where they land.
 *
 * Owner ('*')                                  → '/'             the full dashboard (Supabase sign-in)
 * Back office (holds anything beyond the shop
 *   floor's keys — isBackOffice, A490)         → '/manager'      the manager portal
 * Everyone else                                → '/pos/cashier'
 *
 * A490: no role names. "Is a manager" is a permission (isBackOffice of the expanded map) — a role renamed or created
 * by the owner lands where its keys say. `_role` stays in the signature for the callers; it decides nothing.
 * The keys nobody was refused before A490 (OPEN_BEFORE_A490 — every cashier holds them until migration 134, and an
 * older map is expanded with them) never make a person back office on their own: they include sales.history_all and
 * staff.view, which are not shop-floor keys, so without this every cashier would land on the manager portal.
 */
// A608 (owner, 2026-10-29, "yes to all"): the web manager portal is retired — '/manager' is kept as the SIGNAL "back
// office" (the web POS refuses their PIN, POSLoginScreen; the route itself redirects to the dashboard, App.tsx).
export function resolveRoute(
  permissions: PermissionMap | null | undefined,
  _role?: string | null,
): POSRoute {
  if (permissions?.['*'] === true) return '/';
  if (isBackOffice(backOfficeKeys(permissions))) return '/manager';
  return '/pos/cashier';
}

/** The keys that decide "back office": the map's own (broad keys expanded), without the keys nobody was refused. */
export function backOfficeKeys(permissions: PermissionMap | null | undefined): Set<string> {
  const held = expandMap(permissions ?? {}, false);
  for (const k of OPEN_BEFORE_A490) held.delete(k);
  return held;
}
