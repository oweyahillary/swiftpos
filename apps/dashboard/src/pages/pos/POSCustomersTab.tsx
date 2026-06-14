/**
 * POSCustomersTab
 * Searchable customer list with loyalty points and tier for the cashier's branch.
 * Read-only view — no edit capability at this access level.
 * Permission required: customers.view
 */

import { useState, useEffect, useCallback } from 'react';
import { usePOSAuth } from '../../context/POSAuthContext';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Customer {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  loyalty_points: number;
  total_spent: number;
  visit_count: number;
  status: string;
  tier: { name: string; color: string };
}

interface CustomersResponse {
  customers: Customer[];
  total: number;
  page: number;
  limit: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const fmt = (n: number, currency: string) =>
  `${currency} ${Number(n).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// ── Component ─────────────────────────────────────────────────────────────────

export default function POSCustomersTab({ currency }: { currency: string }) {
  const { posApi } = usePOSAuth();

  const [customers, setCustomers] = useState<Customer[]>([]);
  const [total, setTotal]         = useState(0);
  const [page, setPage]           = useState(1);
  const [search, setSearch]       = useState('');
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState('');
  const [expanded, setExpanded]   = useState<string | null>(null);

  const LIMIT = 15;

  const load = useCallback(async (p = 1, q = search) => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ page: String(p), limit: String(LIMIT) });
      if (q) params.set('search', q);
      const res = await posApi.get<CustomersResponse>(`/api/loyalty/customers?${params}`);
      setCustomers(res.customers ?? []);
      setTotal(res.total ?? 0);
      setPage(p);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load customers');
    } finally {
      setLoading(false);
    }
  }, [posApi, search]);

  useEffect(() => { load(1); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    load(1, search);
  };

  const totalPages = Math.ceil(total / LIMIT);

  return (
    <div style={s.root}>
      {/* Search */}
      <form style={s.searchRow} onSubmit={handleSearch}>
        <input
          style={s.searchInput}
          placeholder="Name or phone…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <button style={s.searchBtn} type="submit">Search</button>
      </form>

      <p style={s.count}>{total} customer{total !== 1 ? 's' : ''}</p>

      {error && <p style={s.error}>{error}</p>}

      {loading && <div style={s.center}><span style={s.spinner} /></div>}

      {!loading && customers.length === 0 && (
        <p style={s.empty}>No customers found.</p>
      )}

      {/* Customer list */}
      <div style={s.list}>
        {customers.map(c => {
          const isOpen = expanded === c.id;
          const tierColor = c.tier?.color ?? '#64748b';
          return (
            <div key={c.id} style={s.card}>
              <button style={s.cardHeader} onClick={() => setExpanded(isOpen ? null : c.id)}>
                {/* Avatar */}
                <div style={{ ...s.avatar, background: `${tierColor}22`, color: tierColor }}>
                  {c.name.charAt(0).toUpperCase()}
                </div>
                <div style={s.cardInfo}>
                  <span style={s.custName}>{c.name}</span>
                  <span style={s.custPhone}>{c.phone ?? c.email ?? '—'}</span>
                </div>
                <div style={s.cardRight}>
                  <div style={s.pointsPill}>
                    <span style={s.pointsNum}>{c.loyalty_points}</span>
                    <span style={s.pointsLabel}>pts</span>
                  </div>
                  <span style={s.chevron}>{isOpen ? '▲' : '▼'}</span>
                </div>
              </button>

              {/* Expanded */}
              {isOpen && (
                <div style={s.detail}>
                  <div style={s.tierRow}>
                    <span style={{ ...s.tierBadge, background: `${tierColor}22`, color: tierColor, border: `1px solid ${tierColor}44` }}>
                      {c.tier?.name ?? 'Standard'}
                    </span>
                    <span style={s.detailMeta}>
                      {c.visit_count} visit{c.visit_count !== 1 ? 's' : ''}
                    </span>
                  </div>
                  <div style={s.detailRow}>
                    <span style={s.detailLabel}>Total Spent</span>
                    <span style={s.detailVal}>{fmt(c.total_spent, currency)}</span>
                  </div>
                  <div style={s.detailRow}>
                    <span style={s.detailLabel}>Loyalty Points</span>
                    <span style={{ ...s.detailVal, color: '#22c55e', fontWeight: 700 }}>{c.loyalty_points}</span>
                  </div>
                  {c.email && (
                    <div style={s.detailRow}>
                      <span style={s.detailLabel}>Email</span>
                      <span style={s.detailVal}>{c.email}</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div style={s.pagination}>
          <button
            style={{ ...s.pageBtn, opacity: page === 1 ? 0.4 : 1 }}
            disabled={page === 1}
            onClick={() => load(page - 1)}
          >← Prev</button>
          <span style={s.pageInfo}>{page} / {totalPages}</span>
          <button
            style={{ ...s.pageBtn, opacity: page >= totalPages ? 0.4 : 1 }}
            disabled={page >= totalPages}
            onClick={() => load(page + 1)}
          >Next →</button>
        </div>
      )}
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  root:       { paddingBottom: 24 },
  searchRow:  { display: 'flex', gap: 8, marginBottom: 6 },
  searchInput:{
    flex: 1, padding: '8px 12px', background: '#0f172a', border: '1px solid #334155',
    borderRadius: 7, color: '#f1f5f9', fontSize: 13, outline: 'none',
  },
  searchBtn:  {
    padding: '8px 16px', background: '#334155', border: 'none', borderRadius: 7,
    color: '#94a3b8', fontWeight: 600, fontSize: 13, cursor: 'pointer',
  },
  count:      { fontSize: 11, color: '#475569', margin: '0 0 10px' },
  error:      { color: '#fca5a5', fontSize: 13, margin: '8px 0' },
  center:     { display: 'flex', justifyContent: 'center', padding: 24 },
  spinner:    {
    display: 'inline-block', width: 22, height: 22,
    border: '2px solid #334155', borderTop: '2px solid #3b82f6', borderRadius: '50%',
    animation: 'spin 0.8s linear infinite',
  },
  empty:      { color: '#475569', fontSize: 13, textAlign: 'center', padding: '24px 0' },
  list:       { display: 'flex', flexDirection: 'column', gap: 6 },
  card:       { background: '#0f172a', border: '1px solid #1e293b', borderRadius: 8, overflow: 'hidden' },
  cardHeader: {
    width: '100%', display: 'flex', alignItems: 'center', padding: '10px 12px', gap: 10,
    background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left' as const,
  },
  avatar:     {
    width: 34, height: 34, borderRadius: '50%', display: 'flex', alignItems: 'center',
    justifyContent: 'center', fontSize: 14, fontWeight: 700, flexShrink: 0,
  },
  cardInfo:   { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 },
  custName:   { fontSize: 13, fontWeight: 600, color: '#f1f5f9', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  custPhone:  { fontSize: 11, color: '#475569' },
  cardRight:  { display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 },
  pointsPill: { display: 'flex', flexDirection: 'column', alignItems: 'center' },
  pointsNum:  { fontSize: 14, fontWeight: 700, color: '#22c55e', lineHeight: 1 },
  pointsLabel:{ fontSize: 9, color: '#475569', textTransform: 'uppercase' as const },
  chevron:    { fontSize: 10, color: '#475569' },
  detail:     { padding: '0 12px 10px', borderTop: '1px solid #1e293b' },
  tierRow:    { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0 6px' },
  tierBadge:  { fontSize: 11, fontWeight: 700, padding: '2px 10px', borderRadius: 12 },
  detailMeta: { fontSize: 11, color: '#475569' },
  detailRow:  { display: 'flex', justifyContent: 'space-between', padding: '3px 0' },
  detailLabel:{ fontSize: 12, color: '#64748b' },
  detailVal:  { fontSize: 12, color: '#94a3b8' },
  pagination: { display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 16, paddingTop: 12 },
  pageBtn:    {
    padding: '6px 14px', background: '#1e293b', border: '1px solid #334155',
    borderRadius: 7, color: '#94a3b8', fontSize: 12, cursor: 'pointer',
  },
  pageInfo:   { fontSize: 12, color: '#475569' },
};
