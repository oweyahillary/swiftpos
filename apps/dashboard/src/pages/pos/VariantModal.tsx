import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { computeUnitPrice, computeLineTotal } from '../../lib/cart';
import type { Product, VariantGroup, ModifierGroup, SelectedVariant, SelectedModifier } from '../../types';

interface Props {
  product: Product;
  currency: string;
  onConfirm: (
    selectedVariants: SelectedVariant[],
    selectedModifiers: SelectedModifier[],
    unitPrice: number,
    lineTotal: number,
  ) => void;
  onClose: () => void;
}

export default function VariantModal({ product, currency, onConfirm, onClose }: Props) {
  const [variantGroups, setVariantGroups] = useState<VariantGroup[]>([]);
  const [modifierGroups, setModifierGroups] = useState<ModifierGroup[]>([]);
  const [loading, setLoading] = useState(true);

  // variant: one selection per group (radio)
  const [selectedVariants, setSelectedVariants] = useState<Record<string, SelectedVariant>>({});
  // modifier: multiple selections per group (checkbox)
  const [selectedModifiers, setSelectedModifiers] = useState<Record<string, SelectedModifier>>({});

  const [error, setError] = useState('');

  useEffect(() => {
    const fetches: Promise<any>[] = [];

    if (product.has_variants) {
      fetches.push(api.get<VariantGroup[]>(`/api/variants/groups?product_id=${product.id}`));
    } else {
      fetches.push(Promise.resolve([]));
    }

    if (product.has_modifiers) {
      fetches.push(api.get<ModifierGroup[]>(`/api/modifiers/groups?product_id=${product.id}`));
    } else {
      fetches.push(Promise.resolve([]));
    }

    Promise.all(fetches).then(([vGroups, mGroups]) => {
      setVariantGroups(vGroups ?? []);
      setModifierGroups(mGroups ?? []);
      setLoading(false);
    });
  }, [product.id]);

  const selectVariant = (group: VariantGroup, optionId: string) => {
    const option = group.variant_options.find(o => o.id === optionId);
    if (!option) return;
    setSelectedVariants(prev => ({
      ...prev,
      [group.id]: {
        groupId: group.id,
        groupName: group.name,
        optionId: option.id,
        optionName: option.name,
        priceAdjustment: option.price_adjustment,
      },
    }));
  };

  const toggleModifier = (group: ModifierGroup, optionId: string) => {
    const option = group.modifier_options.find(o => o.id === optionId);
    if (!option) return;
    const key = `${group.id}__${optionId}`;
    setSelectedModifiers(prev => {
      if (prev[key]) {
        const next = { ...prev };
        delete next[key];
        return next;
      }
      return {
        ...prev,
        [key]: {
          groupId: group.id,
          groupName: group.name,
          optionId: option.id,
          optionName: option.name,
          price: option.price,
        },
      };
    });
  };

  const handleConfirm = () => {
    setError('');

    // Validate required variant groups
    for (const group of variantGroups) {
      if (group.required && !selectedVariants[group.id]) {
        setError(`Please select a ${group.name}`);
        return;
      }
    }

    // Validate modifier min_select
    for (const group of modifierGroups) {
      if (group.min_select > 0) {
        const selected = Object.values(selectedModifiers).filter(m => m.groupId === group.id).length;
        if (selected < group.min_select) {
          setError(`Please select at least ${group.min_select} option${group.min_select > 1 ? 's' : ''} for ${group.name}`);
          return;
        }
      }
    }

    const variantList = Object.values(selectedVariants);
    const modifierList = Object.values(selectedModifiers);
    const unitPrice = computeUnitPrice(product, variantList);
    const lineTotal = computeLineTotal(unitPrice, 1, modifierList);

    onConfirm(variantList, modifierList, unitPrice, lineTotal);
  };

  // Live price preview
  const previewVariants = Object.values(selectedVariants);
  const previewModifiers = Object.values(selectedModifiers);
  const previewUnit = computeUnitPrice(product, previewVariants);
  const previewTotal = computeLineTotal(previewUnit, 1, previewModifiers);

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 px-4">
      <div className="bg-gray-900 border border-gray-800 rounded-2xl w-full max-w-sm flex flex-col max-h-[85vh]">

        {/* Header */}
        <div className="px-6 pt-5 pb-4 border-b border-gray-800 flex items-start justify-between">
          <div>
            <h2 className="text-white font-semibold text-base">{product.name}</h2>
            <p className="text-gray-500 text-xs mt-0.5">Customise your order</p>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-white transition-colors mt-0.5">✕</button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-6">
          {loading ? (
            <div className="flex justify-center py-10">
              <div className="w-5 h-5 border-2 border-green-400 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : (
            <>
              {/* Variant groups — radio */}
              {variantGroups.map(group => (
                <div key={group.id}>
                  <div className="flex items-center gap-2 mb-2">
                    <p className="text-white text-sm font-medium">{group.name}</p>
                    {group.required
                      ? <span className="text-xs text-amber-400 bg-amber-400/10 px-1.5 py-0.5 rounded">Required</span>
                      : <span className="text-xs text-gray-600">Optional</span>
                    }
                  </div>
                  <div className="space-y-2">
                    {group.variant_options.map(opt => {
                      const isSelected = selectedVariants[group.id]?.optionId === opt.id;
                      return (
                        <button
                          key={opt.id}
                          onClick={() => selectVariant(group, opt.id)}
                          className={`w-full flex items-center justify-between px-4 py-2.5 rounded-xl border text-sm transition-colors ${
                            isSelected
                              ? 'border-green-500 bg-green-500/10 text-white'
                              : 'border-gray-700 bg-gray-800 text-gray-300 hover:border-gray-600'
                          }`}
                        >
                          <div className="flex items-center gap-2">
                            <span className={`w-4 h-4 rounded-full border-2 flex items-center justify-center flex-shrink-0 ${isSelected ? 'border-green-500' : 'border-gray-600'}`}>
                              {isSelected && <span className="w-2 h-2 rounded-full bg-green-500 block" />}
                            </span>
                            {opt.name}
                          </div>
                          <span className={Number(opt.price_adjustment) === 0 ? 'text-gray-500 text-xs' : 'text-green-400 text-xs'}>
                            {Number(opt.price_adjustment) === 0 ? 'Included' : `+${currency} ${Number(opt.price_adjustment).toLocaleString()}`}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}

              {/* Modifier groups — checkbox */}
              {modifierGroups.map(group => (
                <div key={group.id}>
                  <div className="flex items-center gap-2 mb-2">
                    <p className="text-white text-sm font-medium">{group.name}</p>
                    <span className="text-xs text-gray-600">
                      {group.min_select > 0 ? `min ${group.min_select}` : 'Optional'}
                      {group.max_select ? `, max ${group.max_select}` : ''}
                    </span>
                  </div>
                  <div className="space-y-2">
                    {group.modifier_options.map(opt => {
                      const key = `${group.id}__${opt.id}`;
                      const isSelected = !!selectedModifiers[key];
                      const atMax = group.max_select !== null &&
                        Object.values(selectedModifiers).filter(m => m.groupId === group.id).length >= group.max_select &&
                        !isSelected;

                      return (
                        <button
                          key={opt.id}
                          onClick={() => !atMax && toggleModifier(group, opt.id)}
                          disabled={atMax}
                          className={`w-full flex items-center justify-between px-4 py-2.5 rounded-xl border text-sm transition-colors ${
                            isSelected
                              ? 'border-green-500 bg-green-500/10 text-white'
                              : atMax
                              ? 'border-gray-800 bg-gray-800/40 text-gray-600 cursor-not-allowed'
                              : 'border-gray-700 bg-gray-800 text-gray-300 hover:border-gray-600'
                          }`}
                        >
                          <div className="flex items-center gap-2">
                            <span className={`w-4 h-4 rounded border-2 flex items-center justify-center flex-shrink-0 ${isSelected ? 'border-green-500 bg-green-500' : 'border-gray-600'}`}>
                              {isSelected && <span className="text-gray-950 text-xs leading-none">✓</span>}
                            </span>
                            {opt.name}
                          </div>
                          <span className={opt.price === 0 ? 'text-gray-500 text-xs' : 'text-green-400 text-xs'}>
                            {opt.price === 0 ? 'Free' : `+${currency} ${opt.price.toLocaleString()}`}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </>
          )}
        </div>

        {/* Footer — live price + confirm */}
        <div className="px-6 py-4 border-t border-gray-800 space-y-3">
          {error && <p className="text-red-400 text-sm">{error}</p>}

          <div className="flex items-center justify-between text-sm">
            <span className="text-gray-400">Item total</span>
            <span className="text-white font-semibold">
              {currency} {previewTotal.toLocaleString()}
            </span>
          </div>

          <button
            onClick={handleConfirm}
            disabled={loading}
            className="w-full bg-green-500 hover:bg-green-400 disabled:opacity-40 text-gray-950 font-bold rounded-xl py-3 transition-colors"
          >
            Add to order
          </button>
        </div>
      </div>
    </div>
  );
}
