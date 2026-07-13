import { Router } from 'express';
import { sendError } from '../lib/sendError';
import { safeRouter } from '../middleware/asyncHandler';
import { requireAuth } from '../middleware/auth';
import { supabase } from '../lib/supabase';

const router = safeRouter();
router.use(requireAuth);

// ── Modifier Groups ─────────────────────────────────────────

// GET /api/modifiers/groups?product_id=xxx
router.get('/groups', async (req, res) => {
  const { product_id } = req.query;
  if (!product_id) { res.status(400).json({ error: 'product_id required' }); return; }

  const { data: product } = await supabase
    .from('products')
    .select('id')
    .eq('id', product_id)
    .eq('business_id', req.businessId)
    .single();

  if (!product) { res.status(404).json({ error: 'Product not found' }); return; }

  const { data, error } = await supabase
    .from('modifier_groups')
    .select('*, modifier_options(*)')
    .eq('product_id', product_id)
    .order('sort_order');

  if (error) { sendError(res, error); return; }
  res.json(data);
});

// POST /api/modifiers/groups
// Body: { product_id, name, min_select, max_select, options: [{ name, price }] }
router.post('/groups', async (req, res) => {
  const { product_id, name, min_select = 0, max_select = null, options = [] } = req.body;
  if (!product_id || !name) { res.status(400).json({ error: 'product_id and name required' }); return; }

  const { data: product } = await supabase
    .from('products')
    .select('id')
    .eq('id', product_id)
    .eq('business_id', req.businessId)
    .single();

  if (!product) { res.status(404).json({ error: 'Product not found' }); return; }

  const { data: group, error: gErr } = await supabase
    .from('modifier_groups')
    .insert({ product_id, name, min_select, max_select, sort_order: 0 })
    .select()
    .single();

  if (gErr) { sendError(res, gErr); return; }

  if (options.length > 0) {
    const { error: oErr } = await supabase
      .from('modifier_options')
      .insert(options.map((o: { name: string; price: number }, i: number) => ({
        modifier_group_id: group.id,
        name: o.name,
        price: o.price ?? 0,
        sort_order: i,
      })));
    if (oErr) { sendError(res, oErr); return; }
  }

  const { data: full } = await supabase
    .from('modifier_groups')
    .select('*, modifier_options(*)')
    .eq('id', group.id)
    .single();

  await supabase.from('products').update({ has_modifiers: true }).eq('id', product_id);

  res.status(201).json(full);
});

// PATCH /api/modifiers/groups/:id
router.patch('/groups/:id', async (req, res) => {
  const { id } = req.params;
  const { name, min_select, max_select } = req.body;

  const { data: group } = await supabase
    .from('modifier_groups')
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
    .from('modifier_groups')
    .update({ name, min_select, max_select })
    .eq('id', id)
    .select()
    .single();

  if (error) { sendError(res, error); return; }
  res.json(data);
});

// DELETE /api/modifiers/groups/:id  (cascades to modifier_options)
router.delete('/groups/:id', async (req, res) => {
  const { id } = req.params;

  const { data: group } = await supabase
    .from('modifier_groups')
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

  await supabase.from('modifier_groups').delete().eq('id', id);

  const { count } = await supabase
    .from('modifier_groups')
    .select('id', { count: 'exact', head: true })
    .eq('product_id', group.product_id);

  if (count === 0) {
    await supabase.from('products').update({ has_modifiers: false }).eq('id', group.product_id);
  }

  res.status(204).send();
});

// ── Modifier Options ────────────────────────────────────────
// Ownership is verified by walking the chain:
//   modifier_option → modifier_group → product → business_id.
// Without this, any authenticated user could edit/delete another
// tenant's option rows by guessing their UUID (cross-tenant IDOR).

async function modifierGroupOwned(groupId: string, businessId: string): Promise<boolean> {
  const { data: group } = await supabase
    .from('modifier_groups').select('product_id').eq('id', groupId).single();
  if (!group) return false;
  const { data: product } = await supabase
    .from('products').select('id').eq('id', group.product_id).eq('business_id', businessId).single();
  return !!product;
}

async function modifierOptionOwned(optionId: string, businessId: string): Promise<boolean> {
  const { data: option } = await supabase
    .from('modifier_options').select('modifier_group_id').eq('id', optionId).single();
  if (!option) return false;
  return modifierGroupOwned(option.modifier_group_id, businessId);
}

// POST /api/modifiers/options
router.post('/options', async (req, res) => {
  const { modifier_group_id, name, price = 0 } = req.body;
  if (!modifier_group_id || !name) { res.status(400).json({ error: 'modifier_group_id and name required' }); return; }

  if (!(await modifierGroupOwned(modifier_group_id, req.businessId))) {
    res.status(404).json({ error: 'Modifier group not found' }); return;
  }

  const { data, error } = await supabase
    .from('modifier_options')
    .insert({ modifier_group_id, name, price, sort_order: 0 })
    .select()
    .single();

  if (error) { sendError(res, error); return; }
  res.status(201).json(data);
});

// PATCH /api/modifiers/options/:id
router.patch('/options/:id', async (req, res) => {
  const { id } = req.params;
  const { name, price } = req.body;

  if (!(await modifierOptionOwned(id, req.businessId))) {
    res.status(404).json({ error: 'Modifier option not found' }); return;
  }

  const { data, error } = await supabase
    .from('modifier_options')
    .update({ name, price })
    .eq('id', id)
    .select()
    .single();

  if (error) { sendError(res, error); return; }
  res.json(data);
});

// DELETE /api/modifiers/options/:id
router.delete('/options/:id', async (req, res) => {
  const { id } = req.params;

  if (!(await modifierOptionOwned(id, req.businessId))) {
    res.status(404).json({ error: 'Modifier option not found' }); return;
  }

  await supabase.from('modifier_options').delete().eq('id', id);
  res.status(204).send();
});

export default router;
