import { useEffect, useState } from 'react';
import { useTerm } from '../../lib/terminology';
import { api } from '../../lib/api';
import { useBusiness } from '../../context/BusinessContext';
import { useBranch } from '../../context/BranchContext';
import AdjustmentModal from './AdjustmentModal';
import MovementsDrawer from './MovementsDrawer';
import { ProductTableSkeleton } from '../pos/cashier/POSSkeletons';

interface StockRow {
  id: string | null;
  product_id: string;
  quantity: number;
  low_stock_threshold: number;
  _unstocked?: boolean;
  products: {
    id: string;
    name: string;
    image_url: string | null;
    track_stock: boolean;
    status: string;
    categories: { name: string; color: string } | null;
  };
}

type StockStatus = 'all' | 'ok' | 'low' | 'out' | 'untracked';

function getStatus(row: StockRow): 'ok' | 'low' | 'out' | 'untracked' {
  if (!row.products.track_stock) return 'untracked';
  if (row.quantity === 0) return 'out';
  if (row.quantity <= row.low_stock_threshold) return 'low';
  return 'ok';
}

const STATUS_CONFIG = {
  ok:        { label: 'OK',        bg: 'bg-green-500/10',  text: 'text-green-400'  },
  low:       { label: 'Low',       bg: 'bg-amber-500/10',  text: 'text-amber-400'  },
  out:       { label: 'Out',       bg: 'bg-red-500/10',    text: 'text-red-400'    },
  untracked: { label: 'Untracked', bg: 'bg-gray-700',      text: 'text-gray-500'   },
};

export default function InventoryPage() {
  const { business } = useBusiness();
  const { term } = useTerm();
  const { activeBranchId } = useBranch();
  const [rows, setRows] = useState<StockRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<StockStatus>('all');
  const [search, setSearch] = useState('');
  const [adjusting, setAdjusting] = useState<StockRow | null>(null);
  const [viewing, setViewing] = useState<StockRow | null>(null);

  // activeBranchId from context — null means all branches selected
  const branchId = activeBranchId;

  const fetchAll = async () => {
    if (!business) return;
    try {
      const params = new URLSearchParams();
      if (activeBranchId) params.set('branch_id', activeBranchId);
      const data = await api.get<StockRow[]>(`/api/inventory?${params}`);
      setRows(data ?? []);
    } catch (err) {
      console.error('Inventory fetch failed:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (business && activeBranchId) fetchAll();
  }, [business?.id, activeBranchId]);

  const filtered = rows.filter(row => {
    const status = getStatus(row);
    const matchFilter = filter === 'all' || status === filter;
    const matchSearch = row.products.name.toLowerCase().includes(search.toLowerCase());
    return matchFilter && matchSearch;
  });

  // Summary counts
  const counts = { ok: 0, low: 0, out: 0, untracked: 0 };
  rows.forEach(r => counts[getStatus(r)]++);

  const currency = business?.currency ?? 'KES';

  // Inventory is per-branch — require a branch selection
  if (!activeBranchId) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-center p-8">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-gray-600"><path d="M20 7H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2Z"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/><line x1="12" y1="12" x2="12" y2="12.01"/></svg>
        <p className="text-white font-medium">Select a branch to view inventory</p>
        <p className="text-gray-500 text-sm max-w-xs">Each branch has its own independent stock levels. Choose a branch from the sidebar to manage its inventory.</p>
      </div>
    );
  }

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">{term('inventory')}</h1>
          <p className="text-gray-400 text-sm mt-0.5">{rows.length} products</p>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
        {([ 
          { key: 'ok',        label: 'In stock',   icon: '✓', color: 'border-green-500/30 bg-green-500/5' },
          { key: 'low',       label: 'Low stock',  icon: '⚠', color: 'border-amber-500/30 bg-amber-500/5' },
          { key: 'out',       label: 'Out of stock', icon: '✕', color: 'border-red-500/30 bg-red-500/5' },
          { key: 'untracked', label: 'Untracked',  icon: '—', color: 'border-gray-700 bg-gray-900' },
        ] as const).map(card => (
          <button
            key={card.key}
            onClick={() => setFilter(filter === card.key ? 'all' : card.key)}
            className={`border rounded-xl p-4 text-left transition-all ${card.color} ${filter === card.key ? 'ring-1 ring-white/20' : 'hover:ring-1 hover:ring-white/10'}`}
          >
            <p className="text-gray-400 text-xs mb-1">{card.label}</p>
            <p className="text-white text-2xl font-bold">{counts[card.key]}</p>
          </button>
        ))}
      </div>

      {/* Search + filter */}
      <div className="flex gap-3 mb-6">
        <input
          type="text"
          placeholder="Search products…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="bg-gray-900 border border-gray-800 rounded-lg px-4 py-2 text-white placeholder-gray-600 text-sm focus:outline-none focus:border-green-500 transition-colors w-64"
        />
        {filter !== 'all' && (
          <button
            onClick={() => setFilter('all')}
            className="text-xs text-gray-400 hover:text-white px-3 py-2 bg-gray-900 border border-gray-800 rounded-lg transition-colors"
          >
            Clear filter ✕
          </button>
        )}
      </div>

      {loading ? (
        <ProductTableSkeleton />
      ) : filtered.length === 0 ? (
        <div className="text-center py-20 text-gray-500">
          <p className="text-lg">No products found</p>
        </div>
      ) : (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-gray-800 text-left">
                <th className="px-4 py-3 text-xs text-gray-500 font-medium uppercase tracking-wider">Product</th>
                <th className="px-4 py-3 text-xs text-gray-500 font-medium uppercase tracking-wider">Category</th>
                <th className="px-4 py-3 text-xs text-gray-500 font-medium uppercase tracking-wider">Stock</th>
                <th className="px-4 py-3 text-xs text-gray-500 font-medium uppercase tracking-wider">Threshold</th>
                <th className="px-4 py-3 text-xs text-gray-500 font-medium uppercase tracking-wider">Status</th>
                <th className="px-4 py-3 text-xs text-gray-500 font-medium uppercase tracking-wider"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {filtered.map(row => {
                const status = getStatus(row);
                const cfg = STATUS_CONFIG[status];
                const isUntracked = status === 'untracked';
                return (
                  <tr key={row.product_id} className="hover:bg-gray-800/50 transition-colors">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        {row.products.image_url ? (
                          <img src={row.products.image_url} alt={row.products.name} className="w-9 h-9 rounded-lg object-cover flex-shrink-0" />
                        ) : (
                          <div className="w-9 h-9 rounded-lg bg-gray-800 flex items-center justify-center text-gray-600 flex-shrink-0 text-xs">IMG</div>
                        )}
                        <p className={`text-sm font-medium ${isUntracked ? 'text-gray-500' : 'text-white'}`}>
                          {row.products.name}
                        </p>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      {row.products.categories ? (
                        <span className="text-xs text-gray-300">{row.products.categories.name}</span>
                      ) : (
                        <span className="text-xs text-gray-600">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {isUntracked ? (
                        <span className="text-gray-600 text-sm">—</span>
                      ) : (
                        <span className={`text-sm font-semibold ${status === 'out' ? 'text-red-400' : status === 'low' ? 'text-amber-400' : 'text-white'}`}>
                          {row.quantity}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {isUntracked ? (
                        <span className="text-gray-600 text-sm">—</span>
                      ) : (
                        <span className="text-gray-400 text-sm">{row.low_stock_threshold}</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`text-xs px-2 py-1 rounded-full ${cfg.bg} ${cfg.text}`}>
                        {cfg.label}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2 justify-end">
                        {!isUntracked && (
                          <>
                            <button
                              onClick={() => setAdjusting(row)}
                              className="text-xs text-green-400 hover:text-green-300 px-2 py-1 rounded hover:bg-gray-700 transition-colors"
                            >
                              Adjust
                            </button>
                            <button
                              onClick={() => setViewing(row)}
                              className="text-xs text-gray-400 hover:text-white px-2 py-1 rounded hover:bg-gray-700 transition-colors"
                            >
                              History
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Adjustment modal */}
      {adjusting && branchId && (
        <AdjustmentModal
          product={{
            id: adjusting.product_id,
            name: adjusting.products.name,
            currentQty: adjusting.quantity,
          }}
          branchId={branchId}
          currency={currency}
          onClose={() => setAdjusting(null)}
          onSaved={() => { setAdjusting(null); fetchAll(); }}
        />
      )}

      {/* Movements drawer */}
      {viewing && branchId && (
        <MovementsDrawer
          product={{ id: viewing.product_id, name: viewing.products.name }}
          branchId={branchId}
          onClose={() => setViewing(null)}
        />
      )}
    </div>
  );
}
