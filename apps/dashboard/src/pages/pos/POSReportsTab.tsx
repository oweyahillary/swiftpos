/**
 * POSReportsTab
 * Branch-scoped sales summary accessible from the POS drawer.
 * Uses posApi (cashier JWT) — backend branchScope() locks it to the cashier's branch.
 * Permission required: reports.view
 */

import { useState, useEffect } from 'react';
import { usePOSAuth } from '../../context/POSAuthContext';
import { localDateStr } from '../../lib/localDate';

// ── Types ─────────────────────────────────────────────────────────────────────

interface SalesSummary {
  summary: {
    totalRevenue: number;
    totalOrders: number;
    avgOrderValue: number;
    totalDiscount: number;
    totalVat: number;
  };
  paymentMethods: Record<string, number>;
  dailySeries: { date: string; revenue: number }[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const fmt = (n: number, currency: string) =>
  `${currency} ${Number(n).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const today = () => localDateStr();
const weekAgo = () => {
  const d = new Date();
  d.setDate(d.getDate() - 6);
  return localDateStr(d);
};

const METHOD_LABELS: Record<string, string> = {
  cash: '💵 Cash',
  mpesa: '📱 M-Pesa',
  card: '💳 Card',
};

// ── Component ─────────────────────────────────────────────────────────────────

export default function POSReportsTab({ currency }: { currency: string }) {
  const { posApi, session } = usePOSAuth();

  const [from, setFrom] = useState(weekAgo());
  const [to,   setTo]   = useState(today());
  const [data, setData] = useState<SalesSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ from, to });
      if (session?.branchId) params.set('branch_id', session.branchId);
      const result = await posApi.get<SalesSummary>(`/api/reports/sales?${params}`);
      setData(result);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load report');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div style={s.root}>
      {/* Date filter */}
      <div style={s.filterRow}>
        <div style={s.dateGroup}>
          <label style={s.dateLabel}>From</label>
          <input style={s.dateInput} type="date" value={from} onChange={e => setFrom(e.target.value)} />
        </div>
        <div style={s.dateGroup}>
          <label style={s.dateLabel}>To</label>
          <input style={s.dateInput} type="date" value={to} onChange={e => setTo(e.target.value)} />
        </div>
        <button style={s.applyBtn} onClick={load} disabled={loading}>
          {loading ? '…' : 'Apply'}
        </button>
      </div>

      {error && <p style={s.error}>{error}</p>}

      {loading && !data && (
        <div style={s.center}><span style={s.spinner} /></div>
      )}

      {data && (
        <>
          {/* Summary cards */}
          <div style={s.cards}>
            <StatCard label="Revenue"    value={fmt(data.summary.totalRevenue, currency)} accent="#22c55e" />
            <StatCard label="Orders"     value={String(data.summary.totalOrders)}          accent="#3b82f6" />
            <StatCard label="Avg Order"  value={fmt(data.summary.avgOrderValue, currency)} accent="#a78bfa" />
            <StatCard label="Discounts"  value={fmt(data.summary.totalDiscount, currency)} accent="#f59e0b" />
            <StatCard label="VAT"        value={fmt(data.summary.totalVat, currency)}      accent="#64748b" />
          </div>

          {/* Payment method breakdown */}
          {Object.keys(data.paymentMethods).length > 0 && (
            <section style={s.section}>
              <p style={s.sectionTitle}>Payment Breakdown</p>
              {Object.entries(data.paymentMethods).map(([method, amount]) => {
                const pct = data.summary.totalRevenue
                  ? Math.round((amount / data.summary.totalRevenue) * 100)
                  : 0;
                return (
                  <div key={method} style={s.methodRow}>
                    <span style={s.methodLabel}>{METHOD_LABELS[method] ?? method}</span>
                    <div style={s.barTrack}>
                      <div style={{ ...s.barFill, width: `${pct}%` }} />
                    </div>
                    <span style={s.methodAmt}>{fmt(amount, currency)}</span>
                  </div>
                );
              })}
            </section>
          )}

          {/* Daily series */}
          {data.dailySeries.length > 0 && (
            <section style={s.section}>
              <p style={s.sectionTitle}>Daily Revenue</p>
              {data.dailySeries.map(({ date, revenue }) => {
                const max = Math.max(...data.dailySeries.map(d => d.revenue));
                const pct = max ? Math.round((revenue / max) * 100) : 0;
                return (
                  <div key={date} style={s.dailyRow}>
                    <span style={s.dailyDate}>{date.slice(5)}</span>
                    <div style={s.barTrack}>
                      <div style={{ ...s.barFill, width: `${pct}%`, background: '#3b82f6' }} />
                    </div>
                    <span style={s.dailyAmt}>{fmt(revenue, currency)}</span>
                  </div>
                );
              })}
            </section>
          )}
        </>
      )}
    </div>
  );
}

function StatCard({ label, value, accent }: { label: string; value: string; accent: string }) {
  return (
    <div style={{ ...s.card, borderTop: `3px solid ${accent}` }}>
      <p style={s.cardLabel}>{label}</p>
      <p style={{ ...s.cardValue, color: accent }}>{value}</p>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  root:       { padding: '0 0 24px' },
  filterRow:  { display: 'flex', gap: 8, alignItems: 'flex-end', marginBottom: 16 },
  dateGroup:  { display: 'flex', flexDirection: 'column', gap: 4, flex: 1 },
  dateLabel:  { fontSize: 11, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.4px' },
  dateInput:  {
    padding: '7px 10px', background: '#0f172a', border: '1px solid #334155',
    borderRadius: 7, color: '#f1f5f9', fontSize: 13, width: '100%', boxSizing: 'border-box' as const,
  },
  applyBtn: {
    padding: '7px 16px', background: '#3b82f6', border: 'none', borderRadius: 7,
    color: '#fff', fontWeight: 700, fontSize: 13, cursor: 'pointer', flexShrink: 0,
  },
  error:   { color: '#fca5a5', fontSize: 13, margin: '8px 0' },
  center:  { display: 'flex', justifyContent: 'center', padding: 32 },
  spinner: {
    display: 'inline-block', width: 24, height: 24,
    border: '2px solid #334155', borderTop: '2px solid #3b82f6', borderRadius: '50%',
    animation: 'spin 0.8s linear infinite',
  },
  cards:      { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 16 },
  card:       { background: '#0f172a', borderRadius: 8, padding: '12px 14px', border: '1px solid #1e293b' },
  cardLabel:  { fontSize: 11, color: '#64748b', margin: '0 0 4px', textTransform: 'uppercase', letterSpacing: '0.4px' },
  cardValue:  { fontSize: 16, fontWeight: 700, margin: 0 },
  section:    { marginBottom: 16 },
  sectionTitle: { fontSize: 11, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.5px', margin: '0 0 8px' },
  methodRow:  { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 },
  methodLabel:{ fontSize: 12, color: '#94a3b8', width: 90, flexShrink: 0 },
  barTrack:   { flex: 1, height: 6, background: '#1e293b', borderRadius: 3, overflow: 'hidden' },
  barFill:    { height: '100%', background: '#22c55e', borderRadius: 3, transition: 'width 0.3s ease' },
  methodAmt:  { fontSize: 12, color: '#f1f5f9', width: 100, textAlign: 'right' as const, flexShrink: 0 },
  dailyRow:   { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 },
  dailyDate:  { fontSize: 11, color: '#64748b', width: 40, flexShrink: 0 },
  dailyAmt:   { fontSize: 11, color: '#94a3b8', width: 90, textAlign: 'right' as const, flexShrink: 0 },
};
