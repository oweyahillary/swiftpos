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
import { requirePermission, requireAnyPermission, branchScope, assertBranchAccess, allBranchAccess, branchFilter, byBranch, rowInBranches } from '../middleware/rbac';   // A550: allBranchAccess
import { branchOfBusiness, idsOfBusiness } from '../lib/branchGuard';   // A494
import type { Request, Response } from 'express';

// A490: setting up pumps and tanks, deliveries and pump state are fuel.manage (everyone held it before migration 134 —
// OPEN_BEFORE_A490). Reading the pumps and tanks also serves selling fuel and the fuel reports.
const canManageFuel = requirePermission('fuel.manage');
const canReadFuel = requireAnyPermission('fuel.manage', 'reports.fuel', 'orders.create');

// ── A494: branches and ids ────────────────────────────────────────────────────
// A tank or pump either belongs to one branch or (branch_id null) to the whole business — the POS lists the branch's
// own and the business-wide ones. Reads were the whole business's for anyone; writes took any branch, product and tank
// id. Now a manager reads and changes their branch's (and the business-wide) equipment only, the owner any of theirs,
// and every id written must be this business's.

/** The rows a caller sees: the owner all (or the chosen branch's and the business-wide), anyone else their branch's
 *  and the business-wide. */
function visible<T extends { branch_id?: string | null }>(req: Request, rows: T[] | null | undefined): T[] {
  const bf = branchFilter(req);   // A582: a partner's set too (and the business-wide equipment)
  return (rows ?? []).filter((r) => rowInBranches(bf, r.branch_id, true));
}

/** May the caller change this tank / pump? Business-wide equipment (no branch) is every branch's. */
function mayTouch(req: Request, row: { branch_id?: string | null }): boolean {
  return !row.branch_id || assertBranchAccess(req, row.branch_id);
}

/** The ids a tank / pump write names are this business's (and its branch the caller's). Answers itself; false = stop. */
async function idsOk(req: Request, res: Response, b: { branch_id?: unknown; fuel_product_id?: unknown; tank_id?: unknown }): Promise<boolean> {
  if (b.branch_id !== undefined && b.branch_id !== null && b.branch_id !== '') {
    const id = String(b.branch_id);
    if (!assertBranchAccess(req, id)) { res.status(403).json({ error: 'No access to that branch' }); return false; }
    if (!(await branchOfBusiness(req.businessId, id))) { res.status(404).json({ error: 'Branch not found in this business' }); return false; }
  } else if (b.branch_id !== undefined && !allBranchAccess(req)) {
    // Business-wide equipment serves every branch — only the owner (A550: or a partner of every branch) sets one up or
    // moves one there.
    res.status(403).json({ error: 'Only the owner sets up a tank or pump for every branch.' }); return false;
  }
  if (b.fuel_product_id && !(await idsOfBusiness('products', req.businessId, [String(b.fuel_product_id)]))) {
    res.status(400).json({ error: 'That fuel grade is not in this business\'s catalogue.' }); return false;
  }
  if (b.tank_id && !(await idsOfBusiness('fuel_tanks', req.businessId, [String(b.tank_id)]))) {
    res.status(400).json({ error: 'That tank is not this business\'s.' }); return false;
  }
  return true;
}

/** The tank / pump by id, this business's and one the caller may change — else answered (404 / 403) and null. */
async function ownRow(req: Request, res: Response, table: 'fuel_tanks' | 'pumps', what: string): Promise<{ id: string; branch_id: string | null } | null> {
  const { data } = await supabase.from(table).select('id, branch_id').eq('id', req.params.id).eq('business_id', req.businessId).maybeSingle();
  const row = data as { id: string; branch_id: string | null } | null;
  if (!row) { res.status(404).json({ error: `${what} not found` }); return null; }
  if (!mayTouch(req, row)) { res.status(403).json({ error: `That ${what.toLowerCase()} is another branch's.` }); return null; }
  return row;
}

// ── FUEL TANKS ────────────────────────────────────────────────────────────────

export const fuelTanksRouter = safeRouter();
fuelTanksRouter.use(requireAuth);

fuelTanksRouter.get('/', canReadFuel, async (req, res) => {
  const query = supabase
    .from('fuel_tanks')
    .select('*, products(id, name, base_price, fuel_unit)')
    .eq('business_id', req.businessId)
    .order('name');
  const { data, error } = await query;
  if (error) { sendError(res, error); return; }
  res.json(visible(req, data as Array<{ branch_id: string | null }>));   // A494
});

fuelTanksRouter.post('/', canManageFuel, async (req, res) => {
  const { name, fuel_product_id, capacity_litres, current_level, reorder_level, branch_id } = req.body;
  if (!name || !fuel_product_id || !capacity_litres) {
    res.status(400).json({ error: 'name, fuel_product_id, capacity_litres are required' });
    return;
  }
  if (!(await idsOk(req, res, { branch_id: branch_id ?? (allBranchAccess(req) ? null : req.branchId), fuel_product_id }))) return;   // A494
  const { data, error } = await supabase
    .from('fuel_tanks')
    .insert({
      business_id: req.businessId,
      branch_id: branch_id ?? (allBranchAccess(req) ? null : req.branchId),   // A494: a manager's tank is their branch's
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

fuelTanksRouter.patch('/:id', canManageFuel, async (req, res) => {
  const { id } = req.params;
  const { name, fuel_product_id, capacity_litres, current_level, reorder_level } = req.body;
  if (!(await ownRow(req, res, 'fuel_tanks', 'Tank'))) return;   // A494
  if (!(await idsOk(req, res, { fuel_product_id }))) return;
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

fuelTanksRouter.delete('/:id', canManageFuel, async (req, res) => {
  if (!(await ownRow(req, res, 'fuel_tanks', 'Tank'))) return;   // A494
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
fuelTanksRouter.get('/movements', canReadFuel, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
  const bf = branchFilter(req);   // A494: the caller's branch (the owner: the chosen one, or all); A582: a partner's set

  // A494: FUEL products only — this route is open to every seller (orders.create), and it listed every product's
  // sales and restocks with the level after each: a shop's whole stock, and a blind count's figures, to a cashier.
  const { data: fuel } = await supabase.from('products').select('id').eq('business_id', req.businessId).eq('is_fuel', true);
  const fuelIds = ((fuel ?? []) as Array<{ id: string }>).map((p) => p.id);
  if (!fuelIds.length) { res.json([]); return; }

  // Fetch stock movements for fuel products, joined to products for name
  let query = supabase
    .from('stock_movements')
    .select(`
      id, product_id, branch_id, movement_type, quantity_change, quantity_after,
      notes, reference_type, created_at,
      products!inner ( name, business_id )
    `)
    .eq('products.business_id', req.businessId)
    .in('product_id', fuelIds)
    .in('movement_type', ['sale', 'restock'])
    .order('created_at', { ascending: false })
    .limit(limit);

  query = byBranch(query, bf);

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

fuelTanksRouter.post('/:id/delivery', canManageFuel, async (req, res) => {
  const { id } = req.params;
  const { litres, delivery_note, supplier_id } = req.body;

  if (!litres || Number(litres) <= 0) {
    res.status(400).json({ error: 'litres must be a positive number' });
    return;
  }

  // Fetch current tank state
  const { data: tank, error: fetchErr } = await supabase
    .from('fuel_tanks')
    .select('current_level, capacity_litres, fuel_product_id, name, branch_id')
    .eq('id', id)
    .eq('business_id', req.businessId)
    .single();

  if (fetchErr || !tank) {
    res.status(404).json({ error: 'Tank not found' });
    return;
  }
  if (!mayTouch(req, tank)) { res.status(403).json({ error: 'That tank is another branch\'s.' }); return; }   // A494

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
  // NB: stock_movements has no business_id column (tenancy is via branch_id ->
  // branches.business_id). Sending one made every fuel delivery movement fail.
  const { error: movementErr } = await supabase.from('stock_movements').insert({
    product_id:     tank.fuel_product_id,
    // A494: the tank's branch — was ?branch_id=, whatever the caller named (another branch's, or another business's).
    // A business-wide tank's delivery is booked at the caller's branch (the owner's: none).
    branch_id:      tank.branch_id ?? (allBranchAccess(req) ? null : req.branchId),
    movement_type:  'restock',
    quantity_change: Number(litres),   // was incorrectly 'quantity' — silent DB fail
    quantity_after:  newLevel,
    notes:          delivery_note ?? `Fuel delivery to ${tank.name}`,
    reference_type: 'delivery',
    created_by:     req.userId,
  });
  if (movementErr) console.error('[fuel-delivery] movement log failed:', movementErr); // non-fatal

  res.json({ tank: data, delivered_litres: Number(litres), new_level: newLevel });
});

// ── PUMPS ─────────────────────────────────────────────────────────────────────

export const pumpsRouter = safeRouter();
pumpsRouter.use(requireAuth);

pumpsRouter.get('/', canReadFuel, async (req, res) => {
  // A494: a manager / cashier sees their branch's pumps and the business-wide ones; ?branch_id= is the owner's choice only.
  const branch_id = branchScope(req);
  const bf = branchFilter(req);   // A582
  let query = supabase
    .from('pumps')
    .select('*, fuel_tanks(id, name, current_level, capacity_litres)')
    .eq('business_id', req.businessId)
    .order('sort_order');
  // Include branch-specific AND business-wide (unassigned, branch_id IS NULL)
  // pumps, so a pump configured without a branch still appears on every branch's
  // POS instead of the till reading "No pumps configured". UUID-guarded because
  // this builds a PostgREST or() filter from a query param.
  if (bf.kind === 'set') {
    query = query.or(`branch_id.in.(${bf.ids.join(',')}),branch_id.is.null`);
  } else if (typeof branch_id === 'string' && /^[0-9a-fA-F-]{36}$/.test(branch_id)) {
    query = query.or(`branch_id.eq.${branch_id},branch_id.is.null`);
  }
  const { data, error } = await query;
  if (error) { sendError(res, error); return; }
  res.json(visible(req, data as Array<{ branch_id: string | null }>));   // A494: also when the branch is not a UUID
});

pumpsRouter.post('/', canManageFuel, async (req, res) => {
  const { name, fuel_product_id, tank_id, status, sort_order, branch_id } = req.body;
  if (!name) { res.status(400).json({ error: 'name is required' }); return; }
  if (!(await idsOk(req, res, { branch_id: branch_id ?? (allBranchAccess(req) ? null : req.branchId), fuel_product_id, tank_id }))) return;   // A494
  const { data, error } = await supabase
    .from('pumps')
    .insert({
      business_id:     req.businessId,
      branch_id:       branch_id ?? (allBranchAccess(req) ? null : req.branchId),   // A494
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

pumpsRouter.patch('/:id', canManageFuel, async (req, res) => {
  const { name, fuel_product_id, tank_id, status, sort_order } = req.body;
  if (!(await ownRow(req, res, 'pumps', 'Pump'))) return;   // A494
  if (!(await idsOk(req, res, { fuel_product_id, tank_id }))) return;
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

pumpsRouter.delete('/:id', canManageFuel, async (req, res) => {
  if (!(await ownRow(req, res, 'pumps', 'Pump'))) return;   // A494
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
pumpsRouter.patch('/:id/activate', canManageFuel, async (req, res) => {
  const { order_id } = req.body;
  if (!(await ownRow(req, res, 'pumps', 'Pump'))) return;   // A494

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
    const { error: linkErr } = await supabase
      .from('orders')
      .update({ pump_id: data.id })
      .eq('id', order_id)
      .eq('business_id', req.businessId);
    if (linkErr) console.error('[pump-activate] order link failed:', linkErr); // non-fatal
  }

  res.json(data);
});

// PATCH /api/pumps/:id/idle
// Called when a fuel sale is completed or cancelled — releases the pump.
pumpsRouter.patch('/:id/idle', canManageFuel, async (req, res) => {
  if (!(await ownRow(req, res, 'pumps', 'Pump'))) return;   // A494
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
