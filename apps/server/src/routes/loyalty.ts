import { Router, Request, Response, NextFunction } from 'express';
import { safeRouter } from '../middleware/asyncHandler';
import { requireAuth } from '../middleware/auth';
import { supabase } from '../lib/supabase';

const router = safeRouter();
router.use(requireAuth);

// ── Loyalty feature flag guard ────────────────────────────────
// All routes in this file are blocked if loyalty_enabled = false for the business.
async function requireLoyalty(req: Request, res: Response, next: NextFunction) {
  const { data } = await supabase
    .from('feature_flags')
    .select('enabled')
    .eq('business_id', req.businessId)
    .eq('key', 'loyalty_enabled')
    .single();

  if (!data?.enabled) {
    res.status(403).json({ error: 'Loyalty program is not enabled for this business' });
    return;
  }
  next();
}

router.use(requireLoyalty);

// ── Tier helpers ─────────────────────────────────────────────
export function getTier(points: number): { name: string; multiplier: number; next: number | null } {
  if (points >= 5000) return { name: 'Gold',   multiplier: 2.0, next: null };
  if (points >= 1000) return { name: 'Silver', multiplier: 1.5, next: 5000 };
  return                      { name: 'Bronze', multiplier: 1.0, next: 1000 };
}

// ── Existing endpoints ────────────────────────────────────────

// GET /api/loyalty/customer?phone=07xx
router.get('/customer', async (req, res) => {
  const { phone } = req.query;
  if (!phone) { res.status(400).json({ error: 'phone is required' }); return; }

  const { data, error } = await supabase
    .from('customers')
    .select('id, name, phone, email, loyalty_points, total_spent, visit_count, notes, status, created_at, updated_at')
    .eq('business_id', req.businessId)
    .eq('phone', phone as string)
    .single();

  if (error || !data) { res.status(404).json({ error: 'Customer not found' }); return; }

  res.json({ customer: data, tier: getTier(data.loyalty_points) });
});

// POST /api/loyalty/customer
router.post('/customer', async (req, res) => {
  const { name, phone, email, notes } = req.body;
  if (!name || !phone) { res.status(400).json({ error: 'name and phone are required' }); return; }

  const { data, error } = await supabase
    .from('customers')
    .insert({ business_id: req.businessId, name, phone, email: email ?? null, notes: notes ?? null })
    .select('id, name, phone, email, loyalty_points, total_spent, visit_count, notes, status, created_at')
    .single();

  if (error) {
    if (error.code === '23505') {
      res.status(409).json({ error: 'A customer with this phone number already exists' });
    } else {
      res.status(500).json({ error: error.message });
    }
    return;
  }

  res.status(201).json({ customer: data, tier: getTier(0) });
});

// GET /api/loyalty/settings
router.get('/settings', async (req, res) => {
  const { data } = await supabase
    .from('business_settings')
    .select('value')
    .eq('business_id', req.businessId)
    .eq('key', 'loyalty_earn_rate')
    .single();

  const earnRate: number = data?.value ?? 1;
  res.json({ earnRate });
});

// GET /api/loyalty/customer/:id/transactions
router.get('/customer/:id/transactions', async (req, res) => {
  const { data, error } = await supabase
    .from('loyalty_transactions')
    .select('id, type, points, notes, created_at, order_id')
    .eq('customer_id', req.params.id)
    .eq('business_id', req.businessId)
    .order('created_at', { ascending: false })
    .limit(20);

  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ transactions: data ?? [] });
});

// ── New CRM endpoints (Step 15) ───────────────────────────────

// GET /api/loyalty/customers?search=&page=1&limit=20
// Paginated list of all customers for the CRM tab.
router.get('/customers', async (req, res) => {
  const search = (req.query.search as string ?? '').trim();
  const page   = Math.max(1, parseInt(req.query.page  as string) || 1);
  const limit  = Math.min(50, parseInt(req.query.limit as string) || 20);
  const offset = (page - 1) * limit;

  let query = supabase
    .from('customers')
    .select('id, name, phone, email, loyalty_points, total_spent, visit_count, status, created_at, updated_at', { count: 'exact' })
    .eq('business_id', req.businessId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (search) {
    // Supabase ilike filter — search name OR phone
    query = query.or(`name.ilike.%${search}%,phone.ilike.%${search}%`);
  }

  const { data, error, count } = await query;

  if (error) { res.status(500).json({ error: error.message }); return; }

  const customers = (data ?? []).map(c => ({ ...c, tier: getTier(c.loyalty_points) }));
  res.json({ customers, total: count ?? 0, page, limit });
});

// PATCH /api/loyalty/customer/:id
// Edit a customer's name, phone, email, or notes.
router.patch('/customer/:id', async (req, res) => {
  const { name, phone, email, notes, status } = req.body;

  // Build only the fields that were actually sent
  const updates: Record<string, unknown> = {};
  if (name  !== undefined) updates.name  = name;
  if (phone !== undefined) updates.phone = phone;
  if (email !== undefined) updates.email = email;
  if (notes !== undefined) updates.notes = notes;
  if (status !== undefined) updates.status = status;

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: 'No fields to update' });
    return;
  }

  const { data, error } = await supabase
    .from('customers')
    .update(updates)
    .eq('id', req.params.id)
    .eq('business_id', req.businessId)   // scoped to business for safety
    .select('id, name, phone, email, loyalty_points, total_spent, visit_count, notes, status, created_at')
    .single();

  if (error) {
    if (error.code === '23505') {
      res.status(409).json({ error: 'A customer with this phone number already exists' });
    } else {
      res.status(500).json({ error: error.message });
    }
    return;
  }

  res.json({ customer: data, tier: getTier(data.loyalty_points) });
});

// DELETE /api/loyalty/customer/:id
// Soft-delete: sets status = 'inactive'. Hard delete is intentionally avoided
// because customers are referenced by orders (ON DELETE SET NULL) and loyalty_transactions.
router.delete('/customer/:id', async (req, res) => {
  const { error } = await supabase
    .from('customers')
    .update({ status: 'inactive' })
    .eq('id', req.params.id)
    .eq('business_id', req.businessId);

  if (error) { res.status(500).json({ error: error.message }); return; }
  res.status(204).send();
});

export default router;
