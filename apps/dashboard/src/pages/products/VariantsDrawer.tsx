import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import type { Product, VariantGroup, VariantOption, ModifierGroup } from '../../types';
import ConfirmModal, { useConfirm } from '../../components/ConfirmModal';

interface Props {
  product: Product;
  onClose: () => void;
  onUpdated: () => void; // triggers product list refresh so has_variants/has_modifiers badges update
}

// Minimal ingredient shape for the picker (no shared type in types/index.ts).
interface IngredientLite { id: string; name: string; unit?: string }

// ── Stock impact (Track C) ──────────────────────────────────
// A variant option can carry ONE stock consequence:
//   • scale       — deduct N× this product's own stock/recipe (Large fries)
//   • product     — deduct a different product's stock (bottled drink SKU)
//   • ingredient  — deduct an ingredient (Large chips → extra frozen fries)
type StockMode = 'none' | 'scale' | 'product' | 'ingredient';

interface StockForm {
  stock_factor: string;         // string for inputs; '1' = no scaling
  linked_product_id: string;    // '' = none
  linked_ingredient_id: string; // '' = none
  deduct_qty: string;           // qty of the linked target per unit sold
}

const EMPTY_STOCK: StockForm = {
  stock_factor: '1',
  linked_product_id: '',
  linked_ingredient_id: '',
  deduct_qty: '1',
};

function stockModeOf(s: StockForm): StockMode {
  if (s.linked_product_id) return 'product';
  if (s.linked_ingredient_id) return 'ingredient';
  if (s.stock_factor && Number(s.stock_factor) !== 1) return 'scale';
  return 'none';
}

// Convert a saved VariantOption back into a StockForm (for editing).
function stockFormFromOption(o: VariantOption): StockForm {
  return {
    stock_factor: o.stock_factor != null ? String(o.stock_factor) : '1',
    linked_product_id: o.linked_product_id ?? '',
    linked_ingredient_id: o.linked_ingredient_id ?? '',
    deduct_qty: o.deduct_qty != null ? String(o.deduct_qty) : '1',
  };
}

// Convert a StockForm into the API payload fields.
function stockPayload(s: StockForm) {
  return {
    stock_factor: parseFloat(s.stock_factor) || 1,
    linked_product_id: s.linked_product_id || null,
    linked_ingredient_id: s.linked_ingredient_id || null,
    deduct_qty: parseFloat(s.deduct_qty) || 1,
  };
}

const inputCls =
  'w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-green-500 transition-colors';

// Shared editor for an option's stock rule. Used in Add-group and Edit-option.
function StockImpactEditor({
  value,
  onChange,
  products,
  ingredients,
}: {
  value: StockForm;
  onChange: (s: StockForm) => void;
  products: Product[];
  ingredients: IngredientLite[];
}) {
  const mode = stockModeOf(value);

  const setMode = (m: StockMode) => {
    if (m === 'none') onChange({ ...EMPTY_STOCK, deduct_qty: value.deduct_qty });
    else if (m === 'scale')
      onChange({
        ...EMPTY_STOCK,
        stock_factor: Number(value.stock_factor) !== 1 && value.stock_factor ? value.stock_factor : '1.5',
      });
    else if (m === 'product')
      onChange({ ...EMPTY_STOCK, linked_product_id: products[0]?.id ?? '', deduct_qty: value.deduct_qty || '1' });
    else if (m === 'ingredient')
      onChange({ ...EMPTY_STOCK, linked_ingredient_id: ingredients[0]?.id ?? '', deduct_qty: value.deduct_qty || '1' });
  };

  return (
    <div className="mt-2 pl-3 border-l-2 border-gray-800 space-y-2">
      <select
        value={mode}
        onChange={e => setMode(e.target.value as StockMode)}
        className={inputCls}
      >
        <option value="none">No stock effect (price only)</option>
        <option value="scale">Scale this item's stock (×)</option>
        <option value="product">Deduct a stock product</option>
        <option value="ingredient">Deduct an ingredient</option>
      </select>

      {mode === 'scale' && (
        <div>
          <label className="block text-xs text-gray-500 mb-1">Multiplier</label>
          <input
            type="number" step="0.1" min="0.1"
            value={value.stock_factor}
            onChange={e => onChange({ ...value, stock_factor: e.target.value })}
            className={inputCls}
          />
          <p className="text-gray-600 text-xs mt-1">e.g. 1.5 = deducts 1.5× the normal amount (Large).</p>
        </div>
      )}

      {mode === 'product' && (
        <div className="space-y-2">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Product to deduct</label>
            {products.length === 0 ? (
              <p className="text-amber-400/80 text-xs">No products found.</p>
            ) : (
              <select
                value={value.linked_product_id}
                onChange={e => onChange({ ...value, linked_product_id: e.target.value })}
                className={inputCls}
              >
                {products.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            )}
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Quantity per sale</label>
            <input
              type="number" step="0.01" min="0.01"
              value={value.deduct_qty}
              onChange={e => onChange({ ...value, deduct_qty: e.target.value })}
              className={inputCls}
            />
          </div>
          <p className="text-gray-600 text-xs">e.g. link a "Soda 1.25L" option to your bottled 1.25L product.</p>
        </div>
      )}

      {mode === 'ingredient' && (
        <div className="space-y-2">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Ingredient to deduct</label>
            {ingredients.length === 0 ? (
              <p className="text-amber-400/80 text-xs">No ingredients found.</p>
            ) : (
              <select
                value={value.linked_ingredient_id}
                onChange={e => onChange({ ...value, linked_ingredient_id: e.target.value })}
                className={inputCls}
              >
                {ingredients.map(i => (
                  <option key={i.id} value={i.id}>{i.name}{i.unit ? ` (${i.unit})` : ''}</option>
                ))}
              </select>
            )}
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Quantity per sale</label>
            <input
              type="number" step="0.01" min="0.01"
              value={value.deduct_qty}
              onChange={e => onChange({ ...value, deduct_qty: e.target.value })}
              className={inputCls}
            />
          </div>
          <p className="text-gray-600 text-xs">e.g. "Large chips" deducts extra frozen fries (kg).</p>
        </div>
      )}
    </div>
  );
}

// One-line summary badge of an option's stock rule, shown on saved rows.
function stockBadge(
  o: VariantOption,
  productName: (id: string) => string,
  ingredientName: (id: string) => string,
): string | null {
  if (o.linked_product_id) return `→ ${productName(o.linked_product_id)} ×${o.deduct_qty ?? 1}`;
  if (o.linked_ingredient_id) return `→ ${ingredientName(o.linked_ingredient_id)} ×${o.deduct_qty ?? 1}`;
  if (o.stock_factor != null && Number(o.stock_factor) !== 1) return `×${o.stock_factor} stock`;
  return null;
}

// ── Small reusable components ───────────────────────────────

function SectionHeader({ title, onAdd }: { title: string; onAdd: () => void }) {
  return (
    <div className="flex items-center justify-between mb-3">
      <h3 className="text-white font-medium text-sm">{title}</h3>
      <button
        onClick={onAdd}
        className="text-xs bg-gray-800 hover:bg-gray-700 text-green-400 border border-gray-700 px-3 py-1.5 rounded-lg transition-colors"
      >
        + Add group
      </button>
    </div>
  );
}

// ── Add Group Modal (shared for variant + modifier) ─────────

interface OptionForm extends StockForm {
  name: string;
  price: string;
}

interface AddGroupState {
  name: string;
  required: boolean;       // variants only
  min_select: number;      // modifiers only
  max_select: string;      // modifiers only — string so input can be empty
  options: OptionForm[];
}

const EMPTY_OPTION: OptionForm = { name: '', price: '0', ...EMPTY_STOCK };

const EMPTY_GROUP: AddGroupState = {
  name: '',
  required: false,
  min_select: 0,
  max_select: '',
  options: [{ ...EMPTY_OPTION }],
};

function AddGroupModal({
  mode,
  currency,
  products,
  ingredients,
  onSave,
  onClose,
}: {
  mode: 'variant' | 'modifier';
  currency: string;
  products: Product[];
  ingredients: IngredientLite[];
  onSave: (state: AddGroupState) => Promise<void>;
  onClose: () => void;
}) {
  const [form, setForm] = useState<AddGroupState>(EMPTY_GROUP);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const addOption = () =>
    setForm(f => ({ ...f, options: [...f.options, { ...EMPTY_OPTION }] }));

  const removeOption = (i: number) =>
    setForm(f => ({ ...f, options: f.options.filter((_, idx) => idx !== i) }));

  const updateOption = (i: number, patch: Partial<OptionForm>) =>
    setForm(f => ({
      ...f,
      options: f.options.map((o, idx) => idx === i ? { ...o, ...patch } : o),
    }));

  const handleSave = async () => {
    if (!form.name.trim()) { setError('Group name is required'); return; }
    if (form.options.some(o => !o.name.trim())) { setError('All options need a name'); return; }
    setSaving(true);
    try {
      await onSave(form);
    } catch (err: any) {
      setError(err.message);
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-[60] px-4">
      <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6 w-full max-w-md space-y-4 max-h-[85vh] overflow-y-auto">
        <h3 className="text-white font-semibold">
          New {mode === 'variant' ? 'variant' : 'modifier'} group
        </h3>

        <div>
          <label className="block text-xs text-gray-400 mb-1">Group name</label>
          <input
            value={form.name}
            onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
            placeholder={mode === 'variant' ? 'e.g. Size' : 'e.g. Extras'}
            className={inputCls}
          />
        </div>

        {mode === 'variant' && (
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={form.required}
              onChange={e => setForm(f => ({ ...f, required: e.target.checked }))}
              className="accent-green-500"
            />
            <span className="text-sm text-gray-400">Required selection</span>
          </label>
        )}

        {mode === 'modifier' && (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-gray-400 mb-1">Min select</label>
              <input
                type="number" min={0}
                value={form.min_select}
                onChange={e => setForm(f => ({ ...f, min_select: Number(e.target.value) }))}
                className={inputCls}
              />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Max select <span className="text-gray-600">(blank = unlimited)</span></label>
              <input
                type="number" min={0}
                value={form.max_select}
                onChange={e => setForm(f => ({ ...f, max_select: e.target.value }))}
                placeholder="∞"
                className={inputCls}
              />
            </div>
          </div>
        )}

        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-xs text-gray-400">Options</label>
            <button onClick={addOption} className="text-xs text-green-400 hover:text-green-300 transition-colors">+ Add option</button>
          </div>
          <div className="space-y-3">
            {form.options.map((opt, i) => (
              <div key={i} className="border border-gray-800 rounded-xl p-3">
                <div className="flex gap-2 items-center">
                  <input
                    value={opt.name}
                    onChange={e => updateOption(i, { name: e.target.value })}
                    placeholder={mode === 'variant' ? 'e.g. Large' : 'e.g. Extra Cheese'}
                    className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-green-500 transition-colors"
                  />
                  <div className="relative w-28">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 text-xs">{currency}</span>
                    <input
                      type="number"
                      value={opt.price}
                      onChange={e => updateOption(i, { price: e.target.value })}
                      placeholder="0"
                      className="w-full bg-gray-800 border border-gray-700 rounded-lg pl-10 pr-3 py-2 text-white text-sm focus:outline-none focus:border-green-500 transition-colors"
                    />
                  </div>
                  {form.options.length > 1 && (
                    <button onClick={() => removeOption(i)} className="text-gray-600 hover:text-red-400 transition-colors">✕</button>
                  )}
                </div>

                {/* Stock rule — variants only */}
                {mode === 'variant' && (
                  <StockImpactEditor
                    value={opt}
                    onChange={s => updateOption(i, s)}
                    products={products}
                    ingredients={ingredients}
                  />
                )}
              </div>
            ))}
          </div>
        </div>

        {error && <p className="text-red-400 text-sm">{error}</p>}

        <div className="flex gap-3 pt-1">
          <button onClick={onClose} className="flex-1 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg py-2.5 text-sm transition-colors">
            Cancel
          </button>
          <button onClick={handleSave} disabled={saving} className="flex-1 bg-green-500 hover:bg-green-400 disabled:opacity-40 text-gray-950 font-semibold rounded-lg py-2.5 text-sm transition-colors">
            {saving ? 'Saving…' : 'Save group'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Edit Option Modal (variants only — set name, price, stock rule) ──
function EditOptionModal({
  option,
  currency,
  products,
  ingredients,
  onSave,
  onClose,
}: {
  option: VariantOption;
  currency: string;
  products: Product[];
  ingredients: IngredientLite[];
  onSave: (patch: { name: string; price_adjustment: number } & ReturnType<typeof stockPayload>) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(option.name);
  const [price, setPrice] = useState(String(option.price_adjustment ?? 0));
  const [stock, setStock] = useState<StockForm>(stockFormFromOption(option));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleSave = async () => {
    if (!name.trim()) { setError('Name is required'); return; }
    setSaving(true);
    try {
      await onSave({ name: name.trim(), price_adjustment: parseFloat(price) || 0, ...stockPayload(stock) });
    } catch (err: any) {
      setError(err.message);
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-[60] px-4">
      <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6 w-full max-w-md space-y-4 max-h-[85vh] overflow-y-auto">
        <h3 className="text-white font-semibold">Edit option</h3>

        <div className="flex gap-2 items-start">
          <div className="flex-1">
            <label className="block text-xs text-gray-400 mb-1">Name</label>
            <input value={name} onChange={e => setName(e.target.value)} className={inputCls} />
          </div>
          <div className="w-28">
            <label className="block text-xs text-gray-400 mb-1">Price +</label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 text-xs">{currency}</span>
              <input
                type="number"
                value={price}
                onChange={e => setPrice(e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg pl-10 pr-3 py-2 text-white text-sm focus:outline-none focus:border-green-500 transition-colors"
              />
            </div>
          </div>
        </div>

        <div>
          <label className="block text-xs text-gray-400 mb-1">Stock rule</label>
          <StockImpactEditor value={stock} onChange={setStock} products={products} ingredients={ingredients} />
        </div>

        {error && <p className="text-red-400 text-sm">{error}</p>}

        <div className="flex gap-3 pt-1">
          <button onClick={onClose} className="flex-1 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg py-2.5 text-sm transition-colors">
            Cancel
          </button>
          <button onClick={handleSave} disabled={saving} className="flex-1 bg-green-500 hover:bg-green-400 disabled:opacity-40 text-gray-950 font-semibold rounded-lg py-2.5 text-sm transition-colors">
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main drawer ─────────────────────────────────────────────

export default function VariantsDrawer({ product, onClose, onUpdated }: Props) {
  const [variantGroups, setVariantGroups] = useState<VariantGroup[]>([]);
  const [modifierGroups, setModifierGroups] = useState<ModifierGroup[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [ingredients, setIngredients] = useState<IngredientLite[]>([]);
  const [loading, setLoading] = useState(true);
  const [addingMode, setAddingMode] = useState<'variant' | 'modifier' | null>(null);
  const [editingOption, setEditingOption] = useState<VariantOption | null>(null);
  const [confirmState, showConfirm, closeConfirm] = useConfirm();

  const currency = 'KES'; // TODO: pull from business context if needed

  const fetchAll = async () => {
    const [vg, mg] = await Promise.all([
      api.get<VariantGroup[]>(`/api/variants/groups?product_id=${product.id}`),
      api.get<ModifierGroup[]>(`/api/modifiers/groups?product_id=${product.id}`),
    ]);
    setVariantGroups(vg);
    setModifierGroups(mg);
  };

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        await fetchAll();
        // Pickers for linked-stock options. Non-fatal if either fails.
        const [prods, ings] = await Promise.all([
          api.get<Product[]>('/api/products').catch(() => [] as Product[]),
          api.get<IngredientLite[]>('/api/stock/ingredients').catch(() => [] as IngredientLite[]),
        ]);
        // Don't let a product link to itself.
        setProducts(prods.filter(p => p.id !== product.id));
        setIngredients(ings);
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product.id]);

  const productName = (id: string) => products.find(p => p.id === id)?.name ?? 'product';
  const ingredientName = (id: string) => ingredients.find(i => i.id === id)?.name ?? 'ingredient';

  const handleAddVariantGroup = async (form: AddGroupState) => {
    await api.post('/api/variants/groups', {
      product_id: product.id,
      name: form.name,
      required: form.required,
      options: form.options.map(o => ({
        name: o.name,
        price_adjustment: parseFloat(o.price) || 0,
        ...stockPayload(o),
      })),
    });
    await fetchAll();
    onUpdated();
    setAddingMode(null);
  };

  const handleAddModifierGroup = async (form: AddGroupState) => {
    await api.post('/api/modifiers/groups', {
      product_id: product.id,
      name: form.name,
      min_select: form.min_select,
      max_select: form.max_select !== '' ? parseInt(form.max_select) : null,
      options: form.options.map(o => ({
        name: o.name,
        price: parseFloat(o.price) || 0,
      })),
    });
    await fetchAll();
    onUpdated();
    setAddingMode(null);
  };

  const saveOptionEdit = async (
    patch: { name: string; price_adjustment: number } & ReturnType<typeof stockPayload>,
  ) => {
    if (!editingOption) return;
    await api.patch(`/api/variants/options/${editingOption.id}`, patch);
    await fetchAll();
    setEditingOption(null);
  };

  const deleteVariantGroup = async (id: string) => {
    showConfirm({
      title: 'Delete variant group?',
      message: 'All options in this group will be deleted. Products using these variants may be affected.',
      intent: 'destructive',
      confirmLabel: 'Delete group',
      onConfirm: async () => {
        await api.delete(`/api/variants/groups/${id}`);
        await fetchAll();
        onUpdated();
      },
    });
  };

  const deleteModifierGroup = async (id: string) => {
    showConfirm({
      title: 'Delete modifier group?',
      message: 'All options in this group will be deleted.',
      intent: 'destructive',
      confirmLabel: 'Delete group',
      onConfirm: async () => {
        await api.delete(`/api/modifiers/groups/${id}`);
        await fetchAll();
        onUpdated();
      },
    });
  };

  const deleteVariantOption = async (id: string) => {
    await api.delete(`/api/variants/options/${id}`);
    await fetchAll();
  };

  const deleteModifierOption = async (id: string) => {
    await api.delete(`/api/modifiers/options/${id}`);
    await fetchAll();
  };

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/50 z-40" onClick={onClose} />

      {/* Drawer */}
      <div className="fixed right-0 top-0 h-full w-full max-w-md bg-gray-950 border-l border-gray-800 z-50 flex flex-col">
        {/* Header */}
        <div className="px-6 py-5 border-b border-gray-800 flex items-start justify-between">
          <div>
            <h2 className="text-white font-semibold text-lg">Variants & Modifiers</h2>
            <p className="text-gray-500 text-sm mt-0.5 truncate max-w-xs">{product.name}</p>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-white transition-colors mt-1">✕</button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-8">
          {loading ? (
            <div className="flex justify-center py-16">
              <div className="w-6 h-6 border-2 border-green-400 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : (
            <>
              {/* ── Variants ── */}
              <div>
                <SectionHeader title="Variant groups" onAdd={() => setAddingMode('variant')} />
                <p className="text-gray-600 text-xs mb-4">
                  Variants change the base price (e.g. Size: Small +0, Large +50) and can move stock. Customer picks one option per group.
                </p>

                {variantGroups.length === 0 ? (
                  <p className="text-gray-600 text-sm text-center py-6 border border-dashed border-gray-800 rounded-xl">
                    No variant groups yet
                  </p>
                ) : (
                  <div className="space-y-4">
                    {variantGroups.map(group => (
                      <div key={group.id} className="border border-gray-800 rounded-xl p-4">
                        <div className="flex items-center justify-between mb-3">
                          <div>
                            <span className="text-white text-sm font-medium">{group.name}</span>
                            {group.required && (
                              <span className="ml-2 text-xs text-amber-400 bg-amber-400/10 px-1.5 py-0.5 rounded">Required</span>
                            )}
                          </div>
                          <button
                            onClick={() => deleteVariantGroup(group.id)}
                            className="text-xs text-gray-600 hover:text-red-400 transition-colors"
                          >
                            Delete group
                          </button>
                        </div>
                        <div className="space-y-1.5">
                          {group.variant_options.map(opt => {
                            const badge = stockBadge(opt, productName, ingredientName);
                            const priceLabel = Number(opt.price_adjustment) === 0
                              ? 'Included'
                              : `+${currency} ${Number(opt.price_adjustment).toLocaleString()}`;
                            return (
                              <div key={opt.id} className="flex items-center justify-between py-1.5 px-3 bg-gray-800/60 rounded-lg text-sm">
                                <span className="text-gray-300">{opt.name}</span>
                                <div className="flex items-center gap-3">
                                  {badge && (
                                    <span className="text-green-400/80 text-xs bg-green-400/10 px-1.5 py-0.5 rounded">{badge}</span>
                                  )}
                                  <span className="text-gray-500 text-xs">{priceLabel}</span>
                                  <button
                                    onClick={() => setEditingOption(opt)}
                                    className="text-gray-500 hover:text-green-400 transition-colors text-xs"
                                  >
                                    Edit
                                  </button>
                                  <button
                                    onClick={() => deleteVariantOption(opt.id)}
                                    className="text-gray-600 hover:text-red-400 transition-colors text-xs"
                                  >
                                    ✕
                                  </button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* ── Modifiers ── */}
              <div>
                <SectionHeader title="Modifier groups" onAdd={() => setAddingMode('modifier')} />
                <p className="text-gray-600 text-xs mb-4">
                  Modifiers are add-ons with their own price (e.g. Extras: Extra Cheese +30). Customer can pick multiple.
                </p>

                {modifierGroups.length === 0 ? (
                  <p className="text-gray-600 text-sm text-center py-6 border border-dashed border-gray-800 rounded-xl">
                    No modifier groups yet
                  </p>
                ) : (
                  <div className="space-y-4">
                    {modifierGroups.map(group => (
                      <div key={group.id} className="border border-gray-800 rounded-xl p-4">
                        <div className="flex items-center justify-between mb-3">
                          <div>
                            <span className="text-white text-sm font-medium">{group.name}</span>
                            <span className="ml-2 text-xs text-gray-500">
                              {group.min_select > 0 ? `min ${group.min_select}` : 'optional'}
                              {group.max_select ? `, max ${group.max_select}` : ''}
                            </span>
                          </div>
                          <button
                            onClick={() => deleteModifierGroup(group.id)}
                            className="text-xs text-gray-600 hover:text-red-400 transition-colors"
                          >
                            Delete group
                          </button>
                        </div>
                        <div className="space-y-1.5">
                          {group.modifier_options.map(opt => (
                            <div key={opt.id} className="flex items-center justify-between py-1.5 px-3 bg-gray-800/60 rounded-lg text-sm">
                              <span className="text-gray-300">{opt.name}</span>
                              <div className="flex items-center gap-3">
                                <span className="text-gray-500 text-xs">{opt.price === 0 ? 'Free' : `+${currency} ${opt.price.toLocaleString()}`}</span>
                                <button onClick={() => deleteModifierOption(opt.id)} className="text-gray-600 hover:text-red-400 transition-colors text-xs">✕</button>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Add Group Modal — rendered outside drawer so it stacks above it */}
      {addingMode && (
        <AddGroupModal
          mode={addingMode}
          currency={currency}
          products={products}
          ingredients={ingredients}
          onSave={addingMode === 'variant' ? handleAddVariantGroup : handleAddModifierGroup}
          onClose={() => setAddingMode(null)}
        />
      )}

      {/* Edit Option Modal */}
      {editingOption && (
        <EditOptionModal
          option={editingOption}
          currency={currency}
          products={products}
          ingredients={ingredients}
          onSave={saveOptionEdit}
          onClose={() => setEditingOption(null)}
        />
      )}

      <ConfirmModal state={confirmState} onClose={closeConfirm} />
    </>
  );
}
