import { Router } from 'express';
import { safeRouter } from '../middleware/asyncHandler';
import { requireAuth } from '../middleware/auth';
import { requirePermission, branchScope } from '../middleware/rbac';
import { supabase } from '../lib/supabase';

const router = safeRouter();
router.use(requireAuth);

// GET /api/credit/customers — list customers with a limit or an outstanding balance (debtors first)
router.get('/customers', async (req, res) => {
  const { search } = req.query;
  let q = supabase
    .from('customers')
    .select('id, name, phone, email, credit_limit, credit_balance, status')
    .eq('business_id', req.businessId)
    .or('credit_limit.gt.0,credit_balance.gt.0')
    .order('credit_balance', { ascending: false })
    .limit(200);
  if (search) q = q.ilike('name', `%${search as string}%`);

  const { data, error } = await q;
  if (error) { res.status(500).json({ error: error.message }); return; }

  const rows = (data ?? []).map((c: any) => ({
    ...c,
    available_credit: Math.max(0, Number(c.credit_limit) - Number(c.credit_balance)),
  }));
  res.json(rows);
});

// GET /api/credit/customer/:id — one account + recent ledger
router.get('/customer/:id', async (req, res) => {
  const { data: customer, error } = await supabase
    .from('customers')
    .select('id, name, phone, email, credit_limit, credit_balance, status')
    .eq('id', req.params.id)
    .eq('business_id', req.businessId)
    .single();

  if (error || !customer) { res.status(404).json({ error: 'Customer not found' }); return; }

  const { data: ledger } = await supabase
    .from('customer_credit_transactions')
    .select('id, type, amount, balance_after, method, reference, notes, order_id, created_at')
    .eq('customer_id', req.params.id)
    .eq('business_id', req.businessId)
    .order('created_at', { ascending: false })
    .limit(100);

  res.json({
    customer: {
      ...customer,
      available_credit: Math.max(0, Number(customer.credit_limit) - Number(customer.credit_balance)),
    },
    ledger: ledger ?? [],
  });
});

// PATCH /api/credit/customer/:id/limit — set the credit limit
router.patch('/customer/:id/limit', requirePermission('customers.manage'), async (req, res) => {
  const limit = Number(req.body?.credit_limit);
  if (!Number.isFinite(limit) || limit < 0) {
    res.status(400).json({ error: 'credit_limit must be a non-negative number' });
    return;
  }

  const { data, error } = await supabase
    .from('customers')
    .update({ credit_limit: limit, updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .eq('business_id', req.businessId)
    .select('id, credit_limit, credit_balance')
    .single();

  if (error || !data) { res.status(404).json({ error: 'Customer not found' }); return; }
  res.json(data);
});

// POST /api/credit/customer/:id/payment — record a repayment (decreases balance)
// Body: { amount, method, reference?, notes? }
router.post('/customer/:id/payment', requirePermission('customers.manage'), async (req, res) => {
  const amount = Number(req.body?.amount);
  const { method, reference, notes } = req.body ?? {};
  if (!Number.isFinite(amount) || amount <= 0) {
    res.status(400).json({ error: 'amount must be a positive number' });
    return;
  }

  const { data: balance, error } = await supabase.rpc('apply_credit_transaction', {
    p_business_id:   req.businessId,
    p_customer_id:   req.params.id,
    p_branch_id:     branchScope(req) ?? null,
    p_order_id:      null,
    p_type:          'payment',
    p_amount:        -Math.abs(amount),   // repayment decreases balance
    p_method:        method ?? null,
    p_reference:     reference ?? null,
    p_notes:         notes ?? null,
    p_created_by:    req.userId,
    p_enforce_limit: false,
  });

  if (error) {
    if (error.message?.includes('CUSTOMER_NOT_FOUND')) { res.status(404).json({ error: 'Customer not found' }); return; }
    res.status(500).json({ error: error.message }); return;
  }
  res.json({ credit_balance: balance });
});

// POST /api/credit/customer/:id/adjustment — manual correction (+/-) with a reason
// Body: { amount (signed), notes }
router.post('/customer/:id/adjustment', requirePermission('customers.manage'), async (req, res) => {
  const amount = Number(req.body?.amount);
  const notes = (req.body?.notes ?? '').trim();
  if (!Number.isFinite(amount) || amount === 0) {
    res.status(400).json({ error: 'amount must be a non-zero number' });
    return;
  }
  if (!notes) { res.status(400).json({ error: 'A reason (notes) is required for an adjustment' }); return; }

  const { data: balance, error } = await supabase.rpc('apply_credit_transaction', {
    p_business_id:   req.businessId,
    p_customer_id:   req.params.id,
    p_branch_id:     branchScope(req) ?? null,
    p_order_id:      null,
    p_type:          'adjustment',
    p_amount:        amount,              // signed
    p_method:        null,
    p_reference:     null,
    p_notes:         notes,
    p_created_by:    req.userId,
    p_enforce_limit: false,               // adjustments bypass the limit by design
  });

  if (error) {
    if (error.message?.includes('CUSTOMER_NOT_FOUND')) { res.status(404).json({ error: 'Customer not found' }); return; }
    res.status(500).json({ error: error.message }); return;
  }
  res.json({ credit_balance: balance });
});

export default router;
