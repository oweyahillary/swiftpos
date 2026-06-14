import { Router } from 'express';
import { safeRouter } from '../middleware/asyncHandler';
import { requireAuth } from '../middleware/auth';
import { supabase } from '../lib/supabase';

const router = safeRouter();
router.use(requireAuth);

// ── Variant Groups ──────────────────────────────────────────

// GET /api/variants/groups?product_id=xxx
router.get('/groups', async (req, res) => {
  const { product_id } = req.query;
  if (!product_id) { res.status(400).json({ error: 'product_id required' }); return; }

  // Verify product belongs to this business
  const { data: product } = await supabase
    .from('products')
    .select('id')
    .eq('id', product_id)
    .eq('business_id', req.businessId)
    .single();

  if (!product) { res.status(404).json({ error: 'Product not found' }); return; }

  const { data, error } = await supabase
    .from('variant_groups')
    .select('*, variant_options(*)')
    .eq('product_id', product_id)
    .order('sort_order');

  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data);
});

// POST /api/variants/groups
// Body: { product_id, name, required, options: [{ name, price_adjustment }] }
router.post('/groups', async (req, res) => {
  const { product_id, name, required = false, options = [] } = req.body;
  if (!product_id || !name) { res.status(400).json({ error: 'product_id and name required' }); return; }

  // Verify ownership
  const { data: product } = await supabase
    .from('products')
    .select('id')
    .eq('id', product_id)
    .eq('business_id', req.businessId)
    .single();

  if (!product) { res.status(404).json({ error: 'Product not found' }); return; }

  const { data: group, error: gErr } = await supabase
    .from('variant_groups')
    .insert({ product_id, name, required, sort_order: 0 })
    .select()
    .single();

  if (gErr) { res.status(500).json({ error: gErr.message }); return; }

  if (options.length > 0) {
    const { error: oErr } = await supabase
      .from('variant_options')
      .insert(options.map((o: { name: string; price_adjustment: number }, i: number) => ({
        variant_group_id: group.id,
        name: o.name,
        price_adjustment: o.price_adjustment ?? 0,
        sort_order: i,
      })));
    if (oErr) { res.status(500).json({ error: oErr.message }); return; }
  }

  // Return group with options
  const { data: full } = await supabase
    .from('variant_groups')
    .select('*, variant_options(*)')
    .eq('id', group.id)
    .single();

  // Mark product as has_variants
  await supabase.from('products').update({ has_variants: true }).eq('id', product_id);

  res.status(201).json(full);
});

// PATCH /api/variants/groups/:id
router.patch('/groups/:id', async (req, res) => {
  const { id } = req.params;
  const { name, required } = req.body;

  // Verify via product → business chain
  const { data: group } = await supabase
    .from('variant_groups')
    .select('product_id')
    .eq('id', id)
    .single();

  if (!group) { res.status(404).json({ error: 'Group not found' }); return; }

  const { data: product } = await supabase
    .from('products')
    .select('id')
    .eq('id', group.product_id)
    .eq('business_id', req.businessId)
    .single();

  if (!product) { res.status(403).json({ error: 'Forbidden' }); return; }

  const { data, error } = await supabase
    .from('variant_groups')
    .update({ name, required })
    .eq('id', id)
    .select()
    .single();

  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data);
});

// DELETE /api/variants/groups/:id  (cascades to variant_options)
router.delete('/groups/:id', async (req, res) => {
  const { id } = req.params;

  const { data: group } = await supabase
    .from('variant_groups')
    .select('product_id')
    .eq('id', id)
    .single();

  if (!group) { res.status(404).json({ error: 'Group not found' }); return; }

  const { data: product } = await supabase
    .from('products')
    .select('id')
    .eq('id', group.product_id)
    .eq('business_id', req.businessId)
    .single();

  if (!product) { res.status(403).json({ error: 'Forbidden' }); return; }

  await supabase.from('variant_groups').delete().eq('id', id);

  // If no groups remain, clear the flag
  const { count } = await supabase
    .from('variant_groups')
    .select('id', { count: 'exact', head: true })
    .eq('product_id', group.product_id);

  if (count === 0) {
    await supabase.from('products').update({ has_variants: false }).eq('id', group.product_id);
  }

  res.status(204).send();
});

// ── Variant Options ─────────────────────────────────────────
// Ownership for an option is verified by walking the chain:
//   variant_option → variant_group → product → business_id.
// Without this, any authenticated user could edit/delete another
// tenant's option rows by guessing their UUID (cross-tenant IDOR).

// Returns true if the given variant group belongs to the caller's business.
async function variantGroupOwned(groupId: string, businessId: string): Promise<boolean> {
  const { data: group } = await supabase
    .from('variant_groups').select('product_id').eq('id', groupId).single();
  if (!group) return false;
  const { data: product } = await supabase
    .from('products').select('id').eq('id', group.product_id).eq('business_id', businessId).single();
  return !!product;
}

// Returns true if the given variant option belongs to the caller's business.
async function variantOptionOwned(optionId: string, businessId: string): Promise<boolean> {
  const { data: option } = await supabase
    .from('variant_options').select('variant_group_id').eq('id', optionId).single();
  if (!option) return false;
  return variantGroupOwned(option.variant_group_id, businessId);
}

// POST /api/variants/options
router.post('/options', async (req, res) => {
  const { variant_group_id, name, price_adjustment = 0 } = req.body;
  if (!variant_group_id || !name) { res.status(400).json({ error: 'variant_group_id and name required' }); return; }

  if (!(await variantGroupOwned(variant_group_id, req.businessId))) {
    res.status(404).json({ error: 'Variant group not found' }); return;
  }

  const { data, error } = await supabase
    .from('variant_options')
    .insert({ variant_group_id, name, price_adjustment, sort_order: 0 })
    .select()
    .single();

  if (error) { res.status(500).json({ error: error.message }); return; }
  res.status(201).json(data);
});

// PATCH /api/variants/options/:id
router.patch('/options/:id', async (req, res) => {
  const { id } = req.params;
  const { name, price_adjustment } = req.body;

  if (!(await variantOptionOwned(id, req.businessId))) {
    res.status(404).json({ error: 'Variant option not found' }); return;
  }

  const { data, error } = await supabase
    .from('variant_options')
    .update({ name, price_adjustment })
    .eq('id', id)
    .select()
    .single();

  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data);
});

// DELETE /api/variants/options/:id
router.delete('/options/:id', async (req, res) => {
  const { id } = req.params;

  if (!(await variantOptionOwned(id, req.businessId))) {
    res.status(404).json({ error: 'Variant option not found' }); return;
  }

  await supabase.from('variant_options').delete().eq('id', id);
  res.status(204).send();
});

export default router;
