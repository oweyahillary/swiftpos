/**
 * PermissionsContext — loads roles and permissions for the owner.
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
 * 3. Parallel fetch: roles and permissions are fetched simultaneously,
 *    not sequentially.
 */

import {
  createContext, useContext, useEffect, useState, useCallback, type ReactNode,
} from 'react';
import { api } from '../lib/api';
import { useAuth } from './AuthContext';

interface Permission {
  id:     string;
  key:    string;
  label:  string;
  module: string;
}

interface Role {
  id:          string;
  name:        string;
  description: string | null;
  is_default:  boolean;
  role_permissions: { permission_id: string }[];
}

interface PermissionsContextType {
  permissionKeys:  Set<string>;
  roles:           Role[];
  allPermissions:  Permission[];
  can:             (key: string) => boolean;
  loading:         boolean;
  refresh:         () => void;
}

const PermissionsContext = createContext<PermissionsContextType | null>(null);

export function PermissionsProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  const [permissionKeys,  setPermissionKeys]  = useState<Set<string>>(new Set());
  const [roles,           setRoles]           = useState<Role[]>([]);
  const [allPermissions,  setAllPermissions]  = useState<Permission[]>([]);
  const [loading,         setLoading]         = useState(true);
  const [tick,            setTick]            = useState(0);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      // Parallel fetch — both in flight simultaneously
      const [rolesData, permsData] = await Promise.all([
        api.get<Role[]>('/api/staff/roles'),
        api.get<Permission[]>('/api/staff/permissions'),
      ]);

      if (signal?.aborted) return;

      setRoles(rolesData ?? []);
      setAllPermissions(permsData ?? []);

      // Dashboard user is always the business owner
      const ownerRole = (rolesData ?? []).find(r => r.name === 'owner');
      if (ownerRole) {
        const ownerPermIds = new Set(ownerRole.role_permissions.map(rp => rp.permission_id));
        const keys = (permsData ?? [])
          .filter(p => ownerPermIds.has(p.id))
          .map(p => p.key);
        setPermissionKeys(new Set(keys));
      } else {
        setPermissionKeys(new Set(['*'])); // fallback: grant all
      }
    } catch {
      if (!signal?.aborted) {
        setPermissionKeys(new Set(['*'])); // don't lock the owner out on error
      }
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!session) {
      // Sign-out: clear immediately
      setPermissionKeys(new Set());
      setRoles([]);
      setAllPermissions([]);
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();

  // ── Stable dependency: user ID, not access_token.
  // access_token rotates every 15 min → would reload permissions repeatedly.
  // user.id is fixed for the lifetime of the login session.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.user.id, tick]);

  const refresh = useCallback(() => setTick(t => t + 1), []);

  const can = useCallback((key: string): boolean => {
    if (permissionKeys.has('*')) return true;
    return permissionKeys.has(key);
  }, [permissionKeys]);

  return (
    <PermissionsContext.Provider
      value={{ permissionKeys, roles, allPermissions, can, loading, refresh }}
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
