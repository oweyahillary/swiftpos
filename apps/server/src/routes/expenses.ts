/**
 * /api/expenses
 *
 * Step 26 — Expenses
 * Covers: expense categories CRUD + expense records CRUD.
 * Expenses are linked to a branch and optionally to a cashier shift.
 * Results feed into the EOD Z-report for true profit visibility.
 *
 * Permissions:
 *   expenses.view   — read access
 *   expenses.manage — create / edit / delete
 */

import { Router } from 'express';
import { safeRouter } from '../middleware/asyncHandler';
import { requireAuth } from '../middleware/auth';
import { requirePermission, branchScope, assertBranchAccess } from '../middleware/rbac';
import { validate } from '../middleware/validate';
import { CreateExpenseSchema } from '../lib/schemas';
import { supabase } from '../lib/supabase';

const router = safeRouter();
router.use(requireAuth);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getDateRange(from?: string, to?: string) {
  const now = new Date();
  const start = from
    ? new Date(from)
    : new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = to
    ? new Date(to + 'T23:59:59')
    : new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
  return { start: start.toISOString(), end: end.toISOString() };
}

// ─── Expense Categories ───────────────────────────────────────────────────────

// GET /api/expenses/categories
router.get('/categories', requirePermission('expenses.view'), async (req, res) => {
  const { data, error } = await supabase
    .from('expense_categories')
    .select('id, name, created_at')
    .eq('business_id', req.businessId)
    .order('name');

  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data ?? []);
});

// POST /api/expenses/categories
router.post('/categories', requirePermission('expenses.manage'), async (req, res) => {
  const { name } = req.body as { name: string };
  if (!name?.trim()) { res.status(400).json({ error: 'name is required' }); return; }

  const { data, error } = await supabase
    .from('expense_categories')
    .insert({ business_id: req.businessId, name: name.trim() })
    .select()
    .single();

  if (error) { res.status(500).json({ error: error.message }); return; }
  res.status(201).json(data);
});

// PATCH /api/expenses/categories/:id
router.patch('/categories/:id', requirePermission('expenses.manage'), async (req, res) => {
  const { name } = req.body as { name: string };
  if (!name?.trim()) { res.status(400).json({ error: 'name is required' }); return; }

  const { data, error } = await supabase
    .from('expense_categories')
    .update({ name: name.trim() })
    .eq('id', req.params.id)
    .eq('business_id', req.businessId)
    .select()
    .single();

  if (error) { res.status(500).json({ error: error.message }); return; }
  if (!data) { res.status(404).json({ error: 'Category not found' }); return; }
  res.json(data);
});

// DELETE /api/expenses/categories/:id
router.delete('/categories/:id', requirePermission('expenses.manage'), async (req, res) => {
  // Guard: do not delete if expenses are still linked
  const { count } = await supabase
    .from('expenses')
    .select('*', { count: 'exact', head: true })
    .eq('expense_category_id', req.params.id)
    .eq('business_id', req.businessId);

  if (count && count > 0) {
    res.status(409).json({ error: `Cannot delete — ${count} expense(s) use this category. Re-categorise them first.` });
    return;
  }

  const { error } = await supabase
    .from('expense_categories')
    .delete()
    .eq('id', req.params.id)
    .eq('business_id', req.businessId);

  if (error) { res.status(500).json({ error: error.message }); return; }
  res.status(204).send();
});

// ─── Expenses ─────────────────────────────────────────────────────────────────

// GET /api/expenses
// Query: from, to, branch_id, category_id
router.get('/', requirePermission('expenses.view'), async (req, res) => {
  const { from, to, category_id } = req.query;
  const { start, end } = getDateRange(from as string, to as string);
  const scopedBranch = branchScope(req);

  let query = supabase
    .from('expenses')
    .select(`
      id, description, amount, expense_date, receipt_url, created_at,
      branch_id, branches ( name ),
      expense_category_id, expense_categories ( name ),
      paid_by, users ( name )
    `)
    .eq('business_id', req.businessId)
    .gte('expense_date', (from as string) || start.slice(0, 10))
    .lte('expense_date', (to as string) || end.slice(0, 10))
    .order('expense_date', { ascending: false })
    .order('created_at', { ascending: false });

  if (scopedBranch) query = query.eq('branch_id', scopedBranch);
  if (category_id) query = query.eq('expense_category_id', category_id as string);

  const { data, error } = await query;
  if (error) { res.status(500).json({ error: error.message }); return; }

  // Flatten joins for easy consumption
  const expenses = (data ?? []).map((e: any) => ({
    id: e.id,
    description: e.description,
    amount: Number(e.amount),
    expense_date: e.expense_date,
    receipt_url: e.receipt_url,
    created_at: e.created_at,
    branch_id: e.branch_id,
    branch_name: e.branches?.name ?? null,
    expense_category_id: e.expense_category_id,
    category_name: e.expense_categories?.name ?? null,
    paid_by: e.paid_by,
    paid_by_name: e.users?.name ?? null,
  }));

  const total = expenses.reduce((s: number, e: any) => s + e.amount, 0);
  res.json({ expenses, total });
});

// GET /api/expenses/summary — totals by category for a period (used by reports)
router.get('/summary', requirePermission('expenses.view'), async (req, res) => {
  const { from, to } = req.query;
  const scopedBranch = branchScope(req);

  let query = supabase
    .from('expenses')
    .select(`
      amount,
      expense_categories ( name )
    `)
    .eq('business_id', req.businessId);

  if (from) query = query.gte('expense_date', from as string);
  if (to)   query = query.lte('expense_date', to as string);
  if (scopedBranch) query = query.eq('branch_id', scopedBranch);

  const { data, error } = await query;
  if (error) { res.status(500).json({ error: error.message }); return; }

  const byCategory: Record<string, number> = {};
  let total = 0;

  (data ?? []).forEach((e: any) => {
    const cat = e.expense_categories?.name ?? 'Uncategorised';
    byCategory[cat] = (byCategory[cat] ?? 0) + Number(e.amount);
    total += Number(e.amount);
  });

  const breakdown = Object.entries(byCategory)
    .map(([category, amount]) => ({ category, amount }))
    .sort((a, b) => b.amount - a.amount);

  res.json({ total, breakdown });
});

// POST /api/expenses
router.post('/', requirePermission('expenses.manage'), validate(CreateExpenseSchema), async (req, res) => {
  const {
    branch_id, expense_category_id, description, amount,
    paid_by, receipt_url, expense_date,
  } = req.body as {
    branch_id: string;
    expense_category_id?: string;
    description: string;
    amount: number;
    paid_by?: string;
    receipt_url?: string;
    expense_date?: string;
  };

  if (!branch_id)    { res.status(400).json({ error: 'branch_id is required' }); return; }
  if (!description?.trim()) { res.status(400).json({ error: 'description is required' }); return; }
  if (!amount || amount <= 0) { res.status(400).json({ error: 'amount must be positive' }); return; }

  if (!assertBranchAccess(req, branch_id)) {
    res.status(403).json({ error: 'Branch access denied' }); return;
  }

  const { data, error } = await supabase
    .from('expenses')
    .insert({
      business_id: req.businessId,
      branch_id,
      expense_category_id: expense_category_id || null,
      description: description.trim(),
      amount,
      paid_by: paid_by || null,
      receipt_url: receipt_url?.trim() || null,
      expense_date: expense_date || new Date().toISOString().slice(0, 10),
    })
    .select(`
      id, description, amount, expense_date, receipt_url, created_at,
      branch_id, branches ( name ),
      expense_category_id, expense_categories ( name ),
      paid_by, users ( name )
    `)
    .single();

  if (error) { res.status(500).json({ error: error.message }); return; }
  res.status(201).json(data);
});

// PATCH /api/expenses/:id
router.patch('/:id', requirePermission('expenses.manage'), async (req, res) => {
  const {
    expense_category_id, description, amount,
    paid_by, receipt_url, expense_date,
  } = req.body;

  const updates: Record<string, unknown> = {};
  if (description !== undefined)       updates.description = description?.trim();
  if (amount !== undefined)            updates.amount = amount;
  if (expense_category_id !== undefined) updates.expense_category_id = expense_category_id || null;
  if (paid_by !== undefined)           updates.paid_by = paid_by || null;
  if (receipt_url !== undefined)       updates.receipt_url = receipt_url?.trim() || null;
  if (expense_date !== undefined)      updates.expense_date = expense_date;

  const { data, error } = await supabase
    .from('expenses')
    .update(updates)
    .eq('id', req.params.id)
    .eq('business_id', req.businessId)
    .select()
    .single();

  if (error) { res.status(500).json({ error: error.message }); return; }
  if (!data) { res.status(404).json({ error: 'Expense not found' }); return; }
  res.json(data);
});

// DELETE /api/expenses/:id
router.delete('/:id', requirePermission('expenses.manage'), async (req, res) => {
  const { error } = await supabase
    .from('expenses')
    .delete()
    .eq('id', req.params.id)
    .eq('business_id', req.businessId);

  if (error) { res.status(500).json({ error: error.message }); return; }
  res.status(204).send();
});

export default router;
