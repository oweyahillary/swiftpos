/**
 * ownerBusiness.ts — resolve which business an owner is acting for.
 *
 * WHY THIS IS A SHARED FUNCTION AND NOT THREE COPIES
 *
 * The same six lines existed in three places:
 *
 *     routes/auth.ts:482      owner email+password login
 *     routes/auth.ts:586      owner session refresh
 *     middleware/auth.ts      every request bearing a Supabase JWT
 *
 * All three did:
 *
 *     .from('businesses').select(...).eq('owner_id', uid).single()
 *
 * and all three told the owner "No business found for this account" when the
 * truth was that TWO were found. `.single()` raises PGRST116 on more than one
 * row, the error was tested only for truthiness, and the message was written
 * for the zero-row case. An owner who opens a second business is locked out of
 * the first one, permanently, with an error saying the opposite of what
 * happened.
 *
 * This is the same failure as BUG-05 (pos-login telling a cashier their PIN was
 * wrong when their email was in two tenants). That one was fixed for cashiers
 * and the owner path was left alone — three times over, because the code was
 * duplicated. Hence one function.
 *
 * WHAT IT DOES WITH MORE THAN ONE
 * Returns them all and lets the caller decide, because the right answer differs
 * by caller: login can ask which one, and middleware cannot ask anything. What
 * none of them may do is guess, or claim there are none.
 */
import { supabase } from './supabase';

export interface OwnedBusiness {
  id:       string;
  name?:    string;
  currency?: string;
  type?:    string;
  status?:  string;
}

export type OwnerBusinessResult =
  | { kind: 'none' }
  | { kind: 'one';  business: OwnedBusiness }
  | { kind: 'many'; businesses: OwnedBusiness[] }
  | { kind: 'error'; message: string };

/**
 * @param ownerId  auth.users.id from the Supabase JWT
 * @param columns  what the caller needs; middleware only wants the id
 * @param preferId if the caller knows which business is meant (a stored
 *                 preference, a query param), it wins when it is one of theirs
 */
export async function resolveOwnerBusinesses(
  ownerId: string,
  columns = 'id, name, currency, type, status',
  preferId?: string | null,
): Promise<OwnerBusinessResult> {
  // No .single(). Ordered so that "the first one" is stable rather than
  // whatever Postgres happened to return — an owner who is sent to a different
  // business on alternate logins is worse than one who is asked.
  const { data, error } = await supabase
    .from('businesses')
    .select(columns)
    .eq('owner_id', ownerId)
    .order('created_at', { ascending: true })
    .limit(50);

  if (error) return { kind: 'error', message: error.message };

  const rows = (data ?? []) as unknown as OwnedBusiness[];
  if (rows.length === 0) return { kind: 'none' };
  if (rows.length === 1) return { kind: 'one', business: rows[0] };

  if (preferId) {
    const hit = rows.find(b => b.id === preferId);
    if (hit) return { kind: 'one', business: hit };
  }

  return { kind: 'many', businesses: rows };
}

/**
 * For callers that cannot ask a question — middleware on an ordinary request.
 * Takes the oldest business, which is stable and is the one a single-business
 * owner has always had. A caller using this MUST NOT be the place where the
 * choice is made; it is a fallback so that having two businesses does not break
 * every API call while the owner picks one at login.
 */
export function firstOrNull(r: OwnerBusinessResult): OwnedBusiness | null {
  if (r.kind === 'one')  return r.business;
  if (r.kind === 'many') return r.businesses[0];
  return null;
}

/**
 * Resolve a business's OWNER public.users.id — for the admin portal's owner actions (resetting the owner's sign-in
 * codes). Never for a till: a till's session is its own and names no person (A415, lib/deviceGrant.ts).
 *
 * Returns null rather than throwing — the caller decides how to fail.
 */
/**
 * 2026-10-02 (owner, admin portal "Enrol till" on a newly registered client: "Could not resolve the business owner for
 * this code"; an older test client worked). Matching ONLY on `businesses.email` fails whenever that is not the owner's
 * sign-in email — self-signup stores the business CONTACT email from the form when one is given, and the owner can change
 * it in Settings › Business › Profile. Now, in order:
 *   1. the owner's SIGN-IN email (`businesses.owner_id` → the auth user) — the truth;
 *   2. `businesses.email` (how every client resolved before);
 *   3. the business's one active user with the `owner` role.
 * An email that matches more than one user is not taken (never guess between people). Pure part: pickOwnerUserId.
 */
export interface OwnerCandidate { id: string; email?: string | null; status?: string | null; role_name?: string | null }

export function pickOwnerUserId(
  users: OwnerCandidate[], opts: { authEmail?: string | null; businessEmail?: string | null },
): string | null {
  const norm = (e: unknown) => String(e ?? '').trim().toLowerCase();
  for (const email of [norm(opts.authEmail), norm(opts.businessEmail)]) {
    if (!email) continue;
    const hits = users.filter((u) => norm(u.email) === email);
    if (hits.length === 1) return hits[0].id;
  }
  const owners = users.filter((u) => norm(u.role_name) === 'owner' && norm(u.status || 'active') === 'active');
  return owners.length === 1 ? owners[0].id : null;
}

export async function resolveOwnerUserId(businessId: string): Promise<string | null> {
  const { data: biz } = await supabase
    .from('businesses').select('email, owner_id').eq('id', businessId).maybeSingle();
  if (!biz) return null;

  let authEmail: string | null = null;
  const ownerAuthId = (biz as { owner_id?: string | null }).owner_id;
  if (ownerAuthId) {
    try {
      const { data } = await supabase.auth.admin.getUserById(ownerAuthId);
      authEmail = data?.user?.email ?? null;
    } catch { /* fall through to the business email */ }
  }

  const { data: users, error } = await supabase
    .from('users').select('id, email, status, roles ( name )')
    .eq('business_id', businessId).limit(500);
  if (error) return null;
  const candidates: OwnerCandidate[] = (users ?? []).map((u: any) => ({
    id: u.id, email: u.email, status: u.status, role_name: u.roles?.name ?? null,
  }));
  return pickOwnerUserId(candidates, { authEmail, businessEmail: (biz as { email?: string | null }).email ?? null });
}
