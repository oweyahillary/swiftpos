import { Router } from 'express';
import { sendError } from '../lib/sendError';
import { safeRouter } from '../middleware/asyncHandler';
import { supabase } from '../lib/supabase';
import { requireAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { CreateDiscountSchema } from '../lib/schemas';
import { requirePermission, can } from '../middleware/rbac';
import { createFailureCounter, pinKey } from '../lib/pinAttempts';   // A505

/**
 * A505: promo-code guessing. A code is a short secret meant for one customer; /apply answered "not found" as fast as it
 * was asked. 20 wrong codes in 15 minutes from one caller (their person, or the till) pauses THAT caller's code look-ups
 * for 15 minutes — far above a cashier mistyping a code or two. A right code clears the count.
 */
export const PROMO_MAX_FAILS = 20;
const promoFails = createFailureCounter({ max: PROMO_MAX_FAILS, windowMs: 15 * 60_000, lockMs: 15 * 60_000 });
export function _resetPromoAttempts(): void { promoFails.reset(); }
/** A505: a promo code matched literally — ilike treats % and _ as wildcards (a code of "%" matched any code). */
export const likeLiteral = (v: string): string => v.replace(/[\\%_]/g, (c) => '\\' + c);

const router = safeRouter();
router.use(requireAuth);

// Audit 2026-10-14: creating, editing, switching and deleting a discount were open to any signed-in user (a cashier could
// make a 100% code and use it). They need products.manage, the Menu's key (Discounts sits under Menu); the owner and '*'
// pass in rbac. Reading the list and POST /apply (the POS checking a code) stay open to every signed-in user.
const canManage = requirePermission('menu.offers');

// GET /api/discounts — list all discounts for business
// A494: the list carried every promo code — a cashier could read a code meant for one customer and use it. Someone
// without menu.offers gets only the discounts that need no code (what a POS offers on its own), active, and never a
// code; the Discounts page (menu.offers) gets everything.
router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('discounts')
    .select('*')
    .eq('business_id', req.businessId)
    .order('created_at', { ascending: false });

  if (error) { sendError(res, error); return; }
  if (can(req, 'menu.offers')) { res.json(data); return; }
  res.json(((data ?? []) as Array<Record<string, unknown>>)
    .filter((d) => !d.promo_code && d.status === 'active')
    .map(({ promo_code: _code, ...d }) => d));
});

// POST /api/discounts — create discount
router.post('/', canManage, validate(CreateDiscountSchema), async (req, res) => {
  const { name, type, value, applies_to, promo_code, min_order_value, max_uses, expires_at } = req.body;

  if (!name || !type || value === undefined) {
    res.status(400).json({ error: 'name, type, and value are required' });
    return;
  }
  if (!['percentage', 'fixed'].includes(type)) {
    res.status(400).json({ error: 'type must be percentage or fixed' });
    return;
  }
  if (type === 'percentage' && (value <= 0 || value > 100)) {
    res.status(400).json({ error: 'Percentage discount must be between 1 and 100' });
    return;
  }

  const { data, error } = await supabase
    .from('discounts')
    .insert({
      business_id: req.businessId,
      name,
      type,
      value,
      applies_to: applies_to ?? 'order',
      promo_code: promo_code || null,
      min_order_value: min_order_value ?? 0,
      max_uses: max_uses || null,
      used_count: 0,
      expires_at: expires_at || null,
      status: 'active',
    })
    .select()
    .single();

  if (error) {
    // Unique constraint on promo_code
    if (error.code === '23505') {
      res.status(409).json({ error: 'Promo code already exists' });
      return;
    }
    sendError(res, error);
    return;
  }
  res.status(201).json(data);
});

// PUT /api/discounts/:id — update discount
router.put('/:id', canManage, async (req, res) => {
  const body = (req.body ?? {}) as Record<string, any>;
  const { name, type, value, applies_to, promo_code, min_order_value, max_uses, expires_at, status } = body;
  // The create rules hold for an edit too (an edit could turn a 10% code into 1000%).
  if (type !== undefined && !['percentage', 'fixed'].includes(type)) {
    res.status(400).json({ error: 'type must be percentage or fixed' });
    return;
  }
  if (value !== undefined && !(typeof value === 'number' && Number.isFinite(value) && value > 0)) {
    res.status(400).json({ error: 'value must be a number greater than 0' });
    return;
  }
  // A494: the value is checked against the type it will HAVE — the new one, else the stored one. Sending only
  // { value: 500 } to a percentage discount made it 500%; sending only { type: 'percentage' } to a fixed 500 did too.
  const { data: cur } = await supabase.from('discounts').select('type, value')
    .eq('id', req.params.id).eq('business_id', req.businessId).maybeSingle();
  if (!cur) { res.status(404).json({ error: 'Discount not found' }); return; }
  const effType = type ?? (cur as { type: string }).type;
  const effValue = value ?? Number((cur as { value: unknown }).value);
  if (effType === 'percentage' && !(effValue > 0 && effValue <= 100)) {
    res.status(400).json({ error: 'Percentage discount must be between 1 and 100' });
    return;
  }

  // A494: only what was SENT changes. Absent fields used to be written as blank — an edit of the name alone cleared
  // the promo code (turning a code-only discount into one anyone could apply), the minimum order, the usage cap and
  // the expiry. A field sent as null / '' still clears it.
  const updates: Record<string, unknown> = {};
  if (name !== undefined) updates.name = name;
  if (type !== undefined) updates.type = type;
  if (value !== undefined) updates.value = value;
  if (applies_to !== undefined) updates.applies_to = applies_to;
  if ('promo_code' in body) updates.promo_code = promo_code || null;
  if ('min_order_value' in body) updates.min_order_value = min_order_value ?? 0;
  if ('max_uses' in body) updates.max_uses = max_uses || null;
  if ('expires_at' in body) updates.expires_at = expires_at || null;
  if (status !== undefined) updates.status = status;
  if (!Object.keys(updates).length) { res.status(400).json({ error: 'Nothing to change' }); return; }

  const { data, error } = await supabase
    .from('discounts')
    .update(updates)
    .eq('id', req.params.id)
    .eq('business_id', req.businessId)
    .select()
    .single();

  if (error) {
    if (error.code === '23505') {
      res.status(409).json({ error: 'Promo code already exists' });
      return;
    }
    sendError(res, error);
    return;
  }
  res.json(data);
});

// PATCH /api/discounts/:id/toggle — activate / deactivate
router.patch('/:id/toggle', canManage, async (req, res) => {
  const { data: current } = await supabase
    .from('discounts')
    .select('status')
    .eq('id', req.params.id)
    .eq('business_id', req.businessId)
    .single();

  if (!current) { res.status(404).json({ error: 'Discount not found' }); return; }

  const newStatus = current.status === 'active' ? 'inactive' : 'active';

  const { data, error } = await supabase
    .from('discounts')
    .update({ status: newStatus })
    .eq('id', req.params.id)
    .eq('business_id', req.businessId)
    .select()
    .single();

  if (error) { sendError(res, error); return; }
  res.json(data);
});

// DELETE /api/discounts/:id
router.delete('/:id', canManage, async (req, res) => {
  const { error } = await supabase
    .from('discounts')
    .delete()
    .eq('id', req.params.id)
    .eq('business_id', req.businessId);

  if (error) { sendError(res, error); return; }
  res.json({ success: true });
});

// POST /api/discounts/apply — validate and apply a discount at POS
// Body: { code?, discount_id?, order_total }
// Returns: { discount, discount_amount }
// A490: giving a discount is sales.discount (everyone held it before migration 134 — OPEN_BEFORE_A490).
// A595 (docs/PERMISSIONS-AUDIT.md F16): a set-up discount or promo code is its own part of sales.discount
// (sales.discount_preset — migration 176 gave it to every holder); typing an amount stays sales.discount.
router.post('/apply', requirePermission('sales.discount_preset'), async (req, res) => {
  const { code, discount_id, order_total } = req.body;

  if (!order_total || order_total <= 0) {
    res.status(400).json({ error: 'order_total is required' });
    return;
  }

  let query = supabase
    .from('discounts')
    .select('*')
    .eq('business_id', req.businessId)
    .eq('status', 'active');

  const promoKey = code ? `${pinKey(req as any)}|promo` : '';
  if (code && promoFails.locked(promoKey)) {
    res.status(429).json({ error: 'Too many wrong promo codes — try again in 15 minutes.', code: 'PROMO_LOCKED' });
    return;
  }
  if (code) {
    query = query.ilike('promo_code', likeLiteral(String(code).trim()));   // A505: literal, no wildcards
  } else if (discount_id) {
    query = query.eq('id', discount_id);
  } else {
    res.status(400).json({ error: 'code or discount_id is required' });
    return;
  }

  const { data: discount, error } = await query.single();

  // A505: and the code must BE the discount's code (case aside) — PostgREST reads * in a filter value as a wildcard too.
  const exact = !code || (!!discount && String(discount.promo_code ?? '').trim().toLowerCase() === String(code).trim().toLowerCase());
  if (error || !discount || !exact) {
    if (code) promoFails.fail(promoKey);   // A505
    res.status(404).json({ error: 'Discount not found or inactive' });
    return;
  }
  if (code) promoFails.succeed(promoKey);
  // A494: a code-only discount is applied with its CODE — by its id alone, anyone who learnt the id (or guessed it
  // from an old list) skipped the code.
  if (!code && discount.promo_code) {
    res.status(404).json({ error: 'Discount not found or inactive' });
    return;
  }

  // Check expiry
  if (discount.expires_at && new Date(discount.expires_at) < new Date()) {
    res.status(400).json({ error: 'This discount has expired' });
    return;
  }

  // Check usage limit
  if (discount.max_uses !== null && discount.used_count >= discount.max_uses) {
    res.status(400).json({ error: 'This discount has reached its usage limit' });
    return;
  }

  // Check minimum order value.
  //
  // Number() on both sides (audit C7): min_order_value is `numeric` and arrives
  // as a STRING, so this was a lexicographic comparison. "500" < "1000" is
  // false — a KES 500 order cleared a KES 1,000 floor — while "90" < "1000" is
  // true. The floor held or failed depending on how the digits sorted, which is
  // the operator's money either way.
  if (Number(order_total) < Number(discount.min_order_value)) {
    res.status(400).json({
      error: `Minimum order value for this discount is ${discount.min_order_value}`,
    });
    return;
  }

  // Calculate discount amount
  let discount_amount = 0;
  if (discount.type === 'percentage') {
    discount_amount = parseFloat(((order_total * discount.value) / 100).toFixed(2));
  } else {
    discount_amount = Math.min(discount.value, order_total);
  }

  res.json({ discount, discount_amount });
});

export default router;
