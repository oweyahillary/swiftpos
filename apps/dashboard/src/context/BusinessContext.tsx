/**
 * BusinessContext — loads the current owner's business record.
 *
 * Fix: gates on `session` (not `user`) so the fetch only fires once
 * the Supabase session is confirmed. Using `user` caused a race where
 * the context fetched with no token, got null, and stayed stale until
 * the next render cycle triggered another attempt.
 */

import {
  createContext, useContext, useEffect, useState, useCallback, type ReactNode,
} from 'react';
import { api } from '../lib/api';
import { useAuth } from './AuthContext';
import type { Business } from '../types';

interface BusinessContextType {
  business: Business | null;
  loading:  boolean;
  refresh:  () => void;
}

const BusinessContext = createContext<BusinessContextType | null>(null);

export function BusinessProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  const [business, setBusiness] = useState<Business | null>(null);
  const [loading, setLoading]   = useState(true);
  const [tick, setTick]         = useState(0);

  useEffect(() => {
    // ── Auth gate: only fetch when we have a confirmed session.
    // Also handles POS surface: cashier POS token lives in localStorage
    // as 'swiftpos_pos_token'; api.ts picks it up via accessKey().
    const hasPosToken = !!localStorage.getItem('swiftpos_pos_token');
    if (!session && !hasPosToken) {
      setBusiness(null);
      setLoading(false);
      return;
    }

    let live = true;
    setLoading(true);
    api.get<Business>('/api/business')
      .then(data  => { if (live) setBusiness(data); })
      .catch(()   => { if (live) setBusiness(null); })
      .finally(() => { if (live) setLoading(false); });

    return () => { live = false; };
  }, [session, tick]);

  const refresh = useCallback(() => setTick(t => t + 1), []);

  return (
    <BusinessContext.Provider value={{ business, loading, refresh }}>
      {children}
    </BusinessContext.Provider>
  );
}

export function useBusiness() {
  const ctx = useContext(BusinessContext);
  if (!ctx) throw new Error('useBusiness must be used within BusinessProvider');
  return ctx;
}
