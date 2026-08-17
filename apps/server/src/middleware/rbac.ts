import type { Request, Response, NextFunction } from 'express';

// requirePermission returns an Express middleware that checks whether the
// authenticated user holds a specific permission key.
//
// Usage:
//   router.delete('/:id', requireAuth, requirePermission('products.manage'), handler);
//
// Permission resolution order (set by requireAuth in auth.ts):
//   1. req.permissionKeys includes '*'  → wildcard, always allow (owner fallback)
//   2. req.permissionKeys includes the required key → allow
//   3. Otherwise → 403 Forbidden

export function requirePermission(permission: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const keys = req.permissionKeys ?? [];

    // The business owner is never permission-gated, regardless of how their role
    // is configured (mirrors the wildcard the Supabase owner path already grants).
    if (req.isOwner || keys.includes('*') || keys.includes(permission)) {
      next();
      return;
    }

    res.status(403).json({
      error: 'Forbidden',
      detail: `Missing permission: ${permission}`,
    });
  };
}

// requireAnyPermission gates a route on ANY ONE of several keys.
//
// ── WHY THIS SHAPE (register A46) ────────────────────────────────────────────
// `settings.manage` gated 16 routes with wildly different blast radii: to let a
// manager type a branch phone number you also had to grant eTIMS fiscal
// registration and the power to revoke a till. The owner asked for fine keys
// "that would not affect operations".
//
// The split is ADDITIVE, and that is the whole design. A route becomes
//
//   requireAnyPermission('devices.approve', 'settings.manage')
//
// so a role holding `settings.manage` today keeps EXACTLY what it has — no
// existing user loses access at the moment of the split, which is what makes it
// deployable without a coordinated permission migration. The narrow key is what
// a manager gets granted INSTEAD, going forward.
//
// This does not shrink `settings.manage`; it provides an alternative to it.
// Shrinking it is a later, separate decision that requires knowing who holds it
// in production, and doing both at once is how a permission change locks
// somebody out mid-service.
//
// Order matters only for the error message: the FIRST key is the one a caller
// should be granted, so it is the one named in the 403.
export function requireAnyPermission(...permissions: string[]) {
  if (permissions.length === 0) {
    // A gate with no keys would allow everyone, which is the opposite of what a
    // caller writing this line intends. Fail at module load, not at request time.
    throw new Error('requireAnyPermission called with no permission keys');
  }

  return (req: Request, res: Response, next: NextFunction): void => {
    const keys = req.permissionKeys ?? [];

    if (req.isOwner || keys.includes('*') || permissions.some(p => keys.includes(p))) {
      next();
      return;
    }

    res.status(403).json({
      error: 'Forbidden',
      // The narrow key first: telling an owner to grant `settings.manage` to fix
      // a 403 on a branch phone number is how one switch got sixteen routes.
      detail: `Missing permission: ${permissions[0]}`,
    });
  };
}

/**
 * Does this caller hold UNRESTRICTED settings access?
 *
 * Exported so `tests/receipt-permission.test.mjs` can exercise the real thing.
 * The alternative — copying the predicate into the test, as
 * branchscope-middleware.test.mjs does with branchScope — leaves two copies of
 * a security decision with a comment asking someone to keep them in lockstep,
 * which is the §L shape this repository builds comparators to avoid.
 *
 * Used by POST /business/settings, where the route gate admits both
 * `receipt.manage` and `settings.manage` (Express middleware runs before the
 * body is readable and cannot know which key is being written) and the handler
 * then narrows per key. Anyone for whom this returns false gets an allow-list.
 */
export function hasFullSettingsAccess(req: Request): boolean {
  const keys = req.permissionKeys ?? [];
  return Boolean(req.isOwner) || keys.includes('*') || keys.includes('settings.manage');
}

// branchScope resolves the effective branch_id for a query.
//
// Rules:
//   - Owner (req.isOwner = true): may pass any branch_id via query param,
//     or omit it to get all branches.
//   - Staff (req.isOwner = false): always locked to req.branchId from their
//     JWT. Any branch_id they pass in the query is ignored.
//
// Usage in a route handler:
//   const scopedBranchId = branchScope(req);
//   if (scopedBranchId) query = query.eq('branch_id', scopedBranchId);
//
// Returns null when the owner wants cross-branch data (no filter applied).

export function branchScope(req: Request): string | null {
  if (req.isOwner) {
    // Owner's selected branch arrives as the X-Branch-Id header (set globally by
    // the dashboard api client); a query param still works as a fallback.
    // Absent both = owner is viewing "All Branches" → no filter.
    return (req.headers['x-branch-id'] as string) || (req.query.branch_id as string) || null;
  }
  // Staff are always locked to their JWT branch
  return req.branchId;
}

// assertBranchAccess checks that a specific branch_id is accessible to the
// requester. Use this when a branch_id comes from the request body (not query).
// Returns true if access is allowed, false if it should be rejected with 403.

export function assertBranchAccess(req: Request, branchId: string): boolean {
  if (req.isOwner) return true;
  return req.branchId === branchId;
}
