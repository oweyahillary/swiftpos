/**
 * routes/offers.ts — A445: the offers a manager creates (the rules: lib/offers.ts, the same file the till runs).
 *
 * Owner, 2026-10-11: "a manager can create an offer i.e runs on specific days or on a certain duration"; the owner for
 * every branch or chosen branches, a manager for their own branch ("Owner all, manager own branch").
 *
 *   GET    /api/offers          every offer this person may see (not deleted), each with `editable`
 *   POST   /api/offers          create     (products.manage — those who edit the menu)
 *   PATCH  /api/offers/:id      change / switch on or off
 *   DELETE /api/offers/:id      delete (marked deleted: the tills' catalogue check sees it; sales keep naming it)
 *
 * The owner may target any of the business's branches (none = every branch). Anyone else's offer is always for their
 * own branch, and they may change only offers for exactly their branch — never a business-wide one. Every product and
 * category an offer names must be the business's own. The tills learn of a change on their 20-s catalogue check
 * (pos.ts catalogue-version reads offers.updated_at) and pull it with the menu (pos/init `offers`).
 */
import { safeRouter } from '../middleware/asyncHandler';
import { supabase } from '../lib/supabase';
import { sendError } from '../lib/sendError';
import { requireAuth } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';
import { cleanOffer, type Offer } from '../lib/offers';

const router = safeRouter();
router.use(requireAuth);

const COLS = 'id, name, kind, value, spend_type, applies_to, product_ids, category_ids, buy_qty, get_qty, get_product_id, '
  + 'min_spend, meal_items, start_date, end_date, days, start_time, end_time, branch_ids, active, created_by_name, created_at, updated_at';

type Row = Record<string, any>;

/** May this person change this offer? The owner any; anyone else only an offer for exactly their branch. */
function mayEdit(req: any, row: Row): boolean {
  if (req.isOwner) return true;
  const b = Array.isArray(row.branch_ids) ? row.branch_ids : null;
  return !!req.branchId && !!b && b.length === 1 && b[0] === req.branchId;
}

/** The columns a clean offer writes. */
function toRow(o: Offer) {
  return {
    name: o.name, kind: o.kind, value: o.value, spend_type: o.spend_type, applies_to: o.applies_to,
    product_ids: o.product_ids, category_ids: o.category_ids, buy_qty: o.buy_qty, get_qty: o.get_qty,
    get_product_id: o.get_product_id, min_spend: o.min_spend, meal_items: o.meal_items,
    start_date: o.start_date, end_date: o.end_date, days: o.days, start_time: o.start_time, end_time: o.end_time,
    branch_ids: o.branch_ids, active: o.active,
  };
}

/** Every product, category and branch the offer names belongs to this business — else the reason. */
async function foreignIds(businessId: string, o: Offer): Promise<string | null> {
  const products = [...new Set([...o.product_ids, ...(o.get_product_id ? [o.get_product_id] : []), ...o.meal_items.flatMap((m) => m.product_ids)])];
  const categories = [...new Set([...o.category_ids, ...o.meal_items.flatMap((m) => m.category_ids)])];
  const check = async (table: string, list: string[]) => {
    if (!list.length) return true;
    const { data, error } = await supabase.from(table).select('id').eq('business_id', businessId).in('id', list);
    return !error && (data ?? []).length === list.length;
  };
  if (!(await check('products', products))) return 'The offer names a product that is not on your menu.';
  if (!(await check('categories', categories))) return 'The offer names a category that is not on your menu.';
  if (o.branch_ids && !(await check('branches', o.branch_ids))) return 'The offer names a branch that is not yours.';
  return null;
}

router.get('/', async (req, res) => {
  const { data, error } = await supabase.from('offers').select(COLS)
    .eq('business_id', req.businessId).is('deleted_at', null).order('created_at', { ascending: false });
  if (error) { sendError(res, error); return; }
  const rows = ((data ?? []) as Row[]).filter((r) => req.isOwner || !r.branch_ids || (req.branchId && r.branch_ids.includes(req.branchId)));
  res.json(rows.map((r) => ({ ...r, editable: mayEdit(req, r) })));
});

router.post('/', requirePermission('products.manage'), async (req, res) => {
  const c = cleanOffer(req.body);
  if (!c.ok) { res.status(400).json({ error: (c as { error: string }).error }); return; }
  const offer = (c as { offer: Offer }).offer;
  if (!req.isOwner) {
    if (!req.branchId) { res.status(403).json({ error: 'Only the owner creates an offer for more than one branch.' }); return; }
    offer.branch_ids = [req.branchId];
  }
  const bad = await foreignIds(req.businessId!, offer);
  if (bad) { res.status(400).json({ error: bad }); return; }
  const { data: who } = req.userId
    ? await supabase.from('users').select('name').eq('id', req.userId).eq('business_id', req.businessId).maybeSingle()
    : { data: null };
  const { data, error } = await supabase.from('offers').insert({
    business_id: req.businessId, ...toRow(offer), created_by: req.userId ?? null, created_by_name: (who as any)?.name ?? null,
  }).select(COLS).single();
  if (error) { sendError(res, error); return; }
  res.status(201).json({ ...(data as Row), editable: true });
});

router.patch('/:id', requirePermission('products.manage'), async (req, res) => {
  const { data: row } = await supabase.from('offers').select(COLS)
    .eq('id', req.params.id).eq('business_id', req.businessId).is('deleted_at', null).maybeSingle();
  if (!row) { res.status(404).json({ error: 'Offer not found' }); return; }
  if (!mayEdit(req, row as Row)) { res.status(403).json({ error: 'Only the owner changes an offer that runs at more than your branch.' }); return; }
  const c = cleanOffer({ ...(row as Row), ...req.body, id: req.params.id });
  if (!c.ok) { res.status(400).json({ error: (c as { error: string }).error }); return; }
  const offer = (c as { offer: Offer }).offer;
  if (!req.isOwner) offer.branch_ids = [req.branchId!];
  const bad = await foreignIds(req.businessId!, offer);
  if (bad) { res.status(400).json({ error: bad }); return; }
  const { data, error } = await supabase.from('offers').update({ ...toRow(offer), updated_at: new Date().toISOString() })
    .eq('id', req.params.id).eq('business_id', req.businessId).select(COLS).single();
  if (error) { sendError(res, error); return; }
  res.json({ ...(data as Row), editable: true });
});

router.delete('/:id', requirePermission('products.manage'), async (req, res) => {
  const { data: row } = await supabase.from('offers').select('id, branch_ids')
    .eq('id', req.params.id).eq('business_id', req.businessId).is('deleted_at', null).maybeSingle();
  if (!row) { res.status(404).json({ error: 'Offer not found' }); return; }
  if (!mayEdit(req, row as Row)) { res.status(403).json({ error: 'Only the owner deletes an offer that runs at more than your branch.' }); return; }
  const now = new Date().toISOString();
  const { error } = await supabase.from('offers').update({ deleted_at: now, updated_at: now, active: false })
    .eq('id', req.params.id).eq('business_id', req.businessId);
  if (error) { sendError(res, error); return; }
  res.json({ ok: true });
});

export default router;

/** A445: the offers a till at `branchId` runs (pos/init) — on, not deleted, for every branch or this one. */
export async function offersForBranch(businessId: string, branchId: string | null): Promise<Row[]> {
  const { data, error } = await supabase.from('offers').select(COLS)
    .eq('business_id', businessId).eq('active', true).is('deleted_at', null);
  if (error) return [];
  return ((data ?? []) as Row[]).filter((r) => !r.branch_ids || (branchId && r.branch_ids.includes(branchId)));
}
