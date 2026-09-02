import { Router } from 'express';
import { sendError } from '../lib/sendError';
import { safeRouter } from '../middleware/asyncHandler';
import { supabase } from '../lib/supabase';
import { requireAuth } from '../middleware/auth';
import { requireAnyPermission } from '../middleware/rbac';
import { validate } from '../middleware/validate';
import { CreateBranchSchema, UpdateBranchSchema } from '../lib/schemas';

const router = safeRouter();

// GET /api/branches — list all branches for this business
router.get('/', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('branches')
    .select('*')
    .eq('business_id', req.businessId)
    .order('is_main', { ascending: false })
    .order('created_at', { ascending: true });

  if (error) { sendError(res, error); return; }
  res.json(data);
});

// GET /api/branches/:id
router.get('/:id', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('branches')
    .select('*')
    .eq('id', req.params.id)
    .eq('business_id', req.businessId)
    .single();

  if (error) { res.status(404).json({ error: 'Branch not found' }); return; }
  res.json(data);
});

// POST /api/branches — BLOCKED for owner tokens
// Branch creation is admin-portal-only to enforce the per-branch licensing fee (KES 30,000).
// Clients cannot self-provision branches. Contact SwiftPOS to add a branch.
router.post('/', requireAuth, (_req, res) => {
  res.status(403).json({
    error: 'Branch creation is managed by SwiftPOS agents. Contact SwiftPOS to add a branch.',
    code:  'BRANCH_CREATION_RESTRICTED',
  });
});

// PUT /api/branches/:id — update branch
router.put('/:id', requireAuth, validate(UpdateBranchSchema), async (req, res) => {
  const { name, address, phone, status } = req.body;

  const { data, error } = await supabase
    .from('branches')
    .update({ name, address, phone, status, updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .eq('business_id', req.businessId)
    .select()
    .single();

  if (error) { sendError(res, error); return; }
  res.json(data);
});

// PUT /api/branches/:id/set-main — change main branch
router.put('/:id/set-main', requireAuth, async (req, res) => {
  // Unset current main
  await supabase
    .from('branches')
    .update({ is_main: false })
    .eq('business_id', req.businessId);

  // Set new main
  const { data, error } = await supabase
    .from('branches')
    .update({ is_main: true, updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .eq('business_id', req.businessId)
    .select()
    .single();

  if (error) { sendError(res, error); return; }
  res.json(data);
});

// DELETE /api/branches/:id — deactivate branch
router.delete('/:id', requireAuth, async (req, res) => {
  const { data: branch } = await supabase
    .from('branches')
    .select('is_main')
    .eq('id', req.params.id)
    .eq('business_id', req.businessId)
    .single();

  if (!branch) { res.status(404).json({ error: 'Branch not found' }); return; }
  if (branch.is_main) { res.status(400).json({ error: 'Cannot deactivate the main branch' }); return; }

  const { error } = await supabase
    .from('branches')
    .update({ status: 'inactive', updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .eq('business_id', req.businessId);

  if (error) { sendError(res, error); return; }
  res.json({ success: true });
});

// GET /api/branches/:id/staff
router.get('/:id/staff', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('user_branches')
    .select(`
      user_id,
      users (id, name, email, phone, status, role_id,
        roles (name)
      )
    `)
    .eq('branch_id', req.params.id);

  if (error) { sendError(res, error); return; }

  const staff = (data ?? []).map((row: any) => ({
    ...row.users,
    role_name: row.users?.roles?.name ?? null,
  }));

  res.json(staff);
});

// GET /api/branches/:id/stock
router.get('/:id/stock', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('stock_levels')
    .select(`
      *,
      products!inner (id, name, base_price, status, business_id,
        categories (name)
      )
    `)
    .eq('branch_id', req.params.id)
    .eq('products.business_id', req.businessId)
    .order('quantity', { ascending: true });

  if (error) { sendError(res, error); return; }
  res.json(data);
});

// PUT /api/branches/:id/stock/:productId — adjust stock
router.put('/:id/stock/:productId', requireAuth, async (req, res) => {
  const { id: branch_id, productId: product_id } = req.params;
  const { quantity, low_stock_threshold } = req.body;

  const { data, error } = await supabase
    .from('stock_levels')
    .upsert(
      { branch_id, product_id, quantity, low_stock_threshold, updated_at: new Date().toISOString() },
      { onConflict: 'product_id,branch_id' }
    )
    .select()
    .single();

  if (error) { sendError(res, error); return; }

  await supabase.from('stock_movements').insert({
    branch_id,
    product_id,
    movement_type: 'correction',
    quantity_change: quantity,
    quantity_after: quantity,
    notes: 'Branch stock correction',
    created_by: req.userId,
  });

  res.json(data);
});

// A145: the branch-centric user-assignment routes were RETIRED here —
//   POST   /api/branches/:id/assign-user
//   DELETE /api/branches/:id/remove-user/:userId
// They were redundant with the staff flow (POST/PATCH /api/staff write
// user_branches, gated by requirePermission('staff.manage') + business/branch
// scoping) and, unlike that flow, were guarded by requireAuth ONLY — no
// permission, no business/branch scoping, service-role client — which allowed
// within-tenant privilege escalation and cross-tenant user_branches writes.
// Zero callers (dashboard/admin/desktop). Do NOT re-add a branch-centric writer
// without those guards; assign branches via the staff endpoints instead.

// A139: per-branch setting overrides (receipt text + hours) that supersede the
// business default. Only these three keys are overridable; the resolution
// (branch → business default) happens server-side in GET /pos/init, so the
// branch-bound till just receives its own values.
const OVERRIDABLE_KEYS = ['receipt_header', 'receipt_footer', 'continuous_operation'];

// Confirms :id is a branch of THIS business — never let an owner read or write
// overrides on another tenant's branch (the till resolves by branch_id alone).
async function assertOwnBranch(businessId: string | undefined, branchId: string): Promise<boolean> {
  const { data } = await supabase
    .from('branches').select('id').eq('id', branchId).eq('business_id', businessId).maybeSingle();
  return !!data;
}

// GET /api/branches/:id/settings — this branch's overrides as a { key: value } map.
router.get('/:id/settings', requireAuth, async (req, res) => {
  if (!(await assertOwnBranch(req.businessId, req.params.id))) {
    res.status(404).json({ error: 'Branch not found' });
    return;
  }
  const { data, error } = await supabase
    .from('branch_settings')
    .select('key, value')
    .eq('business_id', req.businessId)
    .eq('branch_id', req.params.id);
  if (error) { sendError(res, error); return; }
  const map: Record<string, string> = {};
  for (const row of data ?? []) map[(row as any).key] = (row as any).value;
  res.json(map);
});

// POST /api/branches/:id/settings — set or clear one override.
//   { key, value }        → upsert the override (branch value wins over default)
//   { key, value: null }  → delete the override (branch reverts to the default)
router.post('/:id/settings', requireAuth, requireAnyPermission('settings.manage'), async (req, res) => {
  const { key, value } = req.body ?? {};
  if (!OVERRIDABLE_KEYS.includes(key)) {
    res.status(400).json({ error: 'That setting cannot be overridden per branch' });
    return;
  }
  if (!(await assertOwnBranch(req.businessId, req.params.id))) {
    res.status(404).json({ error: 'Branch not found' });
    return;
  }
  if (value === null || value === undefined) {
    const { error } = await supabase
      .from('branch_settings')
      .delete()
      .eq('business_id', req.businessId)
      .eq('branch_id', req.params.id)
      .eq('key', key);
    if (error) { sendError(res, error); return; }
    res.json({ key, inherited: true });
    return;
  }
  const { error } = await supabase
    .from('branch_settings')
    .upsert(
      { business_id: req.businessId, branch_id: req.params.id, key, value: String(value), updated_at: new Date().toISOString() },
      { onConflict: 'branch_id,key' },
    );
  if (error) { sendError(res, error); return; }
  res.json({ key, value: String(value) });
});

export default router;
