import { Router, Request, Response, NextFunction } from 'express';
import { sendError } from '../lib/sendError';
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

// Basic customer CRUD (create / list / edit / delete / lookup / history) works
// without the loyalty program — a business can keep simple contact records. Only
// loyalty-specific routes (settings, points, tiers) require loyalty_enabled, and
// they attach `requireLoyalty` individually.

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
      sendError(res, error);
    }
    return;
  }

  res.status(201).json({ customer: data, tier: getTier(0) });
});

// GET /api/loyalty/settings
router.get('/settings', requireLoyalty, async (req, res) => {
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

  if (error) { sendError(res, error); return; }
  res.json({ transactions: data ?? [] });
});

// GET /api/loyalty/customer/:id/insights
// Per-customer purchase analytics: spend summary, most-bought items, and a
// monthly spend trend. Business-wide (a customer's whole relationship, across
// branches) — customer analytics is about the person, not one till.
router.get('/customer/:id/insights', async (req, res) => {
  const { data, error } = await supabase
    .from('orders')
    .select('id, total, created_at, order_items ( product_name, quantity, subtotal )')
    .eq('business_id', req.businessId)
    .eq('customer_id', req.params.id)
    .eq('status', 'completed')
    .order('created_at', { ascending: false })
    .limit(500);

  if (error) { sendError(res, error); return; }

  const orders = (data ?? []) as Array<{
    total: number; created_at: string;
    order_items: Array<{ product_name: string; quantity: number; subtotal: number }> | null;
  }>;

  const orderCount = orders.length;
  const totalSpent = orders.reduce((s, o) => s + Number(o.total || 0), 0);
  const avgOrder   = orderCount ? totalSpent / orderCount : 0;
  const dates      = orders.map(o => o.created_at).filter(Boolean).sort();
  const firstOrder = dates[0] ?? null;
  const lastOrder  = dates[dates.length - 1] ?? null;
  const daysSinceLast = lastOrder
    ? Math.floor((Date.now() - new Date(lastOrder).getTime()) / 86_400_000)
    : null;

  // Most-bought items (by quantity, with spend alongside).
  const itemMap = new Map<string, { name: string; qty: number; spent: number }>();
  for (const o of orders) {
    for (const it of (o.order_items ?? [])) {
      const name = it.product_name ?? 'Unknown';
      const cur  = itemMap.get(name) ?? { name, qty: 0, spent: 0 };
      cur.qty   += Number(it.quantity || 0);
      cur.spent += Number(it.subtotal || 0);
      itemMap.set(name, cur);
    }
  }
  const topItems = [...itemMap.values()].sort((a, b) => b.qty - a.qty).slice(0, 8);

  // Monthly spend trend (last 6 months that have activity).
  const monthMap = new Map<string, { month: string; spent: number; orders: number }>();
  for (const o of orders) {
    if (!o.created_at) continue;
    const month = o.created_at.slice(0, 7); // YYYY-MM
    const cur   = monthMap.get(month) ?? { month, spent: 0, orders: 0 };
    cur.spent  += Number(o.total || 0);
    cur.orders += 1;
    monthMap.set(month, cur);
  }
  const monthly = [...monthMap.values()].sort((a, b) => a.month.localeCompare(b.month)).slice(-6);

  res.json({
    summary: { orders: orderCount, totalSpent, avgOrder, firstOrder, lastOrder, daysSinceLast },
    topItems,
    monthly,
  });
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

  if (error) { sendError(res, error); return; }

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
      sendError(res, error);
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

  if (error) { sendError(res, error); return; }
  res.status(204).send();
});

export default router;
