/**
 * parking.ts — Parking session management
 *
 * Routes:
 *   POST  /api/parking-sessions            — open session when vehicle enters bay
 *   GET   /api/parking-sessions            — list sessions (branch_id, status, date range)
 *   GET   /api/parking-sessions/:id        — single session
 *   PATCH /api/parking-sessions/:id        — update (vehicle plate, link order_id)
 *   POST  /api/parking-sessions/:id/close  — close with billed_hours + total_amount
 *   POST  /api/parking-sessions/:id/void   — void (vehicle left without paying)
 *
 * Flow in CashierScreen:
 *   1. Cashier taps bay → POST /api/parking-sessions  → session id returned
 *   2. Vehicle parks, cashier adds charges to cart
 *   3. Payment completed → order created → session /close called (non-blocking)
 *   4. /close sets ended_at, billed_hours, total_amount, status = completed
 *
 * Manager Dashboard polls GET ?status=open every 30s for live bay occupancy.
 */

import { safeRouter }        from '../middleware/asyncHandler';
import { sendError } from '../lib/sendError';
import { requireAuth }       from '../middleware/auth';
import { branchScope, assertBranchAccess } from '../middleware/rbac';
import { supabase }          from '../lib/supabase';

const router = safeRouter();
router.use(requireAuth);

// ── POST /api/parking-sessions ────────────────────────────────────────────────

router.post('/', async (req, res) => {
  const {
    bay_id,
    branch_id,
    vehicle_plate,
    vehicle_type  = 'car',
    rate_per_hour = 200,
  } = req.body;

  if (!bay_id)    { res.status(400).json({ error: 'bay_id is required' });    return; }
  if (!branch_id) { res.status(400).json({ error: 'branch_id is required' }); return; }

  if (!assertBranchAccess(req, branch_id)) {
    res.status(403).json({ error: 'Access denied to this branch' });
    return;
  }

  // Verify bay belongs to this business (cross-tenant guard)
  const { data: bay } = await supabase
    .from('tables')
    .select('id, name, slot_type, status')
    .eq('id', bay_id)
    .eq('business_id', req.businessId)
    .single();

  if (!bay) {
    res.status(404).json({ error: 'Bay not found' });
    return;
  }

  if (bay.slot_type !== 'parking_bay') {
    res.status(400).json({ error: 'This table is not a parking bay' });
    return;
  }

  if (bay.status === 'inactive') {
    res.status(400).json({ error: 'This bay is not active' });
    return;
  }

  // Prevent double-opening the same bay
  const { data: existing } = await supabase
    .from('parking_sessions')
    .select('id')
    .eq('bay_id', bay_id)
    .eq('business_id', req.businessId)
    .eq('status', 'open')
    .maybeSingle();

  if (existing) {
    res.status(409).json({
      error:      'This bay already has an open session',
      session_id: existing.id,
    });
    return;
  }

  const { data, error } = await supabase
    .from('parking_sessions')
    .insert({
      business_id:   req.businessId,
      branch_id,
      bay_id,
      vehicle_plate: vehicle_plate?.trim() || null,
      vehicle_type,
      rate_per_hour: Number(rate_per_hour),
      status:        'open',
      started_at:    new Date().toISOString(),
    })
    .select('*, tables(id, name, capacity)')
    .single();

  if (error) { sendError(res, error); return; }
  res.status(201).json(data);
});

// ── GET /api/parking-sessions ─────────────────────────────────────────────────

router.get('/', async (req, res) => {
  const { status, branch_id, from, to } = req.query;
  const limit        = Math.min(parseInt(req.query.limit as string) || 100, 500);
  const scopedBranch = branchScope(req);
  const queryBranch  = (branch_id as string) || scopedBranch;

  let q = supabase
    .from('parking_sessions')
    .select('*, tables(id, name)')
    .eq('business_id', req.businessId)
    .order('started_at', { ascending: false })
    .limit(limit);

  if (queryBranch) q = q.eq('branch_id', queryBranch);
  if (status)      q = q.eq('status',    status as string);
  if (from)        q = q.gte('started_at', from as string);
  if (to)          q = q.lte('started_at', to   as string);

  const { data, error } = await q;
  if (error) { sendError(res, error); return; }
  res.json(data ?? []);
});

// ── GET /api/parking-sessions/:id ────────────────────────────────────────────

router.get('/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('parking_sessions')
    .select('*, tables(id, name, capacity)')
    .eq('id', req.params.id)
    .eq('business_id', req.businessId)
    .single();

  if (error || !data) { res.status(404).json({ error: 'Session not found' }); return; }
  res.json(data);
});

// ── PATCH /api/parking-sessions/:id ──────────────────────────────────────────

router.patch('/:id', async (req, res) => {
  const ALLOWED = ['vehicle_plate', 'vehicle_type', 'rate_per_hour', 'order_id'];
  const updates: Record<string, unknown> = {};
  for (const key of ALLOWED) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: 'No updatable fields provided' });
    return;
  }

  const { data, error } = await supabase
    .from('parking_sessions')
    .update(updates)
    .eq('id', req.params.id)
    .eq('business_id', req.businessId)
    .select()
    .single();

  if (error || !data) { res.status(404).json({ error: 'Session not found' }); return; }
  res.json(data);
});

// ── POST /api/parking-sessions/:id/close ─────────────────────────────────────
// Called by CashierScreen after payment. Computes bill and marks completed.

router.post('/:id/close', async (req, res) => {
  const { order_id } = req.body;

  const { data: session, error: fetchErr } = await supabase
    .from('parking_sessions')
    .select('*')
    .eq('id', req.params.id)
    .eq('business_id', req.businessId)
    .single();

  if (fetchErr || !session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  if (session.status !== 'open') {
    res.status(400).json({ error: `Session is already ${session.status}` });
    return;
  }

  const endedAt     = new Date();
  const elapsedMs   = endedAt.getTime() - new Date(session.started_at).getTime();
  const billedHours = Math.max(1, Math.ceil(elapsedMs / 3_600_000)); // minimum 1 hour
  const totalAmount = Math.round(billedHours * Number(session.rate_per_hour) * 100) / 100;

  const { data, error } = await supabase
    .from('parking_sessions')
    .update({
      status:       'completed',
      ended_at:     endedAt.toISOString(),
      billed_hours: billedHours,
      total_amount: totalAmount,
      order_id:     order_id ?? session.order_id ?? null,
    })
    .eq('id', req.params.id)
    .select()
    .single();

  if (error) { sendError(res, error); return; }

  res.json({
    session:      data,
    billed_hours: billedHours,
    total_amount: totalAmount,
  });
});

// ── POST /api/parking-sessions/:id/void ──────────────────────────────────────
// Vehicle left without paying, or session created in error.

router.post('/:id/void', async (req, res) => {
  const { data: session } = await supabase
    .from('parking_sessions')
    .select('id, status')
    .eq('id', req.params.id)
    .eq('business_id', req.businessId)
    .single();

  if (!session) { res.status(404).json({ error: 'Session not found' }); return; }

  if (session.status !== 'open') {
    res.status(400).json({ error: `Can only void an open session (current: ${session.status})` });
    return;
  }

  const { data, error } = await supabase
    .from('parking_sessions')
    .update({ status: 'voided', ended_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .select()
    .single();

  if (error) { sendError(res, error); return; }
  res.json(data);
});

export default router;
