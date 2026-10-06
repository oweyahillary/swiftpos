/**
 * batches.ts — A413: stock batches and expiry dates (migration 126; the rules are lib/batches.ts).
 *
 *   GET  /api/batches?branch_id=&soon_days=7&all=1   open batches with what is left in each (worked out oldest-expiry
 *                                                    first from the stock level), expired / expiring soon first
 *                                                    inventory.waste | inventory.adjust | inventory.receive
 *   POST /api/batches                                { branch_id, kind, id, quantity, expiry_date, batch_no } — stock
 *                                                    already on the shelf (no stock moves)      inventory.receive | inventory.adjust
 *   PATCH /api/batches/:id                           { expiry_date?, batch_no? } — fix a typo    inventory.receive | inventory.adjust
 *   POST /api/batches/:id/close                      off the list (entered by mistake)           inventory.adjust
 *
 * Batches are written as stock is received too: product restock (/api/inventory/adjust), ingredient add
 * (/api/stock/ingredients/:id/adjust) and goods-received notes (/api/stock/grn) take expiry_date and batch_no.
 * A manager sees their own branch only.
 */
import { sendError } from '../lib/sendError';
import { safeRouter } from '../middleware/asyncHandler';
import { requireAuth } from '../middleware/auth';
import { requirePermission, requireAnyPermission, assertBranchAccess, branchScope } from '../middleware/rbac';
import { supabase } from '../lib/supabase';
import { chunkIn } from '../lib/pgQuery';
import { actor } from '../lib/actor';
import { parseAmount } from '../lib/payables';
import { allocateBatches, expiryStatus, daysLeft, cleanExpiry, cleanBatchNo, expirySummary, type BatchLike } from '../lib/batches';
import { recordReceivedBatch } from '../lib/batchStore';

const router = safeRouter();
router.use(requireAuth);

type BatchRow = BatchLike & { branch_id: string; item_kind: 'product' | 'ingredient'; product_id: string | null; ingredient_id: string | null;
  batch_no: string | null; source: string; source_ref: string | null; created_by_name: string | null };

router.get('/', requireAnyPermission('inventory.waste', 'inventory.adjust', 'inventory.receive'), async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const soonDays = Math.min(90, Math.max(0, Number(req.query.soon_days ?? 7) || 7));
  const showAll = req.query.all === '1';
  const scoped = branchScope(req) ?? (typeof req.query.branch_id === 'string' && req.query.branch_id ? req.query.branch_id : null);
  if (scoped && !assertBranchAccess(req, scoped)) { res.status(403).json({ error: 'That is another branch.' }); return; }

  let q = supabase.from('stock_batches')
    .select('id, branch_id, item_kind, product_id, ingredient_id, batch_no, expiry_date, quantity_received, received_at, source, source_ref, created_by_name')
    .eq('business_id', req.businessId).is('closed_at', null).order('received_at', { ascending: true }).limit(5000);
  if (scoped) q = q.eq('branch_id', scoped);
  const { data, error } = await q;
  if (error) { sendError(res, error); return; }
  const batches = (data ?? []) as BatchRow[];

  const pIds = [...new Set(batches.filter((b) => b.product_id).map((b) => b.product_id as string))];
  const iIds = [...new Set(batches.filter((b) => b.ingredient_id).map((b) => b.ingredient_id as string))];
  const branchIds = [...new Set(batches.map((b) => b.branch_id))];
  const [prods, ings, pLevels, iLevels, brs] = await Promise.all([
    chunkIn<{ id: string; name: string; sold_by: string | null; unit_label: string | null; cost_price: number | null; pieces_per_unit: number | null }>(
      'products', 'id', pIds, (x) => x.select('id, name, sold_by, unit_label, cost_price, pieces_per_unit').eq('business_id', req.businessId)),
    chunkIn<{ id: string; name: string; unit: string | null; unit_cost: number | null }>(
      'ingredients', 'id', iIds, (x) => x.select('id, name, unit, unit_cost').eq('business_id', req.businessId)),
    chunkIn<{ product_id: string; branch_id: string; quantity: number | string; qty_pieces: number | string }>(
      'stock_levels', 'product_id', pIds, (x) => x.select('product_id, branch_id, quantity, qty_pieces')),
    chunkIn<{ ingredient_id: string; branch_id: string; current_stock: number | string }>(
      'ingredient_stock_levels', 'ingredient_id', iIds, (x) => x.select('ingredient_id, branch_id, current_stock').eq('business_id', req.businessId)),
    chunkIn<{ id: string; name: string }>('branches', 'id', branchIds, (x) => x.select('id, name').eq('business_id', req.businessId)),
  ]);
  const P = new Map(prods.map((p) => [p.id, p])), I = new Map(ings.map((g) => [g.id, g])), BR = new Map(brs.map((b) => [b.id, b.name]));
  const held = new Map<string, number>();
  for (const l of pLevels) {
    const p = P.get(l.product_id);
    held.set(`product:${l.product_id}:${l.branch_id}`, Number(p?.sold_by === 'piece' ? l.qty_pieces : l.quantity) || 0);
  }
  for (const l of iLevels) held.set(`ingredient:${l.ingredient_id}:${l.branch_id}`, Number(l.current_stock) || 0);

  // One item at one branch: lay what it holds over its batches.
  const groups = new Map<string, BatchRow[]>();
  for (const b of batches) {
    const key = `${b.item_kind}:${b.product_id ?? b.ingredient_id}:${b.branch_id}`;
    const g = groups.get(key) ?? []; g.push(b); groups.set(key, g);
  }
  const rows: any[] = [];
  const unbatched: any[] = [];
  for (const [key, group] of groups) {
    const { batches: alloc, unbatched: extra } = allocateBatches(held.get(key) ?? 0, group);
    const first = group[0];
    const item = first.item_kind === 'product' ? P.get(first.product_id as string) : I.get(first.ingredient_id as string);
    if (!item) continue;   // deleted from the catalogue
    const name = item.name;
    const unit = first.item_kind === 'product' ? ((item as any).sold_by === 'piece' ? 'pcs' : (item as any).unit_label ?? null) : (item as any).unit ?? null;
    const cost = first.item_kind === 'product'
      ? ((item as any).cost_price === null ? null : Number((item as any).cost_price) / ((item as any).sold_by === 'piece' ? Math.max(1, Number((item as any).pieces_per_unit) || 1) : 1))
      : ((item as any).unit_cost === null ? null : Number((item as any).unit_cost));
    for (const a of alloc) {
      const b = a.batch as BatchRow;
      if (!showAll && !(a.remaining > 0)) continue;
      const status = expiryStatus(b.expiry_date, today, soonDays);
      rows.push({
        id: b.id, branch_id: b.branch_id, branch_name: BR.get(b.branch_id) ?? null, kind: b.item_kind,
        item_id: b.product_id ?? b.ingredient_id, name, unit, batch_no: b.batch_no, expiry_date: b.expiry_date,
        received_at: b.received_at, quantity_received: Number(b.quantity_received), remaining: a.remaining,
        status, days_left: daysLeft(b.expiry_date, today), unit_cost: cost,
        value: cost === null ? null : Math.round(a.remaining * cost * 100) / 100,
        source: b.source, source_ref: b.source_ref, created_by_name: b.created_by_name,
      });
    }
    if (extra > 0) unbatched.push({ kind: first.item_kind, item_id: first.product_id ?? first.ingredient_id, name, unit, branch_id: first.branch_id, quantity: extra });
  }
  const rank: Record<string, number> = { expired: 0, soon: 1, ok: 2, none: 3 };
  rows.sort((x, y) => rank[x.status] - rank[y.status] || String(x.expiry_date ?? '9999').localeCompare(String(y.expiry_date ?? '9999')) || x.name.localeCompare(y.name));
  res.json({ today, soon_days: soonDays, batches: rows, unbatched, summary: expirySummary(rows),
    can_write_off: req.isOwner || (req.permissionKeys ?? []).some((k) => k === 'inventory.waste' || k === 'inventory.adjust'),
    can_close: req.isOwner || (req.permissionKeys ?? []).includes('inventory.adjust') });
});

router.post('/', requireAnyPermission('inventory.receive', 'inventory.adjust'), async (req, res) => {
  const b = (req.body ?? {}) as { branch_id?: string; kind?: string; id?: string; quantity?: unknown; expiry_date?: unknown; batch_no?: unknown };
  const branchId = b.branch_id || req.branchId;
  if (!branchId) { res.status(400).json({ error: 'Choose the branch.' }); return; }
  if (!assertBranchAccess(req, branchId)) { res.status(403).json({ error: 'You can only record batches at your own branch.' }); return; }
  const { data: br } = await supabase.from('branches').select('id').eq('id', branchId).eq('business_id', req.businessId).maybeSingle();
  if (!br) { res.status(400).json({ error: 'That branch is not in this business.' }); return; }
  const qty = parseAmount(b.quantity);
  if (qty === null) { res.status(400).json({ error: 'Enter how much is in this batch.' }); return; }
  const today = new Date().toISOString().slice(0, 10);
  const expiry = cleanExpiry(b.expiry_date, today);
  if (expiry === 'bad') { res.status(400).json({ error: 'The expiry date is not a real date.' }); return; }
  if (!expiry && !cleanBatchNo(b.batch_no)) { res.status(400).json({ error: 'Give the expiry date or the batch number.' }); return; }

  let quantity = qty;
  if (b.kind === 'product') {
    const { data: p } = await supabase.from('products').select('id, sold_by, pieces_per_unit').eq('id', String(b.id ?? '')).eq('business_id', req.businessId).maybeSingle();
    if (!p) { res.status(400).json({ error: 'That item is not in this business\'s catalogue.' }); return; }
    // Typed as the branch holds it — pieces for a by-piece product (the screen says so).
    quantity = qty;
  } else if (b.kind === 'ingredient') {
    const { data: g } = await supabase.from('ingredients').select('id').eq('id', String(b.id ?? '')).eq('business_id', req.businessId).maybeSingle();
    if (!g) { res.status(400).json({ error: 'That item is not in this business\'s catalogue.' }); return; }
  } else { res.status(400).json({ error: 'A batch is of a product or an ingredient.' }); return; }

  const out = await recordReceivedBatch({ businessId: req.businessId, branchId, kind: b.kind, itemId: String(b.id), quantity,
    expiry: expiry ?? undefined, batchNo: b.batch_no, source: 'manual', by: await actor(req) });
  if (out.ok === false) { res.status(400).json({ error: out.error }); return; }
  res.status(201).json({ id: out.id });
});

async function ownBatch(req: any, res: any): Promise<{ id: string; branch_id: string } | null> {
  const { data } = await supabase.from('stock_batches').select('id, branch_id').eq('id', req.params.id).eq('business_id', req.businessId).maybeSingle();
  const row = data as { id: string; branch_id: string } | null;
  if (!row) { res.status(404).json({ error: 'Batch not found.' }); return null; }
  if (!assertBranchAccess(req, row.branch_id)) { res.status(403).json({ error: 'That is another branch.' }); return null; }
  return row;
}

router.patch('/:id', requireAnyPermission('inventory.receive', 'inventory.adjust'), async (req, res) => {
  const row = await ownBatch(req, res); if (!row) return;
  const patch: Record<string, unknown> = {};
  if ('expiry_date' in (req.body ?? {})) {
    const e = cleanExpiry(req.body.expiry_date, new Date().toISOString().slice(0, 10));
    if (e === 'bad') { res.status(400).json({ error: 'The expiry date is not a real date.' }); return; }
    patch.expiry_date = e;
  }
  if ('batch_no' in (req.body ?? {})) patch.batch_no = cleanBatchNo(req.body.batch_no);
  if (!Object.keys(patch).length) { res.status(400).json({ error: 'Nothing to change.' }); return; }
  const { error } = await supabase.from('stock_batches').update(patch).eq('id', row.id).eq('business_id', req.businessId);
  if (error) { sendError(res, error); return; }
  res.json({ ok: true });
});

router.post('/:id/close', requirePermission('inventory.adjust'), async (req, res) => {
  const row = await ownBatch(req, res); if (!row) return;
  const who = await actor(req);
  const { error } = await supabase.from('stock_batches').update({ closed_at: new Date().toISOString(), closed_by_name: who.name })
    .eq('id', row.id).eq('business_id', req.businessId).is('closed_at', null);
  if (error) { sendError(res, error); return; }
  res.json({ ok: true });
});

export default router;
