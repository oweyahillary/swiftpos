import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useBusiness } from '../../context/BusinessContext';
import type { Category } from '../../types';
import ConfirmModal, { useConfirm } from '../../components/ConfirmModal';

const COLORS = ['#22c55e', '#3b82f6', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316'];

const EMPTY = { name: '', color: COLORS[0] };

export default function CategoriesPage() {
  const { business } = useBusiness();
  const [confirmState, showConfirm, closeConfirm] = useConfirm();
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<Category | null>(null);
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const fetchCategories = async () => {
    if (!business) return;
    const data = await api.get<Category[]>('/api/categories');
    setCategories(data ?? []);
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
    setForm({ name: cat.name, color: cat.color ?? COLORS[0] });
    setError('');
    setShowModal(true);
  };

  const handleSave = async () => {
    if (!form.name.trim() || !business) return;
    setSaving(true);
    setError('');

    try {
      if (editing) {
        await api.patch(`/api/categories/${editing.id}`, {
          name: form.name,
          color: form.color,
        });
      } else {
        await api.post('/api/categories', {
          name: form.name,
          color: form.color,
          sort_order: categories.length,
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

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Categories</h1>
          <p className="text-gray-400 text-sm mt-0.5">Organise your products into categories · <span className="text-blue-400/70">shared across all branches</span></p>
        </div>
        <button onClick={openNew} className="bg-green-500 hover:bg-green-400 text-gray-950 font-semibold px-4 py-2 rounded-lg text-sm transition-colors">
          + New category
        </button>
      </div>

      {loading ? (
        <div className="flex justify-center py-20">
          <div className="w-6 h-6 border-2 border-green-400 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : categories.length === 0 ? (
        <div className="text-center py-20 text-gray-500">
          <p className="text-lg">No categories yet</p>
          <p className="text-sm mt-1">Create your first category to get started</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {categories.map(cat => (
            <div key={cat.id} className="bg-gray-900 border border-gray-800 rounded-xl p-4 flex items-center gap-4">
              <div className="w-10 h-10 rounded-lg flex-shrink-0 flex items-center justify-center text-base font-semibold" style={{ backgroundColor: cat.color + '22', color: cat.color ?? '#fff' }}>
                {cat.name?.[0]?.toUpperCase() ?? ''}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-white font-medium truncate">{cat.name}</p>
                <p className={`text-xs mt-0.5 ${cat.status === 'active' ? 'text-green-400' : 'text-gray-500'}`}>
                  {cat.status}
                </p>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
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
      )}

      {/* Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 px-4">
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6 w-full max-w-sm space-y-4">
            <h2 className="text-white font-semibold text-lg">{editing ? 'Edit category' : 'New category'}</h2>

            <div>
              <label className="block text-sm text-gray-400 mb-1.5">Name</label>
              <input
                type="text"
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder="e.g. Diesel"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-white placeholder-gray-600 focus:outline-none focus:border-green-500 transition-colors"
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

            {error && <p className="text-red-400 text-sm">{error}</p>}

            <div className="flex gap-3 pt-1">
              <button onClick={() => setShowModal(false)} className="flex-1 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg py-2.5 text-sm transition-colors">
                Cancel
              </button>
              <button onClick={handleSave} disabled={saving || !form.name.trim()} className="flex-1 bg-green-500 hover:bg-green-400 disabled:opacity-40 text-gray-950 font-semibold rounded-lg py-2.5 text-sm transition-colors">
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
