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
    // Owner may optionally filter by a specific branch
    return (req.query.branch_id as string) || null;
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
