/**
 * routes/combos.ts
 * Combo / Set Meal builder
 *
 * A combo is a product with is_combo=true. Its items are stored in combo_items.
 *
 * GET  /api/combos              — list all combos for business
 * POST /api/combos              — create combo + items
 * GET  /api/combos/:id          — get combo with items
 * PATCH /api/combos/:id         — update name/price/status
 * PUT  /api/combos/:id/items    — replace all items
 * DELETE /api/combos/:id        — delete combo
 */

import { Router } from 'express';
import { safeRouter } from '../middleware/asyncHandler';
import { supabase }    from '../lib/supabase';
import { requireAuth } from '../middleware/auth';

const router = safeRouter();
router.use(requireAuth);

// ── List all combos ───────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('products')
    .select(`
      id, name, description, price, combo_price, status, image_url,
      combo_items (
        id, quantity, sort_order,
        product:product_id ( id, name, price, image_url )
      )
    `)
    .eq('business_id', req.businessId)
    .eq('is_combo', true)
    .order('name');

  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data ?? []);
});

// ── Get single combo ──────────────────────────────────────────────────────────

router.get('/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('products')
    .select(`
      id, name, description, price, combo_price, status, image_url,
      combo_items (
        id, quantity, sort_order,
        product:product_id ( id, name, price, image_url )
      )
    `)
    .eq('id', req.params.id)
    .eq('business_id', req.businessId)
    .eq('is_combo', true)
    .single();

  if (error || !data) { res.status(404).json({ error: 'Combo not found' }); return; }
  res.json(data);
});

// ── Create combo ──────────────────────────────────────────────────────────────

router.post('/', async (req, res) => {
  const { name, description, combo_price, category_id, items = [] } = req.body;

  if (!name?.trim())  { res.status(400).json({ error: 'name is required' }); return; }
  if (!combo_price || Number(combo_price) <= 0) {
    res.status(400).json({ error: 'combo_price is required' }); return;
  }

  // Create the product record with is_combo=true
  const { data: product, error: pErr } = await supabase
    .from('products')
    .insert({
      business_id:  req.businessId,
      name:         name.trim(),
      description:  description?.trim() || null,
      price:        Number(combo_price),
      combo_price:  Number(combo_price),
      is_combo:     true,
      category_id:  category_id || null,
      status:       'active',
    })
    .select('id')
    .single();

  if (pErr) { res.status(500).json({ error: pErr.message }); return; }

  // Insert combo items
  if (items.length > 0) {
    const { error: iErr } = await supabase
      .from('combo_items')
      .insert(
        items.map((item: { product_id: string; quantity?: number }, i: number) => ({
          combo_id:   product.id,
          product_id: item.product_id,
          quantity:   item.quantity ?? 1,
          sort_order: i,
        }))
      );
    if (iErr) { res.status(500).json({ error: iErr.message }); return; }
  }

  // Return full combo
  const { data: full } = await supabase
    .from('products')
    .select(`id, name, description, price, combo_price, status,
      combo_items(id, quantity, sort_order, product:product_id(id, name, price))`)
    .eq('id', product.id)
    .single();

  res.status(201).json(full);
});

// ── Update combo ──────────────────────────────────────────────────────────────

router.patch('/:id', async (req, res) => {
  const { name, description, combo_price, status } = req.body;
  const updates: Record<string, unknown> = {};
  if (name        !== undefined) { updates.name = name.trim(); }
  if (description !== undefined) { updates.description = description; }
  if (combo_price !== undefined) { updates.combo_price = Number(combo_price); updates.price = Number(combo_price); }
  if (status      !== undefined) { updates.status = status; }

  const { data, error } = await supabase
    .from('products')
    .update(updates)
    .eq('id', req.params.id)
    .eq('business_id', req.businessId)
    .eq('is_combo', true)
    .select('id, name, combo_price, status')
    .single();

  if (error || !data) { res.status(404).json({ error: 'Combo not found' }); return; }
  res.json(data);
});

// ── Replace all items ─────────────────────────────────────────────────────────

router.put('/:id/items', async (req, res) => {
  const { items = [] } = req.body;

  // Verify ownership
  const { data: product } = await supabase
    .from('products')
    .select('id')
    .eq('id', req.params.id)
    .eq('business_id', req.businessId)
    .eq('is_combo', true)
    .single();

  if (!product) { res.status(404).json({ error: 'Combo not found' }); return; }

  await supabase.from('combo_items').delete().eq('combo_id', req.params.id);

  if (items.length > 0) {
    await supabase.from('combo_items').insert(
      items.map((item: { product_id: string; quantity?: number }, i: number) => ({
        combo_id:   req.params.id,
        product_id: item.product_id,
        quantity:   item.quantity ?? 1,
        sort_order: i,
      }))
    );
  }

  const { data: full } = await supabase
    .from('products')
    .select(`id, name, combo_price, status,
      combo_items(id, quantity, sort_order, product:product_id(id, name, price))`)
    .eq('id', req.params.id)
    .single();

  res.json(full);
});

// ── Delete combo ──────────────────────────────────────────────────────────────

router.delete('/:id', async (req, res) => {
  const { error } = await supabase
    .from('products')
    .delete()
    .eq('id', req.params.id)
    .eq('business_id', req.businessId)
    .eq('is_combo', true);

  if (error) { res.status(500).json({ error: error.message }); return; }
  res.status(204).send();
});

export default router;
