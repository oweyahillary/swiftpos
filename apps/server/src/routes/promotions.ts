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
 *
 * A518: a promotion saved from the page (applies_at_sale) is CHARGED at the sale — sent to the tills and the web POS as an
 * offer with pos/init and rechecked by the cloud (lib/promotionOffers.ts). The list says per promotion whether it is.
 */

import { Router } from 'express';
import { sendError } from '../lib/sendError';
import { safeRouter } from '../middleware/asyncHandler';
import { supabase }    from '../lib/supabase';
import { requireAuth } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';
import { promotionChargeable } from '../lib/promotionOffers';   // A518

const router = safeRouter();
router.use(requireAuth);

// Audit 2026-10-14: create / edit / delete were open to any signed-in user. They need products.manage (the Menu's key —
// a promotion prices the menu); the owner and '*' pass in rbac. Reads stay open (the POS polls /active).
// A494: a promotion has no branch — it runs at EVERY branch (the table has no branch column), so menu.offers (a manager
// has it by default, for their own branch's offers) is not enough to create, change or delete one.
// A502 (owner, 2026-10-15: "yes leave to owner but should be a right a user can be assigned"): its own permission,
// menu.promotions, which no role starts with — the owner's until the owner gives it to someone. A manager's own-branch
// deal is an offer (/api/offers).
const canManage = requirePermission('menu.promotions');

/** Every product / category a promotion names must be this business's — null when they are, else the refusal. */
async function foreignIds(businessId: string, body: Record<string, unknown>): Promise<string | null> {
  for (const [field, table] of [['product_ids', 'products'], ['category_ids', 'categories']] as const) {
    const v = body[field];
    if (v === undefined || v === null) continue;
    if (!Array.isArray(v) || v.some((id) => typeof id !== 'string')) return `${field} must be a list of ids`;
    const ids = [...new Set(v as string[])];
    if (!ids.length) continue;
    if (ids.length > 1000) return `too many ${field}`;
    const { data, error } = await supabase.from(table).select('id').eq('business_id', businessId).in('id', ids);
    if (error) return 'Could not check the items this promotion names';
    if ((data ?? []).length !== ids.length) return `${field} names something that is not this business's`;
  }
  return null;
}

/**
 * A518: what a promotion is for. 'product' needs its products, 'category' its categories (the page's picker); the list the
 * scope does not use is emptied, so a promotion never carries ids it does not apply to. null = fine, else the refusal.
 * `current` is the stored row on an edit (a change of products alone keeps its scope).
 */
export function scopeProblem(body: Record<string, any>, current?: { applies_to?: string | null; product_ids?: string[] | null; category_ids?: string[] | null } | null): string | null {
  const touches = body.applies_to !== undefined || body.product_ids !== undefined || body.category_ids !== undefined;
  if (!touches) return null;
  const to = body.applies_to ?? current?.applies_to ?? 'all';
  if (!['all', 'product', 'category'].includes(to)) return 'applies_to must be all, product or category';
  const products = (body.product_ids ?? current?.product_ids ?? []) as string[];
  const categories = (body.category_ids ?? current?.category_ids ?? []) as string[];
  if (to === 'product' && !(Array.isArray(products) && products.length)) return 'Choose the products this promotion is for.';
  if (to === 'category' && !(Array.isArray(categories) && categories.length)) return 'Choose the categories this promotion is for.';
  body.applies_to = to;
  body.product_ids = to === 'product' ? [...new Set(products)] : [];
  body.category_ids = to === 'category' ? [...new Set(categories)] : [];
  return null;
}

/** A518: the promotion as the page lists it — with whether it is charged at the sale, and if not, why. */
function withCharge(p: any) {
  const why = p.applies_at_sale !== true
    ? 'Saved before promotions were charged at the POS - open it and save to start charging it.'
    : promotionChargeable(p);
  return { ...p, charged_at_sale: p.status === 'active' && !why, not_charged_reason: why };
}

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
    return withCharge({ ...p, effective_status });   // A518
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
router.post('/', canManage, async (req, res) => {
  const {
    name, promo_type, start_date, end_date, start_time, end_time,
    days_of_week, applies_to, product_ids, category_ids,
    discount_type, discount_value, min_quantity, free_quantity,
  } = req.body;

  if (!name?.trim())  { res.status(400).json({ error: 'name is required' }); return; }
  if (!promo_type)    { res.status(400).json({ error: 'promo_type is required' }); return; }
  const foreign = await foreignIds(req.businessId, req.body ?? {});
  if (foreign) { res.status(400).json({ error: foreign }); return; }
  const body = { applies_to, product_ids, category_ids } as Record<string, any>;   // A518: the scope, checked and tidied
  if (applies_to === undefined) body.applies_to = 'all';
  const scope = scopeProblem(body);
  if (scope) { res.status(400).json({ error: scope }); return; }

  // A518: until migration 144 is applied (the production migrate job runs as the cloud deploys — no order between them)
  // a save without the new column still goes through; the promotion is simply not charged until it is saved again.
  const row: Record<string, unknown> = {
      business_id:    req.businessId,
      name:           name.trim(),
      promo_type,
      start_date:     start_date  || null,
      end_date:       end_date    || null,
      start_time:     start_time  || null,
      end_time:       end_time    || null,
      days_of_week:   days_of_week ?? [0,1,2,3,4,5,6],
      applies_to:     body.applies_to,
      product_ids:    body.product_ids,
      category_ids:   body.category_ids,
      applies_at_sale: true,   // A518: charged at the sale (migration 144)
      discount_type:  discount_type  || null,
      discount_value: discount_value ?? null,
      min_quantity:   min_quantity   ?? 1,
      free_quantity:  free_quantity  ?? null,
      status: 'active',
  };
  let { data, error } = await supabase.from('promotions').insert(row).select().single();
  if (error && missingChargeColumn(error)) {
    delete row.applies_at_sale;
    ({ data, error } = await supabase.from('promotions').insert(row).select().single());
  }

  if (error) { sendError(res, error); return; }
  res.status(201).json(withCharge(data));
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/promotions/:id
// ─────────────────────────────────────────────────────────────────────────────
/** A518: the database does not have promotions.applies_at_sale yet (migration 144 not applied). */
function missingChargeColumn(e: { code?: string; message?: string } | null): boolean {
  return !!e && (e.code === 'PGRST204' || e.code === '42703') && /applies_at_sale/.test(String(e.message ?? ''));
}

router.patch('/:id', canManage, async (req, res) => {
  const allowed = [
    'name','promo_type','start_date','end_date','start_time','end_time',
    'days_of_week','applies_to','product_ids','category_ids',
    'discount_type','discount_value','min_quantity','free_quantity','status',
  ];
  const foreign = await foreignIds(req.businessId, req.body ?? {});
  if (foreign) { res.status(400).json({ error: foreign }); return; }
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }
  // A518: the scope checked against the stored row; a save from the page (it sends applies_at_sale) starts charging it.
  if (updates.applies_to !== undefined || updates.product_ids !== undefined || updates.category_ids !== undefined) {
    const { data: current } = await supabase.from('promotions').select('applies_to, product_ids, category_ids')
      .eq('id', req.params.id).eq('business_id', req.businessId).maybeSingle();
    if (!current) { res.status(404).json({ error: 'Promotion not found' }); return; }
    const scope = scopeProblem(updates as Record<string, any>, current as any);
    if (scope) { res.status(400).json({ error: scope }); return; }
  }
  if (req.body.applies_at_sale === true) updates.applies_at_sale = true;

  const save = () => supabase.from('promotions').update(updates).eq('id', req.params.id).eq('business_id', req.businessId).select().single();
  let { data, error } = await save();
  if (error && 'applies_at_sale' in updates && missingChargeColumn(error)) {   // A518: before migration 144 (as on create)
    delete updates.applies_at_sale;
    ({ data, error } = await save());
  }

  if (error) { sendError(res, error); return; }
  if (!data)  { res.status(404).json({ error: 'Promotion not found' }); return; }
  res.json(withCharge(data));
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/promotions/:id
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/:id', canManage, async (req, res) => {
  const { error } = await supabase
    .from('promotions')
    .delete()
    .eq('id', req.params.id)
    .eq('business_id', req.businessId);

  if (error) { sendError(res, error); return; }
  res.status(204).send();
});

export default router;
