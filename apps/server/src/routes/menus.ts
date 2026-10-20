/**
 * routes/menus.ts — A537: a business's menus (Food, Soft drinks, Alcohol, Tea …), above its categories.
 *
 * Owner, 2026-10-20: "some restaurants have different menus — food menu, non-alcoholic drinks menu, alcoholic drinks
 * menu, tea menu etc, can we include such?" Plain menus (no hours or days for now); one menu per category
 * (categories.menu_id — set through PATCH /api/categories/:id { menu_id }).
 *
 *   GET    /api/menus           the business's menus (not deleted), in order, each with how many categories it holds
 *   POST   /api/menus           { name, color?, icon?, sort_order? }                      menu.edit
 *   PATCH  /api/menus/:id       { name?, color?, icon?, sort_order?, active? }            menu.edit
 *   POST   /api/menus/reorder   { ids: [...] } — the new order (ids not this business's are ignored)   menu.edit
 *   DELETE /api/menus/:id       soft delete (deleted_at, off); its categories are left with no menu      menu.edit
 *
 * The same permission and business scoping as routes/categories.ts (menus are business-wide, like categories — "shared
 * across all branches"). Every write lands in sync_changes through the table's trigger (migration 155), so the tills take
 * the one changed menu (GET /api/pos/changes, table menus).
 */
import { safeRouter } from '../middleware/asyncHandler';
import { requireAuth } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';
import { supabase } from '../lib/supabase';
import { sendError } from '../lib/sendError';
import { cleanMenuName, cleanMenuColor, cleanMenuIcon, isDuplicateName, menusMissing } from '../lib/menus';

const router = safeRouter();
router.use(requireAuth);

const DUP = (name: string) => `A menu called "${name}" already exists`;

// GET /api/menus
router.get('/', async (req, res) => {
  const { data, error } = await supabase.from('menus').select('*')
    .eq('business_id', req.businessId).is('deleted_at', null).order('sort_order', { ascending: true });
  if (error) {
    if (menusMissing(error)) { res.json([]); return; }   // before migration 155: no menus yet
    sendError(res, error); return;
  }
  const { data: cats } = await supabase.from('categories').select('id, menu_id').eq('business_id', req.businessId);
  const count = new Map<string, number>();
  for (const c of (cats ?? []) as Array<{ menu_id?: string | null }>) if (c.menu_id) count.set(c.menu_id, (count.get(c.menu_id) ?? 0) + 1);
  res.json(((data ?? []) as Array<Record<string, unknown>>).map((m) => ({ ...m, category_count: count.get(String(m.id)) ?? 0 })));
});

// POST /api/menus
router.post('/', requirePermission('menu.edit'), async (req, res) => {
  const name = cleanMenuName(req.body?.name);
  if (!name.ok) { res.status(400).json({ error: name.error }); return; }
  const color = cleanMenuColor(req.body?.color);
  if (!color.ok) { res.status(400).json({ error: color.error }); return; }
  const icon = cleanMenuIcon(req.body?.icon);
  if (!icon.ok) { res.status(400).json({ error: icon.error }); return; }
  let sort = Number.isInteger(req.body?.sort_order) && req.body.sort_order >= 0 ? Number(req.body.sort_order) : null;
  if (sort === null) {
    const { data: last } = await supabase.from('menus').select('sort_order').eq('business_id', req.businessId)
      .is('deleted_at', null).order('sort_order', { ascending: false }).limit(1).maybeSingle();
    sort = (Number((last as { sort_order?: number } | null)?.sort_order) || 0) + 1;
  }
  const { data, error } = await supabase.from('menus')
    .insert({ business_id: req.businessId, name: name.value, color: color.value, icon: icon.value, sort_order: sort, active: true })
    .select().single();
  if (error) {
    if (isDuplicateName(error)) { res.status(409).json({ error: DUP(name.value) }); return; }
    sendError(res, error); return;
  }
  res.status(201).json({ ...data, category_count: 0 });
});

// POST /api/menus/reorder — before /:id so "reorder" is never read as an id.
router.post('/reorder', requirePermission('menu.edit'), async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? (req.body.ids as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 200) : null;
  if (!ids || ids.length === 0) { res.status(400).json({ error: 'ids must be the menus in their new order' }); return; }
  const { data: mine, error } = await supabase.from('menus').select('id, sort_order').eq('business_id', req.businessId).is('deleted_at', null);
  if (error) { sendError(res, error); return; }
  const have = new Map(((mine ?? []) as Array<{ id: string; sort_order: number }>).map((m) => [m.id, m.sort_order]));
  let n = 0;
  for (const [i, id] of ids.filter((x) => have.has(x)).entries()) {
    if (have.get(id) === i + 1) continue;   // unchanged: no write, no sync entry
    const { error: e } = await supabase.from('menus').update({ sort_order: i + 1 }).eq('id', id).eq('business_id', req.businessId);
    if (e) { sendError(res, e); return; }
    n++;
  }
  res.json({ ok: true, moved: n });
});

// PATCH /api/menus/:id
router.patch('/:id', requirePermission('menu.edit'), async (req, res) => {
  const patch: Record<string, unknown> = {};
  const b = req.body ?? {};
  if (b.name !== undefined) { const v = cleanMenuName(b.name); if (!v.ok) { res.status(400).json({ error: v.error }); return; } patch.name = v.value; }
  if (b.color !== undefined) { const v = cleanMenuColor(b.color); if (!v.ok) { res.status(400).json({ error: v.error }); return; } patch.color = v.value; }
  if (b.icon !== undefined) { const v = cleanMenuIcon(b.icon); if (!v.ok) { res.status(400).json({ error: v.error }); return; } patch.icon = v.value; }
  if (b.sort_order !== undefined) {
    if (!Number.isInteger(b.sort_order) || b.sort_order < 0) { res.status(400).json({ error: 'sort_order must be a whole number' }); return; }
    patch.sort_order = b.sort_order;
  }
  if (b.active !== undefined) {
    if (typeof b.active !== 'boolean') { res.status(400).json({ error: 'active must be true or false' }); return; }
    patch.active = b.active;
  }
  if (Object.keys(patch).length === 0) { res.status(400).json({ error: 'Nothing to change' }); return; }
  const { data, error } = await supabase.from('menus').update(patch)
    .eq('id', req.params.id).eq('business_id', req.businessId).is('deleted_at', null).select().maybeSingle();
  if (error) {
    if (isDuplicateName(error)) { res.status(409).json({ error: DUP(String(patch.name ?? '')) }); return; }
    sendError(res, error); return;
  }
  if (!data) { res.status(404).json({ error: 'Menu not found' }); return; }
  res.json(data);
});

// DELETE /api/menus/:id — soft: the row stays (deleted_at), the tills are told it is gone; its categories have no menu.
router.delete('/:id', requirePermission('menu.edit'), async (req, res) => {
  const { data: m, error: e1 } = await supabase.from('menus').select('id')
    .eq('id', req.params.id).eq('business_id', req.businessId).is('deleted_at', null).maybeSingle();
  if (e1) { sendError(res, e1); return; }
  if (!m) { res.status(404).json({ error: 'Menu not found' }); return; }
  const { error: e2 } = await supabase.from('categories').update({ menu_id: null })
    .eq('business_id', req.businessId).eq('menu_id', req.params.id);
  if (e2) { sendError(res, e2); return; }
  const { error } = await supabase.from('menus').update({ deleted_at: new Date().toISOString(), active: false })
    .eq('id', req.params.id).eq('business_id', req.businessId);
  if (error) { sendError(res, error); return; }
  res.status(204).send();
});

export default router;
