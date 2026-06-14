import { Router } from 'express';
import { safeRouter } from '../middleware/asyncHandler';
import { supabase } from '../lib/supabase';
import { requireAuth } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';
import { branchScope, assertBranchAccess } from '../middleware/rbac';

const router = safeRouter();

// GET /api/tables?branch_id= — list active tables for a branch
router.get('/', requireAuth, async (req, res) => {
  const scopedBranchId = branchScope(req);
  const queryBranchId = (req.query.branch_id as string) || scopedBranchId;

  if (!queryBranchId) {
    res.status(400).json({ error: 'branch_id is required' });
    return;
  }

  if (!assertBranchAccess(req, queryBranchId)) {
    res.status(403).json({ error: 'Access denied to this branch' });
    return;
  }

  const { data, error } = await supabase
    .from('tables')
    .select('*')
    .eq('business_id', req.businessId)
    .eq('branch_id', queryBranchId)
    .eq('status', 'active')
    .order('sort_order', { ascending: true })
    .order('name', { ascending: true });

  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data);
});

// GET /api/tables/all?branch_id= — list all tables including inactive (for admin)
router.get('/all', requireAuth, requirePermission('settings.manage'), async (req, res) => {
  const queryBranchId = req.query.branch_id as string;

  if (!queryBranchId) {
    res.status(400).json({ error: 'branch_id is required' });
    return;
  }

  const { data, error } = await supabase
    .from('tables')
    .select('*')
    .eq('business_id', req.businessId)
    .eq('branch_id', queryBranchId)
    .order('sort_order', { ascending: true })
    .order('name', { ascending: true });

  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data);
});

// POST /api/tables — create a table
router.post('/', requireAuth, requirePermission('settings.manage'), async (req, res) => {
  const { branch_id, name, capacity, sort_order } = req.body;

  if (!branch_id || !name) {
    res.status(400).json({ error: 'branch_id and name are required' });
    return;
  }

  if (!assertBranchAccess(req, branch_id)) {
    res.status(403).json({ error: 'Access denied to this branch' });
    return;
  }

  const { data, error } = await supabase
    .from('tables')
    .insert({
      business_id: req.businessId,
      branch_id,
      name: name.trim(),
      capacity: capacity ?? 4,
      sort_order: sort_order ?? 0,
      status: 'active',
    })
    .select()
    .single();

  if (error) {
    if (error.code === '23505') {
      res.status(409).json({ error: `A table named "${name}" already exists in this branch` });
      return;
    }
    res.status(500).json({ error: error.message });
    return;
  }

  res.status(201).json(data);
});

// PATCH /api/tables/:id — update name, capacity, sort_order, or status
router.patch('/:id', requireAuth, requirePermission('settings.manage'), async (req, res) => {
  const { name, capacity, sort_order, status, shape, zone, pos_x, pos_y } = req.body;

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (name !== undefined)       updates.name       = name.trim();
  if (capacity !== undefined)   updates.capacity   = capacity;
  if (sort_order !== undefined) updates.sort_order = sort_order;
  if (status !== undefined)     updates.status     = status;
  if (shape !== undefined)      updates.shape      = shape;
  if (zone !== undefined)       updates.zone       = zone;
  if (pos_x !== undefined)      updates.pos_x      = pos_x;
  if (pos_y !== undefined)      updates.pos_y      = pos_y;

  const { data, error } = await supabase
    .from('tables')
    .update(updates)
    .eq('id', req.params.id)
    .eq('business_id', req.businessId)
    .select()
    .single();

  if (error) { res.status(500).json({ error: error.message }); return; }
  if (!data) { res.status(404).json({ error: 'Table not found' }); return; }

  res.json(data);
});

// DELETE /api/tables/:id — soft delete (set inactive)
router.delete('/:id', requireAuth, requirePermission('settings.manage'), async (req, res) => {
  const { data, error } = await supabase
    .from('tables')
    .update({ status: 'inactive', updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .eq('business_id', req.businessId)
    .select()
    .single();

  if (error) { res.status(500).json({ error: error.message }); return; }
  if (!data) { res.status(404).json({ error: 'Table not found' }); return; }

  res.json({ success: true });
});

export default router;
