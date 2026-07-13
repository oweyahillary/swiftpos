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
import { supabase }    from '../lib/supabase';

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
      requested_at, reviewed_at, last_seen_at,
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

// ── PATCH /api/devices/:id/approve ───────────────────────────────────────────

router.patch('/:id/approve', async (req, res) => {
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
  }).catch(() => {}); // non-blocking

  res.json({ success: true });
});

// ── PATCH /api/devices/:id/reject ────────────────────────────────────────────

router.patch('/:id/reject', async (req, res) => {
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

router.delete('/:id', async (req, res) => {
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
