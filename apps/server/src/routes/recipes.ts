/**
 * /api/recipes
 *
 * Links menu products to their raw ingredients with quantities per serving.
 * e.g. "Ugali Nyama" = 200g maize flour + 150g beef + 50ml cooking oil.
 *
 * When an order is placed, the POS order route reads these recipes and
 * auto-deducts the appropriate ingredient quantities from stock.
 */

import { Router } from 'express';
import { sendError } from '../lib/sendError';
import { safeRouter } from '../middleware/asyncHandler';
import { requireAuth } from '../middleware/auth';
import { supabase } from '../lib/supabase';

const router = safeRouter();
router.use(requireAuth);

// GET /api/recipes
// Returns all recipes for this business, grouped by product
router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('recipes')
    .select(`
      id, product_id, ingredient_id, quantity_per_serving, unit,
      products   ( id, name ),
      ingredients ( id, name, unit, current_stock )
    `)
    .eq('business_id', req.businessId)
    .order('product_id');

  if (error) { sendError(res, error); return; }
  res.json(data ?? []);
});

// GET /api/recipes/:productId
// Returns the recipe lines for one product
router.get('/:productId', async (req, res) => {
  const { data, error } = await supabase
    .from('recipes')
    .select(`
      id, product_id, ingredient_id, quantity_per_serving, unit,
      ingredients ( id, name, unit, current_stock )
    `)
    .eq('business_id', req.businessId)
    .eq('product_id', req.params.productId)
    .order('created_at');

  if (error) { sendError(res, error); return; }
  res.json(data ?? []);
});

// POST /api/recipes/:productId
// Full replace — saves the entire recipe for a product in one call.
// Body: { lines: [{ ingredient_id, quantity_per_serving, unit? }] }
router.post('/:productId', async (req, res) => {
  const { productId } = req.params;
  const { lines = [] } = req.body as {
    lines: { ingredient_id: string; quantity_per_serving: number; unit?: string }[];
  };

  // Verify product belongs to this business
  const { data: product } = await supabase
    .from('products')
    .select('id, name')
    .eq('id', productId)
    .eq('business_id', req.businessId)
    .single();

  if (!product) { res.status(404).json({ error: 'Product not found' }); return; }

  // Validate lines
  if (!Array.isArray(lines)) { res.status(400).json({ error: 'lines must be an array' }); return; }
  for (const line of lines) {
    if (!line.ingredient_id)            { res.status(400).json({ error: 'Each line needs an ingredient_id' }); return; }
    if (!line.quantity_per_serving || line.quantity_per_serving <= 0) {
      res.status(400).json({ error: 'Each line needs a positive quantity_per_serving' }); return;
    }
  }

  // Delete existing recipe lines for this product
  const { error: delErr } = await supabase
    .from('recipes')
    .delete()
    .eq('product_id', productId)
    .eq('business_id', req.businessId);

  if (delErr) { sendError(res, delErr); return; }

  // Insert new lines (if any)
  if (lines.length > 0) {
    const rows = lines.map(line => ({
      business_id:          req.businessId,
      product_id:           productId,
      ingredient_id:        line.ingredient_id,
      quantity_per_serving: line.quantity_per_serving,
      unit:                 line.unit ?? null,
    }));

    const { error: insErr } = await supabase.from('recipes').insert(rows);
    if (insErr) { sendError(res, insErr); return; }
  }

  // Return the saved recipe
  const { data: saved } = await supabase
    .from('recipes')
    .select(`
      id, product_id, ingredient_id, quantity_per_serving, unit,
      ingredients ( id, name, unit, current_stock )
    `)
    .eq('product_id', productId)
    .eq('business_id', req.businessId)
    .order('created_at');

  res.json({ product, lines: saved ?? [] });
});

// DELETE /api/recipes/:productId
// Clear the entire recipe for a product
router.delete('/:productId', async (req, res) => {
  const { error } = await supabase
    .from('recipes')
    .delete()
    .eq('product_id', req.params.productId)
    .eq('business_id', req.businessId);

  if (error) { sendError(res, error); return; }
  res.status(204).send();
});

// ── Takeaway packaging (Track C) ────────────────────────────
// A product's takeaway packaging consumption (product_packaging table).
// Packaging items are ingredients flagged is_packaging = true. On a takeaway
// order, the order route deducts (quantity × line qty) of each mapped item.

// GET /api/recipes/:productId/packaging
router.get('/:productId/packaging', async (req, res) => {
  const { data, error } = await supabase
    .from('product_packaging')
    .select('id, product_id, ingredient_id, quantity, ingredients ( id, name, unit, unit_cost )')
    .eq('business_id', req.businessId)
    .eq('product_id', req.params.productId)
    .order('created_at');

  if (error) { sendError(res, error); return; }
  res.json(data ?? []);
});

// POST /api/recipes/:productId/packaging  — full replace
// Body: { lines: [{ ingredient_id, quantity }] }
router.post('/:productId/packaging', async (req, res) => {
  const { productId } = req.params;
  const { lines = [] } = req.body as { lines: { ingredient_id: string; quantity: number }[] };

  const { data: product } = await supabase
    .from('products')
    .select('id, name')
    .eq('id', productId)
    .eq('business_id', req.businessId)
    .single();
  if (!product) { res.status(404).json({ error: 'Product not found' }); return; }

  if (!Array.isArray(lines)) { res.status(400).json({ error: 'lines must be an array' }); return; }
  for (const line of lines) {
    if (!line.ingredient_id) { res.status(400).json({ error: 'Each line needs an ingredient_id' }); return; }
    if (!line.quantity || line.quantity <= 0) {
      res.status(400).json({ error: 'Each line needs a positive quantity' }); return;
    }
  }

  const { error: delErr } = await supabase
    .from('product_packaging')
    .delete()
    .eq('product_id', productId)
    .eq('business_id', req.businessId);
  if (delErr) { sendError(res, delErr); return; }

  if (lines.length > 0) {
    // De-dupe by ingredient to respect the unique (product_id, ingredient_id) constraint.
    const seen = new Set<string>();
    const rows = lines
      .filter(l => !seen.has(l.ingredient_id) && seen.add(l.ingredient_id))
      .map(line => ({
        business_id:   req.businessId,
        product_id:    productId,
        ingredient_id: line.ingredient_id,
        quantity:      line.quantity,
      }));
    const { error: insErr } = await supabase.from('product_packaging').insert(rows);
    if (insErr) { sendError(res, insErr); return; }
  }

  const { data: saved } = await supabase
    .from('product_packaging')
    .select('id, product_id, ingredient_id, quantity, ingredients ( id, name, unit, unit_cost )')
    .eq('product_id', productId)
    .eq('business_id', req.businessId)
    .order('created_at');

  res.json({ product, lines: saved ?? [] });
});

export default router;
