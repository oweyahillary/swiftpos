/**
 * /api/stock-takes — A394: stock take (stock count).
 *
 * Owner, 2026-10-04: "We are missing a stock take module" — "Yes the count should be blind, I would recommend freeze
 * but we leave that as a feature which the owner will decide". The rules live in lib/stockTakeRules.ts.
 *
 *   GET  /                  recent counts (a branch's, or every branch for the owner)
 *   GET  /active            the open count at a branch (null if none) — the POS banner and the manager tab
 *   POST /                  start a count                                   inventory.count
 *   GET  /:id               the count and its items — blind unless inventory.adjust
 *   POST /:id/count         record counts { counts: [{ line_id, qty }] }    inventory.count
 *   POST /:id/submit        counting → review                               inventory.count
 *   POST /:id/recount       review → counting for chosen items              inventory.adjust
 *   POST /:id/post          change stock by the differences                 inventory.adjust
 *   POST /:id/cancel        stop without changing stock                     inventory.adjust (or inventory.count while counting)
 *
 * inventory.count is the manager tier's (migration 120); inventory.adjust is the owner's by default — only the owner
 * changes a stock figure without a delivery behind it.
 */
import type { Request } from 'express';
import { sendError } from '../lib/sendError';
import { safeRouter } from '../middleware/asyncHandler';
import { requireAuth } from '../middleware/auth';
import { requirePermission, requireAnyPermission, branchScope, assertBranchAccess } from '../middleware/rbac';
import { supabase } from '../lib/supabase';
import { chunkIn } from '../lib/pgQuery';
import { actor } from '../lib/actor';
import {
  canDo, isOpen, stockTakeRef, parseCount, lateSales, lineOutcome, summarise, blindLine,
  freezeSetting, STOCK_COUNT_FREEZE_KEY, type SaleMovement,
} from '../lib/stockTakeRules';
import { openTake, may, frozenAtBranch, MAX_LINES, type TakeRow } from '../lib/stockTakeAccess';

const router = safeRouter();
router.use(requireAuth);


// ─── Helpers ──────────────────────────────────────────────────────────────────




interface LineRow {
  id: string; stock_take_id: string; item_kind: 'product' | 'ingredient';
  product_id: string | null; ingredient_id: string | null; name: string; unit: string | null; category: string | null;
  by_piece: boolean; unit_cost: number | string | null; counted_qty: number | string | null;
  expected_qty: number | string | null; counted_at: string | null; counted_by_name: string | null;
  previous_count: number | string | null; recount: boolean; late_sales: number | string | null;
  expected_final: number | string | null; variance: number | string | null; variance_value: number | string | null;
  posted_delta: number | string | null; posted_at: string | null;
}

async function loadTake(req: Request, id: string): Promise<TakeRow | null> {
  const { data } = await supabase.from('stock_takes').select('*')
    .eq('id', id).eq('business_id', req.businessId).maybeSingle();
  const take = data as TakeRow | null;
  if (!take || !assertBranchAccess(req, take.branch_id)) return null;
  return take;
}

/** Every item of a count, paged (a big shop has more items than one response carries). */
async function loadLines(takeId: string): Promise<LineRow[]> {
  const out: LineRow[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from('stock_take_lines').select('*')
      .eq('stock_take_id', takeId).order('category', { ascending: true, nullsFirst: false }).order('name', { ascending: true })
      .range(from, from + 999);
    if (error) throw error;
    out.push(...((data ?? []) as LineRow[]));
    if (!data || data.length < 1000) return out;
  }
}

/** What the system holds right now for these items at the branch (pieces for an item counted in pieces). */
async function currentLevels(branchId: string, lines: LineRow[]): Promise<Map<string, number>> {
  const levels = new Map<string, number>();
  const productIds = lines.filter((l) => l.product_id).map((l) => l.product_id as string);
  const ingredientIds = lines.filter((l) => l.ingredient_id).map((l) => l.ingredient_id as string);
  const byPiece = new Set(lines.filter((l) => l.by_piece && l.product_id).map((l) => l.product_id as string));
  const prows = await chunkIn<{ product_id: string; quantity: number | string; qty_pieces: number | string }>(
    'stock_levels', 'product_id', productIds, (q) => q.select('product_id, quantity, qty_pieces').eq('branch_id', branchId));
  for (const r of prows) levels.set(`p:${r.product_id}`, Number(byPiece.has(r.product_id) ? r.qty_pieces : r.quantity) || 0);
  const irows = await chunkIn<{ ingredient_id: string; current_stock: number | string }>(
    'ingredient_stock_levels', 'ingredient_id', ingredientIds, (q) => q.select('ingredient_id, current_stock').eq('branch_id', branchId));
  for (const r of irows) levels.set(`i:${r.ingredient_id}`, Number(r.current_stock) || 0);
  return levels;
}

const lineKey = (l: LineRow) => (l.product_id ? `p:${l.product_id}` : `i:${l.ingredient_id}`);

/**
 * Late till sales per counted item (lib/stockTakeRules.lateSales): sale movements the cloud recorded after the item
 * was counted, for orders the till made before it.
 */
async function lateSalesFor(branchId: string, lines: LineRow[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const counted = lines.filter((l) => l.counted_at && l.counted_qty !== null);
  if (!counted.length) return out;
  const since = counted.map((l) => l.counted_at as string).sort()[0];
  const pids = counted.filter((l) => l.product_id).map((l) => l.product_id as string);
  const iids = counted.filter((l) => l.ingredient_id).map((l) => l.ingredient_id as string);
  type Move = SaleMovement & { item: string };
  const moves: Move[] = [];
  const pm = await chunkIn<{ product_id: string; quantity_change: number; created_at: string; reference_id: string | null }>(
    'stock_movements', 'product_id', pids,
    (q) => q.select('product_id, quantity_change, created_at, reference_id').eq('branch_id', branchId)
      .eq('movement_type', 'sale').gt('created_at', since));
  for (const m of pm) moves.push({ ...m, item: `p:${m.product_id}` });
  const im = await chunkIn<{ ingredient_id: string; quantity_change: number; created_at: string; reference_id: string | null }>(
    'ingredient_stock_movements', 'ingredient_id', iids,
    (q) => q.select('ingredient_id, quantity_change, created_at, reference_id').eq('branch_id', branchId)
      .eq('movement_type', 'sale').gt('created_at', since));
  for (const m of im) moves.push({ ...m, item: `i:${m.ingredient_id}` });
  if (!moves.length) return out;

  const orderIds = [...new Set(moves.map((m) => m.reference_id).filter((x): x is string => !!x))];
  const orders = await chunkIn<{ id: string; created_at: string }>('orders', 'id', orderIds, (q) => q.select('id, created_at'));
  const madeAt = new Map(orders.map((o) => [o.id, o.created_at]));
  const byItem = new Map<string, Move[]>();
  for (const m of moves) { const a = byItem.get(m.item) ?? []; a.push(m); byItem.set(m.item, a); }
  for (const l of counted) {
    const late = lateSales(byItem.get(lineKey(l)) ?? [], madeAt, l.counted_at as string);
    if (late !== 0) out.set(lineKey(l), late);
  }
  return out;
}

/** The difference for every counted item, as it would be posted now (review screen) — nothing is written. */
async function preview(take: TakeRow, lines: LineRow[]): Promise<LineRow[]> {
  const late = await lateSalesFor(take.branch_id, lines);
  return lines.map((l) => {
    if (l.counted_qty === null || l.expected_qty === null) return l;
    const o = lineOutcome(Number(l.counted_qty), Number(l.expected_qty), late.get(lineKey(l)) ?? 0,
      l.unit_cost === null ? null : Number(l.unit_cost), l.by_piece);
    return { ...l, late_sales: late.get(lineKey(l)) ?? 0, expected_final: o.expectedFinal, variance: o.variance, variance_value: o.varianceValue };
  });
}

function shape(take: TakeRow, lines: LineRow[], full: boolean) {
  const summary = summarise(lines);
  return {
    ...take,
    freeze: take.freeze_sales === true,
    can_review: full,
    progress: { items: summary.items, counted: summary.counted, not_counted: summary.notCounted },
    // Blind: the difference and the totals reach only someone who may change stock.
    summary: full ? (take.summary ?? summary) : null,
    lines: full ? lines : lines.map((l) => blindLine(l as unknown as Record<string, unknown>)),
  };
}

// ─── Routes ───────────────────────────────────────────────────────────────────

router.get('/', requireAnyPermission('inventory.count', 'inventory.adjust'), async (req, res) => {
  const scoped = branchScope(req);
  let q = supabase.from('stock_takes')
    .select('id, branch_id, ref, status, freeze_sales, note, started_at, started_by_name, submitted_at, posted_at, posted_by_name, cancelled_at, summary, branches ( name )')
    .eq('business_id', req.businessId).order('started_at', { ascending: false }).limit(60);
  if (scoped) q = q.eq('branch_id', scoped);
  const { data, error } = await q;
  if (error) { sendError(res, error); return; }
  const full = may(req, 'inventory.adjust');
  res.json((data ?? []).map((t: any) => ({ ...t, freeze: t.freeze_sales === true, summary: full ? t.summary : null })));
});

router.get('/active', async (req, res) => {
  const branchId = branchScope(req) ?? (typeof req.query.branch_id === 'string' ? req.query.branch_id : null);
  if (!branchId) { res.json(null); return; }
  let take: TakeRow | null = null;
  try { take = await openTake(req.businessId, branchId); } catch { take = null; }
  if (!take) { res.json(null); return; }
  const { count: items } = await supabase.from('stock_take_lines').select('id', { count: 'exact', head: true }).eq('stock_take_id', take.id);
  const { count: left } = await supabase.from('stock_take_lines').select('id', { count: 'exact', head: true })
    .eq('stock_take_id', take.id).is('counted_qty', null);
  // The web POS refuses these at the counter (the cloud refuses them at payment too — POST /orders).
  const frozen = take.freeze_sales ? await frozenAtBranch(req.businessId, branchId) : null;
  res.json({ id: take.id, ref: take.ref, status: take.status, freeze: take.freeze_sales, started_at: take.started_at,
    started_by_name: take.started_by_name, items: items ?? 0, not_counted: left ?? 0,
    frozen_product_ids: frozen?.productIds ?? [] });
});

router.post('/', requireAnyPermission('inventory.count', 'inventory.adjust'), async (req, res) => {
  const b = (req.body ?? {}) as {
    branch_id?: string; products?: boolean; ingredients?: boolean; category_ids?: string[]; ingredient_categories?: string[];
    product_ids?: string[]; ingredient_ids?: string[]; note?: string;
  };
  const branchId = b.branch_id || req.branchId;
  if (!branchId) { res.status(400).json({ error: 'Choose the branch to count.' }); return; }
  if (!assertBranchAccess(req, branchId)) { res.status(403).json({ error: 'You can only count stock at your own branch.' }); return; }
  const { data: branch } = await supabase.from('branches').select('id, name').eq('id', branchId).eq('business_id', req.businessId).maybeSingle();
  if (!branch) { res.status(404).json({ error: 'Branch not found' }); return; }
  const wantProducts = b.products !== false;
  const wantIngredients = b.ingredients === true;
  const categoryIds = Array.isArray(b.category_ids) ? b.category_ids.filter(Boolean).map(String) : [];
  const ingCategories = Array.isArray(b.ingredient_categories) ? b.ingredient_categories.filter(Boolean).map(String) : [];
  const productIds = Array.isArray(b.product_ids) ? b.product_ids.filter(Boolean).map(String) : [];
  const ingredientIds = Array.isArray(b.ingredient_ids) ? b.ingredient_ids.filter(Boolean).map(String) : [];

  const existing = await openTake(req.businessId, branchId);
  if (existing) {
    res.status(409).json({ error: `${existing.ref} is still open at ${branch.name}. Finish or cancel it first.`, code: 'COUNT_OPEN', id: existing.id });
    return;
  }

  type NewLine = { item_kind: 'product' | 'ingredient'; product_id: string | null; ingredient_id: string | null; name: string; unit: string | null; category: string | null; by_piece: boolean; unit_cost: number | null };
  const lines: NewLine[] = [];

  if (wantProducts) {
    let q = supabase.from('products')
      .select('id, name, sold_by, unit_label, cost_price, is_fuel, categories ( name )')
      .eq('business_id', req.businessId).eq('status', 'active').eq('track_stock', true);
    if (categoryIds.length) q = q.in('category_id', categoryIds);
    if (productIds.length) q = q.in('id', productIds.slice(0, MAX_LINES));
    const { data: prods, error } = await q.limit(MAX_LINES);
    if (error) { sendError(res, error); return; }
    let list = ((prods ?? []) as Array<{ id: string; name: string; sold_by: string | null; unit_label: string | null; cost_price: number | null; is_fuel: boolean | null; categories: { name?: string } | null }>)
      .filter((p) => !p.is_fuel);   // fuel is measured in the tank (dip), not counted on a shelf
    // "Everything" (no category, no list) means what this branch actually stocks: a product with a stock row here.
    if (!categoryIds.length && !productIds.length) {
      const stocked = await chunkIn<{ product_id: string }>('stock_levels', 'product_id', list.map((p) => p.id),
        (sq) => sq.select('product_id').eq('branch_id', branchId));
      const has = new Set(stocked.map((s) => s.product_id));
      list = list.filter((p) => has.has(p.id));
    }
    for (const p of list) {
      const piece = p.sold_by === 'piece';
      lines.push({ item_kind: 'product', product_id: p.id, ingredient_id: null, name: p.name,
        unit: piece ? 'pcs' : (p.unit_label || null), category: p.categories?.name ?? null, by_piece: piece,
        unit_cost: p.cost_price === null || p.cost_price === undefined ? null : Number(p.cost_price) });
    }
  }

  if (wantIngredients) {
    let q = supabase.from('ingredients').select('id, name, unit, unit_cost, category')
      .eq('business_id', req.businessId).eq('status', 'active');
    if (ingCategories.length) q = q.in('category', ingCategories);
    if (ingredientIds.length) q = q.in('id', ingredientIds.slice(0, MAX_LINES));
    const { data: ings, error } = await q.limit(MAX_LINES);
    if (error) { sendError(res, error); return; }
    for (const i of (ings ?? []) as Array<{ id: string; name: string; unit: string | null; unit_cost: number | null; category: string | null }>) {
      lines.push({ item_kind: 'ingredient', product_id: null, ingredient_id: i.id, name: i.name, unit: i.unit,
        category: i.category, by_piece: false, unit_cost: i.unit_cost === null || i.unit_cost === undefined ? null : Number(i.unit_cost) });
    }
  }

  if (!lines.length) {
    res.status(400).json({ error: 'Nothing to count — no stocked items match. Choose categories or items, or include ingredients.', code: 'NOTHING_TO_COUNT' });
    return;
  }
  if (lines.length > MAX_LINES) { res.status(400).json({ error: `At most ${MAX_LINES} items in one count — count by category.` }); return; }

  const { data: fz } = await supabase.from('business_settings').select('value')
    .eq('business_id', req.businessId).eq('key', STOCK_COUNT_FREEZE_KEY).maybeSingle();
  const freeze = freezeSetting((fz as { value?: unknown } | null)?.value);
  const { count: prior } = await supabase.from('stock_takes').select('id', { count: 'exact', head: true }).eq('business_id', req.businessId);
  const who = await actor(req);

  const { data: take, error: tErr } = await supabase.from('stock_takes').insert({
    business_id: req.businessId, branch_id: branchId, ref: stockTakeRef(prior ?? 0), status: 'counting', freeze_sales: freeze,
    scope: { products: wantProducts, ingredients: wantIngredients, category_ids: categoryIds, ingredient_categories: ingCategories,
      product_ids: productIds.length, ingredient_ids: ingredientIds.length },
    note: typeof b.note === 'string' && b.note.trim() ? b.note.trim().slice(0, 300) : null,
    started_by: who.id, started_by_name: who.name,
  }).select('*').single();
  if (tErr) {
    // Two people pressing Start at once: the one-open-count index refuses the second.
    if ((tErr as { code?: string }).code === '23505') { res.status(409).json({ error: 'A count was just started at this branch.', code: 'COUNT_OPEN' }); return; }
    sendError(res, tErr); return;
  }
  const t = take as TakeRow;
  for (let i = 0; i < lines.length; i += 500) {
    const { error } = await supabase.from('stock_take_lines')
      .insert(lines.slice(i, i + 500).map((l) => ({ ...l, stock_take_id: t.id, business_id: req.businessId })));
    if (error) {
      await supabase.from('stock_takes').delete().eq('id', t.id);
      sendError(res, error); return;
    }
  }
  res.status(201).json({ id: t.id, ref: t.ref, items: lines.length, freeze });
});

router.get('/:id', requireAnyPermission('inventory.count', 'inventory.adjust'), async (req, res) => {
  const take = await loadTake(req, req.params.id);
  if (!take) { res.status(404).json({ error: 'Count not found' }); return; }
  let lines = await loadLines(take.id);
  const full = may(req, 'inventory.adjust');
  if (full && isOpen(take.status)) lines = await preview(take, lines);
  const { data: br } = await supabase.from('branches').select('name').eq('id', take.branch_id).maybeSingle();
  res.json({ ...shape(take, lines, full), branch_name: (br as { name?: string } | null)?.name ?? null });
});

router.post('/:id/count', requireAnyPermission('inventory.count', 'inventory.adjust'), async (req, res) => {
  const take = await loadTake(req, req.params.id);
  if (!take) { res.status(404).json({ error: 'Count not found' }); return; }
  if (!canDo(take.status, 'count')) {
    res.status(409).json({ error: take.status === 'review' ? 'This count has been handed in for review.' : 'This count is closed.', code: 'NOT_COUNTING' });
    return;
  }
  const counts = Array.isArray(req.body?.counts) ? req.body.counts as Array<{ line_id?: string; qty?: unknown }> : [];
  if (!counts.length || counts.length > 500) { res.status(400).json({ error: 'Send 1 to 500 counts.' }); return; }
  const ids = [...new Set(counts.map((c) => String(c.line_id ?? '')).filter(Boolean))];
  const rows = await chunkIn<LineRow>('stock_take_lines', 'id', ids, (q) => q.select('*').eq('stock_take_id', take.id));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const bad: string[] = [];
  const toSave: Array<{ line: LineRow; qty: number | null }> = [];
  for (const c of counts) {
    const line = byId.get(String(c.line_id ?? ''));
    if (!line) { bad.push(String(c.line_id ?? '?')); continue; }
    // An empty box clears a count typed by mistake (the item goes back to "not counted").
    if (c.qty === null || c.qty === '' || c.qty === undefined) { toSave.push({ line, qty: null }); continue; }
    const qty = parseCount(c.qty, line.by_piece);
    if (qty === null) { bad.push(line.name); continue; }
    toSave.push({ line, qty });
  }
  if (bad.length) {
    res.status(400).json({ error: `Not a count: ${bad.slice(0, 5).join(', ')} — type a number (whole pieces where counted in pieces).`, code: 'BAD_COUNT' });
    return;
  }
  // What the system holds at this moment — the blind "expected" for each item, never sent back.
  const levels = await currentLevels(take.branch_id, toSave.map((s) => s.line));
  const who = await actor(req);
  const now = new Date().toISOString();
  for (const s of toSave) {
    const patch = s.qty === null
      ? { counted_qty: null, expected_qty: null, counted_at: null, counted_by: null, counted_by_name: null }
      : { counted_qty: s.qty, expected_qty: levels.get(lineKey(s.line)) ?? 0, counted_at: now, counted_by: who.id, counted_by_name: who.name };
    const { error } = await supabase.from('stock_take_lines').update(patch).eq('id', s.line.id).eq('stock_take_id', take.id);
    if (error) { sendError(res, error); return; }
  }
  // updated_at moves so a till's 20-second check sees a counted item released from a freeze.
  await supabase.from('stock_takes').update({ updated_at: now }).eq('id', take.id);
  res.json({ saved: toSave.length, counted_at: now });
});

router.post('/:id/submit', requireAnyPermission('inventory.count', 'inventory.adjust'), async (req, res) => {
  const take = await loadTake(req, req.params.id);
  if (!take) { res.status(404).json({ error: 'Count not found' }); return; }
  if (!canDo(take.status, 'submit')) { res.status(409).json({ error: 'Only a count in progress can be handed in.', code: 'NOT_COUNTING' }); return; }
  const { count: done } = await supabase.from('stock_take_lines').select('id', { count: 'exact', head: true })
    .eq('stock_take_id', take.id).not('counted_qty', 'is', null);
  if (!done) { res.status(400).json({ error: 'Count at least one item first.', code: 'NOTHING_COUNTED' }); return; }
  const who = await actor(req);
  const now = new Date().toISOString();
  const { data, error } = await supabase.from('stock_takes')
    .update({ status: 'review', submitted_at: now, submitted_by_name: who.name, updated_at: now })
    .eq('id', take.id).eq('status', 'counting').select('id');
  if (error) { sendError(res, error); return; }
  if (!data?.length) { res.status(409).json({ error: 'The count changed — reload.', code: 'STALE' }); return; }
  res.json({ status: 'review' });
});

router.post('/:id/recount', requirePermission('inventory.adjust'), async (req, res) => {
  const take = await loadTake(req, req.params.id);
  if (!take) { res.status(404).json({ error: 'Count not found' }); return; }
  if (!canDo(take.status, 'recount')) { res.status(409).json({ error: 'Only a count under review can be sent back for a recount.', code: 'NOT_REVIEW' }); return; }
  const ids = Array.isArray(req.body?.line_ids) ? (req.body.line_ids as unknown[]).map(String).filter(Boolean) : [];
  if (!ids.length) { res.status(400).json({ error: 'Choose the items to count again.' }); return; }
  const rows = await chunkIn<LineRow>('stock_take_lines', 'id', ids, (q) => q.select('id, counted_qty').eq('stock_take_id', take.id));
  for (const r of rows) {
    // The first count is kept for the reviewer; the counter starts again blank (and blind).
    await supabase.from('stock_take_lines').update({
      previous_count: r.counted_qty, counted_qty: null, expected_qty: null, counted_at: null, counted_by: null, counted_by_name: null, recount: true,
    }).eq('id', r.id).eq('stock_take_id', take.id);
  }
  const now = new Date().toISOString();
  await supabase.from('stock_takes').update({ status: 'counting', submitted_at: null, submitted_by_name: null, updated_at: now })
    .eq('id', take.id).eq('status', 'review');
  res.json({ status: 'counting', recount: rows.length });
});

router.post('/:id/post', requirePermission('inventory.adjust'), async (req, res) => {
  const take = await loadTake(req, req.params.id);
  if (!take) { res.status(404).json({ error: 'Count not found' }); return; }
  const who = await actor(req);
  const now = new Date().toISOString();
  if (take.status === 'review') {
    // Claim it: only one press posts (a second press, or a second reviewer, finds it already posted).
    const { data: claimed, error } = await supabase.from('stock_takes')
      .update({ status: 'posted', posted_at: now, posted_by: who.id, posted_by_name: who.name, updated_at: now })
      .eq('id', take.id).eq('status', 'review').select('id');
    if (error) { sendError(res, error); return; }
    if (!claimed?.length) { res.status(409).json({ error: 'This count was just posted or changed — reload.', code: 'STALE' }); return; }
  } else if (take.status !== 'posted') {
    res.status(409).json({ error: 'Hand the count in for review before posting it.', code: 'NOT_REVIEW' });
    return;
  }

  // Posting (or finishing a post that was interrupted): every counted item not yet posted.
  const all = await loadLines(take.id);
  const pending = all.filter((l) => l.counted_qty !== null && l.expected_qty !== null && !l.posted_at);
  const late = await lateSalesFor(take.branch_id, pending);
  const failed: string[] = [];
  for (const l of pending) {
    const lateQty = late.get(lineKey(l)) ?? 0;
    const o = lineOutcome(Number(l.counted_qty), Number(l.expected_qty), lateQty, l.unit_cost === null ? null : Number(l.unit_cost), l.by_piece);
    let after: number | null = null;
    if (o.delta !== 0) {
      if (l.item_kind === 'product') {
        const { data: adj, error } = await supabase.rpc('adjust_product_stock', {
          p_product_id: l.product_id, p_branch_id: take.branch_id,
          p_qty_delta: l.by_piece ? 0 : o.delta, p_piece_delta: l.by_piece ? Math.round(o.delta) : 0,
        });
        if (error) { failed.push(l.name); continue; }
        const row = Array.isArray(adj) ? adj[0] : adj;
        after = Number(l.by_piece ? row?.qty_pieces : row?.quantity) || 0;
        await supabase.from('stock_movements').insert({
          product_id: l.product_id, branch_id: take.branch_id, movement_type: 'correction',
          quantity_change: o.delta, quantity_after: after,
          notes: `Stock take ${take.ref}: counted ${Number(l.counted_qty)}, expected ${o.expectedFinal}`,
          reference_type: 'stock_take', reference_id: take.id, created_by: who.id,
        });
      } else {
        const { data: newQty, error } = await supabase.rpc('adjust_ingredient_stock', {
          p_ingredient_id: l.ingredient_id, p_branch_id: take.branch_id, p_business_id: req.businessId, p_delta: o.delta,
        });
        if (error) { failed.push(l.name); continue; }
        after = Number(newQty) || 0;
        await supabase.from('ingredient_stock_movements').insert({
          business_id: req.businessId, ingredient_id: l.ingredient_id, branch_id: take.branch_id, movement_type: 'adjustment',
          quantity_change: o.delta, quantity_after: after,
          notes: `Stock take ${take.ref}: counted ${Number(l.counted_qty)}, expected ${o.expectedFinal}`,
          reference_type: 'stock_take', reference_id: take.id, created_by: who.id,
        });
      }
    }
    await supabase.from('stock_take_lines').update({
      late_sales: lateQty, expected_final: o.expectedFinal, variance: o.variance, variance_value: o.varianceValue,
      posted_delta: o.delta, posted_at: now,
    }).eq('id', l.id);
  }

  const final = await loadLines(take.id);
  const summary = summarise(final);
  await supabase.from('stock_takes').update({ summary, updated_at: new Date().toISOString() }).eq('id', take.id);
  if (failed.length) {
    res.status(500).json({ error: `Stock could not be changed for ${failed.slice(0, 5).join(', ')}${failed.length > 5 ? '…' : ''}. Press Post again to finish — items already posted are not changed twice.`, code: 'POST_INCOMPLETE' });
    return;
  }
  res.json({ status: 'posted', summary });
});

router.post('/:id/cancel', requireAnyPermission('inventory.count', 'inventory.adjust'), async (req, res) => {
  const take = await loadTake(req, req.params.id);
  if (!take) { res.status(404).json({ error: 'Count not found' }); return; }
  if (!canDo(take.status, 'cancel')) { res.status(409).json({ error: 'This count is already closed.', code: 'CLOSED' }); return; }
  // Someone counting may stop a count still in progress; once handed in, only someone who may change stock decides.
  if (take.status === 'review' && !may(req, 'inventory.adjust')) {
    res.status(403).json({ error: 'The count is waiting for review — ask the owner.', code: 'FORBIDDEN' });
    return;
  }
  const who = await actor(req);
  const now = new Date().toISOString();
  const { error } = await supabase.from('stock_takes')
    .update({ status: 'cancelled', cancelled_at: now, cancelled_by_name: who.name, updated_at: now })
    .eq('id', take.id).in('status', ['counting', 'review']);
  if (error) { sendError(res, error); return; }
  res.json({ status: 'cancelled' });
});

export default router;
