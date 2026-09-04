/**
 * ManagerMenuTab — READ-ONLY menu view for a branch manager.
 *
 * Product-policy decision: on the WEB, menu EDITING stays owner-only. A manager can
 * SEE the menu (products, prices, category, active/inactive) so they can answer
 * "what's on and what does it cost" without phoning the owner — but there is no
 * edit control here. (On the desktop till, menu editing is granted to managers; the
 * web deliberately differs.) Editing lives on the owner dashboard's Products screen.
 */
import { useCallback, useEffect, useState } from 'react';
import { usePOSAuth } from '../../context/POSAuthContext';

interface Product {
  id: string;
  name: string;
  base_price: number;
  status: string;                 // 'active' | 'inactive' | ...
  is_fuel?: boolean;
  categories?: { name: string } | null;
}

export default function ManagerMenuTab({ currency }: { currency: string }) {
  const { posApi } = usePOSAuth();
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState('');
  const [q, setQ]               = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      setProducts(await posApi.get<Product[]>('/api/products'));
    } catch (e: any) {
      setError(e?.message ?? 'Could not load the menu');
    } finally { setLoading(false); }
  }, [posApi]);
  useEffect(() => { void load(); }, [load]);

  const money = (v: number) => `${currency} ${Number(v ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const term = q.trim().toLowerCase();
  const filtered = term
    ? products.filter(p => p.name.toLowerCase().includes(term) || (p.categories?.name ?? '').toLowerCase().includes(term))
    : products;

  // Group by category name for a readable menu.
  const groups = new Map<string, Product[]>();
  for (const p of filtered) {
    const g = p.categories?.name ?? 'Uncategorised';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(p);
  }
  const orderedGroups = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  return (
    <div className="p-6 space-y-5">
      <div>
        <h2 className="text-white text-lg font-semibold">Menu</h2>
        <p className="text-gray-500 text-sm">View products, prices and availability. Menu changes are made by the owner.</p>
      </div>

      <input
        value={q} onChange={e => setQ(e.target.value)}
        placeholder="Search products or categories…"
        className="w-full max-w-sm bg-gray-900 border border-gray-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 placeholder-gray-600"
      />

      {error && <p className="text-red-400 text-sm">{error}</p>}

      {loading ? <p className="text-gray-500 text-sm">Loading…</p>
        : orderedGroups.length === 0 ? (
          <div className="rounded-xl border border-dashed border-gray-800 p-8 text-center">
            <p className="text-gray-500 text-sm">{term ? 'No products match your search.' : 'No products yet.'}</p>
          </div>
        ) : (
          <div className="space-y-5">
            {orderedGroups.map(([cat, items]) => (
              <div key={cat}>
                <h3 className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-2">{cat} <span className="text-gray-600">· {items.length}</span></h3>
                <div className="bg-gray-900 border border-gray-800 rounded-xl divide-y divide-gray-800">
                  {items.map(p => (
                    <div key={p.id} className="flex items-center justify-between px-4 py-2.5">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-gray-200 text-sm truncate">{p.name}</span>
                        {p.status !== 'active' && <span className="text-[10px] px-1.5 py-0.5 rounded-full border border-gray-600 text-gray-400 flex-shrink-0">inactive</span>}
                      </div>
                      <span className="text-gray-300 text-sm tabular-nums flex-shrink-0">{p.is_fuel ? `${money(p.base_price)}/L` : money(p.base_price)}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
    </div>
  );
}
