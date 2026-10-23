/**
 * creditApprovers.ts — A585: the owner sets every credit limit; the owner may choose who APPROVES sales on account.
 *
 * Owner, 2026-10-23: "credit limit — the owner for now; they can assign to branch manager for approval but they set the
 * limit".
 *
 *   LIMITS     giving, changing or removing a customer's credit limit is the OWNER's alone — signed in as themselves
 *              (the owner's password sign-in, or their own PIN), never someone holding the owner's role by PIN, never a
 *              partner (A550), never a till. Before A585 anyone holding customers.credit could (A567).
 *   APPROVERS  business_settings `credit_sale_approvers` = { on, branches: { <branch id>: [user ids] } }, written only by
 *              PUT /api/credit/approvers (the owner). OFF (the default, and when nothing is stored): A511 / A552 as they
 *              were — the seller holding customers.credit approves it, anyone else needs the PIN of someone at the
 *              branch holding customers.credit. ON: a sale on account at a branch is approved only by someone on THAT
 *              branch's list (or the owner) — the seller themselves when they are on it, else that person's PIN. The
 *              limit is enforced as before: no approver sells past what the owner allowed.
 *
 * The till holds the rule for its branch (GET /api/pos/credit-customers carries it; kept in maintenance_state) so it
 * works offline. Pure functions first — the tests run them as they are.
 */
import { supabase } from './supabase';
import { worksAtBranch } from './branchAccess';

export const CREDIT_APPROVERS_KEY = 'credit_sale_approvers';
/** At most this many approvers per branch (a list a person picks from, never a whole staff). */
export const MAX_APPROVERS_PER_BRANCH = 20;

export interface CreditApprovalRule { on: boolean; branches: Record<string, string[]> }
export const RULE_OFF: CreditApprovalRule = Object.freeze({ on: false, branches: Object.freeze({}) as Record<string, string[]> }) as CreditApprovalRule;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The stored value (an object, or its JSON) → a rule. Anything unreadable is OFF (today's behaviour). */
export function readRule(raw: unknown): CreditApprovalRule {
  let v: unknown = raw;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return { on: false, branches: {} }; } }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { on: false, branches: {} };
  const o = v as { on?: unknown; branches?: unknown };
  const branches: Record<string, string[]> = {};
  if (o.branches && typeof o.branches === 'object' && !Array.isArray(o.branches)) {
    for (const [b, ids] of Object.entries(o.branches as Record<string, unknown>)) {
      if (!UUID.test(b) || !Array.isArray(ids)) continue;
      const clean = [...new Set(ids.filter((x): x is string => typeof x === 'string' && UUID.test(x)))].slice(0, MAX_APPROVERS_PER_BRANCH);
      if (clean.length) branches[b] = clean;
    }
  }
  return { on: o.on === true, branches };
}

export interface StaffForRule { id: string; status?: string | null; user_branches?: Array<{ branch_id: string | null }> | null }

/**
 * What the owner sent → the rule to store, or why not. Only this business's branches; only active staff of this business
 * who work at that branch (lib/branchAccess.ts — no branch assigned = every branch). Turning it ON with nobody on any
 * list is allowed (only the owner then approves) but said so by the screen.
 */
export function cleanRule(body: unknown, ctx: { branchIds: readonly string[]; staff: readonly StaffForRule[] }):
  { ok: true; rule: CreditApprovalRule } | { ok: false; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'Send { on, branches }.' };
  const b = body as { on?: unknown; branches?: unknown };
  if (typeof b.on !== 'boolean') return { ok: false, error: 'Say whether approval is on (true) or off (false).' };
  const branches: Record<string, string[]> = {};
  const raw = b.branches ?? {};
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'branches must be { <branch id>: [staff ids] }.' };
  const known = new Set(ctx.branchIds);
  const people = new Map(ctx.staff.filter((s) => !s.status || s.status === 'active').map((s) => [s.id, s]));
  for (const [branchId, ids] of Object.entries(raw as Record<string, unknown>)) {
    if (!known.has(branchId)) return { ok: false, error: 'One of the branches is not this business\'s.' };
    if (!Array.isArray(ids)) return { ok: false, error: 'Each branch takes a list of staff.' };
    const list = [...new Set(ids.map(String))];
    if (list.length > MAX_APPROVERS_PER_BRANCH) return { ok: false, error: `At most ${MAX_APPROVERS_PER_BRANCH} approvers per branch.` };
    for (const id of list) {
      const p = people.get(id);
      if (!p) return { ok: false, error: 'One of the people chosen is not active staff of this business.' };
      if (!worksAtBranch(p.user_branches, branchId)) return { ok: false, error: 'One of the people chosen does not work at that branch.' };
    }
    if (list.length) branches[branchId] = list;
  }
  return { ok: true, rule: { on: b.on, branches } };
}

/** The people on a branch's list (not the owner — the owner always approves). */
export function approversAt(rule: CreditApprovalRule, branchId: string | null | undefined): string[] {
  if (!branchId) return [];
  return [...(rule.branches[branchId] ?? [])];
}

/**
 * ON: may this person approve a sale on account at this branch — the owner (their own row), or someone on that branch's
 * list who still works there. A sale with no branch: the owner only. OFF: never asked (the A511 rule applies).
 */
export function onApproverList(rule: CreditApprovalRule, branchId: string | null | undefined,
  person: { id: string; user_branches?: Array<{ branch_id: string | null }> | null } | null | undefined,
  owner: { ownerId?: string | null; isOwner?: boolean } = {}): boolean {
  if (!person?.id) return false;
  if (owner.isOwner === true || (!!owner.ownerId && person.id === owner.ownerId)) return true;
  if (!branchId) return false;
  if (!approversAt(rule, branchId).includes(person.id)) return false;
  return person.user_branches === undefined ? true : worksAtBranch(person.user_branches, branchId);
}

/** The business's rule. A failed read is OFF (today's rule: customers.credit approves) and is logged. */
export async function loadCreditRule(businessId: string | null | undefined): Promise<CreditApprovalRule> {
  if (!businessId) return { on: false, branches: {} };
  try {
    const { data, error } = await supabase.from('business_settings').select('value')
      .eq('business_id', businessId).eq('key', CREDIT_APPROVERS_KEY).maybeSingle();
    if (error) { console.warn(`[credit] A585: approver rule not read: ${error.message}`); return { on: false, branches: {} }; }
    return readRule((data as { value?: unknown } | null)?.value ?? null);
  } catch (e: any) {
    console.warn(`[credit] A585: approver rule not read: ${e?.message ?? e}`);
    return { on: false, branches: {} };
  }
}

// ── who sets a limit ───────────────────────────────────────────────────────────────────────────────────────────────
// A585, owner change 2026-10-23 ("add the credit rights to the manager"): the owner OR staff on the built-in Manager role.
export const OWNER_SETS_LIMITS = { error: 'Only the owner or a manager sets credit limits.', code: 'OWNER_SETS_LIMITS' } as const;
export const OWNER_CHOOSES_APPROVERS = { error: 'Only the owner chooses who approves credit sales.', code: 'OWNER_ONLY' } as const;

/** The session's shape alone: the owner's password sign-in (no PIN, no till surface, no role) — never a till or a partner. */
export function ownerPasswordShape(req: { isOwner?: unknown; isTill?: unknown; webPartner?: unknown; pinSignIn?: unknown; surface?: unknown; roleId?: unknown }): boolean {
  return req.isOwner === true && req.isTill !== true && req.webPartner !== true && req.pinSignIn !== true && !req.surface && !req.roleId;
}

/** The owner's Supabase session as requireAuth builds it: owner, web, no ZapTill session id, no PIN, not a till or partner. */
export function supabaseOwnerShape(req: { isOwner?: unknown; isTill?: unknown; webPartner?: unknown; pinSignIn?: unknown; surface?: unknown; sessionId?: unknown }): boolean {
  return req.isOwner === true && req.isTill !== true && req.webPartner !== true && req.pinSignIn !== true
    && req.surface === 'web' && (req.sessionId === null || req.sessionId === undefined);
}

/**
 * A585: is the person signed in THE OWNER — the owner's password sign-in, or a PIN sign-in by the very account the
 * business names as its owner (businesses.owner_id)? Someone else holding the owner's role ("Admin") by PIN, a partner,
 * a till: no.
 */
export async function isTheOwner(req: any): Promise<boolean> {
  if (req?.isTill === true || req?.webPartner === true || req?.isOwner !== true) return false;
  if (ownerPasswordShape(req)) return true;
  // The owner's Supabase session (middleware/auth.ts's last branch: found by businesses.owner_id = the auth user) — no
  // ZapTill session id, never a PIN sign-in. Its userId may be the owner's users row, not owner_id, so the shape decides.
  if (supabaseOwnerShape(req)) return true;
  if (!req.userId) return false;
  try {
    const { data } = await supabase.from('businesses').select('owner_id').eq('id', req.businessId).maybeSingle();
    return (data as { owner_id?: string | null } | null)?.owner_id === req.userId;
  } catch { return false; }
}

/** Express gate: the owner only (403 OWNER_SETS_LIMITS / the given body). */
export const ownerOnlyGate = (body: { error: string; code: string } = OWNER_SETS_LIMITS) => async (req: any, res: any, next: any) => {
  if (await isTheOwner(req)) { next(); return; }
  res.status(403).json({ ...body });
};

/**
 * A585 (owner change, 2026-10-23: "add the credit rights to the manager"): the BUILT-IN Manager role — the one ZapTill
 * made for the business (roles.is_default, lib/defaultRolePermissions.ts), still named Manager. A custom role merely
 * named "Manager" (is_default false) does not count; nor does General Manager, Finance Manager or Supervisor (owner's
 * default: Manager only). A built-in role renamed away from "Manager" stops counting.
 */
export function isBuiltInManagerRole(role: { name?: string | null; is_default?: boolean | null } | null | undefined): boolean {
  return !!role && role.is_default === true && String(role.name ?? '').trim().toLowerCase() === 'manager';
}

/** The person signed in is on the built-in Manager role (read from their users row, not the token) — never a till or a partner. */
export async function isBuiltInManager(req: any): Promise<boolean> {
  if (req?.isTill === true || req?.webPartner === true || !req?.userId || !req?.businessId) return false;
  try {
    const { data } = await supabase.from('users').select('id, status, role_id, roles ( name, is_default )')
      .eq('id', req.userId).eq('business_id', req.businessId).maybeSingle();
    const u = data as { status?: string | null; roles?: { name?: string | null; is_default?: boolean | null } | null } | null;
    if (!u || (u.status && u.status !== 'active')) return false;
    return isBuiltInManagerRole(u.roles ?? null);
  } catch { return false; }
}

/** May this person give, change or remove a customer's credit limit: the owner, or the built-in Manager role. */
export async function maySetCreditLimits(req: any): Promise<boolean> {
  return (await isTheOwner(req)) || (await isBuiltInManager(req));
}

/** Express gate for the limit routes (403 OWNER_SETS_LIMITS: "Only the owner or a manager sets credit limits."). */
export const limitSetterGate = () => async (req: any, res: any, next: any) => {
  if (await maySetCreditLimits(req)) { next(); return; }
  res.status(403).json({ ...OWNER_SETS_LIMITS });
};
