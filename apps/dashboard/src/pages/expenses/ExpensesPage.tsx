import { useState, useEffect, useCallback } from 'react';
import { useToast } from '../../hooks/useToast';
import Toast from '../../components/Toast';
import { api } from '../../lib/api';
import { useBusiness } from '../../context/BusinessContext';
import { useBranch } from '../../context/BranchContext';
import { usePermissions } from '../../context/PermissionsContext';
import ConfirmModal, { useConfirm } from '../../components/ConfirmModal';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ExpenseCategory {
  id: string;
  name: string;
  created_at: string;
}

interface Expense {
  id: string;
  description: string;
  amount: number;
  expense_date: string;
  receipt_url: string | null;
  created_at: string;
  branch_id: string;
  branch_name: string | null;
  expense_category_id: string | null;
  category_name: string | null;
  paid_by: string | null;
  paid_by_name: string | null;
}

interface Branch {
  id: string;
  name: string;
}

interface StaffMember {
  id: string;
  name: string;
}

interface ExpenseForm {
  branch_id: string;
  expense_category_id: string;
  description: string;
  amount: string;
  paid_by: string;
  receipt_url: string;
  expense_date: string;
}

const EMPTY_FORM: ExpenseForm = {
  branch_id: '',
  expense_category_id: '',
  description: '',
  amount: '',
  paid_by: '',
  receipt_url: '',
  expense_date: new Date().toISOString().slice(0, 10),
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(amount: number, currency: string) {
  return new Intl.NumberFormat('en-KE', {
    style: 'currency', currency, minimumFractionDigits: 2,
  }).format(amount);
}

function fmtDate(dateStr: string) {
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-KE', {
    day: 'numeric', month: 'short', year: 'numeric',
  });
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function ExpensesPage() {
  const { business } = useBusiness();
  const { activeBranchId } = useBranch();
  const { can } = usePermissions();
  const currency = business?.currency ?? 'KES';
  const { toast, showToast } = useToast();

  // ── State ──────────────────────────────────────────────────────────────────

  const [confirmState, showConfirm, closeConfirm] = useConfirm();
  const [expenses, setExpenses]       = useState<Expense[]>([]);
  const [total, setTotal]             = useState(0);
  const [categories, setCategories]   = useState<ExpenseCategory[]>([]);
  const [branches, setBranches]       = useState<Branch[]>([]);
  const [staff, setStaff]             = useState<StaffMember[]>([]);
  const [loading, setLoading]         = useState(true);

  // Filters
  const today = new Date().toISOString().slice(0, 10);
  const firstOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1)
    .toISOString().slice(0, 10);
  const [filterFrom, setFilterFrom]         = useState(firstOfMonth);
  const [filterTo, setFilterTo]             = useState(today);
  const [filterCategory, setFilterCategory] = useState('');

  // Expense modal
  const [expenseModal, setExpenseModal] = useState<'add' | Expense | null>(null);
  const [form, setForm]                 = useState<ExpenseForm>(EMPTY_FORM);
  const [saving, setSaving]             = useState(false);
  const [formError, setFormError]       = useState('');

  // Category management
  const [catModal, setCatModal]         = useState<'add' | ExpenseCategory | null>(null);
  const [catName, setCatName]           = useState('');
  const [catSaving, setCatSaving]       = useState(false);
  const [catError, setCatError]         = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState<ExpenseCategory | null>(null);

  // ── Data loading ───────────────────────────────────────────────────────────

  const loadCategories = useCallback(async () => {
    try {
      const data = await api.get<ExpenseCategory[]>('/api/expenses/categories');
      setCategories(data ?? []);
    } catch { /* silent */ }
  }, []);

  const loadExpenses = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set('from', filterFrom);
      params.set('to', filterTo);
      if (activeBranchId) params.set('branch_id', activeBranchId);
      if (filterCategory) params.set('category_id', filterCategory);

      const data = await api.get<{ expenses: Expense[]; total: number }>(
        `/api/expenses?${params.toString()}`
      );
      setExpenses(data.expenses ?? []);
      setTotal(data.total ?? 0);
    } catch { /* silent */ } finally {
      setLoading(false);
    }
  }, [filterFrom, filterTo, activeBranchId, filterCategory]);

  const loadMeta = useCallback(async () => {
    try {
      const [branchData, staffData] = await Promise.all([
        api.get<Branch[]>('/api/branches'),
        api.get<StaffMember[]>('/api/staff'),
      ]);
      setBranches(branchData ?? []);
      setStaff(staffData ?? []);
    } catch { /* silent */ }
  }, []);

  useEffect(() => { loadCategories(); loadMeta(); }, [loadCategories, loadMeta]);
  useEffect(() => { loadExpenses(); }, [loadExpenses]);

  // ── Category handlers ──────────────────────────────────────────────────────

  const openAddCat = () => { setCatName(''); setCatError(''); setCatModal('add'); };
  const openEditCat = (c: ExpenseCategory) => { setCatName(c.name); setCatError(''); setCatModal(c); };

  const saveCat = async () => {
    if (!catName.trim()) { setCatError('Name is required'); return; }
    setCatSaving(true); setCatError('');
    try {
      if (catModal === 'add') {
        await api.post('/api/expenses/categories', { name: catName.trim() });
      } else {
        await api.patch(`/api/expenses/categories/${(catModal as ExpenseCategory).id}`, { name: catName.trim() });
      }
      await loadCategories();
      setCatModal(null);
    } catch (e: any) {
      setCatError(e.message ?? 'Save failed');
    } finally {
      setCatSaving(false);
    }
  };

  const deleteCat = async (cat: ExpenseCategory) => {
    try {
      await api.delete(`/api/expenses/categories/${cat.id}`);
      await loadCategories();
      setDeleteConfirm(null);
    } catch (e: any) {
      showToast(e.message ?? 'Delete failed', 'error');
    }
  };

  // ── Expense handlers ───────────────────────────────────────────────────────

  const openAddExpense = () => {
    setForm({
      ...EMPTY_FORM,
      branch_id: activeBranchId ?? (branches[0]?.id ?? ''),
      expense_date: today,
    });
    setFormError('');
    setExpenseModal('add');
  };

  const openEditExpense = (e: Expense) => {
    setForm({
      branch_id: e.branch_id,
      expense_category_id: e.expense_category_id ?? '',
      description: e.description,
      amount: String(e.amount),
      paid_by: e.paid_by ?? '',
      receipt_url: e.receipt_url ?? '',
      expense_date: e.expense_date,
    });
    setFormError('');
    setExpenseModal(e);
  };

  const saveExpense = async () => {
    if (!form.branch_id)        { setFormError('Branch is required'); return; }
    if (!form.description.trim()) { setFormError('Description is required'); return; }
    const amount = parseFloat(form.amount);
    if (!form.amount || isNaN(amount) || amount <= 0) {
      setFormError('A positive amount is required'); return;
    }

    setSaving(true); setFormError('');
    try {
      const payload = {
        branch_id: form.branch_id,
        expense_category_id: form.expense_category_id || undefined,
        description: form.description.trim(),
        amount,
        paid_by: form.paid_by || undefined,
        receipt_url: form.receipt_url || undefined,
        expense_date: form.expense_date,
      };

      if (expenseModal === 'add') {
        await api.post('/api/expenses', payload);
      } else {
        await api.patch(`/api/expenses/${(expenseModal as Expense).id}`, payload);
      }
      await loadExpenses();
      setExpenseModal(null);
    } catch (e: any) {
      setFormError(e.message ?? 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const deleteExpense = async (id: string) => {
    // Deletion confirmed by the existing delete button — no browser confirm() needed
    try {
      await api.delete(`/api/expenses/${id}`);
      await loadExpenses();
    } catch (e: any) {
      showToast(e.message ?? 'Delete failed', 'error');
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  const canManage = can('expenses.manage');

  return (
    <>
      <Toast toast={toast} />
    <div className="flex-1 overflow-y-auto p-6 space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-white">Expenses</h1>
          <p className="text-gray-400 text-sm mt-0.5">Record and categorise business expenses</p>
        </div>
        {canManage && (
          <button
            onClick={openAddExpense}
            className="px-4 py-2 bg-green-500 hover:bg-green-400 text-black text-sm font-semibold rounded-lg transition-colors"
          >
            + Add Expense
          </button>
        )}
      </div>

      {/* Layout: categories sidebar + main table */}
      <div className="flex gap-6 items-start">

        {/* ── Categories panel ── */}
        <div className="w-56 flex-shrink-0 bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
            <p className="text-white text-sm font-semibold">Categories</p>
            {canManage && (
              <button
                onClick={openAddCat}
                className="text-green-400 hover:text-green-300 text-lg leading-none transition-colors"
                title="Add category"
              >+</button>
            )}
          </div>

          {/* All filter */}
          <button
            onClick={() => setFilterCategory('')}
            className={`w-full text-left px-4 py-2.5 text-sm transition-colors border-b border-gray-800/50 ${
              !filterCategory
                ? 'text-green-400 bg-green-500/10'
                : 'text-gray-400 hover:text-white hover:bg-gray-800'
            }`}
          >
            All categories
          </button>

          {categories.map(cat => (
            <div
              key={cat.id}
              className={`group flex items-center justify-between px-4 py-2.5 border-b border-gray-800/50 transition-colors cursor-pointer ${
                filterCategory === cat.id
                  ? 'text-green-400 bg-green-500/10'
                  : 'text-gray-400 hover:text-white hover:bg-gray-800'
              }`}
              onClick={() => setFilterCategory(cat.id)}
            >
              <span className="text-sm truncate flex-1">{cat.name}</span>
              {canManage && (
                <div className="flex gap-1 opacity-0 group-hover:opacity-100 flex-shrink-0 ml-1">
                  <button
                    onClick={e => { e.stopPropagation(); openEditCat(cat); }}
                    className="text-gray-500 hover:text-white text-xs transition-colors p-0.5"
                    title="Edit"
                  >✎</button>
                  <button
                    onClick={e => { e.stopPropagation(); setDeleteConfirm(cat); }}
                    className="text-gray-500 hover:text-red-400 text-xs transition-colors p-0.5"
                    title="Delete"
                  >✕</button>
                </div>
              )}
            </div>
          ))}

          {categories.length === 0 && (
            <p className="px-4 py-4 text-gray-600 text-xs text-center">No categories yet</p>
          )}
        </div>

        {/* ── Main expense log ── */}
        <div className="flex-1 min-w-0 space-y-4">

          {/* Filters bar */}
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2 bg-gray-900 border border-gray-800 rounded-lg px-3 py-2">
              <span className="text-gray-500 text-xs">From</span>
              <input
                type="date"
                value={filterFrom}
                onChange={e => setFilterFrom(e.target.value)}
                className="bg-transparent text-white text-sm focus:outline-none"
              />
            </div>
            <div className="flex items-center gap-2 bg-gray-900 border border-gray-800 rounded-lg px-3 py-2">
              <span className="text-gray-500 text-xs">To</span>
              <input
                type="date"
                value={filterTo}
                onChange={e => setFilterTo(e.target.value)}
                className="bg-transparent text-white text-sm focus:outline-none"
              />
            </div>

            {/* Summary chip */}
            <div className="ml-auto flex items-center gap-2 bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-2">
              <span className="text-red-400 text-xs font-medium">Total Expenses</span>
              <span className="text-red-300 text-sm font-bold">{fmt(total, currency)}</span>
            </div>
          </div>

          {/* Table */}
          <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
            {loading ? (
              <div className="py-16 text-center text-gray-500 text-sm">Loading…</div>
            ) : expenses.length === 0 ? (
              <div className="py-16 text-center">
                <p className="text-3xl mb-3">💸</p>
                <p className="text-gray-400 text-sm font-medium">No expenses found</p>
                <p className="text-gray-600 text-xs mt-1">
                  {canManage ? 'Click "+ Add Expense" to record one.' : 'No expenses in this period.'}
                </p>
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-800">
                    <th className="text-left text-gray-500 text-xs font-semibold px-4 py-3 uppercase tracking-wider">Date</th>
                    <th className="text-left text-gray-500 text-xs font-semibold px-4 py-3 uppercase tracking-wider">Description</th>
                    <th className="text-left text-gray-500 text-xs font-semibold px-4 py-3 uppercase tracking-wider">Category</th>
                    <th className="text-left text-gray-500 text-xs font-semibold px-4 py-3 uppercase tracking-wider">Branch</th>
                    <th className="text-left text-gray-500 text-xs font-semibold px-4 py-3 uppercase tracking-wider">Paid By</th>
                    <th className="text-right text-gray-500 text-xs font-semibold px-4 py-3 uppercase tracking-wider">Amount</th>
                    {canManage && <th className="px-4 py-3" />}
                  </tr>
                </thead>
                <tbody>
                  {expenses.map(e => (
                    <tr key={e.id} className="border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors group">
                      <td className="px-4 py-3 text-gray-300 whitespace-nowrap">{fmtDate(e.expense_date)}</td>
                      <td className="px-4 py-3 text-white max-w-xs">
                        <span className="block truncate">{e.description}</span>
                        {e.receipt_url && (
                          <a
                            href={e.receipt_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-green-500 text-xs hover:underline"
                          >Receipt ↗</a>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {e.category_name ? (
                          <span className="px-2 py-0.5 bg-gray-800 text-gray-300 rounded text-xs">{e.category_name}</span>
                        ) : (
                          <span className="text-gray-600 text-xs">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-gray-400 text-xs">{e.branch_name ?? '—'}</td>
                      <td className="px-4 py-3 text-gray-400 text-xs">{e.paid_by_name ?? '—'}</td>
                      <td className="px-4 py-3 text-right font-semibold text-red-300 whitespace-nowrap">
                        {fmt(e.amount, currency)}
                      </td>
                      {canManage && (
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 justify-end transition-opacity">
                            <button
                              onClick={() => openEditExpense(e)}
                              className="text-gray-500 hover:text-white text-xs transition-colors"
                            >Edit</button>
                            <button
                              onClick={() => deleteExpense(e.id)}
                              className="text-gray-500 hover:text-red-400 text-xs transition-colors"
                            >Delete</button>
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-gray-700">
                    <td colSpan={canManage ? 5 : 5} className="px-4 py-3 text-gray-500 text-xs font-semibold">
                      {expenses.length} expense{expenses.length !== 1 ? 's' : ''}
                    </td>
                    <td className="px-4 py-3 text-right font-bold text-red-300">
                      {fmt(total, currency)}
                    </td>
                    {canManage && <td />}
                  </tr>
                </tfoot>
              </table>
            )}
          </div>
        </div>
      </div>

      {/* ── Expense Modal ── */}
      {expenseModal !== null && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-800 rounded-2xl w-full max-w-md shadow-2xl">
            <div className="px-6 py-4 border-b border-gray-800">
              <h2 className="text-white font-semibold">
                {expenseModal === 'add' ? 'Add Expense' : 'Edit Expense'}
              </h2>
            </div>

            <div className="px-6 py-5 space-y-4">
              {/* Date */}
              <div>
                <label className="block text-gray-400 text-xs mb-1.5">Date</label>
                <input
                  type="date"
                  value={form.expense_date}
                  onChange={e => setForm(f => ({ ...f, expense_date: e.target.value }))}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-green-500"
                />
              </div>

              {/* Branch */}
              <div>
                <label className="block text-gray-400 text-xs mb-1.5">Branch <span className="text-red-400">*</span></label>
                <select
                  value={form.branch_id}
                  onChange={e => setForm(f => ({ ...f, branch_id: e.target.value }))}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-green-500"
                >
                  <option value="">Select branch…</option>
                  {branches.map(b => (
                    <option key={b.id} value={b.id}>{b.name}</option>
                  ))}
                </select>
              </div>

              {/* Category */}
              <div>
                <label className="block text-gray-400 text-xs mb-1.5">Category</label>
                <select
                  value={form.expense_category_id}
                  onChange={e => setForm(f => ({ ...f, expense_category_id: e.target.value }))}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-green-500"
                >
                  <option value="">Uncategorised</option>
                  {categories.map(c => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>

              {/* Description */}
              <div>
                <label className="block text-gray-400 text-xs mb-1.5">Description <span className="text-red-400">*</span></label>
                <input
                  type="text"
                  placeholder="e.g. Electricity bill – March"
                  value={form.description}
                  onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-green-500"
                />
              </div>

              {/* Amount */}
              <div>
                <label className="block text-gray-400 text-xs mb-1.5">Amount ({currency}) <span className="text-red-400">*</span></label>
                <input
                  type="number"
                  min="0.01"
                  step="0.01"
                  placeholder="0.00"
                  value={form.amount}
                  onChange={e => setForm(f => ({ ...f, amount: e.target.value }))}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-green-500"
                />
              </div>

              {/* Paid by */}
              <div>
                <label className="block text-gray-400 text-xs mb-1.5">Paid By</label>
                <select
                  value={form.paid_by}
                  onChange={e => setForm(f => ({ ...f, paid_by: e.target.value }))}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-green-500"
                >
                  <option value="">— Select staff member —</option>
                  {staff.map(s => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </div>

              {/* Receipt URL */}
              <div>
                <label className="block text-gray-400 text-xs mb-1.5">Receipt URL (optional)</label>
                <input
                  type="url"
                  placeholder="https://…"
                  value={form.receipt_url}
                  onChange={e => setForm(f => ({ ...f, receipt_url: e.target.value }))}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-green-500"
                />
              </div>

              {formError && (
                <p className="text-red-400 text-xs bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
                  {formError}
                </p>
              )}
            </div>

            <div className="px-6 py-4 border-t border-gray-800 flex justify-end gap-3">
              <button
                onClick={() => setExpenseModal(null)}
                className="px-4 py-2 text-gray-400 hover:text-white text-sm transition-colors"
              >Cancel</button>
              <button
                onClick={saveExpense}
                disabled={saving}
                className="px-5 py-2 bg-green-500 hover:bg-green-400 disabled:opacity-50 text-black text-sm font-semibold rounded-lg transition-colors"
              >{saving ? 'Saving…' : 'Save Expense'}</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Category Modal ── */}
      {catModal !== null && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-800 rounded-2xl w-full max-w-sm shadow-2xl">
            <div className="px-6 py-4 border-b border-gray-800">
              <h2 className="text-white font-semibold">
                {catModal === 'add' ? 'New Category' : 'Rename Category'}
              </h2>
            </div>

            <div className="px-6 py-5">
              <label className="block text-gray-400 text-xs mb-1.5">Category name</label>
              <input
                type="text"
                placeholder="e.g. Utilities, Rent, Transport…"
                value={catName}
                onChange={e => setCatName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && saveCat()}
                autoFocus
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-green-500"
              />
              {catError && (
                <p className="text-red-400 text-xs mt-2">{catError}</p>
              )}
            </div>

            <div className="px-6 py-4 border-t border-gray-800 flex justify-end gap-3">
              <button
                onClick={() => setCatModal(null)}
                className="px-4 py-2 text-gray-400 hover:text-white text-sm transition-colors"
              >Cancel</button>
              <button
                onClick={saveCat}
                disabled={catSaving}
                className="px-5 py-2 bg-green-500 hover:bg-green-400 disabled:opacity-50 text-black text-sm font-semibold rounded-lg transition-colors"
              >{catSaving ? 'Saving…' : 'Save'}</button>
            </div>
          </div>
        </div>
      )}

      <ConfirmModal state={confirmState} onClose={closeConfirm} />
    </div>
    </>
  );
}