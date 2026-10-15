import { Router } from 'express';
import { sendError } from '../lib/sendError';
import { safeRouter } from '../middleware/asyncHandler';
import { requireAuth } from '../middleware/auth';
import { verifyPin } from './auth';
import { requirePermission } from '../middleware/rbac';
import { supabase } from '../lib/supabase';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { validate } from '../middleware/validate';
import { CreateStaffSchema, UpdateStaffSchema } from '../lib/schemas';
import { callerHeld, canAssignRole, roleEditRefusal, overridesBeyondCaller } from '../lib/roleCeiling';
import { isOwnerRoleName } from '../lib/ownerRole';
import { PERMISSIONS, PERMISSION_GROUPS, expandKeys, isPermissionKey } from '../lib/permissions';
import { permissionIds, roleKeyMap, loadRole, personKeys, fineKeysOf } from '../lib/roleKeys';
import { useEmailCodes } from '../lib/loginOtp';   // A391

const router = safeRouter();
router.use(requireAuth);

function hashPin(pin: string, businessId: string): string {
  return crypto.createHash('sha256').update(`${pin}:${businessId}`).digest('hex');
}

// Override PINs are auth secrets used to authorize privileged actions (e.g.
// voiding a paid order), so they get a proper salted bcrypt hash — kept separate
// from the login pin_hash so shoulder-surfing an override never leaks login.
const OVERRIDE_PIN_RE = /^\d{4,6}$/;
function hashOverridePin(pin: string): Promise<string> {
  return bcrypt.hash(String(pin), 10);
}

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
function shapeStaff(rows: any[]): any[] {
  return (rows ?? []).map((u: any) => {
    const { override_pin_hash, pin_hash, ...rest } = u ?? {};
    const override_keys: Record<string, boolean> = {};
    for (const up of (u?.user_permissions ?? []) as Array<{ granted?: boolean; permissions?: { key?: string | null } | null }>) {
      const k = up?.permissions?.key;
      if (!k) continue;
      for (const f of expandKeys([k])) if (f !== '*') override_keys[f] = up.granted === true;
    }
    return { ...rest, can_authorize: !!override_pin_hash, override_keys };
  });
}

// Owner: sees all staff. Non-owners: only staff assigned to their branch.
// A490: staff.view (everyone held it before migration 134 — OPEN_BEFORE_A490).
router.get('/', requirePermission('staff.view'), async (req, res) => {
  if (req.isOwner) {
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
    res.json(shapeStaff(data ?? []));
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

  res.json(shapeStaff(staff));
});

// GET /api/staff/authorizers — list staff who can authorize overrides.
// Used by the POS void modal so a supervisor can be selected by name, then
// confirm with their override PIN. Returns only id/name/role — never the hash.
// Any authenticated user on this business may read it (names only).
router.get('/authorizers', async (req, res) => {
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

  // Non-owners can only assign staff to their own branch
  const effectiveBranchIds: string[] = req.isOwner
    ? (branch_ids ?? [])
    : [req.branchId!];

  if (!req.isOwner && branch_ids?.length && !branch_ids.every((bid: string) => bid === req.branchId)) {
    res.status(403).json({ error: 'You can only assign staff to your own branch' });
    return;
  }

  // Server-side role guard: a non-owner gives only a role within their own keys (never the owner's).
  const roleRefusal = await roleAssignRefusal(req, role_id);
  if (roleRefusal) { res.status(403).json({ error: roleRefusal }); return; }
  const overRefusal = await refuseOverridesBeyondCaller(req);   // A340
  if (overRefusal) { res.status(403).json(overRefusal); return; }

  const pin_hash = hashPin(pin, req.businessId);

  // Optional per-user override PIN (manager authority for voids/overrides).
  const overridePin = req.body.override_pin;
  let override_pin_hash: string | null | undefined;
  if (typeof overridePin === 'string' && overridePin.length > 0) {
    if (!OVERRIDE_PIN_RE.test(overridePin)) {
      res.status(400).json({ error: 'Override PIN must be 4–6 digits' });
      return;
    }
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
  if (!req.isOwner) {
    const roleRefusal = await roleAssignRefusal(req, role_id);
    if (roleRefusal) { res.status(403).json({ error: roleRefusal }); return; }
    if (branch_ids?.length && !branch_ids.every((bid: string) => bid === req.branchId)) {
      res.status(403).json({ error: 'You can only assign staff to your own branch' });
      return;
    }
  }
  const inviteBranchIds: string[] = req.isOwner ? (branch_ids ?? []) : (req.branchId ? [req.branchId] : []);

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
    .from('users').select('id').eq('id', req.params.id).eq('business_id', req.businessId).single();
  if (!existing) { res.status(404).json({ error: 'Staff member not found' }); return; }

  // Non-owners: never touch a proprietor account, whatever branch it sits in.
  // This is the guard that matters — hiding the row in the list is presentation,
  // the endpoint is the boundary.
  if (!req.isOwner) {
    const refusal = await refuseIfProprietor(req.params.id, req.businessId);
    if (refusal) { res.status(403).json({ error: refusal }); return; }
  }

  // Non-owners: verify target staff belongs to their branch
  if (!req.isOwner) {
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
    // Non-owners cannot assign staff to branches outside their own
    if (branch_ids && !branch_ids.every((bid: string) => bid === req.branchId)) {
      res.status(403).json({ error: 'You can only assign staff to your own branch' });
      return;
    }

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
  }

  const updates: any = { updated_at: new Date().toISOString() };
  if (name)               updates.name   = name;
  if (email !== undefined) updates.email = email || null;
  if (role_id)            updates.role_id = role_id;
  if (status)             updates.status       = status;
  if (hourly_rate !== undefined) updates.hourly_rate = hourly_rate !== null ? Number(hourly_rate) : null;
  if (pin) {
    if (!/^\d{4,6}$/.test(pin)) { res.status(400).json({ error: 'PIN must be 4–6 digits' }); return; }
    updates.pin_hash = hashPin(pin, req.businessId);
  }

  // Override PIN: a 4–6 digit value sets/replaces it, '' clears it (revokes
  // override authority), and omitting the field leaves it unchanged.
  const overridePin = req.body.override_pin;
  if (typeof overridePin === 'string') {
    if (overridePin.length === 0) {
      updates.override_pin_hash = null;
    } else if (OVERRIDE_PIN_RE.test(overridePin)) {
      updates.override_pin_hash = await hashOverridePin(overridePin);
    } else {
      res.status(400).json({ error: 'Override PIN must be 4–6 digits' });
      return;
    }
  }

  // (Their token renews on its own: the database bumps permissions_version on any override or role change, migration 13.)
  const rows = await overrideRows(req.params.id, req.body);

  const { data, error } = await supabase
    .from('users').update(updates).eq('id', req.params.id).select().single();
  if (error) { sendError(res, error); return; }

  if (branch_ids !== undefined) {
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
  }

  const { error } = await supabase
    .from('users')
    .update({ status: 'inactive', updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .eq('business_id', req.businessId);

  if (error) { sendError(res, error); return; }
  res.json({ success: true });
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


// POST /api/staff/clock — record a clock in or clock out event
// Uses PIN to identify the staff member (same as POS login)
router.post('/clock', async (req, res) => {
  const { pin, type, branch_id } = req.body;

  if (!pin)    { res.status(400).json({ error: 'PIN is required' }); return; }
  if (!type || !['in', 'out'].includes(type)) {
    res.status(400).json({ error: 'type must be "in" or "out"' });
    return;
  }

  try {
    // Look up staff member by PIN. PINs are stored bcrypt-hashed in pin_hash (with
    // a legacy SHA256 fallback), so we fetch active staff and verify each with the
    // canonical verifier — the old `.eq('pin', pin)` hit a column that does not
    // exist (there is no plaintext `pin`), so every clock-in returned Invalid PIN
    // (A136). Same verification path as POS login.
    const { data: candidates, error: staffErr } = await supabase
      .from('users')
      .select('id, name, role_id, pin_hash, roles ( name )')
      .eq('business_id', req.businessId)
      .eq('status', 'active');

    let staff: { id: string; name: string; role_id: string | null } | null = null;
    if (!staffErr && candidates) {
      for (const u of candidates as Array<{ id: string; name: string; role_id: string | null; pin_hash: string | null }>) {
        if (!u.pin_hash) continue;
        const { valid } = await verifyPin(pin, u.pin_hash, req.businessId as string);
        if (valid) { staff = { id: u.id, name: u.name, role_id: u.role_id }; break; }
      }
    }

    if (!staff) {
      res.status(401).json({ error: 'Invalid PIN' });
      return;
    }

    const now = new Date().toISOString();

    // Record clock event
    const { error: insertErr } = await supabase
      .from('clock_events')
      .insert({
        business_id: req.businessId,
        staff_id:    staff.id,
        branch_id:   branch_id ?? null,
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
