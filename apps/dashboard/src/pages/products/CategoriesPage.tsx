import { useEffect, useState } from 'react';
import { useTerm } from '../../lib/terminology';
import { api } from '../../lib/api';
import { useBusiness } from '../../context/BusinessContext';
import type { Category, Menu } from '../../types';
import ConfirmModal, { useConfirm } from '../../components/ConfirmModal';
import Pager, { usePageSize } from '../../components/Pager';   // A475
import { paginate } from '@zaptill/core/paginate';

const COLORS = ['#22c55e', '#3b82f6', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316'];

const EMPTY = { name: '', color: COLORS[0], menu_id: '' };

export default function CategoriesPage() {
  const { business } = useBusiness();
  const { term, lower, terms } = useTerm();   // A573: terms.menu — Menu / Department / Group
  const [confirmState, showConfirm, closeConfirm] = useConfirm();
  const [categories, setCategories] = useState<Category[]>([]);
  // A537: the business's menus (Food, Soft drinks …) — a category is under one of them, or none.
  const [menus, setMenus] = useState<Menu[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<Category | null>(null);
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [page, setPage] = useState(1);   // A475
  const [pageSize, setPageSize] = usePageSize('swiftpos.pageSize.categories');

  const fetchCategories = async () => {
    if (!business) return;
    const [data, m] = await Promise.all([
      api.get<Category[]>('/api/categories'),
      api.get<Menu[]>('/api/menus').catch(() => [] as Menu[]),   // A537 (an older cloud: no menus)
    ]);
    setCategories(data ?? []);
    setMenus((m ?? []).slice().sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)));
    setLoading(false);
  };

  useEffect(() => { fetchCategories(); }, [business]);

  const openNew = () => {
    setEditing(null);
    setForm(EMPTY);
    setError('');
    setShowModal(true);
  };

  const openEdit = (cat: Category) => {
    setEditing(cat);
    setForm({ name: cat.name, color: cat.color ?? COLORS[0], menu_id: cat.menu_id ?? '' });
    setError('');
    setShowModal(true);
  };

  const handleSave = async () => {
    // A257: an empty name used to silently return (button disabled, no message), so a
    // user got no feedback. Surface the reason instead of no-op'ing.
    if (!form.name.trim()) { setError('Name is required'); return; }
    if (!business) return;
    setSaving(true);
    setError('');

    try {
      if (editing) {
        await api.patch(`/api/categories/${editing.id}`, {
          name: form.name,
          color: form.color,
          ...(menus.length || editing.menu_id ? { menu_id: form.menu_id || null } : {}),
        });
      } else {
        await api.post('/api/categories', {
          name: form.name,
          color: form.color,
          sort_order: categories.length,
          ...(form.menu_id ? { menu_id: form.menu_id } : {}),
        });
      }
      await fetchCategories();
      setSaving(false);
      setShowModal(false);
    } catch (err: any) {
      setError(err.message);
      setSaving(false);
    }
  };

  // A537: put a category under a menu straight from its card ("No menu" allowed).
  const setMenu = async (cat: Category, menuId: string) => {
    try {
      await api.patch(`/api/categories/${cat.id}`, { menu_id: menuId || null });
      await fetchCategories();
    } catch (err: any) { setError(err.message); }
  };
  const menuName = (id?: string | null) => menus.find(m => m.id === id)?.name ?? null;

  const toggleStatus = async (cat: Category) => {
    await api.patch(`/api/categories/${cat.id}`, {
      status: cat.status === 'active' ? 'inactive' : 'active',
    });
    await fetchCategories();
  };

  const handleDelete = async (id: string) => {
    showConfirm({
      title: 'Delete category?',
      message: 'Products in this category will become uncategorised.',
      intent: 'destructive',
      confirmLabel: 'Delete',
      onConfirm: async () => {
        await api.delete(`/api/categories/${id}`);
        await fetchCategories();
      },
    });
  };

  // A475: the categories in pages (25 / 50 / 100, remembered in this browser); an edit, enable / disable or delete keeps
  // the page (clamped).
  const paged = paginate(categories, page, pageSize);
  useEffect(() => { if (paged.page !== page) setPage(paged.page); }, [paged.page, page]);

  return (
    <div className="p-4 sm:p-8">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">{term('categories')}</h1>
          <p className="text-gray-400 text-sm mt-0.5">Organise your products into categories · <span className="text-blue-400/70">shared across all branches</span></p>
        </div>
        <button onClick={openNew} className="bg-swift hover:bg-swift-light text-gray-950 font-semibold px-4 py-2 rounded-lg text-sm transition-colors">
          + New category
        </button>
      </div>

      {error && !showModal && <p className="text-red-400 text-sm mb-4">{error}</p>}
      {loading ? (
        <div className="flex justify-center py-20">
          <div className="w-6 h-6 border-2 border-swift border-t-transparent rounded-full animate-spin" />
        </div>
      ) : categories.length === 0 ? (
        <div className="text-center py-20 text-gray-500">
          <p className="text-lg">No categories yet</p>
          <p className="text-sm mt-1">Create your first category to get started</p>
        </div>
      ) : (<>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {paged.items.map(cat => (
            <div key={cat.id} className="bg-gray-900 border border-gray-800 rounded-xl p-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg flex-shrink-0 flex items-center justify-center text-base font-semibold" style={{ backgroundColor: cat.color + '22', color: cat.color ?? '#fff' }}>
                  {cat.name?.[0]?.toUpperCase() ?? ''}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-white font-medium truncate" title={cat.name}>{cat.name}</p>
                  <p className={`text-xs mt-0.5 ${cat.status === 'active' ? 'text-green-400' : 'text-gray-500'}`}>
                    {cat.status}
                  </p>
                </div>
              </div>
              {/* A537: the menu this category is under — shown once the business has a menu. */}
              {(menus.length > 0 || cat.menu_id) && (
                <label className="flex items-center gap-2 mt-3 text-xs text-gray-400">
                  {terms.menu}
                  <select data-testid="category-menu" value={cat.menu_id ?? ''} onChange={e => void setMenu(cat, e.target.value)}
                    className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-white text-xs focus:outline-none focus:border-swift">
                    <option value="">{terms.noMenu}</option>
                    {menus.map(m => <option key={m.id} value={m.id}>{m.name}{m.active ? '' : ' (off)'}</option>)}
                    {cat.menu_id && !menuName(cat.menu_id) && <option value={cat.menu_id}>(a deleted {terms.menu.toLowerCase()})</option>}
                  </select>
                </label>
              )}
              <div className="flex items-center gap-2 mt-3 pt-3 border-t border-gray-800">
                <button onClick={() => toggleStatus(cat)} className="text-xs text-gray-400 hover:text-white px-2 py-1 rounded hover:bg-gray-800 transition-colors">
                  {cat.status === 'active' ? 'Disable' : 'Enable'}
                </button>
                <button onClick={() => openEdit(cat)} className="text-xs text-gray-400 hover:text-white px-2 py-1 rounded hover:bg-gray-800 transition-colors">
                  Edit
                </button>
                <button onClick={() => handleDelete(cat.id)} className="text-xs text-red-400 hover:text-red-300 px-2 py-1 rounded hover:bg-gray-800 transition-colors">
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
        <Pager paged={paged} noun="categories" onPage={setPage} onSize={n => { setPageSize(n); setPage(1); }} />
      </>)}

      {/* Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 px-4">
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6 w-full max-w-sm space-y-4">
            <h2 className="text-white font-semibold text-lg">{editing ? `Edit ${lower('category')}` : `New ${lower('category')}`}</h2>

            <div>
              <label className="block text-sm text-gray-400 mb-1.5">Name</label>
              <input
                type="text"
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder="e.g. Beverages"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-white placeholder-gray-600 focus:outline-none focus:border-swift transition-colors"
              />
            </div>

            <div>
              <label className="block text-sm text-gray-400 mb-1.5">Color</label>
              <div className="flex gap-2 flex-wrap">
                {COLORS.map(c => (
                  <button
                    key={c}
                    onClick={() => setForm(f => ({ ...f, color: c }))}
                    className={`w-7 h-7 rounded-full border-2 transition-all ${form.color === c ? 'border-white scale-110' : 'border-transparent'}`}
                    style={{ backgroundColor: c }}
                  />
                ))}
              </div>
            </div>

            {menus.length > 0 && (
              <div>
                <label className="block text-sm text-gray-400 mb-1.5">{terms.menu}</label>
                <select value={form.menu_id} onChange={e => setForm(f => ({ ...f, menu_id: e.target.value }))}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-white focus:outline-none focus:border-swift transition-colors">
                  <option value="">{terms.noMenu}</option>
                  {menus.map(m => <option key={m.id} value={m.id}>{m.name}{m.active ? '' : ' (off)'}</option>)}
                </select>
              </div>
            )}

            {error && <p className="text-red-400 text-sm">{error}</p>}

            <div className="flex gap-3 pt-1">
              <button onClick={() => setShowModal(false)} className="flex-1 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg py-2.5 text-sm transition-colors">
                Cancel
              </button>
              <button onClick={handleSave} disabled={saving} className="flex-1 bg-swift hover:bg-swift-light disabled:opacity-40 text-gray-950 font-semibold rounded-lg py-2.5 text-sm transition-colors">
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
      <ConfirmModal state={confirmState} onClose={closeConfirm} />
    </div>
  );
}
