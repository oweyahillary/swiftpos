/**
 * tenant.ts — A378: a client's own sign-in address (africanfries.<TENANT_ROOT_DOMAIN>).
 *
 * The sign-in pages on a client's address send its subdomain; this finds the business it names. /login and /pos-login
 * then admit only that business's people, and GET /api/tenant/:subdomain gives the page the client's name and logo.
 * The format rule is shared/tenantHost.ts (copied to lib/tenantHost.ts).
 */
import { supabase } from './supabase';
import { cleanRootDomain, subdomainProblem } from './tenantHost';

/** The root domain the client addresses sit under (TENANT_ROOT_DOMAIN, e.g. "zaptill.co.ke"); '' = feature off. */
export function tenantRootDomain(): string {
  return cleanRootDomain(process.env.TENANT_ROOT_DOMAIN);
}

/** A client's full sign-in address, or null when it has none or the root is not configured. */
export function signInAddress(subdomain: unknown): string | null {
  const root = tenantRootDomain();
  return root && typeof subdomain === 'string' && subdomain ? `https://${subdomain}.${root}` : null;
}

export interface Tenant { id: string; name: string; status: string }
export type TenantLookup = { kind: 'none' } | { kind: 'found'; tenant: Tenant } | { kind: 'unknown' } | { kind: 'error' };

/**
 * The business a sign-in names by its subdomain. `none` = no subdomain sent (the main address — behaviour unchanged);
 * `unknown` = a subdomain no business has (or a malformed one) — the caller refuses the sign-in, never falls back to
 * "any business".
 */
export async function findTenant(raw: unknown): Promise<TenantLookup> {
  if (raw === undefined || raw === null || raw === '') return { kind: 'none' };
  if (typeof raw !== 'string') return { kind: 'unknown' };
  const sub = raw.trim().toLowerCase();
  if (subdomainProblem(sub)) return { kind: 'unknown' };
  const { data, error } = await supabase
    .from('businesses')
    .select('id, name, status')
    .eq('subdomain', sub)
    .maybeSingle();
  if (error) return { kind: 'error' };
  if (!data) return { kind: 'unknown' };
  return { kind: 'found', tenant: data as Tenant };
}

/**
 * /login on a client's address: the business the account may open there — the tenant itself when the account owns it
 * (alone or among others), else null (refused: NOT_THIS_BUSINESS). Never another business the account also owns.
 */
export function ownedTenantBusiness<T extends { id: string }>(
  owned: { kind: 'none' } | { kind: 'error'; message?: string } | { kind: 'one'; business: T } | { kind: 'many'; businesses: T[] },
  tenantId: string,
): T | null {
  if (owned.kind === 'one')  return owned.business.id === tenantId ? owned.business : null;
  if (owned.kind === 'many') return owned.businesses.find(b => b.id === tenantId) ?? null;
  return null;
}
