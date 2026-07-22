/**
 * RecipeDrawer
 *
 * Slides in from the right when a manager clicks "Recipe" on a product.
 * Lets them define which ingredients + quantities make up one serving of that product.
 *
 * e.g. Ugali Nyama:
 *   - Maize Flour  200 g
 *   - Beef         150 g
 *   - Cooking Oil   20 ml
 *   - Kales        100 g
 */

import { useState, useEffect, useCallback } from 'react';
import { api } from '../../lib/api';
import type { Product } from '../../types';
import ConfirmModal, { useConfirm } from '../../components/ConfirmModal';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Ingredient {
  id: string;
  name: string;
  unit: string;
  current_stock: number;
  category: string | null;
  unit_cost: number | null;
  is_packaging?: boolean;
}

interface RecipeLine {
  id?: string;
  ingredient_id: string;
  ingredient_name: string;
  ingredient_unit: string;
  ingredient_unit_cost: number | null;
  quantity_per_serving: string; // string for controlled input
}

interface SavedRecipeLine {
  id: string;
  ingredient_id: string;
  quantity_per_serving: number;
  unit: string | null;
  ingredients: { id: string; name: string; unit: string; current_stock: number; unit_cost: number | null };
}

// ─── Component ────────────────────────────────────────────────────────────────

interface Props {
  product: Product;
  onClose: () => void;
}

export default function RecipeDrawer({ product, onClose }: Props) {
  const [confirmState, showConfirm, closeConfirm] = useConfirm();
  const [ingredients, setIngredients] = useState<Ingredient[]>([]);
  const [lines, setLines]             = useState<RecipeLine[]>([]);
  const [loading, setLoading]         = useState(true);
  const [saving, setSaving]           = useState(false);
  const [saved, setSaved]             = useState(false);
  const [error, setError]             = useState('');

  // Ingredient search per line
  const [searches, setSearches] = useState<string[]>([]);

  // ── Takeaway packaging (Track C) ───────────────────────────
  const [packagingItems, setPackagingItems] = useState<Ingredient[]>([]);
  const [pkgLines, setPkgLines]   = useState<{ ingredient_id: string; quantity: string }[]>([]);
  const [pkgSaving, setPkgSaving] = useState(false);
  const [pkgSaved, setPkgSaved]   = useState(false);
  const [pkgError, setPkgError]   = useState('');

  // ── Load existing recipe + ingredient list ─────────────────────────────────
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [ingData, recipeData, pkgItems, pkgData] = await Promise.all([
        api.get<Ingredient[]>('/api/stock/ingredients?status=active&fields=unit_cost'),
        api.get<SavedRecipeLine[]>(`/api/recipes/${product.id}`),
        api.get<Ingredient[]>('/api/stock/ingredients?status=active&packaging=true'),
        api.get<{ ingredient_id: string; quantity: number }[]>(`/api/recipes/${product.id}/packaging`),
      ]);

      setIngredients(ingData ?? []);
      setPackagingItems(pkgItems ?? []);
      setPkgLines((pkgData ?? []).map(p => ({ ingredient_id: p.ingredient_id, quantity: String(p.quantity) })));

      if (recipeData && recipeData.length > 0) {
        const loaded: RecipeLine[] = recipeData.map(r => ({
          id:                  r.id,
          ingredient_id:       r.ingredient_id,
          ingredient_name:     r.ingredients.name,
          ingredient_unit:     r.unit ?? r.ingredients.unit,
          ingredient_unit_cost: r.ingredients.unit_cost ?? null,
          quantity_per_serving: String(r.quantity_per_serving),
        }));
        setLines(loaded);
        setSearches(loaded.map(() => ''));
      } else {
        // Start with one blank line
        setLines([{ ingredient_id: '', ingredient_name: '', ingredient_unit: '', ingredient_unit_cost: null, quantity_per_serving: '' }]);
        setSearches(['']);
      }
    } catch { /* silent */ }
    finally { setLoading(false); }
  }, [product.id]);

  useEffect(() => { load(); }, [load]);

  // ── Line management ────────────────────────────────────────────────────────
  const addLine = () => {
    setLines(p => [...p, { ingredient_id: '', ingredient_name: '', ingredient_unit: '', quantity_per_serving: '' }]);
    setSearches(p => [...p, '']);
  };

  const removeLine = (idx: number) => {
    setLines(p => p.filter((_, i) => i !== idx));
    setSearches(p => p.filter((_, i) => i !== idx));
  };

  const selectIngredient = (idx: number, ing: Ingredient) => {
    setLines(p => p.map((line, i) =>
      i === idx
        ? { ...line, ingredient_id: ing.id, ingredient_name: ing.name, ingredient_unit: ing.unit, ingredient_unit_cost: ing.unit_cost ?? null }
        : line
    ));
    setSearches(p => p.map((s, i) => i === idx ? '' : s));
  };

  const clearIngredient = (idx: number) => {
    setLines(p => p.map((line, i) =>
      i === idx
        ? { ...line, ingredient_id: '', ingredient_name: '', ingredient_unit: '' }
        : line
    ));
  };

  const setQty = (idx: number, val: string) => {
    setLines(p => p.map((line, i) => i === idx ? { ...line, quantity_per_serving: val } : line));
  };

  // ── Save ───────────────────────────────────────────────────────────────────
  const save = async () => {
    const valid = lines.filter(l => l.ingredient_id && l.quantity_per_serving && Number(l.quantity_per_serving) > 0);
    if (valid.length === 0) {
      setError('Add at least one ingredient with a quantity, or clear all lines to remove the recipe.');
      return;
    }

    setSaving(true); setError('');
    try {
      await api.post(`/api/recipes/${product.id}`, {
        lines: valid.map(l => ({
          ingredient_id:       l.ingredient_id,
          quantity_per_serving: Number(l.quantity_per_serving),
          unit:                l.ingredient_unit || undefined,
        })),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      await load(); // reload to get server-assigned IDs
    } catch (e: any) {
      setError(e.message ?? 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const clearRecipe = async () => {
    showConfirm({
      title: `Remove recipe for "${product.name}"?`,
      message: 'The ingredient list will be cleared. This cannot be undone.',
      intent: 'destructive',
      confirmLabel: 'Remove recipe',
      onConfirm: async () => {
        await api.delete(`/api/recipes/${product.id}`);
        setLines([{ ingredient_id: '', ingredient_name: '', ingredient_unit: '', quantity_per_serving: '' }]);
        setSearches(['']);
      },
    });
  };

  // ── Takeaway packaging management ──────────────────────────
  const pkgName = (id: string) => packagingItems.find(p => p.id === id)?.name ?? '';
  const pkgUnit = (id: string) => packagingItems.find(p => p.id === id)?.unit ?? '';

  const addPkgLine = () => setPkgLines(p => [...p, { ingredient_id: '', quantity: '1' }]);
  const removePkgLine = (idx: number) => setPkgLines(p => p.filter((_, i) => i !== idx));
  const setPkgLine = (idx: number, patch: Partial<{ ingredient_id: string; quantity: string }>) =>
    setPkgLines(p => p.map((l, i) => i === idx ? { ...l, ...patch } : l));

  const savePackaging = async () => {
    const valid = pkgLines.filter(l => l.ingredient_id && Number(l.quantity) > 0);
    // Guard against picking the same packaging item twice.
    const ids = valid.map(l => l.ingredient_id);
    if (new Set(ids).size !== ids.length) { setPkgError('Each packaging item can only be added once.'); return; }
    setPkgSaving(true); setPkgError('');
    try {
      await api.post(`/api/recipes/${product.id}/packaging`, {
        lines: valid.map(l => ({ ingredient_id: l.ingredient_id, quantity: Number(l.quantity) })),
      });
      setPkgSaved(true);
      setTimeout(() => setPkgSaved(false), 2000);
    } catch (e: any) {
      setPkgError(e.message ?? 'Save failed');
    } finally {
      setPkgSaving(false);
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  const hasRecipe = lines.some(l => l.ingredient_id);
  const usedIngredientIds = new Set(lines.map(l => l.ingredient_id).filter(Boolean));

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/60 z-40"
        onClick={onClose}
      />

      {/* Drawer */}
      <div className="fixed right-0 top-0 h-full w-full max-w-lg bg-gray-900 border-l border-gray-800 z-50 flex flex-col shadow-2xl">

        {/* Header */}
        <div className="px-6 py-5 border-b border-gray-800 flex items-start justify-between gap-4 flex-shrink-0">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-lg">🧂</span>
              <h2 className="text-white font-bold text-base">Recipe</h2>
            </div>
            <p className="text-gray-400 text-sm mt-0.5">{product.name}</p>
            <p className="text-gray-600 text-xs mt-1">
              Define the raw ingredients used per serving. When this product is sold,
              stock is automatically deducted.
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-white transition-colors text-xl flex-shrink-0 mt-0.5"
          >✕</button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
          {loading ? (
            <div className="py-16 text-center text-gray-500 text-sm">Loading…</div>
          ) : (
            <>
              {/* Column headers */}
              <div className="grid grid-cols-12 gap-3 px-1">
                <p className="col-span-7 text-gray-600 text-xs font-medium uppercase tracking-wider">Ingredient</p>
                <p className="col-span-4 text-gray-600 text-xs font-medium uppercase tracking-wider">Qty per serving</p>
                <div className="col-span-1" />
              </div>

              {/* Lines */}
              {lines.map((line, idx) => {
                const search  = searches[idx] ?? '';
                const options = ingredients.filter(ing => {
                  if (ing.is_packaging) return false; // packaging is handled in its own section
                  if (usedIngredientIds.has(ing.id) && ing.id !== line.ingredient_id) return false;
                  if (!search) return true;
                  return ing.name.toLowerCase().includes(search.toLowerCase()) ||
                    (ing.category ?? '').toLowerCase().includes(search.toLowerCase());
                });

                return (
                  <div key={idx} className="grid grid-cols-12 gap-3 items-start">

                    {/* Ingredient picker */}
                    <div className="col-span-7 relative">
                      {line.ingredient_id ? (
                        <div className="flex items-center gap-2 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5">
                          <div className="flex-1 min-w-0">
                            <p className="text-white text-sm font-medium truncate">{line.ingredient_name}</p>
                            <p className="text-gray-500 text-xs">{line.ingredient_unit}</p>
                          </div>
                          <button
                            onClick={() => clearIngredient(idx)}
                            className="text-gray-600 hover:text-white text-xs flex-shrink-0 transition-colors"
                          >✕</button>
                        </div>
                      ) : (
                        <div className="relative">
                          <input
                            type="text"
                            placeholder="Search ingredient…"
                            value={search}
                            onChange={e => setSearches(p => p.map((s, i) => i === idx ? e.target.value : s))}
                            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-green-500"
                          />
                          {search && (
                            <div className="absolute top-full left-0 right-0 mt-1 bg-gray-800 border border-gray-700 rounded-lg shadow-xl z-20 max-h-52 overflow-y-auto">
                              {options.length > 0 ? options.slice(0, 20).map(ing => (
                                <button
                                  key={ing.id}
                                  onClick={() => selectIngredient(idx, ing)}
                                  className="w-full text-left px-3 py-2.5 hover:bg-gray-700 transition-colors border-b border-gray-700/50 last:border-0"
                                >
                                  <p className="text-white text-sm">{ing.name}</p>
                                  <p className="text-gray-500 text-xs">
                                    {ing.unit}
                                    {ing.category ? ` · ${ing.category}` : ''}
                                    {' · '}
                                    <span className={ing.current_stock <= 0 ? 'text-red-400' : 'text-gray-500'}>
                                      {ing.current_stock} in stock
                                    </span>
                                  </p>
                                </button>
                              )) : (
                                <div className="px-3 py-3">
                                  <p className="text-gray-500 text-xs">No ingredients match. Add them in Stock → Ingredients first.</p>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Quantity */}
                    <div className="col-span-4">
                      <div className="relative">
                        <input
                          type="number"
                          min="0.001"
                          step="0.001"
                          placeholder="0"
                          value={line.quantity_per_serving}
                          onChange={e => setQty(idx, e.target.value)}
                          className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-green-500 pr-10"
                        />
                        {line.ingredient_unit && (
                          <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-500 text-xs pointer-events-none">
                            {line.ingredient_unit}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Remove */}
                    <div className="col-span-1 flex items-center justify-center pt-2">
                      {lines.length > 1 && (
                        <button
                          onClick={() => removeLine(idx)}
                          className="text-gray-600 hover:text-red-400 transition-colors text-base leading-none"
                        >✕</button>
                      )}
                    </div>
                  </div>
                );
              })}

              {/* Add line */}
              <button
                onClick={addLine}
                className="flex items-center gap-2 text-green-400 hover:text-green-300 text-sm font-medium transition-colors mt-2"
              >
                <span className="text-lg leading-none">+</span> Add ingredient
              </button>

              {/* Recipe summary */}
              {hasRecipe && (
                <div className="mt-4 bg-gray-800/50 rounded-xl border border-gray-700 p-4">
                  <p className="text-gray-400 text-xs font-semibold uppercase tracking-wider mb-3">Per serving deduction</p>
                  <div className="space-y-1.5">
                    {lines.filter(l => l.ingredient_id && l.quantity_per_serving).map((l, i) => (
                      <div key={i} className="flex items-center justify-between">
                        <p className="text-gray-300 text-sm">{l.ingredient_name}</p>
                        <p className="text-white text-sm font-medium tabular-nums">
                          {l.quantity_per_serving} {l.ingredient_unit}
                        </p>
                      </div>
                    ))}
                  </div>
                  {/* Cost per serving */}
                  {lines.filter(l => l.ingredient_id && l.quantity_per_serving && l.ingredient_unit_cost).length > 0 && (() => {
                    const costPerServing = lines
                      .filter(l => l.ingredient_id && l.quantity_per_serving && l.ingredient_unit_cost)
                      .reduce((sum, l) => sum + Number(l.quantity_per_serving) * (l.ingredient_unit_cost ?? 0), 0);
                    const sellingPrice = (product as any).base_price ?? 0;
                    const margin = sellingPrice > 0 ? ((sellingPrice - costPerServing) / sellingPrice) * 100 : null;
                    return (
                      <div className="mt-3 pt-3 border-t border-gray-700">
                        <div className="flex items-center justify-between">
                          <span className="text-gray-400 text-xs">Cost per serving</span>
                          <span className="text-white text-sm font-bold tabular-nums">
                            KES {costPerServing.toFixed(2)}
                          </span>
                        </div>
                        {sellingPrice > 0 && (
                          <div className="flex items-center justify-between mt-1">
                            <span className="text-gray-400 text-xs">Selling price</span>
                            <span className="text-gray-300 text-sm tabular-nums">KES {Number(sellingPrice).toFixed(2)}</span>
                          </div>
                        )}
                        {margin !== null && (
                          <div className="flex items-center justify-between mt-1">
                            <span className="text-gray-400 text-xs">Gross margin</span>
                            <span className={`text-sm font-bold tabular-nums ${margin >= 60 ? 'text-green-400' : margin >= 30 ? 'text-amber-400' : 'text-red-400'}`}>
                              {margin.toFixed(1)}%
                            </span>
                          </div>
                        )}
                      </div>
                    );
                  })()}
                  <p className="text-gray-600 text-xs mt-3">
                    These quantities will be deducted from ingredient stock every time <span className="text-gray-400">{product.name}</span> is sold.
                  </p>
                </div>
              )}

              {/* ── Takeaway packaging ── */}
              <div className="mt-6 pt-5 border-t border-gray-800">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-lg">📦</span>
                  <h3 className="text-white font-semibold text-sm">Takeaway packaging</h3>
                </div>
                <p className="text-gray-600 text-xs mb-3">
                  Deducted from stock when <span className="text-gray-400">{product.name}</span> is sold as <span className="text-gray-400">takeaway</span> (never dine-in). Flag items as packaging in Stock → Ingredients first.
                </p>

                {packagingItems.length === 0 ? (
                  <p className="text-gray-600 text-xs text-center py-4 border border-dashed border-gray-800 rounded-lg">
                    No packaging items yet. Add one in Stock → Ingredients and tick "This is a packaging item".
                  </p>
                ) : (
                  <>
                    <div className="space-y-2">
                      {pkgLines.map((line, idx) => (
                        <div key={idx} className="grid grid-cols-12 gap-2 items-center">
                          <div className="col-span-7">
                            <select
                              value={line.ingredient_id}
                              onChange={e => setPkgLine(idx, { ingredient_id: e.target.value })}
                              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-green-500"
                            >
                              <option value="">— Select packaging —</option>
                              {packagingItems.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                            </select>
                          </div>
                          <div className="col-span-4 relative">
                            <input
                              type="number" min="0.001" step="0.001" placeholder="1"
                              value={line.quantity}
                              onChange={e => setPkgLine(idx, { quantity: e.target.value })}
                              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-green-500 pr-10"
                            />
                            {line.ingredient_id && (
                              <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-500 text-xs pointer-events-none">{pkgUnit(line.ingredient_id)}</span>
                            )}
                          </div>
                          <div className="col-span-1 flex items-center justify-center">
                            <button onClick={() => removePkgLine(idx)} className="text-gray-600 hover:text-red-400 transition-colors text-base leading-none">✕</button>
                          </div>
                        </div>
                      ))}
                    </div>

                    <button onClick={addPkgLine} className="flex items-center gap-2 text-green-400 hover:text-green-300 text-sm font-medium transition-colors mt-2">
                      <span className="text-lg leading-none">+</span> Add packaging
                    </button>

                    {pkgError && (
                      <p className="text-red-400 text-xs bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 mt-2">{pkgError}</p>
                    )}

                    <div className="flex justify-end mt-3">
                      <button
                        onClick={savePackaging}
                        disabled={pkgSaving}
                        className={`px-4 py-2 text-sm font-semibold rounded-lg transition-all ${pkgSaved ? 'bg-green-600 text-white' : 'bg-gray-800 hover:bg-gray-700 text-green-400 border border-gray-700'}`}
                      >
                        {pkgSaving ? 'Saving…' : pkgSaved ? '✓ Saved' : 'Save packaging'}
                      </button>
                    </div>
                  </>
                )}
              </div>

              {error && (
                <p className="text-red-400 text-xs bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">{error}</p>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-800 flex items-center gap-3 flex-shrink-0">
          {hasRecipe && (
            <button
              onClick={clearRecipe}
              className="text-gray-600 hover:text-red-400 text-xs transition-colors mr-auto"
            >
              Clear recipe
            </button>
          )}
          <button
            onClick={onClose}
            className="px-4 py-2 text-gray-400 hover:text-white text-sm transition-colors"
          >
            Close
          </button>
          <button
            onClick={save}
            disabled={saving || loading}
            className={`px-5 py-2 text-sm font-semibold rounded-lg transition-all ${
              saved
                ? 'bg-green-600 text-white'
                : 'bg-green-500 hover:bg-green-400 disabled:opacity-50 text-black'
            }`}
          >
            {saving ? 'Saving…' : saved ? '✓ Saved' : 'Save Recipe'}
          </button>
        </div>
      </div>
      <ConfirmModal state={confirmState} onClose={closeConfirm} />
    </>
  );
}
