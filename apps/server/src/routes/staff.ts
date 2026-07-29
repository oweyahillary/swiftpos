import { Router } from 'express';
import { sendError } from '../lib/sendError';
import { safeRouter } from '../middleware/asyncHandler';
import { requireAuth } from '../middleware/auth';
import { requirePermission, assertBranchAccess } from '../middleware/rbac';
import { supabase } from '../lib/supabase';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { validate } from '../middleware/validate';
import { CreateStaffSchema, UpdateStaffSchema } from '../lib/schemas';

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

// Roles a non-owner (e.g. a branch manager) must never be able to assign or
// grant — otherwise a manager with staff.manage could escalate by creating or
// promoting a user into an owner/admin/manager role. The dashboard hides these
// in the role picker, but that is client-side only; this is the server guard.
const ELEVATED_ROLE_NAMES = ['owner', 'admin', 'manager', 'supervisor', 'branch_manager'];

// Returns true if role_id refers to an elevated role.
//
// Two deliberate changes from the original, both about failing CLOSED:
//
//  1. No business_id filter. Roles may be seeded globally (business_id NULL) and
//     shared across tenants. With the filter, the lookup found nothing for such
//     a role, the function returned false, and every caller concluded "not
//     elevated" — so a branch manager could deactivate the proprietor's account
//     and nothing stopped them. Business ownership of a role is checked
//     separately where it matters (assigning one); this function answers only
//     "is this role privileged".
//
//  2. A missing or unreadable role is treated as elevated. If we cannot tell,
//     the safe answer to "may a manager modify this account" is no.
async function roleIsElevated(roleId: string, _businessId: string): Promise<boolean> {
  const { data: role, error } = await supabase
    .from('roles').select('name').eq('id', roleId).maybeSingle();
  if (error || !role) return true;
  return ELEVATED_ROLE_NAMES.includes(String(role.name).toLowerCase());
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

  const roleName = String((target as any)?.roles?.name ?? '').toLowerCase();
  if (roleName === 'owner' || roleName === 'admin') {
    return 'The business owner account can only be changed by the owner';
  }
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
function shapeStaff(rows: any[]): any[] {
  return (rows ?? []).map((u: any) => {
    const { override_pin_hash, pin_hash, ...rest } = u ?? {};
    return { ...rest, can_authorize: !!override_pin_hash };
  });
}

// Owner: sees all staff. Non-owners: only staff assigned to their branch.
router.get('/', async (req, res) => {
  if (req.isOwner) {
    // Owner sees everyone
    const { data, error } = await supabase
      .from('users')
      .select(`
        id, name, email, phone, status, created_at, updated_at, override_pin_hash,
        roles ( id, name, description ),
        user_branches ( branch_id, branches ( id, name ) ),
        user_permissions ( permission_id, granted )
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
        user_permissions ( permission_id, granted )
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
  staff = staff.filter((u: any) => {
    const roleName = String(u?.roles?.name ?? '').toLowerCase();
    return roleName !== 'owner' && roleName !== 'admin';
  });

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
router.post('/', requirePermission('staff.manage'), validate(CreateStaffSchema), async (req, res) => {
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

  // Server-side role guard: non-owners cannot create elevated-role staff.
  if (!req.isOwner && await roleIsElevated(role_id, req.businessId)) {
    res.status(403).json({ error: 'You are not allowed to assign this role' });
    return;
  }

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

  if (req.body.overrides?.length) {
    await supabase.from('user_permissions').insert(
      req.body.overrides.map((o: { permission_id: string; granted: boolean }) => ({
        user_id: user.id,
        permission_id: o.permission_id,
        granted: o.granted,
      }))
    );
  }

  res.status(201).json(user);
});

// POST /api/staff/invite — invite staff by email
router.post('/invite', requirePermission('staff.manage'), async (req, res) => {
  const { name, email, role_id, branch_ids } = req.body;

  if (!name || !email || !role_id) {
    res.status(400).json({ error: 'name, email and role_id are required' });
    return;
  }

  const { data: user, error: uErr } = await supabase
    .from('users')
    .insert({ business_id: req.businessId, name, email, role_id, status: 'inactive' })
    .select()
    .single();

  if (uErr) { sendError(res, uErr); return; }

  if (branch_ids?.length) {
    await supabase.from('user_branches').insert(
      branch_ids.map((bid: string) => ({ user_id: user.id, branch_id: bid }))
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
router.patch('/:id', requirePermission('staff.manage'), validate(UpdateStaffSchema), async (req, res) => {
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
    //  - cannot promote a user INTO an elevated role, and
    //  - cannot modify a user who ALREADY holds an elevated role.
    if (role_id && await roleIsElevated(role_id, req.businessId)) {
      res.status(403).json({ error: 'You are not allowed to assign this role' });
      return;
    }
    const { data: target } = await supabase
      .from('users').select('role_id').eq('id', req.params.id).single();
    if (target?.role_id && await roleIsElevated(target.role_id, req.businessId)) {
      res.status(403).json({ error: 'You are not allowed to manage this staff member' });
      return;
    }
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

  // Update per-user permission overrides
  // overrides: Array of { permission_id: string, granted: boolean }
  if (req.body.overrides !== undefined) {
    await supabase.from('user_permissions').delete().eq('user_id', req.params.id);
    if (req.body.overrides.length) {
      await supabase.from('user_permissions').insert(
        req.body.overrides.map((o: { permission_id: string; granted: boolean }) => ({
          user_id: req.params.id,
          permission_id: o.permission_id,
          granted: o.granted,
        }))
      );
    }
  }

  res.json(data);
});

// DELETE /api/staff/:id — soft deactivate
router.delete('/:id', requirePermission('staff.manage'), async (req, res) => {
  // Non-owners: verify target is in their branch
  if (!req.isOwner) {
    // Same refusal as PATCH. This route had NO elevated-role check whatsoever —
    // only the branch check below — while doing exactly what PATCH does: set
    // status to inactive. Guarding one and not the other left the front door
    // locked and the back door open.
    const refusal = await refuseIfProprietor(req.params.id, req.businessId);
    if (refusal) { res.status(403).json({ error: refusal }); return; }

    // And a manager must not be able to deactivate a peer manager or
    // supervisor either — the same rule PATCH already applies.
    const { data: target } = await supabase
      .from('users').select('role_id').eq('id', req.params.id).eq('business_id', req.businessId).maybeSingle();
    if (target?.role_id && await roleIsElevated(target.role_id, req.businessId)) {
      res.status(403).json({ error: 'You are not allowed to manage this staff member' });
      return;
    }

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



// GET /api/staff/roles — list all roles with their permissions
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
  res.json(data ?? []);
});

// GET /api/staff/permissions — list all available permissions
router.get('/permissions', async (req, res) => {
  const { data, error } = await supabase
    .from('permissions')
    .select('*')
    .order('module, label');

  if (error) { sendError(res, error); return; }
  res.json(data ?? []);
});

// PUT /api/staff/roles/:roleId/permissions — replace all permissions for a role
router.put('/roles/:roleId/permissions', requirePermission('staff.manage'), async (req, res) => {
  const { permission_ids } = req.body;
  if (!Array.isArray(permission_ids)) {
    res.status(400).json({ error: 'permission_ids array is required' });
    return;
  }

  // Verify role belongs to this business
  const { data: role } = await supabase
    .from('roles').select('id, name, is_default').eq('id', req.params.roleId).eq('business_id', req.businessId).single();
  if (!role) { res.status(404).json({ error: 'Role not found' }); return; }

  // ── C3: a non-owner with staff.manage had no further restriction here — they
  // could grant ANY role (including their own) permissions they don't hold
  // themselves (e.g. settings.manage, which defaultRolePermissions.ts already
  // treats as owner-only), or wipe an elevated role's permissions outright.
  // Two guards, both owner-exempt:
  //   1. Can never grant a permission the caller doesn't currently hold —
  //      structurally closes every escalation path (own role, another role,
  //      a freshly created custom role) without needing to special-case each.
  //   2. Can never touch an elevated role's permissions at all (reuses the
  //      same ELEVATED_ROLE_NAMES this file already guards role ASSIGNMENT
  //      with) — otherwise a manager could silently strip another manager's
  //      or a role-based "owner" account's access.
  if (!req.isOwner) {
    if (ELEVATED_ROLE_NAMES.includes(String(role.name).toLowerCase())) {
      res.status(403).json({ error: "Only the owner can edit an elevated role's permissions" });
      return;
    }
    if (permission_ids.length) {
      const callerKeys = new Set(req.permissionKeys ?? []);
      const { data: requested } = await supabase
        .from('permissions').select('key').in('id', permission_ids);
      const notHeld = (requested ?? []).map((p: any) => p.key).filter((k: string) => !callerKeys.has(k));
      if (notHeld.length) {
        res.status(403).json({ error: 'You cannot grant permissions you do not hold', missing: notHeld });
        return;
      }
    }
  }

  // Delete existing, insert new
  await supabase.from('role_permissions').delete().eq('role_id', req.params.roleId);

  if (permission_ids.length) {
    const { error } = await supabase.from('role_permissions').insert(
      permission_ids.map((pid: string) => ({ role_id: req.params.roleId, permission_id: pid }))
    );
    if (error) { sendError(res, error); return; }
  }

  res.json({ success: true });
});

// POST /api/staff/roles — create a custom role
router.post('/roles', requirePermission('staff.manage'), async (req, res) => {
  const { name, description } = req.body;
  if (!name) { res.status(400).json({ error: 'name is required' }); return; }

  const { data, error } = await supabase
    .from('roles')
    .insert({ business_id: req.businessId, name, description: description || null })
    .select()
    .single();

  if (error) { sendError(res, error); return; }
  res.status(201).json(data);
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
    // Look up staff member by PIN
    const { data: staff, error: staffErr } = await supabase
      .from('users')
      .select('id, name, role_id, roles ( name )')
      .eq('business_id', req.businessId)
      .eq('pin', pin)
      .eq('status', 'active')
      .maybeSingle();

    if (staffErr || !staff) {
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
