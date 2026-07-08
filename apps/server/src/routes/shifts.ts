import { Router } from 'express';
import { sendError } from '../lib/sendError';
import { safeRouter } from '../middleware/asyncHandler';
import { requireAuth } from '../middleware/auth';
import { supabase } from '../lib/supabase';
import { validate } from '../middleware/validate';
import { OpenShiftSchema, CloseShiftSchema } from '../lib/schemas';

const router = safeRouter();
router.use(requireAuth);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/shifts/current
// Returns the caller's open shift for their branch (if any).
// Used by the POS on boot to resume a session.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/current', async (req, res) => {
  const { data, error } = await supabase
    .from('shifts')
    .select('*')
    .eq('business_id', req.businessId)
    .eq('cashier_id', req.userId)
    .eq('status', 'open')
    .order('opened_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) { sendError(res, error); return; }
  res.json(data ?? null);
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/shifts/open
// Opens a new shift. Rejects if the cashier already has an open shift.
// Body: { branch_id, opening_float }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/open', validate(OpenShiftSchema), async (req, res) => {
  const { branch_id, opening_float = 0 } = req.body;

  if (!branch_id) {
    res.status(400).json({ error: 'branch_id is required' });
    return;
  }

  // Guard: no duplicate open shifts for this cashier
  const { data: existing } = await supabase
    .from('shifts')
    .select('id')
    .eq('business_id', req.businessId)
    .eq('cashier_id', req.userId)
    .eq('status', 'open')
    .maybeSingle();

  if (existing) {
    res.status(409).json({ error: 'You already have an open shift', shiftId: existing.id });
    return;
  }

  const { data, error } = await supabase
    .from('shifts')
    .insert({
      business_id: req.businessId,
      branch_id,
      cashier_id: req.userId,
      opening_float: Number(opening_float),
      status: 'open',
    })
    .select()
    .single();

  if (error) { sendError(res, error); return; }
  res.status(201).json(data);
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/shifts/:id/close
// Closes a shift with a cash count and optional notes.
// Calculates expected cash and variance automatically.
// Body: { closing_float, notes? }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/:id/close', validate(CloseShiftSchema), async (req, res) => {
  const { id } = req.params;
  const { closing_float, notes, denomination_breakdown } = req.body;

  if (closing_float === undefined || closing_float === null) {
    res.status(400).json({ error: 'closing_float is required' });
    return;
  }

  // If a denomination breakdown was supplied, verify it sums to closing_float
  // (guards against a UI/transport mismatch between the count and the total).
  if (denomination_breakdown && typeof denomination_breakdown === 'object') {
    const summed = Object.entries(denomination_breakdown)
      .reduce((s, [denom, count]) => s + Number(denom) * Number(count), 0);
    if (Math.round(summed * 100) !== Math.round(Number(closing_float) * 100)) {
      res.status(400).json({
        error: `Denomination count (${summed.toFixed(2)}) does not match closing float (${Number(closing_float).toFixed(2)})`,
      });
      return;
    }
  }

  // Fetch the shift (must belong to this business and be open)
  const { data: shift, error: shiftErr } = await supabase
    .from('shifts')
    .select('*')
    .eq('id', id)
    .eq('business_id', req.businessId)
    .eq('status', 'open')
    .single();

  if (shiftErr || !shift) {
    res.status(404).json({ error: 'Open shift not found' });
    return;
  }

  // Sum all completed CASH payments for orders belonging to this shift.
  // Use orders → payments direction (more reliable than the !inner embed
  // syntax which is PostgREST-version sensitive and fails on some Supabase tiers).
  const { data: shiftOrders, error: ordErr } = await supabase
    .from('orders')
    .select('id')
    .eq('shift_id', id)
    .eq('status', 'completed');

  if (ordErr) { sendError(res, ordErr); return; }

  let cashSales = 0;
  const orderIds = (shiftOrders ?? []).map((o: any) => o.id);
  if (orderIds.length > 0) {
    const { data: cashPayments, error: payErr } = await supabase
      .from('payments')
      .select('amount')
      .in('order_id', orderIds)
      .eq('method', 'cash')
      .eq('status', 'completed');
    if (payErr) { sendError(res, payErr); return; }
    cashSales = (cashPayments ?? []).reduce((sum, p) => sum + Number(p.amount), 0);
  }

  // Sum float_out movements (cash removed from drawer)
  const { data: floatTxns } = await supabase
    .from('float_transactions')
    .select('type, amount')
    .eq('shift_id', id);

  const floatIn  = (floatTxns ?? []).filter(f => f.type === 'float_in') .reduce((s, f) => s + Number(f.amount), 0);
  const floatOut = (floatTxns ?? []).filter(f => f.type === 'float_out').reduce((s, f) => s + Number(f.amount), 0);

  const expectedCash  = Number(shift.opening_float) + cashSales + floatIn - floatOut;
  const cashVariance  = Number(closing_float) - expectedCash;

  // Require an explanatory note whenever the count doesn't match expected cash.
  if (Math.round(cashVariance * 100) !== 0 && !(notes && notes.trim())) {
    res.status(400).json({
      error: 'A note is required to close a shift with a cash variance',
      variance: cashVariance,
      expected_cash: expectedCash,
    });
    return;
  }

  const { data: closed, error: closeErr } = await supabase
    .from('shifts')
    .update({
      status: 'closed',
      closed_at: new Date().toISOString(),
      closing_float: Number(closing_float),
      expected_cash: expectedCash,
      cash_variance: cashVariance,
      notes: notes ?? null,
      denomination_breakdown: denomination_breakdown ?? null,
    })
    .eq('id', id)
    .select()
    .single();

  if (closeErr) { sendError(res, closeErr); return; }
  res.json(closed);
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/shifts/:id/float
// Records a float_in or float_out transaction during an open shift.
// Body: { type: 'float_in'|'float_out', amount, reason? }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/:id/float', async (req, res) => {
  const { id } = req.params;
  const { type, amount, reason } = req.body;

  if (!type || !amount || !['float_in', 'float_out'].includes(type)) {
    res.status(400).json({ error: 'type (float_in|float_out) and amount are required' });
    return;
  }
  if (Number(amount) <= 0) {
    res.status(400).json({ error: 'amount must be greater than zero' });
    return;
  }

  // Verify shift is open and belongs to this business
  const { data: shift, error: shiftErr } = await supabase
    .from('shifts')
    .select('id, branch_id, status')
    .eq('id', id)
    .eq('business_id', req.businessId)
    .eq('status', 'open')
    .single();

  if (shiftErr || !shift) {
    res.status(404).json({ error: 'Open shift not found' });
    return;
  }

  const { data, error } = await supabase
    .from('float_transactions')
    .insert({
      shift_id: id,
      branch_id: shift.branch_id,
      cashier_id: req.userId,
      type,
      amount: Number(amount),
      reason: reason ?? null,
    })
    .select()
    .single();

  if (error) { sendError(res, error); return; }
  res.status(201).json(data);
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/shifts
// Lists shifts for the business. Supports filters: branch_id, status, from, to.
// Enriches with cashier name (fetched separately to avoid Supabase FK join issues).
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const { branch_id, status, from, to, limit = '50' } = req.query as Record<string, string>;

  let query = supabase
    .from('shifts')
    .select('*')
    .eq('business_id', req.businessId)
    .order('opened_at', { ascending: false })
    .limit(Math.min(Number(limit), 200));

  if (branch_id) query = query.eq('branch_id', branch_id);
  if (status)    query = query.eq('status', status);
  if (from)      query = query.gte('opened_at', from);
  if (to)        query = query.lte('opened_at', to);

  const { data: shifts, error } = await query;
  if (error) { sendError(res, error); return; }

  if (!shifts?.length) { res.json([]); return; }

  // Fetch cashier names separately (avoid FK join issues on users table)
  const cashierIds = [...new Set(shifts.map(s => s.cashier_id))];
  const { data: users } = await supabase
    .from('users')
    .select('id, name')
    .in('id', cashierIds.slice(0, 500)); // bounded: max 500 cashiers per business

  const nameMap: Record<string, string> = {};
  (users ?? []).forEach(u => { nameMap[u.id] = u.name; });

  const enriched = shifts.map(s => ({
    ...s,
    cashier_name: nameMap[s.cashier_id] ?? 'Unknown',
  }));

  res.json(enriched);
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/shifts/:id
// Returns a single shift with its float transactions and order summary.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  const { id } = req.params;

  const [{ data: shift, error: sErr }, { data: floatTxns }, { data: orders }] = await Promise.all([
    supabase
      .from('shifts')
      .select('*')
      .eq('id', id)
      .eq('business_id', req.businessId)
      .single(),
    supabase
      .from('float_transactions')
      .select('*')
      .eq('shift_id', id)
      .order('created_at'),
    supabase
      .from('orders')
      .select('id, total, payment_method, created_at')
      .eq('shift_id', id)
      .eq('status', 'completed'),
  ]);

  if (sErr || !shift) { res.status(404).json({ error: 'Shift not found' }); return; }

  // Cashier name
  const { data: cashier } = await supabase
    .from('users')
    .select('name')
    .eq('id', shift.cashier_id)
    .single();

  const totalRevenue = (orders ?? []).reduce((s, o) => s + Number(o.total), 0);

  res.json({
    ...shift,
    cashier_name: cashier?.name ?? 'Unknown',
    float_transactions: floatTxns ?? [],
    order_count: (orders ?? []).length,
    total_revenue: totalRevenue,
  });
});

export default router;
