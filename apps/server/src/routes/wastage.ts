/**
 * wastage.ts — A399: the wastage log (migration 123).
 *
 *   GET  /api/wastage?from=YYYY-MM-DD&to=YYYY-MM-DD   entries in the period (newest first) and the summary  inventory.waste | inventory.adjust
 *   POST /api/wastage                                  record { branch_id, reason, note, items: [{ kind, id, quantity, unit_cost?, batch_id? }],
 *                                                      client_id?, recorded_by_name?, recorded_at? } — the last three from a till (A414)
 *                                                                                                          inventory.waste | inventory.adjust
 *   POST /api/wastage/:id/void                         { reason } — the stock goes back; the entry stays    inventory.adjust
 *   GET  /api/wastage/items?branch_id=                 what can be written off at the branch: active products (stocked
 *                                                      or made to order) and ingredients, with what is held and the cost
 *
 * inventory.waste is the manager tier's (migration 123): whoever is on shift writes off what spoiled. Voiding — which
 * puts stock back — is inventory.adjust, the owner's by default. A manager sees and records only their own branch.
 * The rules (reasons, value, summary) are lib/wastage.ts.
 */
import { sendError } from '../lib/sendError';
import { safeRouter } from '../middleware/asyncHandler';
import { requireAuth } from '../middleware/auth';
import { requirePermission, requireAnyPermission, assertBranchAccess, branchScope } from '../middleware/rbac';
import { supabase } from '../lib/supabase';
import { chunkIn } from '../lib/pgQuery';
import { actor } from '../lib/actor';
import { parseAmount, cleanDate, addDays, round2 } from '../lib/payables';
import { WASTE_REASONS, cleanReason, noteProblem, wastageRef, entryValue, wastageSummary, type EntryLike } from '../lib/wastage';

const router = safeRouter();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A414: when a till recorded it — kept if it is a real time in the last 30 days and not ahead of now. */
function tillTime(v: unknown): string | null {
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  if (!Number.isFinite(t) || t > Date.now() + 5 * 60_000 || t < Date.now() - 30 * 86_400_000) return null;
  return new Date(t).toISOString();
}
router.use(requireAuth);

type Entry = EntryLike & { id: string; branch_id: string; ref: string; unit_cost: number | string | null; stock_moved: boolean;
  note: string | null; recorded_by_name: string | null; voided_by_name: string | null; void_reason: string | null };

router.get('/', requireAnyPermission('inventory.waste', 'inventory.adjust'), async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const to = cleanDate(req.query.to) ?? today;
  const from = cleanDate(req.query.from) ?? addDays(to, -6);
  if (from > to) { res.status(400).json({ error: 'The start is after the end.' }); return; }
  let q = supabase.from('wastage_entries')
    .select('id, branch_id, ref, item_kind, product_id, ingredient_id, name, quantity, unit_cost, value, stock_moved, reason, note, recorded_by_name, created_at, voided_at, voided_by_name, void_reason')
    .eq('business_id', req.businessId)
    .gte('created_at', `${from}T00:00:00`).lt('created_at', `${addDays(to, 1)}T00:00:00`)
    .order('created_at', { ascending: false }).limit(2000);
  const scoped = branchScope(req);
  if (scoped) q = q.eq('branch_id', scoped);
  const { data, error } = await q;
  if (error) { sendError(res, error); return; }
  const rows = (data ?? []) as Entry[];
  res.json({ from, to, entries: rows, summary: wastageSummary(rows), reasons: WASTE_REASONS, can_void: req.isOwner || (req.permissionKeys ?? []).includes('inventory.adjust') });
});

router.get('/items', requireAnyPermission('inventory.waste', 'inventory.adjust'), async (req, res) => {
  const branchId = branchScope(req) ?? (typeof req.query.branch_id === 'string' ? req.query.branch_id : null) ?? req.branchId;
  if (!branchId) { res.status(400).json({ error: 'Choose the branch.' }); return; }
  if (!assertBranchAccess(req, branchId)) { res.status(403).json({ error: 'That is another branch.' }); return; }
  const [{ data: prods, error }, { data: ings }] = await Promise.all([
    supabase.from('products').select('id, name, sold_by, unit_label, cost_price, track_stock')
      .eq('business_id', req.businessId).eq('status', 'active').order('name').limit(5000),
    supabase.from('ingredients').select('id, name, unit, unit_cost')
      .eq('business_id', req.businessId).eq('status', 'active').order('name').limit(5000),
  ]);
  if (error) { sendError(res, error); return; }
  const P = (prods ?? []) as Array<{ id: string; name: string; sold_by: string | null; unit_label: string | null; cost_price: number | null; track_stock: boolean }>;
  const G = (ings ?? []) as Array<{ id: string; name: string; unit: string | null; unit_cost: number | null }>;
  const pLevels = await chunkIn<{ product_id: string; quantity: number | string; qty_pieces: number | string }>(
    'stock_levels', 'product_id', P.filter((p) => p.track_stock).map((p) => p.id), (q) => q.select('product_id, quantity, qty_pieces').eq('branch_id', branchId));
  const iLevels = await chunkIn<{ ingredient_id: string; current_stock: number | string }>(
    'ingredient_stock_levels', 'ingredient_id', G.map((g) => g.id), (q) => q.select('ingredient_id, current_stock').eq('branch_id', branchId));
  const pl = new Map(pLevels.map((l) => [l.product_id, l])), il = new Map(iLevels.map((l) => [l.ingredient_id, Number(l.current_stock) || 0]));
  res.json([
    ...P.map((p) => ({ kind: 'product', id: p.id, name: p.name, unit: p.unit_label, by_piece: p.sold_by === 'piece', stocked: p.track_stock === true,
      held: p.track_stock ? Number(p.sold_by === 'piece' ? pl.get(p.id)?.qty_pieces : pl.get(p.id)?.quantity) || 0 : null,
      cost: p.cost_price === null ? null : Number(p.cost_price) })),
    ...G.map((g) => ({ kind: 'ingredient', id: g.id, name: g.name, unit: g.unit, by_piece: false, stocked: true,
      held: il.get(g.id) ?? 0, cost: g.unit_cost === null ? null : Number(g.unit_cost) })),
  ]);
});

router.post('/', requireAnyPermission('inventory.waste', 'inventory.adjust'), async (req, res) => {
  const b = (req.body ?? {}) as { branch_id?: string; reason?: string; note?: string;
    items?: Array<{ kind?: string; id?: string; quantity?: unknown; unit_cost?: unknown; batch_id?: string }>;
    client_id?: string; recorded_by_name?: string; recorded_at?: string };
  const branchId = b.branch_id || req.branchId;
  if (!branchId) { res.status(400).json({ error: 'Choose the branch.' }); return; }
  if (!assertBranchAccess(req, branchId)) { res.status(403).json({ error: 'You can only record wastage at your own branch.' }); return; }
  const { data: br } = await supabase.from('branches').select('id').eq('id', branchId).eq('business_id', req.businessId).maybeSingle();
  if (!br) { res.status(400).json({ error: 'That branch is not in this business.' }); return; }
  const reason = cleanReason(b.reason);
  if (!reason) { res.status(400).json({ error: 'Choose why it was wasted.', code: 'REASON_REQUIRED' }); return; }
  const note = typeof b.note === 'string' ? b.note.trim().slice(0, 300) : '';
  const np = noteProblem(reason, note);
  if (np) { res.status(400).json({ error: np, code: 'NOTE_REQUIRED' }); return; }
  const raw = Array.isArray(b.items) ? b.items : [];
  if (!raw.length || raw.length > 100) { res.status(400).json({ error: 'Add the items wasted (1 to 100).' }); return; }

  // A414: a till saves a write-off while offline and sends it later — with its own id, so a send repeated after a lost
  // answer is recognised and never recorded twice.
  const clientId = typeof b.client_id === 'string' && UUID.test(b.client_id) ? b.client_id : null;
  if (clientId) {
    const { data: seen } = await supabase.from('wastage_entries').select('ref, value').eq('business_id', req.businessId).eq('client_id', clientId);
    if ((seen ?? []).length) {
      const rows = seen as Array<{ ref: string; value: number | string }>;
      res.status(200).json({ ref: rows[0].ref, entries: rows.length, value: round2(rows.reduce((t, x) => t + (Number(x.value) || 0), 0)), duplicate: true });
      return;
    }
  }
  // A413: the batch an expired item came from (optional) — must be this business's, this branch's, this item's.
  const batchIds = [...new Set(raw.map((i) => i.batch_id).filter((x): x is string => typeof x === 'string' && UUID.test(x)))];
  const batchRows = batchIds.length ? await chunkIn<{ id: string; branch_id: string; product_id: string | null; ingredient_id: string | null }>(
    'stock_batches', 'id', batchIds, (q) => q.select('id, branch_id, product_id, ingredient_id').eq('business_id', req.businessId)) : [];
  const BATCH = new Map(batchRows.map((x) => [x.id, x]));

  const pIds = raw.filter((i) => i.kind === 'product').map((i) => String(i.id ?? ''));
  const iIds = raw.filter((i) => i.kind === 'ingredient').map((i) => String(i.id ?? ''));
  const prods = await chunkIn<{ id: string; name: string; sold_by: string | null; cost_price: number | null; track_stock: boolean }>(
    'products', 'id', pIds, (q) => q.select('id, name, sold_by, cost_price, track_stock').eq('business_id', req.businessId));
  const ings = await chunkIn<{ id: string; name: string; unit_cost: number | null }>(
    'ingredients', 'id', iIds, (q) => q.select('id, name, unit_cost').eq('business_id', req.businessId));
  const pLevels = await chunkIn<{ product_id: string; quantity: number | string; qty_pieces: number | string }>(
    'stock_levels', 'product_id', pIds, (q) => q.select('product_id, quantity, qty_pieces').eq('branch_id', branchId));
  const iLevels = await chunkIn<{ ingredient_id: string; current_stock: number | string }>(
    'ingredient_stock_levels', 'ingredient_id', iIds, (q) => q.select('ingredient_id, current_stock').eq('branch_id', branchId));
  const P = new Map(prods.map((p) => [p.id, p])), I = new Map(ings.map((i) => [i.id, i]));
  const pHeld = new Map(pLevels.map((l) => [l.product_id, l])), iHeld = new Map(iLevels.map((l) => [l.ingredient_id, Number(l.current_stock) || 0]));

  type Line = { item_kind: 'product' | 'ingredient'; product_id: string | null; ingredient_id: string | null; name: string;
    quantity: number; unit_cost: number | null; byPiece: boolean; moves: boolean; batch_id: string | null };
  const batchFor = (it: { batch_id?: string }, kind: 'product' | 'ingredient', id: string): string | null | 'bad' => {
    if (!it.batch_id) return null;
    const bt = BATCH.get(it.batch_id);
    if (!bt || bt.branch_id !== branchId || (kind === 'product' ? bt.product_id : bt.ingredient_id) !== id) return 'bad';
    return bt.id;
  };
  const lines: Line[] = [];
  const typedCost = (v: unknown): number | null => {
    if (v === undefined || v === null || v === '') return null;
    const n = Number(v); return Number.isFinite(n) && n >= 0 ? round2(n) : null;
  };
  for (const it of raw) {
    const qty = parseAmount(it.quantity);
    if (it.kind === 'product') {
      const p = P.get(String(it.id));
      if (!p) { res.status(400).json({ error: 'An item is not in this business\'s catalogue.' }); return; }
      const byPiece = p.sold_by === 'piece';
      if (qty === null || (byPiece && !Number.isInteger(qty))) { res.status(400).json({ error: `${p.name}: enter how many${byPiece ? ' (whole pieces)' : ''}.` }); return; }
      // A product that is not stock-tracked (made to order) is recorded for its value only — there is no level to lower.
      const moves = p.track_stock === true;
      if (moves) {
        const lvl = pHeld.get(p.id);
        const held = Number(byPiece ? lvl?.qty_pieces : lvl?.quantity) || 0;
        if (qty > held + 0.004) { res.status(409).json({ error: `${p.name}: only ${held} at this branch.`, code: 'MORE_THAN_HELD' }); return; }
      }
      const pb = batchFor(it, 'product', p.id);
      if (pb === 'bad') { res.status(400).json({ error: `${p.name}: that batch is not this item's at this branch.` }); return; }
      lines.push({ item_kind: 'product', product_id: p.id, ingredient_id: null, name: p.name, quantity: qty, byPiece, moves, batch_id: pb,
        unit_cost: typedCost(it.unit_cost) ?? (p.cost_price === null ? null : Number(p.cost_price)) });
    } else if (it.kind === 'ingredient') {
      const g = I.get(String(it.id));
      if (!g) { res.status(400).json({ error: 'An item is not in this business\'s catalogue.' }); return; }
      if (qty === null) { res.status(400).json({ error: `${g.name}: enter how much.` }); return; }
      const held = iHeld.get(g.id) ?? 0;
      if (qty > held + 0.004) { res.status(409).json({ error: `${g.name}: only ${held} at this branch.`, code: 'MORE_THAN_HELD' }); return; }
      const gb = batchFor(it, 'ingredient', g.id);
      if (gb === 'bad') { res.status(400).json({ error: `${g.name}: that batch is not this item's at this branch.` }); return; }
      lines.push({ item_kind: 'ingredient', product_id: null, ingredient_id: g.id, name: g.name, quantity: qty, byPiece: false, moves: true, batch_id: gb,
        unit_cost: typedCost(it.unit_cost) ?? (g.unit_cost === null ? null : Number(g.unit_cost)) });
    } else {
      res.status(400).json({ error: 'Each item is a product or an ingredient.' }); return;
    }
  }

  const who = await actor(req);
  // A414: from a till, the person signed in there (the till's own sign-in is the business's) and when they recorded it.
  const fromTill = req.surface === 'desktop';
  const byName = fromTill && typeof b.recorded_by_name === 'string' && b.recorded_by_name.trim() ? b.recorded_by_name.trim().slice(0, 80) : who.name;
  const at = fromTill ? tillTime(b.recorded_at) : null;
  const { data: last } = await supabase.from('wastage_entries').select('ref').eq('business_id', req.businessId)
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  const ref = wastageRef(Number(/(\d+)$/.exec((last as { ref?: string } | null)?.ref ?? '')?.[1] ?? 0));
  const { data: rows, error } = await supabase.from('wastage_entries').insert(lines.map((l) => ({
    business_id: req.businessId, branch_id: branchId, ref, item_kind: l.item_kind, product_id: l.product_id, ingredient_id: l.ingredient_id,
    name: l.name, quantity: l.quantity, unit_cost: l.unit_cost, value: entryValue(l.quantity, l.unit_cost), stock_moved: false,
    reason, note: note || null, recorded_by: who.id, recorded_by_name: byName,
    ...(at ? { created_at: at } : {}),
    // Sent only when there is one, so the web's recording works on a cloud before migration 126.
    ...(clientId ? { client_id: clientId } : {}), ...(l.batch_id ? { batch_id: l.batch_id } : {}),
  }))).select('id, product_id, ingredient_id');
  if (error) { sendError(res, error); return; }
  const ids = (rows ?? []) as Array<{ id: string; product_id: string | null; ingredient_id: string | null }>;

  // The stock leaves the branch — atomic per item, and each change names its entry.
  const failed: string[] = [];
  const moved: string[] = [];
  for (const [n, l] of lines.entries()) {
    if (!l.moves) continue;
    const entryId = ids[n]?.id;
    const text = `Wastage ${ref} — ${reason}${note ? `: ${note}` : ''}`.slice(0, 300);
    if (l.item_kind === 'product') {
      const { data: adj, error: aErr } = await supabase.rpc('adjust_product_stock', {
        p_product_id: l.product_id, p_branch_id: branchId,
        p_qty_delta: l.byPiece ? 0 : -l.quantity, p_piece_delta: l.byPiece ? -Math.round(l.quantity) : 0,
      });
      if (aErr) { failed.push(l.name); continue; }
      const row = Array.isArray(adj) ? adj[0] : adj;
      await supabase.from('stock_movements').insert({
        product_id: l.product_id, branch_id: branchId, movement_type: 'write_off', quantity_change: -l.quantity,
        quantity_after: Number(l.byPiece ? row?.qty_pieces : row?.quantity) || 0, notes: text,
        reference_type: 'wastage', reference_id: entryId, created_by: who.id,
      });
    } else {
      const { data: after, error: aErr } = await supabase.rpc('adjust_ingredient_stock', {
        p_ingredient_id: l.ingredient_id, p_branch_id: branchId, p_business_id: req.businessId, p_delta: -l.quantity,
      });
      if (aErr) { failed.push(l.name); continue; }
      await supabase.from('ingredient_stock_movements').insert({
        business_id: req.businessId, ingredient_id: l.ingredient_id, branch_id: branchId, movement_type: 'wastage',
        quantity_change: -l.quantity, quantity_after: Number(after) || 0, notes: text,
        reference_type: 'wastage', reference_id: entryId, created_by: who.id,
      });
    }
    if (entryId) moved.push(entryId);
  }
  if (moved.length) await supabase.from('wastage_entries').update({ stock_moved: true }).in('id', moved);
  if (failed.length) {
    res.status(500).json({ error: `${ref} was recorded, but stock could not be taken off for ${failed.join(', ')} — correct it on the stock screen.`, code: 'STOCK_NOT_MOVED', ref });
    return;
  }
  res.status(201).json({ ref, entries: lines.length, value: round2(lines.reduce((s, l) => s + entryValue(l.quantity, l.unit_cost), 0)) });
});

router.post('/:id/void', requirePermission('inventory.adjust'), async (req, res) => {
  const why = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 300) : '';
  if (!why) { res.status(400).json({ error: 'Say why this entry is wrong.', code: 'REASON_REQUIRED' }); return; }
  const { data } = await supabase.from('wastage_entries')
    .select('id, branch_id, ref, item_kind, product_id, ingredient_id, name, quantity, stock_moved, voided_at')
    .eq('id', req.params.id).eq('business_id', req.businessId).maybeSingle();
  const e = data as (Entry & { stock_moved: boolean }) | null;
  if (!e) { res.status(404).json({ error: 'Entry not found.' }); return; }
  if (!assertBranchAccess(req, e.branch_id)) { res.status(403).json({ error: 'That entry is at another branch.' }); return; }
  if (e.voided_at) { res.status(409).json({ error: 'That entry was already voided.', code: 'ALREADY_VOID' }); return; }
  const who = await actor(req);
  // Claim it first (only one void ever wins), then put the stock back.
  const { data: claimed, error } = await supabase.from('wastage_entries')
    .update({ voided_at: new Date().toISOString(), voided_by_name: who.name, void_reason: why })
    .eq('id', e.id).is('voided_at', null).select('id');
  if (error) { sendError(res, error); return; }
  if (!claimed?.length) { res.status(409).json({ error: 'That entry was already voided.', code: 'ALREADY_VOID' }); return; }

  if (e.stock_moved) {
    const qty = Number(e.quantity) || 0;
    const text = `Wastage ${e.ref} voided: ${why}`.slice(0, 300);
    if (e.item_kind === 'product' && e.product_id) {
      const { data: p } = await supabase.from('products').select('sold_by').eq('id', e.product_id).maybeSingle();
      const byPiece = (p as { sold_by?: string } | null)?.sold_by === 'piece';
      const { data: adj, error: aErr } = await supabase.rpc('adjust_product_stock', {
        p_product_id: e.product_id, p_branch_id: e.branch_id, p_qty_delta: byPiece ? 0 : qty, p_piece_delta: byPiece ? Math.round(qty) : 0,
      });
      if (aErr) { res.status(500).json({ error: `Voided, but the stock could not be put back for ${e.name} — correct it on the stock screen.`, code: 'STOCK_NOT_MOVED' }); return; }
      const row = Array.isArray(adj) ? adj[0] : adj;
      await supabase.from('stock_movements').insert({
        product_id: e.product_id, branch_id: e.branch_id, movement_type: 'correction', quantity_change: qty,
        quantity_after: Number(byPiece ? row?.qty_pieces : row?.quantity) || 0, notes: text,
        reference_type: 'wastage', reference_id: e.id, created_by: who.id,
      });
    } else if (e.item_kind === 'ingredient' && e.ingredient_id) {
      const { data: after, error: aErr } = await supabase.rpc('adjust_ingredient_stock', {
        p_ingredient_id: e.ingredient_id, p_branch_id: e.branch_id, p_business_id: req.businessId, p_delta: qty,
      });
      if (aErr) { res.status(500).json({ error: `Voided, but the stock could not be put back for ${e.name} — correct it on the stock screen.`, code: 'STOCK_NOT_MOVED' }); return; }
      await supabase.from('ingredient_stock_movements').insert({
        business_id: req.businessId, ingredient_id: e.ingredient_id, branch_id: e.branch_id, movement_type: 'adjustment',
        quantity_change: qty, quantity_after: Number(after) || 0, notes: text,
        reference_type: 'wastage', reference_id: e.id, created_by: who.id,
      });
    }
  }
  res.json({ ok: true, stock_back: e.stock_moved });
});

export default router;
