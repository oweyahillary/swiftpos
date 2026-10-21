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
}

const BranchContext  = createContext<BranchContextValue | null>(null);
const STORAGE_KEY    = 'swiftpos_active_branch';

export function BranchProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  const [branches,       setBranches]        = useState<Branch[]>([]);
  const [activeBranch,   setActiveBranchState] = useState<Branch | null>(null);
  const [loading,        setLoading]         = useState(true);
  const [allowAll,       setAllowAll]        = useState(true);

  const fetchBranches = useCallback(async () => {
    try {
      // A550: a partner of some branches gets only theirs from /api/branches, and no "All Branches" (/api/auth/session);
      // the owner — or an older cloud without /session — keeps the picker as it was.
      const [data, web] = await Promise.all([
        api.get<Branch[]>('/api/branches'),
        api.get<{ allBranches?: boolean }>('/api/auth/session').catch(() => null),
      ]);
      const all = web?.allBranches !== false;
      setAllowAll(all);
      setBranches(data);

      // Restore persisted selection, else default to main branch
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved === 'all' && all) {
        setActiveBranchState(null);
      } else if (saved) {
        const found = data.find(b => b.id === saved);
        const pick = found ?? data.find(b => b.is_main) ?? data[0] ?? null;
        setActiveBranchState(pick);
        // A550: a partner's remembered choice that is not theirs (another login's, or "all") — the picked branch is what
        // the cloud acts at (X-Branch-Id), so remember it.
        if (!all && pick && !found) localStorage.setItem(STORAGE_KEY, pick.id);
      } else {
        const pick = data.find(b => b.is_main) ?? data[0] ?? null;
        setActiveBranchState(pick);
        if (!all && pick) localStorage.setItem(STORAGE_KEY, pick.id);   // A550
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
      setLoading(false);
      return;
    }
    setLoading(true);
    fetchBranches();
  }, [session, fetchBranches]);

  function setActiveBranch(branch: Branch | null) {
    setActiveBranchState(branch);
    localStorage.setItem(STORAGE_KEY, branch ? branch.id : 'all');
  }

  const activeBranchId = activeBranch?.id ?? null;
  const branchParam    = activeBranchId ? `branch_id=${activeBranchId}` : '';

  return (
    <BranchContext.Provider value={{
      branches, activeBranch, activeBranchId,
      setActiveBranch, branchParam, loading,
      refetchBranches: fetchBranches, allowAll,
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
