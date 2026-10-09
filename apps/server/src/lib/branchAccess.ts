/**
 * branchAccess.ts — A426: which branches a staff member may work at. ONE rule for every caller.
 *
 * A person with no branch assigned works at every branch of the business; one with branches assigned works at those
 * only. PIN sign-in (/auth/verify-pin) has always read it that way. The branch server's staff roster
 * (/api/pos/branch-staff) read it the other way — only staff with THIS branch explicitly assigned — so in a shop
 * where nobody is tied to a branch the server got an empty roster, and every till behind it said "This branch server
 * has no staff roster yet" while the same PINs signed in on the server itself (owner, 2026-10-09).
 */
export function worksAtBranch(userBranches: Array<{ branch_id: string | null }> | null | undefined, branchId: string): boolean {
  const assigned = (userBranches ?? []).filter((b) => !!b?.branch_id);
  return assigned.length === 0 || assigned.some((b) => b.branch_id === branchId);
}
