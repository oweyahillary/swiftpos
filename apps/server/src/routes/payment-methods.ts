// /api/payment-methods — custom payment methods, per business (register A95 / #4).
//
// The built-in tenders (cash, M-Pesa, card) live in the POS clients; this manages
// the EXTRA ones a business defines (Coop Card, Airtel Money, …). `code` is what
// gets written to payments.method for such a sale, so it is generated once from
// the name, kept stable, and unique per business. All are non-cash for
// reconciliation (only 'cash' affects expected drawer cash), so there is no flag.
//
// Guarded like stations: settings.manage OR products.manage.

import { sendError } from '../lib/sendError';
import { safeRouter } from '../middleware/asyncHandler';
import { supabase } from '../lib/supabase';
import { requireAuth } from '../middleware/auth';
import { requireAnyPermission } from '../middleware/rbac';

const router = safeRouter();
router.use(requireAuth);

// A stable, url-safe code from the display name. Collisions inside a business are
// caught by the UNIQUE constraint and surfaced as a 409.
function toCode(name: string): string {
  return name.trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'method';
}

// GET /api/payment-methods — list this business's custom methods (all, for the
// manage screen; the POS filters to is_active itself).
router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('payment_methods')
    .select('id, name, code, is_active, sort_order')
    .eq('business_id', req.businessId)
    .order('sort_order', { ascending: true })
    .order('name', { ascending: true });
  if (error) { sendError(res, error); return; }
  res.json(data ?? []);
});

// POST /api/payment-methods — create. Body: { name, sort_order? }
router.post('/', requireAnyPermission('settings.manage', 'products.manage'), async (req, res) => {
  const name = String(req.body?.name ?? '').trim();
  if (!name) { res.status(400).json({ error: 'name is required' }); return; }

  const { data, error } = await supabase
    .from('payment_methods')
    .insert({
      business_id: req.businessId,
      name,
      code:        toCode(name),
      sort_order:  Number(req.body?.sort_order) || 0,
    })
    .select('id, name, code, is_active, sort_order')
    .single();

  if (error) {
    if ((error as { code?: string }).code === '23505') {
      res.status(409).json({ error: `A payment method like "${name}" already exists` });
      return;
    }
    sendError(res, error); return;
  }
  res.status(201).json(data);
});

// PATCH /api/payment-methods/:id — rename, reorder, or activate/deactivate.
// `code` is deliberately immutable: it is stamped on historical orders, so
// changing it would strand their reporting under a name that no longer maps.
router.patch('/:id', requireAnyPermission('settings.manage', 'products.manage'), async (req, res) => {
  const patch: Record<string, unknown> = {};
  if (typeof req.body?.name === 'string' && req.body.name.trim()) patch.name = req.body.name.trim();
  if (typeof req.body?.is_active === 'boolean') patch.is_active = req.body.is_active;
  if (req.body?.sort_order !== undefined) patch.sort_order = Number(req.body.sort_order) || 0;
  if (Object.keys(patch).length === 0) { res.status(400).json({ error: 'nothing to update' }); return; }

  const { data, error } = await supabase
    .from('payment_methods')
    .update(patch)
    .eq('id', req.params.id)
    .eq('business_id', req.businessId)   // tenant scope — never trust the path alone
    .select('id, name, code, is_active, sort_order')
    .single();
  if (error) { sendError(res, error); return; }
  if (!data) { res.status(404).json({ error: 'Payment method not found' }); return; }
  res.json(data);
});

// DELETE /api/payment-methods/:id — hard delete. Safe because payments.method is
// a free string, not an FK: past sales keep their method label regardless.
router.delete('/:id', requireAnyPermission('settings.manage', 'products.manage'), async (req, res) => {
  const { error } = await supabase
    .from('payment_methods')
    .delete()
    .eq('id', req.params.id)
    .eq('business_id', req.businessId);
  if (error) { sendError(res, error); return; }
  res.json({ success: true });
});

export default router;
