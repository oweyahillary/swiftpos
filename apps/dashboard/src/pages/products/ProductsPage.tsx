import { useEffect, useState, useRef } from 'react';
import { useTerm } from '../../lib/terminology';
import { api } from '../../lib/api';
import { useBusiness } from '../../context/BusinessContext';
import { uploadImage } from '../../lib/upload';
import type { Product, Category } from '../../types';
import VariantsDrawer from './VariantsDrawer';
import RecipeDrawer from './RecipeDrawer';
import ConfirmModal, { useConfirm } from '../../components/ConfirmModal';
import { ProductTableSkeleton } from '../pos/cashier/POSSkeletons';

const EMPTY_FORM = {
  name: '',
  description: '',
  base_price: '',
  category_id: '',
  track_stock: true,
  status: 'active' as 'active' | 'inactive',
  tax_type: 'B',
  kra_item_class_code: '',
  sold_by: 'each',
  is_fuel: false,
  fuel_unit: 'L',
};

export default function ProductsPage() {
  const { business } = useBusiness();
  const { term, lower } = useTerm();
  const [confirmState, showConfirm, closeConfirm] = useConfirm();
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<Product | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [filterCategory, setFilterCategory] = useState('');
  const [drawerProduct, setDrawerProduct] = useState<Product | null>(null);
  const [recipeProduct, setRecipeProduct] = useState<Product | null>(null);
  const [productRecipes, setProductRecipes] = useState<Set<string>>(new Set());
  const fileRef = useRef<HTMLInputElement>(null);

  const fetchAll = async () => {
    if (!business) return;
    const [prods, cats] = await Promise.all([
      api.get<Product[]>('/api/products'),
      api.get<Category[]>('/api/categories'),
    ]);
    setProducts(prods ?? []);
    setCategories(cats ?? []);
    setLoading(false);

    // Load which products have recipes (for the 🧂 badge)
    try {
      const allRecipes = await api.get<{ product_id: string }[]>('/api/recipes');
      setProductRecipes(new Set((allRecipes ?? []).map((r: any) => r.product_id)));
    } catch { /* non-critical */ }
  };

  useEffect(() => { fetchAll(); }, [business]);

  const openNew = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setImageFile(null);
    setImagePreview(null);
    setError('');
    setShowModal(true);
  };

  const openEdit = (p: Product) => {
    setEditing(p);
    setForm({
      name: p.name,
      description: p.description ?? '',
      base_price: String(p.base_price),
      category_id: p.category_id ?? '',
      track_stock: p.track_stock,
      status: p.status,
      tax_type: (p as any).tax_type ?? 'B',
      kra_item_class_code: (p as any).kra_item_class_code ?? '',
      sold_by: (p as any).sold_by ?? 'each',
      is_fuel: (p as any).is_fuel ?? false,
      fuel_unit: (p as any).fuel_unit ?? 'L',
    });
    setImageFile(null);
    setImagePreview(p.image_url);
    setError('');
    setShowModal(true);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImageFile(file);
    setImagePreview(URL.createObjectURL(file));
  };

  const handleSave = async () => {
    if (!form.name.trim() || !business) return;
    setSaving(true);
    setError('');

    let image_url = editing?.image_url ?? null;

    if (imageFile) {
      setUploading(true);
      try {
        image_url = await uploadImage(imageFile);
      } catch (e: any) {
        setError('Image upload failed: ' + e.message);
        setSaving(false);
        setUploading(false);
        return;
      }
      setUploading(false);
    }

    const payload = {
      name: form.name.trim(),
      description: form.description.trim() || null,
      base_price: parseFloat(form.base_price) || 0,
      category_id: form.category_id || null,
      track_stock: form.track_stock,
      status: form.status,
      image_url,
      tax_type: form.tax_type,
      kra_item_class_code: form.kra_item_class_code.trim() || null,
      sold_by: form.is_fuel ? 'volume' : form.sold_by,
      is_fuel: form.is_fuel,
      fuel_unit: form.is_fuel ? (form.fuel_unit || 'L') : null,
    };

    try {
      if (editing) {
        await api.patch(`/api/products/${editing.id}`, payload);
      } else {
        await api.post('/api/products', payload);
      }
      await fetchAll();
      setSaving(false);
      setShowModal(false);
    } catch (err: any) {
      setError(err.message);
      setSaving(false);
    }
  };

  const toggleStatus = async (p: Product) => {
    await api.patch(`/api/products/${p.id}`, {
      status: p.status === 'active' ? 'inactive' : 'active',
    });
    await fetchAll();
  };

  const handleDelete = async (id: string) => {
    showConfirm({
      title: 'Delete product?',
      message: 'This permanently removes the product and its variants. Sales history is preserved.',
      intent: 'destructive',
      confirmLabel: 'Delete',
      onConfirm: async () => {
        await api.delete(`/api/products/${id}`);
        await fetchAll();
      },
    });
  };

  const filtered = products.filter(p => {
    const matchSearch = p.name.toLowerCase().includes(search.toLowerCase());
    const matchCat = filterCategory ? p.category_id === filterCategory : true;
    return matchSearch && matchCat;
  });

  const currency = business?.currency ?? 'KES';

  // Vertical gating: recipes are restaurant/café only; variants are hidden for
  // petrol; fuel fields show only for petrol stations.
  const bizType = business?.type ?? '';
  const isFood = bizType === 'restaurant' || bizType === 'cafe';
  const isPetrol = bizType === 'petrol_station';

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">{term('products')}<span className="text-[10px] font-medium text-blue-400 bg-blue-500/10 border border-blue-500/20 rounded-full px-2 py-0.5 ml-2 align-middle">All branches</span></h1>
          <p className="text-gray-400 text-sm mt-0.5">{products.length} product{products.length !== 1 ? 's' : ''}</p>
        </div>
        <button onClick={openNew} className="bg-green-500 hover:bg-green-400 text-gray-950 font-semibold px-4 py-2 rounded-lg text-sm transition-colors">
          + New product
        </button>
      </div>

      {/* Filters */}
      <div className="flex gap-3 mb-6">
        <input
          type="text"
          placeholder={`Search ${lower('products')}…`}
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="bg-gray-900 border border-gray-800 rounded-lg px-4 py-2 text-white placeholder-gray-600 text-sm focus:outline-none focus:border-green-500 transition-colors w-64"
        />
        <select
          value={filterCategory}
          onChange={e => setFilterCategory(e.target.value)}
          className="bg-gray-900 border border-gray-800 rounded-lg px-4 py-2 text-white text-sm focus:outline-none focus:border-green-500 transition-colors"
        >
          <option value="">All categories</option>
          {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>

      {loading ? (
        <ProductTableSkeleton />
      ) : filtered.length === 0 ? (
        <div className="text-center py-20 text-gray-500">
          <p className="text-lg">No products found</p>
          <p className="text-sm mt-1">{products.length === 0 ? 'Create your first product' : 'Try a different search'}</p>
        </div>
      ) : (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-gray-800 text-left">
                <th className="px-4 py-3 text-xs text-gray-500 font-medium uppercase tracking-wider">Product</th>
                <th className="px-4 py-3 text-xs text-gray-500 font-medium uppercase tracking-wider">Category</th>
                <th className="px-4 py-3 text-xs text-gray-500 font-medium uppercase tracking-wider">Price</th>
                <th className="px-4 py-3 text-xs text-gray-500 font-medium uppercase tracking-wider">Status</th>
                <th className="px-4 py-3 text-xs text-gray-500 font-medium uppercase tracking-wider"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {filtered.map(p => (
                <tr key={p.id} className="hover:bg-gray-800/50 transition-colors">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      {p.image_url ? (
                        <img src={p.image_url} alt={p.name} className="w-9 h-9 rounded-lg object-cover flex-shrink-0" />
                      ) : (
                        <div className="w-9 h-9 rounded-lg bg-gray-800 flex items-center justify-center text-gray-500 flex-shrink-0 text-xs">IMG</div>
                      )}
                      <div>
                        <div className="flex items-center gap-2">
                          <p className="text-white text-sm font-medium">{p.name}</p>
                          {p.has_variants && (
                            <span className="text-xs bg-blue-500/10 text-blue-400 border border-blue-500/20 px-1.5 py-0.5 rounded">Variants</span>
                          )}
                          {p.has_modifiers && (
                            <span className="text-xs bg-purple-500/10 text-purple-400 border border-purple-500/20 px-1.5 py-0.5 rounded">Modifiers</span>
                          )}
                        </div>
                        {p.description && <p className="text-gray-500 text-xs truncate max-w-xs">{p.description}</p>}
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    {p.categories ? (
                      <span className="text-xs text-gray-300">{p.categories.name}</span>
                    ) : (
                      <span className="text-xs text-gray-600">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm text-white">{currency} {Number(p.base_price).toLocaleString()}</td>
                  <td className="px-4 py-3">
                    <span className={`text-xs px-2 py-1 rounded-full ${p.status === 'active' ? 'bg-green-500/10 text-green-400' : 'bg-gray-700 text-gray-400'}`}>
                      {p.status}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2 justify-end">
                      {!isPetrol && (
                        <button
                          onClick={() => setDrawerProduct(p)}
                          className="text-xs text-blue-400 hover:text-blue-300 px-2 py-1 rounded hover:bg-gray-700 transition-colors"
                        >
                          Variants
                        </button>
                      )}
                      {isFood && (
                        <button
                          onClick={() => setRecipeProduct(p)}
                          className={`text-xs px-2 py-1 rounded hover:bg-gray-700 transition-colors ${
                            productRecipes.has(p.id) ? 'text-green-400 hover:text-green-300' : 'text-gray-400 hover:text-white'
                          }`}
                        >
                          {productRecipes.has(p.id) ? '🧂 Recipe' : 'Recipe'}
                        </button>
                      )}
                      <button onClick={() => toggleStatus(p)} className="text-xs text-gray-400 hover:text-white px-2 py-1 rounded hover:bg-gray-700 transition-colors">
                        {p.status === 'active' ? 'Disable' : 'Enable'}
                      </button>
                      <button onClick={() => openEdit(p)} className="text-xs text-gray-400 hover:text-white px-2 py-1 rounded hover:bg-gray-700 transition-colors">
                        Edit
                      </button>
                      <button onClick={() => handleDelete(p.id)} className="text-xs text-red-400 hover:text-red-300 px-2 py-1 rounded hover:bg-gray-700 transition-colors">
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Variants Drawer */}
      {drawerProduct && (
        <VariantsDrawer
          product={drawerProduct}
          onClose={() => setDrawerProduct(null)}
          onUpdated={fetchAll}
        />
      )}

      {recipeProduct && (
        <RecipeDrawer
          product={recipeProduct}
          onClose={() => { setRecipeProduct(null); fetchAll(); }}
        />
      )}

      {/* Product Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 px-4">
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6 w-full max-w-md space-y-4 max-h-[90vh] overflow-y-auto">
            <h2 className="text-white font-semibold text-lg">{editing ? `Edit ${lower('product')}` : `New ${lower('product')}`}</h2>

            {/* Image upload */}
            <div>
              <label className="block text-sm text-gray-400 mb-1.5">Image</label>
              <div
                onClick={() => fileRef.current?.click()}
                className="w-full h-32 bg-gray-800 border border-gray-700 border-dashed rounded-lg flex items-center justify-center cursor-pointer hover:border-green-500 transition-colors overflow-hidden"
              >
                {imagePreview ? (
                  <img src={imagePreview} alt="preview" className="w-full h-full object-cover rounded-lg" />
                ) : (
                  <div className="text-center">
                    <p className="text-gray-500 text-sm">Click to upload</p>
                    <p className="text-gray-600 text-xs mt-0.5">PNG, JPG up to 5MB</p>
                  </div>
                )}
              </div>
              <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleFileChange} />
            </div>

            <div>
              <label className="block text-sm text-gray-400 mb-1.5">Name</label>
              <input
                type="text"
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder={isPetrol ? 'e.g. Super Petrol' : isFood ? 'e.g. Chicken Burger' : 'e.g. Product name'}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-white placeholder-gray-600 focus:outline-none focus:border-green-500 transition-colors"
              />
            </div>

            <div>
              <label className="block text-sm text-gray-400 mb-1.5">Description <span className="text-gray-600">(optional)</span></label>
              <textarea
                value={form.description}
                onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                placeholder="Short description…"
                rows={2}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-white placeholder-gray-600 focus:outline-none focus:border-green-500 transition-colors resize-none"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm text-gray-400 mb-1.5">
                  {form.is_fuel ? `Price per ${form.fuel_unit || 'L'} (${currency})` : `Price (${currency})`}
                </label>
                <input
                  type="number"
                  value={form.base_price}
                  onChange={e => setForm(f => ({ ...f, base_price: e.target.value }))}
                  placeholder="0"
                  min="0"
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-white placeholder-gray-600 focus:outline-none focus:border-green-500 transition-colors"
                />
              </div>
              <div>
                <label className="block text-sm text-gray-400 mb-1.5">Category</label>
                <select
                  value={form.category_id}
                  onChange={e => setForm(f => ({ ...f, category_id: e.target.value }))}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-white focus:outline-none focus:border-green-500 transition-colors"
                >
                  <option value="">None</option>
                  {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
            </div>

            {/* KRA eTIMS tax classification */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm text-gray-400 mb-1.5">KRA Tax Type</label>
                <select
                  value={form.tax_type}
                  onChange={e => setForm(f => ({ ...f, tax_type: e.target.value }))}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-white focus:outline-none focus:border-green-500 transition-colors"
                >
                  <option value="A">A — Exempt</option>
                  <option value="B">B — 16% (Standard)</option>
                  <option value="C">C — Zero-rated</option>
                  <option value="D">D — Non-VAT</option>
                  <option value="E">E — 8%</option>
                </select>
              </div>
              <div>
                <label className="block text-sm text-gray-400 mb-1.5">KRA Item Class Code</label>
                <input
                  type="text"
                  value={form.kra_item_class_code}
                  onChange={e => setForm(f => ({ ...f, kra_item_class_code: e.target.value }))}
                  placeholder="e.g. 50161509"
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-white placeholder-gray-600 focus:outline-none focus:border-green-500 transition-colors"
                />
              </div>
            </div>

            <div className="flex items-center gap-3">
              <button
                onClick={() => setForm(f => ({ ...f, track_stock: !f.track_stock }))}
                className={`w-10 h-5 rounded-full transition-colors relative ${form.track_stock ? 'bg-green-500' : 'bg-gray-700'}`}
              >
                <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full transition-all ${form.track_stock ? 'left-5' : 'left-0.5'}`} />
              </button>
              <label className="text-sm text-gray-400">Track stock for this product</label>
            </div>

            {/* Fuel product — petrol stations only. Marks the product as a fuel
                grade sold by volume; its price above is the price per litre, and
                the desktop pump grid reads it for fuel sales. */}
            {isPetrol && (
              <div className="border border-gray-800 rounded-lg p-3 space-y-3">
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => setForm(f => ({ ...f, is_fuel: !f.is_fuel, sold_by: !f.is_fuel ? 'volume' : 'each' }))}
                    className={`w-10 h-5 rounded-full transition-colors relative ${form.is_fuel ? 'bg-green-500' : 'bg-gray-700'}`}
                  >
                    <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full transition-all ${form.is_fuel ? 'left-5' : 'left-0.5'}`} />
                  </button>
                  <label className="text-sm text-gray-300">⛽ This is a fuel grade (sold by volume)</label>
                </div>
                {form.is_fuel && (
                  <div>
                    <label className="block text-sm text-gray-400 mb-1.5">Sold per</label>
                    <select
                      value={form.fuel_unit}
                      onChange={e => setForm(f => ({ ...f, fuel_unit: e.target.value }))}
                      className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-white focus:outline-none focus:border-green-500 transition-colors"
                    >
                      <option value="L">Litre (L)</option>
                      <option value="kg">Kilogram (kg)</option>
                    </select>
                    <p className="text-gray-600 text-xs mt-1.5">
                      Set the price above to the price per {form.fuel_unit || 'L'}. Map this grade to a pump in Settings → Petrol Setup.
                    </p>
                  </div>
                )}
              </div>
            )}

            {error && <p className="text-red-400 text-sm">{error}</p>}

            <div className="flex gap-3 pt-1">
              <button onClick={() => setShowModal(false)} className="flex-1 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg py-2.5 text-sm transition-colors">
                Cancel
              </button>
              <button onClick={handleSave} disabled={saving || !form.name.trim()} className="flex-1 bg-green-500 hover:bg-green-400 disabled:opacity-40 text-gray-950 font-semibold rounded-lg py-2.5 text-sm transition-colors">
                {uploading ? 'Uploading…' : saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
      <ConfirmModal state={confirmState} onClose={closeConfirm} />
    </div>
  );
}
