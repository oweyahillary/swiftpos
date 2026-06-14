/**
 * /api/printers
 * CRUD for branch printer profiles.
 *
 * Session 5 fix: added assertBranchAccess() on POST / PATCH / DELETE so
 * managers cannot create or modify printers for branches they don't own.
 */

import { Router } from 'express';
import { safeRouter } from '../middleware/asyncHandler';
import { requireAuth } from '../middleware/auth';
import { assertBranchAccess } from '../middleware/rbac';
import { supabase } from '../lib/supabase';

const router = safeRouter();
router.use(requireAuth);

// GET /api/printers?branch_id=
router.get('/', async (req, res) => {
  const { branch_id } = req.query as Record<string, string>;

  // Non-owners are always locked to their JWT branch — ignore any branch_id param
  const effectiveBranchId = req.isOwner ? (branch_id || null) : req.branchId;

  let query = supabase
    .from('branch_printers')
    .select('*')
    .eq('business_id', req.businessId)
    .order('type')
    .order('name');
  if (effectiveBranchId) query = query.eq('branch_id', effectiveBranchId);
  const { data, error } = await query;
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data ?? []);
});

// POST /api/printers
router.post('/', async (req, res) => {
  const {
    branch_id, name, printer_name, type, paper_width,
    category_ids, is_default_receipt, connection_type, enabled,
  } = req.body;

  if (!branch_id)    { res.status(400).json({ error: 'branch_id is required' }); return; }
  if (!name?.trim()) { res.status(400).json({ error: 'name is required' }); return; }

  // Branch access guard — managers can only create printers for their own branch
  if (!assertBranchAccess(req, branch_id)) {
    res.status(403).json({ error: 'Branch access denied' }); return;
  }

  // If setting as default receipt, unset others first
  if (is_default_receipt) {
    await supabase.from('branch_printers')
      .update({ is_default_receipt: false, updated_at: new Date().toISOString() })
      .eq('branch_id', branch_id)
      .eq('business_id', req.businessId);
  }

  const { data, error } = await supabase.from('branch_printers').insert({
    business_id:        req.businessId,
    branch_id,
    name:               name.trim(),
    printer_name:       printer_name?.trim() || null,
    type:               type ?? 'receipt',
    paper_width:        paper_width ?? 80,
    category_ids:       category_ids ?? [],
    is_default_receipt: is_default_receipt ?? false,
    connection_type:    connection_type ?? 'browser',
    enabled:            enabled ?? true,
  }).select().single();

  if (error) { res.status(500).json({ error: error.message }); return; }
  res.status(201).json(data);
});

// PATCH /api/printers/:id
router.patch('/:id', async (req, res) => {
  const {
    name, printer_name, type, paper_width,
    category_ids, is_default_receipt, connection_type, enabled,
  } = req.body;

  // Fetch current printer to get branch_id for access check
  const { data: current } = await supabase.from('branch_printers')
    .select('branch_id').eq('id', req.params.id).eq('business_id', req.businessId).single();
  if (!current) { res.status(404).json({ error: 'Printer not found' }); return; }

  // Branch access guard — managers can only edit their own branch's printers
  if (!assertBranchAccess(req, current.branch_id)) {
    res.status(403).json({ error: 'Branch access denied' }); return;
  }

  if (is_default_receipt) {
    await supabase.from('branch_printers')
      .update({ is_default_receipt: false, updated_at: new Date().toISOString() })
      .eq('branch_id', current.branch_id)
      .eq('business_id', req.businessId)
      .neq('id', req.params.id);
  }

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (name !== undefined)               updates.name               = name?.trim();
  if (printer_name !== undefined)       updates.printer_name       = printer_name?.trim() || null;
  if (type !== undefined)               updates.type               = type;
  if (paper_width !== undefined)        updates.paper_width        = paper_width;
  if (category_ids !== undefined)       updates.category_ids       = category_ids;
  if (is_default_receipt !== undefined) updates.is_default_receipt = is_default_receipt;
  if (connection_type !== undefined)    updates.connection_type    = connection_type;
  if (enabled !== undefined)            updates.enabled            = enabled;

  const { data, error } = await supabase.from('branch_printers')
    .update(updates).eq('id', req.params.id).eq('business_id', req.businessId).select().single();
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data);
});

// DELETE /api/printers/:id
router.delete('/:id', async (req, res) => {
  // Fetch to verify branch access before deleting
  const { data: existing } = await supabase.from('branch_printers')
    .select('branch_id').eq('id', req.params.id).eq('business_id', req.businessId).single();

  if (!existing) { res.status(404).json({ error: 'Printer not found' }); return; }

  // Branch access guard
  if (!assertBranchAccess(req, existing.branch_id)) {
    res.status(403).json({ error: 'Branch access denied' }); return;
  }

  const { error } = await supabase.from('branch_printers')
    .delete().eq('id', req.params.id).eq('business_id', req.businessId);
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.status(204).send();
});

export default router;
