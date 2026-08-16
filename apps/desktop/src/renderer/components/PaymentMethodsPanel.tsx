import { useEffect, useState, useCallback } from 'react';
import { posApi } from '../lib/posApi';

// Manage custom payment methods from the till (A97) — the same list the dashboard
// edits, per business. Cash / M-Pesa / Card are always available and not shown
// here. Requires a connection (writes go to the server); once saved, the method
// is cached locally and appears as a tender on this till right away.
interface PaymentMethod { id: string; name: string; code: string; is_active: boolean; sort_order: number }

export default function PaymentMethodsPanel({ canEdit = true }: { canEdit?: boolean }) {
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try { setMethods(await posApi.manage.listPaymentMethods()); }
    catch (e: any) { setError(e?.message ?? 'Could not load payment methods (are you online?)'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const add = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy('new'); setError('');
    try { await posApi.manage.createPaymentMethod({ name: trimmed, sort_order: methods.length }); setName(''); await load(); }
    catch (e: any) { setError(e?.message ?? 'Could not add'); }
    finally { setBusy(''); }
  };

  const toggle = async (m: PaymentMethod) => {
    setMethods(prev => prev.map(x => x.id === m.id ? { ...x, is_active: !x.is_active } : x));
    try { await posApi.manage.updatePaymentMethod(m.id, { is_active: !m.is_active }); }
    catch (e: any) { setError(e?.message ?? 'Could not update'); await load(); }
  };

  const remove = async (m: PaymentMethod) => {
    setBusy(m.id);
    try { await posApi.manage.deletePaymentMethod(m.id); await load(); }
    catch (e: any) { setError(e?.message ?? 'Could not delete'); }
    finally { setBusy(''); }
  };

  return (
    <div className="max-w-xl">
      <h2 className="text-lg font-semibold text-white">Payment methods</h2>
      <p className="text-sm text-gray-400 mt-1">
        Cash, M-Pesa and Card are always available. Add any other tenders you accept
        (e.g. Coop Card) — they appear at the POS and in reports. All are non-cash.
      </p>
      {error && <p className="text-red-400 text-sm mt-3">{error}</p>}

      {canEdit && (
        <div className="mt-5 flex gap-2">
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') void add(); }}
            placeholder="e.g. Coop Card"
            className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-green-500"
          />
          <button
            onClick={add}
            disabled={busy === 'new' || !name.trim()}
            className="bg-green-500 hover:bg-green-400 disabled:opacity-40 text-gray-950 font-semibold px-4 py-2 rounded-lg text-sm"
          >
            {busy === 'new' ? 'Adding…' : 'Add'}
          </button>
        </div>
      )}

      <div className="mt-5 space-y-2">
        {loading ? (
          <p className="text-sm text-gray-500">Loading…</p>
        ) : methods.length === 0 ? (
          <div className="border border-gray-800 rounded-lg p-6 text-center text-sm text-gray-500">
            No custom methods yet.
          </div>
        ) : methods.map(m => (
          <div key={m.id} className="flex items-center gap-3 border border-gray-800 rounded-lg px-4 py-3">
            <span className={`flex-1 text-sm ${m.is_active ? 'text-white' : 'text-gray-500 line-through'}`}>{m.name}</span>
            <span className="text-xs text-gray-600 font-mono">{m.code}</span>
            {canEdit && (
              <>
                <button
                  onClick={() => toggle(m)}
                  className={`text-xs rounded-lg px-2.5 py-1 border transition-colors ${
                    m.is_active ? 'text-green-400 border-green-500/30 hover:border-green-500/60'
                                : 'text-gray-400 border-gray-600 hover:border-gray-400'}`}
                >
                  {m.is_active ? 'Active' : 'Inactive'}
                </button>
                <button
                  onClick={() => remove(m)}
                  disabled={busy === m.id}
                  className="text-xs text-red-400 hover:text-red-300 border border-red-500/30 hover:border-red-500/60 rounded-lg px-2.5 py-1 disabled:opacity-40"
                >
                  Delete
                </button>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
