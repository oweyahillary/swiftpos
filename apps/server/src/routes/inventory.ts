import { Router } from 'express';
import { safeRouter } from '../middleware/asyncHandler';
import { requireAuth } from '../middleware/auth';
import { branchScope, assertBranchAccess } from '../middleware/rbac';
import { supabase } from '../lib/supabase';

const router = safeRouter();
router.use(requireAuth);

// GET /api/inventory
// Returns stock levels for all products in the business, joined with product info.
// Owner: pass ?branch_id= to filter, or omit for all branches.
// Staff: always locked to their JWT branch.
router.get('/', async (req, res) => {
  const scopedBranch = branchScope(req);

  if (!scopedBranch) {
    // Owner with no branch filter — return all branches
    const { data, error } = await supabase
      .from('stock_levels')
      .select(`
        *,
        products!inner (
          id, name, image_url, track_stock, status, business_id,
          categories ( name, color )
        )
      `)
      .eq('products.business_id', req.businessId)
      .order('quantity', { ascending: true });

    if (error) { res.status(500).json({ error: error.message }); return; }
    res.json(data ?? []);
    return;
  }

  const { data, error } = await supabase
    .from('stock_levels')
    .select(`
      *,
      products!inner (
        id, name, image_url, track_stock, status, business_id,
        categories ( name, color )
      )
    `)
    .eq('branch_id', scopedBranch)
    .eq('products.business_id', req.businessId)
    .order('quantity', { ascending: true });

  if (error) { res.status(500).json({ error: error.message }); return; }

  const { data: allProducts } = await supabase
    .from('products')
    .select('id, name, image_url, track_stock, status, categories(name, color)')
    .eq('business_id', req.businessId)
    .eq('status', 'active');

  const stockedIds = new Set((data ?? []).map((s: any) => s.product_id));
  const unstocked = (allProducts ?? [])
    .filter((p: any) => !stockedIds.has(p.id))
    .map((p: any) => ({
      id: null,
      product_id: p.id,
      quantity: 0,
      low_stock_threshold: 5,
      products: p,
      _unstocked: true,
    }));

  res.json([...(data ?? []), ...unstocked]);
});

// POST /api/inventory/adjust
// Body: { product_id, branch_id, type: 'restock'|'write_off'|'correction', quantity, notes }
router.post('/adjust', async (req, res) => {
  const { product_id, branch_id, type, quantity, notes } = req.body;

  if (!product_id || !branch_id || !type || quantity === undefined) {
    res.status(400).json({ error: 'product_id, branch_id, type, and quantity are required' });
    return;
  }

  // Non-owners can only adjust stock for their own branch
  if (!assertBranchAccess(req, branch_id)) {
    res.status(403).json({ error: 'You can only adjust stock for your own branch' });
    return;
  }

  // Verify product belongs to this business
  const { data: product } = await supabase
    .from('products')
    .select('id, track_stock')
    .eq('id', product_id)
    .eq('business_id', req.businessId)
    .single();

  if (!product) { res.status(404).json({ error: 'Product not found' }); return; }

  // Get current stock level
  const { data: current } = await supabase
    .from('stock_levels')
    .select('*')
    .eq('product_id', product_id)
    .eq('branch_id', branch_id)
    .single();

  const currentQty = current?.quantity ?? 0;

  let newQty: number;
  let quantityChange: number;

  if (type === 'correction') {
    newQty = quantity;
    quantityChange = quantity - currentQty;
  } else if (type === 'restock') {
    quantityChange = Math.abs(quantity);
    newQty = currentQty + quantityChange;
  } else if (type === 'write_off') {
    quantityChange = -Math.abs(quantity);
    newQty = Math.max(0, currentQty + quantityChange);
  } else {
    res.status(400).json({ error: 'type must be restock, write_off, or correction' });
    return;
  }

  // Upsert stock level
  const { data: stockLevel, error: slErr } = await supabase
    .from('stock_levels')
    .upsert({
      product_id,
      branch_id,
      quantity: newQty,
      low_stock_threshold: current?.low_stock_threshold ?? 5,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'product_id,branch_id' })
    .select()
    .single();

  if (slErr) { res.status(500).json({ error: slErr.message }); return; }

  // Log movement
  const { error: mvErr } = await supabase
    .from('stock_movements')
    .insert({
      product_id,
      branch_id,
      movement_type: type,
      quantity_change: quantityChange,
      quantity_after: newQty,
      notes: notes ?? null,
      created_by: req.userId,
    });

  if (mvErr) { res.status(500).json({ error: mvErr.message }); return; }

  res.json({ stockLevel, previousQty: currentQty, newQty, quantityChange });
});

// PATCH /api/inventory/:product_id/threshold
// Update low stock threshold for a product+branch
router.patch('/:product_id/threshold', async (req, res) => {
  const { product_id } = req.params;
  const { branch_id, low_stock_threshold } = req.body;

  const { data, error } = await supabase
    .from('stock_levels')
    .upsert({
      product_id,
      branch_id,
      low_stock_threshold,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'product_id,branch_id' })
    .select()
    .single();

  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data);
});

// GET /api/inventory/movements
router.get('/movements', async (req, res) => {
  const { product_id, limit = '50' } = req.query;
  const scopedBranch = branchScope(req);

  let query = supabase
    .from('stock_movements')
    .select(`
      *,
      products!inner ( name, business_id )
    `)
    .eq('products.business_id', req.businessId)
    .order('created_at', { ascending: false })
    .limit(parseInt(limit as string));

  if (product_id)   query = query.eq('product_id', product_id as string);
  if (scopedBranch) query = query.eq('branch_id', scopedBranch);

  const { data, error } = await query;
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data ?? []);
});

export default router;
