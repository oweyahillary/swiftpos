import { Router } from 'express';
import { sendError } from '../lib/sendError';
import { safeRouter } from '../middleware/asyncHandler';
import { requireAuth } from '../middleware/auth';
import { verifyPin } from './auth';
import { requirePermission, allBranchAccess, branchFilter, oneBranchOnly } from '../middleware/rbac';   // A550: allBranchAccess
import { supabase } from '../lib/supabase';
import bcrypt from 'bcrypt';
import { validate } from '../middleware/validate';
import { CreateStaffSchema, UpdateStaffSchema } from '../lib/schemas';
import { callerHeld, canAssignRole, roleEditRefusal, overridesBeyondCaller } from '../lib/roleCeiling';
import { isOwnerRoleName } from '../lib/ownerRole';
import { PERMISSIONS, PERMISSION_GROUPS, expandKeys, isPermissionKey } from '@zaptill/core/permissions';
import { permissionIds, roleKeyMap, loadRole, personKeys, fineKeysOf } from '../lib/roleKeys';
import { useEmailCodes } from '../lib/loginOtp';   // A391
import { keysBeyond } from '@zaptill/core/permissions';   // A494
import { keysFromGrants } from '../lib/effectiveKeys';   // A494
import { revokePersonSessions } from '../lib/tillSessions';   // A494
import { worksAtBranch } from '../lib/branchAccess';   // A494
import { pinKey, pinLocked, notePinFailure, notePinSuccess, PIN_LOCKED_BODY } from '../lib/pinAttempts';   // A494
import { readPartners, writePartners, partnerLive, withMetaLink, unusablePassword, type PartnerMap } from '../lib/webPartners';   // A550
import { forgetUser } from '../lib/authCache';   // A550
import { sendEmailChecked } from '../lib/mailer';   // A550
import { signInAddress } from '../lib/tenant';   // A550
import { businessPosFeatures } from '../lib/posFeatureFlags';   // A562
import { approvalPinOn } from '@zaptill/core/posFeatures';   // A562

const router = safeRouter();
router.use(requireAuth);

// A494: a sign-in PIN is stored with bcrypt, as /auth/set-pin does — the unsalted sha256(pin:business) this used was
// 10,000 guesses away from every PIN of the business for anyone holding one hash (a till's roster, a backup).
const PIN_BCRYPT_ROUNDS = 12;
function hashPin(pin: string): Promise<string> {
  return bcrypt.hash(String(pin), PIN_BCRYPT_ROUNDS);
}

// Override PINs are auth secrets used to authorize privileged actions (e.g.
// voiding a paid order), so they get a proper salted bcrypt hash — kept separate
// from the login pin_hash so shoulder-surfing an override never leaks login.
const OVERRIDE_PIN_RE = /^\d{4,6}$/;
function hashOverridePin(pin: string): Promise<string> {
  return bcrypt.hash(String(pin), 10);
}

// A562 (owner, 2026-10-22: "we remove approval pin and add it as a feature we can turn on or off in the admin panel"):
// a NEW approval PIN is set only for a business whose admin-portal switch 'approval_pin' is on. Removing one ('') is
// always allowed. One already set keeps approving either way (lib/approver.ts reads no switch) — no manager's approval
// breaks the day the switch is off; the owner removes it on the staff form.
const APPROVAL_PIN_OFF_BODY = {
  error: 'Separate approval PINs are off for this business — managers approve with their sign-in PIN. ZapTill support can turn them on.',
  code: 'APPROVAL_PIN_OFF',
} as const;
async function approvalPinAllowed(req: any): Promise<boolean> {
  return approvalPinOn(await businessPosFeatures(req.businessId));
}

/** A562: the owner's role belongs to the owner alone — nobody is given it, the owner included (lib/roleCeiling.ts). */
const OWNER_ROLE_REFUSAL = 'The owner\'s role belongs to the owner alone — choose another role (for full rights, a role such as General Manager).';

// ── A490: the ceiling is by PERMISSION (lib/roleCeiling.ts) ──────────────────────────────────────────────────────────
// A340 matched role names (owner, admin, manager, supervisor, branch_manager). Now: the owner's role (lib/ownerRole.ts)
// is the owner's alone, and anyone else may assign a role, grant a permission or manage a person only when that holds
// nothing beyond their own keys.

/**
 * Why this caller may not give someone this role, or null. Fails CLOSED: a role that cannot be read, or one of another
 * business, is refused. No business_id filter on the read (roles may be seeded globally — a NULL business_id), but a
 * role of ANOTHER business is never assignable.
 */
async function roleAssignRefusal(req: any, roleId: string): Promise<string | null> {
  const held = callerHeld(req);
  const { data: role, error } = await supabase.from('roles').select('id, name, business_id').eq('id', roleId).maybeSingle();
  if (error || !role) return held.has('*') ? null : 'You are not allowed to assign this role';
  if ((role as any).business_id && (role as any).business_id !== req.businessId) return 'You are not allowed to assign this role';
  if (isOwnerRoleName((role as any).name)) return OWNER_ROLE_REFUSAL;   // A562: by nobody, the owner included
  let keys: Set<string>;
  try { keys = (await roleKeyMap([roleId])).get(roleId) ?? new Set(); } catch { return 'Could not check this role — please try again'; }
  return canAssignRole(held, { name: (role as any).name, keys }) ? null : 'You are not allowed to assign this role';
}

/** The keys a body GRANTS a person: `overrides` by permission id (granted: true) and `override_keys` by key. Unknown
 *  ids are reported (refused — fail closed). */
async function grantedKeysOf(body: any): Promise<{ keys: string[]; unknown: number }> {
  const keys: string[] = [];
  let unknown = 0;
  const overrides = Array.isArray(body?.overrides) ? body.overrides : [];
  const grantIds = overrides.filter((o: any) => o && o.granted === true && typeof o.permission_id === 'string').map((o: any) => o.permission_id);
  if (grantIds.length) {
    const { data: rows, error } = await supabase.from('permissions').select('id, key').in('id', grantIds);
    if (error) throw error;
    keys.push(...(rows ?? []).map((r: any) => r.key as string));
    unknown += grantIds.length - (rows ?? []).length;
  }
  const byKey = body?.override_keys && typeof body.override_keys === 'object' ? body.override_keys : {};
  for (const [k, v] of Object.entries(byKey)) if (v === true) keys.push(k);
  return { keys, unknown };
}

// A340: a non-owner may grant a staff member only permissions they hold themselves. Returns a refusal, or null.
// Only GRANTS are checked (taking a permission away is never an escalation).
async function refuseOverridesBeyondCaller(req: any): Promise<{ error: string; missing: string[] } | null> {
  const held = callerHeld(req);
  if (held.has('*')) return null;
  let granted: { keys: string[]; unknown: number };
  try { granted = await grantedKeysOf(req.body); } catch { return { error: 'Could not check the permissions being granted', missing: [] }; }
  const missing = overridesBeyondCaller(held, granted.keys);
  if (missing.length || granted.unknown > 0) return { error: 'You cannot grant permissions you do not hold', missing };
  return null;
}

/**
 * The user_permissions rows a body asks for — `overrides` (by id) and `override_keys` (by key; a broad key becomes the
 * fine keys it stands for; unknown keys are dropped) — or undefined when it names neither (leave them as they are).
 */
async function overrideRows(userId: string, body: any): Promise<Array<{ user_id: string; permission_id: string; granted: boolean }> | undefined> {
  const hasIds = Array.isArray(body?.overrides);
  const hasKeys = body?.override_keys && typeof body.override_keys === 'object';
  if (!hasIds && !hasKeys) return undefined;
  const byId = new Map<string, boolean>();
  if (hasIds) for (const o of body.overrides) if (o && typeof o.permission_id === 'string') byId.set(o.permission_id, o.granted === true);
  if (hasKeys) {
    const want = new Map<string, boolean>();
    for (const [k, v] of Object.entries(body.override_keys as Record<string, unknown>)) {
      if (typeof v !== 'boolean') continue;
      for (const f of expandKeys([k])) if (f !== '*' && isPermissionKey(f)) want.set(f, v);
    }
    const ids = await permissionIds(want.keys());
    for (const [k, v] of want) { const id = ids.get(k); if (id) byId.set(id, v); }
  }
  return [...byId].map(([permission_id, granted]) => ({ user_id: userId, permission_id, granted }));
}

// Blocks a non-owner from touching a proprietor account at all.
//
// Checked by joining the role off the user, the same shape the listing uses, so
// it does not depend on roles being business-scoped. Returns a reason string
// when the caller must be refused, or null when it may proceed.
async function refuseIfProprietor(targetUserId: string, businessId: string): Promise<string | null> {
  const { data: target, error } = await supabase
    .from('users')
    .select('id, roles ( name )')
    .eq('id', targetUserId)
    .eq('business_id', businessId)
    .maybeSingle();

  if (error) return 'Could not verify this staff member';
  if (!target) return null;   // handled as 404 by the caller

  if (isOwnerRoleName((target as any)?.roles?.name)) {   // A490: the one place a role name decides — lib/ownerRole.ts
    return 'The business owner account can only be changed by the owner';
  }
  return null;
}

/** A490: a non-owner manages only someone holding nothing beyond them (replaces "a manager may not touch a manager"). */
async function refuseIfBeyondCaller(req: any, targetUserId: string): Promise<string | null> {
  const held = callerHeld(req);
  if (held.has('*')) return null;
  let target: Awaited<ReturnType<typeof personKeys>>;
  try { target = await personKeys(req.businessId, targetUserId); } catch { return 'Could not verify this staff member'; }
  if (!target) return null;
  return overridesBeyondCaller(held, target.keys).length ? 'You are not allowed to manage this staff member' : null;
}

/**
 * A550: a partner names only branches they work at (their token's list — this business's, checked at sign-in). The owner
 * and everyone else are unaffected (their own rules above). Returns a refusal, or null.
 */
function partnerBranchRefusal(req: any, branchIds: unknown): string | null {
  if (!req.webPartner || branchIds === undefined || branchIds === null) return null;
  if (!Array.isArray(branchIds)) return 'You can only assign staff to your own branches';
  const mine: string[] = req.partnerBranches ?? [];
  return branchIds.every((b) => typeof b === 'string' && mine.includes(b)) ? null : 'You can only assign staff to your own branches';
}

/**
 * A550: end a person's web dashboard access (lib/webPartners.ts) — the owner's grant marked revoked, the sign-in account's
 * link removed, and every session of theirs ended now: refresh tokens revoked (lib/tillSessions.ts — never a till's own)
 * and permissions_version moved on, so an access token already out is refused at its next request (requireAuth), not
 * when it expires. Returns false when there was no live grant. A failure to unlink the account is logged: the grant alone
 * already refuses every sign-in and renewal.
 */
async function endPartnerAccess(businessId: string, userId: string, reason: string): Promise<boolean> {
  const { map, error } = await readPartners(businessId);
  if (error) throw error;
  const rec = map[userId];
  if (!rec || !partnerLive(rec, rec.auth_user_id)) return false;
  const next: PartnerMap = { ...map, [userId]: { ...rec, status: 'revoked', revoked_at: new Date().toISOString(), revoked_reason: reason } };
  const wErr = await writePartners(businessId, next);
  if (wErr) throw wErr;
  try {
    const { data: acct } = await supabase.auth.admin.getUserById(rec.auth_user_id);
    if (acct?.user) {
      const { error: uErr } = await supabase.auth.admin.updateUserById(rec.auth_user_id,
        { app_metadata: withMetaLink(acct.user.app_metadata, businessId, null) });
      if (uErr) console.warn('[staff] A550: could not unlink the sign-in account', { businessId, userId }, uErr.message);
    }
  } catch (e) { console.warn('[staff] A550: could not unlink the sign-in account', { businessId, userId }, (e as Error)?.message); }
  const { data: row } = await supabase.from('users').select('permissions_version').eq('id', userId).eq('business_id', businessId).maybeSingle();
  await supabase.from('users').update({ permissions_version: ((row as { permissions_version?: number } | null)?.permissions_version ?? 1) + 1 })
    .eq('id', userId).eq('business_id', businessId);
  forgetUser(userId);
  await revokePersonSessions(userId, businessId);
  console.log(`[staff] A550: web dashboard access ended (${reason})`, { businessId, userId });
  return true;
}

/**
 * A494: the keys a person WOULD hold after this change — the role they will have (the new one, else their current one)
 * and the overrides they will have (the ones sent replace all of theirs; else their current ones). A non-owner's change
 * must leave them within the caller's own keys: taking away a person's `granted: false` row for a key the caller lacks
 * gives them that key back, and the old check (only GRANTS) let it through.
 * `targetId` null = a new person. Returns the keys, or null when they cannot be worked out (refuse — fail closed).
 */
async function resultingKeys(req: any, targetId: string | null, roleId: string | null | undefined,
  rows: Array<{ permission_id: string; granted: boolean }> | undefined): Promise<Set<string> | null> {
  let currentRole: string | null = null;
  let currentOverrides: Array<{ granted?: boolean | null; permissions?: { key?: string | null } | null }> = [];
  if (targetId) {
    const { data, error } = await supabase.from('users')
      .select('id, role_id, user_permissions ( granted, permissions ( key ) )')
      .eq('id', targetId).eq('business_id', req.businessId).maybeSingle();
    if (error || !data) return null;
    currentRole = (data as any).role_id ?? null;
    currentOverrides = ((data as any).user_permissions ?? []) as typeof currentOverrides;
  }
  const rid = roleId || currentRole;
  let roleName: string | null = null;
  let grants: Array<{ permissions: { key: string } }> = [];
  if (rid) {
    const { data: role, error } = await supabase.from('roles').select('id, name').eq('id', rid).maybeSingle();
    if (error || !role) return null;
    roleName = (role as any).name ?? null;
    if (isOwnerRoleName(roleName)) return new Set(['*']);
    try { grants = [...((await roleKeyMap([rid])).get(rid) ?? [])].map((key) => ({ permissions: { key } })); } catch { return null; }
  }
  let overrides = currentOverrides;
  if (rows !== undefined) {
    const ids = rows.map((r) => r.permission_id);
    let keyOf = new Map<string, string>();
    if (ids.length) {
      const { data, error } = await supabase.from('permissions').select('id, key').in('id', ids);
      if (error) return null;
      keyOf = new Map(((data ?? []) as Array<{ id: string; key: string }>).map((p) => [p.id, p.key]));
    }
    overrides = rows.map((r) => ({ granted: r.granted, permissions: { key: keyOf.get(r.permission_id) ?? null } }));
  }
  return keysFromGrants(grants, overrides, false);
}

/** A494: the keys of someone already on the staff (role + overrides; the owner's role '*'), or null. */
async function currentKeys(req: any, targetId: string): Promise<Set<string> | null> {
  try { return (await personKeys(req.businessId, targetId))?.keys ?? null; } catch { return null; }
}

/**
 * A494: may approve something with a PIN — the keys an override (approval) PIN stands for. A514: with the business
 * supervisor PIN retired, a person's approval PIN is how an owner or a manager makes someone an approver — of voids
 * (sales.void), refunds (sales.refund), sales on account (customers.credit, A511) or drawers, cash out, expenses and
 * kitchen removals (shifts.confirm). What it approves is still decided per action (lib/approver.ts mayApprove,
 * lib/shiftConfirm.ts mayConfirm): the PIN never approves more than its holder's keys.
 */
export const APPROVAL_PIN_KEYS: readonly string[] = ['sales.void', 'sales.refund', 'customers.credit', 'shifts.confirm'];
const holdsApproval = (held: ReadonlySet<string>): boolean => held.has('*') || APPROVAL_PIN_KEYS.some((k) => held.has(k));

/** A494: why this caller may not SET an override PIN for someone who will hold `targetKeys`, or null. */
function overridePinRefusal(req: any, targetKeys: ReadonlySet<string>): { error: string; code: string } | null {
  if (!holdsApproval(callerHeld(req))) return { error: 'Only the owner, or someone who may approve (void, refund, credit or drawers), sets an approval PIN.', code: 'OVERRIDE_PIN_NOT_YOURS' };
  if (!holdsApproval(targetKeys)) return { error: 'An approval PIN is for someone who may approve voids, refunds, sales on account or drawers — give them that permission first.', code: 'OVERRIDE_PIN_NO_AUTHORITY' };
  return null;
}

// GET /api/staff — list staff for business
// Whether this user can authorise a void/override, as a boolean.
//
// Void authority is NOT decided by role name anywhere in this codebase — it is
// decided by having an override PIN set (see GET /authorizers, which selects on
// override_pin_hash). Naming a role "Supervisor" grants nothing on its own, so
// the staff list has to show the thing that actually matters. The hash itself is
// stripped before the response leaves.
// A490: each person's own overrides also come as `override_keys` — { fine key: granted } (a broad override row from
// before migration 134 shown as the fine keys it stands for).
function shapeStaff(rows: any[], selfId?: string | null): any[] {
  return (rows ?? []).map((u: any) => {
    const { override_pin_hash, pin_hash, ...rest } = u ?? {};
    const override_keys: Record<string, boolean> = {};
    for (const up of (u?.user_permissions ?? []) as Array<{ granted?: boolean; permissions?: { key?: string | null } | null }>) {
      const k = up?.permissions?.key;
      if (!k) continue;
      for (const f of expandKeys([k])) if (f !== '*') override_keys[f] = up.granted === true;
    }
    // A562: is_self — the row of whoever is asking (the owner's own account, for the owner): the staff form keeps its role,
    // and Deactivate is not offered (the cloud refuses SELF_DEACTIVATE).
    return { ...rest, can_authorize: !!override_pin_hash, override_keys, is_self: !!selfId && u?.id === selfId };
  });
}

// Owner: sees all staff. Non-owners: only staff assigned to their branch.
// A490: staff.view (everyone held it before migration 134 — OPEN_BEFORE_A490).
// A550: a partner of every branch sees everyone too — never the owner's own account (filtered below, as for any non-owner).
router.get('/', requirePermission('staff.view'), async (req, res) => {
  if (allBranchAccess(req)) {
    // Owner sees everyone
    const { data, error } = await supabase
      .from('users')
      .select(`
        id, name, email, phone, status, created_at, updated_at, override_pin_hash,
        roles ( id, name, description ),
        user_branches ( branch_id, branches ( id, name ) ),
        user_permissions ( permission_id, granted, permissions ( key ) )
      `)
      .eq('business_id', req.businessId)
      .order('name');

    if (error) { sendError(res, error); return; }
    res.json(shapeStaff(req.isOwner ? (data ?? []) : (data ?? []).filter((u: any) => !isOwnerRoleName(u?.roles?.name)), req.userId));
    return;
  }

  // A582: a partner's "All my branches" — the staff of their branches (each once), and of each person only the branches
  // in the set: never a name of another branch.
  const f = branchFilter(req);
  if (f.kind === 'set') {
    const { data, error } = await supabase
      .from('user_branches')
      .select(`
        branch_id,
        users (
          id, name, email, phone, status, created_at, updated_at, override_pin_hash,
          roles ( id, name, description ),
          user_branches ( branch_id, branches ( id, name ) ),
          user_permissions ( permission_id, granted, permissions ( key ) )
        )
      `)
      .in('branch_id', f.ids)
      .eq('users.business_id', req.businessId);
    if (error) { sendError(res, error); return; }
    const seen = new Map<string, any>();
    for (const row of (data ?? []) as any[]) {
      const u = row?.users;
      if (!u?.id || !f.ids.includes(row.branch_id) || seen.has(u.id)) continue;
      seen.set(u.id, { ...u, user_branches: (u.user_branches ?? []).filter((b: any) => f.ids.includes(b?.branch_id)) });
    }
    res.json(shapeStaff([...seen.values()].filter((u: any) => !isOwnerRoleName(u?.roles?.name)), req.userId));
    return;
  }

  // Non-owner: only staff that have an entry in user_branches for this branch
  const { data, error } = await supabase
    .from('user_branches')
    .select(`
      users (
        id, name, email, phone, status, created_at, updated_at, override_pin_hash,
        roles ( id, name, description ),
        user_branches ( branch_id, branches ( id, name ) ),
        user_permissions ( permission_id, granted, permissions ( key ) )
      )
    `)
    .eq('branch_id', req.branchId!)
    .eq('users.business_id', req.businessId);

  if (error) { sendError(res, error); return; }

  // Flatten the nested users out
  let staff = (data ?? []).map((row: any) => row.users).filter(Boolean);

  // Hide proprietor accounts from non-owners.
  //
  // An owner usually has a user_branches row for the branch they work out of,
  // so the branch filter alone let a branch manager see the owner in the staff
  // list — complete with a Deactivate button. Deactivating the proprietor stops
  // their PIN immediately, and on a single-branch pilot that is the account the
  // whole business is run from.
  //
  // Enforced here rather than hidden in the UI: the desktop sends the STAFF
  // token for these calls, so the server knows who is asking, and a client-side
  // filter would be undone by anyone talking to the API directly.
  staff = staff.filter((u: any) => !isOwnerRoleName(u?.roles?.name));

  res.json(shapeStaff(staff, req.userId));
});

// GET /api/staff/authorizers — list staff who can authorize overrides.
// Used by the POS void modal so a supervisor can be selected by name, then
// confirm with their override PIN. Returns only id/name/role — never the hash.
// Any authenticated user on this business may read it (names only).
router.get('/authorizers', async (req, res) => {
  if (oneBranchOnly(req, res)) return;   // A582: an approver is picked at one branch (a void, a refund — never in a set)
  const { data, error } = await supabase
    .from('users')
    .select('id, name, roles ( name )')
    .eq('business_id', req.businessId)
    .eq('status', 'active')
    .not('override_pin_hash', 'is', null)
    .order('name');

  if (error) { sendError(res, error); return; }
  res.json((data ?? []).map((u: any) => ({
    id:   u.id,
    name: u.name,
    role: u.roles?.name ?? null,
  })));
});

// POST /api/staff — create staff member with PIN
router.post('/', requirePermission('staff.edit'), validate(CreateStaffSchema), async (req, res) => {
  const { name, email, phone, role_id, pin, branch_ids } = req.body;

  if (!name || !role_id || !pin) {
    res.status(400).json({ error: 'name, role_id and pin are required' });
    return;
  }
  if (!/^\d{4,6}$/.test(pin)) {
    res.status(400).json({ error: 'PIN must be 4–6 digits' });
    return;
  }

  // Non-owners can only assign staff to their own branch. A494: exactly their branch — a non-owner with no branch adds
  // nobody (the person would have had no branch = every branch).
  // A550: a partner of every branch assigns any of their branches, as the owner does (partnerBranchRefusal).
  if (!allBranchAccess(req) && !req.branchId) {
    res.status(403).json({ error: 'You are not signed in at a branch — you can only add staff to your own branch.', code: 'NO_BRANCH' });
    return;
  }
  const effectiveBranchIds: string[] = allBranchAccess(req)
    ? (branch_ids ?? [])
    : [req.branchId!];

  if (!allBranchAccess(req) && branch_ids?.length && !(branch_ids.length === 1 && branch_ids[0] === req.branchId)) {
    res.status(403).json({ error: 'You can only assign staff to your own branch' });
    return;
  }
  const brRefusal = partnerBranchRefusal(req, branch_ids);
  if (brRefusal) { res.status(403).json({ error: brRefusal }); return; }

  // Server-side role guard: a non-owner gives only a role within their own keys (never the owner's).
  const roleRefusal = await roleAssignRefusal(req, role_id);
  if (roleRefusal) { res.status(403).json({ error: roleRefusal }); return; }
  const overRefusal = await refuseOverridesBeyondCaller(req);   // A340
  if (overRefusal) { res.status(403).json(overRefusal); return; }

  // A494: what the new person will hold (role + overrides) — within the caller's keys, and the base of the override-PIN rule.
  let plannedRows: Array<{ permission_id: string; granted: boolean }> | undefined;
  try { plannedRows = await overrideRows('new', req.body); } catch { res.status(503).json({ error: 'Could not check the permissions being granted' }); return; }
  const willHold = (await resultingKeys(req, null, role_id, plannedRows)) ?? (req.isOwner ? new Set<string>() : null);
  if (!willHold) { res.status(403).json({ error: 'Could not check this role — please try again' }); return; }
  if (!req.isOwner) {
    const missing = keysBeyond(callerHeld(req), willHold);
    if (missing.length) { res.status(403).json({ error: 'You cannot give someone permissions you do not hold', missing }); return; }
  }

  const pin_hash = await hashPin(pin);

  // Optional per-user override PIN (manager authority for voids/overrides).
  const overridePin = req.body.override_pin;
  let override_pin_hash: string | null | undefined;
  if (typeof overridePin === 'string' && overridePin.length > 0) {
    if (!(await approvalPinAllowed(req))) { res.status(403).json(APPROVAL_PIN_OFF_BODY); return; }   // A562
    if (!OVERRIDE_PIN_RE.test(overridePin)) {
      res.status(400).json({ error: 'Override PIN must be 4–6 digits' });
      return;
    }
    // A494: an override PIN approves voids and refunds — set only by someone who may, for someone who may.
    const refusal = overridePinRefusal(req, willHold);
    if (refusal) { res.status(403).json(refusal); return; }
    override_pin_hash = await hashOverridePin(overridePin);
  }

  const { data: user, error } = await supabase
    .from('users')
    .insert({
      business_id: req.businessId, name, email: email || null, phone: phone || null,
      role_id, pin_hash, status: 'active',
      ...(override_pin_hash !== undefined ? { override_pin_hash } : {}),
    })
    .select()
    .single();

  if (error) { sendError(res, error); return; }

  if (effectiveBranchIds.length) {
    await supabase.from('user_branches').insert(
      effectiveBranchIds.map((bid: string) => ({ user_id: user.id, branch_id: bid }))
    );
  }

  const rows = await overrideRows(user.id, req.body);
  if (rows?.length) await supabase.from('user_permissions').insert(rows);

  res.status(201).json(user);
});

// POST /api/staff/invite — invite staff by email
router.post('/invite', requirePermission('staff.edit'), async (req, res) => {
  const { name, email, role_id, branch_ids } = req.body;

  if (!name || !email || !role_id) {
    res.status(400).json({ error: 'name, email and role_id are required' });
    return;
  }

  // A340: the invite path had NO role or branch guard — a manager could invite anyone as the owner, the one gap in
  // an otherwise guarded set (POST /, PATCH, DELETE). Same rules as POST /.
  // A562: and the owner never invites someone onto the owner's role either.
  if (req.isOwner) {
    const roleRefusal = await roleAssignRefusal(req, role_id);
    if (roleRefusal) { res.status(403).json({ error: roleRefusal }); return; }
  }
  if (!req.isOwner) {
    // A494: a non-owner with no branch invites nobody (the person would have had every branch). A550: a partner of every
    // branch invites to any of their branches, as the owner does.
    if (!allBranchAccess(req) && !req.branchId) {
      res.status(403).json({ error: 'You are not signed in at a branch — you can only invite staff to your own branch.', code: 'NO_BRANCH' });
      return;
    }
    const roleRefusal = await roleAssignRefusal(req, role_id);
    if (roleRefusal) { res.status(403).json({ error: roleRefusal }); return; }
    if (!allBranchAccess(req) && branch_ids?.length && !(branch_ids.length === 1 && branch_ids[0] === req.branchId)) {
      res.status(403).json({ error: 'You can only assign staff to your own branch' });
      return;
    }
    const brRefusal = partnerBranchRefusal(req, branch_ids);
    if (brRefusal) { res.status(403).json({ error: brRefusal }); return; }
    const overRefusal = await refuseOverridesBeyondCaller(req);   // A494: the invite stores no overrides, but never accepts a grant beyond
    if (overRefusal) { res.status(403).json(overRefusal); return; }
  }
  const inviteBranchIds: string[] = allBranchAccess(req) ? (branch_ids ?? []) : (req.branchId ? [req.branchId] : []);

  const { data: user, error: uErr } = await supabase
    .from('users')
    .insert({ business_id: req.businessId, name, email, role_id, status: 'inactive' })
    .select()
    .single();

  if (uErr) { sendError(res, uErr); return; }

  if (inviteBranchIds.length) {
    await supabase.from('user_branches').insert(
      inviteBranchIds.map((bid: string) => ({ user_id: user.id, branch_id: bid }))
    );
  }

  const { error: invErr } = await supabase.auth.admin.inviteUserByEmail(email, {
    data: { business_id: req.businessId, user_id: user.id },
  });

  if (invErr) {
    console.error('Invite email failed:', invErr.message);
    res.status(207).json({ user, warning: 'Staff created, but the invitation email could not be sent' });
    return;
  }

  res.status(201).json(user);
});

// PATCH /api/staff/:id — update staff member
router.patch('/:id', requirePermission('staff.edit'), validate(UpdateStaffSchema), async (req, res) => {
  const { name, email, role_id, pin, status, branch_ids, hourly_rate } = req.body;

  const { data: existing } = await supabase
    .from('users').select('id, role_id, status, email').eq('id', req.params.id).eq('business_id', req.businessId).single();
  if (!existing) { res.status(404).json({ error: 'Staff member not found' }); return; }

  const overridePin = req.body.override_pin;
  const changesAccess = role_id !== undefined || branch_ids !== undefined
    || Array.isArray(req.body?.overrides) || (req.body?.override_keys && typeof req.body.override_keys === 'object');

  // Non-owners: never touch a proprietor account, whatever branch it sits in.
  // This is the guard that matters — hiding the row in the list is presentation,
  // the endpoint is the boundary.
  if (!req.isOwner) {
    const refusal = await refuseIfProprietor(req.params.id, req.businessId);
    if (refusal) { res.status(403).json({ error: refusal }); return; }
  }

  // A562: nobody deactivates themselves (the owner's own row stopped their PIN on every till); the owner's own role stays
  // the owner's; the owner's own e-mail is their sign-in — changed here, their next sign-in found no row of theirs and
  // made a second one on the owner's role (auth.ts ensureOwnerUserRow) — ZapTill support changes it (admin portal).
  const isSelf = !!req.userId && req.params.id === req.userId;
  if (isSelf && status && status !== 'active') {
    res.status(400).json({ error: 'You cannot deactivate yourself.', code: 'SELF_DEACTIVATE' });
    return;
  }
  if (req.isOwner && role_id && role_id !== (existing as any).role_id) {
    if (isSelf) { res.status(403).json({ error: 'The owner\'s own role cannot be changed.', code: 'OWN_ROLE' }); return; }
    const roleRefusal = await roleAssignRefusal(req, role_id);
    if (roleRefusal) { res.status(403).json({ error: roleRefusal }); return; }
  }
  if (req.isOwner && req.webPartner !== true && isSelf && email !== undefined
    && String(email || '').trim().toLowerCase() !== String((existing as any).email ?? '').trim().toLowerCase()) {
    res.status(400).json({ error: 'Your e-mail is how you sign in — ZapTill support changes it for you.', code: 'OWNER_SIGNIN_EMAIL' });
    return;
  }

  // A494: nobody but the owner changes their OWN role, permissions or branches — a manager could otherwise lift
  // themselves out of every limit the owner set (taking away their own "not allowed" rows, a bigger role, every branch).
  if (!req.isOwner && req.params.id === req.userId && changesAccess) {
    res.status(403).json({ error: 'You cannot change your own role, permissions or branches — ask the owner.', code: 'OWN_ACCESS' });
    return;
  }

  // Non-owners: verify target staff belongs to their branch
  if (!req.isOwner) {
    // A550: a partner of every branch manages staff of any branch (as the owner does) and assigns only their branches.
    if (!allBranchAccess(req)) {
    if (!req.branchId) { res.status(403).json({ error: 'You can only manage staff in your own branch', code: 'NO_BRANCH' }); return; }
    const { data: branchCheck } = await supabase
      .from('user_branches')
      .select('user_id')
      .eq('user_id', req.params.id)
      .eq('branch_id', req.branchId!)
      .single();
    if (!branchCheck) {
      res.status(403).json({ error: 'You can only manage staff in your own branch' });
      return;
    }
    // Non-owners cannot assign staff to branches outside their own. A494: exactly [their branch] — [] meant "no branch"
    // = every branch of the business.
    if (branch_ids !== undefined && !(Array.isArray(branch_ids) && branch_ids.length === 1 && branch_ids[0] === req.branchId)) {
      res.status(403).json({ error: 'You can only assign staff to your own branch' });
      return;
    }
    }
    const brRefusal = partnerBranchRefusal(req, branch_ids);
    if (brRefusal) { res.status(403).json({ error: brRefusal }); return; }

    // Server-side role guard (client-side excludeRoles is not sufficient):
    //  - cannot give a role holding more than the caller, and
    //  - cannot modify someone who ALREADY holds more than the caller (A490: by keys, not role names).
    if (role_id) {
      const roleRefusal = await roleAssignRefusal(req, role_id);
      if (roleRefusal) { res.status(403).json({ error: roleRefusal }); return; }
    }
    const beyond = await refuseIfBeyondCaller(req, req.params.id);
    if (beyond) { res.status(403).json({ error: beyond }); return; }
    const overRefusal = await refuseOverridesBeyondCaller(req);   // A340
    if (overRefusal) { res.status(403).json(overRefusal); return; }

    // A494: a peer — someone holding exactly what the caller holds — keeps their own credentials: another non-owner
    // setting their PIN, e-mail or override PIN could then sign in as them.
    if (req.params.id !== req.userId && (pin || email !== undefined || typeof overridePin === 'string')) {
      const theirs = await currentKeys(req, req.params.id);
      if (!theirs) { res.status(403).json({ error: 'Could not verify this staff member' }); return; }
      if (keysBeyond(theirs, callerHeld(req)).length === 0) {
        res.status(403).json({ error: 'Only the owner changes the PIN or e-mail of someone with the same permissions as you.', code: 'PEER_CREDENTIALS' });
        return;
      }
    }
  }

  // (Their token renews on its own: the database bumps permissions_version on any override or role change, migration 13.)
  const rows = await overrideRows(req.params.id, req.body);

  // A494: what they WILL hold — the new role and the new overrides together (removed deny rows included) — must stay
  // within a non-owner caller's keys; and it decides whether an override PIN may be set.
  const willHold = (await resultingKeys(req, req.params.id, role_id, rows)) ?? (req.isOwner ? new Set<string>() : null);
  if (!willHold) { res.status(403).json({ error: 'Could not check this staff member\'s permissions — please try again' }); return; }
  if (!req.isOwner) {
    const missing = keysBeyond(callerHeld(req), willHold);
    if (missing.length) { res.status(403).json({ error: 'You cannot give someone permissions you do not hold', missing }); return; }
  }

  const updates: any = { updated_at: new Date().toISOString() };
  if (name)               updates.name   = name;
  if (email !== undefined) updates.email = email || null;
  if (role_id)            updates.role_id = role_id;
  if (status)             updates.status       = status;
  if (hourly_rate !== undefined) updates.hourly_rate = hourly_rate !== null ? Number(hourly_rate) : null;
  if (pin) {
    if (!/^\d{4,6}$/.test(pin)) { res.status(400).json({ error: 'PIN must be 4–6 digits' }); return; }
    updates.pin_hash = await hashPin(pin);   // A494: bcrypt
  }

  // Override PIN: a 4–6 digit value sets/replaces it, '' clears it (revokes
  // override authority), and omitting the field leaves it unchanged.
  if (typeof overridePin === 'string') {
    if (overridePin.length === 0) {
      updates.override_pin_hash = null;
    } else if (OVERRIDE_PIN_RE.test(overridePin)) {
      if (!(await approvalPinAllowed(req))) { res.status(403).json(APPROVAL_PIN_OFF_BODY); return; }   // A562
      const refusal = overridePinRefusal(req, willHold);   // A494
      if (refusal) { res.status(403).json(refusal); return; }
      updates.override_pin_hash = await hashOverridePin(overridePin);
    } else {
      res.status(400).json({ error: 'Override PIN must be 4–6 digits' });
      return;
    }
  }

  const { data, error } = await supabase
    .from('users').update(updates).eq('id', req.params.id).select().single();
  if (error) { sendError(res, error); return; }

  let branchesChanged = false;
  if (branch_ids !== undefined) {
    const { data: before } = await supabase.from('user_branches').select('branch_id').eq('user_id', req.params.id);
    const was = new Set(((before ?? []) as Array<{ branch_id: string | null }>).map((b) => b.branch_id).filter(Boolean));
    const now = new Set((branch_ids as string[]).filter(Boolean));
    branchesChanged = was.size !== now.size || [...now].some((b) => !was.has(b));
    await supabase.from('user_branches').delete().eq('user_id', req.params.id);
    if (branch_ids.length) {
      await supabase.from('user_branches').insert(
        branch_ids.map((bid: string) => ({ user_id: req.params.id, branch_id: bid }))
      );
    }
  }

  // Update per-user permission overrides — `overrides` [{ permission_id, granted }] and/or `override_keys` { key: granted }
  if (rows !== undefined) {
    await supabase.from('user_permissions').delete().eq('user_id', req.params.id);
    if (rows.length) await supabase.from('user_permissions').insert(rows);
  }

  // A494: deactivated, another role or other branches — every session of theirs ends now (lib/tillSessions.ts).
  const roleChanged = !!role_id && role_id !== (existing as any).role_id;
  const deactivated = !!status && status !== 'active';
  if (roleChanged || deactivated || branchesChanged) await revokePersonSessions(req.params.id, req.businessId);

  // A550: a new e-mail ends web dashboard access — the sign-in account the owner's grant names is the old address's.
  // The owner gives access again (and the invite goes to the new address).
  const emailChanged = email !== undefined && String(email || '').trim().toLowerCase() !== String((existing as any).email ?? '').trim().toLowerCase();
  if (emailChanged) {
    try { await endPartnerAccess(req.businessId, req.params.id, 'email_changed'); }
    catch (e) { console.error('[staff] A550: could not end web access after an email change', req.params.id, (e as Error)?.message); }
  }

  res.json(data);
});

// DELETE /api/staff/:id — soft deactivate
// A391: a manager lost the phone with their authenticator app → back to emailed sign-in codes. The owner only.
router.post('/:id/reset-otp', requirePermission('staff.edit'), async (req, res) => {
  if (!req.isOwner) { res.status(403).json({ error: 'Only the owner can reset a sign-in code.' }); return; }
  const { data: target } = await supabase
    .from('users').select('id').eq('id', req.params.id).eq('business_id', req.businessId).maybeSingle();
  if (!target) { res.status(404).json({ error: 'Staff member not found' }); return; }
  if (await useEmailCodes('user', req.params.id)) { res.status(500).json({ error: 'Could not reset — please try again.' }); return; }
  res.json({ method: 'email' });
});

router.delete('/:id', requirePermission('staff.edit'), async (req, res) => {
  // A562: nobody deactivates themselves — the owner's own row included (their PIN stopped on every till).
  if (req.userId && req.params.id === req.userId) {
    res.status(400).json({ error: 'You cannot deactivate yourself.', code: 'SELF_DEACTIVATE' });
    return;
  }
  // Non-owners: verify target is in their branch
  if (!req.isOwner) {
    // Same refusal as PATCH. This route had NO elevated-role check whatsoever —
    // only the branch check below — while doing exactly what PATCH does: set
    // status to inactive. Guarding one and not the other left the front door
    // locked and the back door open.
    const refusal = await refuseIfProprietor(req.params.id, req.businessId);
    if (refusal) { res.status(403).json({ error: refusal }); return; }

    // And a manager must not be able to deactivate someone holding more than they do — the same rule PATCH applies.
    const beyond = await refuseIfBeyondCaller(req, req.params.id);
    if (beyond) { res.status(403).json({ error: beyond }); return; }

    // A550: a partner of every branch deactivates staff of any branch, as the owner does (the ceiling above still applies).
    const { data: branchCheck } = allBranchAccess(req) ? { data: { user_id: req.params.id } } : await supabase
      .from('user_branches')
      .select('user_id')
      .eq('user_id', req.params.id)
      .eq('branch_id', req.branchId!)
      .single();
    if (!branchCheck) {
      res.status(403).json({ error: 'You can only manage staff in your own branch' });
      return;
    }
  }

  const { error } = await supabase
    .from('users')
    .update({ status: 'inactive', updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .eq('business_id', req.businessId);

  if (error) { sendError(res, error); return; }
  await revokePersonSessions(req.params.id, req.businessId);   // A494: no session outlives the deactivation
  res.json({ success: true });
});

// ── A550: web dashboard access (partner login, lib/webPartners.ts) — the OWNER's alone ──────────────────────────────
// Owner, 2026-10-21: "I want to create a user, full rights like an owner but not the owner, they should be able to log
// in using the URL and a password." The owner marks someone on the staff; they sign in at the owner's own address with
// their e-mail and a password they set, and see what their role allows. Never by anyone but the owner — not a partner,
// not a manager holding staff.edit (a partner giving access would be a non-owner minting password sign-ins).

/** The owner, signed in as themselves (not a till, not a PIN sign-in on one, never a partner — who is never isOwner). */
const ownerOnly = (req: any): boolean => req.isOwner === true && !req.isTill && !req.pinSignIn && req.webPartner !== true;
const OWNER_ONLY_ACCESS = { error: 'Only the owner gives or takes away web dashboard access.', code: 'OWNER_ONLY' } as const;

// GET /api/staff/web-access — each person's web dashboard access: invited (not signed in yet), active, revoked.
router.get('/web-access', async (req, res) => {
  if (!ownerOnly(req)) { res.status(403).json(OWNER_ONLY_ACCESS); return; }
  const { map, error } = await readPartners(req.businessId);
  if (error) { sendError(res, error as Error); return; }
  const out: Record<string, { status: string; granted_at: string; activated_at: string | null; revoked_at: string | null }> = {};
  for (const [id, r] of Object.entries(map)) {
    out[id] = { status: r.status, granted_at: r.granted_at, activated_at: r.activated_at ?? null, revoked_at: r.revoked_at ?? null };
  }
  res.json(out);
});

/** The sign-in account for an invite: a new one (a password nobody knows — they set theirs with "Forgot password?"), or the
 *  one that address already has (an owner elsewhere, an earlier invite), found without sending anything. */
async function partnerSignInAccount(email: string): Promise<{ id: string; app_metadata: unknown } | null> {
  const { data, error } = await supabase.auth.admin.createUser({ email, email_confirm: true, password: unusablePassword() });
  if (!error && data?.user) return { id: data.user.id, app_metadata: data.user.app_metadata };
  const { data: link, error: lErr } = await supabase.auth.admin.generateLink({ type: 'magiclink', email });
  if (!lErr && link?.user) return { id: link.user.id, app_metadata: link.user.app_metadata };
  console.error('[staff] A550: no sign-in account for the invite', error?.message, lErr?.message);
  return null;
}

function escapeHtml(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

/** The invite: where to sign in and how to set a password (the A402 emailed code — no link that could be forwarded). */
async function sendPartnerInvite(to: string, name: string | null, businessName: string, address: string): Promise<boolean> {
  // The email goes in the fragment (#), never the query: a fragment is not sent to servers, so it stays out of web logs.
  const setUp = `${address}/login#set_password=1&email=${encodeURIComponent(to)}`;
  const sent = await sendEmailChecked({
    to,
    subject: `You can now sign in to ${businessName} on ZapTill`,
    html: `<div style="font-family:system-ui,sans-serif;font-size:15px;color:#0f172a">
  <p>${name ? `Hi ${escapeHtml(name)},` : 'Hi,'}</p>
  <p>The owner of <b>${escapeHtml(businessName)}</b> has given you access to its ZapTill dashboard.</p>
  <p>1. Open <a href="${escapeHtml(setUp)}">${escapeHtml(address)}</a> and choose <b>Forgot password?</b><br>
     2. Enter this email address — a 6-digit code is emailed to you.<br>
     3. Enter the code and choose your password, then sign in with this email and that password.</p>
  <p>Each time you sign in you also enter a one-time code (emailed to you, or from an authenticator app).</p>
  <p>If you were not expecting this, ignore this email.</p>
</div>`,
  });
  if (!sent.ok) console.error('[staff] A550: the invite email was not sent', sent.error);
  return sent.ok;
}

// POST /api/staff/:id/web-access — give web dashboard access (or send the invite again). The person must be an active
// member of the staff with an e-mail address, and never on the owner's role.
router.post('/:id/web-access', async (req, res) => {
  if (!ownerOnly(req)) { res.status(403).json(OWNER_ONLY_ACCESS); return; }
  const { data: target, error: tErr } = await supabase.from('users')
    .select('id, name, email, status, business_id, roles ( name )').eq('id', req.params.id).eq('business_id', req.businessId).maybeSingle();
  if (tErr) { sendError(res, tErr); return; }
  if (!target) { res.status(404).json({ error: 'Staff member not found' }); return; }
  const t = target as { id: string; name: string | null; email: string | null; status: string; roles?: { name?: string | null } | null };
  if (isOwnerRoleName(t.roles?.name)) {
    res.status(400).json({ error: 'The owner\'s role signs in as the owner. Give them another role (for example General Manager) first.', code: 'OWNER_ROLE' });
    return;
  }
  if (t.status !== 'active') { res.status(400).json({ error: 'Activate this staff member first.', code: 'INACTIVE' }); return; }
  const email = String(t.email ?? '').trim().toLowerCase();
  if (!email.includes('@')) { res.status(400).json({ error: 'Add an email address for this staff member first.', code: 'NO_EMAIL' }); return; }

  const { data: biz, error: bErr } = await supabase.from('businesses').select('id, name, owner_id, subdomain').eq('id', req.businessId).maybeSingle();
  if (bErr || !biz) { sendError(res, bErr ?? new Error('business not found')); return; }
  const acct = await partnerSignInAccount(email);
  if (!acct) { res.status(502).json({ error: 'Could not set up a sign-in for this email. Try again in a minute.' }); return; }
  if (acct.id === (biz as { owner_id?: string | null }).owner_id) {
    res.status(400).json({ error: 'That email is the owner\'s own sign-in.', code: 'OWNER_ACCOUNT' });
    return;
  }

  const { map, error: rErr } = await readPartners(req.businessId);
  if (rErr) { sendError(res, rErr as Error); return; }
  const prior = map[t.id];
  const keepActive = !!prior && partnerLive(prior, acct.id) && prior.status === 'active';
  const { error: mErr } = await supabase.auth.admin.updateUserById(acct.id, { app_metadata: withMetaLink(acct.app_metadata, req.businessId, t.id) });
  if (mErr) { res.status(502).json({ error: 'Could not link the sign-in. Try again in a minute.' }); return; }
  const now = new Date().toISOString();
  const wErr = await writePartners(req.businessId, { ...map, [t.id]: {
    auth_user_id: acct.id, status: keepActive ? 'active' : 'invited',
    granted_at: prior && partnerLive(prior, acct.id) ? prior.granted_at : now, granted_by: req.userId ?? null,
    activated_at: keepActive ? (prior?.activated_at ?? null) : null, revoked_at: null, revoked_reason: null,
  } });
  if (wErr) { sendError(res, wErr as Error); return; }

  const address = signInAddress((biz as { subdomain?: string | null }).subdomain) ?? (process.env.DASHBOARD_URL ?? 'https://app.zaptill.co.ke');
  const emailed = await sendPartnerInvite(email, t.name, (biz as { name?: string }).name ?? 'your business', address);
  console.log(`[staff] A550: web dashboard access given${prior ? ' (again)' : ''}`, { businessId: req.businessId, userId: t.id });
  res.status(emailed ? 200 : 207).json({ status: keepActive ? 'active' : 'invited', emailed,
    ...(emailed ? {} : { warning: 'Access was given, but the invitation email could not be sent — use "Resend invite".' }) });
});

// DELETE /api/staff/:id/web-access — take web dashboard access away: they are signed out everywhere at once.
router.delete('/:id/web-access', async (req, res) => {
  if (!ownerOnly(req)) { res.status(403).json(OWNER_ONLY_ACCESS); return; }
  try {
    const ended = await endPartnerAccess(req.businessId, req.params.id, 'revoked_by_owner');
    if (!ended) { res.status(404).json({ error: 'This staff member has no web dashboard access.' }); return; }
    res.json({ status: 'revoked' });
  } catch (e) { sendError(res, e as Error); }
});

// NOTE: POST /api/staff/verify-pin has been moved to POST /api/auth/verify-pin
// It now issues a branch-scoped JWT. Update any frontend calls accordingly.

// ── Roles and permissions (A490: docs/PERMISSIONS-A490.md "Roles") ───────────────────────────────────────────────────

/** Replace a role's grants with these FINE keys (registered first when a key has no row yet). */
async function writeRoleKeys(roleId: string, keys: string[]): Promise<void> {
  const ids = await permissionIds(keys);
  const { error: dErr } = await supabase.from('role_permissions').delete().eq('role_id', roleId);
  if (dErr) throw dErr;
  const rows = keys.map((k) => ids.get(k)).filter((id): id is string => !!id).map((permission_id) => ({ role_id: roleId, permission_id }));
  if (rows.length) {
    const { error } = await supabase.from('role_permissions').insert(rows);
    if (error) throw error;
  }
}

// GET /api/staff/roles — every role of the business: its fine keys, whether it is the owner's, whether THIS caller may
// give it (assignable) and change it (editable), and how many people hold it (members).
router.get('/roles', async (req, res) => {
  const { data, error } = await supabase
    .from('roles')
    .select(`
      id, name, description, is_default,
      role_permissions (
        permission_id,
        permissions ( id, key, label, module )
      )
    `)
    .eq('business_id', req.businessId)
    .order('name');

  if (error) { sendError(res, error); return; }
  const roles = (data ?? []) as any[];
  const { data: members } = await supabase.from('users').select('id, role_id').eq('business_id', req.businessId).eq('status', 'active');
  const count = new Map<string, number>();
  for (const u of (members ?? []) as Array<{ role_id: string | null }>) if (u.role_id) count.set(u.role_id, (count.get(u.role_id) ?? 0) + 1);
  const held = callerHeld(req);
  // A340: which of these THIS caller may hand out — the dashboard's and the till's role pickers show only these, so a
  // manager is never offered Owner (the routes refuse it regardless).
  res.json(roles.map((r) => {
    const isOwnerRole = isOwnerRoleName(r.name);
    const keys = isOwnerRole ? ['*'] : [...expandKeys((r.role_permissions ?? []).map((rp: any) => rp?.permissions?.key).filter(Boolean))].filter((k) => k !== '*');
    const role = { name: r.name, keys };
    return {
      ...r, keys, is_owner_role: isOwnerRole,
      assignable: canAssignRole(held, role),
      editable: (held.has('*') || held.has('staff.roles')) && roleEditRefusal(held, role) === null,
      members: count.get(r.id) ?? 0,
    };
  }));
});

// GET /api/staff/permissions — the catalogue: fine keys only, in catalogue order, with the words the owner reads.
router.get('/permissions', async (req, res) => {
  let ids: Map<string, string>;
  try { ids = await permissionIds(PERMISSIONS.map((p) => p.key)); } catch (e) { sendError(res, e as Error); return; }
  res.json(PERMISSIONS.map((p) => ({
    id: ids.get(p.key) ?? null, key: p.key, label: p.label, description: p.description, group: p.group, surface: p.surface,
  })));
});

// GET /api/staff/permission-groups — the groups the catalogue is listed under, in order.
router.get('/permission-groups', (_req, res) => { res.json(PERMISSION_GROUPS); });

// PUT /api/staff/roles/:roleId/permissions — replace a role's keys. { keys: string[] } (or the old { permission_ids }).
// Stores FINE keys only. Never the owner's role; never beyond the caller's own keys (lib/roleCeiling.ts).
router.put('/roles/:roleId/permissions', requirePermission('staff.roles'), async (req, res) => {
  const { keys, permission_ids } = req.body ?? {};
  let wanted: string[];
  if (Array.isArray(keys)) wanted = fineKeysOf(keys);
  else if (Array.isArray(permission_ids)) {
    const { data: rows, error } = permission_ids.length
      ? await supabase.from('permissions').select('id, key').in('id', permission_ids)
      : { data: [], error: null };
    if (error) { sendError(res, error); return; }
    if ((rows ?? []).length !== new Set(permission_ids).size) { res.status(400).json({ error: 'Unknown permission id' }); return; }
    wanted = fineKeysOf((rows ?? []).map((r: any) => r.key));
  } else {
    res.status(400).json({ error: 'keys (or permission_ids) array is required' });
    return;
  }

  let role: Awaited<ReturnType<typeof loadRole>>;
  try { role = await loadRole(req.businessId, req.params.roleId); } catch (e) { sendError(res, e as Error); return; }
  if (!role) { res.status(404).json({ error: 'Role not found' }); return; }

  const refusal = roleEditRefusal(callerHeld(req), role, wanted);
  if (refusal) { res.status(403).json(refusal); return; }

  try { await writeRoleKeys(role.id, wanted); } catch (e) { sendError(res, e as Error); return; }
  // Everyone on the role renews their token on its own (migration 13's trigger bumps permissions_version).
  res.json({ success: true, keys: wanted });
});

// POST /api/staff/roles — create a role. { name, description?, keys?, copy_from?: roleId }
router.post('/roles', requirePermission('staff.roles'), async (req, res) => {
  const { name, description, keys, copy_from } = req.body ?? {};
  const clean = typeof name === 'string' ? name.trim() : '';
  if (!clean) { res.status(400).json({ error: 'name is required' }); return; }
  if (clean.length > 60) { res.status(400).json({ error: 'name is too long' }); return; }
  // The owner's role is the owner's — nobody mints another one (it would hold everything by its name).
  if (isOwnerRoleName(clean)) { res.status(403).json({ error: 'That name belongs to the owner\'s role — choose another.' }); return; }

  let wanted: string[] = Array.isArray(keys) ? fineKeysOf(keys) : [];
  if (copy_from) {
    let src: Awaited<ReturnType<typeof loadRole>>;
    try { src = await loadRole(req.businessId, String(copy_from)); } catch (e) { sendError(res, e as Error); return; }
    if (!src) { res.status(404).json({ error: 'The role to copy was not found' }); return; }
    const srcKeys = isOwnerRoleName(src.name) ? fineKeysOf(PERMISSIONS.map((p) => p.key)) : [...src.keys].filter((k) => k !== '*');
    wanted = [...new Set([...srcKeys, ...wanted])];
  }
  const refusal = roleEditRefusal(callerHeld(req), { name: clean, keys: [] }, wanted);
  if (refusal) { res.status(403).json(refusal); return; }

  const { data, error } = await supabase
    .from('roles')
    .insert({ business_id: req.businessId, name: clean, description: description || null })
    .select()
    .single();

  if (error) { sendError(res, error); return; }
  if (wanted.length) {
    try { await writeRoleKeys((data as any).id, wanted); } catch (e) { sendError(res, e as Error); return; }
  }
  res.status(201).json({ ...data, keys: wanted });
});

// PATCH /api/staff/roles/:roleId — rename or describe a role. Never the owner's role.
router.patch('/roles/:roleId', requirePermission('staff.roles'), async (req, res) => {
  const { name, description } = req.body ?? {};
  let role: Awaited<ReturnType<typeof loadRole>>;
  try { role = await loadRole(req.businessId, req.params.roleId); } catch (e) { sendError(res, e as Error); return; }
  if (!role) { res.status(404).json({ error: 'Role not found' }); return; }
  const refusal = roleEditRefusal(callerHeld(req), role);
  if (refusal) { res.status(403).json(refusal); return; }
  const updates: Record<string, unknown> = {};
  if (name !== undefined) {
    const clean = typeof name === 'string' ? name.trim() : '';
    if (!clean || clean.length > 60) { res.status(400).json({ error: 'name must be 1–60 characters' }); return; }
    if (isOwnerRoleName(clean)) { res.status(403).json({ error: 'That name belongs to the owner\'s role — choose another.' }); return; }
    updates.name = clean;
  }
  if (description !== undefined) updates.description = description ? String(description) : null;
  if (!Object.keys(updates).length) { res.status(400).json({ error: 'Nothing to change' }); return; }
  const { data, error } = await supabase.from('roles').update(updates).eq('id', role.id).eq('business_id', req.businessId).select().single();
  if (error) { sendError(res, error); return; }
  res.json(data);
});

// DELETE /api/staff/roles/:roleId — remove a role nobody holds. 409 ROLE_IN_USE (with members) while anyone does.
router.delete('/roles/:roleId', requirePermission('staff.roles'), async (req, res) => {
  let role: Awaited<ReturnType<typeof loadRole>>;
  try { role = await loadRole(req.businessId, req.params.roleId); } catch (e) { sendError(res, e as Error); return; }
  if (!role) { res.status(404).json({ error: 'Role not found' }); return; }
  const refusal = roleEditRefusal(callerHeld(req), role);
  if (refusal) { res.status(403).json(refusal); return; }
  const { data: holders, error: hErr } = await supabase.from('users').select('id').eq('role_id', role.id).eq('business_id', req.businessId);
  if (hErr) { sendError(res, hErr); return; }
  const members = (holders ?? []).length;
  if (members > 0) {
    res.status(409).json({ error: `${members} ${members === 1 ? 'person has' : 'people have'} this role — give them another role first.`, code: 'ROLE_IN_USE', members });
    return;
  }
  const { error: dErr } = await supabase.from('role_permissions').delete().eq('role_id', role.id);
  if (dErr) { sendError(res, dErr); return; }
  const { error } = await supabase.from('roles').delete().eq('id', role.id).eq('business_id', req.businessId);
  if (error) { sendError(res, error); return; }
  res.json({ success: true });
});


// POST /api/staff/clock — record a clock in or clock out event.
// A494: it clocks ONE named person after checking THEIR PIN — the signed-in person (no staff_id), or the person named by
// staff_id. It used to look the PIN up across the whole business and clock (and NAME, with their id) whoever it matched:
// any signed-in session could try every PIN and learn whose it was. Every failure is the same 401 'Invalid PIN', and every
// failure counts towards the PIN limiter (lib/pinAttempts.ts).
router.post('/clock', async (req, res) => {
  const { pin, type, branch_id, staff_id } = req.body ?? {};

  if (!pin)    { res.status(400).json({ error: 'PIN is required' }); return; }
  if (!type || !['in', 'out'].includes(type)) {
    res.status(400).json({ error: 'type must be "in" or "out"' });
    return;
  }

  const pk = pinKey(req);
  if (pinLocked(pk)) { res.status(429).json(PIN_LOCKED_BODY); return; }
  const invalid = () => { notePinFailure(pk); res.status(401).json({ error: 'Invalid PIN' }); };

  const who = typeof staff_id === 'string' && staff_id ? staff_id : req.userId;
  if (!who) { res.status(400).json({ error: 'staff_id is required on a POS\'s own session' }); return; }
  if (!/^\d{4,6}$/.test(String(pin))) { invalid(); return; }

  // Where: a non-owner clocks at their own branch only. A550: a partner of every branch at any of theirs.
  const branch = allBranchAccess(req) ? (branch_id ?? req.branchId ?? null) : req.branchId;
  if (!allBranchAccess(req) && branch_id && branch_id !== req.branchId) {
    res.status(403).json({ error: 'You can only clock in at your own branch' });
    return;
  }
  if (partnerBranchRefusal(req, branch_id ? [branch_id] : undefined)) {
    res.status(403).json({ error: 'You can only clock in at your own branch' });
    return;
  }

  try {
    const { data: u, error: staffErr } = await supabase
      .from('users')
      .select('id, name, status, pin_hash, user_branches ( branch_id )')
      .eq('id', who)
      .eq('business_id', req.businessId)
      .maybeSingle();
    if (staffErr) { sendError(res, staffErr, { message: 'Clock event failed' }); return; }

    const row = u as { id: string; name: string; status?: string; pin_hash: string | null; user_branches?: Array<{ branch_id: string | null }> } | null;
    let valid = false;
    if (row && row.status === 'active' && row.pin_hash && (!branch || worksAtBranch(row.user_branches, branch))) {
      valid = (await verifyPin(String(pin), row.pin_hash, req.businessId as string)).valid;
    }
    if (!valid || !row) { invalid(); return; }
    notePinSuccess(pk);
    const staff = { id: row.id, name: row.name };

    const now = new Date().toISOString();

    // Record clock event
    const { error: insertErr } = await supabase
      .from('clock_events')
      .insert({
        business_id: req.businessId,
        staff_id:    staff.id,
        branch_id:   branch ?? null,
        event_type:  type,
        recorded_at: now,
      });

    if (insertErr) {
      // Table might not exist yet — fail gracefully
      console.warn('clock_events insert failed:', insertErr.message);
    }

    const timeStr = new Date(now).toLocaleString('en-KE', {
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      day: 'numeric', month: 'short',
    });

    res.json({
      type,
      staff_id:   staff.id,
      staff_name: staff.name,
      time:       timeStr,
      recorded_at: now,
    });
  } catch (err: any) {
    sendError(res, err, { message: 'Clock event failed' });
  }
});

export default router;
