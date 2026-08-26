/**
 * products.ts — Extended Products Routes
 * ─────────────────────────────────────────────────────────────────────────────
 * Extends the existing products route with:
 *   GET  /api/products/plu/:code       — PLU lookup for minimart scale barcodes
 *   GET  /api/products/barcode/:code   — barcode lookup
 *   POST /api/products/bulk            — CSV bulk import (up to 500 rows)
 *   POST /api/products                 — create (extended: barcode, PLU, sold_by, is_fuel)
 *   PATCH /api/products/:id            — update (extended fields)
 *
 * DROP-IN: this file replaces apps/server/src/routes/products.ts entirely.
 */

import { Router }    from 'express';
import { sendError } from '../lib/sendError';
import { safeRouter } from '../middleware/asyncHandler';
import { requireAuth } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';
import { supabase }  from '../lib/supabase';
import { buildProductPatch, rowMatchKeys } from '../lib/productImport';
import { applyPriceOp, parsePriceOp } from '../lib/priceOps';

const router = safeRouter();
router.use(requireAuth);

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

// ── POST /api/products ────────────────────────────────────────────────────────

router.post('/', requirePermission('products.manage'), async (req, res) => {
  const {
    name, description, base_price, category_id, image_url,
    track_stock, has_variants, has_modifiers,
    barcode, plu_code, sold_by, is_fuel, fuel_unit,
    cost_price, reorder_level,
    pieces_per_unit, unit_label, source,
    tax_type, kra_item_class_code,
    is_kitchen,
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

  // Validate sold_by
  const validSoldBy = ['each', 'weight', 'volume', 'piece'];
  if (sold_by && !validSoldBy.includes(sold_by)) {
    res.status(400).json({ error: `sold_by must be one of: ${validSoldBy.join(', ')}` });
    return;
  }

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
      status:         'active',
    })
    .select('*, categories(name, color, icon)')
    .single();

  if (error) { sendError(res, error); return; }
  res.status(201).json(data);
});

// ── PATCH /api/products/:id ───────────────────────────────────────────────────

router.patch('/:id', requirePermission('products.manage'), async (req, res) => {
  const { id } = req.params;
  const {
    name, description, base_price, category_id, image_url,
    track_stock, has_variants, has_modifiers, status,
    barcode, plu_code, sold_by, is_fuel, fuel_unit,
    cost_price, reorder_level,
    pieces_per_unit, unit_label, source,
    tax_type, kra_item_class_code,
    is_kitchen,
  } = req.body;

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

router.delete('/:id', requirePermission('products.manage'), async (req, res) => {
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
router.patch('/bulk-tax/by-category', requirePermission('products.manage'), async (req, res) => {
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
router.patch('/bulk-tax/by-ids', requirePermission('products.manage'), async (req, res) => {
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
router.patch('/bulk-cost/by-ids', requirePermission('products.manage'), async (req, res) => {
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

// POST /api/products/bulk-price
// Body: { ids?: string[], category_id?: string|null, op: {type,value}, dry_run?: boolean }
// One endpoint, two modes. dry_run returns the old→new preview WITHOUT writing;
// otherwise it applies. Both compute with the same applyPriceOp, so the preview a
// user confirms is exactly what gets written. Selection is by explicit ids or one
// category — never the whole catalogue by accident.
router.post('/bulk-price', requirePermission('products.manage'), async (req, res) => {
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

router.post('/bulk', requirePermission('products.manage'), async (req, res) => {
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

  const catMap: Record<string, string> = {};
  (categories ?? []).forEach(c => { catMap[c.name.toLowerCase()] = c.id; });

  // Existing products for THIS business, with the keys we can match on: barcode,
  // a stable plu_code, and name. A re-import UPDATES the matched row rather than
  // duplicating — deletion isn't offered, so a dupe was unrecoverable by hand.
  const { data: existingProducts } = await supabase
    .from('products')
    .select('id, name, plu_code, barcode')
    .eq('business_id', req.businessId);

  const byName: Record<string, string> = {};
  const byPlu: Record<string, string> = {};
  const byBarcode: Record<string, string> = {};
  for (const pr of (existingProducts ?? []) as any[]) {
    // First wins: if the catalogue already holds two rows with the same key,
    // an import must not pick a different one on each run.
    const n = String(pr.name ?? '').trim().toLowerCase();
    const p = String(pr.plu_code ?? '').trim().toLowerCase();
    const b = String(pr.barcode ?? '').trim().toLowerCase();
    if (n && !(n in byName)) byName[n] = pr.id;
    if (p && !(p in byPlu)) byPlu[p] = pr.id;
    if (b && !(b in byBarcode)) byBarcode[b] = pr.id;
  }

  // Auto-create any category named in the file that doesn't exist yet, so a menu
  // import can introduce new sections without a separate step.
  const wantedCats = new Set<string>();
  for (const row of rows) {
    const c = (row.category_name ?? row.category ?? '').toString().trim();
    if (c && !(c.toLowerCase() in catMap)) wantedCats.add(c);
  }
  for (const name of wantedCats) {
    const { data: created } = await supabase
      .from('categories').insert({ business_id: req.businessId, name }).select('id').single();
    if (created?.id) catMap[name.toLowerCase()] = created.id;
  }

  const results = { created: 0, updated: 0, errors: [] as { row: number; error: string }[] };

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const keys = rowMatchKeys(row);

    // Match an existing product: barcode, then a stable plu_code, then name.
    const existingId =
      (keys.barcode && byBarcode[keys.barcode.toLowerCase()]) ||
      (keys.plu     && byPlu[keys.plu.toLowerCase()]) ||
      (keys.name    && byName[keys.name.toLowerCase()]) ||
      null;
    const isCreate = !existingId;

    // Category is only touched when the row actually carries one.
    const catRaw = (row.category_name ?? row.category ?? '').toString().trim();
    const categoryProvided = catRaw !== '';
    const categoryId = categoryProvided ? (catMap[catRaw.toLowerCase()] ?? null) : null;

    const built = buildProductPatch(row, { isCreate, categoryProvided, categoryId });
    if ('error' in built) { results.errors.push({ row: i + 1, error: built.error }); continue; }
    const patch = built.patch;

    if (isCreate) {
      const { data: inserted, error } = await supabase
        .from('products')
        .insert({ business_id: req.businessId, status: 'active', ...patch })
        .select('id')
        .single();
      if (error) { results.errors.push({ row: i + 1, error: error.message }); continue; }
      results.created++;
      // Register so a file that repeats a key WITHIN ITSELF updates the row it
      // just created rather than inserting a second one.
      const id = inserted?.id;
      if (id) {
        if (keys.name)    byName[keys.name.toLowerCase()] = id;
        if (keys.plu)     byPlu[keys.plu.toLowerCase()] = id;
        if (keys.barcode) byBarcode[keys.barcode.toLowerCase()] = id;
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
  }

  // Flat fields AND the summary object. The desktop Import tab reads
  // res.created / res.updated at the top level, so a nested-only response made
  // every successful import report "0 added, 0 updated".
  res.json({
    created: results.created,
    updated: results.updated,
    errors:  results.errors,
    summary: {
      total:   rows.length,
      created: results.created,
      updated: results.updated,
      failed:  results.errors.length,
    },
  });
});

export default router;
