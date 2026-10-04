import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import ConfirmModal, { useConfirm } from '../../components/ConfirmModal';
import SupplierAccount from '../../components/SupplierAccount';   // A395
import { usePermissions } from '../../context/PermissionsContext';
import { useBusiness } from '../../context/BusinessContext';
import { useBranch } from '../../context/BranchContext';

// A395: what is owed to each supplier (only for someone holding payables.manage — the owner by default).
interface Position { id: string; balance: number; overdue: number; dueSoon: number; openBills: number }
interface Summary { owed: number; overdue: number; dueSoon: number; suppliers: Position[] }

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
  const { can } = usePermissions();
  const canPay = can('payables.manage');
  const { business } = useBusiness();
  const { branches } = useBranch();
  const currency = (business as { currency?: string } | null)?.currency || 'KES';
  const [summary, setSummary]     = useState<Summary | null>(null);
  const [account, setAccount]     = useState<string | null>(null);
  const owedOf = (id: string) => summary?.suppliers.find(p => p.id === id);
  const money = (n: number) => `${currency} ${n.toLocaleString('en-KE', { maximumFractionDigits: 2 })}`;

  const load = async () => {
    setLoading(true);
    try {
      const data = await api.get<Supplier[]>('/api/stock/suppliers');
      setSuppliers(data);
      if (canPay) setSummary(await api.get<Summary>('/api/payables/summary').catch(() => null));
    } catch { /* silent */ } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [canPay]);   // eslint-disable-line react-hooks/exhaustive-deps

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

  if (account) {
    return (
      <div className="flex-1 overflow-auto p-4 sm:p-6">
        <SupplierAccount supplierId={account} currency={currency} business={business}
          branches={branches.map(b => ({ id: b.id, name: b.name }))} onClose={() => { setAccount(null); load(); }} />
      </div>
    );
  }

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
          className="flex items-center gap-2 bg-swift hover:bg-swift-light text-black font-semibold text-sm px-4 py-2 rounded-lg transition-colors"
        >
          + Add Supplier
        </button>
      </div>

      {/* A395: what is owed, at a glance */}
      {canPay && summary && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-5" data-testid="payables-summary">
          {[
            { label: 'You owe suppliers', value: money(summary.owed), cls: 'text-white' },
            { label: 'Overdue', value: money(summary.overdue), cls: summary.overdue > 0 ? 'text-red-400' : 'text-gray-400' },
            { label: 'Due in the next 7 days', value: money(summary.dueSoon), cls: summary.dueSoon > 0 ? 'text-amber-400' : 'text-gray-400' },
          ].map(c => (
            <div key={c.label} className="bg-gray-900 border border-gray-800 rounded-xl p-4">
              <p className="text-gray-500 text-xs">{c.label}</p>
              <p className={`text-xl font-semibold mt-1 ${c.cls}`}>{c.value}</p>
            </div>
          ))}
        </div>
      )}

      {/* Search */}
      <div className="mb-4">
        <input
          type="text"
          placeholder="Search suppliers…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="w-full max-w-sm bg-gray-900 border border-gray-800 text-white text-sm rounded-lg px-3 py-2 outline-none focus:border-swift"
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
                {canPay && <th className="text-right px-5 py-3">Owed</th>}
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
                  {canPay && (() => {
                    const o = owedOf(s.id);
                    return (
                      <td className="px-5 py-3.5 text-right whitespace-nowrap">
                        <span className={o && o.balance > 0 ? 'text-white' : 'text-gray-500'}>{o ? money(o.balance) : '—'}</span>
                        {o && o.overdue > 0 && <p className="text-red-400 text-xs mt-0.5">{money(o.overdue)} overdue</p>}
                      </td>
                    );
                  })()}
                  <td className="px-5 py-3.5">
                    <div className="flex items-center gap-2 justify-end">
                      {canPay && (
                        <button
                          onClick={() => setAccount(s.id)}
                          className="text-swift-text hover:text-white text-xs px-2 py-1 rounded hover:bg-gray-800 transition-colors"
                        >
                          Account
                        </button>
                      )}
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
                  className="w-full bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-3 py-2.5 outline-none focus:border-swift"
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
                    className="w-full bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-3 py-2.5 outline-none focus:border-swift"
                    value={form.contact_name ?? ''}
                    onChange={e => setForm(f => ({ ...f, contact_name: e.target.value }))}
                    placeholder="John Doe"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 uppercase tracking-wide mb-1.5">Phone</label>
                  <input
                    className="w-full bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-3 py-2.5 outline-none focus:border-swift"
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
                  className="w-full bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-3 py-2.5 outline-none focus:border-swift"
                  value={form.email ?? ''}
                  onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                  placeholder="supplier@example.com"
                />
              </div>

              <div>
                <label className="block text-xs text-gray-500 uppercase tracking-wide mb-1.5">Address</label>
                <input
                  className="w-full bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-3 py-2.5 outline-none focus:border-swift"
                  value={form.address ?? ''}
                  onChange={e => setForm(f => ({ ...f, address: e.target.value }))}
                  placeholder="Nairobi, Kenya"
                />
              </div>

              <div>
                <label className="block text-xs text-gray-500 uppercase tracking-wide mb-1.5">Notes</label>
                <textarea
                  className="w-full bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-3 py-2.5 outline-none focus:border-swift resize-none"
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
                    className="w-full bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-3 py-2.5 outline-none focus:border-swift"
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
                className="flex-1 bg-swift hover:bg-swift-light disabled:opacity-50 text-black font-semibold text-sm py-2.5 rounded-lg transition-colors"
              >
                {saving ? 'Saving…' : modal === 'add' ? 'Add Supplier' : 'Save Changes'}
              </button>
            </div>
          </div>
        </div>
      )}
      <ConfirmModal state={confirmState} onClose={closeConfirm} />
    </div>
  );
}
