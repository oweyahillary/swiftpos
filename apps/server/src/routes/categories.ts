import { Router } from 'express';
import { validateLoose } from '../middleware/validate';
import { CreateCategorySchema } from '../lib/schemas';
import { sendError } from '../lib/sendError';
import { safeRouter } from '../middleware/asyncHandler';
import { requireAuth } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';
import { supabase } from '../lib/supabase';
import { menuIdForCategory } from '../lib/menus';   // A537

const router = safeRouter();

// All routes require a verified session + resolved businessId
router.use(requireAuth);

// GET /api/categories
router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('categories')
    .select('*')
    .eq('business_id', req.businessId)
    .order('sort_order');

  if (error) { sendError(res, error); return; }
  res.json(data);
});

// POST /api/categories
// Writes were ungated: any authenticated session, including a cashier's, could
// create, rename or delete a category — which also moves every product in it and
// changes what prints on the kitchen ticket.
router.post('/', requirePermission('menu.edit'), validateLoose(CreateCategorySchema), async (req, res) => {
  const { name, color, icon, sort_order, super_category, is_kitchen } = req.body;

  if (!name) { res.status(400).json({ error: 'name is required' }); return; }
  // A537: the menu it is under (Food, Soft drinks …) — this business's own, or none.
  const extra: Record<string, unknown> = {};
  if (req.body.menu_id !== undefined) {
    const m = await menuIdForCategory(req.businessId!, req.body.menu_id);
    if (!m.ok) { res.status(400).json({ error: m.error }); return; }
    extra.menu_id = m.value;
  }

  const { data, error } = await supabase
    .from('categories')
    .insert({ business_id: req.businessId, name, color, icon, sort_order: sort_order ?? 0, super_category: super_category ?? null, is_kitchen: is_kitchen === true, ...extra })
    .select()
    .single();

  if (error) { sendError(res, error); return; }
  res.status(201).json(data);
});

// PATCH /api/categories/:id
router.patch('/:id', requirePermission('menu.edit'), async (req, res) => {
  const { id } = req.params;
  const { name, color, icon, status, super_category, is_kitchen } = req.body;

  // Only send what the caller actually supplied. The previous update wrote every
  // column unconditionally, so a caller changing one field blanked the rest.
  const patch: Record<string, unknown> = {};
  if (name !== undefined)           patch.name = name;
  if (color !== undefined)          patch.color = color;
  if (icon !== undefined)           patch.icon = icon;
  if (status !== undefined)         patch.status = status;
  if (super_category !== undefined) patch.super_category = super_category;
  if (is_kitchen !== undefined)     patch.is_kitchen = is_kitchen === true;
  // A537: one menu per category — another business's menu is refused ("Menu not found"), null takes it out of any menu.
  if (req.body.menu_id !== undefined) {
    const m = await menuIdForCategory(req.businessId!, req.body.menu_id);
    if (!m.ok) { res.status(400).json({ error: m.error }); return; }
    patch.menu_id = m.value;
  }

  // Ensure the record belongs to this business before updating
  const { data, error } = await supabase
    .from('categories')
    .update(patch)
    .eq('id', id)
    .eq('business_id', req.businessId)
    .select()
    .single();

  if (error) { sendError(res, error); return; }
  if (!data) { res.status(404).json({ error: 'Category not found' }); return; }
  res.json(data);
});

// DELETE /api/categories/:id
router.delete('/:id', requirePermission('menu.edit'), async (req, res) => {
  const { id } = req.params;

  const { error } = await supabase
    .from('categories')
    .delete()
    .eq('id', id)
    .eq('business_id', req.businessId);

  if (error) { sendError(res, error); return; }
  res.status(204).send();
});

export default router;
