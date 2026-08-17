/**
 * devices.ts — Device registration management
 *
 * Routes:
 *   GET    /api/devices               — list pending/approved/rejected devices for business
 *   PATCH  /api/devices/:id/approve   — owner approves a device
 *   PATCH  /api/devices/:id/reject    — owner rejects a device
 *   DELETE /api/devices/:id           — owner revokes an approved device
 *
 * The actual device registration check lives in auth.ts (pos-login / verify-pin),
 * which inserts 'pending' rows and returns DEVICE_NOT_REGISTERED when blocked.
 */

import { safeRouter } from '../middleware/asyncHandler';
import { sendError } from '../lib/sendError';
import { requireAuth } from '../middleware/auth';
import { requireAnyPermission } from '../middleware/rbac';
import { isNodeRole } from '../lib/deviceRegistry';
import { ROLE_HANDOVER_WINDOW_MINUTES } from '../lib/deviceRole';
import { supabase }    from '../lib/supabase';
import { REQUIRED_DESKTOP_SCHEMA } from '../lib/desktopSchema';

const router = safeRouter();
router.use(requireAuth);

// ── GET /api/devices ──────────────────────────────────────────────────────────
// Returns all devices for the business, with staff name resolved.
// Query: ?status=pending|approved|rejected  (omit for all)

router.get('/', async (req, res) => {
  const { status } = req.query;

  let q = supabase
    .from('user_devices')
    .select(`
      id, fingerprint, device_label, ip_address, status,
      requested_at, reviewed_at, last_seen_at, app_version,
      schema_version, last_sync_at, device_id,
      branch_id, device_role, terminal_code, created_at,
      user_id,
      users ( id, name, email,
        roles ( name )
      )
    `)
    .eq('business_id', req.businessId)
    .order('requested_at', { ascending: false });

  if (status && ['pending', 'approved', 'rejected'].includes(status as string)) {
    q = q.eq('status', status as string);
  }

  const { data, error } = await q;
  if (error) { sendError(res, error); return; }

  // A71: resolve branch names in one round-trip so the owner sees WHERE a device
  // is bound. Not embedded via PostgREST because user_devices has two FKs to
  // branches (branch_id + previous_branch_id, migration 52) — that's ambiguous.
  const rows = data ?? [];
  const branchIds = [...new Set(rows.map((d: any) => d.branch_id).filter(Boolean))];
  let branchName: Record<string, string> = {};
  if (branchIds.length) {
    const { data: br } = await supabase.from('branches').select('id, name').in('id', branchIds);
    branchName = Object.fromEntries((br ?? []).map((b: any) => [b.id, b.name]));
  }

  res.json(rows.map((d: any) => ({
    ...d,
    branch_name: d.branch_id ? (branchName[d.branch_id] ?? null) : null,
  })));
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/devices/fleet
//
// Health of every approved terminal: which build, which schema, and — the number
// that actually matters — when it last synced.
//
// Separate from GET / because they answer different questions. That list is "who
// is allowed to sign in", an access-control view sorted by request date. This is
// "is every till healthy right now", and it needs the stale ones first.
//
// WHY last_sync_at MATTERS MORE THAN last_seen_at
//   last_seen_at is written at SIGN-IN. A till that signed in at 07:00 and has
//   silently failed to sync since 07:05 — network unplugged, or its queue wedged
//   on a rejected row — looks perfectly healthy by last_seen_at alone, and the
//   first sign of trouble is the day's takings coming up short in the cloud.
//
// The server states the facts and computes nothing subjective beyond staleness in
// hours; whether "behind" is acceptable is a judgement for whoever reads it.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/fleet', requireAnyPermission('devices.approve', 'settings.manage'), async (req, res) => {
  const { data, error } = await supabase
    .from('user_devices')
    .select(`
      id, device_label, device_id, status, app_version, schema_version,
      last_seen_at, last_sync_at,
      users ( name )
    `)
    .eq('business_id', req.businessId)
    .eq('status', 'approved');

  if (error) { sendError(res, error); return; }

  const now = Date.now();
  const hoursSince = (iso: string | null) =>
    iso ? Math.floor((now - new Date(iso).getTime()) / 3_600_000) : null;

  const fleet = (data ?? []).map((d: any) => ({
    id: d.id,
    deviceId: d.device_id ?? null,
    label: d.device_label ?? null,
    user: d.users?.name ?? null,
    appVersion: d.app_version ?? null,
    schemaVersion: d.schema_version ?? null,
    lastSeenAt: d.last_seen_at ?? null,
    lastSyncAt: d.last_sync_at ?? null,
    hoursSinceSync: hoursSince(d.last_sync_at ?? null),
    hoursSinceSeen: hoursSince(d.last_seen_at ?? null),
  }));

  // Never-synced sorts first, then longest-silent. The device needing attention
  // should not be somewhere in the middle of an alphabetical list.
  fleet.sort((a, b) => {
    if (a.hoursSinceSync === null && b.hoursSinceSync !== null) return -1;
    if (b.hoursSinceSync === null && a.hoursSinceSync !== null) return 1;
    return (b.hoursSinceSync ?? 0) - (a.hoursSinceSync ?? 0);
  });

  res.json({
    fleet,
    // Echoed so the UI compares against what the SERVER requires rather than a
    // number hardcoded in the dashboard, which would drift the moment one is
    // deployed without the other.
    requiredSchema: REQUIRED_DESKTOP_SCHEMA,
  });
});

// ── PATCH /api/devices/:id/label ── A72: owner gives a device a chosen name ──
// device_label is written by registration ONLY on first insert (deviceRegistry
// refresh applies `patch`, which does not touch it), so a chosen name persists
// across sign-ins and is not clobbered. Tenant-guarded — you can only rename your
// own devices.
router.patch('/:id/label', requireAnyPermission('devices.approve', 'settings.manage'), async (req, res) => {
  const label = String(req.body?.label ?? '').trim();
  if (!label)            { res.status(400).json({ error: 'A device name is required.' }); return; }
  if (label.length > 60) { res.status(400).json({ error: 'Device name must be 60 characters or fewer.' }); return; }

  const { data: device } = await supabase
    .from('user_devices').select('id, business_id')
    .eq('id', req.params.id).eq('business_id', req.businessId).maybeSingle();
  if (!device) { res.status(404).json({ error: 'Device not found' }); return; }

  const { error } = await supabase
    .from('user_devices').update({ device_label: label }).eq('id', req.params.id);
  if (error) { sendError(res, error); return; }

  res.json({ id: req.params.id, device_label: label });
});

// ── PATCH /api/devices/:id/approve ───────────────────────────────────────────

router.patch('/:id/approve', requireAnyPermission('devices.approve', 'settings.manage'), async (req, res) => {  // M22: was requireAuth only
  const { id } = req.params;

  const { data: device, error: fetchErr } = await supabase
    .from('user_devices')
    .select('id, user_id, business_id, status')
    .eq('id', id)
    .eq('business_id', req.businessId)
    .maybeSingle();

  if (fetchErr || !device) {
    res.status(404).json({ error: 'Device not found' });
    return;
  }

  const { error } = await supabase
    .from('user_devices')
    .update({
      status:      'approved',
      reviewed_at: new Date().toISOString(),
      reviewed_by: req.userId,
    })
    .eq('id', id);

  if (error) { sendError(res, error); return; }

  // Write a notification for the cashier so they know to retry
  await supabase.from('notifications').insert({
    business_id: req.businessId,
    type:        'device_approved',
    title:       'Device approved',
    message:     'Your device has been approved. You can now log in.',
    link:        '/pos',
  });

  res.json({ success: true });
});

// ── PATCH /api/devices/:id/reject ────────────────────────────────────────────

router.patch('/:id/reject', requireAnyPermission('devices.approve', 'settings.manage'), async (req, res) => {  // M22: was requireAuth only
  const { id } = req.params;

  const { data: device, error: fetchErr } = await supabase
    .from('user_devices')
    .select('id, business_id')
    .eq('id', id)
    .eq('business_id', req.businessId)
    .maybeSingle();

  if (fetchErr || !device) {
    res.status(404).json({ error: 'Device not found' });
    return;
  }

  const { error } = await supabase
    .from('user_devices')
    .update({
      status:      'rejected',
      reviewed_at: new Date().toISOString(),
      reviewed_by: req.userId,
    })
    .eq('id', id);

  if (error) { sendError(res, error); return; }
  res.json({ success: true });
});

// ── DELETE /api/devices/:id ───────────────────────────────────────────────────
// Revoke a previously approved device — e.g. lost/stolen or staff departure.

router.delete('/:id', requireAnyPermission('devices.approve', 'settings.manage'), async (req, res) => {  // M22: was requireAuth only
  const { data: device, error: fetchErr } = await supabase
    .from('user_devices')
    .select('id, business_id')
    .eq('id', req.params.id)
    .eq('business_id', req.businessId)
    .maybeSingle();

  if (fetchErr || !device) {
    res.status(404).json({ error: 'Device not found' });
    return;
  }

  const { error } = await supabase
    .from('user_devices')
    .delete()
    .eq('id', req.params.id);

  if (error) { sendError(res, error); return; }
  res.status(204).send();
});

// ── POST /api/devices/:id/authorise-handover ─────────────────────────────────
// Open a window during which a DIFFERENT machine may take over as this branch's
// server. Migration 74; mirrors the rebind window migration 52 gave branch
// binding, and exists for the same reason: a legitimate, occasional act should
// be possible without a developer and impossible without somebody accountable.
//
// Required for failover. When a branch server dies and a peer is promoted, the
// promoted machine claims a serving role the dead one still holds — and is
// refused, because refusing an unexpected claim is the whole point. Without this
// route the branch would recover its data and never recover its ability to
// obtain credentials.
//
// `:id` is the OUTGOING device — the one currently confirmed. Granting on the
// incumbent rather than the newcomer is deliberate: the operator names the
// machine being replaced, which is the one they can identify, and there may be
// no row yet for a replacement that has never synced.
router.post('/:id/authorise-handover', requireAnyPermission('devices.approve', 'settings.manage'), async (req, res) => {
  const { data: device, error: fetchErr } = await supabase
    .from('user_devices')
    .select('id, device_id, device_label, branch_id, device_role, role_confirmed_at')
    .eq('id', req.params.id)
    .eq('business_id', req.businessId)
    .maybeSingle();

  if (fetchErr || !device) {
    res.status(404).json({ error: 'Device not found' });
    return;
  }

  if (!isNodeRole((device as any).device_role)) {
    res.status(400).json({
      error: 'That machine is not registered as a branch server, so there is nothing to hand over.',
      code:  'not_serving',
    });
    return;
  }

  const until = new Date(Date.now() + ROLE_HANDOVER_WINDOW_MINUTES * 60_000).toISOString();

  const { error } = await supabase
    .from('user_devices')
    .update({
      role_change_allowed_until: until,
      role_change_authorised_by: req.userId,
    })
    .eq('id', (device as any).id);

  if (error) { sendError(res, error); return; }

  console.log(
    `[deviceRole] handover authorised for branch ${(device as any).branch_id}: ` +
    `${(device as any).device_id} may be replaced until ${until} (by user ${req.userId})`,
  );

  res.json({
    success: true,
    // The operator needs to know this is time-boxed and what to do inside it,
    // or they will authorise it and walk away.
    expiresAt: until,
    windowMinutes: ROLE_HANDOVER_WINDOW_MINUTES,
    message:
      `The replacement machine must sync within ${ROLE_HANDOVER_WINDOW_MINUTES} minutes to take over as ` +
      `this branch's server. After that the window closes and the current machine keeps the role.`,
  });
});

export default router;
