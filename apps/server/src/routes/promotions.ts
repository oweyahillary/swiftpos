/**
 * routes/promotions.ts
 *
 * CRUD for the promotions table + an /active endpoint the POS polls.
 *
 * GET  /api/promotions             — list all for business
 * POST /api/promotions             — create
 * PATCH /api/promotions/:id        — update
 * DELETE /api/promotions/:id       — delete
 * GET  /api/promotions/active      — returns promos applicable RIGHT NOW
 *                                    given current time + cart contents
 */

import { Router } from 'express';
import { sendError } from '../lib/sendError';
import { safeRouter } from '../middleware/asyncHandler';
import { supabase }    from '../lib/supabase';
import { requireAuth } from '../middleware/auth';

const router = safeRouter();
router.use(requireAuth);

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function isActiveNow(promo: any, now: Date): boolean {
  const dayOfWeek = now.getDay(); // 0=Sun…6=Sat
  if (!promo.days_of_week.includes(dayOfWeek)) return false;

  if (promo.start_date && new Date(promo.start_date) > now) return false;
  if (promo.end_date   && new Date(promo.end_date)   < now) return false;

  if (promo.start_time && promo.end_time) {
    const hhmm = (t: string) => {
      const [h, m] = t.split(':').map(Number);
      return h * 60 + m;
    };
    const currentMins = now.getHours() * 60 + now.getMinutes();
    if (currentMins < hhmm(promo.start_time) || currentMins > hhmm(promo.end_time)) return false;
  }

  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/promotions
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('promotions')
    .select('*')
    .eq('business_id', req.businessId)
    .order('created_at', { ascending: false });

  if (error) { sendError(res, error); return; }
  // The stored `status` is a manual flag and doesn't reflect the promo's date window.
  // Add `effective_status` so the UI can show expired/scheduled without a nightly job.
  const now = new Date();
  const withEffective = (data ?? []).map((p: any) => {
    let effective_status = p.status;
    if (p.status === 'active') {
      if (p.end_date && new Date(p.end_date) < now)        effective_status = 'expired';
      else if (p.start_date && new Date(p.start_date) > now) effective_status = 'scheduled';
    }
    return { ...p, effective_status };
  });
  res.json(withEffective);
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/promotions/active
// Called by the POS whenever the cart changes.
// Body (optional query params): product_ids, category_ids — the items in cart
// Returns promos that are active now AND match the cart contents.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/active', async (req, res) => {
  const now = new Date();

  const { data: all, error } = await supabase
    .from('promotions')
    .select('*')
    .eq('business_id', req.businessId)
    .eq('status', 'active');

  if (error) { sendError(res, error); return; }

  const cartProductIds:  string[] = ((req.query.product_ids  as string) ?? '').split(',').filter(Boolean);
  const cartCategoryIds: string[] = ((req.query.category_ids as string) ?? '').split(',').filter(Boolean);

  const active = (all ?? []).filter(p => {
    if (!isActiveNow(p, now)) return false;

    // Scope check
    if (p.applies_to === 'all') return true;
    if (p.applies_to === 'product'  && (p.product_ids  ?? []).some((id: string) => cartProductIds.includes(id)))  return true;
    if (p.applies_to === 'category' && (p.category_ids ?? []).some((id: string) => cartCategoryIds.includes(id))) return true;

    return false;
  });

  res.json(active);
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/promotions
// ─────────────────────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const {
    name, promo_type, start_date, end_date, start_time, end_time,
    days_of_week, applies_to, product_ids, category_ids,
    discount_type, discount_value, min_quantity, free_quantity,
  } = req.body;

  if (!name?.trim())  { res.status(400).json({ error: 'name is required' }); return; }
  if (!promo_type)    { res.status(400).json({ error: 'promo_type is required' }); return; }

  const { data, error } = await supabase
    .from('promotions')
    .insert({
      business_id:    req.businessId,
      name:           name.trim(),
      promo_type,
      start_date:     start_date  || null,
      end_date:       end_date    || null,
      start_time:     start_time  || null,
      end_time:       end_time    || null,
      days_of_week:   days_of_week ?? [0,1,2,3,4,5,6],
      applies_to:     applies_to  ?? 'all',
      product_ids:    product_ids  ?? [],
      category_ids:   category_ids ?? [],
      discount_type:  discount_type  || null,
      discount_value: discount_value ?? null,
      min_quantity:   min_quantity   ?? 1,
      free_quantity:  free_quantity  ?? null,
      status: 'active',
    })
    .select()
    .single();

  if (error) { sendError(res, error); return; }
  res.status(201).json(data);
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/promotions/:id
// ─────────────────────────────────────────────────────────────────────────────
router.patch('/:id', async (req, res) => {
  const allowed = [
    'name','promo_type','start_date','end_date','start_time','end_time',
    'days_of_week','applies_to','product_ids','category_ids',
    'discount_type','discount_value','min_quantity','free_quantity','status',
  ];
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }

  const { data, error } = await supabase
    .from('promotions')
    .update(updates)
    .eq('id', req.params.id)
    .eq('business_id', req.businessId)
    .select()
    .single();

  if (error) { sendError(res, error); return; }
  if (!data)  { res.status(404).json({ error: 'Promotion not found' }); return; }
  res.json(data);
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/promotions/:id
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  const { error } = await supabase
    .from('promotions')
    .delete()
    .eq('id', req.params.id)
    .eq('business_id', req.businessId);

  if (error) { sendError(res, error); return; }
  res.status(204).send();
});

export default router;
