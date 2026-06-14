import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import type { Product, VariantGroup, ModifierGroup } from '../../types';
import ConfirmModal, { useConfirm } from '../../components/ConfirmModal';

interface Props {
  product: Product;
  onClose: () => void;
  onUpdated: () => void; // triggers product list refresh so has_variants/has_modifiers badges update
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

function OptionRow({
  name,
  price,
  label,
  onDelete,
}: {
  name: string;
  price: string;
  label: string;
  onDelete: () => void;
}) {
  return (
    <div className="flex items-center justify-between py-1.5 px-3 bg-gray-800/60 rounded-lg text-sm">
      <span className="text-gray-300">{name}</span>
      <div className="flex items-center gap-3">
        <span className="text-gray-500 text-xs">{label} {price}</span>
        <button onClick={onDelete} className="text-gray-600 hover:text-red-400 transition-colors text-xs">✕</button>
      </div>
    </div>
  );
}

// ── Add Group Modal (shared for variant + modifier) ─────────

interface AddGroupState {
  name: string;
  required: boolean;       // variants only
  min_select: number;      // modifiers only
  max_select: string;      // modifiers only — string so input can be empty
  options: { name: string; price: string }[];
}

const EMPTY_GROUP: AddGroupState = {
  name: '',
  required: false,
  min_select: 0,
  max_select: '',
  options: [{ name: '', price: '0' }],
};

function AddGroupModal({
  mode,
  currency,
  onSave,
  onClose,
}: {
  mode: 'variant' | 'modifier';
  currency: string;
  onSave: (state: AddGroupState) => Promise<void>;
  onClose: () => void;
}) {
  const [confirmState, showConfirm, closeConfirm] = useConfirm();
  const [form, setForm] = useState<AddGroupState>(EMPTY_GROUP);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const addOption = () =>
    setForm(f => ({ ...f, options: [...f.options, { name: '', price: '0' }] }));

  const removeOption = (i: number) =>
    setForm(f => ({ ...f, options: f.options.filter((_, idx) => idx !== i) }));

  const updateOption = (i: number, field: 'name' | 'price', val: string) =>
    setForm(f => ({
      ...f,
      options: f.options.map((o, idx) => idx === i ? { ...o, [field]: val } : o),
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
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-green-500 transition-colors"
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
                type="number"
                min={0}
                value={form.min_select}
                onChange={e => setForm(f => ({ ...f, min_select: Number(e.target.value) }))}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-green-500 transition-colors"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Max select <span className="text-gray-600">(blank = unlimited)</span></label>
              <input
                type="number"
                min={0}
                value={form.max_select}
                onChange={e => setForm(f => ({ ...f, max_select: e.target.value }))}
                placeholder="∞"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-green-500 transition-colors"
              />
            </div>
          </div>
        )}

        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-xs text-gray-400">Options</label>
            <button onClick={addOption} className="text-xs text-green-400 hover:text-green-300 transition-colors">+ Add option</button>
          </div>
          <div className="space-y-2">
            {form.options.map((opt, i) => (
              <div key={i} className="flex gap-2 items-center">
                <input
                  value={opt.name}
                  onChange={e => updateOption(i, 'name', e.target.value)}
                  placeholder={mode === 'variant' ? 'e.g. Large' : 'e.g. Extra Cheese'}
                  className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-green-500 transition-colors"
                />
                <div className="relative w-28">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 text-xs">{currency}</span>
                  <input
                    type="number"
                    value={opt.price}
                    onChange={e => updateOption(i, 'price', e.target.value)}
                    placeholder="0"
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg pl-10 pr-3 py-2 text-white text-sm focus:outline-none focus:border-green-500 transition-colors"
                  />
                </div>
                {form.options.length > 1 && (
                  <button onClick={() => removeOption(i)} className="text-gray-600 hover:text-red-400 transition-colors">✕</button>
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

// ── Main Drawer ─────────────────────────────────────────────

export default function VariantsDrawer({ product, onClose, onUpdated }: Props) {
  const [variantGroups, setVariantGroups] = useState<VariantGroup[]>([]);
  const [modifierGroups, setModifierGroups] = useState<ModifierGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [addingMode, setAddingMode] = useState<'variant' | 'modifier' | null>(null);

  const currency = 'KES'; // TODO: pull from business context if needed

  const fetchAll = async () => {
    const [vGroups, mGroups] = await Promise.all([
      api.get<VariantGroup[]>(`/api/variants/groups?product_id=${product.id}`),
      api.get<ModifierGroup[]>(`/api/modifiers/groups?product_id=${product.id}`),
    ]);
    setVariantGroups(vGroups ?? []);
    setModifierGroups(mGroups ?? []);
    setLoading(false);
  };

  useEffect(() => { fetchAll(); }, []);

  const handleAddVariantGroup = async (form: AddGroupState) => {
    await api.post('/api/variants/groups', {
      product_id: product.id,
      name: form.name,
      required: form.required,
      options: form.options.map(o => ({
        name: o.name,
        price_adjustment: parseFloat(o.price) || 0,
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
                  Variants change the base price (e.g. Size: Small +0, Large +50). Customer must pick one option per required group.
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
                          {group.variant_options.map(opt => (
                            <OptionRow
                              key={opt.id}
                              name={opt.name}
                              price={Number(opt.price_adjustment) === 0 ? 'Included' : `+${currency} ${Number(opt.price_adjustment).toLocaleString()}`}
                              label=""
                              onDelete={() => deleteVariantOption(opt.id)}
                            />
                          ))}
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
                            <OptionRow
                              key={opt.id}
                              name={opt.name}
                              price={opt.price === 0 ? 'Free' : `+${currency} ${opt.price.toLocaleString()}`}
                              label=""
                              onDelete={() => deleteModifierOption(opt.id)}
                            />
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
          onSave={addingMode === 'variant' ? handleAddVariantGroup : handleAddModifierGroup}
          onClose={() => setAddingMode(null)}
        />
      )}
    </>
      <ConfirmModal state={confirmState} onClose={closeConfirm} />
  );
}
