/**
 * products.ts — Extended Products Routes
 * ─────────────────────────────────────────────────────────────────────────────
 * Extends the existing products route with:
 *   GET  /api/products/plu/:code       — PLU lookup for minimart scale barcodes
 *   GET  /api/products/barcode/:code   — barcode lookup
 *   POST /api/products/bulk            — CSV bulk import (up to 500 rows)
 *   POST /api/products                 — create (extended: barcode, PLU, sold_by, is_fuel)
 *   PATCH /api/products/:id            — update (extended fields)
 *   POST /api/products/barcodes/generate — A571: in-store EAN-13s for products without a barcode
 *   GET|PUT /api/products/labels/settings — A571: the label designer; GET …/labels/restocked — items in a delivery
 *
 * DROP-IN: this file replaces apps/server/src/routes/products.ts entirely.
 */
import { validateLoose } from '../middleware/validate';
import { CreateProductSchema, UpdateProductSchema } from '../lib/schemas';

import { Router }    from 'express';
import { sendError } from '../lib/sendError';
import { safeRouter } from '../middleware/asyncHandler';
import { requireAuth } from '../middleware/auth';
import { requirePermission, requireAnyPermission, can, branchScope } from '../middleware/rbac';
import { lacksBarcode, nextInStoreCodes } from '../lib/barcode';                  // A571
import { cleanLabelSettings, LABEL_SETTINGS_KEY } from '../lib/labels';           // A571
import { stripCostsUnlessAllowed } from '../lib/costAccess';
import { idsOfBusiness } from '../lib/branchGuard';   // A494   // A490
import { supabase }  from '../lib/supabase';
import { buildProductPatch, rowMatchKeys, importKey } from '../lib/productImport';
import { applyPriceOp, parsePriceOp } from '../lib/priceOps';
import { cleanShowDays } from '../lib/productDays';
import { cleanMenuName, isDuplicateName, menusMissing } from '../lib/menus';   // A542: the import's `menu` column

const router = safeRouter();
router.use(requireAuth);
// A490: cost prices and margins go out only to the owner, menu.costs or reports.costs (lib/costAccess.ts).
router.use(stripCostsUnlessAllowed());

/** A490: a cost value someone without menu.costs sends is IGNORED when it is empty (their form never saw the cost —
 *  it was stripped) and refused when it is a value. */
const costSent = (v: unknown) => v !== undefined && v !== null && v !== '';
const PRODUCT_WRITE = requireAnyPermission('menu.edit', 'menu.prices', 'menu.costs');
const PRODUCT_FIELDS = ['name', 'description', 'base_price', 'category_id', 'image_url', 'track_stock', 'has_variants',
  'has_modifiers', 'status', 'barcode', 'plu_code', 'sold_by', 'is_fuel', 'fuel_unit', 'cost_price', 'reorder_level',
  'pieces_per_unit', 'unit_label', 'source', 'tax_type', 'kra_item_class_code', 'is_kitchen', 'show_days'];

// ── GET /api/products ─────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  const { category_id, is_fuel, status } = req.query;

  let query = supabase
    .from('products')
    .select('*, categories(name, color, icon)')
    .eq('business_id', req.businessId)
    .order('name');

  if (category_id) query = query.eq('category_id', category_id as string);
  if (is_fuel !== undefined) query = query.eq('is_fuel', is_fuel === 'true');
  if (status) query = query.eq('status', status as string);

  const { data, error } = await query;
  if (error) { sendError(res, error); return; }
  res.json(data ?? []);
});

// ── GET /api/products/plu/:code ───────────────────────────────────────────────
// Lookup by PLU code — used by minimart barcode scanner for weighed items.

router.get('/plu/:code', async (req, res) => {
  const { code } = req.params;

  const { data, error } = await supabase
    .from('products')
    .select('*, categories(name, color, icon)')
    .eq('business_id', req.businessId)
    .eq('plu_code', code.trim())
    .eq('status', 'active')
    .single();

  if (error || !data) {
    res.status(404).json({ error: `No product found with PLU code: ${code}` });
    return;
  }

  res.json(data);
});

// ── GET /api/products/barcode/:code ──────────────────────────────────────────
// Exact barcode lookup — used by minimart scanner for standard barcodes.

router.get('/barcode/:code', async (req, res) => {
  const { code } = req.params;

  const { data, error } = await supabase
    .from('products')
    .select('*, categories(name, color, icon)')
    .eq('business_id', req.businessId)
    .eq('barcode', code.trim())
    .eq('status', 'active')
    .single();

  if (error || !data) {
    res.status(404).json({ error: `No product found with barcode: ${code}` });
    return;
  }

  res.json(data);
});

// ── A571: barcodes and labels ─────────────────────────────────────────────────────────────────────────────────────────
// Owner, 2026-10-22: "we do not have barcode generation mechanism, what does it entail can we add it?" — then, on the
// label printer and size: "for now i cant tell what my clients will use as their printer or the label size can we do all?"

/** The business's stored barcodes, trimmed (empty ones left out). */
async function businessBarcodes(businessId: string): Promise<{ rows: Array<{ id: string; name: string; barcode: string | null; status: string }>; error: unknown }> {
  const { data, error } = await supabase.from('products').select('id, name, barcode, status').eq('business_id', businessId);
  return { rows: (data ?? []) as Array<{ id: string; name: string; barcode: string | null; status: string }>, error };
}

// POST /api/products/barcodes/generate  { product_ids?: string[], dry_run?: boolean }
// Gives every chosen product WITHOUT a barcode an in-store EAN-13 ("20" + item number + check digit, lib/barcode.ts);
// none chosen = every active product without one. A product that has a barcode is never touched — the write is
// conditional on the field still being empty, so one typed (or generated) meanwhile is kept. The unique index
// products_barcode_business_idx (business_id, barcode) makes a duplicate impossible: a clash with a concurrent
// generate re-reads the business's codes and takes the next free number. dry_run answers how many would get one.
router.post('/barcodes/generate', requirePermission('menu.edit'), async (req, res) => {
  const body = req.body ?? {};
  if (body.product_ids !== undefined && !Array.isArray(body.product_ids)) {
    res.status(400).json({ error: 'product_ids must be a list' }); return;
  }
  const ids: string[] | null = Array.isArray(body.product_ids) ? body.product_ids.map(String).filter(Boolean) : null;
  if (ids && ids.length > 5000) { res.status(400).json({ error: 'At most 5000 products at a time' }); return; }
  const wanted = ids ? new Set(ids) : null;
  const read = await businessBarcodes(req.businessId);
  if (read.error) { sendError(res, read.error); return; }
  const chosen = read.rows.filter((p) => (wanted ? wanted.has(p.id) : p.status === 'active'));
  const targets = chosen.filter((p) => lacksBarcode(p.barcode));
  if (body.dry_run === true) {
    res.json({ count: targets.length, already: chosen.length - targets.length,
      sample: nextInStoreCodes(read.rows.map((p) => p.barcode), Math.min(3, targets.length)) });
    return;
  }
  const taken = new Set(read.rows.map((p) => String(p.barcode ?? '').trim()).filter(Boolean));
  const assigned: Array<{ id: string; name: string; barcode: string }> = [];
  const kept: string[] = [];
  for (const p of targets) {
    let settled = false;
    for (let attempt = 0; attempt < 30 && !settled; attempt++) {
      const [code] = nextInStoreCodes(taken, 1);
      taken.add(code);
      let q = supabase.from('products').update({ barcode: code }).eq('id', p.id).eq('business_id', req.businessId);
      q = p.barcode == null ? q.is('barcode', null) : q.eq('barcode', p.barcode);   // still empty — never overwrite
      const { data: upd, error: uErr } = await q.select('id, barcode');
      if (uErr) {
        if ((uErr as { code?: string }).code !== '23505') { sendError(res, uErr); return; }
        // Another request took that number first: learn every code the business has now, and try the next one.
        const again = await businessBarcodes(req.businessId);
        for (const r of again.rows) { const c = String(r.barcode ?? '').trim(); if (c) taken.add(c); }
        continue;
      }
      if (!upd || (upd as unknown[]).length === 0) kept.push(p.id);   // given a barcode meanwhile: kept as it is
      else assigned.push({ id: p.id, name: p.name, barcode: code });
      settled = true;
    }
    if (!settled) { res.status(409).json({ error: 'Could not find a free barcode — try again', assigned, kept }); return; }
  }
  res.json({ assigned, kept, count: assigned.length });
});

// GET /api/products/labels/settings — the label designer (size, what is printed, the sheet), defaults filled in.
router.get('/labels/settings', async (req, res) => {
  const { data, error } = await supabase.from('business_settings').select('value')
    .eq('business_id', req.businessId).eq('key', LABEL_SETTINGS_KEY).maybeSingle();
  if (error) { sendError(res, error); return; }
  res.json(cleanLabelSettings((data as { value?: unknown } | null)?.value ?? null));
});

// PUT /api/products/labels/settings — menu.edit (whoever looks after the products); stored cleaned (lib/labels.ts).
router.put('/labels/settings', requirePermission('menu.edit'), async (req, res) => {
  const clean = cleanLabelSettings(req.body ?? {});
  const { data: existing } = await supabase.from('business_settings').select('id')
    .eq('business_id', req.businessId).eq('key', LABEL_SETTINGS_KEY).maybeSingle();
  const { error } = existing
    ? await supabase.from('business_settings').update({ value: clean, updated_at: new Date().toISOString() }).eq('id', (existing as { id: string }).id)
    : await supabase.from('business_settings').insert({ business_id: req.businessId, key: LABEL_SETTINGS_KEY, value: clean });
  if (error) { sendError(res, error); return; }
  res.json(clean);
});

// GET /api/products/labels/restocked?since=YYYY-MM-DD — "items in this delivery": the products restocked since that day
// (stock_movements 'restock'), with how many came in — one label each. (A goods-received note receives INGREDIENTS,
// never products, so a delivery of products is its restock movements.)
router.get('/labels/restocked', requirePermission('inventory.view'), async (req, res) => {
  const since = String(req.query.since ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) { res.status(400).json({ error: 'since must be a date (YYYY-MM-DD)' }); return; }
  const scoped = branchScope(req);
  let q = supabase.from('stock_movements').select('product_id, quantity_change, products!inner ( business_id )')
    .eq('products.business_id', req.businessId).eq('movement_type', 'restock').gte('created_at', `${since}T00:00:00Z`)
    .limit(5000);
  if (scoped) q = q.eq('branch_id', scoped);
  const { data, error } = await q;
  if (error) { sendError(res, error); return; }
  const qty = new Map<string, number>();
  for (const m of (data ?? []) as Array<{ product_id: string; quantity_change: number }>) {
    if (Number(m.quantity_change) > 0) qty.set(m.product_id, (qty.get(m.product_id) ?? 0) + Number(m.quantity_change));
  }
  res.json([...qty].map(([product_id, quantity]) => ({ product_id, quantity })));
});

// ── POST /api/products ────────────────────────────────────────────────────────

router.post('/', requirePermission('menu.edit'),validateLoose(CreateProductSchema), async (req, res) => {
  // A490: adding a product is menu.edit (its first price with it); a cost price with it is menu.costs.
  if (costSent(req.body?.cost_price) && !can(req, 'menu.costs')) {
    res.status(403).json({ error: 'Forbidden', detail: 'Missing permission: menu.costs' }); return;
  }
  if (!can(req, 'menu.costs')) delete req.body.cost_price;
  const {
    name, description, base_price, category_id, image_url,
    track_stock, has_variants, has_modifiers,
    barcode, plu_code, sold_by, is_fuel, fuel_unit,
    cost_price, reorder_level,
    pieces_per_unit, unit_label, source,
    tax_type, kra_item_class_code,
    is_kitchen, show_days,
  } = req.body;

  if (!name?.trim()) {
    res.status(400).json({ error: 'name is required' });
    return;
  }

  // Reject negative prices — a negative-priced product acts as an untracked,
  // permission-free discount in the cart (bypasses the Discounts workflow/audit).
  if (base_price != null && Number(base_price) < 0) {
    res.status(400).json({ error: 'Price cannot be negative' });
    return;
  }
  if (cost_price != null && Number(cost_price) < 0) {
    res.status(400).json({ error: 'Cost price cannot be negative' });
    return;
  }

  // A494: the category must be this business's (another tenant's category id was accepted as it came).
  if (category_id && !(await idsOfBusiness('categories', req.businessId, [category_id]))) {
    res.status(400).json({ error: "That category is not this business's" });
    return;
  }

  // Validate sold_by
  const validSoldBy = ['each', 'weight', 'volume', 'piece'];
  if (sold_by && !validSoldBy.includes(sold_by)) {
    res.status(400).json({ error: `sold_by must be one of: ${validSoldBy.join(', ')}` });
    return;
  }

  // 0.6.31: the days the product is on the POS grid (null = every day; lib/productDays.ts).
  const createDays = cleanShowDays(show_days);
  if (createDays === undefined) { res.status(400).json({ error: 'show_days must be a list of days (0 = Sunday … 6 = Saturday)' }); return; }

  // Check barcode uniqueness within business
  if (barcode) {
    const { data: existing } = await supabase
      .from('products')
      .select('id')
      .eq('business_id', req.businessId)
      .eq('barcode', barcode.trim())
      .single();

    if (existing) {
      res.status(409).json({ error: `Barcode ${barcode} is already assigned to another product` });
      return;
    }
  }

  const { data, error } = await supabase
    .from('products')
    .insert({
      business_id:   req.businessId,
      name:          name.trim(),
      description:   description?.trim() ?? null,
      base_price:    parseFloat(base_price) ?? 0,
      cost_price:    cost_price ? parseFloat(cost_price) : null,
      category_id:   category_id ?? null,
      image_url:     image_url ?? null,
      track_stock:   track_stock ?? true,
      has_variants:  has_variants ?? false,
      has_modifiers: has_modifiers ?? false,
      barcode:       barcode?.trim() ?? null,
      plu_code:      plu_code?.trim() ?? null,
      sold_by:        sold_by ?? 'each',
      pieces_per_unit: sold_by === 'piece' ? (parseInt(pieces_per_unit) || 1) : 1,
      unit_label:     unit_label?.trim() ?? 'pc',
      source:         source ?? 'purchased',
      is_fuel:        is_fuel ?? false,
      fuel_unit:      is_fuel ? (fuel_unit ?? 'L') : null,
      reorder_level:  reorder_level ?? null,
      tax_type:            tax_type ?? 'B',
      kra_item_class_code: kra_item_class_code?.trim() ?? null,
      show_days:      createDays,
      status:         'active',
    })
    .select('*, categories(name, color, icon)')
    .single();

  if (error) { sendError(res, error); return; }
  res.status(201).json(data);
});

// ── PATCH /api/products/:id ───────────────────────────────────────────────────

router.patch('/:id', PRODUCT_WRITE, validateLoose(UpdateProductSchema), async (req, res) => {
  const { id } = req.params;
  // A490: what the edit changes decides the key — a selling price menu.prices, a cost price menu.costs, anything else
  // menu.edit. A field sent unchanged (the form sends the whole product) changes nothing and needs nothing.
  {
    const body = req.body ?? {};
    if (!can(req, 'menu.costs') && !costSent(body.cost_price)) delete body.cost_price;
    const { data: cur } = await supabase.from('products').select('*').eq('id', id).eq('business_id', req.businessId).maybeSingle();
    if (!cur) { res.status(404).json({ error: 'Product not found' }); return; }
    const same = (k: string) => {
      const a = (cur as Record<string, unknown>)[k], b = body[k];
      if (typeof a === 'number' || k === 'base_price' || k === 'cost_price') return (a == null ? null : Number(a)) === (b == null || b === '' ? null : Number(b));
      return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
    };
    const need = new Set<string>();
    for (const k of PRODUCT_FIELDS) {
      if (body[k] === undefined || same(k)) continue;
      need.add(k === 'base_price' ? 'menu.prices' : k === 'cost_price' ? 'menu.costs' : 'menu.edit');
    }
    const missing = [...need].find((k) => !can(req, k));
    if (missing) { res.status(403).json({ error: 'Forbidden', detail: `Missing permission: ${missing}` }); return; }
  }
  const {
    name, description, base_price, category_id, image_url,
    track_stock, has_variants, has_modifiers, status,
    barcode, plu_code, sold_by, is_fuel, fuel_unit,
    cost_price, reorder_level,
    pieces_per_unit, unit_label, source,
    tax_type, kra_item_class_code,
    is_kitchen, show_days,
  } = req.body;

  // 0.6.31: the days the product is on the POS grid; null clears it (every day).
  const updateDays = show_days === undefined ? undefined : cleanShowDays(show_days);
  if (show_days !== undefined && updateDays === undefined) {
    res.status(400).json({ error: 'show_days must be a list of days (0 = Sunday … 6 = Saturday)' }); return;
  }

  // A494: the category must be this business's.
  if (category_id && !(await idsOfBusiness('categories', req.businessId, [category_id]))) {
    res.status(400).json({ error: "That category is not this business's" });
    return;
  }

  // If barcode is being changed, check uniqueness
  if (barcode) {
    const { data: conflict } = await supabase
      .from('products')
      .select('id')
      .eq('business_id', req.businessId)
      .eq('barcode', barcode.trim())
      .neq('id', id)
      .single();

    if (conflict) {
      res.status(409).json({ error: `Barcode ${barcode} is already assigned to another product` });
      return;
    }
  }

  const updates: Record<string, unknown> = {};
  if (name          !== undefined) updates.name          = name.trim();
  if (description   !== undefined) updates.description   = description?.trim() ?? null;
  if (base_price    !== undefined) updates.base_price    = parseFloat(base_price);
  if (cost_price    !== undefined) updates.cost_price    = parseFloat(cost_price);
  if (category_id   !== undefined) updates.category_id  = category_id ?? null;
  if (image_url     !== undefined) updates.image_url     = image_url ?? null;
  if (track_stock   !== undefined) updates.track_stock   = track_stock;
  if (has_variants  !== undefined) updates.has_variants  = has_variants;
  if (has_modifiers !== undefined) updates.has_modifiers = has_modifiers;
  if (status        !== undefined) updates.status        = status;
  // Tri-state (migration 38): true / false force routing, null follows the
  // category. `?? null` on purpose — sending null is how the override is
  // CLEARED, and coercing it to false would silently mean "never cook this".
  if (is_kitchen    !== undefined) updates.is_kitchen    = is_kitchen === null ? null : !!is_kitchen;
  if (show_days     !== undefined) updates.show_days     = updateDays;   // 0.6.31
  if (barcode       !== undefined) updates.barcode       = barcode?.trim() ?? null;
  if (plu_code      !== undefined) updates.plu_code      = plu_code?.trim() ?? null;
  if (sold_by           !== undefined) updates.sold_by           = sold_by;
  if (pieces_per_unit   !== undefined) updates.pieces_per_unit   = parseInt(pieces_per_unit) || 1;
  if (unit_label        !== undefined) updates.unit_label        = unit_label;
  if (source            !== undefined) updates.source            = source;
  if (is_fuel       !== undefined) updates.is_fuel       = is_fuel;
  if (fuel_unit     !== undefined) updates.fuel_unit     = fuel_unit ?? null;
  if (reorder_level !== undefined) updates.reorder_level = reorder_level ?? null;
  if (tax_type            !== undefined) updates.tax_type            = tax_type;
  if (kra_item_class_code !== undefined) updates.kra_item_class_code = kra_item_class_code?.trim() ?? null;

  const { data, error } = await supabase
    .from('products')
    .update(updates)
    .eq('id', id)
    .eq('business_id', req.businessId)
    .select('*, categories(name, color, icon)')
    .single();

  if (error) { sendError(res, error); return; }
  if (!data)  { res.status(404).json({ error: 'Product not found' }); return; }
  res.json(data);
});

// ── DELETE /api/products/:id ──────────────────────────────────────────────────

router.delete('/:id', requirePermission('menu.edit'), async (req, res) => {
  const { id } = req.params;

  // Soft delete — set status to 'inactive' (archived not in DB constraint)
  // order_items history retains product name column independently
  const { error } = await supabase
    .from('products')
    .update({ status: 'inactive' })
    .eq('id', id)
    .eq('business_id', req.businessId);

  if (error) { sendError(res, error); return; }
  res.status(204).send();
});

// ── POST /api/products/bulk ───────────────────────────────────────────────────
// Bulk CSV import — accepts parsed rows from the frontend.
// Frontend uses papaparse to parse CSV, sends rows as JSON array.
//
// Expected row shape:
//   { name, base_price, category_name?, barcode?, plu_code?,
//     sold_by?, cost_price?, track_stock?, description? }

// ── Bulk KRA tax-code assignment (eTIMS) ─────────────────────────────────────
// Two modes so a merchant can classify a whole catalogue without editing each
// product. Both validate tax_type and are strictly business-scoped.

const VALID_TAX_TYPES = ['A', 'B', 'C', 'D', 'E'];

// PATCH /api/products/bulk-tax/by-category
// Body: { category_id?: string|null, tax_type?, kra_item_class_code?, only_unset?: boolean }
// Applies to every product in the business (optionally filtered to one category).
// only_unset=true touches just products missing a class code (safe re-runs).
router.patch('/bulk-tax/by-category', requirePermission('menu.edit'), async (req, res) => {
  const { category_id, tax_type, kra_item_class_code, only_unset } = req.body ?? {};

  if (tax_type === undefined && kra_item_class_code === undefined) {
    res.status(400).json({ error: 'Provide tax_type and/or kra_item_class_code' });
    return;
  }
  if (tax_type !== undefined && !VALID_TAX_TYPES.includes(tax_type)) {
    res.status(400).json({ error: `tax_type must be one of ${VALID_TAX_TYPES.join(', ')}` });
    return;
  }

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (tax_type !== undefined)            updates.tax_type            = tax_type;
  if (kra_item_class_code !== undefined) updates.kra_item_class_code = String(kra_item_class_code).trim() || null;

  let q = supabase.from('products').update(updates).eq('business_id', req.businessId);
  if (category_id) q = q.eq('category_id', category_id);
  if (category_id === null) q = q.is('category_id', null);
  if (only_unset) q = q.is('kra_item_class_code', null);

  const { data, error } = await q.select('id');
  if (error) { sendError(res, error); return; }
  res.json({ updated: data?.length ?? 0 });
});

// PATCH /api/products/bulk-tax/by-ids
// Body: { items: [{ id, tax_type?, kra_item_class_code? }, ...] }
// Per-row codes — drives CSV import. Each id is verified to belong to the business.
router.patch('/bulk-tax/by-ids', requirePermission('menu.edit'), async (req, res) => {
  const { items } = req.body ?? {};
  if (!Array.isArray(items) || items.length === 0) {
    res.status(400).json({ error: 'items array is required' }); return;
  }
  if (items.length > 1000) {
    res.status(400).json({ error: 'Maximum 1000 rows per update' }); return;
  }

  // Resolve which of the submitted ids actually belong to this business.
  const ids = items.map((i: any) => i.id).filter(Boolean);
  const { data: owned } = await supabase
    .from('products').select('id').eq('business_id', req.businessId).in('id', ids);
  const ownedSet = new Set((owned ?? []).map((p: any) => p.id));

  const results = { updated: 0, skipped: 0, errors: [] as { id: string; error: string }[] };

  for (const item of items) {
    if (!ownedSet.has(item.id)) { results.skipped++; continue; }
    if (item.tax_type !== undefined && !VALID_TAX_TYPES.includes(item.tax_type)) {
      results.errors.push({ id: item.id, error: 'invalid tax_type' }); continue;
    }
    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (item.tax_type !== undefined)            updates.tax_type            = item.tax_type;
    if (item.kra_item_class_code !== undefined) updates.kra_item_class_code = String(item.kra_item_class_code).trim() || null;

    const { error } = await supabase
      .from('products').update(updates).eq('id', item.id).eq('business_id', req.businessId);
    if (error) results.errors.push({ id: item.id, error: error.message });
    else results.updated++;
  }

  res.json(results);
});

// PATCH /api/products/bulk-cost/by-ids
// Set cost_price on many products at once — each a different value — for the
// cost-price editor. Mirrors bulk-tax/by-ids' business scoping. cost_price is
// the unit cost that drives margin, COGS and the Menu Matrix; null/'' clears it.
router.patch('/bulk-cost/by-ids', requirePermission('menu.costs'), async (req, res) => {
  const { items } = req.body ?? {};
  if (!Array.isArray(items) || items.length === 0) {
    res.status(400).json({ error: 'items array is required' }); return;
  }
  if (items.length > 1000) {
    res.status(400).json({ error: 'Maximum 1000 rows per update' }); return;
  }

  const ids = items.map((i: any) => i.id).filter(Boolean);
  const { data: owned } = await supabase
    .from('products').select('id').eq('business_id', req.businessId).in('id', ids);
  const ownedSet = new Set((owned ?? []).map((p: any) => p.id));

  const results = { updated: 0, skipped: 0, errors: [] as { id: string; error: string }[] };

  for (const item of items) {
    if (!ownedSet.has(item.id)) { results.skipped++; continue; }
    let cost: number | null;
    if (item.cost_price === null || item.cost_price === '' || item.cost_price === undefined) {
      cost = null;
    } else {
      cost = Number(item.cost_price);
      if (!Number.isFinite(cost) || cost < 0) {
        results.errors.push({ id: item.id, error: 'invalid cost_price' }); continue;
      }
    }
    const { error } = await supabase
      .from('products')
      .update({ cost_price: cost, updated_at: new Date().toISOString() })
      .eq('id', item.id).eq('business_id', req.businessId);
    if (error) results.errors.push({ id: item.id, error: error.message });
    else results.updated++;
  }

  res.json(results);
});

// PATCH /api/products/bulk-track/by-ids
// Body: { ids: string[], track_stock: boolean }
// Turn stock tracking on/off for many existing products at once — the retro path the
// "+ New product" toggle alone did not provide (A144). Scoped to the caller's business.
router.patch('/bulk-track/by-ids', requirePermission('menu.edit'), async (req, res) => {
  const { ids, track_stock } = req.body ?? {};
  if (!Array.isArray(ids) || ids.length === 0) {
    res.status(400).json({ error: 'ids array is required' }); return;
  }
  if (ids.length > 1000) {
    res.status(400).json({ error: 'Maximum 1000 rows per update' }); return;
  }
  const { error, count } = await supabase
    .from('products')
    .update({ track_stock: track_stock === true, updated_at: new Date().toISOString() }, { count: 'exact' })
    .eq('business_id', req.businessId).in('id', ids);
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ updated: count ?? 0 });
});
// Body: { ids?: string[], category_id?: string|null, op: {type,value}, dry_run?: boolean }
// One endpoint, two modes. dry_run returns the old→new preview WITHOUT writing;
// otherwise it applies. Both compute with the same applyPriceOp, so the preview a
// user confirms is exactly what gets written. Selection is by explicit ids or one
// category — never the whole catalogue by accident.
router.post('/bulk-price', requirePermission('menu.prices'), async (req, res) => {
  const { ids, category_id, op: rawOp, dry_run } = req.body ?? {};
  const op = parsePriceOp(rawOp);
  if ('error' in op) { res.status(400).json({ error: op.error }); return; }

  const hasIds = Array.isArray(ids) && ids.length > 0;
  const hasCat = category_id !== undefined;
  if (!hasIds && !hasCat) { res.status(400).json({ error: 'select products by ids or a category_id' }); return; }

  let q = supabase.from('products').select('id, name, base_price').eq('business_id', req.businessId);
  if (hasIds)                    q = q.in('id', (ids as string[]).slice(0, 2000));
  else if (category_id === null) q = q.is('category_id', null);
  else                           q = q.eq('category_id', category_id);
  const { data: targets, error: selErr } = await q;
  if (selErr) { sendError(res, selErr); return; }

  const preview: { id: string; name: string; current: number; next?: number; error?: string }[] = [];
  for (const p of (targets ?? []) as any[]) {
    const cur = Number(p.base_price);
    const r = applyPriceOp(cur, op);
    if ('error' in r) preview.push({ id: p.id, name: p.name, current: cur, error: r.error });
    else              preview.push({ id: p.id, name: p.name, current: cur, next: r.next });
  }

  if (dry_run) {
    res.json({
      preview,
      would_update: preview.filter(r => r.next !== undefined && r.next !== r.current).length,
      errors:       preview.filter(r => r.error).length,
    });
    return;
  }

  let updated = 0;
  const errors: { id: string; error: string }[] = [];
  for (const r of preview) {
    if (r.error) { errors.push({ id: r.id, error: r.error }); continue; }
    if (r.next === undefined || r.next === r.current) continue; // no-op, don't touch
    const { error } = await supabase
      .from('products')
      .update({ base_price: r.next, updated_at: new Date().toISOString() })
      .eq('id', r.id).eq('business_id', req.businessId);
    if (error) errors.push({ id: r.id, error: error.message });
    else updated++;
  }
  res.json({ updated, errors, preview });
});

router.post('/bulk', requirePermission('menu.edit'), async (req, res) => {
  const { rows } = req.body;

  if (!Array.isArray(rows) || rows.length === 0) {
    res.status(400).json({ error: 'rows array is required' });
    return;
  }

  if (rows.length > 500) {
    res.status(400).json({ error: 'Maximum 500 rows per import' });
    return;
  }

  // Build category name → id map for this business
  const { data: categories } = await supabase
    .from('categories')
    .select('id, name')
    .eq('business_id', req.businessId);

  // 2026-10-04: compared on importKey — "Soft  Drinks" or one with a hidden space is the same category, not a new one.
  const catMap: Record<string, string> = {};
  (categories ?? []).forEach(c => { const k = importKey(c.name); if (k && !(k in catMap)) catMap[k] = c.id; });

  // Existing products for THIS business, with the keys we can match on: barcode,
  // a stable plu_code, and name. A re-import UPDATES the matched row rather than
  // duplicating — deletion isn't offered, so a dupe was unrecoverable by hand.
  //
  // 2026-10-04 (owner: "if i upload the same product it reuploads the same product"): every product, in pages (a
  // business past 1,000 products was matched against only the first 1,000); names compared on importKey (case, hidden
  // and double spaces); and an ACTIVE product wins over an archived one of the same name — the one the owner sees.
  const existingProducts: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data: page, error: pErr } = await supabase
      .from('products')
      .select('id, name, plu_code, barcode, status, created_at, category_id')
      .eq('business_id', req.businessId)
      .order('created_at', { ascending: true })
      .range(from, from + 999);
    if (pErr) { sendError(res, pErr); return; }
    existingProducts.push(...(page ?? []));
    if (!page || page.length < 1000) break;
  }
  existingProducts.sort((a, b) => Number(b.status === 'active') - Number(a.status === 'active'));   // stable: oldest first within each

  const byName: Record<string, string> = {};
  const byPlu: Record<string, string> = {};
  const byBarcode: Record<string, string> = {};
  for (const pr of existingProducts) {
    // First wins: if the catalogue already holds two rows with the same key,
    // an import must not pick a different one on each run.
    const n = importKey(pr.name);
    const p = importKey(pr.plu_code);
    const b = importKey(pr.barcode);
    if (n && !(n in byName)) byName[n] = pr.id;
    if (p && !(p in byPlu)) byPlu[p] = pr.id;
    if (b && !(b in byBarcode)) byBarcode[b] = pr.id;
  }

  // Auto-create any category named in the file that doesn't exist yet, so a menu
  // import can introduce new sections without a separate step.
  const wantedCats = new Set<string>();
  for (const row of rows) {
    const c = (row.category_name ?? row.category ?? '').toString().trim();
    if (c && !(importKey(c) in catMap)) wantedCats.add(c);
  }
  for (const name of wantedCats) {
    if (importKey(name) in catMap) continue;   // the same category spelled twice in one file
    const { data: created } = await supabase
      .from('categories').insert({ business_id: req.businessId, name }).select('id').single();
    if (created?.id) catMap[importKey(name)] = created.id;
  }

  // Match an existing product: barcode, then a stable plu_code, then name.
  const matchId = (keys: ReturnType<typeof rowMatchKeys>): string | null =>
    (keys.barcode && byBarcode[importKey(keys.barcode)]) ||
    (keys.plu     && byPlu[importKey(keys.plu)]) ||
    (keys.name    && byName[importKey(keys.name)]) ||
    null;

  // A542: an optional `menu` column (A537 — menus hold CATEGORIES, one menu per category). The row's category (or, with
  // no category in the row, the matched product's own) is put in the menu named; a menu not there yet is created (the
  // same rules as POST /api/menus: this business's, a clean name — the route is menu.edit like the menus routes); blank
  // leaves the category's menu alone; DELETE takes the category out of its menu. Two rows of one category naming
  // different menus: the first wins, the later row is refused (a per-row error, the row skipped).
  const menuCell = (row: Record<string, unknown>) => String(row?.menu ?? '').normalize('NFKC').replace(/[​-‍⁠﻿]/g, '').trim();
  const categoryOfProduct = new Map<string, string | null>(existingProducts.map((p) => [String(p.id), p.category_id ?? null]));
  const menuRowError = new Map<number, string>();
  const menuWant = new Map<string, { row: number; key: string; label: string }>();   // category id → its menu ('' = none)
  rows.forEach((row: Record<string, unknown>, i: number) => {
    const cell = menuCell(row);
    if (!cell) return;
    const catRaw = String(row.category_name ?? row.category ?? '').trim();
    let catId: string | null = catRaw ? (catMap[importKey(catRaw)] ?? null) : null;
    if (!catRaw) { const id = matchId(rowMatchKeys(row)); catId = id ? (categoryOfProduct.get(id) ?? null) : null; }
    if (!catId) { menuRowError.set(i, `menu "${cell}" needs a category — a menu holds categories, not single products`); return; }
    let key = '', label = 'DELETE';
    if (cell.toUpperCase() !== 'DELETE') {
      const n = cleanMenuName(cell);
      if (!n.ok) { menuRowError.set(i, n.error); return; }
      key = importKey(n.value); label = n.value;
    }
    const first = menuWant.get(catId);
    if (!first) menuWant.set(catId, { row: i, key, label });
    else if (first.key !== key) {
      menuRowError.set(i, `menu "${label}" clashes with row ${first.row + 1} ("${first.label}") — one menu per category; the first row wins`);
    }
  });
  const rowDone = new Set<number>();

  const results = { created: 0, updated: 0, errors: [] as { row: number; error: string }[], createdNames: [] as string[] };
  const mayCost = can(req, 'menu.costs'), mayPrice = can(req, 'menu.prices');

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const keys = rowMatchKeys(row);
    const menuErr = menuRowError.get(i);   // A542
    if (menuErr) { results.errors.push({ row: i + 1, error: menuErr }); continue; }

    const existingId = matchId(keys);
    const isCreate = !existingId;

    // Category is only touched when the row actually carries one.
    const catRaw = (row.category_name ?? row.category ?? '').toString().trim();
    const categoryProvided = catRaw !== '';
    const categoryId = categoryProvided ? (catMap[importKey(catRaw)] ?? null) : null;

    const built = buildProductPatch(row, { isCreate, categoryProvided, categoryId });
    if ('error' in built) { results.errors.push({ row: i + 1, error: built.error }); continue; }
    const patch = built.patch as Record<string, unknown>;
    // A490: the import is menu.edit; the cost column is applied only for menu.costs, and a price change to a product
    // that exists only for menu.prices (a new product takes its first price with it).
    if (!mayCost) delete patch.cost_price;
    if (!isCreate && !mayPrice) delete patch.base_price;

    if (isCreate) {
      const { data: inserted, error } = await supabase
        .from('products')
        .insert({ business_id: req.businessId, status: 'active', ...patch })
        .select('id')
        .single();
      if (error) { results.errors.push({ row: i + 1, error: error.message }); continue; }
      results.created++;
      if (keys.name) results.createdNames.push(keys.name);
      // Register so a file that repeats a key WITHIN ITSELF updates the row it
      // just created rather than inserting a second one.
      const id = inserted?.id;
      if (id) {
        if (keys.name)    byName[importKey(keys.name)] = id;
        if (keys.plu)     byPlu[importKey(keys.plu)] = id;
        if (keys.barcode) byBarcode[importKey(keys.barcode)] = id;
      }
    } else {
      const { error } = await supabase
        .from('products')
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq('id', existingId)
        .eq('business_id', req.businessId);
      if (error) { results.errors.push({ row: i + 1, error: error.message }); continue; }
      results.updated++;
    }
    rowDone.add(i);   // A542: only a row that went in decides its category's menu
  }

  // A542: the menus the file names, applied once per category (from the row that decided it, if that row went in).
  const menusCreated: string[] = [];
  const menuErrors: { row: number; error: string }[] = [];
  let categoriesMoved = 0;
  const decisions = [...menuWant.entries()].filter(([, d]) => rowDone.has(d.row));
  if (decisions.length > 0) {
    const { data: menus, error: mErr } = await supabase.from('menus').select('id, name, sort_order')
      .eq('business_id', req.businessId).is('deleted_at', null);
    const { data: cats, error: cErr } = mErr ? { data: null, error: mErr } : await supabase.from('categories')
      .select('id, menu_id').eq('business_id', req.businessId).in('id', decisions.map(([id]) => id));
    if (mErr || cErr) {
      const why = menusMissing(mErr || cErr) ? 'menus are not set up on this server yet' : String((mErr || cErr)?.message ?? 'menus could not be read');
      for (const [, d] of decisions) menuErrors.push({ row: d.row + 1, error: `menu "${d.label}" not applied — ${why}` });
    } else {
      const menuByKey = new Map<string, string>();
      let lastSort = 0;
      for (const m of (menus ?? []) as Array<{ id: string; name: string; sort_order?: number }>) {
        const k = importKey(m.name);
        if (k && !menuByKey.has(k)) menuByKey.set(k, m.id);
        lastSort = Math.max(lastSort, Number(m.sort_order) || 0);
      }
      const current = new Map<string, string | null>(((cats ?? []) as Array<{ id: string; menu_id?: string | null }>).map((c) => [c.id, c.menu_id ?? null]));
      for (const [catId, d] of decisions) {
        let target: string | null = null;
        if (d.key) {
          target = menuByKey.get(d.key) ?? null;
          if (!target) {
            const { data: made, error } = await supabase.from('menus')
              .insert({ business_id: req.businessId, name: d.label, color: null, icon: null, sort_order: ++lastSort, active: true })
              .select('id').single();
            if (error || !made?.id) {
              menuErrors.push({ row: d.row + 1, error: `menu "${d.label}" could not be created — ${isDuplicateName(error) ? 'a menu of that name already exists' : String(error?.message ?? 'no id')}` });
              continue;
            }
            target = made.id as string;
            menuByKey.set(d.key, target);
            menusCreated.push(d.label);
          }
        }
        if ((current.get(catId) ?? null) === target) continue;   // unchanged: no write, no sync entry
        const { error } = await supabase.from('categories').update({ menu_id: target })
          .eq('id', catId).eq('business_id', req.businessId);
        if (error) { menuErrors.push({ row: d.row + 1, error: `menu "${d.label}" not applied — ${error.message}` }); continue; }
        categoriesMoved++;
      }
    }
  }

  // Flat fields AND the summary object. The desktop Import tab reads
  // res.created / res.updated at the top level, so a nested-only response made
  // every successful import report "0 added, 0 updated".
  res.json({
    created: results.created,
    updated: results.updated,
    errors:  results.errors,
    // 2026-10-04: which rows became NEW products — the screen lists them, so a surprise duplicate is seen at once.
    created_names: results.createdNames,
    // A542: the `menu` column — menus it created, categories it put in (or took out of) a menu, and what it could not do.
    menus_created: menusCreated,
    categories_moved: categoriesMoved,
    menu_errors: menuErrors,
    summary: {
      total:   rows.length,
      created: results.created,
      updated: results.updated,
      failed:  results.errors.length,
    },
  });
});

export default router;
