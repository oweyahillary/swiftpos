import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api';
import ConfirmModal, { useConfirm } from '../components/ConfirmModal';

// Custom payment methods, per business (register A95 / #4). The built-in tenders
// (Cash, M-Pesa, Card) are always available at the POS and are not listed here —
// this screen manages the EXTRA ones a business accepts (Coop Card, Airtel Money,
// a house account). All are non-cash for shift reconciliation.
interface PaymentMethod {
  id: string;
  name: string;
  code: string;
  is_active: boolean;
  sort_order: number;
}

export default function PaymentMethodsPage() {
  const [confirmState, showConfirm, closeConfirm] = useConfirm();
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');

  const fetchMethods = useCallback(async () => {
    try {
      setMethods(await api.get<PaymentMethod[]>('/api/payment-methods'));
    } catch (e: any) {
      setError(e?.message ?? 'Could not load payment methods');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void fetchMethods(); }, [fetchMethods]);

  const add = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setSaving(true); setError('');
    try {
      await api.post('/api/payment-methods', { name: trimmed, sort_order: methods.length });
      setName('');
      await fetchMethods();
    } catch (e: any) {
      setError(e?.message ?? 'Could not add the method');
    } finally { setSaving(false); }
  };

  const saveEdit = async (m: PaymentMethod) => {
    const trimmed = editName.trim();
    if (!trimmed || trimmed === m.name) { setEditId(null); return; }
    try {
      await api.patch(`/api/payment-methods/${m.id}`, { name: trimmed });
      setEditId(null);
      await fetchMethods();
    } catch (e: any) { setError(e?.message ?? 'Could not rename'); }
  };

  const toggle = async (m: PaymentMethod) => {
    setMethods(prev => prev.map(x => x.id === m.id ? { ...x, is_active: !x.is_active } : x));
    try {
      await api.patch(`/api/payment-methods/${m.id}`, { is_active: !m.is_active });
    } catch (e: any) {
      setError(e?.message ?? 'Could not update'); await fetchMethods();
    }
  };

  const remove = (m: PaymentMethod) => {
    showConfirm({
      title: `Delete "${m.name}"?`,
      message: 'It will no longer be offered at the POS. Past sales that used it keep their record.',
      intent: 'destructive',
      confirmLabel: 'Delete',
      onConfirm: async () => {
        await api.delete(`/api/payment-methods/${m.id}`);
        await fetchMethods();
      },
    });
  };

  return (
    <div className="max-w-2xl mx-auto p-6">
      <h1 className="text-xl font-semibold text-white">Payment methods</h1>
      <p className="text-sm text-gray-400 mt-1">
        Cash, M-Pesa and Card are always available. Add any other methods you accept —
        they appear at the POS and in your payment reports. All count as non-cash.
      </p>

      {error && <p className="text-red-400 text-sm mt-3">{error}</p>}

      <div className="mt-6 flex gap-2">
        <input
          value={name}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') void add(); }}
          placeholder="e.g. Coop Card"
          className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-green-500"
        />
        <button
          onClick={add}
          disabled={saving || !name.trim()}
          className="bg-green-500 hover:bg-green-400 disabled:opacity-40 text-gray-950 font-semibold px-4 py-2 rounded-lg text-sm"
        >
          {saving ? 'Adding…' : 'Add'}
        </button>
      </div>

      <div className="mt-6 space-y-2">
        {loading ? (
          <p className="text-sm text-gray-500">Loading…</p>
        ) : methods.length === 0 ? (
          <div className="border border-gray-800 rounded-lg p-6 text-center text-sm text-gray-500">
            No custom methods yet. Add one above.
          </div>
        ) : methods.map(m => (
          <div key={m.id} className="flex items-center gap-3 border border-gray-800 rounded-lg px-4 py-3">
            {editId === m.id ? (
              <input
                autoFocus
                value={editName}
                onChange={e => setEditName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') void saveEdit(m); if (e.key === 'Escape') setEditId(null); }}
                onBlur={() => void saveEdit(m)}
                className="flex-1 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-white text-sm focus:outline-none focus:border-green-500"
              />
            ) : (
              <button
                onClick={() => { setEditId(m.id); setEditName(m.name); }}
                className={`flex-1 text-left text-sm ${m.is_active ? 'text-white' : 'text-gray-500 line-through'}`}
                title="Rename"
              >
                {m.name}
              </button>
            )}
            <span className="text-xs text-gray-600 font-mono">{m.code}</span>
            <button
              onClick={() => toggle(m)}
              className={`text-xs rounded-lg px-2.5 py-1 border transition-colors ${
                m.is_active
                  ? 'text-green-400 border-green-500/30 hover:border-green-500/60'
                  : 'text-gray-400 border-gray-600 hover:border-gray-400'
              }`}
            >
              {m.is_active ? 'Active' : 'Inactive'}
            </button>
            <button
              onClick={() => remove(m)}
              className="text-xs text-red-400 hover:text-red-300 border border-red-500/30 hover:border-red-500/60 rounded-lg px-2.5 py-1"
            >
              Delete
            </button>
          </div>
        ))}
      </div>

      <ConfirmModal state={confirmState} onClose={closeConfirm} />
    </div>
  );
}
