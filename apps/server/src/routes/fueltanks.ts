/**
 * fueltanks.ts — Fuel Tank & Pump Routes
 * ─────────────────────────────────────────────────────────────────────────────
 * Routes:
 *   GET    /api/fuel-tanks
 *   POST   /api/fuel-tanks
 *   PATCH  /api/fuel-tanks/:id
 *   DELETE /api/fuel-tanks/:id
 *   POST   /api/fuel-tanks/:id/delivery   — record a fuel delivery (adds to level)
 *
 *   GET    /api/pumps
 *   POST   /api/pumps
 *   PATCH  /api/pumps/:id
 *   DELETE /api/pumps/:id
 *
 * Register in routes/index.ts:
 *   import fuelTanksRoutes from './fueltanks';
 *   router.use('/fuel-tanks', fuelTanksRoutes);
 *   router.use('/pumps', pumpsRoutes);  ← exported as pumpsRouter
 */

import { Router } from 'express';
import { sendError } from '../lib/sendError';
import { safeRouter } from '../middleware/asyncHandler';
import { supabase } from '../lib/supabase';
import { requireAuth } from '../middleware/auth';

// ── FUEL TANKS ────────────────────────────────────────────────────────────────

export const fuelTanksRouter = safeRouter();
fuelTanksRouter.use(requireAuth);

fuelTanksRouter.get('/', async (req, res) => {
  const { branch_id } = req.query;
  let query = supabase
    .from('fuel_tanks')
    .select('*, products(id, name, base_price, fuel_unit)')
    .eq('business_id', req.businessId)
    .order('name');
  if (branch_id) query = query.eq('branch_id', branch_id as string);
  const { data, error } = await query;
  if (error) { sendError(res, error); return; }
  res.json(data ?? []);
});

fuelTanksRouter.post('/', async (req, res) => {
  const { name, fuel_product_id, capacity_litres, current_level, reorder_level, branch_id } = req.body;
  if (!name || !fuel_product_id || !capacity_litres) {
    res.status(400).json({ error: 'name, fuel_product_id, capacity_litres are required' });
    return;
  }
  const { data, error } = await supabase
    .from('fuel_tanks')
    .insert({
      business_id: req.businessId,
      branch_id: branch_id ?? null,
      name: name.trim(),
      fuel_product_id,
      capacity_litres: Number(capacity_litres),
      current_level: Number(current_level ?? 0),
      reorder_level: Number(reorder_level ?? 0),
    })
    .select()
    .single();
  if (error) { sendError(res, error); return; }
  res.status(201).json(data);
});

fuelTanksRouter.patch('/:id', async (req, res) => {
  const { id } = req.params;
  const { name, fuel_product_id, capacity_litres, current_level, reorder_level } = req.body;
  const updates: Record<string, unknown> = {};
  if (name !== undefined)            updates.name = name.trim();
  if (fuel_product_id !== undefined) updates.fuel_product_id = fuel_product_id;
  if (capacity_litres !== undefined) updates.capacity_litres = Number(capacity_litres);
  if (current_level !== undefined)   updates.current_level = Number(current_level);
  if (reorder_level !== undefined)   updates.reorder_level = Number(reorder_level);

  const { data, error } = await supabase
    .from('fuel_tanks')
    .update(updates)
    .eq('id', id)
    .eq('business_id', req.businessId)
    .select()
    .single();
  if (error) { sendError(res, error); return; }
  if (!data)  { res.status(404).json({ error: 'Tank not found' }); return; }
  res.json(data);
});

fuelTanksRouter.delete('/:id', async (req, res) => {
  const { error } = await supabase
    .from('fuel_tanks')
    .delete()
    .eq('id', req.params.id)
    .eq('business_id', req.businessId);
  if (error) { sendError(res, error); return; }
  res.status(204).send();
});

// Record a fuel delivery — increments current_level (capped at capacity)
// GET /api/fuel-tanks/movements — stock movement history (sales + deliveries)
fuelTanksRouter.get('/movements', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
  const { branch_id } = req.query;

  // Fetch stock movements for fuel products, joined to products for name
  let query = supabase
    .from('stock_movements')
    .select(`
      id, movement_type, quantity_change, quantity_after,
      notes, reference_type, created_at,
      products ( name )
    `)
    .eq('business_id', req.businessId)
    .in('movement_type', ['sale', 'restock'])
    .order('created_at', { ascending: false })
    .limit(limit);

  if (branch_id) query = query.eq('branch_id', branch_id as string);

  const { data: movements, error } = await query;
  if (error) { sendError(res, error); return; }

  // Enrich with tank name via fuel_product_id
  const productIds = [...new Set((movements ?? []).map(m => (m as any).products ? null : null).filter(Boolean))];
  const { data: tankRows } = await supabase
    .from('fuel_tanks')
    .select('id, name, fuel_product_id')
    .eq('business_id', req.businessId);
  const tankByProduct: Record<string, string> = {};
  (tankRows ?? []).forEach((t: any) => { tankByProduct[t.fuel_product_id] = t.name; });

  const enriched = (movements ?? []).map((m: any) => ({
    ...m,
    product_name: m.products?.name ?? null,
    tank_name:    null as string | null,  // resolved below via product join
  }));

  // Attach tank name: find tank whose fuel_product matches this movement's product_id
  // stock_movements.product_id IS the fuel_product_id on fuel_tanks
  const { data: allTanks } = await supabase
    .from('fuel_tanks').select('name, fuel_product_id').eq('business_id', req.businessId);
  const tankNameByProduct: Record<string, string> = {};
  (allTanks ?? []).forEach((t: any) => { tankNameByProduct[t.fuel_product_id] = t.name; });

  const result = enriched.map(m => ({
    ...m,
    tank_name: tankNameByProduct[(m as any).product_id] ?? null,
  }));

  res.json(result);
});

fuelTanksRouter.post('/:id/delivery', async (req, res) => {
  const { id } = req.params;
  const { litres, delivery_note, supplier_id } = req.body;

  if (!litres || Number(litres) <= 0) {
    res.status(400).json({ error: 'litres must be a positive number' });
    return;
  }

  // Fetch current tank state
  const { data: tank, error: fetchErr } = await supabase
    .from('fuel_tanks')
    .select('current_level, capacity_litres, fuel_product_id, name')
    .eq('id', id)
    .eq('business_id', req.businessId)
    .single();

  if (fetchErr || !tank) {
    res.status(404).json({ error: 'Tank not found' });
    return;
  }

  const newLevel = Math.min(
    Number(tank.current_level) + Number(litres),
    Number(tank.capacity_litres),
  );

  const { data, error: updateErr } = await supabase
    .from('fuel_tanks')
    .update({ current_level: newLevel })
    .eq('id', id)
    .select()
    .single();

  if (updateErr) { sendError(res, updateErr); return; }

  // Log the delivery as a stock movement
  await supabase.from('stock_movements').insert({
    business_id:    req.businessId,
    product_id:     tank.fuel_product_id,
    branch_id:      req.query.branch_id ?? null,
    movement_type:  'restock',
    quantity_change: Number(litres),   // was incorrectly 'quantity' — silent DB fail
    quantity_after:  newLevel,
    notes:          delivery_note ?? `Fuel delivery to ${tank.name}`,
    reference_type: 'delivery',
    created_by:     req.userId,
  }).throwOnError().catch(err => console.error('[fuel-delivery] movement log failed:', err)); // non-fatal

  res.json({ tank: data, delivered_litres: Number(litres), new_level: newLevel });
});

// ── PUMPS ─────────────────────────────────────────────────────────────────────

export const pumpsRouter = safeRouter();
pumpsRouter.use(requireAuth);

pumpsRouter.get('/', async (req, res) => {
  const { branch_id } = req.query;
  let query = supabase
    .from('pumps')
    .select('*, fuel_tanks(id, name, current_level, capacity_litres)')
    .eq('business_id', req.businessId)
    .order('sort_order');
  // Include branch-specific AND business-wide (unassigned, branch_id IS NULL)
  // pumps, so a pump configured without a branch still appears on every branch's
  // POS instead of the till reading "No pumps configured". UUID-guarded because
  // this builds a PostgREST or() filter from a query param.
  if (typeof branch_id === 'string' && /^[0-9a-fA-F-]{36}$/.test(branch_id)) {
    query = query.or(`branch_id.eq.${branch_id},branch_id.is.null`);
  }
  const { data, error } = await query;
  if (error) { sendError(res, error); return; }
  res.json(data ?? []);
});

pumpsRouter.post('/', async (req, res) => {
  const { name, fuel_product_id, tank_id, status, sort_order, branch_id } = req.body;
  if (!name) { res.status(400).json({ error: 'name is required' }); return; }
  const { data, error } = await supabase
    .from('pumps')
    .insert({
      business_id:     req.businessId,
      branch_id:       branch_id ?? null,
      name:            name.trim(),
      fuel_product_id: fuel_product_id ?? null,
      tank_id:         tank_id ?? null,
      status:          status ?? 'idle',
      sort_order:      sort_order ?? 0,
    })
    .select()
    .single();
  if (error) { sendError(res, error); return; }
  res.status(201).json(data);
});

pumpsRouter.patch('/:id', async (req, res) => {
  const { name, fuel_product_id, tank_id, status, sort_order } = req.body;
  const updates: Record<string, unknown> = {};
  if (name !== undefined)            updates.name            = name.trim();
  if (fuel_product_id !== undefined) updates.fuel_product_id = fuel_product_id ?? null;
  if (tank_id !== undefined)         updates.tank_id         = tank_id ?? null;
  if (status !== undefined)          updates.status          = status;
  if (sort_order !== undefined)      updates.sort_order      = sort_order;

  const { data, error } = await supabase
    .from('pumps')
    .update(updates)
    .eq('id', req.params.id)
    .eq('business_id', req.businessId)
    .select()
    .single();
  if (error) { sendError(res, error); return; }
  if (!data)  { res.status(404).json({ error: 'Pump not found' }); return; }
  res.json(data);
});

pumpsRouter.delete('/:id', async (req, res) => {
  const { error } = await supabase
    .from('pumps')
    .delete()
    .eq('id', req.params.id)
    .eq('business_id', req.businessId);
  if (error) { sendError(res, error); return; }
  res.status(204).send();
});

// PATCH /api/pumps/:id/activate
// Called by CashierScreen when a cashier starts a fuel sale on a pump.
// Sets status to 'dispensing'. Records which order is using this pump.
pumpsRouter.patch('/:id/activate', async (req, res) => {
  const { order_id } = req.body;

  const { data, error } = await supabase
    .from('pumps')
    .update({ status: 'dispensing', updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .eq('business_id', req.businessId)
    .neq('status', 'inactive')   // can't activate a decommissioned pump
    .select()
    .single();

  if (error) { sendError(res, error); return; }
  if (!data)  { res.status(404).json({ error: 'Pump not found or inactive' }); return; }

  // Optionally link the pump to the open order in the orders table
  if (order_id) {
    await supabase
      .from('orders')
      .update({ pump_id: data.id })
      .eq('id', order_id)
      .eq('business_id', req.businessId)
      .catch(err => console.error('[pump-activate] order link failed:', err)); // non-fatal
  }

  res.json(data);
});

// PATCH /api/pumps/:id/idle
// Called when a fuel sale is completed or cancelled — releases the pump.
pumpsRouter.patch('/:id/idle', async (req, res) => {
  const { data, error } = await supabase
    .from('pumps')
    .update({ status: 'idle', updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .eq('business_id', req.businessId)
    .select()
    .single();

  if (error) { sendError(res, error); return; }
  if (!data)  { res.status(404).json({ error: 'Pump not found' }); return; }
  res.json(data);
});

// Default export — for routes/index.ts simplicity
export default fuelTanksRouter;
