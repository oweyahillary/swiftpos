/**
 * branchChoice.ts — A582: "All my branches", the dashboard's branch picker rules (pure — tested without React or the API).
 *
 * Owner, 2026-10-23: "assume i have partner a and they fully own shop x,y and z they should never see general sales for
 * all stores only their store" … "yes i want all my branch feature".
 *
 * The owner (and a partner of every branch) picks "All Branches" or one branch. A partner of SOME branches (two or more)
 * picks "All my branches (3)" — their branches combined, sent to the cloud as X-Branch-Id 'mine' (lib/api.ts), which
 * reads exactly their list — or one of theirs. A partner of one branch, a manager: one branch, as before.
 */
/** A582: what is remembered (and sent as X-Branch-Id by lib/api.ts) for "All my branches". */
export const MY_BRANCHES = 'mine';
/** A582: "All my branches (3)". */
export const myBranchesLabel = (n: number): string => `All my branches (${n})`;

/**
 * A582: the choice to restore from what was remembered — pure, so the picker's rules are tested without React.
 * 'all' only where "All Branches" is on offer, 'mine' only where "All my branches" is; a branch id only when it is one of
 * the list; else the main branch (as for the owner).
 */
export function restoreChoice(saved: string | null, list: Array<{ id: string; is_main?: boolean }>, allowAll: boolean, allowMine: boolean):
  { kind: 'all' } | { kind: 'mine' } | { kind: 'branch'; id: string } | { kind: 'none' } {
  if (saved === 'all' && allowAll) return { kind: 'all' };
  if (saved === MY_BRANCHES && allowMine) return { kind: 'mine' };
  const found = saved ? list.find((b) => b.id === saved) : undefined;
  if (found) return { kind: 'branch', id: found.id };
  const pick = list.find((b) => b.is_main) ?? list[0];
  return pick ? { kind: 'branch', id: pick.id } : { kind: 'none' };
}
