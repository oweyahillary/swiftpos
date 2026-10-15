/**
 * PermissionsContext — the owner dashboard's permissions: the owner holds '*' (A202, A490).
 *
 * Fixes:
 * 1. Stable dependency: previously subscribed to `session?.access_token`
 *    which changed on every token refresh (every 15 min), triggering a
 *    full permissions reload that caused the dashboard to flicker blank.
 *    Now uses the Supabase user ID (`session?.user.id`) which is stable
 *    for the lifetime of the login.
 *
 * 2. Resets cleanly on sign-out so the next login starts with a clean slate.
 *
 * 3. A490: nothing is fetched — the owner holds '*' (see below).
 */

import {
  createContext, useContext, useEffect, useState, useCallback, type ReactNode,
} from 'react';
import { useAuth } from './AuthContext';

// A490: the owner dashboard's user is ALWAYS the business owner — '*' (the cloud never refuses the owner). The role and
// permission lists this context used to fetch were never read (Settings › Roles and permissions loads its own, on the
// catalogue API), so they are gone; the PIN-session apps use POSAuthContext.hasPermission (expandMap of the session).

interface PermissionsContextType {
  permissionKeys:  Set<string>;
  can:             (key: string) => boolean;
  loading:         boolean;
  refresh:         () => void;
}

const PermissionsContext = createContext<PermissionsContextType | null>(null);

export function PermissionsProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  const [permissionKeys,  setPermissionKeys]  = useState<Set<string>>(new Set());
  const [loading,         setLoading]         = useState(true);
  const [tick,            setTick]            = useState(0);

  useEffect(() => {
    if (!session) {
      // Sign-out: clear immediately
      setPermissionKeys(new Set());
      setLoading(false);
      return;
    }
    // A202: the dashboard user is ALWAYS the business owner, and the server treats the owner as all-access
    // (requirePermission() bypasses on req.isOwner). Mirror that wildcard here — never a filtered explicit set, which
    // once hid owner-only features (ingredients.manage, inventory.adjust).
    setPermissionKeys(new Set(['*']));
    setLoading(false);

  // ── Stable dependency: user ID, not access_token (it rotates every 15 min).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.user.id, tick]);

  const refresh = useCallback(() => setTick(t => t + 1), []);

  const can = useCallback((key: string): boolean => {
    if (permissionKeys.has('*')) return true;
    return permissionKeys.has(key);
  }, [permissionKeys]);

  return (
    <PermissionsContext.Provider
      value={{ permissionKeys, can, loading, refresh }}
    >
      {children}
    </PermissionsContext.Provider>
  );
}

export function usePermissions() {
  const ctx = useContext(PermissionsContext);
  if (!ctx) throw new Error('usePermissions must be used within PermissionsProvider');
  return ctx;
}
