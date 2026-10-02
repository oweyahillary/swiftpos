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

/** The client this address belongs to, for the sign-in page's logo and name. */
export function useTenant(): TenantState {
  const [sub] = useState(currentSubdomain);
  const [state, setState] = useState<TenantState>(sub ? { status: 'loading', subdomain: sub } : { status: 'none' });
  useEffect(() => {
    if (!sub) return;
    let live = true;
    fetch(`${API_URL}/api/tenant/${encodeURIComponent(sub)}`)
      .then(async (res) => {
        if (!live) return;
        if (res.status === 404) { setState({ status: 'unknown', subdomain: sub }); return; }
        if (!res.ok) { setState({ status: 'error', subdomain: sub }); return; }
        const t = await res.json();
        setState({ status: 'found', subdomain: sub, tenant: { name: String(t.name ?? ''), logo: t.logo ?? null, accent: t.accent ?? null } });
      })
      .catch(() => { if (live) setState({ status: 'error', subdomain: sub }); });
    return () => { live = false; };
  }, [sub]);
  return state;
}
