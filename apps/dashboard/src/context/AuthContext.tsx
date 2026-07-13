/**
 * AuthContext — single Supabase auth subscription for the entire app.
 *
 * Mounted ONCE at the root in App.tsx (not per-route).
 * This eliminates the triple-subscription bug where navigating between
 * /dashboard, /pos, and /manager destroyed and recreated the auth tree,
 * causing full context reloads on every route transition.
 *
 * signOut() calls clearAllTokens() — wipes every SwiftPOS localStorage key
 * (owner token, POS token, branch selection, cashier session) so no stale
 * data leaks when a different user logs in on the same device.
 */

import {
  createContext, useContext, useEffect, useState, useRef, type ReactNode,
} from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { clearAllTokens, signalSessionExpired } from '../lib/api';

interface AuthContextType {
  session:  Session | null;
  user:     User | null;
  /** True only during the initial session check on cold boot. */
  loading:  boolean;
  signOut:  () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  // Guard against setting state after unmount (StrictMode double-invoke)
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;

    // ── 1. Restore persisted session synchronously (Supabase v2 returns it
    //       from its in-memory cache — no network call on warm boots).
    supabase.auth.getSession().then(({ data }) => {
      if (mounted.current) {
        setSession(data.session);
        setLoading(false);
      }
    });

    // ── 2. React to Supabase auth events (token refresh, sign-out, etc.)
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (_event, newSession) => {
        if (mounted.current) setSession(newSession);
      },
    );

    // ── 3. SwiftPOS token expiry signal from api.ts
    function handleSessionExpired() {
      supabase.auth.signOut();   // clears Supabase session; triggers onAuthStateChange
    }
    window.addEventListener('swiftpos:session-expired', handleSessionExpired);

    return () => {
      mounted.current = false;
      subscription.unsubscribe();
      window.removeEventListener('swiftpos:session-expired', handleSessionExpired);
    };
  }, []);

  const signOut = async () => {
    clearAllTokens();              // wipe ALL SwiftPOS tokens + cashier session
    await supabase.auth.signOut(); // triggers onAuthStateChange → session = null
  };

  return (
    <AuthContext.Provider value={{ session, user: session?.user ?? null, loading, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
