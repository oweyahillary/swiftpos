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
import { requirePermission } from '../middleware/rbac';
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

  res.json(data ?? []);
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
router.get('/fleet', requirePermission('settings.manage'), async (req, res) => {
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

// ── PATCH /api/devices/:id/approve ───────────────────────────────────────────

router.patch('/:id/approve', requirePermission('settings.manage'), async (req, res) => {  // M22: was requireAuth only
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

router.patch('/:id/reject', requirePermission('settings.manage'), async (req, res) => {  // M22: was requireAuth only
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

router.delete('/:id', requirePermission('settings.manage'), async (req, res) => {  // M22: was requireAuth only
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

export default router;
