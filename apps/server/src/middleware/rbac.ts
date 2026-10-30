import type { Request, Response, NextFunction } from 'express';
import { isPermissionKey } from '@zaptill/core/permissions';
import { tillMay } from '../lib/tillScope';

// A490: every check names a FINE key (shared permissions.ts). A broad key (reports.view, settings.manage, …) here would
// be checked against tokens that no longer carry it — requireAuth expands every grant into fine keys — and refuse
// everyone. Refused when the route file loads, so a missed conversion fails the build's tests, not a shop at noon.
function assertFineKeys(keys: string[]): void {
  for (const k of keys) {
    if (!isPermissionKey(k)) throw new Error(`'${k}' is not a permission key of the catalogue (A490: check the fine key it stands for — shared/permissions.ts)`);
  }
}

/** A490: may this caller do what any of `keys` allows? The owner and '*' always may; the till's own sign-in is limited
 *  to what a till does by itself (lib/tillScope.ts, dry-run until TILL_SCOPE_ENFORCE). Use inside a handler. */
export function can(req: Request, ...keys: string[]): boolean {
  assertFineKeys(keys);
  const held = req.permissionKeys ?? [];
  if (req.isTill) return tillMay(req, keys);
  return Boolean(req.isOwner) || held.includes('*') || keys.some((k) => held.includes(k));
}

// requirePermission returns an Express middleware that checks whether the
// authenticated user holds a specific permission key.
//
// Usage:
//   router.delete('/:id', requireAuth, requirePermission('menu.edit'), handler);
//
// Permission resolution order (set by requireAuth in auth.ts):
//   1. req.permissionKeys includes '*'  → wildcard, always allow (owner fallback)
//   2. req.permissionKeys includes the required key → allow
//   3. Otherwise → 403 Forbidden

export function requirePermission(permission: string) {
  assertFineKeys([permission]);
  return (req: Request, res: Response, next: NextFunction): void => {
    // The business owner is never permission-gated, regardless of how their role
    // is configured (mirrors the wildcard the Supabase owner path already grants).
    if (can(req, permission)) {
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
//   requireAnyPermission('devices.approve', 'settings.business')
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
  assertFineKeys(permissions);

  return (req: Request, res: Response, next: NextFunction): void => {
    if (can(req, ...permissions)) {
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
  // A490: what settings.manage stood for here — the business's settings (the receipt text alone is receipt.manage).
  return can(req, 'settings.business');
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
  // A550: a partner of every branch is scoped as the owner is — the branch picked (requireAuth took X-Branch-Id only when
  // it is one of theirs), else ?branch_id when it is one of theirs, else every branch (null). Never a branch not theirs.
  if (req.allBranches) {
    const asked = typeof req.query.branch_id === 'string' ? req.query.branch_id : '';
    return req.branchId || (asked && (req.partnerBranches ?? []).includes(asked) ? asked : null);
  }
  // A582: "All my branches" — one of the set named by ?branch_id (a one-branch read the page points at one of theirs), else
  // NO_BRANCH: a read not taught the set (branchFilter) finds nothing — never every branch.
  if (inBranchSet(req)) {
    const asked = typeof req.query?.branch_id === 'string' ? req.query.branch_id : '';
    return asked && (req.branchSet as string[]).includes(asked) ? asked : NO_BRANCH;
  }
  // Staff are always locked to their JWT branch.
  // A494: a non-owner WITHOUT a branch is not "every branch" (null meant no filter — the owner's view): they get a
  // branch that matches nothing, so a read filtered by it is empty and a `branchScope(req) ?? asked` cannot fall back
  // to a branch they asked for.
  return req.branchId || NO_BRANCH;
}

/** A494: the branch a branchless non-owner is scoped to — a UUID no branch has. */
export const NO_BRANCH = '00000000-0000-0000-0000-000000000000';

/**
 * A550: does this caller reach EVERY branch — the owner, or a partner who works at every branch (lib/webPartners.ts)?
 * The branch half of what used to read `req.isOwner`: where the owner was let past a "your own branch" check, a partner of
 * every branch is too. Never the owner's other powers — those still read req.isOwner (the A550 entry lists each check).
 */
export function allBranchAccess(req: Pick<Request, 'isOwner' | 'allBranches'>): boolean {
  return req.isOwner === true || req.allBranches === true;
}

// assertBranchAccess checks that a specific branch_id is accessible to the
// requester. Use this when a branch_id comes from the request body (not query).
// Returns true if access is allowed, false if it should be rejected with 403.

export function assertBranchAccess(req: Request, branchId: string | null | undefined): boolean {
  if (req.isOwner) return true;
  // A582: "All my branches" — any branch of the set (only reads get this far: requireAuth refuses a write in a set).
  if (inBranchSet(req)) return !!branchId && (req.branchSet as string[]).includes(branchId);
  // A550: a partner of every branch acts at any branch of theirs (the token's list — this business's, checked at sign-in).
  if (req.allBranches) return !!branchId && (req.partnerBranches ?? []).includes(branchId);
  // A494: a non-owner without a branch has access to none (null === null used to pass), and no branch named is no access.
  if (!req.branchId || !branchId || branchId === NO_BRANCH) return false;
  return req.branchId === branchId;
}

// ── A582: "All my branches" — a partner of some branches reading them combined ────────────────────────────────────────
// Owner, 2026-10-23: "assume i have partner a and they fully own shop x,y and z they should never see general sales for
// all stores only their store" … "yes i want all my branch feature".
//
// requireAuth sets req.branchSet (exactly the partner's list, two or more — lib/webPartners.ts partnerBranchSet) and
// branchId = NO_BRANCH, and refuses every write first. branchScope() gives them ONE branch only when ?branch_id= names
// one of the set, else NO_BRANCH — so a read that was not taught the set finds nothing (fail closed, never every
// branch); assertBranchAccess() admits any branch of the set. A read that combines asks branchFilter():
//   { kind: 'all' }            — the owner / a partner of every branch with no branch picked (today's null: no filter)
//   { kind: 'one', id }        — one branch (branchScope's answer; in a set, ?branch_id= naming one of the set)
//   { kind: 'set', ids }       — the partner's branches, never empty, never null — `.in(col, ids)`
// and applies it with byBranch(). A read that cannot combine answers oneBranchOnly() — "Pick one of your branches for
// this" — instead of a silently empty page.

export type BranchFilter = { kind: 'all' } | { kind: 'one'; id: string } | { kind: 'set'; ids: string[] };

/** A582: is this request "All my branches"? */
export function inBranchSet(req: Pick<Request, 'branchSet'>): boolean {
  return Array.isArray(req.branchSet) && req.branchSet.length > 0;
}

/** A582: the branches a read covers (see above). Never { kind: 'all' } for a request in a set. */
export function branchFilter(req: Request): BranchFilter {
  const one = branchScope(req);
  if (inBranchSet(req)) return one && one !== NO_BRANCH ? { kind: 'one', id: one } : { kind: 'set', ids: [...(req.branchSet as string[])] };
  return one ? { kind: 'one', id: one } : { kind: 'all' };
}

/** A582: a query narrowed to the filter's branches (`col`, default branch_id): eq for one, in for a set, nothing for all. */
export function byBranch<Q>(q: Q, f: BranchFilter, col = 'branch_id'): Q {
  const x = q as unknown as { eq: (c: string, v: string) => Q; in: (c: string, v: string[]) => Q };
  if (f.kind === 'one') return x.eq(col, f.id);
  if (f.kind === 'set') return x.in(col, f.ids);
  return q;
}

/** A582: does a row of this branch fit the filter? A row with no branch fits only 'all' unless `orNone` (business-wide equipment). */
export function rowInBranches(f: BranchFilter, branchId: string | null | undefined, orNone = false): boolean {
  if (f.kind === 'all') return true;
  if (!branchId) return orNone;
  return f.kind === 'one' ? branchId === f.id : f.ids.includes(branchId);
}

/** A582: the one branch of a filter, null for 'all' — and for a set, NO_BRANCH (a set is never one branch). */
export function oneOf(f: BranchFilter): string | null {
  return f.kind === 'one' ? f.id : f.kind === 'set' ? NO_BRANCH : null;
}

/**
 * A582: a read that works one branch at a time, asked in "All my branches" without ?branch_id= naming one of theirs:
 * answered 400 PICK_ONE_BRANCH (true). Otherwise false — branchScope() is then that one branch (or today's answer).
 */
export const PICK_ONE_BRANCH_BODY = { error: 'Pick one of your branches for this.', code: 'PICK_ONE_BRANCH' } as const;
export function oneBranchOnly(req: Request, res: Response, error?: string): boolean {
  if (!inBranchSet(req) || branchScope(req) !== NO_BRANCH) return false;
  res.status(400).json(error ? { ...PICK_ONE_BRANCH_BODY, error } : PICK_ONE_BRANCH_BODY);
  return true;
}
