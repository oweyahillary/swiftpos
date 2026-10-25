/**
 * webPartners.ts — A550: partner login. Someone on the staff whom the owner lets into the full web dashboard with an
 * e-mail and a password, at the owner's own sign-in address — "full rights like an owner but not the owner".
 *
 * Owner, 2026-10-21: "I want to create a user, full rights like an owner but not the owner, they should be able to log
 * in using the URL and a password."
 *
 * WHO. A users row of the business that the OWNER marks for web dashboard access (routes/staff.ts /:id/web-access). The
 * person keeps their role and their keys — what they see and do is decided by those keys, as for anyone else; they are
 * NEVER the owner (req.isOwner stays false). Nobody on the owner's role (owner / admin, lib/ownerRole.ts) is a partner:
 * that role is everything by its name, so a partner on it would pass every owner-only check by the ceiling's '*'.
 *
 * THE LINK (no migration). users has no auth-id column, and users is UNIQUE (business_id, email), so the same e-mail can
 * be on the staff of two businesses — matching a sign-in account to a users row by e-mail alone could open the wrong
 * business. Two records, BOTH required at every sign-in and renewal:
 *   1. business_settings `web_partners` (one row per business, jsonb): users.id → { auth_user_id, status, dates }. The
 *      owner's grant — revoked here, the person is out.
 *   2. the sign-in account's app_metadata `zaptill_partner`: business id → users.id. Only the service role can write
 *      app_metadata (unlike user_metadata, which the account holder can change), so it names exactly which business and
 *      which person this password opens — the sign-in never searches by e-mail.
 * The grant names the account (auth_user_id) and the account names the grant (business → person): one without the other
 * opens nothing.
 *
 * BRANCHES. A partner works where their staff record says (lib/branchAccess.ts — none assigned = every branch). Every
 * branch → the owner's branch picker ("All branches" and each one: allBranches); some → the picker offers those, and the
 * session acts at the one picked, like a manager signed in there. Worked out at sign-in and at every renewal, carried in
 * the token (partnerBranches, allBranches); requireAuth takes the picked branch (X-Branch-Id) only when it is one of them.
 */
import crypto from 'crypto';
import { supabase } from './supabase';
import { isOwnerRoleName } from './ownerRole';

export const PARTNER_SETTING_KEY = 'web_partners';
export const PARTNER_META_KEY = 'zaptill_partner';

export type PartnerStatus = 'invited' | 'active' | 'revoked';
export interface PartnerRecord {
  auth_user_id: string;
  /** invited — access given, not signed in yet; active — has signed in; revoked — the owner took it away. */
  status: PartnerStatus;
  granted_at: string;
  granted_by: string | null;
  activated_at?: string | null;
  revoked_at?: string | null;
  revoked_reason?: string | null;
}
export type PartnerMap = Record<string, PartnerRecord>;

const UUIDISH = /^[0-9a-f-]{8,64}$/i;

/** The stored map, cleaned: anything that is not a well-formed record is dropped (read as no access). Pure. */
export function cleanPartnerMap(v: unknown): PartnerMap {
  let raw = v;
  if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { return {}; } }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: PartnerMap = {};
  for (const [userId, r] of Object.entries(raw as Record<string, any>)) {
    if (!UUIDISH.test(userId) || !r || typeof r !== 'object') continue;
    if (typeof r.auth_user_id !== 'string' || !r.auth_user_id) continue;
    if (!['invited', 'active', 'revoked'].includes(r.status)) continue;
    out[userId] = {
      auth_user_id: r.auth_user_id, status: r.status,
      granted_at: String(r.granted_at ?? ''), granted_by: typeof r.granted_by === 'string' ? r.granted_by : null,
      activated_at: r.activated_at ?? null, revoked_at: r.revoked_at ?? null, revoked_reason: r.revoked_reason ?? null,
    };
  }
  return out;
}

/** Is this a live grant for this sign-in account? Revoked, another account's, or none → no. Pure. */
export function partnerLive(rec: PartnerRecord | null | undefined, authUserId: string | null | undefined): boolean {
  return !!rec && (rec.status === 'invited' || rec.status === 'active') && !!authUserId && rec.auth_user_id === authUserId;
}

/** The (business, person) pairs a sign-in account's app_metadata names. Pure. */
export function metaLinks(appMeta: unknown): Array<{ businessId: string; userId: string }> {
  const m = (appMeta && typeof appMeta === 'object') ? (appMeta as Record<string, unknown>)[PARTNER_META_KEY] : null;
  if (!m || typeof m !== 'object' || Array.isArray(m)) return [];
  return Object.entries(m as Record<string, unknown>)
    .filter(([b, u]) => UUIDISH.test(b) && typeof u === 'string' && UUIDISH.test(u))
    .map(([businessId, userId]) => ({ businessId, userId: userId as string }));
}

/** app_metadata with this business's link set (userId) or removed (null) — every other key kept. Pure. */
export function withMetaLink(appMeta: unknown, businessId: string, userId: string | null): Record<string, unknown> {
  const base = (appMeta && typeof appMeta === 'object' && !Array.isArray(appMeta)) ? { ...(appMeta as Record<string, unknown>) } : {};
  const cur = base[PARTNER_META_KEY];
  const links: Record<string, unknown> = (cur && typeof cur === 'object' && !Array.isArray(cur)) ? { ...(cur as Record<string, unknown>) } : {};
  if (userId) links[businessId] = userId; else delete links[businessId];
  base[PARTNER_META_KEY] = links;
  return base;
}

/**
 * A partner's branches: those assigned (open ones only), or — none assigned — every open branch (lib/branchAccess.ts).
 * allBranches when they work at every open branch: the owner's picker, "All branches" included. Pure.
 */
export function partnerBranchAccess(userBranches: Array<{ branch_id?: string | null }> | null | undefined,
  openBranchIds: readonly string[]): { branchIds: string[]; allBranches: boolean } {
  const assigned = [...new Set((userBranches ?? []).map((b) => b?.branch_id).filter((x): x is string => !!x))];
  if (!assigned.length) return { branchIds: [...openBranchIds], allBranches: openBranchIds.length > 0 };
  const branchIds = openBranchIds.filter((b) => assigned.includes(b));
  return { branchIds, allBranches: openBranchIds.length > 0 && branchIds.length === openBranchIds.length };
}

/**
 * The branch a partner's request acts at: the one picked (X-Branch-Id) when it is theirs; else "every branch" (null) for
 * a partner of every branch, or the session's own branch for one of some. A header naming any other branch — another
 * business's, or one of theirs they lost — is never taken. Pure.
 */
export function partnerRequestBranch(claims: { branchIds: readonly string[]; allBranches: boolean; sessionBranch: string | null },
  asked: unknown): string | null {
  const a = typeof asked === 'string' ? asked.split(',')[0].trim() : '';
  if (a && claims.branchIds.includes(a)) return a;
  if (claims.allBranches) return null;
  return claims.sessionBranch && claims.branchIds.includes(claims.sessionBranch) ? claims.sessionBranch : (claims.branchIds[0] ?? null);
}

/** A582: what the dashboard sends as X-Branch-Id for "All my branches". */
export const MY_BRANCHES = 'mine';

/**
 * A582: "All my branches" — a partner of SOME branches (two or more, not every one) who asks for X-Branch-Id 'mine' reads
 * their branches combined: exactly their token's list, never null (the owner's "every branch"), never another branch.
 * Anyone else (a partner of every branch — whose "all" is already theirs —, of one branch, any other ask): null, today's
 * rules. Pure.
 *
 * Owner, 2026-10-23: "assume i have partner a and they fully own shop x,y and z they should never see general sales for
 * all stores only their store" … "yes i want all my branch feature".
 */
export function partnerBranchSet(claims: { branchIds: readonly string[]; allBranches: boolean }, asked: unknown): string[] | null {
  const a = typeof asked === 'string' ? asked.trim().toLowerCase() : '';
  if (a !== MY_BRANCHES || claims.allBranches) return null;
  const ids = [...new Set(claims.branchIds.filter((b) => typeof b === 'string' && UUIDISH.test(b)))];
  return ids.length >= 2 ? ids : null;
}

/** The business's grants. A read that fails is an error (never "nobody") — the caller decides how to fail. */
export async function readPartners(businessId: string): Promise<{ map: PartnerMap; error: unknown }> {
  const { data, error } = await supabase.from('business_settings').select('value')
    .eq('business_id', businessId).eq('key', PARTNER_SETTING_KEY).maybeSingle();
  if (error) return { map: {}, error };
  return { map: cleanPartnerMap((data as { value?: unknown } | null)?.value), error: null };
}

export async function writePartners(businessId: string, map: PartnerMap): Promise<unknown> {
  const { data: existing, error: rErr } = await supabase.from('business_settings').select('id')
    .eq('business_id', businessId).eq('key', PARTNER_SETTING_KEY).maybeSingle();
  if (rErr) return rErr;
  const now = new Date().toISOString();
  const { error } = existing
    ? await supabase.from('business_settings').update({ value: map, updated_at: now }).eq('id', (existing as { id: string }).id)
    : await supabase.from('business_settings').insert({ business_id: businessId, key: PARTNER_SETTING_KEY, value: map });
  return error ?? null;
}

export interface PartnerPerson {
  id: string; name: string | null; email: string | null; status: string; business_id: string;
  role_id: string | null; permissions_version: number | null;
  roles?: { id?: string; name?: string | null; role_permissions?: unknown[] } | null;
  user_permissions?: unknown[];
  user_branches?: Array<{ branch_id: string | null }>;
}

/**
 * Everything a partner sign-in or renewal checks, for one (business, person): the grant is live for this sign-in account
 * (or, `authUserId` null, live at all — a renewal, whose token the sign-in already tied to the account), the person is an
 * active users row of the business, not on the owner's role, and works at an open branch. Any "no" is one answer — the
 * caller says the same generic thing for each.
 */
export type PartnerCheck =
  | { ok: true; person: PartnerPerson; record: PartnerRecord; map: PartnerMap; branchIds: string[]; allBranches: boolean }
  | { ok: false; reason: 'NOT_PARTNER' | 'ACCOUNT_GONE' | 'ACCOUNT_INACTIVE' | 'OWNER_ROLE' | 'NO_BRANCH' }
  | { ok: false; reason: 'DB_ERROR' };

export async function checkPartner(businessId: string, userId: string, authUserId: string | null): Promise<PartnerCheck> {
  const { map, error } = await readPartners(businessId);
  if (error) return { ok: false, reason: 'DB_ERROR' };
  const record = map[userId];
  if (!record || !(authUserId ? partnerLive(record, authUserId) : partnerLive(record, record.auth_user_id))) return { ok: false, reason: 'NOT_PARTNER' };
  const { data, error: uErr } = await supabase.from('users')
    .select('id, name, email, status, business_id, role_id, permissions_version, roles ( id, name, role_permissions ( permissions ( key ) ) ), user_permissions ( granted, permissions ( key ) ), user_branches ( branch_id )')
    .eq('id', userId).eq('business_id', businessId).maybeSingle();
  if (uErr) return { ok: false, reason: 'DB_ERROR' };
  const person = data as PartnerPerson | null;
  if (!person || person.business_id !== businessId) return { ok: false, reason: 'ACCOUNT_GONE' };
  if (person.status !== 'active') return { ok: false, reason: 'ACCOUNT_INACTIVE' };
  if (isOwnerRoleName(person.roles?.name)) return { ok: false, reason: 'OWNER_ROLE' };
  const { data: open, error: bErr } = await supabase.from('branches').select('id')
    .eq('business_id', businessId).eq('status', 'active');
  if (bErr) return { ok: false, reason: 'DB_ERROR' };
  const access = partnerBranchAccess(person.user_branches, ((open ?? []) as Array<{ id: string }>).map((b) => b.id));
  if (!access.branchIds.length) return { ok: false, reason: 'NO_BRANCH' };
  return { ok: true, person, record, map, ...access };
}

/**
 * Which business a partner's password opens. Only the businesses the account's app_metadata names (narrowed to the
 * client's own address, or the business picked), each checked in full (checkPartner). One → that one; more than one and
 * nothing picked → the choice (the owner's MULTIPLE_BUSINESSES); none → nothing.
 */
export async function resolvePartnerSignIn(authUser: { id: string; app_metadata?: unknown },
  want: { businessId?: string | null }): Promise<
  | { kind: 'none' } | { kind: 'error' }
  | { kind: 'one'; businessId: string; check: Extract<PartnerCheck, { ok: true }> }
  | { kind: 'many'; businesses: Array<{ id: string; name?: string }> }> {
  let links = metaLinks(authUser.app_metadata);
  if (want.businessId) links = links.filter((l) => l.businessId === want.businessId);
  const hits: Array<{ businessId: string; check: Extract<PartnerCheck, { ok: true }> }> = [];
  for (const l of links.slice(0, 20)) {
    const c = await checkPartner(l.businessId, l.userId, authUser.id);
    if (c.ok === true) hits.push({ businessId: l.businessId, check: c });
    else if (c.reason === 'DB_ERROR') return { kind: 'error' };
  }
  if (!hits.length) return { kind: 'none' };
  if (hits.length === 1) return { kind: 'one', ...hits[0] };
  const { data } = await supabase.from('businesses').select('id, name').in('id', hits.map((h) => h.businessId));
  const names = new Map(((data ?? []) as Array<{ id: string; name?: string }>).map((b) => [b.id, b.name]));
  return { kind: 'many', businesses: hits.map((h) => ({ id: h.businessId, name: names.get(h.businessId) })) };
}

/** A password nobody knows, for a sign-in account made for an invite (the person sets theirs with "Forgot password?"). */
export function unusablePassword(): string {
  return crypto.randomBytes(32).toString('base64url');
}
