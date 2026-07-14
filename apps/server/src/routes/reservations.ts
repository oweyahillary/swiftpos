/**
 * routes/reservations.ts
 *
 * Table reservations and walk-in waitlist.
 *
 * Reservations:
 *   GET  /api/reservations?date=&branch_id= — list for a date
 *   POST /api/reservations                  — create reservation
 *   PATCH /api/reservations/:id             — update / change status
 *   DELETE /api/reservations/:id            — cancel
 *
 * Waitlist:
 *   GET  /api/reservations/waitlist?branch_id= — active waitlist
 *   POST /api/reservations/waitlist            — add to waitlist
 *   PATCH /api/reservations/waitlist/:id       — update status (seated/left)
 */

import { Router } from 'express';
import { branchScope } from '../middleware/rbac';
import { sendError } from '../lib/sendError';
import { safeRouter } from '../middleware/asyncHandler';
import { supabase }    from '../lib/supabase';
import { requireAuth } from '../middleware/auth';

const router = safeRouter();
router.use(requireAuth);

// ── Reservations ──────────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  const { date } = req.query;
  const branch_id = branchScope(req);
  const today = new Date().toISOString().slice(0, 10);

  let query = supabase
    .from('reservations')
    .select('*, tables(name, capacity)')
    .eq('business_id', req.businessId)
    .order('reserved_time');

  if (branch_id) query = query.eq('branch_id', branch_id as string);
  if (date)      query = query.eq('reserved_date', date as string);
  else           query = query.eq('reserved_date', today);

  const { data, error } = await query;
  if (error) { sendError(res, error); return; }
  res.json(data ?? []);
});

router.post('/', async (req, res) => {
  const {
    branch_id, table_id, guest_name, guest_phone,
    party_size = 2, reserved_date, reserved_time, notes,
  } = req.body;

  if (!branch_id)     { res.status(400).json({ error: 'branch_id is required' }); return; }
  if (!guest_name?.trim()) { res.status(400).json({ error: 'guest_name is required' }); return; }
  if (!reserved_date) { res.status(400).json({ error: 'reserved_date is required' }); return; }
  if (!reserved_time) { res.status(400).json({ error: 'reserved_time is required' }); return; }

  const { data, error } = await supabase
    .from('reservations')
    .insert({
      business_id:   req.businessId,
      branch_id,
      table_id:      table_id || null,
      guest_name:    guest_name.trim(),
      guest_phone:   guest_phone?.trim() || null,
      party_size:    Number(party_size),
      reserved_date,
      reserved_time,
      notes:         notes?.trim() || null,
      status:        'confirmed',
    })
    .select('*, tables(name, capacity)')
    .single();

  if (error) { sendError(res, error); return; }
  res.status(201).json(data);
});

router.patch('/:id', async (req, res) => {
  const allowed = ['guest_name','guest_phone','party_size','reserved_date',
                   'reserved_time','table_id','notes','status'];
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }

  const { data, error } = await supabase
    .from('reservations')
    .update(updates)
    .eq('id', req.params.id)
    .eq('business_id', req.businessId)
    .select('*, tables(name, capacity)')
    .single();

  if (error || !data) { res.status(404).json({ error: 'Reservation not found' }); return; }
  res.json(data);
});

router.delete('/:id', async (req, res) => {
  await supabase.from('reservations').update({ status: 'cancelled' })
    .eq('id', req.params.id).eq('business_id', req.businessId);
  res.status(204).send();
});

// ── Waitlist ──────────────────────────────────────────────────────────────────

router.get('/waitlist', async (req, res) => {
  const branch_id = branchScope(req);

  let query = supabase
    .from('waitlist')
    .select('*')
    .eq('business_id', req.businessId)
    .eq('status', 'waiting')
    .order('added_at');

  if (branch_id) query = query.eq('branch_id', branch_id as string);

  const { data, error } = await query;
  if (error) { sendError(res, error); return; }
  res.json(data ?? []);
});

router.post('/waitlist', async (req, res) => {
  const { branch_id, guest_name, guest_phone, party_size = 2, estimated_wait, notes } = req.body;

  if (!branch_id)          { res.status(400).json({ error: 'branch_id is required' }); return; }
  if (!guest_name?.trim()) { res.status(400).json({ error: 'guest_name is required' }); return; }

  const { data, error } = await supabase
    .from('waitlist')
    .insert({
      business_id:    req.businessId,
      branch_id,
      guest_name:     guest_name.trim(),
      guest_phone:    guest_phone?.trim() || null,
      party_size:     Number(party_size),
      estimated_wait: estimated_wait ? Number(estimated_wait) : null,
      notes:          notes?.trim() || null,
      status:         'waiting',
    })
    .select()
    .single();

  if (error) { sendError(res, error); return; }
  res.status(201).json(data);
});

router.patch('/waitlist/:id', async (req, res) => {
  const { status, estimated_wait, notes } = req.body;
  const updates: Record<string, unknown> = {};
  if (status          !== undefined) updates.status         = status;
  if (estimated_wait  !== undefined) updates.estimated_wait = Number(estimated_wait);
  if (notes           !== undefined) updates.notes          = notes;
  if (status === 'seated') updates.seated_at = new Date().toISOString();

  const { data, error } = await supabase
    .from('waitlist')
    .update(updates)
    .eq('id', req.params.id)
    .eq('business_id', req.businessId)
    .select()
    .single();

  if (error || !data) { res.status(404).json({ error: 'Waitlist entry not found' }); return; }
  res.json(data);
});

export default router;
