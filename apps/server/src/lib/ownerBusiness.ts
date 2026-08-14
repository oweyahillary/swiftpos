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
 * Resolve a business's OWNER public.users.id — the token principal a redeemed
 * enrolment code mints under (A69). The admin issuing a code is an `admin_users`
 * row, not a `public.users` row, so `created_by` on the code cannot be the admin;
 * it must be the owner, exactly as the owner-issued path used `req.userId`.
 *
 * The owner user row is created by `POST /clients` with `email = businesses.email`
 * and the seeded `owner` role (see admin.ts create-business). We resolve by that
 * same email — an exact, case-insensitive match, `%`/`_` neutralised — so this
 * agrees with `resolveOwnerUserRow` in auth.ts, which does the same match on the
 * desktop-login path. (Kept here so admin.ts need not import from a routes file;
 * if the two ever unify, this is the home.)
 *
 * Returns null rather than throwing — the caller decides how to fail, and issuing
 * a code with no valid principal must be refused, not papered over.
 */
export async function resolveOwnerUserId(businessId: string): Promise<string | null> {
  const { data: biz } = await supabase
    .from('businesses').select('email').eq('id', businessId).maybeSingle();
  const email = String((biz as any)?.email ?? '').trim().toLowerCase();
  if (!email) return null;

  const likeSafe = email.replace(/[\\%_]/g, ch => `\\${ch}`);
  const { data: candidates, error } = await supabase
    .from('users').select('id, email')
    .eq('business_id', businessId).ilike('email', likeSafe).limit(200);
  if (error) return null;

  const match = (candidates ?? []).find(
    (u: any) => String(u.email ?? '').trim().toLowerCase() === email,
  );
  return (match as any)?.id ?? null;
}
