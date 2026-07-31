/**
 * MenuWorkbench — ONE menu screen.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * The manager side had four tabs doing different halves of one job: Menu created
 * products, Prices edited prices, Combos defined contents, Import loaded a CSV.
 * To change a combo's price and what it contains you visited three of them, and
 * nothing on any screen told you the other two existed.
 *
 * Worse, each was organised around a DATABASE TABLE rather than around a menu
 * item. In the schema a combo is simply a product that has components — so
 * "Combos" was never a different kind of thing, only a different query.
 *
 * ── THE SHAPE ───────────────────────────────────────────────────────────────
 * A list on the left, one item's full detail on the right. Filters across the
 * top: search, category, and type. Combos are a FILTER, not a tab — the owner's
 * decision and the one the data already supported.
 *
 * Categories are the filters, and they are whatever the site has created. There
 * is no predefined set, because a menu's categories are the menu's own language.
 *
 * ── WHAT IS DELIBERATELY INLINE ─────────────────────────────────────────────
 * Price is editable straight in the list. It is the single most frequent edit by
 * a wide margin, and making it a three-click journey into a detail panel is what
 * produced a separate Prices tab in the first place.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { posApi } from '../lib/posApi';
import ChoicesEditor from '../components/ChoicesEditor';

interface Category { id: string; name: string }
interface Product {
  id: string;
  name: string;
  base_price: number;
  category_id: string | null;
  description?: string | null;
  is_combo?: boolean;
  status?: string;
}

type TypeFilter = 'all' | 'combo' | 'single' | 'review';

interface Props {
  currency: string;
  /** Opens the CSV/Excel import, kept as its own flow but reachable from here. */
  onOpenImport?: () => void;
}

export default function MenuWorkbench({ currency, onOpenImport }: Props) {
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [comboItems, setComboItems] = useState<Record<string, any[]>>({});
  // Product ids with at least one group migration 45 could not classify. Loaded
  // once for the whole menu so the filter can find them without opening each item
  // — the point being that an unresolved group nobody looks at stays unresolved.
  const [needsReview, setNeedsReview] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [search, setSearch] = useState('');
  const [catFilter, setCatFilter] = useState<string>('all');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');

  const [selected, setSelected] = useState<string | null>(null);
  const [priceDrafts, setPriceDrafts] = useState<Record<string, string>>({});
  const [savingId, setSavingId] = useState<string | null>(null);
  const [flash, setFlash] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    // Independent, not Promise.all: one failing call must not blank the screen
    // into "no menu items", which reads as an empty menu rather than a failure.
    const [p, c, combos] = await Promise.all([
      posApi.manage.listProducts().catch(e => { setError(e?.message ?? 'Could not load products'); return null; }),
      posApi.manage.listCategories().catch(() => null),
      posApi.manage.listCombos().catch(() => null),
    ]);
    if (Array.isArray(p)) setProducts(p);
    if (Array.isArray(c)) setCategories(c);
    // One pass over every product's groups. Only run on load, and failures are
    // silent: a review badge is useful, not load-bearing.
    if (Array.isArray(p)) {
      void Promise.all(p.map(async (prod: Product) => {
        try {
          const gs = await posApi.manage.listVariantGroups(prod.id);
          return Array.isArray(gs) && gs.some((g: any) => g.kind === 'review') ? prod.id : null;
        } catch { return null; }
      })).then(ids => setNeedsReview(new Set(ids.filter(Boolean) as string[])));
    }
    if (Array.isArray(combos)) {
      const map: Record<string, any[]> = {};
      for (const cb of combos) map[cb.id] = cb.items ?? cb.combo_items ?? [];
      setComboItems(map);
    }
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const catName = useCallback(
    (id: string | null) => categories.find(c => c.id === id)?.name ?? 'Uncategorised',
    [categories],
  );

  const isCombo = useCallback(
    (p: Product) => (comboItems[p.id]?.length ?? 0) > 0 || p.is_combo === true,
    [comboItems],
  );

  /** Rows matching everything EXCEPT the type filter — the basis for the counts. */
  const scoped = useMemo(() => {
    const q = search.trim().toLowerCase();
    return products.filter(p => {
      if (q && !p.name.toLowerCase().includes(q)) return false;
      if (catFilter !== 'all' && (p.category_id ?? '') !== catFilter) return false;
      return true;
    });
  }, [products, search, catFilter]);

  const typeCounts = useMemo(() => ([
    { key: 'all'    as TypeFilter, label: 'All',     count: scoped.length },
    { key: 'single' as TypeFilter, label: 'Items',   count: scoped.filter(p => !isCombo(p)).length },
    { key: 'combo'  as TypeFilter, label: 'Combos',  count: scoped.filter(p => isCombo(p)).length },
    { key: 'review' as TypeFilter, label: 'Review',  count: scoped.filter(p => needsReview.has(p.id)).length },
  ]), [scoped, isCombo, needsReview]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return products.filter(p => {
      if (q && !p.name.toLowerCase().includes(q)) return false;
      if (catFilter !== 'all' && (p.category_id ?? '') !== catFilter) return false;
      if (typeFilter === 'combo' && !isCombo(p)) return false;
      if (typeFilter === 'single' && isCombo(p)) return false;
      if (typeFilter === 'review' && !needsReview.has(p.id)) return false;
      return true;
    });
  }, [products, search, catFilter, typeFilter, isCombo, needsReview]);

  const savePrice = async (p: Product) => {
    const raw = priceDrafts[p.id];
    if (raw === undefined) return;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) {
      setError(`"${raw}" is not a valid price`);
      return;
    }
    if (value === Number(p.base_price)) {          // nothing changed, do not call
      setPriceDrafts(d => { const { [p.id]: _, ...rest } = d; return rest; });
      return;
    }
    setSavingId(p.id);
    try {
      await posApi.manage.updateProduct(p.id, { base_price: value });
      setProducts(prev => prev.map(x => x.id === p.id ? { ...x, base_price: value } : x));
      setPriceDrafts(d => { const { [p.id]: _, ...rest } = d; return rest; });
      setFlash(`${p.name} → ${currency} ${value.toFixed(2)}`);
      setTimeout(() => setFlash(''), 2500);
    } catch (e: any) {
      setError(e?.message ?? 'Could not save the price');
    } finally { setSavingId(null); }
  };

  // A filter that becomes empty because of a SEARCH looks like the search found
  // nothing. Drop back to All so the reason is visible.
  useEffect(() => {
    if (typeFilter === 'all') return;
    const active = typeCounts.find(t => t.key === typeFilter);
    if (active && active.count === 0) setTypeFilter('all');
  }, [typeCounts, typeFilter]);

  const sel = products.find(p => p.id === selected) ?? null;
  const input = 'bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm';

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-bold text-white">Menu</h2>
          <p className="text-gray-400 text-sm">
            Every item in one place — prices, contents, choices and extras.
          </p>
        </div>
        <div className="flex gap-2">
          {onOpenImport && (
            <button onClick={onOpenImport}
              className="text-xs text-gray-300 hover:text-white border border-gray-700 rounded-lg px-3 py-1.5 transition-colors">
              Import / export
            </button>
          )}
          <button onClick={load}
            className="text-xs text-gray-400 hover:text-white border border-gray-700 rounded-lg px-3 py-1.5 transition-colors">
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3">
          <p className="text-sm text-red-300">{error}</p>
        </div>
      )}
      {flash && (
        <div className="bg-green-500/10 border border-green-500/30 rounded-lg px-3 py-2">
          <p className="text-sm text-green-300">Saved · {flash}</p>
        </div>
      )}

      {/* Filters. Categories come from the site's own list — there is no
          predefined set, because a menu's categories are its own language. */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search items…"
          className={`${input} flex-1 min-w-[180px]`}
        />
        <select value={catFilter} onChange={e => setCatFilter(e.target.value)} className={input}>
          <option value="all">All categories</option>
          {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <div className="flex rounded-lg overflow-hidden border border-gray-700">
          {/* Each button carries its own count.
              Without them three of the four look broken on a freshly imported
              menu: nothing is a combo yet, so "Items" returns the same 67 rows as
              "All" and the other two empty the list with no explanation. A filter
              that silently returns everything, or nothing, is indistinguishable
              from one that does not work — so the count goes ON the button, and a
              filter with nothing to show is disabled rather than left to
              disappoint. */}
          {typeCounts.map(({ key, label, count }) => (
            <button
              key={key}
              disabled={count === 0 && key !== 'all'}
              title={count === 0 && key !== 'all' ? `No ${label.toLowerCase()} in this menu` : undefined}
              onClick={() => setTypeFilter(key)}
              className={`px-3 py-2 text-xs transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                typeFilter === key ? 'bg-green-500/10 text-green-400'
                  : key === 'review' && count > 0 ? 'bg-gray-800 text-amber-400 hover:text-amber-300'
                  : 'bg-gray-800 text-gray-400 hover:text-white'
              }`}
            >
              {label} <span className="opacity-60">{count}</span>
            </button>
          ))}
        </div>
      </div>

      <p className="text-xs text-gray-500">
        {loading ? 'Loading…' : `${filtered.length} of ${products.length} items`}
      </p>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
        {/* ── List ─────────────────────────────────────────────────────────── */}
        <div className="lg:col-span-3 border border-gray-800 rounded-xl overflow-hidden">
          {filtered.length === 0 && !loading ? (
            <div className="text-center py-10 px-4">
              <p className="text-sm text-gray-400">Nothing matches those filters.</p>
              {/* Name the filter responsible. "Nothing matches" leaves the reader
                  to work out which of three controls did it. */}
              {typeFilter === 'combo' && (
                <p className="text-xs text-gray-500 mt-1">
                  No combos yet — a combo is an item with components, added under
                  "Comes with".
                </p>
              )}
              {typeFilter === 'review' && (
                <p className="text-xs text-gray-500 mt-1">
                  Nothing needs review. Every choice group is classified.
                </p>
              )}
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-gray-800/60">
                <tr>
                  <th className="px-3 py-2 text-left text-xs text-gray-400 font-medium">Item</th>
                  <th className="px-3 py-2 text-left text-xs text-gray-400 font-medium">Category</th>
                  <th className="px-3 py-2 text-right text-xs text-gray-400 font-medium">Price</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800">
                {filtered.map(p => {
                  const draft = priceDrafts[p.id];
                  const dirty = draft !== undefined && Number(draft) !== Number(p.base_price);
                  return (
                    <tr
                      key={p.id}
                      className={`${selected === p.id ? 'bg-green-500/5' : 'hover:bg-gray-800/40'} transition-colors`}
                    >
                      <td className="px-3 py-2 cursor-pointer" onClick={() => setSelected(p.id)}>
                        <span className="text-white">{p.name}</span>
                        {isCombo(p) && (
                          <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-300">
                            combo
                          </span>
                        )}
                        {needsReview.has(p.id) && (
                          <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300">
                            review
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-gray-400 cursor-pointer" onClick={() => setSelected(p.id)}>
                        {catName(p.category_id)}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {/* Inline, because price is the edit that happens most and
                            burying it behind a panel is what created a separate
                            Prices tab in the first place. */}
                        <input
                          type="number" min={0} step="0.01" inputMode="decimal"
                          value={draft ?? String(p.base_price ?? '')}
                          onChange={e => setPriceDrafts(d => ({ ...d, [p.id]: e.target.value }))}
                          onBlur={() => savePrice(p)}
                          onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                          disabled={savingId === p.id}
                          className={`w-24 text-right tabular-nums bg-gray-900 border rounded px-2 py-1 text-white
                            ${dirty ? 'border-amber-500' : 'border-gray-700'} disabled:opacity-50`}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* ── Detail ───────────────────────────────────────────────────────── */}
        <div className="lg:col-span-2 border border-gray-800 rounded-xl p-4">
          {!sel ? (
            <p className="text-sm text-gray-500 text-center py-10">
              Select an item to see what it comes with.
            </p>
          ) : (
            <ItemDetail
              product={sel}
              categories={categories}
              components={comboItems[sel.id] ?? []}
              currency={currency}
              catName={catName}
              onSaved={load}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * One item's full picture: what it is, what it comes with, and how it varies.
 *
 * Read-only for Includes/Choices/Extras in this first pass — the aim was to end
 * the four-tab hunt, and showing a combo's contents beside its price already does
 * that. Editing them here comes with the choices/upgrades rework, which needs the
 * data cleanup the owner's answers implied.
 */
function ItemDetail({
  product, categories, components, currency, catName, onSaved,
}: {
  product: Product;
  categories: Category[];
  components: any[];
  currency: string;
  catName: (id: string | null) => string;
  onSaved: () => void;
}) {
  const [name, setName] = useState(product.name);
  const [categoryId, setCategoryId] = useState(product.category_id ?? '');
  const [description, setDescription] = useState(product.description ?? '');
  const [modifiers, setModifiers] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    setName(product.name);
    setCategoryId(product.category_id ?? '');
    setDescription(product.description ?? '');
    setMsg('');
    posApi.manage.listModifierGroups(product.id).then(setModifiers).catch(() => setModifiers([]));
  }, [product.id, product.name, product.category_id, product.description]);

  const save = async () => {
    setBusy(true);
    setMsg('');
    try {
      await posApi.manage.updateProduct(product.id, {
        name: name.trim(),
        category_id: categoryId || null,
        description: description.trim() || null,
      });
      setMsg('Saved');
      onSaved();
    } catch (e: any) {
      setMsg(e?.message ?? 'Could not save');
    } finally { setBusy(false); }
  };

  const input = 'w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm';
  const label = 'block text-xs text-gray-400 mb-1';
  const section = 'text-xs font-semibold text-gray-300 uppercase tracking-wide';

  return (
    <div className="space-y-4">
      <div>
        <label className={label}>Name</label>
        <input value={name} onChange={e => setName(e.target.value)} className={input} />
      </div>

      <div>
        <label className={label}>Category</label>
        <select value={categoryId} onChange={e => setCategoryId(e.target.value)} className={input}>
          <option value="">Uncategorised</option>
          {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <p className="text-[11px] text-gray-500 mt-1">
          Category decides where this prints — see Printers → Stations.
        </p>
      </div>

      <div>
        <label className={label}>Description</label>
        <textarea rows={2} value={description} onChange={e => setDescription(e.target.value)} className={input} />
        <p className="text-[11px] text-gray-500 mt-1">
          Shown on kitchen and packing tickets, not on the customer receipt.
        </p>
      </div>

      <button
        onClick={save}
        disabled={busy}
        className="w-full bg-green-600 hover:bg-green-500 disabled:bg-gray-700 text-white
                   rounded-lg py-2 text-sm font-medium transition-colors"
      >
        {busy ? 'Saving…' : 'Save details'}
      </button>
      {msg && <p className="text-xs text-gray-400">{msg}</p>}

      <div className="border-t border-gray-800 pt-3 space-y-3">
        <div>
          <p className={section}>Comes with</p>
          {components.length === 0 ? (
            <p className="text-xs text-gray-500 mt-1">Nothing — this is a single item.</p>
          ) : (
            <ul className="mt-1 space-y-0.5">
              {components.map((c, i) => (
                <li key={i} className="text-sm text-gray-300">
                  {c.quantity ?? 1} × {c.name}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <p className={section}>Choices &amp; upgrades</p>
          <div className="mt-1">
            <ChoicesEditor productId={product.id} currency={currency} onChanged={onSaved} />
          </div>
        </div>

        <div>
          <p className={section}>Extras</p>
          {modifiers.length === 0 ? (
            <p className="text-xs text-gray-500 mt-1">None.</p>
          ) : modifiers.map(g => (
            <div key={g.id} className="mt-1">
              <p className="text-sm text-gray-300">{g.name}</p>
              <p className="text-xs text-gray-500">
                {(g.options ?? []).map((o: any) =>
                  Number(o.price) ? `${o.name} +${o.price}` : o.name,
                ).join(' · ')}
              </p>
            </div>
          ))}
        </div>
      </div>

      <p className="text-[11px] text-gray-600">
        {currency} · {catName(product.category_id)}
      </p>
    </div>
  );
}
