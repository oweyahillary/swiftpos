import { stripCostsUnlessAllowed } from '../lib/costAccess';   // A490
import { Router } from 'express';
import { sendError } from '../lib/sendError';
import { safeRouter } from '../middleware/asyncHandler';
import { requireAuth } from '../middleware/auth';
import { branchScope, assertBranchAccess, requirePermission, requireAnyPermission } from '../middleware/rbac';
import { supabase } from '../lib/supabase';
import { hiddenWhileCounting } from '../lib/stockTakeAccess';   // A394
import { recordReceivedBatch, wantsBatch } from '../lib/batchStore';   // A413
import { heldUnits } from '../lib/batches';
import { actor } from '../lib/actor';
import { guardBranch, idsOfBusiness } from '../lib/branchGuard';   // A494

const router = safeRouter();
router.use(requireAuth);
// A490: cost prices, margins and cost values go out only to the owner, menu.costs or reports.costs (lib/costAccess.ts).
router.use(stripCostsUnlessAllowed());

// GET /api/inventory
// Returns stock levels for all products in the business, joined with product info.
// Owner: pass ?branch_id= to filter, or omit for all branches.
// Staff: always locked to their JWT branch.
// A494: deliberately NO permission gate — the POS (web and till) reads it for what is in stock at the counter, and a
// cashier's role need not hold inventory.view. It is branch-locked (branchScope; a branchless non-owner reads nothing),
// sends no cost (router strip) and is blind for the items a count at the branch is counting (hiddenWhileCounting).
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

    if (error) { sendError(res, error); return; }
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

  if (error) { sendError(res, error); return; }

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

  // A394: blind count — while this branch counts, someone who may not change stock does not see the counted items' figures.
  const hide = await hiddenWhileCounting(req, scopedBranch);
  const rows = [...(data ?? []), ...unstocked].map((r: any) =>
    hide.has(`p:${r.product_id}`) ? { ...r, quantity: null, qty_pieces: null, counting: true } : r);
  res.json(rows);
});

// POST /api/inventory/adjust
// Body: { product_id, branch_id, type: 'restock'|'write_off'|'correction', quantity, notes }
router.post('/adjust', requirePermission('inventory.adjust'), async (req, res) => {
  const { product_id, branch_id, type, quantity, notes, expiry_date, batch_no } = req.body;

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
    .select('id, track_stock, sold_by, pieces_per_unit')
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

  if (slErr) { sendError(res, slErr); return; }

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
      // created_by references users(id). An owner authenticated via Supabase may
      // not have a users row, so req.userId isn't a valid FK for them → the insert
      // would 500. Only set it for staff (whose req.userId is always a users.id);
      // null for owners (the column is nullable).
      created_by: req.isOwner ? null : req.userId,
    });

  if (mvErr) { sendError(res, mvErr); return; }

  // A413: a restock with an expiry date or a batch number records the batch (never fails the restock).
  let batchWarning: string | undefined;
  if (type === 'restock' && wantsBatch(expiry_date, batch_no)) {
    const p = product as { sold_by?: string | null; pieces_per_unit?: number | null };
    const out = await recordReceivedBatch({ businessId: req.businessId, branchId: branch_id, kind: 'product', itemId: product_id,
      quantity: heldUnits(quantityChange, p.sold_by === 'piece', p.pieces_per_unit), expiry: expiry_date, batchNo: batch_no,
      source: 'restock', sourceRef: typeof notes === 'string' ? notes.slice(0, 120) : null, by: await actor(req) });
    if (out.ok === false) batchWarning = out.error;
  }

  res.json({ stockLevel, previousQty: currentQty, newQty, quantityChange, ...(batchWarning ? { batch_warning: batchWarning } : {}) });
});

// PATCH /api/inventory/:product_id/threshold
// Update low stock threshold for a product+branch
// A494: the product and the branch were never checked — any id, any branch, any business (and an upsert made a stock
// row for a branch that has none). Now: the product is this business's, the branch is this business's and the caller's,
// the threshold a number — and only then is the (product, branch) row written.
router.patch('/:product_id/threshold', requireAnyPermission('inventory.adjust', 'inventory.receive'), async (req, res) => {
  const { product_id } = req.params;
  const { branch_id, low_stock_threshold } = req.body ?? {};
  const t = Number(low_stock_threshold);
  if (low_stock_threshold === null || low_stock_threshold === undefined || low_stock_threshold === '' || !Number.isFinite(t) || t < 0) {
    res.status(400).json({ error: 'low_stock_threshold must be a number >= 0' }); return;
  }
  if (!(await guardBranch(req, res, branch_id, 'You can only change your own branch'))) return;
  if (!(await idsOfBusiness('products', req.businessId, [product_id]))) { res.status(404).json({ error: 'Product not found' }); return; }

  const { data, error } = await supabase
    .from('stock_levels')
    .upsert({
      product_id,
      branch_id,
      low_stock_threshold: t,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'product_id,branch_id' })
    .select()
    .single();

  if (error) { sendError(res, error); return; }
  res.json(data);
});

// GET /api/inventory/movements
// A494: was open to every signed-in user — inventory.view; branch-locked; blind for counted items.
router.get('/movements', requirePermission('inventory.view'), async (req, res) => {
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
    .limit(Math.min(parseInt(limit as string) || 50, 500));

  if (product_id)   query = query.eq('product_id', product_id as string);
  if (scopedBranch) query = query.eq('branch_id', scopedBranch);

  const { data, error } = await query;
  if (error) { sendError(res, error); return; }
  // A394 / A494: while the branch counts, the level after each movement of a counted item would give the count away.
  const hide = await hiddenWhileCounting(req, scopedBranch);
  const rows = (data ?? []) as Array<Record<string, unknown>>;
  res.json(hide.size ? rows.map((m) => (hide.has(`p:${m.product_id}`) ? { ...m, quantity_after: null, counting: true } : m)) : rows);
});

export default router;
