import { Router, Request, Response, NextFunction } from 'express';
import { sendError } from '../lib/sendError';
import { safeRouter } from '../middleware/asyncHandler';
import { requireAuth } from '../middleware/auth';
import { requirePermission, requireAnyPermission, branchFilter, byBranch } from '../middleware/rbac';
import { supabase } from '../lib/supabase';
import { maskContacts, seesCustomerContacts, customerSearchFilter, isMasked, cleanKraPin } from '../lib/personalData';   // A595

const router = safeRouter();
router.use(requireAuth);

// Audit 2026-10-14: editing and deactivating a customer were open to any signed-in user. They need customers.manage (the
// credit routes' key); the owner and '*' pass in rbac. Adding a customer stays the POS's (the Loyalty panel looks a
// customer up and adds them: customers.view) or a customers.manage holder's.
// Reads stay scoped to the business. (There is no loyalty-settings write route here.)
const canManageCustomers = requirePermission('customers.edit');
// A494: the customer list, a customer's points history and their purchase analytics were open to every signed-in
// user — customers.view. GET /customer?phone= (one exact phone number, the POS's Loyalty panel) stays open: it answers
// only for a number the cashier already has, and a till must find the customer at the counter.
const canViewCustomers = requirePermission('customers.view');
// A595 (docs/PERMISSIONS-AUDIT.md F1): what a customer bought is its own part of customers.view (customers.history), and
// removing a customer of customers.edit (customers.delete) — migration 176 gave both to every holder of the parent.
const canSeeHistory = requirePermission('customers.history');
const canDeleteCustomers = requirePermission('customers.delete');
/** A595 (D1): migration 177 adds customers.kra_pin — until it has run, the reads and writes go on without it. */
let kraColumn = true;
const kraMissing = (e: unknown): boolean => {
  if (e && /kra_pin/.test(String((e as { message?: unknown }).message ?? ''))) { kraColumn = false; return true; }
  return false;
};
const KRA = (): string => (kraColumn ? ', kra_pin' : '');
/** A595: an answer about customers, phones and e-mails masked unless the caller holds customers.contacts. */
const shown = <T>(req: Request, body: T, keepPhone?: string | null): T => (seesCustomerContacts(req) ? body : maskContacts(body, { keepPhone }));

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

  const read = () => supabase
    .from('customers')
    .select(`id, name, phone, email${KRA()}, loyalty_points, total_spent, visit_count, notes, status, created_at, updated_at`)
    .eq('business_id', req.businessId)
    .eq('phone', phone as string)
    .single();
  let { data, error } = (await read()) as { data: any; error: any };
  if (kraMissing(error)) ({ data, error } = (await read()) as { data: any; error: any });

  if (error || !data) { res.status(404).json({ error: 'Customer not found' }); return; }

  // A595: the number the cashier typed stays as typed (the POS puts it on the sale); the e-mail is masked without
  // customers.contacts.
  res.json(shown(req, { customer: data, tier: getTier(data.loyalty_points) }, String(phone)));
});

// POST /api/loyalty/customer
router.post('/customer', requireAnyPermission('customers.edit', 'customers.view'), async (req, res) => {
  const { name, phone, email, notes } = req.body;
  if (!name || !phone) { res.status(400).json({ error: 'name and phone are required' }); return; }
  // A595 (owner, 2026-10-27, D1): the customer's KRA PIN is taken when they are added (a letter, 9 digits, a letter).
  const kra = cleanKraPin(req.body?.kra_pin);
  if (kra.ok === false) { res.status(400).json({ error: kra.error, code: 'BAD_KRA_PIN' }); return; }

  const add = () => supabase
    .from('customers')
    .insert({ business_id: req.businessId, name, phone, email: email ?? null, notes: notes ?? null, ...(kra.value && kraColumn ? { kra_pin: kra.value } : {}) })
    .select(`id, name, phone, email${KRA()}, loyalty_points, total_spent, visit_count, notes, status, created_at`)
    .single();
  let { data, error } = (await add()) as { data: any; error: any };
  if (kraMissing(error)) ({ data, error } = (await add()) as { data: any; error: any });

  if (error) {
    if (error.code === '23505') {
      res.status(409).json({ error: 'A customer with this phone number already exists' });
    } else {
      sendError(res, error);
    }
    return;
  }

  res.status(201).json(shown(req, { customer: data, tier: getTier(0) }, String(phone)));
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
router.get('/customer/:id/transactions', canSeeHistory, async (req, res) => {
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
router.get('/customer/:id/insights', canSeeHistory, async (req, res) => {
  let q = supabase
    .from('orders')
    .select('id, total, created_at, order_items ( product_name, quantity, subtotal )')
    .eq('business_id', req.businessId)
    .eq('customer_id', req.params.id)
    .eq('status', 'completed')
    .order('created_at', { ascending: false })
    .limit(500);
  // A582: a partner's "All my branches" — the customer's purchases at their branches only (business-wide for everyone else)
  const f = branchFilter(req);
  if (f.kind === 'set') q = byBranch(q, f);
  const { data, error } = await q;

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
router.get('/customers', canViewCustomers, async (req, res) => {
  const search = (req.query.search as string ?? '').trim();
  const page   = Math.max(1, parseInt(req.query.page  as string) || 1);
  const limit  = Math.min(50, parseInt(req.query.limit as string) || 20);
  const offset = (page - 1) * limit;

  const listQuery = () => supabase
    .from('customers')
    .select(`id, name, phone, email${KRA()}, loyalty_points, total_spent, visit_count, status, created_at, updated_at`, { count: 'exact' })
    .eq('business_id', req.businessId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  // A595: the search is one quoted PostgREST literal (lib/personalData.ts customerSearchFilter) — it was pasted in raw, so a
  // comma or a bracket added filter terms; and without customers.contacts a phone matches only when typed in full.
  const filter = customerSearchFilter(search, seesCustomerContacts(req));
  const run = () => { const q0 = listQuery(); return filter ? q0.or(filter) : q0; };
  let { data, error, count } = (await run()) as { data: any[] | null; error: any; count: number | null };
  if (kraMissing(error)) ({ data, error, count } = (await run()) as { data: any[] | null; error: any; count: number | null });

  if (error) { sendError(res, error); return; }

  const customers = (data ?? []).map(c => ({ ...c, tier: getTier(c.loyalty_points) }));
  res.json(shown(req, { customers, total: count ?? 0, page, limit }));
});

// PATCH /api/loyalty/customer/:id
// Edit a customer's name, phone, email, or notes.
router.patch('/customer/:id', canManageCustomers, async (req, res) => {
  const { name, phone, email, notes, status } = req.body;

  // Build only the fields that were actually sent
  const updates: Record<string, unknown> = {};
  if (name  !== undefined) updates.name  = name;
  // A595: a phone number or e-mail is changed only by someone who may see them (customers.contacts) — never over the real
  // one with what a form was shown (masked), and never by someone who cannot see what they replace.
  const contactsOk = seesCustomerContacts(req);
  if (phone !== undefined && contactsOk && !isMasked(phone)) updates.phone = phone;
  if (email !== undefined && contactsOk && !isMasked(email)) updates.email = email;
  // A595 D1: the KRA PIN as the phone — with customers.contacts, never a masked value; checked.
  if (req.body?.kra_pin !== undefined && contactsOk && !isMasked(req.body.kra_pin)) {
    const kra = cleanKraPin(req.body.kra_pin);
    if (kra.ok === false) { res.status(400).json({ error: kra.error, code: 'BAD_KRA_PIN' }); return; }
    updates.kra_pin = kra.value;
  }
  if (notes !== undefined) updates.notes = notes;
  if (status !== undefined) updates.status = status;

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: 'No fields to update' });
    return;
  }

  const save = () => supabase
    .from('customers')
    .update(updates)
    .eq('id', req.params.id)
    .eq('business_id', req.businessId)   // scoped to business for safety
    .select(`id, name, phone, email${KRA()}, loyalty_points, total_spent, visit_count, notes, status, created_at`)
    .single();
  let { data, error } = (await save()) as { data: any; error: any };
  if (kraMissing(error)) { delete updates.kra_pin; ({ data, error } = (await save()) as { data: any; error: any }); }

  if (error) {
    if (error.code === '23505') {
      res.status(409).json({ error: 'A customer with this phone number already exists' });
    } else {
      sendError(res, error);
    }
    return;
  }

  res.json(shown(req, { customer: data, tier: getTier(data.loyalty_points) }));
});

// DELETE /api/loyalty/customer/:id
// Soft-delete: sets status = 'inactive'. Hard delete is intentionally avoided
// because customers are referenced by orders (ON DELETE SET NULL) and loyalty_transactions.
router.delete('/customer/:id', canDeleteCustomers, async (req, res) => {
  const { error } = await supabase
    .from('customers')
    .update({ status: 'inactive' })
    .eq('id', req.params.id)
    .eq('business_id', req.businessId);

  if (error) { sendError(res, error); return; }
  res.status(204).send();
});

export default router;
