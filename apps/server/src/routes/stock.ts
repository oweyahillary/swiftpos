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
import { safeRouter } from '../middleware/asyncHandler';
import { requireAuth } from '../middleware/auth';
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
  createdBy: string,
  movementType: 'restock' | 'adjustment' | 'opening',
  referenceNote: string,
) {
  for (const item of items) {
    if (!item.quantity || item.quantity <= 0) continue;
    const { data: current } = await supabase
      .from('ingredients')
      .select('current_stock')
      .eq('id', item.ingredient_id)
      .eq('business_id', businessId)
      .single();
    const currentQty = Number(current?.current_stock ?? 0);
    const newQty = currentQty + item.quantity;
    const upd: Record<string, unknown> = { current_stock: newQty, updated_at: new Date().toISOString() };
    if (item.unit_cost != null) upd.unit_cost = item.unit_cost;
    await supabase.from('ingredients').update(upd).eq('id', item.ingredient_id).eq('business_id', businessId);
    await supabase.from('ingredient_stock_movements').insert({
      business_id: businessId, ingredient_id: item.ingredient_id,
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
  let query = supabase.from('ingredients').select('*')
    .eq('business_id', req.businessId)
    .order('category', { ascending: true })
    .order('name',     { ascending: true });
  if (status)   query = query.eq('status', status);
  if (category) query = query.eq('category', category);
  const { data, error } = await query;
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data ?? []);
});

router.post('/ingredients', async (req, res) => {
  const { name, category, unit, unit_cost, current_stock, reorder_level, notes } = req.body;
  if (!name?.trim()) { res.status(400).json({ error: 'name is required' }); return; }
  if (!unit?.trim()) { res.status(400).json({ error: 'unit is required' }); return; }

  const { data, error } = await supabase.from('ingredients').insert({
    business_id: req.businessId, name: name.trim(),
    category: category?.trim() || null, unit: unit.trim(),
    unit_cost: unit_cost != null ? Number(unit_cost) : null,
    current_stock: Number(current_stock ?? 0),
    reorder_level: Number(reorder_level ?? 0),
    notes: notes?.trim() || null,
  }).select().single();

  if (error) { res.status(500).json({ error: error.message }); return; }

  if (Number(current_stock ?? 0) > 0) {
    await supabase.from('ingredient_stock_movements').insert({
      business_id: req.businessId, ingredient_id: data.id,
      movement_type: 'opening', quantity_change: Number(current_stock),
      quantity_after: Number(current_stock), notes: 'Opening stock', created_by: req.userId,
    });
  }

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
  if (error) { res.status(500).json({ error: error.message }); return; }
  if (!data) { res.status(404).json({ error: 'Ingredient not found' }); return; }
  res.json(data);
});

router.post('/ingredients/:id/adjust', async (req, res) => {
  const { type, quantity, notes } = req.body as { type: 'add'|'remove'|'set'; quantity: number; notes?: string };
  if (!['add','remove','set'].includes(type)) { res.status(400).json({ error: 'type must be add, remove, or set' }); return; }
  if (quantity == null || quantity < 0)       { res.status(400).json({ error: 'quantity must be >= 0' }); return; }

  const { data: ingredient } = await supabase.from('ingredients')
    .select('current_stock').eq('id', req.params.id).eq('business_id', req.businessId).single();
  if (!ingredient) { res.status(404).json({ error: 'Ingredient not found' }); return; }

  const currentQty = Number(ingredient.current_stock);
  let newQty: number;
  let change: number;
  if (type === 'add')    { newQty = currentQty + quantity; change = quantity; }
  else if (type === 'remove') { newQty = Math.max(0, currentQty - quantity); change = newQty - currentQty; }
  else                   { newQty = quantity; change = quantity - currentQty; }

  const { data, error } = await supabase.from('ingredients')
    .update({ current_stock: newQty, updated_at: new Date().toISOString() })
    .eq('id', req.params.id).eq('business_id', req.businessId).select().single();
  if (error) { res.status(500).json({ error: error.message }); return; }

  await supabase.from('ingredient_stock_movements').insert({
    business_id: req.businessId, ingredient_id: req.params.id,
    movement_type: 'adjustment', quantity_change: change, quantity_after: newQty,
    notes: notes?.trim() || `Manual ${type}`, created_by: req.userId,
  });

  res.json(data);
});

router.get('/ingredients/:id/movements', async (req, res) => {
  const { limit = '50' } = req.query as Record<string, string>;
  const { data, error } = await supabase.from('ingredient_stock_movements')
    .select('*, users ( name )')
    .eq('ingredient_id', req.params.id).eq('business_id', req.businessId)
    .order('created_at', { ascending: false }).limit(Math.min(Number(limit), 200));
  if (error) { res.status(500).json({ error: error.message }); return; }
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
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data ?? []);
});

router.post('/suppliers', async (req, res) => {
  const { name, contact_name, email, phone, address, notes } = req.body;
  if (!name) { res.status(400).json({ error: 'name is required' }); return; }
  const { data, error } = await supabase.from('suppliers')
    .insert({ business_id: req.businessId, name, contact_name, email, phone, address, notes })
    .select().single();
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.status(201).json(data);
});

router.patch('/suppliers/:id', async (req, res) => {
  const { name, contact_name, email, phone, address, notes, status } = req.body;
  const { data, error } = await supabase.from('suppliers')
    .update({ name, contact_name, email, phone, address, notes, status, updated_at: new Date().toISOString() })
    .eq('id', req.params.id).eq('business_id', req.businessId).select().single();
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data);
});

router.delete('/suppliers/:id', async (req, res) => {
  const { error } = await supabase.from('suppliers')
    .update({ status: 'inactive', updated_at: new Date().toISOString() })
    .eq('id', req.params.id).eq('business_id', req.businessId);
  if (error) { res.status(500).json({ error: error.message }); return; }
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
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data ?? []);
});

router.get('/purchase-orders/:id', async (req, res) => {
  const { data, error } = await supabase.from('purchase_orders')
    .select(`*, suppliers ( id, name, email, phone ),
      purchase_order_items ( id, ingredient_id, quantity_ordered, unit_cost, quantity_received, ingredients ( id, name, unit ) )`)
    .eq('id', req.params.id).eq('business_id', req.businessId).single();
  if (error || !data) { res.status(404).json({ error: 'Purchase order not found' }); return; }
  res.json(data);
});

router.post('/purchase-orders', async (req, res) => {
  const { branch_id, supplier_id, order_date, expected_date, notes, items = [] } = req.body;
  if (!branch_id)    { res.status(400).json({ error: 'branch_id is required' }); return; }
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
  if (poErr) { res.status(500).json({ error: poErr.message }); return; }

  const lineItems = items.map((i: any) => ({
    purchase_order_id: po.id, ingredient_id: i.ingredient_id,
    quantity_ordered: Number(i.quantity_ordered), unit_cost: Number(i.unit_cost ?? 0), quantity_received: 0,
  }));

  const { error: itemErr } = await supabase.from('purchase_order_items').insert(lineItems);
  if (itemErr) { res.status(500).json({ error: itemErr.message }); return; }
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
  if (error) { res.status(500).json({ error: error.message }); return; }
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
  if (error) { res.status(500).json({ error: error.message }); return; }
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
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data ?? []);
});

router.post('/grn', async (req, res) => {
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
  if (grnErr) { res.status(500).json({ error: grnErr.message }); return; }

  const lineItems = items.map((i: any) => ({
    grn_id: grn.id, ingredient_id: i.ingredient_id,
    quantity_received: Number(i.quantity_received),
    unit_cost: i.unit_cost != null ? Number(i.unit_cost) : null,
    notes: i.notes || null,
  }));
  const { error: itemErr } = await supabase.from('grn_items').insert(lineItems);
  if (itemErr) { res.status(500).json({ error: itemErr.message }); return; }

  await applyIngredientStockIn(
    items.map((i: any) => ({ ingredient_id: i.ingredient_id, quantity: Number(i.quantity_received), unit_cost: i.unit_cost })),
    req.businessId, req.userId, 'restock', `GRN ${grn_number}`,
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
  if (error) { res.status(500).json({ error: error.message }); return; }
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
  if (tErr) { res.status(500).json({ error: tErr.message }); return; }
  const lineItems = items.map((i: any) => ({ transfer_id: transfer.id, product_id: i.product_id, quantity: Number(i.quantity) }));
  const { error: itemErr } = await supabase.from('stock_transfer_items').insert(lineItems);
  if (itemErr) { res.status(500).json({ error: itemErr.message }); return; }
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
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data);
});

export default router;
