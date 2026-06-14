import { useState, useEffect, useCallback } from 'react';
import { useToast } from '../../hooks/useToast';
import Toast from '../../components/Toast';
import { api } from '../../lib/api';
import { usePermissions } from '../../context/PermissionsContext';
import { useBusiness } from '../../context/BusinessContext';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Ingredient {
  id: string;
  name: string;
  category: string | null;
  unit: string;
  unit_cost: number | null;
  current_stock: number;
  reorder_level: number;
  status: 'active' | 'inactive';
  notes: string | null;
  updated_at: string;
}

interface Movement {
  id: string;
  movement_type: string;
  quantity_change: number;
  quantity_after: number;
  notes: string | null;
  created_at: string;
  users: { name: string } | null;
}

interface IngredientForm {
  name: string;
  category: string;
  unit: string;
  unit_cost: string;
  current_stock: string;
  reorder_level: string;
  notes: string;
}

const UNITS = ['kg', 'g', 'litres', 'ml', 'pieces', 'bags', 'crates', 'bottles', 'loaves', 'bunches', 'trays', 'packets'];
const CATEGORIES = ['Dry Goods', 'Produce', 'Meat & Poultry', 'Dairy & Eggs', 'Beverages', 'Oils & Fats', 'Spices & Condiments', 'Cleaning & Hygiene', 'Packaging', 'Other'];

const EMPTY_FORM: IngredientForm = {
  name: '', category: '', unit: 'kg',
  unit_cost: '', current_stock: '0', reorder_level: '0', notes: '',
};

function fmt(n: number, currency: string) {
  return new Intl.NumberFormat('en-KE', { style: 'currency', currency, minimumFractionDigits: 2 }).format(n);
}

function stockStatus(i: Ingredient): 'ok' | 'low' | 'out' {
  if (i.current_stock <= 0) return 'out';
  if (i.reorder_level > 0 && i.current_stock <= i.reorder_level) return 'low';
  return 'ok';
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function IngredientsPage() {
  const { can } = usePermissions();
  const { business } = useBusiness();
  const currency = business?.currency ?? 'KES';
  const { toast, showToast } = useToast();
  const canManage = can('ingredients.manage');

  // ── State ──────────────────────────────────────────────────────────────────
  const [ingredients, setIngredients]   = useState<Ingredient[]>([]);
  const [loading, setLoading]           = useState(true);
  const [search, setSearch]             = useState('');
  const [filterCat, setFilterCat]       = useState('');
  const [filterStatus, setFilterStatus] = useState('active');

  // Ingredient modal
  const [modal, setModal]       = useState<'add' | Ingredient | null>(null);
  const [form, setForm]         = useState<IngredientForm>(EMPTY_FORM);
  const [saving, setSaving]     = useState(false);
  const [formError, setFormError] = useState('');

  // Adjust stock modal
  const [adjustTarget, setAdjustTarget] = useState<Ingredient | null>(null);
  const [adjustType, setAdjustType]     = useState<'add' | 'remove' | 'set'>('add');
  const [adjustQty, setAdjustQty]       = useState('');
  const [adjustNote, setAdjustNote]     = useState('');
  const [adjusting, setAdjusting]       = useState(false);

  // Movements drawer
  const [movementsFor, setMovementsFor] = useState<Ingredient | null>(null);
  const [movements, setMovements]       = useState<Movement[]>([]);
  const [movLoading, setMovLoading]     = useState(false);

  // ── Load ───────────────────────────────────────────────────────────────────
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filterStatus) params.set('status', filterStatus);
      const data = await api.get<Ingredient[]>(`/api/stock/ingredients?${params}`);
      setIngredients(data ?? []);
    } catch { /* silent */ } finally { setLoading(false); }
  }, [filterStatus]);

  useEffect(() => { load(); }, [load]);

  const loadMovements = useCallback(async (ingredient: Ingredient) => {
    setMovLoading(true);
    setMovements([]);
    try {
      const data = await api.get<Movement[]>(`/api/stock/ingredients/${ingredient.id}/movements?limit=30`);
      setMovements(data ?? []);
    } catch { /* silent */ } finally { setMovLoading(false); }
  }, []);

  // ── Ingredient CRUD ────────────────────────────────────────────────────────
  const openAdd = () => { setForm(EMPTY_FORM); setFormError(''); setModal('add'); };
  const openEdit = (i: Ingredient) => {
    setForm({
      name: i.name, category: i.category ?? '',
      unit: i.unit, unit_cost: i.unit_cost != null ? String(i.unit_cost) : '',
      current_stock: String(i.current_stock), reorder_level: String(i.reorder_level),
      notes: i.notes ?? '',
    });
    setFormError('');
    setModal(i);
  };

  const save = async () => {
    if (!form.name.trim())   { setFormError('Name is required'); return; }
    if (!form.unit.trim())   { setFormError('Unit is required'); return; }
    setSaving(true); setFormError('');
    try {
      const payload = {
        name: form.name.trim(),
        category: form.category.trim() || null,
        unit: form.unit.trim(),
        unit_cost: form.unit_cost ? Number(form.unit_cost) : null,
        reorder_level: Number(form.reorder_level || 0),
        notes: form.notes.trim() || null,
        ...(modal === 'add' ? { current_stock: Number(form.current_stock || 0) } : {}),
      };
      if (modal === 'add') {
        await api.post('/api/stock/ingredients', payload);
      } else {
        await api.patch(`/api/stock/ingredients/${(modal as Ingredient).id}`, payload);
      }
      await load();
      setModal(null);
    } catch (e: any) { setFormError(e.message ?? 'Save failed'); }
    finally { setSaving(false); }
  };

  const toggleStatus = async (i: Ingredient) => {
    const newStatus = i.status === 'active' ? 'inactive' : 'active';
    try {
      await api.patch(`/api/stock/ingredients/${i.id}`, { status: newStatus });
      await load();
    } catch { /* silent */ }
  };

  // ── Stock Adjustment ───────────────────────────────────────────────────────
  const openAdjust = (i: Ingredient) => {
    setAdjustTarget(i); setAdjustType('add'); setAdjustQty(''); setAdjustNote('');
  };

  const doAdjust = async () => {
    if (!adjustTarget) return;
    const qty = parseFloat(adjustQty);
    if (!adjustQty || isNaN(qty) || qty < 0) { showToast('Enter a valid quantity', 'warning'); return; }
    setAdjusting(true);
    try {
      await api.post(`/api/stock/ingredients/${adjustTarget.id}/adjust`, {
        type: adjustType, quantity: qty, notes: adjustNote.trim() || undefined,
      });
      await load();
      setAdjustTarget(null);
    } catch (e: any) { showToast(e.message ?? 'Adjustment failed', 'error'); }
    finally { setAdjusting(false); }
  };

  // ── Movements drawer ───────────────────────────────────────────────────────
  const openMovements = async (i: Ingredient) => {
    setMovementsFor(i);
    await loadMovements(i);
  };

  // ── Derived list ───────────────────────────────────────────────────────────
  const visible = ingredients.filter(i => {
    if (filterCat && i.category !== filterCat) return false;
    if (search && !i.name.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const categories = [...new Set(ingredients.map(i => i.category).filter(Boolean))] as string[];
  const lowCount = ingredients.filter(i => stockStatus(i) !== 'ok').length;

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <>
      <Toast toast={toast} />
    <div className="flex-1 overflow-y-auto p-6 space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-white">Ingredients<span className="text-[10px] font-medium text-blue-400 bg-blue-500/10 border border-blue-500/20 rounded-full px-2 py-0.5 ml-2 align-middle">All branches</span></h1>
          <p className="text-gray-400 text-sm mt-0.5">Raw supplies you order from suppliers</p>
        </div>
        <div className="flex items-center gap-3">
          {lowCount > 0 && (
            <span className="px-3 py-1.5 bg-amber-500/10 border border-amber-500/20 rounded-lg text-amber-400 text-xs font-medium">
              ⚠ {lowCount} low/out of stock
            </span>
          )}
          {canManage && (
            <button
              onClick={openAdd}
              className="px-4 py-2 bg-green-500 hover:bg-green-400 text-black text-sm font-semibold rounded-lg transition-colors"
            >+ Add Ingredient</button>
          )}
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 items-center">
        <input
          type="text"
          placeholder="Search ingredients…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="bg-gray-900 border border-gray-800 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-green-500 w-56"
        />
        <select
          value={filterCat}
          onChange={e => setFilterCat(e.target.value)}
          className="bg-gray-900 border border-gray-800 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-green-500"
        >
          <option value="">All categories</option>
          {categories.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <div className="flex rounded-lg overflow-hidden border border-gray-800">
          {['active', 'inactive', ''].map((s, idx) => (
            <button key={idx}
              onClick={() => setFilterStatus(s)}
              className={`px-3 py-2 text-xs font-medium transition-colors ${filterStatus === s ? 'bg-green-500 text-black' : 'bg-gray-900 text-gray-400 hover:text-white'}`}
            >{s === '' ? 'All' : s === 'active' ? 'Active' : 'Inactive'}</button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
        {loading ? (
          <div className="py-16 text-center text-gray-500 text-sm">Loading…</div>
        ) : visible.length === 0 ? (
          <div className="py-16 text-center">
            <p className="text-4xl mb-3">🧂</p>
            <p className="text-gray-400 text-sm font-medium">No ingredients found</p>
            {canManage && <p className="text-gray-600 text-xs mt-1">Click "+ Add Ingredient" to get started.</p>}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800">
                {['Name', 'Category', 'Unit', 'In Stock', 'Reorder At', 'Unit Cost', 'Status', ''].map(h => (
                  <th key={h} className="text-left text-gray-500 text-xs font-semibold px-4 py-3 uppercase tracking-wider">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map(i => {
                const st = stockStatus(i);
                return (
                  <tr key={i.id} className="border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors group">
                    <td className="px-4 py-3">
                      <p className="text-white font-medium">{i.name}</p>
                      {i.notes && <p className="text-gray-600 text-xs truncate max-w-xs">{i.notes}</p>}
                    </td>
                    <td className="px-4 py-3">
                      {i.category
                        ? <span className="px-2 py-0.5 bg-gray-800 text-gray-300 rounded text-xs">{i.category}</span>
                        : <span className="text-gray-600 text-xs">—</span>}
                    </td>
                    <td className="px-4 py-3 text-gray-400 text-xs">{i.unit}</td>
                    <td className="px-4 py-3">
                      <span className={`font-semibold text-sm ${st === 'out' ? 'text-red-400' : st === 'low' ? 'text-amber-400' : 'text-white'}`}>
                        {i.current_stock} {i.unit}
                      </span>
                      {st === 'out' && <span className="ml-1.5 text-xs text-red-500">OUT</span>}
                      {st === 'low' && <span className="ml-1.5 text-xs text-amber-500">LOW</span>}
                    </td>
                    <td className="px-4 py-3 text-gray-400 text-sm">
                      {i.reorder_level > 0 ? `${i.reorder_level} ${i.unit}` : <span className="text-gray-600">—</span>}
                    </td>
                    <td className="px-4 py-3 text-gray-300 text-sm">
                      {i.unit_cost != null ? fmt(i.unit_cost, currency) : <span className="text-gray-600">—</span>}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-0.5 rounded text-xs font-medium ${i.status === 'active' ? 'bg-green-500/10 text-green-400' : 'bg-gray-800 text-gray-500'}`}>
                        {i.status}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 justify-end transition-opacity">
                        <button onClick={() => openMovements(i)} className="text-gray-500 hover:text-blue-400 text-xs transition-colors" title="History">History</button>
                        {canManage && (
                          <>
                            <button onClick={() => openAdjust(i)} className="text-gray-500 hover:text-amber-400 text-xs transition-colors">Adjust</button>
                            <button onClick={() => openEdit(i)} className="text-gray-500 hover:text-white text-xs transition-colors">Edit</button>
                            <button onClick={() => toggleStatus(i)} className="text-gray-500 hover:text-red-400 text-xs transition-colors">
                              {i.status === 'active' ? 'Deactivate' : 'Activate'}
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* ── Add / Edit Modal ── */}
      {modal !== null && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-800 rounded-2xl w-full max-w-lg shadow-2xl">
            <div className="px-6 py-4 border-b border-gray-800">
              <h2 className="text-white font-semibold">{modal === 'add' ? 'Add Ingredient' : `Edit — ${(modal as Ingredient).name}`}</h2>
            </div>
            <div className="px-6 py-5 space-y-4 max-h-[70vh] overflow-y-auto">

              {/* Name */}
              <div className="grid grid-cols-2 gap-4">
                <div className="col-span-2">
                  <label className="block text-gray-400 text-xs mb-1.5">Name <span className="text-red-400">*</span></label>
                  <input type="text" placeholder="e.g. Maize Flour, Kales, Cooking Oil…"
                    value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-green-500"
                  />
                </div>

                {/* Category */}
                <div>
                  <label className="block text-gray-400 text-xs mb-1.5">Category</label>
                  <select value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-green-500">
                    <option value="">— None —</option>
                    {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>

                {/* Unit */}
                <div>
                  <label className="block text-gray-400 text-xs mb-1.5">Unit <span className="text-red-400">*</span></label>
                  <select value={form.unit} onChange={e => setForm(f => ({ ...f, unit: e.target.value }))}
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-green-500">
                    {UNITS.map(u => <option key={u} value={u}>{u}</option>)}
                  </select>
                </div>

                {/* Unit Cost */}
                <div>
                  <label className="block text-gray-400 text-xs mb-1.5">Unit Cost ({currency})</label>
                  <input type="number" min="0" step="0.01" placeholder="0.00"
                    value={form.unit_cost} onChange={e => setForm(f => ({ ...f, unit_cost: e.target.value }))}
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-green-500"
                  />
                </div>

                {/* Reorder Level */}
                <div>
                  <label className="block text-gray-400 text-xs mb-1.5">Reorder Level</label>
                  <input type="number" min="0" step="0.01" placeholder="0"
                    value={form.reorder_level} onChange={e => setForm(f => ({ ...f, reorder_level: e.target.value }))}
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-green-500"
                  />
                </div>

                {/* Opening Stock — only on add */}
                {modal === 'add' && (
                  <div className="col-span-2">
                    <label className="block text-gray-400 text-xs mb-1.5">Opening Stock (current qty on hand)</label>
                    <input type="number" min="0" step="0.01" placeholder="0"
                      value={form.current_stock} onChange={e => setForm(f => ({ ...f, current_stock: e.target.value }))}
                      className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-green-500"
                    />
                  </div>
                )}

                {/* Notes */}
                <div className="col-span-2">
                  <label className="block text-gray-400 text-xs mb-1.5">Notes (optional)</label>
                  <input type="text" placeholder="e.g. Keep refrigerated, buy from Wakulima…"
                    value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-green-500"
                  />
                </div>
              </div>

              {formError && (
                <p className="text-red-400 text-xs bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">{formError}</p>
              )}
            </div>
            <div className="px-6 py-4 border-t border-gray-800 flex justify-end gap-3">
              <button onClick={() => setModal(null)} className="px-4 py-2 text-gray-400 hover:text-white text-sm transition-colors">Cancel</button>
              <button onClick={save} disabled={saving}
                className="px-5 py-2 bg-green-500 hover:bg-green-400 disabled:opacity-50 text-black text-sm font-semibold rounded-lg transition-colors">
                {saving ? 'Saving…' : modal === 'add' ? 'Add Ingredient' : 'Save Changes'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Adjust Stock Modal ── */}
      {adjustTarget && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-800 rounded-2xl w-full max-w-sm shadow-2xl">
            <div className="px-6 py-4 border-b border-gray-800">
              <h2 className="text-white font-semibold">Adjust Stock</h2>
              <p className="text-gray-500 text-xs mt-0.5">{adjustTarget.name} — current: <span className="text-white">{adjustTarget.current_stock} {adjustTarget.unit}</span></p>
            </div>
            <div className="px-6 py-5 space-y-4">
              {/* Type */}
              <div className="flex rounded-lg overflow-hidden border border-gray-700">
                {(['add', 'remove', 'set'] as const).map(t => (
                  <button key={t} onClick={() => setAdjustType(t)}
                    className={`flex-1 py-2 text-sm font-medium capitalize transition-colors ${adjustType === t ? 'bg-green-500 text-black' : 'bg-gray-800 text-gray-400 hover:text-white'}`}>
                    {t}
                  </button>
                ))}
              </div>
              <div>
                <label className="block text-gray-400 text-xs mb-1.5">
                  Quantity ({adjustTarget.unit})
                  {adjustType === 'set' && <span className="text-gray-600"> — set absolute value</span>}
                </label>
                <input type="number" min="0" step="0.01" placeholder="0"
                  value={adjustQty} onChange={e => setAdjustQty(e.target.value)}
                  autoFocus
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-green-500"
                />
              </div>
              <div>
                <label className="block text-gray-400 text-xs mb-1.5">Reason (optional)</label>
                <input type="text" placeholder="e.g. Spoilage, Stock count correction…"
                  value={adjustNote} onChange={e => setAdjustNote(e.target.value)}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-green-500"
                />
              </div>
            </div>
            <div className="px-6 py-4 border-t border-gray-800 flex gap-3">
              <button onClick={() => setAdjustTarget(null)} className="flex-1 bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm font-medium py-2.5 rounded-lg transition-colors">Cancel</button>
              <button onClick={doAdjust} disabled={adjusting}
                className="flex-1 bg-green-500 hover:bg-green-400 disabled:opacity-50 text-black text-sm font-semibold py-2.5 rounded-lg transition-colors">
                {adjusting ? 'Saving…' : 'Apply'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Movements Drawer ── */}
      {movementsFor && (
        <div className="fixed inset-0 bg-black/70 flex items-end sm:items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-800 rounded-2xl w-full max-w-lg shadow-2xl max-h-[80vh] flex flex-col">
            <div className="px-6 py-4 border-b border-gray-800 flex items-center justify-between">
              <div>
                <h2 className="text-white font-semibold">Stock History</h2>
                <p className="text-gray-500 text-xs mt-0.5">{movementsFor.name}</p>
              </div>
              <button onClick={() => setMovementsFor(null)} className="text-gray-500 hover:text-white transition-colors text-lg">✕</button>
            </div>
            <div className="overflow-y-auto flex-1 px-6 py-4 space-y-2">
              {movLoading ? (
                <p className="text-gray-500 text-sm text-center py-8">Loading…</p>
              ) : movements.length === 0 ? (
                <p className="text-gray-600 text-sm text-center py-8">No movements recorded yet.</p>
              ) : movements.map(m => {
                const isPositive = m.quantity_change > 0;
                const typeColors: Record<string, string> = {
                  restock: 'text-green-400', opening: 'text-blue-400',
                  adjustment: 'text-amber-400', wastage: 'text-red-400',
                };
                return (
                  <div key={m.id} className="flex items-start justify-between gap-4 py-2.5 border-b border-gray-800/50">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className={`text-xs font-semibold capitalize ${typeColors[m.movement_type] ?? 'text-gray-400'}`}>{m.movement_type}</span>
                        {m.notes && <span className="text-gray-500 text-xs truncate">{m.notes}</span>}
                      </div>
                      <p className="text-gray-600 text-xs mt-0.5">
                        {new Date(m.created_at).toLocaleString('en-KE', { dateStyle: 'medium', timeStyle: 'short' })}
                        {m.users?.name && ` · ${m.users.name}`}
                      </p>
                    </div>
                    <div className="text-right flex-shrink-0">
                      <p className={`text-sm font-semibold ${isPositive ? 'text-green-400' : 'text-red-400'}`}>
                        {isPositive ? '+' : ''}{m.quantity_change} {movementsFor.unit}
                      </p>
                      <p className="text-gray-600 text-xs">→ {m.quantity_after} {movementsFor.unit}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}