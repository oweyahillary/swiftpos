import { Router } from 'express';
import { sendError } from '../lib/sendError';
import { safeRouter } from '../middleware/asyncHandler';
import { supabase } from '../lib/supabase';
import { requireAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { CreateDiscountSchema } from '../lib/schemas';

const router = safeRouter();
router.use(requireAuth);

// GET /api/discounts — list all discounts for business
router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('discounts')
    .select('*')
    .eq('business_id', req.businessId)
    .order('created_at', { ascending: false });

  if (error) { sendError(res, error); return; }
  res.json(data);
});

// POST /api/discounts — create discount
router.post('/', validate(CreateDiscountSchema), async (req, res) => {
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
router.put('/:id', async (req, res) => {
  const { name, type, value, applies_to, promo_code, min_order_value, max_uses, expires_at, status } = req.body;

  const { data, error } = await supabase
    .from('discounts')
    .update({
      name, type, value, applies_to,
      promo_code: promo_code || null,
      min_order_value: min_order_value ?? 0,
      max_uses: max_uses || null,
      expires_at: expires_at || null,
      status,
    })
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
router.patch('/:id/toggle', async (req, res) => {
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
router.delete('/:id', async (req, res) => {
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
router.post('/apply', async (req, res) => {
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

  if (code) {
    query = query.ilike('promo_code', code.trim());
  } else if (discount_id) {
    query = query.eq('id', discount_id);
  } else {
    res.status(400).json({ error: 'code or discount_id is required' });
    return;
  }

  const { data: discount, error } = await query.single();

  if (error || !discount) {
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

  // Check minimum order value
  if (order_total < discount.min_order_value) {
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
