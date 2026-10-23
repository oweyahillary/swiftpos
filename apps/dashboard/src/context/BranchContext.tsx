/**
 * BranchContext — loads branches for the active owner session.
 *
 * Fixes:
 * 1. Auth-gated: only fetches when `session` is present.
 *    Previously fired unconditionally on mount, hitting /api/branches
 *    with no token → 401 → signalSessionExpired() → sign-out loop
 *    on the login page before any login had happened.
 *
 * 2. Clears on sign-out: when session becomes null the branch list
 *    is reset so a new owner login doesn't see the previous owner's
 *    branches for a render cycle.
 *
 * 3. Stable branch selection: localStorage persists the selection
 *    across refreshes but is cleared by clearAllTokens() on logout.
 */

import {
  createContext, useContext, useState, useEffect, useCallback, type ReactNode,
} from 'react';
import { api } from '../lib/api';
import { useAuth } from './AuthContext';
import { MY_BRANCHES, myBranchesLabel, restoreChoice } from '../lib/branchChoice';   // A582
export { MY_BRANCHES, myBranchesLabel, restoreChoice };

export interface Branch {
  id:       string;
  name:     string;
  address:  string | null;
  phone:    string | null;
  is_main:  boolean;
  status:   'active' | 'inactive';
}

interface BranchContextValue {
  branches:        Branch[];
  activeBranch:    Branch | null;   // null = "All Branches"
  activeBranchId:  string | null;
  setActiveBranch: (branch: Branch | null) => void;
  branchParam:     string;          // "branch_id=xxx" or ""
  loading:         boolean;
  refetchBranches: () => Promise<void>;
  /** A550: "All Branches" is on offer — the owner, or a partner who works at every branch (never one of some). */
  allowAll:        boolean;
  /**
   * A582: "All my branches" is on offer — a partner who works at two or more branches but not every one. Their branches
   * combined (the cloud reads exactly their list, X-Branch-Id 'mine'); never the business's "All branches".
   */
  allowMine:       boolean;
  /** A582: "All my branches" is the choice now (activeBranch is null then, as the owner's "All Branches"). */
  allMine:         boolean;
  /** A582: the words for "every branch in view": "All branches" for the owner, "All my branches (3)" for such a partner. */
  allLabel:        string;
}

const BranchContext  = createContext<BranchContextValue | null>(null);
const STORAGE_KEY    = 'swiftpos_active_branch';
export function BranchProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  const [branches,       setBranches]        = useState<Branch[]>([]);
  const [activeBranch,   setActiveBranchState] = useState<Branch | null>(null);
  const [loading,        setLoading]         = useState(true);
  const [allowAll,       setAllowAll]        = useState(true);
  const [allowMine,      setAllowMine]       = useState(false);   // A582
  const [allMine,        setAllMine]         = useState(false);   // A582

  const fetchBranches = useCallback(async () => {
    try {
      // A550: a partner of some branches gets only theirs from /api/branches, and no "All Branches" (/api/auth/session);
      // the owner — or an older cloud without /session — keeps the picker as it was.
      const [data, web] = await Promise.all([
        api.get<Branch[]>('/api/branches'),
        api.get<{ allBranches?: boolean; partner?: boolean }>('/api/auth/session').catch(() => null),
      ]);
      const all = web?.allBranches !== false;
      // A582: a partner of two or more branches (not every one) — "All my branches", their branches combined
      const mine = !all && web?.partner === true && data.length >= 2;
      setAllowAll(all);
      setAllowMine(mine);
      setBranches(data);

      // Restore persisted selection, else default to main branch
      const saved = localStorage.getItem(STORAGE_KEY);
      const choice = restoreChoice(saved, data, all, mine);
      if (choice.kind === 'all') {
        setActiveBranchState(null); setAllMine(false);
      } else if (choice.kind === 'mine') {
        setActiveBranchState(null); setAllMine(true);
        if (saved !== MY_BRANCHES) localStorage.setItem(STORAGE_KEY, MY_BRANCHES);
      } else {
        const pick = choice.kind === 'branch' ? data.find(b => b.id === choice.id) ?? null : null;
        setActiveBranchState(pick); setAllMine(false);
        // A550: a partner's remembered choice that is not theirs (another login's, or "all") — the picked branch is what
        // the cloud acts at (X-Branch-Id), so remember it. A582: and never a 'mine' left from a partner's sign-in.
        if (pick && (!all || saved === MY_BRANCHES) && saved !== pick.id) localStorage.setItem(STORAGE_KEY, pick.id);
      }
    } catch {
      // Silent — 401s are handled by api.ts; network errors shouldn't crash the UI
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!session) {
      // Sign-out: reset immediately so next login starts clean
      setBranches([]);
      setActiveBranchState(null);
      setAllMine(false);   // A582
      setAllowMine(false);
      setLoading(false);
      return;
    }
    setLoading(true);
    fetchBranches();
  }, [session, fetchBranches]);

  function setActiveBranch(branch: Branch | null) {
    setActiveBranchState(branch);
    // A582: "every branch" for such a partner is "All my branches" ('mine' — the cloud reads exactly theirs)
    const mineNow = !branch && allowMine && !allowAll;
    setAllMine(mineNow);
    localStorage.setItem(STORAGE_KEY, branch ? branch.id : mineNow ? MY_BRANCHES : 'all');
  }

  const activeBranchId = activeBranch?.id ?? null;
  const branchParam    = activeBranchId ? `branch_id=${activeBranchId}` : '';
  const allLabel       = allowMine && !allowAll ? myBranchesLabel(branches.length) : 'All branches';

  return (
    <BranchContext.Provider value={{
      branches, activeBranch, activeBranchId,
      setActiveBranch, branchParam, loading,
      refetchBranches: fetchBranches, allowAll, allowMine, allMine, allLabel,
    }}>
      {children}
    </BranchContext.Provider>
  );
}

export function useBranch(): BranchContextValue {
  const ctx = useContext(BranchContext);
  if (!ctx) throw new Error('useBranch must be used inside BranchProvider');
  return ctx;
}
