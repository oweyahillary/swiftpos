import { createContext, useContext, useState, useCallback, useEffect, ReactNode } from 'react';
import { API_URL } from '../lib/config';

// ── Types ─────────────────────────────────────────────────────────────────────

export type BusinessMode =
  | 'restaurant'
  | 'cafe'
  | 'retail'
  | 'minimart'
  | 'parking'
  | 'petrol_station'
  | 'other';

export interface CashierSession {
  token:        string;
  refreshToken: string;   // stored here for server-side logout
  staffId:      string;
  staffName:    string;
  role:         string;
  branchId:     string;
  branchName:   string;
  businessType: BusinessMode;
  currency:     string;
  permissions:  Record<string, boolean>;
}

interface POSAuthContextType {
  session:             CashierSession | null;
  setCashierSession:   (s: CashierSession) => void;
  clearCashierSession: (callServer?: boolean) => Promise<void>;
  hasPermission:       (key: string) => boolean;
  posApi: {
    get:    <T>(path: string)                => Promise<T>;
    post:   <T>(path: string, body: unknown) => Promise<T>;
    patch:  <T>(path: string, body: unknown) => Promise<T>;
    delete: <T>(path: string)                => Promise<T>;
  };
}

// ── Storage key — scoped to userId (Fix 4) ────────────────────────────────────
// Using a userId-scoped key means two cashiers on the same browser tab each
// get their own isolated sessionStorage entry. The second cashier login no
// longer overwrites the first cashier's in-flight session.

const BASE_KEY = 'swiftpos_cashier_session';

function sessionKey(userId: string): string {
  return `${BASE_KEY}_${userId}`;
}

// On boot, try to load any existing session (any userId)
function loadAnySession(): CashierSession | null {
  try {
    // Find any key that starts with our prefix
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      if (key?.startsWith(BASE_KEY)) {
        const raw = sessionStorage.getItem(key);
        if (raw) return JSON.parse(raw) as CashierSession;
      }
    }
    return null;
  } catch {
    return null;
  }
}

// ── Context ───────────────────────────────────────────────────────────────────

const POSAuthContext = createContext<POSAuthContextType | null>(null);
const BASE_URL = API_URL;

export function POSAuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<CashierSession | null>(loadAnySession);

  const setCashierSession = useCallback((s: CashierSession) => {
    // Write to userId-scoped key
    sessionStorage.setItem(sessionKey(s.staffId), JSON.stringify(s));
    setSession(s);
  }, []);

  const clearCashierSession = useCallback(async (callServer = true) => {
    if (callServer && session?.refreshToken) {
      // Fix 2: tell the server to revoke this refresh token
      try {
        await fetch(`${BASE_URL}/api/auth/logout`, {
          method:  'POST',
          headers: {
            'Content-Type':  'application/json',
            'Authorization': `Bearer ${session.token}`,
          },
          body: JSON.stringify({ refreshToken: session.refreshToken }),
        });
      } catch {
        // Best-effort — don't block logout on network failure
      }
    }

    // Clear this cashier's scoped key
    if (session?.staffId) {
      sessionStorage.removeItem(sessionKey(session.staffId));
    }
    // Also clear any legacy unsoped key
    sessionStorage.removeItem(BASE_KEY);

    setSession(null);
  }, [session]);

  // Critical: when the POS access token expires and can't be refreshed, api.ts
  // fires 'swiftpos:session-expired'. Without reacting here, the cashier session
  // stays "active" while every API call 401s — the terminal silently breaks into
  // an empty "No products" screen with no shift controls. Dropping the session
  // sends the terminal back to the PIN lock, and the flag lets the lock screen
  // explain what happened.
  useEffect(() => {
    function onExpired() {
      sessionStorage.setItem('swiftpos_pos_expired', '1');
      clearCashierSession(false); // tokens already cleared by api.ts — no server call
    }
    window.addEventListener('swiftpos:session-expired', onExpired);
    return () => window.removeEventListener('swiftpos:session-expired', onExpired);
  }, [clearCashierSession]);

  const hasPermission = useCallback(
    (key: string) => {
      if (!session) return false;
      return session.permissions['*'] === true || session.permissions[key] === true;
    },
    [session],
  );

  const posRequest = useCallback(
    async <T,>(method: string, path: string, body?: unknown): Promise<T> => {
      const token = session?.token;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;

      const res = await fetch(`${BASE_URL}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });

      // Any 401 — expired token OR permissions changed. Try one refresh + retry;
      // if that fails, end the session cleanly so the terminal returns to the PIN
      // lock with a message (instead of silently 401'ing every call).
      if (res.status === 401) {
        if (session?.refreshToken) {
          try {
            const refreshRes = await fetch(`${BASE_URL}/api/auth/refresh`, {
              method:  'POST',
              headers: { 'Content-Type': 'application/json' },
              body:    JSON.stringify({ refreshToken: session.refreshToken }),
            });
            if (refreshRes.ok) {
              const refreshData = await refreshRes.json();
              const newToken = refreshData.accessToken ?? refreshData.token;
              setCashierSession({
                ...session,
                token:        newToken,
                refreshToken: refreshData.refreshToken ?? session.refreshToken,
              });
              const retryRes = await fetch(`${BASE_URL}${path}`, {
                method,
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${newToken}` },
                body: body !== undefined ? JSON.stringify(body) : undefined,
              });
              if (retryRes.status === 204) return undefined as T;
              const retryJson = await retryRes.json().catch(() => ({}));
              if (retryRes.ok) return retryJson as T;
              throw new Error(retryJson.error ?? `Request failed: ${retryRes.status}`);
            }
          } catch {
            // fall through to clean expiry
          }
        }
        // Couldn't refresh — return to the PIN lock with an explanation.
        sessionStorage.setItem('swiftpos_pos_expired', '1');
        await clearCashierSession(false);
        throw new Error('Session expired — please log in again');
      }

      if (res.status === 204) return undefined as T;
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `Request failed: ${res.status}`);
      return json as T;
    },
    [session, setCashierSession, clearCashierSession],
  );

  const posApi = {
    get:    <T,>(path: string)                => posRequest<T>('GET',    path),
    post:   <T,>(path: string, body: unknown) => posRequest<T>('POST',   path, body),
    patch:  <T,>(path: string, body: unknown) => posRequest<T>('PATCH',  path, body),
    delete: <T,>(path: string)                => posRequest<T>('DELETE', path),
  };

  return (
    <POSAuthContext.Provider value={{
      session, setCashierSession, clearCashierSession, hasPermission, posApi,
    }}>
      {children}
    </POSAuthContext.Provider>
  );
}

export function usePOSAuth() {
  const ctx = useContext(POSAuthContext);
  if (!ctx) throw new Error('usePOSAuth must be used within POSAuthProvider');
  return ctx;
}
