/**
 * PermissionsContext — the web dashboard's permissions: the owner holds '*' (A202, A490); a partner their own keys (A550).
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
 * 3. A490: the owner holds '*' (see below).
 *
 * 4. A550 (partner login): the dashboard is no longer only the owner's. GET /api/auth/session says who is signed in — the
 *    owner ('*'), or a partner (someone on the staff the owner let in with a password) with their OWN keys. The screens
 *    use `can` to show only what the person may use, and `isOwner` to hide what is the owner's alone (giving web access,
 *    the sign-in code switch, the kitchen display key). The cloud decides every request on its own either way.
 */

import {
  createContext, useContext, useEffect, useState, useCallback, type ReactNode,
} from 'react';
import { useAuth } from './AuthContext';
import { api } from '../lib/api';
import { expandMap } from '@zaptill/core/permissions';

// A490: the role and permission lists this context used to fetch were never read (Settings › Roles and permissions loads
// its own, on the catalogue API), so they are gone; the PIN-session apps use POSAuthContext.hasPermission (expandMap).

/** A550: GET /api/auth/session. */
interface WebSession {
  owner:        boolean;
  partner:      boolean;
  name:         string | null;
  permissions:  Record<string, boolean>;
  allBranches:  boolean;
  branchIds:    string[] | null;
  /** A568: the owner still has the password they were given — /change-password first. */
  mustChangePassword?: boolean;
}

interface PermissionsContextType {
  permissionKeys:  Set<string>;
  can:             (key: string) => boolean;
  /** A550: the owner (true until the session says otherwise — the owner's dashboard is unchanged if the call fails). */
  isOwner:         boolean;
  /** A550: a partner — a person on the staff with web dashboard access. */
  isPartner:       boolean;
  loading:         boolean;
  refresh:         () => void;
  /** A568: the owner must set a new password before using the dashboard (ProtectedRoute sends them there). */
  mustChangePassword: boolean;
  /** A568: the forced page set a new password — let them in without waiting for the session to be read again. */
  passwordChanged: () => void;
}

const PermissionsContext = createContext<PermissionsContextType | null>(null);

export function PermissionsProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  const [permissionKeys,  setPermissionKeys]  = useState<Set<string>>(new Set());
  const [isPartner,       setIsPartner]       = useState(false);
  const [mustChange,      setMustChange]      = useState(false);
  const [loading,         setLoading]         = useState(true);
  const [tick,            setTick]            = useState(0);

  useEffect(() => {
    if (!session) {
      // Sign-out: clear immediately
      setPermissionKeys(new Set());
      setIsPartner(false);
      setMustChange(false);
      setLoading(false);
      return;
    }
    // A202: the owner is all-access on the server (requirePermission() bypasses on req.isOwner) — mirrored here as '*',
    // never a filtered set, which once hid owner-only features (ingredients.manage, inventory.adjust). A550: a partner's
    // own keys instead, from the session.
    let live = true;
    setLoading(true);
    api.get<WebSession>('/api/auth/session')
      .then((s) => {
        if (!live) return;
        const partner = s?.partner === true && s?.owner !== true;
        setIsPartner(partner);
        setMustChange(!partner && s?.mustChangePassword === true);
        setPermissionKeys(partner ? expandMap(s.permissions ?? {}) : new Set(['*']));
      })
      .catch(() => {
        // An older cloud without /session, or a blip: the owner's dashboard as before (the cloud still refuses a partner).
        if (!live) return;
        setIsPartner(false);
        setPermissionKeys(new Set(['*']));
      })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };

  // ── Stable dependency: user ID, not access_token (it rotates every 15 min).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.user.id, tick]);

  const refresh = useCallback(() => setTick(t => t + 1), []);
  const passwordChanged = useCallback(() => setMustChange(false), []);

  const can = useCallback((key: string): boolean => {
    if (permissionKeys.has('*')) return true;
    return permissionKeys.has(key);
  }, [permissionKeys]);

  return (
    <PermissionsContext.Provider
      value={{ permissionKeys, can, isOwner: !isPartner, isPartner, loading, refresh,
        mustChangePassword: mustChange, passwordChanged }}
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
