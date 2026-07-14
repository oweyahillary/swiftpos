/**
 * /api/stock
 *
 * Covers: Ingredients, Suppliers, Purchase Orders (PO),
 *         Goods Received Notes (GRN), Stock Transfers.
 *
 * Key design: POs and GRNs operate on INGREDIENTS (raw supplies like maize
 * flour, cooking oil, kales) — NOT on menu products (like "Ugali Nyama").
 * Stock Transfers still operate on products (for minimart / retail branches).
 *
 * Recipes table exists in DB (Option B foundation) but not wired to routes yet.
 */

import { Router } from 'express';
import { sendError } from '../lib/sendError';
import { safeRouter } from '../middleware/asyncHandler';
import { requireAuth } from '../middleware/auth';
import { requirePermission, assertBranchAccess, branchScope } from '../middleware/rbac';
import { supabase } from '../lib/supabase';
import { chunkIn } from './reports';

const router = safeRouter();
router.use(requireAuth);

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function nextRef(table: string, prefix: string, businessId: string): Promise<string> {
  const { count } = await supabase
    .from(table)
    .select('*', { count: 'exact', head: true })
    .eq('business_id', businessId);
  const seq = String((count ?? 0) + 1).padStart(4, '0');
  return `${prefix}-${seq}`;
}

async function applyIngredientStockIn(
  items: { ingredient_id: string; quantity: number; unit_cost?: number | null }[],
  businessId: string,
  branchId: string,
  createdBy: string,
  movementType: 'restock' | 'adjustment' | 'opening',
  referenceNote: string,
) {
  for (const item of items) {
    if (!item.quantity || item.quantity <= 0) continue;

    // Atomic per-branch increment (no read-modify-write race).
    const { data: newQty, error } = await supabase.rpc('adjust_ingredient_stock', {
      p_ingredient_id: item.ingredient_id,
      p_branch_id:     branchId,
      p_business_id:   businessId,
      p_delta:         item.quantity,
    });
    if (error) throw error;

    // Keep the catalogue's last-known unit cost fresh (business-level field).
    if (item.unit_cost != null) {
      await supabase.from('ingredients')
        .update({ unit_cost: item.unit_cost, updated_at: new Date().toISOString() })
        .eq('id', item.ingredient_id).eq('business_id', businessId);
    }

    await supabase.from('ingredient_stock_movements').insert({
      business_id: businessId, ingredient_id: item.ingredient_id, branch_id: branchId,
      movement_type: movementType, quantity_change: item.quantity,
      quantity_after: newQty, notes: referenceNote, created_by: createdBy,
    });
  }
}

async function applyProductStockIn(
  items: { product_id: string; quantity: number }[],
  branchId: string, createdBy: string,
  movementType: 'restock' | 'transfer_in', referenceNote: string,
) {
  // Fetch sold_by and pieces_per_unit for all products in one query
  const productIds = items.map(i => i.product_id);
  const { data: productMeta } = await supabase
    .from('products')
    .select('id, sold_by, pieces_per_unit')
    .in('id', productIds);
  const metaMap = new Map((productMeta ?? []).map((p: any) => [p.id, p]));

  for (const item of items) {
    if (!item.quantity || item.quantity <= 0) continue;
    const meta = metaMap.get(item.product_id);
    const isByPiece = meta?.sold_by === 'piece';
    const piecesPerUnit = meta?.pieces_per_unit ?? 1;

    const { data: current } = await supabase.from('stock_levels')
      .select('quantity, qty_pieces, low_stock_threshold')
      .eq('product_id', item.product_id).eq('branch_id', branchId).maybeSingle();

    const newQty       = (current?.quantity ?? 0) + item.quantity;
    // For piece-based products qty_pieces is the live counter; units received are unpacked into pieces
    const newQtyPieces = isByPiece
      ? (current?.qty_pieces ?? 0) + item.quantity * piecesPerUnit
      : (current?.qty_pieces ?? 0);

    await supabase.from('stock_levels').upsert(
      {
        product_id: item.product_id, branch_id: branchId,
        quantity: newQty,
        qty_pieces: newQtyPieces,
        low_stock_threshold: current?.low_stock_threshold ?? 5,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'product_id,branch_id' },
    );

    const noteWithPieces = isByPiece
      ? `${referenceNote} (+${item.quantity * piecesPerUnit} pieces)`
      : referenceNote;

    await supabase.from('stock_movements').insert({
      product_id: item.product_id, branch_id: branchId,
      movement_type: movementType,
      quantity_change: item.quantity,
      quantity_after: isByPiece ? newQtyPieces : newQty,
      notes: noteWithPieces,
      created_by: createdBy,
    });
  }
}

async function applyProductStockOut(
  items: { product_id: string; quantity: number }[],
  branchId: string, createdBy: string,
  movementType: 'transfer_out' | 'write_off', referenceNote: string,
) {
  for (const item of items) {
    if (!item.quantity || item.quantity <= 0) continue;
    const { data: current } = await supabase.from('stock_levels')
      .select('quantity, low_stock_threshold').eq('product_id', item.product_id).eq('branch_id', branchId).maybeSingle();
    const newQty = Math.max(0, (current?.quantity ?? 0) - item.quantity);
    await supabase.from('stock_levels').upsert(
      { product_id: item.product_id, branch_id: branchId, quantity: newQty, low_stock_threshold: current?.low_stock_threshold ?? 5, updated_at: new Date().toISOString() },
      { onConflict: 'product_id,branch_id' },
    );
    await supabase.from('stock_movements').insert({ product_id: item.product_id, branch_id: branchId, movement_type: movementType, quantity_change: -item.quantity, quantity_after: newQty, notes: referenceNote, created_by: createdBy });
  }
}

// =============================================================================
// INGREDIENTS
// =============================================================================

router.get('/ingredients', async (req, res) => {
  const { status, category } = req.query as Record<string, string>;
  const scopedBranch = branchScope(req); // staff -> their branch; owner -> ?branch_id or null (all)

  let query = supabase.from('ingredients')
    .select('*, ingredient_stock_levels ( branch_id, current_stock, reorder_level )')
    .eq('business_id', req.businessId)
    .order('category', { ascending: true })
    .order('name',     { ascending: true });
  if (status)   query = query.eq('status', status);
  if (category) query = query.eq('category', category);
  const { data, error } = await query;
  if (error) { sendError(res, error); return; }

  // Flatten per-branch stock into the current_stock/reorder_level fields the UI
  // already reads. Staff see their branch; owner (no branch filter) sees the
  // business-wide total plus a per-branch breakdown in `branch_stock`.
  const shaped = (data ?? []).map((ing: any) => {
    const levels = ing.ingredient_stock_levels ?? [];
    let current_stock = 0;
    let reorder_level = 0;
    if (scopedBranch) {
      const lvl = levels.find((l: any) => l.branch_id === scopedBranch);
      current_stock = Number(lvl?.current_stock ?? 0);
      reorder_level = Number(lvl?.reorder_level ?? 0);
    } else {
      current_stock = levels.reduce((sum: number, l: any) => sum + Number(l.current_stock ?? 0), 0);
    }
    const { ingredient_stock_levels, ...rest } = ing;
    return { ...rest, current_stock, reorder_level, branch_stock: levels };
  });
  res.json(shaped);
});

router.post('/ingredients', requirePermission('ingredients.manage'), async (req, res) => {
  const { name, category, unit, unit_cost, notes } = req.body;
  if (!name?.trim()) { res.status(400).json({ error: 'name is required' }); return; }
  if (!unit?.trim()) { res.status(400).json({ error: 'unit is required' }); return; }

  // Catalogue entry only — a business-level definition with NO stock. Stock
  // arrives per-branch via receiving (GRN) or an owner adjustment. reorder_level
  // is per-branch now (ingredient_stock_levels), set when stock is first added.
  const { data, error } = await supabase.from('ingredients').insert({
    business_id: req.businessId, name: name.trim(),
    category: category?.trim() || null, unit: unit.trim(),
    unit_cost: unit_cost != null ? Number(unit_cost) : null,
    notes: notes?.trim() || null,
  }).select().single();

  if (error) { sendError(res, error); return; }
  res.status(201).json(data);
});

router.patch('/ingredients/:id', async (req, res) => {
  const { name, category, unit, unit_cost, reorder_level, notes, status } = req.body;
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (name !== undefined)          updates.name          = name?.trim();
  if (category !== undefined)      updates.category      = category?.trim() || null;
  if (unit !== undefined)          updates.unit          = unit?.trim();
  if (unit_cost !== undefined)     updates.unit_cost     = unit_cost != null ? Number(unit_cost) : null;
  if (reorder_level !== undefined) updates.reorder_level = Number(reorder_level);
  if (notes !== undefined)         updates.notes         = notes?.trim() || null;
  if (status !== undefined)        updates.status        = status;

  const { data, error } = await supabase.from('ingredients').update(updates)
    .eq('id', req.params.id).eq('business_id', req.businessId).select().single();
  if (error) { sendError(res, error); return; }
  if (!data) { res.status(404).json({ error: 'Ingredient not found' }); return; }
  res.json(data);
});

router.post('/ingredients/:id/adjust', requirePermission('inventory.adjust'), async (req, res) => {
  const { branch_id, type, quantity, notes } = req.body as
    { branch_id: string; type: 'add' | 'remove' | 'set'; quantity: number; notes?: string };

  if (!branch_id) { res.status(400).json({ error: 'branch_id is required' }); return; }
  if (!assertBranchAccess(req, branch_id)) { res.status(403).json({ error: 'No access to that branch' }); return; }
  if (!['add', 'remove', 'set'].includes(type)) { res.status(400).json({ error: 'type must be add, remove, or set' }); return; }
  if (quantity == null || quantity < 0) { res.status(400).json({ error: 'quantity must be >= 0' }); return; }

  // Read the branch level once (manual, low-frequency op) to compute the delta;
  // the RPC still performs the write atomically.
  const { data: lvl } = await supabase.from('ingredient_stock_levels')
    .select('current_stock').eq('ingredient_id', req.params.id).eq('branch_id', branch_id).maybeSingle();
  const current = Number(lvl?.current_stock ?? 0);

  const target = type === 'add' ? current + quantity
               : type === 'remove' ? Math.max(0, current - quantity)
               : quantity; // set
  const delta = target - current;

  const { data: newQty, error } = await supabase.rpc('adjust_ingredient_stock', {
    p_ingredient_id: req.params.id, p_branch_id: branch_id,
    p_business_id: req.businessId, p_delta: delta,
  });
  if (error) { sendError(res, error); return; }

  await supabase.from('ingredient_stock_movements').insert({
    business_id: req.businessId, ingredient_id: req.params.id, branch_id,
    movement_type: 'adjustment', quantity_change: delta, quantity_after: newQty,
    notes: notes?.trim() || `Manual ${type}`, created_by: req.userId,
  });

  res.json({ ingredient_id: req.params.id, branch_id, current_stock: newQty });
});

// Set the per-branch reorder level for an ingredient (owner-only). Upserts the
// (ingredient, branch) row; current_stock is preserved on update.
router.patch('/ingredients/:id/reorder', requirePermission('inventory.adjust'), async (req, res) => {
  const { branch_id, reorder_level } = req.body as { branch_id: string; reorder_level: number };
  if (!branch_id) { res.status(400).json({ error: 'branch_id is required' }); return; }
  if (!assertBranchAccess(req, branch_id)) { res.status(403).json({ error: 'No access to that branch' }); return; }
  if (reorder_level == null || Number(reorder_level) < 0) { res.status(400).json({ error: 'reorder_level must be >= 0' }); return; }

  const { data, error } = await supabase
    .from('ingredient_stock_levels')
    .upsert(
      { business_id: req.businessId, ingredient_id: req.params.id, branch_id, reorder_level: Number(reorder_level), updated_at: new Date().toISOString() },
      { onConflict: 'ingredient_id,branch_id' },
    )
    .select('current_stock, reorder_level')
    .single();
  if (error) { sendError(res, error); return; }
  res.json({ ingredient_id: req.params.id, branch_id, ...data });
});

router.get('/ingredients/:id/movements', async (req, res) => {
  const { limit = '50' } = req.query as Record<string, string>;
  const { data, error } = await supabase.from('ingredient_stock_movements')
    .select('*, users ( name )')
    .eq('ingredient_id', req.params.id).eq('business_id', req.businessId)
    .order('created_at', { ascending: false }).limit(Math.min(Number(limit), 200));
  if (error) { sendError(res, error); return; }
  res.json(data ?? []);
});

// =============================================================================
// SUPPLIERS
// =============================================================================

router.get('/suppliers', async (req, res) => {
  const { status } = req.query as Record<string, string>;
  let query = supabase.from('suppliers').select('*').eq('business_id', req.businessId).order('name');
  if (status) query = query.eq('status', status);
  const { data, error } = await query;
  if (error) { sendError(res, error); return; }
  res.json(data ?? []);
});

router.post('/suppliers', async (req, res) => {
  const { name, contact_name, email, phone, address, notes } = req.body;
  if (!name) { res.status(400).json({ error: 'name is required' }); return; }
  const { data, error } = await supabase.from('suppliers')
    .insert({ business_id: req.businessId, name, contact_name, email, phone, address, notes })
    .select().single();
  if (error) { sendError(res, error); return; }
  res.status(201).json(data);
});

router.patch('/suppliers/:id', async (req, res) => {
  const { name, contact_name, email, phone, address, notes, status } = req.body;
  const { data, error } = await supabase.from('suppliers')
    .update({ name, contact_name, email, phone, address, notes, status, updated_at: new Date().toISOString() })
    .eq('id', req.params.id).eq('business_id', req.businessId).select().single();
  if (error) { sendError(res, error); return; }
  res.json(data);
});

router.delete('/suppliers/:id', async (req, res) => {
  const { error } = await supabase.from('suppliers')
    .update({ status: 'inactive', updated_at: new Date().toISOString() })
    .eq('id', req.params.id).eq('business_id', req.businessId);
  if (error) { sendError(res, error); return; }
  res.status(204).send();
});

// =============================================================================
// PURCHASE ORDERS  (ordering INGREDIENTS, not products)
// =============================================================================

router.get('/purchase-orders', async (req, res) => {
  const { status, supplier_id, branch_id, limit = '50' } = req.query as Record<string, string>;
  let query = supabase.from('purchase_orders')
    .select(`*, suppliers ( id, name ),
      purchase_order_items ( id, ingredient_id, quantity_ordered, unit_cost, quantity_received, ingredients ( id, name, unit ) )`)
    .eq('business_id', req.businessId)
    .order('created_at', { ascending: false })
    .limit(Math.min(Number(limit), 200));
  if (status)      query = query.eq('status', status);
  if (supplier_id) query = query.eq('supplier_id', supplier_id);
  if (branch_id)   query = query.eq('branch_id', branch_id);
  const { data, error } = await query;
  if (error) { sendError(res, error); return; }
  // Derive total from the actual line items so a stale stored total_amount can never
  // disagree with the items shown (e.g. a cancelled/edited PO with 0 items).
  const withTotals = (data ?? []).map((po: any) => ({
    ...po,
    total_amount: (po.purchase_order_items ?? []).reduce(
      (s: number, it: any) => s + Number(it.unit_cost ?? 0) * Number(it.quantity_ordered ?? 0), 0),
  }));
  res.json(withTotals);
});

router.get('/purchase-orders/:id', async (req, res) => {
  const { data, error } = await supabase.from('purchase_orders')
    .select(`*, suppliers ( id, name, email, phone ),
      purchase_order_items ( id, ingredient_id, quantity_ordered, unit_cost, quantity_received, ingredients ( id, name, unit ) )`)
    .eq('id', req.params.id).eq('business_id', req.businessId).single();
  if (error || !data) { res.status(404).json({ error: 'Purchase order not found' }); return; }
  const total_amount = ((data as any).purchase_order_items ?? []).reduce(
    (s: number, it: any) => s + Number(it.unit_cost ?? 0) * Number(it.quantity_ordered ?? 0), 0);
  res.json({ ...data, total_amount });
});

router.post('/purchase-orders', async (req, res) => {
  const { branch_id, supplier_id, order_date, expected_date, notes, items = [] } = req.body;
  if (!branch_id)    { res.status(400).json({ error: 'branch_id is required' }); return; }
  if (!assertBranchAccess(req, branch_id)) { res.status(403).json({ error: 'No access to that branch' }); return; }
  if (!items.length) { res.status(400).json({ error: 'At least one item is required' }); return; }

  const po_number   = await nextRef('purchase_orders', 'PO', req.businessId);
  const totalAmount = items.reduce((s: number, i: any) => s + Number(i.unit_cost ?? 0) * Number(i.quantity_ordered ?? 0), 0);

  const { data: po, error: poErr } = await supabase.from('purchase_orders').insert({
    business_id: req.businessId, branch_id,
    supplier_id: supplier_id || null, po_number,
    order_date: order_date || new Date().toISOString().slice(0, 10),
    expected_date: expected_date || null, notes: notes || null,
    total_amount: totalAmount, created_by: req.userId, status: 'draft',
  }).select().single();
  if (poErr) { sendError(res, poErr); return; }

  const lineItems = items.map((i: any) => ({
    purchase_order_id: po.id, ingredient_id: i.ingredient_id,
    quantity_ordered: Number(i.quantity_ordered), unit_cost: Number(i.unit_cost ?? 0), quantity_received: 0,
  }));

  const { error: itemErr } = await supabase.from('purchase_order_items').insert(lineItems);
  if (itemErr) { sendError(res, itemErr); return; }
  res.status(201).json({ ...po, purchase_order_items: lineItems });
});

router.patch('/purchase-orders/:id', async (req, res) => {
  const { status, notes, expected_date, supplier_id } = req.body;
  const { data: current } = await supabase.from('purchase_orders')
    .select('status').eq('id', req.params.id).eq('business_id', req.businessId).single();
  if (!current)                        { res.status(404).json({ error: 'Purchase order not found' }); return; }
  if (current.status === 'cancelled')  { res.status(409).json({ error: 'Cannot modify a cancelled purchase order' }); return; }
  if (current.status === 'received' && status && status !== 'received') { res.status(409).json({ error: 'Cannot change status of a fully-received purchase order' }); return; }
  if (status === 'cancelled')          { res.status(409).json({ error: 'Use POST /purchase-orders/:id/cancel to cancel a PO' }); return; }
  const { data, error } = await supabase.from('purchase_orders')
    .update({ status, notes, expected_date, supplier_id, updated_at: new Date().toISOString() })
    .eq('id', req.params.id).eq('business_id', req.businessId).select().single();
  if (error) { sendError(res, error); return; }
  res.json(data);
});

router.post('/purchase-orders/:id/cancel', async (req, res) => {
  const { reason } = req.body as { reason?: string };
  const { data: po } = await supabase.from('purchase_orders')
    .select('status, notes, po_number').eq('id', req.params.id).eq('business_id', req.businessId).single();
  if (!po)                        { res.status(404).json({ error: 'Purchase order not found' }); return; }
  if (po.status === 'cancelled')  { res.status(409).json({ error: 'Already cancelled' }); return; }
  if (po.status === 'received')   { res.status(409).json({ error: 'Cannot cancel a fully-received PO' }); return; }
  if (po.status === 'draft')      { res.status(409).json({ error: 'Delete draft POs instead of cancelling' }); return; }
  const cancelNote   = reason?.trim() ? `[Cancelled] ${reason.trim()}` : '[Cancelled]';
  const updatedNotes = po.notes ? `${po.notes}\n${cancelNote}` : cancelNote;
  const { data, error } = await supabase.from('purchase_orders')
    .update({ status: 'cancelled', notes: updatedNotes, updated_at: new Date().toISOString() })
    .eq('id', req.params.id).eq('business_id', req.businessId).select().single();
  if (error) { sendError(res, error); return; }
  res.json(data);
});

router.delete('/purchase-orders/:id', async (req, res) => {
  const { data: po } = await supabase.from('purchase_orders')
    .select('status').eq('id', req.params.id).eq('business_id', req.businessId).single();
  if (!po)                   { res.status(404).json({ error: 'Purchase order not found' }); return; }
  if (po.status !== 'draft') { res.status(409).json({ error: 'Only draft purchase orders can be deleted' }); return; }
  await supabase.from('purchase_order_items').delete().eq('purchase_order_id', req.params.id);
  await supabase.from('purchase_orders').delete().eq('id', req.params.id);
  res.status(204).send();
});

// =============================================================================
// GOODS RECEIVED NOTES  (receiving INGREDIENTS)
// =============================================================================

router.get('/grn', async (req, res) => {
  const { purchase_order_id, branch_id, limit = '50' } = req.query as Record<string, string>;
  let query = supabase.from('goods_received_notes')
    .select(`*, purchase_orders ( po_number ),
      grn_items ( id, ingredient_id, quantity_received, unit_cost, ingredients ( name, unit ) )`)
    .eq('business_id', req.businessId)
    .order('created_at', { ascending: false }).limit(Math.min(Number(limit), 200));
  if (purchase_order_id) query = query.eq('purchase_order_id', purchase_order_id);
  if (branch_id)         query = query.eq('branch_id', branch_id);
  const { data, error } = await query;
  if (error) { sendError(res, error); return; }
  res.json(data ?? []);
});

router.post('/grn', requirePermission('inventory.receive'), async (req, res) => {
  const { branch_id, purchase_order_id, received_date, notes, items = [] } = req.body;
  if (!branch_id)    { res.status(400).json({ error: 'branch_id is required' }); return; }
  if (!items.length) { res.status(400).json({ error: 'At least one item is required' }); return; }

  const grn_number = await nextRef('goods_received_notes', 'GRN', req.businessId);

  const { data: grn, error: grnErr } = await supabase.from('goods_received_notes').insert({
    business_id: req.businessId, branch_id,
    purchase_order_id: purchase_order_id || null, grn_number,
    received_date: received_date || new Date().toISOString().slice(0, 10),
    notes: notes || null, received_by: req.userId,
  }).select().single();
  if (grnErr) { sendError(res, grnErr); return; }

  const lineItems = items.map((i: any) => ({
    grn_id: grn.id, ingredient_id: i.ingredient_id,
    quantity_received: Number(i.quantity_received),
    unit_cost: i.unit_cost != null ? Number(i.unit_cost) : null,
    notes: i.notes || null,
  }));
  const { error: itemErr } = await supabase.from('grn_items').insert(lineItems);
  if (itemErr) { sendError(res, itemErr); return; }

  await applyIngredientStockIn(
    items.map((i: any) => ({ ingredient_id: i.ingredient_id, quantity: Number(i.quantity_received), unit_cost: i.unit_cost })),
    req.businessId, branch_id, req.userId, 'restock', `GRN ${grn_number}`,
  );

  if (purchase_order_id) {
    const { data: poItems } = await supabase.from('purchase_order_items')
      .select('id, ingredient_id, quantity_ordered, quantity_received')
      .eq('purchase_order_id', purchase_order_id);
    if (poItems) {
      for (const poi of poItems) {
        const received = items.find((i: any) => i.ingredient_id === poi.ingredient_id);
        if (received) {
          await supabase.from('purchase_order_items')
            .update({ quantity_received: Number(poi.quantity_received) + Number(received.quantity_received) })
            .eq('id', poi.id);
        }
      }
      const { data: updated } = await supabase.from('purchase_order_items')
        .select('quantity_ordered, quantity_received').eq('purchase_order_id', purchase_order_id);
      if (updated) {
        const fullyReceived = updated.every(i => Number(i.quantity_received) >= Number(i.quantity_ordered));
        const anyReceived   = updated.some(i => Number(i.quantity_received) > 0);
        await supabase.from('purchase_orders')
          .update({ status: fullyReceived ? 'received' : anyReceived ? 'partial' : 'ordered', updated_at: new Date().toISOString() })
          .eq('id', purchase_order_id);
      }
    }
  }

  res.status(201).json({ ...grn, grn_items: lineItems });
});

// =============================================================================
// STOCK TRANSFERS  (menu products — for minimart / retail branches)
// =============================================================================

router.get('/transfers', async (req, res) => {
  const { status, branch_id, limit = '50' } = req.query as Record<string, string>;
  let query = supabase.from('stock_transfers')
    .select(`*, stock_transfer_items ( id, product_id, quantity, products ( name ) )`)
    .eq('business_id', req.businessId)
    .order('created_at', { ascending: false }).limit(Math.min(Number(limit), 200));
  if (status)    query = query.eq('status', status);
  if (branch_id) query = query.or(`from_branch_id.eq.${branch_id},to_branch_id.eq.${branch_id}`);
  const { data: transfers, error } = await query;
  if (error) { sendError(res, error); return; }
  if (transfers?.length) {
    const branchIds = [...new Set(transfers.flatMap(t => [t.from_branch_id, t.to_branch_id]))];
    const branches = await chunkIn<any>('branches', 'id', branchIds, q => q.select('id, name'));
    const bmap: Record<string, string> = {};
    (branches ?? []).forEach(b => { bmap[b.id] = b.name; });
    return res.json(transfers.map(t => ({ ...t, from_branch_name: bmap[t.from_branch_id] ?? 'Unknown', to_branch_name: bmap[t.to_branch_id] ?? 'Unknown' })));
  }
  res.json([]);
});

router.post('/transfers', async (req, res) => {
  const { from_branch_id, to_branch_id, notes, items = [] } = req.body;
  if (!from_branch_id || !to_branch_id) { res.status(400).json({ error: 'from_branch_id and to_branch_id are required' }); return; }
  if (from_branch_id === to_branch_id)  { res.status(400).json({ error: 'Source and destination branches must be different' }); return; }
  if (!items.length) { res.status(400).json({ error: 'At least one item is required' }); return; }
  const transfer_number = await nextRef('stock_transfers', 'TRF', req.businessId);
  const { data: transfer, error: tErr } = await supabase.from('stock_transfers').insert({
    business_id: req.businessId, from_branch_id, to_branch_id,
    transfer_number, status: 'received', notes: notes || null, created_by: req.userId,
  }).select().single();
  if (tErr) { sendError(res, tErr); return; }
  const lineItems = items.map((i: any) => ({ transfer_id: transfer.id, product_id: i.product_id, quantity: Number(i.quantity) }));
  const { error: itemErr } = await supabase.from('stock_transfer_items').insert(lineItems);
  if (itemErr) { sendError(res, itemErr); return; }
  await applyProductStockOut(items.map((i: any) => ({ product_id: i.product_id, quantity: Number(i.quantity) })), from_branch_id, req.userId, 'transfer_out', `Transfer ${transfer_number} → ${to_branch_id}`);
  await applyProductStockIn(items.map((i: any) => ({ product_id: i.product_id, quantity: Number(i.quantity) })), to_branch_id, req.userId, 'transfer_in', `Transfer ${transfer_number} ← ${from_branch_id}`);
  res.status(201).json({ ...transfer, stock_transfer_items: lineItems });
});

router.patch('/transfers/:id/status', async (req, res) => {
  const { status } = req.body;
  if (!['pending','in_transit','received','cancelled'].includes(status)) { res.status(400).json({ error: 'Invalid status' }); return; }
  const { data, error } = await supabase.from('stock_transfers')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', req.params.id).eq('business_id', req.businessId).select().single();
  if (error) { sendError(res, error); return; }
  res.json(data);
});

export default router;
