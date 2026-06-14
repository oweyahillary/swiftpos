import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import ConfirmModal, { useConfirm } from '../../components/ConfirmModal';

interface Supplier {
  id: string;
  name: string;
  contact_name: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  notes: string | null;
  status: 'active' | 'inactive';
  created_at: string;
}

const EMPTY: Omit<Supplier, 'id' | 'created_at'> = {
  name: '', contact_name: '', email: '', phone: '', address: '', notes: '', status: 'active',
};

export default function SuppliersPage() {
  const [confirmState, showConfirm, closeConfirm] = useConfirm();
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [loading, setLoading]     = useState(true);
  const [search, setSearch]       = useState('');
  const [modal, setModal]         = useState<'add' | Supplier | null>(null);
  const [form, setForm]           = useState<typeof EMPTY>(EMPTY);
  const [saving, setSaving]       = useState(false);
  const [error, setError]         = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const data = await api.get<Supplier[]>('/api/stock/suppliers');
      setSuppliers(data);
    } catch { /* silent */ } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const openAdd = () => { setForm(EMPTY); setError(''); setModal('add'); };
  const openEdit = (s: Supplier) => {
    setForm({ name: s.name, contact_name: s.contact_name ?? '', email: s.email ?? '',
              phone: s.phone ?? '', address: s.address ?? '', notes: s.notes ?? '', status: s.status });
    setError('');
    setModal(s);
  };

  const save = async () => {
    if (!form.name.trim()) { setError('Supplier name is required'); return; }
    setSaving(true); setError('');
    try {
      if (modal === 'add') {
        await api.post('/api/stock/suppliers', form);
      } else {
        await api.patch(`/api/stock/suppliers/${(modal as Supplier).id}`, form);
      }
      await load();
      setModal(null);
    } catch (e: any) {
      setError(e?.message ?? 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const deactivate = async (s: Supplier) => {
    showConfirm({
      title: `Deactivate "${s.name}"?`,
      message: "Purchase history and existing orders are preserved.",
      intent: 'warning',
      confirmLabel: 'Deactivate',
      onConfirm: async () => {
        await api.delete(`/api/stock/suppliers/${s.id}`);
        await load();
      },
    });
    // catch { /* silent */ }
  };

  const filtered = suppliers.filter(s =>
    s.name.toLowerCase().includes(search.toLowerCase()) ||
    (s.contact_name ?? '').toLowerCase().includes(search.toLowerCase()) ||
    (s.email ?? '').toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="flex-1 overflow-auto p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-white">Suppliers<span className="text-[10px] font-medium text-blue-400 bg-blue-500/10 border border-blue-500/20 rounded-full px-2 py-0.5 ml-2 align-middle">All branches</span></h1>
          <p className="text-gray-500 text-sm mt-0.5">{suppliers.filter(s => s.status === 'active').length} active suppliers</p>
        </div>
        <button
          onClick={openAdd}
          className="flex items-center gap-2 bg-green-500 hover:bg-green-400 text-black font-semibold text-sm px-4 py-2 rounded-lg transition-colors"
        >
          + Add Supplier
        </button>
      </div>

      {/* Search */}
      <div className="mb-4">
        <input
          type="text"
          placeholder="Search suppliers…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="w-full max-w-sm bg-gray-900 border border-gray-800 text-white text-sm rounded-lg px-3 py-2 outline-none focus:border-green-500"
        />
      </div>

      {/* Table */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        {loading ? (
          <div className="p-12 text-center text-gray-500 text-sm">Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="p-12 text-center">
            <p className="text-3xl mb-3">🏭</p>
            <p className="text-white font-medium mb-1">{search ? 'No results' : 'No suppliers yet'}</p>
            <p className="text-gray-500 text-sm">{search ? 'Try a different search' : 'Add your first supplier to get started'}</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800 text-gray-500 text-xs uppercase tracking-wide">
                <th className="text-left px-5 py-3">Supplier</th>
                <th className="text-left px-5 py-3">Contact</th>
                <th className="text-left px-5 py-3">Email</th>
                <th className="text-left px-5 py-3">Phone</th>
                <th className="text-left px-5 py-3">Status</th>
                <th className="px-5 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(s => (
                <tr key={s.id} className="border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors">
                  <td className="px-5 py-3.5">
                    <span className="text-white font-medium">{s.name}</span>
                    {s.address && <p className="text-gray-500 text-xs mt-0.5 truncate max-w-xs">{s.address}</p>}
                  </td>
                  <td className="px-5 py-3.5 text-gray-300">{s.contact_name ?? '—'}</td>
                  <td className="px-5 py-3.5 text-gray-300">{s.email ?? '—'}</td>
                  <td className="px-5 py-3.5 text-gray-300">{s.phone ?? '—'}</td>
                  <td className="px-5 py-3.5">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                      s.status === 'active' ? 'bg-green-500/10 text-green-400' : 'bg-gray-700 text-gray-400'
                    }`}>
                      {s.status}
                    </span>
                  </td>
                  <td className="px-5 py-3.5">
                    <div className="flex items-center gap-2 justify-end">
                      <button
                        onClick={() => openEdit(s)}
                        className="text-gray-500 hover:text-white text-xs px-2 py-1 rounded hover:bg-gray-800 transition-colors"
                      >
                        Edit
                      </button>
                      {s.status === 'active' && (
                        <button
                          onClick={() => deactivate(s)}
                          className="text-gray-500 hover:text-red-400 text-xs px-2 py-1 rounded hover:bg-gray-800 transition-colors"
                        >
                          Deactivate
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Modal */}
      {modal && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-800 rounded-2xl w-full max-w-md max-h-[90vh] overflow-auto">
            <div className="flex items-center justify-between px-6 py-5 border-b border-gray-800">
              <h2 className="text-white font-semibold text-base">
                {modal === 'add' ? 'Add Supplier' : 'Edit Supplier'}
              </h2>
              <button onClick={() => setModal(null)} className="text-gray-500 hover:text-white text-lg">✕</button>
            </div>

            <div className="px-6 py-5 space-y-4">
              <div>
                <label className="block text-xs text-gray-500 uppercase tracking-wide mb-1.5">Name *</label>
                <input
                  className="w-full bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-3 py-2.5 outline-none focus:border-green-500"
                  value={form.name}
                  onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="e.g. Naivas Distributors"
                  autoFocus
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-gray-500 uppercase tracking-wide mb-1.5">Contact Name</label>
                  <input
                    className="w-full bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-3 py-2.5 outline-none focus:border-green-500"
                    value={form.contact_name ?? ''}
                    onChange={e => setForm(f => ({ ...f, contact_name: e.target.value }))}
                    placeholder="John Doe"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 uppercase tracking-wide mb-1.5">Phone</label>
                  <input
                    className="w-full bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-3 py-2.5 outline-none focus:border-green-500"
                    value={form.phone ?? ''}
                    onChange={e => setForm(f => ({ ...f, phone: e.target.value }))}
                    placeholder="+254…"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs text-gray-500 uppercase tracking-wide mb-1.5">Email</label>
                <input
                  type="email"
                  className="w-full bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-3 py-2.5 outline-none focus:border-green-500"
                  value={form.email ?? ''}
                  onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                  placeholder="supplier@example.com"
                />
              </div>

              <div>
                <label className="block text-xs text-gray-500 uppercase tracking-wide mb-1.5">Address</label>
                <input
                  className="w-full bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-3 py-2.5 outline-none focus:border-green-500"
                  value={form.address ?? ''}
                  onChange={e => setForm(f => ({ ...f, address: e.target.value }))}
                  placeholder="Nairobi, Kenya"
                />
              </div>

              <div>
                <label className="block text-xs text-gray-500 uppercase tracking-wide mb-1.5">Notes</label>
                <textarea
                  className="w-full bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-3 py-2.5 outline-none focus:border-green-500 resize-none"
                  value={form.notes ?? ''}
                  onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                  rows={2}
                  placeholder="Payment terms, delivery schedule…"
                />
              </div>

              {modal !== 'add' && (
                <div>
                  <label className="block text-xs text-gray-500 uppercase tracking-wide mb-1.5">Status</label>
                  <select
                    className="w-full bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-3 py-2.5 outline-none focus:border-green-500"
                    value={form.status}
                    onChange={e => setForm(f => ({ ...f, status: e.target.value as 'active' | 'inactive' }))}
                  >
                    <option value="active">Active</option>
                    <option value="inactive">Inactive</option>
                  </select>
                </div>
              )}

              {error && <p className="text-red-400 text-sm">{error}</p>}
            </div>

            <div className="flex gap-3 px-6 pb-6">
              <button
                onClick={() => setModal(null)}
                className="flex-1 bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm font-medium py-2.5 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={save}
                disabled={saving}
                className="flex-1 bg-green-500 hover:bg-green-400 disabled:opacity-50 text-black font-semibold text-sm py-2.5 rounded-lg transition-colors"
              >
                {saving ? 'Saving…' : modal === 'add' ? 'Add Supplier' : 'Save Changes'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
      <ConfirmModal state={confirmState} onClose={closeConfirm} />
  );
}
