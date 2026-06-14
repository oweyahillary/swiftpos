import { useEffect, useState, useRef, useCallback } from 'react';
import { api } from '../../lib/api';

// ── Types ─────────────────────────────────────────────────────
interface Customer {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  loyalty_points: number;
  total_spent: number;
  visit_count: number;
  notes: string | null;
  status: 'active' | 'inactive';
  created_at: string;
  updated_at?: string;
}

interface Tier {
  name: string;
  multiplier: number;
  next: number | null;
}

interface CustomerWithTier extends Customer {
  tier: Tier;
}

interface Transaction {
  id: string;
  type: 'earn' | 'redeem' | 'adjust';
  points: number;
  notes: string | null;
  created_at: string;
  order_id: string | null;
}

interface Props {
  currency: string;
}

// ── Constants ─────────────────────────────────────────────────
const TIER_COLORS: Record<string, string> = {
  Bronze: 'text-amber-500',
  Silver: 'text-gray-400',
  Gold:   'text-yellow-400',
};

const TIER_BG: Record<string, string> = {
  Bronze: 'bg-amber-500/10 border-amber-500/20',
  Silver: 'bg-gray-400/10 border-gray-500/20',
  Gold:   'bg-yellow-400/10 border-yellow-500/20',
};

const TIER_BAR: Record<string, string> = {
  Bronze: 'bg-amber-500',
  Silver: 'bg-gray-400',
  Gold:   'bg-yellow-400',
};


// ── RFM Segmentation ─────────────────────────────────────────────────────────
// Recency  = days since updated_at (proxy for last order — updated on every loyalty earn)
// Frequency = visit_count
// Monetary  = total_spent

type Segment = 'loyal' | 'new' | 'at_risk' | 'lost' | 'occasional';

interface SegmentConfig {
  label: string;
  color: string;
  bg: string;
  desc: string;
}

const SEGMENTS: Record<Segment, SegmentConfig> = {
  loyal:      { label: 'Loyal',      color: '#16a34a', bg: '#EAF3DE', desc: 'Frequent, recent, high spend' },
  new:        { label: 'New',        color: '#2563eb', bg: '#E6F1FB', desc: 'Joined recently, low visits' },
  at_risk:    { label: 'At Risk',    color: '#d97706', bg: '#FAEEDA', desc: 'Was regular, not seen lately' },
  lost:       { label: 'Lost',       color: '#dc2626', bg: '#FCEBEB', desc: 'No visits in 60+ days' },
  occasional: { label: 'Occasional', color: '#7c3aed', bg: '#EEEDFE', desc: 'Irregular visits' },
};

function getSegment(customer: Customer): Segment {
  const daysSinceActivity = (Date.now() - new Date(customer.updated_at ?? customer.created_at).getTime()) / 86_400_000;
  const freq  = customer.visit_count;
  const spend = customer.total_spent;

  if (freq <= 1) return 'new';
  if (daysSinceActivity > 60 && freq >= 3) return 'lost';
  if (daysSinceActivity > 30 && freq >= 3) return 'at_risk';
  if (freq >= 5 && spend > 0 && daysSinceActivity <= 30) return 'loyal';
  return 'occasional';
}

function SegmentBadge({ segment }: { segment: Segment }) {
  const cfg = SEGMENTS[segment];
  return (
    <span className="inline-flex items-center text-[10px] font-semibold px-2 py-0.5 rounded-full"
      style={{ color: cfg.color, background: cfg.bg }}>
      {cfg.label}
    </span>
  );
}

function tierProgress(points: number, tier: Tier): number {
  if (!tier.next) return 100;
  const start = tier.name === 'Bronze' ? 0 : tier.name === 'Silver' ? 1000 : 5000;
  return Math.min(100, Math.round(((points - start) / (tier.next - start)) * 100));
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-KE', { day: '2-digit', month: 'short', year: 'numeric' });
}

// ── Sub-components ────────────────────────────────────────────

function TierBadge({ tier }: { tier: Tier }) {
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full border ${TIER_BG[tier.name]} ${TIER_COLORS[tier.name]}`}>
      {tier.name === 'Gold' ? '★' : tier.name === 'Silver' ? '◆' : '●'} {tier.name}
    </span>
  );
}

function StatusBadge({ status }: { status: 'active' | 'inactive' }) {
  return (
    <span className={`inline-flex items-center text-xs font-medium px-2 py-0.5 rounded-full ${
      status === 'active'
        ? 'bg-green-500/10 text-green-400 border border-green-500/20'
        : 'bg-gray-700/40 text-gray-500 border border-gray-700'
    }`}>
      {status}
    </span>
  );
}

// ── Profile Drawer ────────────────────────────────────────────
interface DrawerProps {
  customer: CustomerWithTier;
  currency: string;
  onClose: () => void;
  onUpdated: (c: CustomerWithTier) => void;
  onDeactivated: (id: string) => void;
}

function CustomerDrawer({ customer, currency, onClose, onUpdated, onDeactivated }: DrawerProps) {
  const [editing, setEditing]       = useState(false);
  const [saving, setSaving]         = useState(false);
  const [deactivating, setDeact]    = useState(false);
  const [confirmDeact, setConfirm]  = useState(false);
  const [error, setError]           = useState('');
  const [txns, setTxns]             = useState<Transaction[]>([]);
  const [txnsLoading, setTxnsLoad]  = useState(true);

  const [form, setForm] = useState({
    name:  customer.name,
    phone: customer.phone,
    email: customer.email ?? '',
    notes: customer.notes ?? '',
  });

  // Load transactions
  useEffect(() => {
    setTxnsLoad(true);
    api.get<{ transactions: Transaction[] }>(`/api/loyalty/customer/${customer.id}/transactions`)
      .then(r => setTxns(r.transactions))
      .catch(() => setTxns([]))
      .finally(() => setTxnsLoad(false));
  }, [customer.id]);

  const handleSave = async () => {
    setSaving(true);
    setError('');
    try {
      const { customer: updated, tier } = await api.patch<{ customer: Customer; tier: Tier }>(
        `/api/loyalty/customer/${customer.id}`,
        {
          name:  form.name.trim(),
          phone: form.phone.trim(),
          email: form.email.trim() || null,
          notes: form.notes.trim() || null,
        }
      );
      onUpdated({ ...updated, tier });
      setEditing(false);
    } catch (e: any) {
      setError(e.message ?? 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const handleDeactivate = async () => {
    setDeact(true);
    try {
      await api.delete(`/api/loyalty/customer/${customer.id}`);
      onDeactivated(customer.id);
      onClose();
    } catch (e: any) {
      setError(e.message ?? 'Failed to deactivate');
      setDeact(false);
      setConfirm(false);
    }
  };

  const progress = tierProgress(customer.loyalty_points, customer.tier);

  return (
    <div className="fixed inset-0 z-50 flex">
      {/* Backdrop */}
      <div className="flex-1 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      {/* Panel */}
      <div className="w-full max-w-md bg-gray-950 border-l border-gray-800 flex flex-col h-full overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800 flex-shrink-0">
          <h2 className="text-white font-semibold text-base">Customer Profile</h2>
          <div className="flex items-center gap-3">
            {!editing && (
              <button
                onClick={() => setEditing(true)}
                className="text-xs text-gray-400 hover:text-white transition-colors border border-gray-700 hover:border-gray-500 px-3 py-1.5 rounded-lg"
              >
                Edit
              </button>
            )}
            <button onClick={onClose} className="text-gray-500 hover:text-white transition-colors text-lg leading-none">✕</button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {/* Identity block */}
          <div className="px-5 py-4 border-b border-gray-800/60 space-y-4">
            {editing ? (
              <div className="space-y-3">
                {[
                  { label: 'Name', key: 'name', type: 'text', placeholder: 'Full name' },
                  { label: 'Phone', key: 'phone', type: 'tel', placeholder: '07xx xxx xxx' },
                  { label: 'Email', key: 'email', type: 'email', placeholder: 'Optional' },
                  { label: 'Notes', key: 'notes', type: 'text', placeholder: 'Optional internal notes' },
                ].map(f => (
                  <div key={f.key}>
                    <label className="block text-xs text-gray-500 mb-1">{f.label}</label>
                    <input
                      type={f.type}
                      value={form[f.key as keyof typeof form]}
                      onChange={e => setForm(prev => ({ ...prev, [f.key]: e.target.value }))}
                      placeholder={f.placeholder}
                      className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-green-500 transition-colors"
                    />
                  </div>
                ))}
                {error && <p className="text-red-400 text-xs">{error}</p>}
                <div className="flex gap-2 pt-1">
                  <button
                    onClick={handleSave}
                    disabled={saving || !form.name.trim() || !form.phone.trim()}
                    className="flex-1 py-2 bg-green-500 hover:bg-green-400 disabled:opacity-40 text-gray-950 text-sm font-bold rounded-lg transition-colors"
                  >
                    {saving ? 'Saving…' : 'Save changes'}
                  </button>
                  <button
                    onClick={() => { setEditing(false); setError(''); }}
                    className="px-4 py-2 border border-gray-700 text-gray-400 hover:text-white text-sm rounded-lg transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-1">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-white text-lg font-semibold">{customer.name}</p>
                    <p className="text-gray-400 text-sm">{customer.phone}</p>
                    {customer.email && <p className="text-gray-500 text-sm">{customer.email}</p>}
                  </div>
                  <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
                    <TierBadge tier={customer.tier} />
                    <StatusBadge status={customer.status} />
                  </div>
                </div>
                {customer.notes && (
                  <p className="text-gray-500 text-xs mt-2 bg-gray-900/60 rounded-lg px-3 py-2 italic">
                    {customer.notes}
                  </p>
                )}
                <p className="text-gray-600 text-xs pt-1">Member since {fmtDate(customer.created_at)}</p>
              </div>
            )}
          </div>

          {/* Stats row */}
          <div className="px-5 py-4 border-b border-gray-800/60">
            <div className="grid grid-cols-3 gap-3">
              {[
                { label: 'Points', value: customer.loyalty_points.toLocaleString(), color: TIER_COLORS[customer.tier.name] },
                { label: 'Total Spent', value: `${currency} ${Number(customer.total_spent).toLocaleString()}`, color: 'text-white' },
                { label: 'Visits', value: customer.visit_count.toString(), color: 'text-white' },
              ].map(s => (
                <div key={s.label} className="bg-gray-900/60 rounded-xl px-3 py-3 text-center">
                  <p className={`text-base font-bold ${s.color}`}>{s.value}</p>
                  <p className="text-gray-500 text-xs mt-0.5">{s.label}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Tier progress */}
          <div className="px-5 py-4 border-b border-gray-800/60">
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs text-gray-400 font-medium">Tier progress</p>
              {customer.tier.next ? (
                <p className="text-xs text-gray-500">
                  {(customer.tier.next - customer.loyalty_points).toLocaleString()} pts to {customer.tier.name === 'Bronze' ? 'Silver' : 'Gold'}
                </p>
              ) : (
                <p className={`text-xs font-semibold ${TIER_COLORS.Gold}`}>Max tier reached ★</p>
              )}
            </div>
            <div className="h-2 bg-gray-800 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-500 ${TIER_BAR[customer.tier.name]}`}
                style={{ width: `${progress}%` }}
              />
            </div>
            <div className="flex justify-between mt-1">
              <span className="text-gray-600 text-xs">{customer.tier.name}</span>
              {customer.tier.next && (
                <span className="text-gray-600 text-xs">{customer.tier.name === 'Bronze' ? 'Silver' : 'Gold'}</span>
              )}
            </div>
          </div>

          {/* Transaction history */}
          <div className="px-5 py-4">
            <p className="text-xs text-gray-400 font-medium mb-3">Recent transactions</p>
            {txnsLoading ? (
              <div className="space-y-2">
                {[1, 2, 3].map(i => (
                  <div key={i} className="h-10 bg-gray-800/40 rounded-lg animate-pulse" />
                ))}
              </div>
            ) : txns.length === 0 ? (
              <p className="text-gray-600 text-sm text-center py-6">No transactions yet</p>
            ) : (
              <div className="space-y-2">
                {txns.map(t => (
                  <div key={t.id} className="flex items-center justify-between bg-gray-900/50 rounded-lg px-3 py-2.5">
                    <div>
                      <p className="text-white text-xs font-medium capitalize">{t.type}</p>
                      {t.notes && <p className="text-gray-500 text-xs">{t.notes}</p>}
                      <p className="text-gray-600 text-xs">{fmtDate(t.created_at)}</p>
                    </div>
                    <span className={`text-sm font-bold ${t.points > 0 ? 'text-green-400' : 'text-red-400'}`}>
                      {t.points > 0 ? '+' : ''}{t.points} pts
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Footer — deactivate */}
        {customer.status === 'active' && (
          <div className="px-5 py-4 border-t border-gray-800 flex-shrink-0">
            {confirmDeact ? (
              <div className="space-y-2">
                <p className="text-sm text-gray-300">Deactivate <span className="font-semibold text-white">{customer.name}</span>? Their order history is kept.</p>
                <div className="flex gap-2">
                  <button
                    onClick={handleDeactivate}
                    disabled={deactivating}
                    className="flex-1 py-2 bg-red-500/10 hover:bg-red-500/20 border border-red-500/30 text-red-400 text-sm font-semibold rounded-lg transition-colors"
                  >
                    {deactivating ? 'Deactivating…' : 'Yes, deactivate'}
                  </button>
                  <button
                    onClick={() => setConfirm(false)}
                    className="px-4 py-2 border border-gray-700 text-gray-400 hover:text-white text-sm rounded-lg transition-colors"
                  >
                    Cancel
                  </button>
                </div>
                {error && <p className="text-red-400 text-xs">{error}</p>}
              </div>
            ) : (
              <button
                onClick={() => setConfirm(true)}
                className="w-full py-2 text-gray-500 hover:text-red-400 text-sm transition-colors border border-transparent hover:border-red-500/20 rounded-lg"
              >
                Deactivate customer
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────
export default function CustomersPage({ currency }: Props) {
  const [customers, setCustomers]   = useState<CustomerWithTier[]>([]);
  const [loading, setLoading]       = useState(true);
  const [search, setSearch]         = useState('');
  const [page, setPage]             = useState(1);
  const [total, setTotal]           = useState(0);
  const [selected, setSelected]     = useState<CustomerWithTier | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState({ name: '', phone: '', email: '', notes: '' });
  const [segmentFilter, setSegmentFilter] = useState<Segment | 'all'>('all');
  const [creating, setCreating]     = useState(false);
  const [createError, setCreateError] = useState('');

  const LIMIT = 20;
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchCustomers = useCallback(async (q: string, p: number) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(p), limit: String(LIMIT) });
      if (q) params.set('search', q);
      const { customers: data, total: t } = await api.get<{ customers: CustomerWithTier[]; total: number }>(
        `/api/loyalty/customers?${params}`
      );
      setCustomers(data);
      setTotal(t);
    } catch {
      setCustomers([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load
  useEffect(() => { fetchCustomers('', 1); }, [fetchCustomers]);

  // Debounced search
  const handleSearch = (val: string) => {
    setSearch(val);
    setPage(1);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => fetchCustomers(val, 1), 350);
  };

  const handlePageChange = (p: number) => {
    setPage(p);
    fetchCustomers(search, p);
  };

  const handleUpdated = (updated: CustomerWithTier) => {
    setCustomers(prev => prev.map(c => c.id === updated.id ? updated : c));
    setSelected(updated);
  };

  const handleDeactivated = (id: string) => {
    setCustomers(prev => prev.map(c => c.id === id ? { ...c, status: 'inactive' as const } : c));
  };

  const handleCreate = async () => {
    setCreating(true);
    setCreateError('');
    try {
      const { customer, tier } = await api.post<{ customer: Customer; tier: Tier }>(
        '/api/loyalty/customer',
        {
          name:  createForm.name.trim(),
          phone: createForm.phone.trim(),
          email: createForm.email.trim() || null,
          notes: createForm.notes.trim() || null,
        }
      );
      const newCustomer: CustomerWithTier = { ...customer, tier };
      setCustomers(prev => [newCustomer, ...prev]);
      setTotal(t => t + 1);
      setShowCreate(false);
      setCreateForm({ name: '', phone: '', email: '', notes: '' });
      setSelected(newCustomer);
    } catch (e: any) {
      setCreateError(e.message ?? 'Failed to create customer');
    } finally {
      setCreating(false);
    }
  };

  const totalPages = Math.ceil(total / LIMIT);

  // RFM segment computation (client-side — no extra API call)
  const withSegment = customers.map(c => ({ ...c, segment: getSegment(c) }));
  const segmentCounts = (Object.keys(SEGMENTS) as Segment[]).reduce((acc, s) => {
    acc[s] = withSegment.filter(c => c.segment === s).length;
    return acc;
  }, {} as Record<Segment, number>);
  const displayList = withSegment.filter(c =>
    segmentFilter === 'all' || c.segment === segmentFilter
  );

  return (
    <div className="flex flex-col h-full bg-gray-950">
      {/* Toolbar */}
      <div className="px-5 pt-4 pb-1 flex-shrink-0">
        <h1 className="text-xl font-bold text-white">Customers<span className="text-[10px] font-medium text-blue-400 bg-blue-500/10 border border-blue-500/20 rounded-full px-2 py-0.5 ml-2 align-middle">All branches</span></h1>
      </div>
      {/* Segment filter bar */}
      <div className="flex flex-wrap gap-2 px-5 pt-3 pb-2 flex-shrink-0">
        <button
          onClick={() => setSegmentFilter('all')}
          className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${segmentFilter === 'all' ? 'bg-gray-700 text-white border-gray-600' : 'border-gray-700 text-gray-500 hover:border-gray-500 hover:text-gray-300'}`}>
          All ({customers.length})
        </button>
        {(Object.keys(SEGMENTS) as Segment[]).map(s => {
          const cfg = SEGMENTS[s];
          const count = segmentCounts[s] ?? 0;
          return (
            <button key={s}
              onClick={() => setSegmentFilter(s === segmentFilter ? 'all' : s)}
              className="text-xs px-3 py-1.5 rounded-full border transition-colors"
              style={segmentFilter === s
                ? { background: cfg.color, borderColor: cfg.color, color: '#fff' }
                : { borderColor: '#374151', color: '#9ca3af' }}>
              {cfg.label} ({count})
            </button>
          );
        })}
      </div>

      <div className="flex items-center gap-3 px-5 py-3 border-b border-gray-800 flex-shrink-0">
        <div className="flex-1 relative">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 text-sm">🔍</span>
          <input
            type="text"
            value={search}
            onChange={e => handleSearch(e.target.value)}
            placeholder="Search by name or phone…"
            className="w-full bg-gray-900 border border-gray-700 rounded-lg pl-8 pr-4 py-2 text-white placeholder-gray-600 text-sm focus:outline-none focus:border-green-500 transition-colors"
          />
        </div>
        <button
          onClick={() => { setShowCreate(true); setCreateError(''); }}
          className="flex items-center gap-2 px-4 py-2 bg-green-500 hover:bg-green-400 text-gray-950 text-sm font-bold rounded-lg transition-colors flex-shrink-0"
        >
          <span>+</span> New Customer
        </button>
      </div>

      {/* Stats strip */}
      <div className="px-5 py-2.5 border-b border-gray-800/50 flex items-center gap-2 flex-shrink-0">
        <span className="text-gray-500 text-xs">
          {loading ? '—' : `${total.toLocaleString()} customer${total !== 1 ? 's' : ''}`}
          {search && ` matching "${search}"`}
        </span>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="space-y-px p-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="h-14 bg-gray-800/30 rounded-lg animate-pulse mb-2" />
            ))}
          </div>
        ) : customers.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center py-20 px-6">
            <p className="text-4xl mb-3">👥</p>
            <p className="text-white text-base font-medium mb-1">
              {search ? 'No customers found' : 'No customers yet'}
            </p>
            <p className="text-gray-500 text-sm">
              {search ? 'Try a different name or phone number' : 'Add your first loyalty customer to get started'}
            </p>
          </div>
        ) : (
          <>
            {/* Header row */}
            <div className="grid grid-cols-[2fr_1fr_1fr_1fr_1fr_80px] gap-4 px-5 py-2.5 border-b border-gray-800/60 sticky top-0 bg-gray-950 z-10">
              {['Customer', 'Tier', 'Points', 'Total Spent', 'Visits', 'Status'].map(h => (
                <span key={h} className="text-gray-500 text-xs font-medium uppercase tracking-wide">{h}</span>
              ))}
            </div>

            {/* Rows */}
            {displayList.map(c => (
              <button
                key={c.id}
                onClick={() => setSelected(c)}
                className="w-full grid grid-cols-[2fr_1fr_1fr_1fr_1fr_80px] gap-4 px-5 py-3.5 border-b border-gray-800/40 hover:bg-gray-800/30 transition-colors text-left group"
              >
                <div>
                  <p className="text-white text-sm font-medium group-hover:text-green-400 transition-colors truncate">{c.name}</p>
                  <p className="text-gray-500 text-xs">{c.phone}</p>
                </div>
                <div className="flex items-center">
                  <TierBadge tier={c.tier} />
                </div>
                <div className="flex items-center">
                  <span className={`text-sm font-semibold ${TIER_COLORS[c.tier.name]}`}>
                    {c.loyalty_points.toLocaleString()}
                  </span>
                </div>
                <div className="flex items-center">
                  <span className="text-white text-sm">{currency} {Number(c.total_spent).toLocaleString()}</span>
                </div>
                <div className="flex items-center">
                  <span className="text-white text-sm">{c.visit_count}</span>
                </div>
                <div className="flex items-center">
                  <StatusBadge status={c.status} />
                </div>
              </button>
            ))}
          </>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between px-5 py-3 border-t border-gray-800 flex-shrink-0">
          <span className="text-gray-500 text-xs">
            Page {page} of {totalPages}
          </span>
          <div className="flex gap-2">
            <button
              onClick={() => handlePageChange(page - 1)}
              disabled={page === 1}
              className="px-3 py-1.5 text-sm border border-gray-700 text-gray-400 hover:text-white disabled:opacity-30 rounded-lg transition-colors"
            >
              ← Prev
            </button>
            <button
              onClick={() => handlePageChange(page + 1)}
              disabled={page === totalPages}
              className="px-3 py-1.5 text-sm border border-gray-700 text-gray-400 hover:text-white disabled:opacity-30 rounded-lg transition-colors"
            >
              Next →
            </button>
          </div>
        </div>
      )}

      {/* Create customer modal */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm px-4">
          <div className="bg-gray-950 border border-gray-800 rounded-2xl w-full max-w-sm p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-white font-semibold">New Customer</h3>
              <button onClick={() => setShowCreate(false)} className="text-gray-500 hover:text-white transition-colors">✕</button>
            </div>
            <div className="space-y-3">
              {[
                { label: 'Name *', key: 'name', type: 'text', placeholder: 'Full name' },
                { label: 'Phone *', key: 'phone', type: 'tel', placeholder: '07xx xxx xxx' },
                { label: 'Email', key: 'email', type: 'email', placeholder: 'Optional' },
                { label: 'Notes', key: 'notes', type: 'text', placeholder: 'Optional internal notes' },
              ].map(f => (
                <div key={f.key}>
                  <label className="block text-xs text-gray-500 mb-1">{f.label}</label>
                  <input
                    type={f.type}
                    value={createForm[f.key as keyof typeof createForm]}
                    onChange={e => setCreateForm(prev => ({ ...prev, [f.key]: e.target.value }))}
                    onKeyDown={e => e.key === 'Enter' && handleCreate()}
                    placeholder={f.placeholder}
                    className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-green-500 transition-colors"
                  />
                </div>
              ))}
            </div>
            {createError && <p className="text-red-400 text-xs">{createError}</p>}
            <button
              onClick={handleCreate}
              disabled={creating || !createForm.name.trim() || !createForm.phone.trim()}
              className="w-full py-2.5 bg-green-500 hover:bg-green-400 disabled:opacity-40 text-gray-950 text-sm font-bold rounded-xl transition-colors"
            >
              {creating ? 'Creating…' : 'Create customer'}
            </button>
          </div>
        </div>
      )}

      {/* Profile drawer */}
      {selected && (
        <CustomerDrawer
          customer={selected}
          currency={currency}
          onClose={() => setSelected(null)}
          onUpdated={handleUpdated}
          onDeactivated={handleDeactivated}
        />
      )}
    </div>
  );
}
