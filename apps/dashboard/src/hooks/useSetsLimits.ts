/**
 * useSetsLimits — A585 / A587: may the person on the dashboard give, change or remove a customer's credit limit here, and
 * the line to show when not. The owner; A587 (owner, 2026-10-24: "Can a co-owner partner set credit limits? — yes for
 * their selected branch"): a partner with ONE of their branches picked (not "All my branches"). The cloud decides the
 * same (PATCH /api/credit/customer/:id/limit — 403 PICK_ONE_BRANCH otherwise). Rules: lib/creditApprovers.ts.
 */
import { usePermissions } from '../context/PermissionsContext';
import { useBranch } from '../context/BranchContext';
import { dashboardSetsLimits, limitLineFor } from '../lib/creditApprovers';

export function useSetsLimits(): { setsLimits: boolean; line: string } {
  const perms = usePermissions();
  const branch = useBranch();
  const who = { isOwner: perms.isOwner, isPartner: perms.isPartner, activeBranchId: branch.activeBranchId, allMine: branch.allMine };
  return { setsLimits: dashboardSetsLimits(who), line: limitLineFor(who) };
}
