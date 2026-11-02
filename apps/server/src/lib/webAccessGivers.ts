/**
 * webAccessGivers.ts — A608 part 3 (owner, 2026-10-29, "yes to all"): who may give, resend and take away web dashboard
 * access (A550, routes/staff.ts /:id/web-access and POST /api/staff web_access), besides the owner.
 *
 *   the owner          — anyone (as before, A550): never the owner's role (giveWebAccess refuses it).
 *   a partner holding staff.edit (the right that adds and edits staff — routes/staff.ts POST /, PATCH /:id) — that is, a
 *                        partner, or a manager the owner gave web access to (on the dashboard every non-owner is a partner
 *                        session) — only for someone who:
 *     · is not themselves (OWN_WEB_ACCESS);
 *     · is not on the General Manager role — a General Manager with web access IS a partner, and a partner is made by the
 *       owner alone (A603: a manager never makes one, a partner never makes another) (PARTNER_OWNER_ONLY);
 *     · is not on the owner's role (OWNER_ROLE);
 *     · holds nothing beyond them — the same ceiling as giving a role or managing a person (lib/roleCeiling.ts)
 *       (BEYOND_YOU);
 *     · works only at branches of theirs — no branches at all means every branch, so only a giver of every branch
 *       (OTHER_BRANCH).
 * Never a till, a PIN sign-in on a till, a web POS session or a kitchen screen (not a dashboard session). Pure.
 */
import { isOwnerRoleName } from './ownerRole';
import { overridesBeyondCaller } from './roleCeiling';

export type GiverKind = 'owner' | 'staff';

/** Who is asking: the owner (their own sign-in, not a till or a PIN sign-in), a partner holding staff.edit, or nobody. */
export function webAccessGiverKind(req: { isOwner?: boolean; isTill?: boolean; pinSignIn?: boolean; webPartner?: boolean },
  canEditStaff: boolean): GiverKind | null {
  if (req.isTill || req.pinSignIn) return null;
  if (req.isOwner === true && req.webPartner !== true) return 'owner';
  return req.webPartner === true && canEditStaff ? 'staff' : null;
}

const norm = (n: unknown): string => String(n ?? '').trim().replace(/[\s_]+/g, ' ').toLowerCase();
/** The General Manager role — the role a partner is given (routes/staff.ts partnerRole): by name, case and spaces aside. */
export const isPartnerRoleName = (name: unknown): boolean => norm(name) === 'general manager';
export const PARTNER_OWNER_ONLY = { error: 'A General Manager with web dashboard access is a partner — only the owner gives or takes it away.', code: 'PARTNER_OWNER_ONLY' } as const;

export interface WebAccessTargetFacts { id: string; roleName: string | null; keys: ReadonlySet<string>; branchIds: readonly string[] }
export interface WebAccessGiverFacts { userId: string | null; held: ReadonlySet<string>; allBranches: boolean; branchIds: readonly string[] }

/** Why this (non-owner) giver may not give or take away this person's web access, or null. */
export function webAccessTargetRefusal(giver: WebAccessGiverFacts, t: WebAccessTargetFacts): { error: string; code: string } | null {
  if (giver.userId && giver.userId === t.id) return { error: 'You cannot change your own web dashboard access — ask the owner.', code: 'OWN_WEB_ACCESS' };
  if (isPartnerRoleName(t.roleName)) return { ...PARTNER_OWNER_ONLY };
  if (isOwnerRoleName(t.roleName) || t.keys.has('*')) return { error: 'The owner\'s role signs in as the owner.', code: 'OWNER_ROLE' };
  if (overridesBeyondCaller(giver.held, [...t.keys]).length) {
    return { error: 'This person holds permissions you do not — only the owner, or someone holding all of them, gives them web dashboard access.', code: 'BEYOND_YOU' };
  }
  if (!giver.allBranches) {
    const mine = new Set(giver.branchIds);
    if (!t.branchIds.length || t.branchIds.some((b) => !mine.has(b))) {
      return { error: 'This person works at a branch that is not yours — only the owner, or someone of every branch they work at, gives them web dashboard access.', code: 'OTHER_BRANCH' };
    }
  }
  return null;
}

/**
 * A608 part 3 (owner, 2026-10-29: making a Partner is the owner's alone): the indirect way — someone who already has web
 * dashboard access (invited or active) moved ONTO the General Manager role becomes a partner just as surely as a General
 * Manager given web access. Someone other than the owner never does it: not by a person's role (PATCH /api/staff/:id
 * role_id), not by renaming the role they hold to General Manager (PATCH /api/staff/roles/:roleId). Someone without web
 * access moved to General Manager follows the ordinary ceiling (roleAssignRefusal) — it makes no partner. Pure.
 */
export function makesPartnerRefusal(o: { owner: boolean; newRoleName: unknown; oldRoleName?: unknown; liveWebAccess: boolean }):
  typeof PARTNER_OWNER_ONLY | null {
  if (o.owner || !o.liveWebAccess) return null;
  if (!isPartnerRoleName(o.newRoleName) || isPartnerRoleName(o.oldRoleName)) return null;
  return PARTNER_OWNER_ONLY;
}
