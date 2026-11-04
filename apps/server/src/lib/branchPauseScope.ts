/**
 * branchPauseScope.ts — A612: who sees what while a branch's cloud is paused (docs/A612-per-branch-cloud.md).
 *
 * Owner, 2026-10-30: "if a branch does not pay it should not view its data and the owner should not see it too, it cuts
 * across all users". lib/cloudPlan.ts branchPause() says which branches are paused; this narrows a signed-in web request to
 * the OPEN branches, the way A582's "All my branches" narrows a partner (req.branchSet, middleware/rbac.ts branchFilter):
 *
 *   the owner / a partner of every branch, no branch picked  a read covers the open branches only — two or more: the set
 *                                                            (a read not taught the set finds nothing, never every branch);
 *                                                            one: that branch. A write stays business-wide (a product, a
 *                                                            setting) — assertBranchAccess refuses a paused branch.
 *   a branch picked (X-Branch-Id) that is paused             refused (403 BRANCH_PAUSED)
 *   a partner of some branches                               their branches less the paused ones; none left: refused
 *   anyone else (manager, cashier, …) of a paused branch     refused
 *
 * Pure: middleware/auth.ts applies the answer.
 */
import { NO_BRANCH } from '../middleware/rbac';

/** Their own branch is paused (a manager, a cashier, a partner with no open branch): the dashboard's paused screen. */
export const BRANCH_PAUSED_BODY = {
  error: 'This branch\'s cloud access is paused. Call 0717 675 635 to renew.',
  code: 'BRANCH_PAUSED',
} as const;
/** A paused branch PICKED by someone with open ones (the owner, a partner): the dashboard drops it and picks an open one. */
export const BRANCH_PICKED_PAUSED_BODY = {
  error: 'This branch\'s cloud access is paused. Pick another branch.',
  code: 'BRANCH_PICKED_PAUSED',
} as const;

export interface PauseScopeIn {
  isOwner: boolean;
  isTill: boolean;
  webPartner: boolean;
  allBranches: boolean;
  partnerBranches: string[];
  branchSet: string[] | null;
  branchId: string | null;
  /** The branch picked in the dashboard (X-Branch-Id), as sent. */
  picked: string | null;
  method: string;
}

export interface PauseScopeOut {
  partnerBranches?: string[];
  branchSet?: string[] | null;
  branchId?: string | null;
  /** The one open branch every read of the owner / a partner of every branch is pinned to. */
  pinnedBranch?: string | null;
}

const READS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** The narrowing for a request; 'refuse' (their own branch paused: BRANCH_PAUSED) or 'picked' (a paused branch picked while
 *  others are open: BRANCH_PICKED_PAUSED). Nothing paused: {} (no change). */
export function scopeForPause(r: PauseScopeIn, pause: { paused: ReadonlySet<string>; open: readonly string[] }): PauseScopeOut | 'refuse' | 'picked' {
  if (!pause.paused.size) return {};
  const isPaused = (id: string | null | undefined) => !!id && pause.paused.has(id);
  const read = READS.has(String(r.method).toUpperCase());
  /** A read with no branch picked, by someone who sees every branch: the open ones. */
  const narrowAll = (): PauseScopeOut => {
    if (!read) return {};
    // One open branch: pinned to it — req.branchId too, so a route reading the caller's own branch reads it.
    return pause.open.length >= 2 ? { branchSet: [...pause.open], branchId: NO_BRANCH }
      : { pinnedBranch: pause.open[0] ?? NO_BRANCH, branchId: pause.open[0] ?? NO_BRANCH };
  };

  if (r.isOwner) {
    // A612: a session of a paused branch (the owner's "Open POS" carries its branch) — refused, writes included.
    if (isPaused(r.picked) || isPaused(r.branchId)) return pause.open.length ? 'picked' : 'refuse';
    return r.picked ? {} : narrowAll();
  }
  if (r.webPartner) {
    const theirs = r.partnerBranches.filter((b) => !isPaused(b));
    if (r.allBranches) {
      if (isPaused(r.branchId) || isPaused(r.picked)) return pause.open.length ? 'picked' : 'refuse';
      return r.branchId ? { partnerBranches: theirs } : { partnerBranches: theirs, ...narrowAll() };
    }
    if (!theirs.length) return 'refuse';
    if (Array.isArray(r.branchSet) && r.branchSet.length) {
      const set = r.branchSet.filter((b) => !isPaused(b));
      if (!set.length) return 'refuse';
      return set.length >= 2 ? { partnerBranches: theirs, branchSet: set } : { partnerBranches: theirs, branchSet: null, branchId: set[0] };
    }
    return isPaused(r.branchId) ? 'picked' : { partnerBranches: theirs };
  }
  return isPaused(r.branchId) ? 'refuse' : {};
}
