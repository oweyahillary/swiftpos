/**
 * POSInventoryTab
 * Read-only stock level view for the cashier's branch.
 * Shows low-stock items first, with a colour-coded quantity indicator.
 * Permission required: inventory.view
 */

import { useState, useEffect } from 'react';
import { usePOSAuth } from '../../context/POSAuthContext';

// ── Types ─────────────────────────────────────────────────────────────────────

interface StockRow {
  id: string | null;
  product_id: string;
  quantity: number;
  low_stock_threshold: number;
  _unstocked?: boolean;
  products: {
    id: string;
    name: string;
    track_stock: boolean;
    status: string;
    categories: { name: string; color: string } | null;
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function stockStatus(qty: number, threshold: number): { color: string; label: string } {
  if (qty <= 0)         return { color: '#ef4444', label: 'Out' };
  if (qty <= threshold) return { color: '#f59e0b', label: 'Low' };
  return                       { color: '#22c55e', label: 'OK'  };
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function POSInventoryTab() {
  const { posApi, session } = usePOSAuth();

  const [rows, setRows]       = useState<StockRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const [search, setSearch]   = useState('');
  const [filter, setFilter]   = useState<'all' | 'low' | 'out'>('all');

  useEffect(() => {
    const params = new URLSearchParams();
    if (session?.branchId) params.set('branch_id', session.branchId);

    posApi.get<StockRow[]>(`/api/inventory?${params}`)
      .then(data => setRows(data ?? []))
      .catch(e  => setError(e?.message ?? 'Failed to load inventory'))
      .finally(() => setLoading(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Only show tracked products
  const tracked = rows.filter(r => r.products.track_stock && r.products.status === 'active');

  const filtered = tracked.filter(r => {
    const matchSearch = r.products.name.toLowerCase().includes(search.toLowerCase());
    if (!matchSearch) return false;
    if (filter === 'out') return r.quantity <= 0;
    if (filter === 'low') return r.quantity > 0 && r.quantity <= r.low_stock_threshold;
    return true;
  });

  const outCount = tracked.filter(r => r.quantity <= 0).length;
  const lowCount = tracked.filter(r => r.quantity > 0 && r.quantity <= r.low_stock_threshold).length;

  return (
    <div style={s.root}>
      {/* Filter chips */}
      <div style={s.chips}>
        {([
          ['all', `All (${tracked.length})`],
          ['low', `⚠️ Low (${lowCount})`],
          ['out', `🔴 Out (${outCount})`],
        ] as const).map(([key, label]) => (
          <button
            key={key}
            style={{ ...s.chip, ...(filter === key ? s.chipActive : {}) }}
            onClick={() => setFilter(key)}
          >{label}</button>
        ))}
      </div>

      {/* Search */}
      <input
        style={s.search}
        placeholder="Search product…"
        value={search}
        onChange={e => setSearch(e.target.value)}
      />

      {error && <p style={s.error}>{error}</p>}

      {loading && <div style={s.center}><span style={s.spinner} /></div>}

      {!loading && filtered.length === 0 && (
        <p style={s.empty}>No products match this filter.</p>
      )}

      {/* Stock list */}
      <div style={s.list}>
        {filtered.map(row => {
          const { color, label } = stockStatus(row.quantity, row.low_stock_threshold);
          const catColor = row.products.categories?.color ?? '#475569';
          return (
            <div key={row.product_id} style={s.item}>
              <div style={{ ...s.catDot, background: catColor }} />
              <div style={s.itemInfo}>
                <span style={s.itemName}>{row.products.name}</span>
                {row.products.categories && (
                  <span style={s.itemCat}>{row.products.categories.name}</span>
                )}
              </div>
              <div style={s.itemRight}>
                <span style={{ ...s.qty, color }}>{row.quantity}</span>
                <span style={{ ...s.badge, background: `${color}22`, color }}>{label}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  root:   { paddingBottom: 24 },
  chips:  { display: 'flex', gap: 6, marginBottom: 10 },
  chip:   {
    padding: '5px 12px', background: '#1e293b', border: '1px solid #334155',
    borderRadius: 20, color: '#64748b', fontSize: 12, fontWeight: 600, cursor: 'pointer',
  },
  chipActive: { background: 'rgba(59,130,246,0.15)', border: '1px solid #3b82f6', color: '#93c5fd' },
  search: {
    width: '100%', padding: '8px 12px', background: '#0f172a', border: '1px solid #334155',
    borderRadius: 7, color: '#f1f5f9', fontSize: 13, marginBottom: 12,
    boxSizing: 'border-box' as const, outline: 'none',
  },
  error:   { color: '#fca5a5', fontSize: 13, margin: '8px 0' },
  center:  { display: 'flex', justifyContent: 'center', padding: 24 },
  spinner: {
    display: 'inline-block', width: 22, height: 22,
    border: '2px solid #334155', borderTop: '2px solid #3b82f6', borderRadius: '50%',
    animation: 'spin 0.8s linear infinite',
  },
  empty:   { color: '#475569', fontSize: 13, textAlign: 'center', padding: '24px 0' },
  list:    { display: 'flex', flexDirection: 'column', gap: 4 },
  item:    {
    display: 'flex', alignItems: 'center', gap: 10,
    padding: '9px 10px', background: '#0f172a', borderRadius: 8, border: '1px solid #1e293b',
  },
  catDot:  { width: 8, height: 8, borderRadius: '50%', flexShrink: 0 },
  itemInfo:{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 },
  itemName:{ fontSize: 13, color: '#f1f5f9', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  itemCat: { fontSize: 10, color: '#475569' },
  itemRight:{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 },
  qty:     { fontSize: 16, fontWeight: 700, minWidth: 28, textAlign: 'right' as const },
  badge:   { fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 4 },
};
