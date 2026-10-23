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
import { sendError } from '../lib/sendError';
import { safeRouter } from '../middleware/asyncHandler';
import { requireAuth } from '../middleware/auth';
import { requirePermission, assertBranchAccess, branchFilter, byBranch } from '../middleware/rbac';
import { guardBranch, idsOfBusiness } from '../lib/branchGuard';   // A494

/** A494: the category and the payer an expense names must be this business's. Answers itself; false = stop. */
async function expenseIdsOk(req: any, res: any, categoryId: unknown, paidBy: unknown): Promise<boolean> {
  if (categoryId && !(await idsOfBusiness('expense_categories', req.businessId, [String(categoryId)]))) {
    res.status(400).json({ error: "That expense category is not this business's." }); return false;
  }
  if (paidBy && !(await idsOfBusiness('users', req.businessId, [String(paidBy)]))) {
    res.status(400).json({ error: "The person who paid is not on this business's staff." }); return false;
  }
  return true;
}
import { validate } from '../middleware/validate';
import { CreateExpenseSchema } from '../lib/schemas';
import { cleanExpenseMethod } from '../lib/expenseMethod';
import { supabase } from '../lib/supabase';
import { recorderId } from '../lib/expenseRecorder';

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
// A360 (2026-09-28): the LIST of expense types is read by anyone signed in to this business — a cashier records petty
// cash at the till (Shift → Expenses) and must be able to pick a type; before, only `expenses.view` could read it, so a
// cashier's picker was empty and their expenses synced untyped (owner, backlog S2: "cashier cannot select expense type").
// No key on purpose: a cashier's keys differ by role and database (orders.create is not registered everywhere), and
// type names are no more private than the menu. requireAuth (router-wide) still applies and the read is business-scoped.
// ADDING, renaming and deleting a type stay `expenses.manage` (below).
router.get('/categories', async (req, res) => {
  const { data, error } = await supabase
    .from('expense_categories')
    .select('id, name, created_at')
    .eq('business_id', req.businessId)
    .order('name');

  if (error) { sendError(res, error); return; }
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

  if (error) { sendError(res, error); return; }
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

  if (error) { sendError(res, error); return; }
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

  if (error) { sendError(res, error); return; }
  res.status(204).send();
});

// ─── Expenses ─────────────────────────────────────────────────────────────────

// GET /api/expenses
// Query: from, to, branch_id, category_id
router.get('/', requirePermission('expenses.view'), async (req, res) => {
  const { from, to, category_id } = req.query;
  const { start, end } = getDateRange(from as string, to as string);
  const bf = branchFilter(req);   // A582: one branch, all, or a partner's set

  let query = supabase
    .from('expenses')
    .select(`
      id, description, amount, expense_date, receipt_url, created_at,
      branch_id, branches ( name ),
      expense_category_id, expense_categories ( name ),
      paid_by, payer:users!expenses_paid_by_fkey ( name ),
      recorded_by, recorder:users!expenses_recorded_by_fkey ( name ),
      payment_method, approved_by_name
    `)
    .eq('business_id', req.businessId)
    .gte('expense_date', (from as string) || start.slice(0, 10))
    .lte('expense_date', (to as string) || end.slice(0, 10))
    .order('expense_date', { ascending: false })
    .order('created_at', { ascending: false });

  query = byBranch(query, bf);
  if (category_id) query = query.eq('expense_category_id', category_id as string);

  const { data, error } = await query;
  if (error) { sendError(res, error); return; }

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
    paid_by_name: e.payer?.name ?? null,
    recorded_by: e.recorded_by ?? null,
    recorded_by_name: e.recorder?.name ?? null,
    payment_method: e.payment_method ?? 'cash',   // 0.6.27
    approved_by_name: e.approved_by_name ?? null,   // 0.6.37 (A388): the manager who approved it at the POS
  }));

  const total = expenses.reduce((s: number, e: any) => s + e.amount, 0);
  res.json({ expenses, total });
});

// GET /api/expenses/summary — totals by category for a period (used by reports)
router.get('/summary', requirePermission('expenses.view'), async (req, res) => {
  const { from, to } = req.query;
  const bf = branchFilter(req);   // A582

  let query = supabase
    .from('expenses')
    .select(`
      amount,
      expense_categories ( name )
    `)
    .eq('business_id', req.businessId);

  if (from) query = query.gte('expense_date', from as string);
  if (to)   query = query.lte('expense_date', to as string);
  query = byBranch(query, bf);

  const { data, error } = await query;
  if (error) { sendError(res, error); return; }

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
    paid_by, receipt_url, expense_date, payment_method,
  } = req.body as {
    payment_method?: string;
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

  if (!(await guardBranch(req, res, branch_id, 'Branch access denied'))) return;   // A494: the owner's too
  if (!(await expenseIdsOk(req, res, expense_category_id, paid_by))) return;

  const recordedBy = await recorderId(req);
  const { data, error } = await supabase
    .from('expenses')
    .insert({
      business_id: req.businessId,
      branch_id,
      expense_category_id: expense_category_id || null,
      description: description.trim(),
      amount,
      paid_by: paid_by || null,
      recorded_by: recordedBy,
      receipt_url: receipt_url?.trim() || null,
      expense_date: expense_date || new Date().toISOString().slice(0, 10),
      payment_method: cleanExpenseMethod(payment_method),   // 0.6.27
    })
    .select(`
      id, description, amount, expense_date, receipt_url, created_at,
      branch_id, branches ( name ),
      expense_category_id, expense_categories ( name ),
      paid_by, payer:users!expenses_paid_by_fkey ( name ),
      recorded_by, recorder:users!expenses_recorded_by_fkey ( name )
    `)
    .single();

  if (error) { sendError(res, error); return; }
  res.status(201).json(data);
});

// PATCH /api/expenses/:id
router.patch('/:id', requirePermission('expenses.manage'), async (req, res) => {
  const {
    expense_category_id, description, amount,
    paid_by, receipt_url, expense_date,
  } = req.body;

  const updates: Record<string, unknown> = {};
  if (req.body?.payment_method !== undefined) updates.payment_method = cleanExpenseMethod(req.body.payment_method);   // 0.6.27
  if (description !== undefined)       updates.description = description?.trim();
  if (amount !== undefined)            updates.amount = amount;
  if (expense_category_id !== undefined) updates.expense_category_id = expense_category_id || null;
  if (paid_by !== undefined)           updates.paid_by = paid_by || null;
  if (receipt_url !== undefined)       updates.receipt_url = receipt_url?.trim() || null;
  if (expense_date !== undefined)      updates.expense_date = expense_date;

  // A494: another branch's expense was editable by id; and the category / payer must be this business's.
  const { data: cur } = await supabase.from('expenses').select('id, branch_id').eq('id', req.params.id).eq('business_id', req.businessId).maybeSingle();
  if (!cur) { res.status(404).json({ error: 'Expense not found' }); return; }
  if (!assertBranchAccess(req, (cur as { branch_id: string }).branch_id)) { res.status(403).json({ error: 'Branch access denied' }); return; }
  if (!(await expenseIdsOk(req, res, expense_category_id, paid_by))) return;

  const { data, error } = await supabase
    .from('expenses')
    .update(updates)
    .eq('id', req.params.id)
    .eq('business_id', req.businessId)
    .select()
    .single();

  if (error) { sendError(res, error); return; }
  if (!data) { res.status(404).json({ error: 'Expense not found' }); return; }
  res.json(data);
});

// DELETE /api/expenses/:id
router.delete('/:id', requirePermission('expenses.manage'), async (req, res) => {
  // A494: another branch's expense was deletable by id.
  const { data: cur } = await supabase.from('expenses').select('id, branch_id').eq('id', req.params.id).eq('business_id', req.businessId).maybeSingle();
  if (!cur) { res.status(404).json({ error: 'Expense not found' }); return; }
  if (!assertBranchAccess(req, (cur as { branch_id: string }).branch_id)) { res.status(403).json({ error: 'Branch access denied' }); return; }
  const { error } = await supabase
    .from('expenses')
    .delete()
    .eq('id', req.params.id)
    .eq('business_id', req.businessId);

  if (error) { sendError(res, error); return; }
  res.status(204).send();
});

export default router;
