/**
 * tenant.ts — A378: the sign-in pages on a client's own address (africanfries.<VITE_TENANT_ROOT_DOMAIN>).
 *
 * Reads the subdomain from the address bar, asks the cloud for the client's name and logo (GET /api/tenant/:subdomain),
 * and gives the sign-in calls the subdomain to send — the cloud then admits only that client's people. On any other
 * address (the main one, localhost, a preview) nothing changes.
 */
import { useEffect, useState } from 'react';
import { API_URL } from './config';
import { subdomainFromHost } from './tenantHost';

export interface TenantInfo { name: string; logo: string | null; accent: string | null }

export type TenantState =
  | { status: 'none' }                                            // not on a client's address
  | { status: 'loading'; subdomain: string }
  | { status: 'found';   subdomain: string; tenant: TenantInfo }
  | { status: 'unknown'; subdomain: string }                      // no business has this address
  | { status: 'error';   subdomain: string };                     // could not ask — sign-in still sends the subdomain

/** The client's subdomain in this page's address, or null. */
export function currentSubdomain(): string | null {
  if (typeof window === 'undefined') return null;
  return subdomainFromHost(window.location.hostname, import.meta.env.VITE_TENANT_ROOT_DOMAIN);
}

/** What the sign-in calls add to their body: `{ subdomain }` on a client's address, nothing elsewhere. */
export function tenantSignInFields(): { subdomain?: string } {
  const sub = currentSubdomain();
  return sub ? { subdomain: sub } : {};
}

/**
 * 0.6.36: the client last seen on this address, remembered in this browser — so their name and logo show at once on the
 * next visit (no flash of the default brand while the cloud answers); refreshed from the cloud every time.
 */
const CACHE_KEY = (sub: string) => `zaptill_tenant_${sub}`;
function cachedTenant(sub: string): TenantInfo | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY(sub));
    const t = raw ? JSON.parse(raw) : null;
    return t && typeof t.name === 'string' && t.name ? { name: t.name, logo: t.logo ?? null, accent: t.accent ?? null } : null;
  } catch { return null; }
}
function rememberTenant(sub: string, t: TenantInfo | null): void {
  try { if (t) localStorage.setItem(CACHE_KEY(sub), JSON.stringify(t)); else localStorage.removeItem(CACHE_KEY(sub)); }
  catch { /* storage unavailable: the next visit just waits for the cloud */ }
}

/** The initial state: remembered client → shown at once; otherwise loading (the page shows no brand until it knows). */
export function initialTenantState(sub: string | null): TenantState {
  if (!sub) return { status: 'none' };
  const t = cachedTenant(sub);
  return t ? { status: 'found', subdomain: sub, tenant: t } : { status: 'loading', subdomain: sub };
}

/** The client this address belongs to, for the sign-in page's logo and name. */
export function useTenant(): TenantState {
  const [sub] = useState(currentSubdomain);
  const [state, setState] = useState<TenantState>(() => initialTenantState(sub));
  useEffect(() => {
    if (!sub) return;
    let live = true;
    fetch(`${API_URL}/api/tenant/${encodeURIComponent(sub)}`)
      .then(async (res) => {
        if (!live) return;
        if (res.status === 404) { rememberTenant(sub, null); setState({ status: 'unknown', subdomain: sub }); return; }
        if (!res.ok) { setState({ status: 'error', subdomain: sub }); return; }
        const t = await res.json();
        const info: TenantInfo = { name: String(t.name ?? ''), logo: t.logo ?? null, accent: t.accent ?? null };
        rememberTenant(sub, info);
        setState({ status: 'found', subdomain: sub, tenant: info });
      })
      // Offline / the cloud did not answer: keep a remembered client on screen; otherwise fall back to the default brand.
      .catch(() => { if (live) setState((s) => (s.status === 'found' ? s : { status: 'error', subdomain: sub })); });
    return () => { live = false; };
  }, [sub]);
  return state;
}
