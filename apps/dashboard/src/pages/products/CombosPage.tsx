/**
 * CombosPage.tsx
 * Route: /dashboard/combos
 *
 * Build and manage combo / set meals. A combo bundles existing products
 * at a fixed price. Combos appear in the POS alongside regular products.
 */

import { useState, useEffect, useCallback } from 'react';
import { api } from '../../lib/api';
import ConfirmModal, { useConfirm } from '../../components/ConfirmModal';

interface ComboProduct {
  id: string; name: string; price: number; image_url: string | null;
}

interface ComboItem {
  id: string;
  quantity: number;
  sort_order: number;
  product: ComboProduct;
}

interface Combo {
  id: string;
  name: string;
  description: string | null;
  price: number;
  combo_price: number;
  status: 'active' | 'inactive';
  image_url: string | null;
  combo_items: ComboItem[];
}

interface Category { id: string; name: string; }
interface Product   { id: string; name: string; price: number; category_id: string | null; }

interface ComboForm {
  name: string;
  description: string;
  combo_price: string;
  category_id: string;
  items: { product_id: string; quantity: number }[];
}

const BLANK: ComboForm = { name: '', description: '', combo_price: '', category_id: '', items: [] };

export default function CombosPage() {
  const [confirmState, showConfirm, closeConfirm] = useConfirm();
  const [combos,     setCombos]     = useState<Combo[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [products,   setProducts]   = useState<Product[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [showForm,   setShowForm]   = useState(false);
  const [editing,    setEditing]    = useState<Combo | null>(null);
  const [form,       setForm]       = useState<ComboForm>(BLANK);
  const [saving,     setSaving]     = useState(false);
  const [error,      setError]      = useState('');
  const [search,     setSearch]     = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [c, cats, prods] = await Promise.all([
        api.get<Combo[]>('/api/combos'),
        api.get<Category[]>('/api/categories'),
        api.get<Product[]>('/api/products'),
      ]);
      setCombos(c ?? []);
      setCategories(cats ?? []);
      setProducts((prods ?? []).filter((p: any) => !p.is_combo));
    } catch { /* silent */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  function openCreate() {
    setEditing(null); setForm(BLANK); setError(''); setShowForm(true);
  }

  function openEdit(c: Combo) {
    setEditing(c);
    setForm({
      name:        c.name,
      description: c.description ?? '',
      combo_price: String(c.combo_price),
      category_id: '',
      items:       c.combo_items.map(i => ({ product_id: i.product.id, quantity: i.quantity })),
    });
    setError(''); setShowForm(true);
  }

  async function save() {
    if (!form.name.trim())   { setError('Name is required'); return; }
    if (!form.combo_price || Number(form.combo_price) <= 0) { setError('Price is required'); return; }
    if (form.items.length === 0) { setError('Add at least one item to the combo'); return; }
    setSaving(true); setError('');
    try {
      if (editing) {
        await api.patch(`/api/combos/${editing.id}`, {
          name: form.name.trim(), description: form.description || null,
          combo_price: Number(form.combo_price),
        });
        await api.put(`/api/combos/${editing.id}/items`, { items: form.items });
      } else {
        await api.post('/api/combos', {
          name: form.name.trim(), description: form.description || null,
          combo_price: Number(form.combo_price), category_id: form.category_id || null,
          items: form.items,
        });
      }
      setShowForm(false); await load();
    } catch (e: any) { setError(e.message ?? 'Failed to save'); }
    finally { setSaving(false); }
  }

  async function toggle(c: Combo) {
    try {
      await api.patch(`/api/combos/${c.id}`, { status: c.status === 'active' ? 'inactive' : 'active' });
      setCombos(prev => prev.map(x => x.id === c.id ? { ...x, status: x.status === 'active' ? 'inactive' : 'active' } : x));
    } catch { /* silent */ }
  }

  async function remove(id: string) {
    showConfirm({
      title: 'Delete combo?',
      message: 'This cannot be undone.',
      intent: 'destructive',
      confirmLabel: 'Delete',
      onConfirm: async () => {
        await api.delete(`/api/combos/${id}`);
        setCombos(prev => prev.filter(c => c.id !== id));
      },
    });
  }

  function addItem(productId: string) {
    if (form.items.find(i => i.product_id === productId)) return;
    setForm(f => ({ ...f, items: [...f.items, { product_id: productId, quantity: 1 }] }));
  }

  function removeItem(productId: string) {
    setForm(f => ({ ...f, items: f.items.filter(i => i.product_id !== productId) }));
  }

  function changeQty(productId: string, qty: number) {
    setForm(f => ({ ...f, items: f.items.map(i => i.product_id === productId ? { ...i, quantity: Math.max(1, qty) } : i) }));
  }

  const fmt = (n: number) => `KES ${Number(n).toLocaleString('en-KE', { minimumFractionDigits: 2 })}`;
  const filtered = combos.filter(c => c.name.toLowerCase().includes(search.toLowerCase()));
  const availableProducts = products.filter(p => !form.items.find(i => i.product_id === p.id));

  function individualTotal() {
    return form.items.reduce((sum, item) => {
      const p = products.find(p => p.id === item.product_id);
      return sum + (p?.price ?? 0) * item.quantity;
    }, 0);
  }

  const saving_ = individualTotal();
  const comboPrice = Number(form.combo_price) || 0;
  const savingAmount = saving_ - comboPrice;

  return (
    <div className="flex flex-col h-full">
      <div className="px-6 pt-6 pb-4 border-b border-gray-800 flex-shrink-0 flex items-center justify-between">
        <div>
          <h1 className="text-white text-2xl font-bold">Combo Meals</h1>
          <p className="text-gray-500 text-sm mt-1">Bundle products into set meals at a fixed price</p>
        </div>
        <button onClick={openCreate}
          className="px-4 py-2 bg-blue-700 hover:bg-blue-600 text-white text-sm font-bold rounded-lg transition-colors">
          + New combo
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="mb-4">
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search combos…"
            className="w-full max-w-sm bg-gray-900 border border-gray-700 rounded-xl px-4 py-2.5 text-white text-sm focus:outline-none focus:border-blue-500" />
        </div>

        {loading ? (
          <div className="text-center py-16 text-gray-500 text-sm">Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-20">
            <p className="text-4xl mb-3">🍱</p>
            <p className="text-gray-400 text-sm mb-1">No combos yet.</p>
            <p className="text-gray-600 text-xs">Create a combo meal to bundle products at a fixed price.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {filtered.map(c => {
              const indiv = c.combo_items.reduce((s, i) => s + i.product.price * i.quantity, 0);
              const saving = indiv - c.combo_price;
              return (
                <div key={c.id} className={`border rounded-2xl overflow-hidden ${
                  c.status === 'active' ? 'border-gray-800 bg-gray-900' : 'border-gray-800/50 bg-gray-900/40 opacity-60'
                }`}>
                  <div className="p-4">
                    <div className="flex items-start justify-between gap-2 mb-3">
                      <div>
                        <p className="text-white font-semibold">{c.name}</p>
                        {c.description && <p className="text-gray-500 text-xs mt-0.5 line-clamp-1">{c.description}</p>}
                      </div>
                      {c.status === 'active'
                        ? <span className="text-[10px] text-green-400 font-semibold flex-shrink-0">● Active</span>
                        : <span className="text-[10px] text-gray-600 font-semibold flex-shrink-0">Inactive</span>}
                    </div>
                    <div className="space-y-1.5 mb-3">
                      {c.combo_items.sort((a, b) => a.sort_order - b.sort_order).map(i => (
                        <div key={i.id} className="flex items-center gap-2 text-xs">
                          <span className="text-gray-600">{i.quantity}×</span>
                          <span className="text-gray-300 flex-1">{i.product.name}</span>
                          <span className="text-gray-600">{fmt(i.product.price * i.quantity)}</span>
                        </div>
                      ))}
                    </div>
                    <div className="border-t border-gray-800 pt-3 flex items-center justify-between">
                      <div>
                        <p className="text-white font-bold text-lg">{fmt(c.combo_price)}</p>
                        {saving > 0 && (
                          <p className="text-green-400 text-xs">Save {fmt(saving)} vs individual</p>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex border-t border-gray-800">
                    <button onClick={() => toggle(c)}
                      className="flex-1 py-2.5 text-xs text-gray-400 hover:text-white hover:bg-gray-800 transition-colors">
                      {c.status === 'active' ? 'Deactivate' : 'Activate'}
                    </button>
                    <button onClick={() => openEdit(c)}
                      className="flex-1 py-2.5 text-xs text-blue-400 hover:bg-gray-800 transition-colors border-l border-gray-800">
                      Edit
                    </button>
                    <button onClick={() => remove(c.id)}
                      className="flex-1 py-2.5 text-xs text-red-400 hover:bg-gray-800 transition-colors border-l border-gray-800">
                      Delete
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Create / Edit drawer */}
      {showForm && (
        <div className="fixed inset-0 bg-black/70 flex items-end sm:items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-800 rounded-2xl w-full max-w-2xl shadow-2xl max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between px-6 py-5 border-b border-gray-800 flex-shrink-0">
              <h3 className="text-white font-bold text-lg">{editing ? 'Edit combo' : 'New combo meal'}</h3>
              <button onClick={() => setShowForm(false)} className="text-gray-500 hover:text-white text-xl">✕</button>
            </div>

            <div className="flex-1 overflow-y-auto">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-0 divide-y sm:divide-y-0 sm:divide-x divide-gray-800">
                {/* Left: combo details */}
                <div className="px-6 py-5 space-y-4">
                  <div>
                    <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Combo name *</label>
                    <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                      placeholder="e.g. Chicken Meal Deal, Family Combo"
                      className="w-full bg-gray-950 border border-gray-800 rounded-lg px-3.5 py-2.5 text-white text-sm focus:outline-none focus:border-blue-500" />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Description</label>
                    <textarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                      placeholder="What's in this combo?"
                      rows={2}
                      className="w-full bg-gray-950 border border-gray-800 rounded-lg px-3.5 py-2.5 text-white text-sm focus:outline-none focus:border-blue-500 resize-none" />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Combo price *</label>
                    <input type="number" min={0} step={0.01} value={form.combo_price}
                      onChange={e => setForm(f => ({ ...f, combo_price: e.target.value }))}
                      placeholder="0.00"
                      className="w-full bg-gray-950 border border-gray-800 rounded-lg px-3.5 py-2.5 text-white text-sm focus:outline-none focus:border-blue-500" />
                    {saving_ > 0 && comboPrice > 0 && (
                      <p className={`text-xs mt-1.5 ${savingAmount > 0 ? 'text-green-400' : 'text-amber-400'}`}>
                        Individual total: {fmt(saving_)}
                        {savingAmount > 0 ? ` · customer saves ${fmt(savingAmount)}` : ` · combo is ${fmt(-savingAmount)} more`}
                      </p>
                    )}
                  </div>
                  {!editing && categories.length > 0 && (
                    <div>
                      <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Category (optional)</label>
                      <select value={form.category_id} onChange={e => setForm(f => ({ ...f, category_id: e.target.value }))}
                        className="w-full bg-gray-950 border border-gray-800 rounded-lg px-3.5 py-2.5 text-white text-sm focus:outline-none focus:border-blue-500">
                        <option value="">— None —</option>
                        {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                      </select>
                    </div>
                  )}

                  {/* Selected items */}
                  <div>
                    <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
                      Items in combo ({form.items.length})
                    </label>
                    {form.items.length === 0 ? (
                      <p className="text-gray-600 text-xs py-3 text-center border border-dashed border-gray-800 rounded-lg">
                        Select products from the right →
                      </p>
                    ) : (
                      <div className="space-y-2">
                        {form.items.map(item => {
                          const p = products.find(p => p.id === item.product_id);
                          if (!p) return null;
                          return (
                            <div key={item.product_id} className="flex items-center gap-2 bg-gray-800 rounded-lg px-3 py-2">
                              <span className="flex-1 text-white text-xs font-medium truncate">{p.name}</span>
                              <div className="flex items-center gap-1">
                                <button onClick={() => changeQty(item.product_id, item.quantity - 1)}
                                  className="w-5 h-5 text-gray-400 hover:text-white bg-gray-700 rounded text-xs flex items-center justify-center">−</button>
                                <span className="text-white text-xs w-4 text-center">{item.quantity}</span>
                                <button onClick={() => changeQty(item.product_id, item.quantity + 1)}
                                  className="w-5 h-5 text-gray-400 hover:text-white bg-gray-700 rounded text-xs flex items-center justify-center">+</button>
                              </div>
                              <span className="text-gray-500 text-xs w-20 text-right">{fmt(p.price * item.quantity)}</span>
                              <button onClick={() => removeItem(item.product_id)}
                                className="text-gray-600 hover:text-red-400 text-xs ml-1">✕</button>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>

                {/* Right: product picker */}
                <div className="px-6 py-5">
                  <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">Add products</label>
                  <div className="space-y-1 max-h-72 overflow-y-auto pr-1">
                    {availableProducts.length === 0
                      ? <p className="text-gray-600 text-xs text-center py-4">All products added</p>
                      : availableProducts.map(p => (
                          <button key={p.id} onClick={() => addItem(p.id)}
                            className="w-full flex items-center justify-between text-left px-3 py-2 rounded-lg hover:bg-gray-800 transition-colors group">
                            <span className="text-gray-300 text-xs group-hover:text-white truncate">{p.name}</span>
                            <span className="text-gray-500 text-xs flex-shrink-0 ml-2">{fmt(p.price)}</span>
                          </button>
                        ))
                    }
                  </div>
                </div>
              </div>
            </div>

            <div className="px-6 py-4 border-t border-gray-800 flex gap-2.5 flex-shrink-0">
              {error && <p className="text-red-400 text-sm flex-1">{error}</p>}
              <button onClick={() => setShowForm(false)}
                className="px-5 py-2.5 border border-gray-700 rounded-lg text-gray-400 text-sm hover:border-gray-600 transition-colors">
                Cancel
              </button>
              <button onClick={save} disabled={saving}
                className="px-5 py-2.5 bg-blue-700 hover:bg-blue-600 disabled:opacity-40 rounded-lg text-white text-sm font-bold transition-colors">
                {saving ? 'Saving…' : editing ? 'Save changes' : 'Create combo'}
              </button>
            </div>
          </div>
        </div>
      )}
      <ConfirmModal state={confirmState} onClose={closeConfirm} />
    </div>
  );
}
