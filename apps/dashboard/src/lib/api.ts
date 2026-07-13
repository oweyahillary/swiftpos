/**
 * api.ts — HTTP client for the SwiftPOS dashboard.
 *
 * Token strategy (two separate key-spaces, never mixed):
 *
 *   OWNER surface  (/dashboard/*, /login)
 *     swiftpos_access_token   — 15-min SwiftPOS JWT (owner login)
 *     swiftpos_refresh_token  — 30-day refresh token
 *
 *   POS surface  (/pos/*, /manager)
 *     swiftpos_pos_token          — cashier/manager SwiftPOS JWT
 *     swiftpos_pos_refresh_token  — 30-day refresh token
 *
 * On logout, clearAllTokens() wipes EVERY key so no session leaks
 * across owner → cashier or device-sharing scenarios.
 */

import { supabase } from './supabase';

import { API_URL } from './config';
const BASE_URL = API_URL;

// ── Storage keys (single source of truth) ────────────────────────────────────
export const TOKEN_KEYS = {
  ownerAccess:   'swiftpos_access_token',
  ownerRefresh:  'swiftpos_refresh_token',
  posAccess:     'swiftpos_pos_token',
  posRefresh:    'swiftpos_pos_refresh_token',
  activeBranch:  'swiftpos_active_branch',
  cashierSession:'swiftpos_cashier_session',   // sessionStorage
} as const;

function onPosSurface(): boolean {
  return typeof window !== 'undefined' &&
    (window.location.pathname.startsWith('/pos') ||
     window.location.pathname.startsWith('/manager'));
}

function accessKey():  string { return onPosSurface() ? TOKEN_KEYS.posAccess  : TOKEN_KEYS.ownerAccess; }
function refreshKey(): string { return onPosSurface() ? TOKEN_KEYS.posRefresh : TOKEN_KEYS.ownerRefresh; }

// ── Token storage ─────────────────────────────────────────────────────────────

export function storeSwiftPOSToken(token: string)  { localStorage.setItem(accessKey(),  token); }
export function storeRefreshToken(token: string)   { localStorage.setItem(refreshKey(), token); }

/** Clears only the current surface's tokens. */
export function clearSwiftPOSToken() {
  localStorage.removeItem(accessKey());
  localStorage.removeItem(refreshKey());
}

/**
 * Full wipe — call this on owner logout or session expiry.
 * Clears ALL SwiftPOS tokens, branch selection, and cashier session
 * so no stale data leaks to the next user on a shared device.
 * Also revokes the owner refresh token server-side (best effort).
 */
export function clearAllTokens() {
  // Best-effort server-side revocation of the owner refresh token
  const ownerRefresh = localStorage.getItem(TOKEN_KEYS.ownerRefresh);
  const ownerAccess  = localStorage.getItem(TOKEN_KEYS.ownerAccess);
  if (ownerRefresh) {
    fetch(`${BASE_URL}/api/auth/logout`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        ...(ownerAccess ? { 'Authorization': `Bearer ${ownerAccess}` } : {}),
      },
      body: JSON.stringify({ refreshToken: ownerRefresh }),
    }).catch(() => {}); // fire-and-forget
  }

  localStorage.removeItem(TOKEN_KEYS.ownerAccess);
  localStorage.removeItem(TOKEN_KEYS.ownerRefresh);
  localStorage.removeItem(TOKEN_KEYS.posAccess);
  localStorage.removeItem(TOKEN_KEYS.posRefresh);
  localStorage.removeItem(TOKEN_KEYS.activeBranch);
  // Clear all scoped cashier session keys
  const keysToRemove: string[] = [];
  for (let i = 0; i < sessionStorage.length; i++) {
    const key = sessionStorage.key(i);
    if (key?.startsWith(TOKEN_KEYS.cashierSession)) keysToRemove.push(key);
  }
  keysToRemove.forEach(k => sessionStorage.removeItem(k));
  sessionStorage.removeItem(TOKEN_KEYS.cashierSession); // legacy unsoped key
}

function getStoredAccessToken():  string | null { return localStorage.getItem(accessKey()); }
function getStoredRefreshToken(): string | null { return localStorage.getItem(refreshKey()); }

// ── Session-expired event ─────────────────────────────────────────────────────
// Fired when a token refresh fails. AuthContext listens and signs out cleanly.
// Using a custom event avoids window.location hacks that break the router.

let sessionExpiredFired = false;

export function signalSessionExpired() {
  if (sessionExpiredFired) return;
  sessionExpiredFired = true;
  clearAllTokens();
  window.dispatchEvent(new CustomEvent('swiftpos:session-expired'));
  setTimeout(() => { sessionExpiredFired = false; }, 3000);
}

// ── Token refresh (single in-flight guard) ────────────────────────────────────

let refreshInFlight: Promise<string> | null = null;

async function refreshAccessToken(): Promise<string> {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    const refreshToken = getStoredRefreshToken();
    if (!refreshToken) throw new Error('No refresh token');

    const res = await fetch(`${BASE_URL}/api/auth/refresh`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ refreshToken }),
    });

    if (!res.ok) throw new Error('Refresh failed');

    const data = await res.json();
    storeSwiftPOSToken(data.accessToken);
    if (data.refreshToken) storeRefreshToken(data.refreshToken);
    return data.accessToken as string;
  })().finally(() => { refreshInFlight = null; });

  return refreshInFlight;
}

// ── Auth header ───────────────────────────────────────────────────────────────
// Priority: SwiftPOS JWT → Supabase session (owner web login fallback).
// getSession() is synchronous in Supabase v2 when the session is cached —
// no network call, no added latency on requests.

async function getAuthHeader(): Promise<Record<string, string>> {
  const swiftposToken = getStoredAccessToken();
  if (swiftposToken) return { Authorization: `Bearer ${swiftposToken}` };

  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// ── Core request ──────────────────────────────────────────────────────────────

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  isRetry = false,
): Promise<T> {
  const authHeader = await getAuthHeader();

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...authHeader },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  // ── 401: attempt token refresh once, then signal expiry ──────────────────
  if (res.status === 401 && !isRetry) {
    // Parse the body to check for specific error codes before deciding how to handle
    const errBody = await res.json().catch(() => ({}));

    const hadToken = !!getStoredAccessToken();
    if (hadToken) {
      // PERMISSIONS_CHANGED: role/permissions updated since token was issued.
      // Refresh to get a token with current permissions, then retry.
      // TOKEN_REPLAYED: refresh token was used twice (possible theft).
      // In both cases, refresh first and let the retry surface the real error if any.
      try {
        await refreshAccessToken();
        return request<T>(method, path, body, true);
      } catch {
        signalSessionExpired();
        return new Promise(() => {}); // halt — sign-out is in flight
      }
    }
    // No stored token — let 401 propagate (login page, unauthenticated call)
    const err = new Error(errBody.error ?? `Request failed: 401`) as Error & { code?: string; status?: number };
    err.code   = errBody.code;
    err.status = 401;
    throw err;
  }

  if (res.status === 204) return undefined as T;

  const json = await res.json();

  if (!res.ok) {
    const err = new Error(json.error ?? `Request failed: ${res.status}`) as Error & {
      code?: string;
      status?: number;
    };
    err.code   = json.code;
    err.status = res.status;
    throw err;
  }

  return json as T;
}

export const api = {
  get:    <T>(path: string)                => request<T>('GET',    path),
  post:   <T>(path: string, body: unknown) => request<T>('POST',   path, body),
  put:    <T>(path: string, body: unknown) => request<T>('PUT',    path, body),
  patch:  <T>(path: string, body: unknown) => request<T>('PATCH',  path, body),
  delete: <T>(path: string)               => request<T>('DELETE', path),
};
