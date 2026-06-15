import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api';
import { useBusiness } from '../context/BusinessContext';
import ConfirmModal, { useConfirm } from '../components/ConfirmModal';

interface Discount {
  id: string;
  name: string;
  type: 'percentage' | 'fixed';
  value: number;
  applies_to: 'order' | 'item';
  promo_code: string | null;
  min_order_value: number;
  max_uses: number | null;
  used_count: number;
  expires_at: string | null;
  status: 'active' | 'inactive';
  created_at: string;
}

const EMPTY_FORM = {
  name: '',
  type: 'percentage' as 'percentage' | 'fixed',
  value: '',
  applies_to: 'order' as 'order' | 'item',
  promo_code: '',
  min_order_value: '',
  max_uses: '',
  expires_at: '',
};

export default function DiscountsPage() {
  const { business } = useBusiness();
  const currency = business?.currency ?? 'KES';
  const [confirmState, showConfirm, closeConfirm] = useConfirm();
  const [discounts, setDiscounts] = useState<Discount[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editTarget, setEditTarget] = useState<Discount | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const fetchDiscounts = useCallback(async () => {
    try {
      const data = await api.get<Discount[]>('/api/discounts');
      setDiscounts(data);
    } catch (err: any) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchDiscounts(); }, [fetchDiscounts]);

  function openCreate() {
    setEditTarget(null);
    setForm(EMPTY_FORM);
    setError('');
    setShowForm(true);
  }

  function openEdit(d: Discount) {
    setEditTarget(d);
    setForm({
      name: d.name,
      type: d.type,
      value: String(d.value),
      applies_to: d.applies_to,
      promo_code: d.promo_code ?? '',
      min_order_value: d.min_order_value > 0 ? String(d.min_order_value) : '',
      max_uses: d.max_uses !== null ? String(d.max_uses) : '',
      expires_at: d.expires_at ? d.expires_at.split('T')[0] : '',
    });
    setError('');
    setShowForm(true);
  }

  async function handleSave() {
    setError('');
    if (!form.name.trim()) return setError('Name is required');
    if (!form.value || isNaN(Number(form.value)) || Number(form.value) <= 0) return setError('Value must be a positive number');
    if (form.type === 'percentage' && Number(form.value) > 100) return setError('Percentage cannot exceed 100');

    setSaving(true);
    const payload = {
      name: form.name.trim(),
      type: form.type,
      value: Number(form.value),
      applies_to: form.applies_to,
      promo_code: form.promo_code.trim() || null,
      min_order_value: form.min_order_value ? Number(form.min_order_value) : 0,
      max_uses: form.max_uses ? Number(form.max_uses) : null,
      expires_at: form.expires_at || null,
      status: 'active',
    };

    try {
      if (editTarget) {
        await api.put(`/api/discounts/${editTarget.id}`, payload);
      } else {
        await api.post('/api/discounts', payload);
      }
      await fetchDiscounts();
      setShowForm(false);
    } catch (err: any) {
      setError(err.message ?? 'Failed to save discount');
    } finally {
      setSaving(false);
    }
  }

  async function handleToggle(d: Discount) {
    try {
      await api.patch(`/api/discounts/${d.id}/toggle`, {});
      await fetchDiscounts();
    } catch (err: any) {
      setError(err.message ?? 'Failed to toggle discount');
    }
  }

  async function handleDelete(d: Discount) {
    showConfirm({
      title: `Delete "${d.name}"?`,
      message: 'This cannot be undone.',
      intent: 'destructive',
      confirmLabel: 'Delete',
      onConfirm: async () => {
        await api.delete(`/api/discounts/${d.id}`);
        await fetchDiscounts();
      },
    });
  }

  function formatValue(d: Discount) {
    return d.type === 'percentage' ? `${d.value}%` : `${currency} ${d.value.toLocaleString()}`;
  }

  function isExpired(d: Discount) {
    return d.expires_at ? new Date(d.expires_at) < new Date() : false;
  }

  return (
    <div className="flex-1 overflow-y-auto p-6 bg-gray-950">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold text-white">Discounts & Promotions<span className="text-[10px] font-medium text-blue-400 bg-blue-500/10 border border-blue-500/20 rounded-full px-2 py-0.5 ml-2 align-middle">All branches</span></h1>
          <p className="text-gray-500 text-sm mt-0.5">{discounts.length} discount{discounts.length !== 1 ? 's' : ''}</p>
        </div>
        <button
          onClick={openCreate}
          className="px-4 py-2 bg-green-500 hover:bg-green-400 text-black text-sm font-semibold rounded-lg transition-colors"
        >
          + New Discount
        </button>
      </div>

      {/* Table */}
      {loading ? (
        <div className="text-center py-20 text-gray-500 text-sm">Loading...</div>
      ) : discounts.length === 0 ? (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-16 text-center">
          <p className="text-3xl mb-3">🏷️</p>
          <p className="text-gray-400 text-sm font-medium">No discounts yet</p>
          <p className="text-gray-600 text-xs mt-1">Create percentage or fixed discounts and promo codes for your POS</p>
          <button onClick={openCreate} className="mt-4 px-4 py-2 bg-green-500 hover:bg-green-400 text-black text-sm font-semibold rounded-lg transition-colors">
            Create first discount
          </button>
        </div>
      ) : (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800">
                <th className="text-left px-4 py-3 text-gray-500 text-xs font-medium">Name</th>
                <th className="text-left px-4 py-3 text-gray-500 text-xs font-medium">Value</th>
                <th className="text-left px-4 py-3 text-gray-500 text-xs font-medium">Promo Code</th>
                <th className="text-left px-4 py-3 text-gray-500 text-xs font-medium">Applies To</th>
                <th className="text-left px-4 py-3 text-gray-500 text-xs font-medium">Usage</th>
                <th className="text-left px-4 py-3 text-gray-500 text-xs font-medium">Expires</th>
                <th className="text-left px-4 py-3 text-gray-500 text-xs font-medium">Status</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {discounts.map(d => {
                const expired = isExpired(d);
                return (
                  <tr key={d.id} className="border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors">
                    <td className="px-4 py-3">
                      <p className="text-white font-medium">{d.name}</p>
                      {d.min_order_value > 0 && (
                        <p className="text-gray-500 text-xs">Min order: {currency} {d.min_order_value.toLocaleString()}</p>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-green-400 font-semibold">{formatValue(d)}</span>
                    </td>
                    <td className="px-4 py-3">
                      {d.promo_code ? (
                        <span className="font-mono text-xs bg-gray-800 text-yellow-400 px-2 py-1 rounded border border-gray-700">
                          {d.promo_code}
                        </span>
                      ) : (
                        <span className="text-gray-600 text-xs">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-400 capitalize">{d.applies_to}</td>
                    <td className="px-4 py-3 text-gray-400">
                      {d.used_count}
                      {d.max_uses !== null && <span className="text-gray-600"> / {d.max_uses}</span>}
                    </td>
                    <td className="px-4 py-3">
                      {d.expires_at ? (
                        <span className={`text-xs ${expired ? 'text-red-400' : 'text-gray-400'}`}>
                          {expired ? '⚠ ' : ''}{new Date(d.expires_at).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' })}
                        </span>
                      ) : (
                        <span className="text-gray-600 text-xs">Never</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <button
                        onClick={() => handleToggle(d)}
                        className={`text-xs px-2 py-1 rounded-full border transition-colors ${
                          d.status === 'active' && !expired
                            ? 'bg-green-500/10 text-green-400 border-green-500/20 hover:bg-red-500/10 hover:text-red-400 hover:border-red-500/20'
                            : 'bg-gray-800 text-gray-500 border-gray-700 hover:bg-green-500/10 hover:text-green-400 hover:border-green-500/20'
                        }`}
                      >
                        {d.status === 'active' ? 'Active' : 'Inactive'}
                      </button>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3 justify-end">
                        <button onClick={() => openEdit(d)} className="text-xs text-gray-400 hover:text-white transition-colors">Edit</button>
                        <button onClick={() => handleDelete(d)} className="text-xs text-red-400 hover:text-red-300 transition-colors">Delete</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Modal */}
      {showForm && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setShowForm(false)}>
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6 w-full max-w-lg shadow-2xl" onClick={e => e.stopPropagation()}>
            <h2 className="text-white font-semibold text-lg mb-5">{editTarget ? 'Edit Discount' : 'New Discount'}</h2>

            {error && <p className="mb-4 text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">{error}</p>}

            <div className="space-y-4">
              {/* Name */}
              <div>
                <label className="block text-gray-400 text-xs mb-1.5">Name *</label>
                <input
                  value={form.name}
                  onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="e.g. Happy Hour 20%"
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-green-500"
                />
              </div>

              {/* Type + Value */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-gray-400 text-xs mb-1.5">Type *</label>
                  <select
                    value={form.type}
                    onChange={e => setForm(f => ({ ...f, type: e.target.value as 'percentage' | 'fixed' }))}
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-green-500"
                  >
                    <option value="percentage">Percentage (%)</option>
                    <option value="fixed">Fixed ({currency})</option>
                  </select>
                </div>
                <div>
                  <label className="block text-gray-400 text-xs mb-1.5">Value *</label>
                  <input
                    type="number"
                    value={form.value}
                    onChange={e => setForm(f => ({ ...f, value: e.target.value }))}
                    placeholder={form.type === 'percentage' ? '0–100' : '0.00'}
                    min="0"
                    max={form.type === 'percentage' ? 100 : undefined}
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-green-500"
                  />
                </div>
              </div>

              {/* Applies to */}
              <div>
                <label className="block text-gray-400 text-xs mb-1.5">Applies To</label>
                <select
                  value={form.applies_to}
                  onChange={e => setForm(f => ({ ...f, applies_to: e.target.value as 'order' | 'item' }))}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-green-500"
                >
                  <option value="order">Entire Order</option>
                  <option value="item">Per Item</option>
                </select>
              </div>

              {/* Promo code */}
              <div>
                <label className="block text-gray-400 text-xs mb-1.5">Promo Code <span className="text-gray-600">(optional)</span></label>
                <input
                  value={form.promo_code}
                  onChange={e => setForm(f => ({ ...f, promo_code: e.target.value.toUpperCase() }))}
                  placeholder="e.g. SAVE20"
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-green-500 font-mono"
                />
              </div>

              {/* Min order + Max uses */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-gray-400 text-xs mb-1.5">Min Order ({currency}) <span className="text-gray-600">(optional)</span></label>
                  <input
                    type="number"
                    value={form.min_order_value}
                    onChange={e => setForm(f => ({ ...f, min_order_value: e.target.value }))}
                    placeholder="0"
                    min="0"
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-green-500"
                  />
                </div>
                <div>
                  <label className="block text-gray-400 text-xs mb-1.5">Max Uses <span className="text-gray-600">(optional)</span></label>
                  <input
                    type="number"
                    value={form.max_uses}
                    onChange={e => setForm(f => ({ ...f, max_uses: e.target.value }))}
                    placeholder="Unlimited"
                    min="1"
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-green-500"
                  />
                </div>
              </div>

              {/* Expires at */}
              <div>
                <label className="block text-gray-400 text-xs mb-1.5">Expires On <span className="text-gray-600">(optional)</span></label>
                <input
                  type="date"
                  value={form.expires_at}
                  onChange={e => setForm(f => ({ ...f, expires_at: e.target.value }))}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-green-500"
                />
              </div>
            </div>

            <div className="flex gap-3 mt-6">
              <button onClick={() => setShowForm(false)} className="flex-1 px-4 py-2 text-sm text-gray-400 hover:text-white border border-gray-700 rounded-lg transition-colors">
                Cancel
              </button>
              <button onClick={handleSave} disabled={saving} className="flex-1 px-4 py-2 text-sm font-semibold bg-green-500 hover:bg-green-400 disabled:opacity-50 text-black rounded-lg transition-colors">
                {saving ? 'Saving...' : 'Save Discount'}
              </button>
            </div>
          </div>
        </div>
      )}
      <ConfirmModal state={confirmState} onClose={closeConfirm} />
    </div>
  );
}
