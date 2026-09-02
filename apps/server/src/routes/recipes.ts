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
import { branchScope } from '../middleware/rbac';
import { requirePermission } from '../middleware/rbac';
import { buildRecipeImport } from '../lib/productImport';
import { supabase } from '../lib/supabase';

/**
 * A12: recipe lines join `ingredients`, and used to read the dead
 * `ingredients.current_stock` column (frozen since migration 23), so the Recipes
 * drawer showed "0 in stock" for everything created since. The live figure is
 * per-branch in `ingredient_stock_levels`. Flatten it the SAME way `stock.ts`
 * does — scoped branch → that branch, no branch (owner) → business-wide sum — so
 * the Recipes drawer and the Ingredients page finally show the same number.
 */
function flattenRecipeStock(rows: any[], scopedBranch: string | null): any[] {
  return (rows ?? []).map((r: any) => {
    const ing = r?.ingredients;
    if (!ing || !Array.isArray(ing.ingredient_stock_levels)) return r;
    const levels = ing.ingredient_stock_levels;
    const current_stock = scopedBranch
      ? Number(levels.find((l: any) => l.branch_id === scopedBranch)?.current_stock ?? 0)
      : levels.reduce((s: number, l: any) => s + Number(l.current_stock ?? 0), 0);
    const { ingredient_stock_levels, ...restIng } = ing;
    return { ...r, ingredients: { ...restIng, current_stock } };
  });
}

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
      ingredients ( id, name, unit, ingredient_stock_levels ( branch_id, current_stock ) )
    `)
    .eq('business_id', req.businessId)
    .order('product_id');

  if (error) { sendError(res, error); return; }
  res.json(flattenRecipeStock(data ?? [], branchScope(req)));
});

// GET /api/recipes/:productId
// Returns the recipe lines for one product
router.get('/:productId', async (req, res) => {
  const { data, error } = await supabase
    .from('recipes')
    .select(`
      id, product_id, ingredient_id, quantity_per_serving, unit,
      ingredients ( id, name, unit, ingredient_stock_levels ( branch_id, current_stock ) )
    `)
    .eq('business_id', req.businessId)
    .eq('product_id', req.params.productId)
    .order('created_at');

  if (error) { sendError(res, error); return; }
  res.json(flattenRecipeStock(data ?? [], branchScope(req)));
});

// POST /api/recipes/:productId
// Full replace — saves the entire recipe for a product in one call.
// Body: { lines: [{ ingredient_id, quantity_per_serving, unit? }] }
// POST /api/recipes/bulk — A165 slice 2. Import the Recipe tab.
// Body: { rows: [{ product, ingredient, quantity_per_serving, unit?, notes? }] }
// A product that appears has its recipe REPLACED by the listed lines; a product
// not in the file is left alone. Products matched by name/plu, ingredients by name
// (import the Ingredients tab first so they exist).
router.post('/bulk', requirePermission('products.manage'), async (req, res) => {
  const { rows } = req.body ?? {};
  if (!Array.isArray(rows) || rows.length === 0) { res.status(400).json({ error: 'rows array is required' }); return; }
  if (rows.length > 2000) { res.status(400).json({ error: 'Maximum 2000 rows per import' }); return; }

  const { products: recipeProducts, errors } = buildRecipeImport(rows);
  const results = { updated: 0, cleared: 0, errors: [...errors] as { row: number; error: string }[] };

  const { data: prods } = await supabase
    .from('products').select('id, name, plu_code').eq('business_id', req.businessId);
  const { data: ings } = await supabase
    .from('ingredients').select('id, name').eq('business_id', req.businessId);
  const pByName: Record<string, string> = {}, pByPlu: Record<string, string> = {}, iByName: Record<string, string> = {};
  for (const p of (prods ?? []) as any[]) {
    const n = String(p.name ?? '').trim().toLowerCase(); const pl = String(p.plu_code ?? '').trim().toLowerCase();
    if (n && !(n in pByName)) pByName[n] = p.id;
    if (pl && !(pl in pByPlu)) pByPlu[pl] = p.id;
  }
  for (const ing of (ings ?? []) as any[]) {
    const n = String(ing.name ?? '').trim().toLowerCase();
    if (n && !(n in iByName)) iByName[n] = ing.id;
  }

  for (const rp of recipeProducts) {
    const productId = pByPlu[rp.product.toLowerCase()] || pByName[rp.product.toLowerCase()];
    if (!productId) { results.errors.push({ row: 0, error: `unknown product: ${rp.product}` }); continue; }

    // Resolve ingredient names; a single unknown fails the whole product so its
    // recipe isn't silently saved half-right.
    const lines: { ingredient_id: string; quantity_per_serving: number; unit: string | null }[] = [];
    let bad = '';
    for (const l of rp.lines) {
      const id = iByName[l.ingredient.toLowerCase()];
      if (!id) { bad = l.ingredient; break; }
      lines.push({ ingredient_id: id, quantity_per_serving: l.quantity_per_serving, unit: l.unit });
    }
    if (bad) { results.errors.push({ row: 0, error: `${rp.product}: unknown ingredient "${bad}" (add it on the Ingredients tab first)` }); continue; }

    const { error: delErr } = await supabase
      .from('recipes').delete().eq('product_id', productId).eq('business_id', req.businessId);
    if (delErr) { results.errors.push({ row: 0, error: `${rp.product}: ${delErr.message}` }); continue; }

    if (lines.length > 0) {
      const { error: insErr } = await supabase.from('recipes').insert(
        lines.map(l => ({ business_id: req.businessId, product_id: productId, ingredient_id: l.ingredient_id, quantity_per_serving: l.quantity_per_serving, unit: l.unit })),
      );
      if (insErr) { results.errors.push({ row: 0, error: `${rp.product}: ${insErr.message}` }); continue; }
      results.updated++;
    } else {
      results.cleared++;
    }
  }

  res.json(results);
});

// POST /api/recipes/:productId  — save/replace a single product's recipe
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
      ingredients ( id, name, unit, ingredient_stock_levels ( branch_id, current_stock ) )
    `)
    .eq('product_id', productId)
    .eq('business_id', req.businessId)
    .order('created_at');

  res.json({ product, lines: flattenRecipeStock(saved ?? [], branchScope(req)) });
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
