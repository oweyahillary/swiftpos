// Central routing logic — one source of truth used everywhere
// Put this in: apps/dashboard/src/lib/posRouting.ts

export type POSRoute = '/pos/cashier' | '/manager' | '/';

export interface PermissionMap {
  [key: string]: boolean;
}

/**
 * Given a set of permissions and a role name, return where this user should land.
 *
 * Owner  (wildcard *)      → '/'          full dashboard (Supabase)
 * Manager (role OR perm)   → '/manager'   branch manager dashboard
 * Everyone else            → '/pos/cashier'
 */
export function resolveRoute(
  permissions: PermissionMap,
  role: string,
): POSRoute {
  // Owner — has wildcard
  if (permissions['*'] === true) return '/';

  // Manager — either role name matches OR has settings.manage permission
  const MANAGER_ROLE_NAMES = ['manager', 'supervisor', 'admin', 'branch_manager'];
  const isManagerByRole = MANAGER_ROLE_NAMES.includes((role ?? '').toLowerCase());
  const isManagerByPerm = permissions['settings.manage'] === true;

  if (isManagerByRole || isManagerByPerm) return '/manager';

  return '/pos/cashier';
}
