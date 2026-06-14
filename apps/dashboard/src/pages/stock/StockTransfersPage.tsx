import { useEffect, useState, useCallback } from 'react';
import { api } from '../../lib/api';
import { useBusiness } from '../../context/BusinessContext';
import { useBranch } from '../../context/BranchContext';

interface Product { id: string; name: string; }
interface Branch  { id: string; name: string; }

interface TransferItem {
  product_id: string;
  quantity: number;
  products: { name: string };
}

interface Transfer {
  id: string;
  transfer_number: string;
  from_branch_id: string;
  from_branch_name: string;
  to_branch_id: string;
  to_branch_name: string;
  status: 'pending' | 'in_transit' | 'received' | 'cancelled';
  notes: string | null;
  created_at: string;
  stock_transfer_items: TransferItem[];
}

const STATUS_CONFIG: Record<string, { label: string; cls: string }> = {
  pending:    { label: 'Pending',    cls: 'bg-gray-700 text-gray-300' },
  in_transit: { label: 'In Transit', cls: 'bg-blue-500/10 text-blue-400' },
  received:   { label: 'Received',   cls: 'bg-green-500/10 text-green-400' },
  cancelled:  { label: 'Cancelled',  cls: 'bg-red-500/10 text-red-400' },
};

export default function StockTransfersPage() {
  const { business } = useBusiness();
  const { activeBranchId } = useBranch();

  const [transfers, setTransfers]   = useState<Transfer[]>([]);
  const [branches, setBranches]     = useState<Branch[]>([]);
  const [products, setProducts]     = useState<Product[]>([]);
  const [loading, setLoading]       = useState(true);
  const [expanded, setExpanded]     = useState<string | null>(null);

  // Create modal
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm]             = useState({ from_branch_id: '', to_branch_id: '', notes: '' });
  const [lines, setLines]           = useState<{ product_id: string; quantity: string }[]>([
    { product_id: '', quantity: '' },
  ]);
  const [createError, setCreateError] = useState('');
  const [creating, setCreating]       = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [tData, bData, pData] = await Promise.all([
        api.get<Transfer[]>(activeBranchId ? `/api/stock/transfers?branch_id=${activeBranchId}` : '/api/stock/transfers'),
        api.get<Branch[]>('/api/branches'),
        api.get<Product[]>('/api/products?status=active'),
      ]);
      setTransfers(tData);
      setBranches(bData);
      setProducts(Array.isArray(pData) ? pData : []);
    } finally {
      setLoading(false);
    }
  }, [activeBranchId]);

  useEffect(() => { load(); }, [load]);

  const addLine = () => setLines(l => [...l, { product_id: '', quantity: '' }]);
  const removeLine = (i: number) => setLines(l => l.filter((_, idx) => idx !== i));
  const updateLine = (i: number, field: string, val: string) =>
    setLines(l => l.map((item, idx) => idx === i ? { ...item, [field]: val } : item));

  const create = async () => {
    if (!form.from_branch_id || !form.to_branch_id) { setCreateError('Select both branches'); return; }
    if (form.from_branch_id === form.to_branch_id) { setCreateError('Branches must be different'); return; }
    const valid = lines.filter(l => l.product_id && Number(l.quantity) > 0);
    if (!valid.length) { setCreateError('Add at least one item with a quantity'); return; }

    setCreating(true); setCreateError('');
    try {
      await api.post('/api/stock/transfers', {
        from_branch_id: form.from_branch_id,
        to_branch_id: form.to_branch_id,
        notes: form.notes || null,
        items: valid.map(l => ({ product_id: l.product_id, quantity: Number(l.quantity) })),
      });
      setShowCreate(false);
      setForm({ from_branch_id: '', to_branch_id: '', notes: '' });
      setLines([{ product_id: '', quantity: '' }]);
      await load();
    } catch (e: any) {
      setCreateError(e?.message ?? 'Transfer failed');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="flex-1 overflow-auto p-6">

      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-white">Stock Transfers</h1>
          <p className="text-gray-500 text-sm mt-0.5">Move stock between branches</p>
        </div>
        <button
          onClick={() => { setCreateError(''); setShowCreate(true); }}
          className="flex items-center gap-2 bg-green-500 hover:bg-green-400 text-black font-semibold text-sm px-4 py-2 rounded-lg transition-colors"
        >
          + New Transfer
        </button>
      </div>

      {/* Transfer list */}
      <div className="space-y-2">
        {loading ? (
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-12 text-center text-gray-500 text-sm">Loading…</div>
        ) : transfers.length === 0 ? (
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-12 text-center">
            <p className="text-3xl mb-3">🔄</p>
            <p className="text-white font-medium mb-1">No transfers yet</p>
            <p className="text-gray-500 text-sm">Create a transfer to move stock between branches</p>
          </div>
        ) : transfers.map(t => {
          const st = STATUS_CONFIG[t.status];
          const isOpen = expanded === t.id;
          return (
            <div
              key={t.id}
              className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden"
            >
              <div
                onClick={() => setExpanded(isOpen ? null : t.id)}
                className="flex items-center justify-between px-5 py-4 cursor-pointer hover:bg-gray-800/30 transition-colors"
              >
                <div className="flex items-center gap-4 min-w-0">
                  <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium flex-shrink-0 ${st.cls}`}>
                    {st.label}
                  </span>
                  <div className="min-w-0">
                    <p className="text-white font-semibold text-sm">{t.transfer_number}</p>
                    <p className="text-gray-500 text-xs mt-0.5">
                      {t.from_branch_name} → {t.to_branch_name}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-3 flex-shrink-0">
                  <span className="text-gray-400 text-xs">{t.stock_transfer_items.length} item{t.stock_transfer_items.length !== 1 ? 's' : ''}</span>
                  <span className="text-gray-500 text-xs">{new Date(t.created_at).toLocaleDateString('en-KE')}</span>
                  <span className="text-gray-600 text-xs">{isOpen ? '▲' : '▼'}</span>
                </div>
              </div>

              {isOpen && (
                <div className="px-5 pb-4 border-t border-gray-800">
                  <table className="w-full text-xs mt-3">
                    <thead>
                      <tr className="text-gray-500 uppercase tracking-wide">
                        <th className="text-left pb-2">Product</th>
                        <th className="text-right pb-2">Quantity</th>
                      </tr>
                    </thead>
                    <tbody>
                      {t.stock_transfer_items.map((item, i) => (
                        <tr key={i} className="border-t border-gray-800/50">
                          <td className="py-1.5 text-gray-300">{item.products?.name ?? item.product_id}</td>
                          <td className="py-1.5 text-white text-right font-medium">{item.quantity}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {t.notes && <p className="text-gray-500 text-xs mt-3 italic">Note: {t.notes}</p>}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* ── CREATE MODAL ──────────────────────────────────────────────────────── */}
      {showCreate && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-800 rounded-2xl w-full max-w-lg max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between px-6 py-5 border-b border-gray-800 flex-shrink-0">
              <h2 className="text-white font-semibold text-base">New Stock Transfer</h2>
              <button onClick={() => setShowCreate(false)} className="text-gray-500 hover:text-white text-lg">✕</button>
            </div>

            <div className="overflow-auto flex-1 px-6 py-5 space-y-4">
              <p className="text-gray-400 text-sm">Stock is transferred immediately. Ensure the sending branch has sufficient quantity.</p>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-gray-500 uppercase tracking-wide mb-1.5">From Branch *</label>
                  <select
                    className="w-full bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-3 py-2.5 outline-none focus:border-green-500"
                    value={form.from_branch_id}
                    onChange={e => setForm(f => ({ ...f, from_branch_id: e.target.value }))}
                  >
                    <option value="">Select…</option>
                    {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-gray-500 uppercase tracking-wide mb-1.5">To Branch *</label>
                  <select
                    className="w-full bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-3 py-2.5 outline-none focus:border-green-500"
                    value={form.to_branch_id}
                    onChange={e => setForm(f => ({ ...f, to_branch_id: e.target.value }))}
                  >
                    <option value="">Select…</option>
                    {branches
                      .filter(b => b.id !== form.from_branch_id)
                      .map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                  </select>
                </div>
              </div>

              {/* Line items */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-xs text-gray-500 uppercase tracking-wide">Items *</label>
                  <button onClick={addLine} className="text-xs text-green-400 hover:text-green-300">+ Add row</button>
                </div>

                <div className="space-y-2">
                  <div className="grid grid-cols-12 gap-2 text-xs text-gray-500 uppercase tracking-wide px-1">
                    <span className="col-span-8">Product</span>
                    <span className="col-span-3 text-right">Quantity</span>
                    <span className="col-span-1"></span>
                  </div>
                  {lines.map((line, i) => (
                    <div key={i} className="grid grid-cols-12 gap-2 items-center">
                      <div className="col-span-8">
                        <select
                          className="w-full bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-2 py-2 outline-none focus:border-green-500"
                          value={line.product_id}
                          onChange={e => updateLine(i, 'product_id', e.target.value)}
                        >
                          <option value="">Select product…</option>
                          {products.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                        </select>
                      </div>
                      <div className="col-span-3">
                        <input
                          type="number"
                          min="1"
                          className="w-full bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-2 py-2 outline-none focus:border-green-500 text-right"
                          value={line.quantity}
                          onChange={e => updateLine(i, 'quantity', e.target.value)}
                          placeholder="0"
                        />
                      </div>
                      <div className="col-span-1 flex justify-center">
                        {lines.length > 1 && (
                          <button onClick={() => removeLine(i)} className="text-gray-600 hover:text-red-400 text-sm">✕</button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-xs text-gray-500 uppercase tracking-wide mb-1.5">Notes</label>
                <input
                  className="w-full bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-3 py-2.5 outline-none focus:border-green-500"
                  value={form.notes}
                  onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                  placeholder="Reason for transfer…"
                />
              </div>

              {createError && <p className="text-red-400 text-sm">{createError}</p>}
            </div>

            <div className="flex gap-3 px-6 pb-6 pt-3 flex-shrink-0 border-t border-gray-800">
              <button
                onClick={() => setShowCreate(false)}
                className="flex-1 bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm font-medium py-2.5 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={create}
                disabled={creating}
                className="flex-1 bg-green-500 hover:bg-green-400 disabled:opacity-50 text-black font-semibold text-sm py-2.5 rounded-lg transition-colors"
              >
                {creating ? 'Transferring…' : 'Transfer Stock'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
