import { Router } from 'express';
import { safeRouter } from '../middleware/asyncHandler';
import { requireAuth } from '../middleware/auth';
import { supabase } from '../lib/supabase';

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

  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data);
});

// POST /api/categories
router.post('/', async (req, res) => {
  const { name, color, icon, sort_order, super_category } = req.body;

  if (!name) { res.status(400).json({ error: 'name is required' }); return; }

  const { data, error } = await supabase
    .from('categories')
    .insert({ business_id: req.businessId, name, color, icon, sort_order: sort_order ?? 0, super_category: super_category ?? null })
    .select()
    .single();

  if (error) { res.status(500).json({ error: error.message }); return; }
  res.status(201).json(data);
});

// PATCH /api/categories/:id
router.patch('/:id', async (req, res) => {
  const { id } = req.params;
  const { name, color, icon, status, super_category } = req.body;

  // Ensure the record belongs to this business before updating
  const { data, error } = await supabase
    .from('categories')
    .update({ name, color, icon, status, super_category })
    .eq('id', id)
    .eq('business_id', req.businessId)
    .select()
    .single();

  if (error) { res.status(500).json({ error: error.message }); return; }
  if (!data) { res.status(404).json({ error: 'Category not found' }); return; }
  res.json(data);
});

// DELETE /api/categories/:id
router.delete('/:id', async (req, res) => {
  const { id } = req.params;

  const { error } = await supabase
    .from('categories')
    .delete()
    .eq('id', id)
    .eq('business_id', req.businessId);

  if (error) { res.status(500).json({ error: error.message }); return; }
  res.status(204).send();
});

export default router;
