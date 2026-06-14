/**
 * OverviewPage.tsx — Live Cockpit Dashboard
 *
 * Key upgrades over previous version:
 *  - Supabase realtime subscription on orders → live revenue ticker
 *  - Rolling 60-min order count + sparkline
 *  - Top item of the day (live)
 *  - Branch comparison widget (multi-branch)
 *  - KPI cards with animated delta vs yesterday
 *  - Auto-refresh every 60s as fallback
 *  - "Last updated" timestamp
 */

import { useEffect, useState, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { supabase } from '../lib/supabase';
import { useBusiness } from '../context/BusinessContext';
import { useBranch } from '../context/BranchContext';

// ── Types ─────────────────────────────────────────────────────────────────────

interface SalesSummary {
  summary: {
    totalRevenue: number; totalOrders: number; avgOrderValue: number;
    totalDiscount: number; totalVat: number;
  };
  paymentMethods: Record<string, number>;
  dailySeries: { date: string; revenue: number }[];
  branchBreakdown: { branch_id: string; name: string; revenue: number; orders: number }[];
}

interface TopProduct { product_id: string; name: string; qty: number; revenue: number; }
interface StockRow { product_id: string; quantity: number; low_stock_threshold: number; products: { name: string }; }
interface Shift { id: string; cashier_name: string; branch_name: string; opened_at: string; status: string; opening_float: number; }

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(n: number, currency = 'KES') {
  return `${currency} ${n.toLocaleString('en-KE', { maximumFractionDigits: 0 })}`;
}
function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit' });
}
function hoursAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const h = Math.floor(diff / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
function deltaLabel(curr: number, prev: number) {
  if (!prev) return null;
  const pct = Math.round(((curr - prev) / prev) * 100);
  return { pct, up: pct >= 0 };
}
function todayStr() { return new Date().toISOString().slice(0, 10); }
function ydStr() { return new Date(Date.now() - 86_400_000).toISOString().slice(0, 10); }
function sevenAgoStr() { return new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10); }

// ── Sub-components ────────────────────────────────────────────────────────────

function KpiCard({ label, value, delta, sub, accent }: {
  label: string; value: string; delta?: { pct: number; up: boolean } | null;
  sub?: string; accent?: boolean;
}) {
  return (
    <div className={`rounded-xl p-4 flex flex-col gap-1.5 border ${accent
      ? 'bg-blue-600 border-blue-500'
      : 'bg-gray-900 border-gray-800'
    }`}>
      <span className={`text-xs uppercase tracking-wider font-medium ${accent ? 'text-blue-100' : 'text-gray-500'}`}>{label}</span>
      <span className={`text-xl font-semibold tabular-nums ${accent ? 'text-white' : 'text-white'}`}>{value}</span>
      {delta != null && (
        <span className={`text-xs font-medium ${delta.up ? 'text-green-400' : 'text-red-400'}`}>
          {delta.up ? '▲' : '▼'} {Math.abs(delta.pct)}% vs yesterday
        </span>
      )}
      {sub && <span className="text-xs text-gray-500">{sub}</span>}
    </div>
  );
}

function Section({ title, sub, linkTo, linkLabel, live, children }: {
  title: string; sub?: string; linkTo?: string; linkLabel?: string;
  live?: boolean; children: React.ReactNode;
}) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-white text-sm font-medium">{title}</span>
          {live && (
            <span className="flex items-center gap-1 text-[10px] text-green-400 font-medium">
              <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
              live
            </span>
          )}
          {sub && <span className="text-xs text-gray-600">{sub}</span>}
        </div>
        {linkTo && (
          <Link to={linkTo} className="text-xs text-gray-500 hover:text-white transition-colors">
            {linkLabel ?? 'view all →'}
          </Link>
        )}
      </div>
      {children}
    </div>
  );
}

function MiniBarChart({ series }: { series: { date: string; revenue: number }[] }) {
  const last7 = series.slice(-7);
  const max = Math.max(...last7.map(d => d.revenue), 1);
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  return (
    <div>
      <div className="flex items-end gap-1 h-12">
        {last7.map((d, i) => {
          const isToday = i === last7.length - 1;
          const pct = Math.max(6, Math.round((d.revenue / max) * 100));
          return (
            <div key={i} className="flex-1 flex flex-col justify-end h-full">
              <div
                style={{ height: `${pct}%` }}
                className={`rounded-sm transition-all ${isToday ? 'bg-blue-500' : 'bg-gray-700'}`}
                title={`${d.date}: ${d.revenue.toLocaleString()}`}
              />
            </div>
          );
        })}
      </div>
      <div className="flex justify-between mt-1">
        {last7.map((d, i) => {
          const isToday = i === last7.length - 1;
          const dow = new Date(d.date + 'T12:00:00').getDay();
          const label = days[dow === 0 ? 6 : dow - 1];
          return (
            <span key={i} className={`flex-1 text-center text-[10px] ${isToday ? 'text-blue-400 font-medium' : 'text-gray-600'}`}>
              {isToday ? 'Today' : label}
            </span>
          );
        })}
      </div>
    </div>
  );
}

// Rolling 60-min sparkline — buckets by 10-min intervals
function HourlySparkline({ orders60 }: { orders60: { ts: number; total: number }[] }) {
  const now = Date.now();
  const buckets = Array.from({ length: 6 }, (_, i) => {
    const from = now - (6 - i) * 600_000;
    const to = from + 600_000;
    return orders60.filter(o => o.ts >= from && o.ts < to).reduce((s, o) => s + o.total, 0);
  });
  const max = Math.max(...buckets, 1);
  return (
    <div className="flex items-end gap-1 h-8">
      {buckets.map((v, i) => (
        <div key={i} className="flex-1 flex flex-col justify-end h-full">
          <div
            style={{ height: `${Math.max(6, Math.round((v / max) * 100))}%` }}
            className="rounded-sm bg-teal-500/60"
          />
        </div>
      ))}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function OverviewPage() {
  const { business, loading: businessLoading } = useBusiness();
  const { activeBranch, activeBranchId, branches } = useBranch();
  const currency = business?.currency ?? 'KES';

  const [sales, setSales]             = useState<SalesSummary | null>(null);
  const [yesterday, setYesterday]     = useState<SalesSummary | null>(null);
  const [topProducts, setTopProducts] = useState<TopProduct[]>([]);
  const [lowStock, setLowStock]       = useState<StockRow[]>([]);
  const [shifts, setShifts]           = useState<Shift[]>([]);
  const [loading, setLoading]         = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  // Live data: rolling 60-min orders + live revenue
  const [liveRevenue, setLiveRevenue]   = useState<number | null>(null);
  const [liveOrders, setLiveOrders]     = useState<number | null>(null);
  const [orders60, setOrders60]         = useState<{ ts: number; total: number }[]>([]);
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);

  const load = useCallback(async () => {
    if (!business) { setLoading(false); return; }
    setLoading(true);
    try {
      const bq = activeBranchId ? `&branch_id=${activeBranchId}` : '';
      const td = todayStr(), yd = ydStr(), s7 = sevenAgoStr();

      const [todaySales, ydData, trendData, prodData, shiftsData] = await Promise.all([
        api.get<any>(`/api/reports/sales?from=${td}&to=${td}${bq}`),
        api.get<any>(`/api/reports/sales?from=${yd}&to=${yd}${bq}`),
        api.get<any>(`/api/reports/sales?from=${s7}&to=${td}${bq}`),
        api.get<any>(`/api/reports/products?from=${td}&to=${td}${bq}`),
        api.get<any>(`/api/shifts?status=open${bq}`).catch(() => []),
      ]);

      const salesData = { ...todaySales, dailySeries: trendData?.dailySeries ?? [] };
      setSales(salesData);
      setYesterday(ydData);
      setTopProducts((prodData?.products ?? []).slice(0, 5));
      setShifts(shiftsData ?? []);
      setLiveRevenue(todaySales?.summary?.totalRevenue ?? 0);
      setLiveOrders(todaySales?.summary?.totalOrders ?? 0);

      if (activeBranchId) {
        const stockData = await api.get<StockRow[]>(`/api/inventory?branch_id=${activeBranchId}`);
        setLowStock((stockData ?? []).filter(r => r.quantity <= r.low_stock_threshold)
          .sort((a, b) => a.quantity - b.quantity).slice(0, 5));
      } else {
        setLowStock([]);
      }

      setLastUpdated(new Date());
    } catch (err) {
      console.error('Overview load failed:', err);
    } finally {
      setLoading(false);
    }
  }, [business?.id, activeBranchId]);

  // Initial load + 60s auto-refresh
  useEffect(() => {
    if (!businessLoading) load();
    const t = setInterval(() => { if (!businessLoading) load(); }, 60_000);
    return () => clearInterval(t);
  }, [load, businessLoading]);

  // Supabase realtime — listen for new completed orders
  useEffect(() => {
    if (!business?.id) return;
    if (channelRef.current) supabase.removeChannel(channelRef.current);

    const filter = activeBranchId
      ? `business_id=eq.${business.id}&branch_id=eq.${activeBranchId}&status=eq.completed`
      : `business_id=eq.${business.id}&status=eq.completed`;

    const channel = supabase
      .channel(`cockpit-orders-${business.id}-${activeBranchId ?? 'all'}`)
      .on('postgres_changes', {
        event: 'INSERT', schema: 'public', table: 'orders', filter,
      }, (payload) => {
        const order = payload.new as any;
        const total = Number(order.total ?? 0);
        // Increment live counters
        setLiveRevenue(prev => (prev ?? 0) + total);
        setLiveOrders(prev => (prev ?? 0) + 1);
        // Add to rolling 60-min window
        setOrders60(prev => {
          const now = Date.now();
          const fresh = prev.filter(o => o.ts > now - 3_600_000);
          return [...fresh, { ts: now, total }];
        });
      })
      .subscribe();

    channelRef.current = channel;
    return () => { supabase.removeChannel(channel); };
  }, [business?.id, activeBranchId]);

  // Prune orders60 older than 60 min every 30s
  useEffect(() => {
    const t = setInterval(() => {
      setOrders60(prev => prev.filter(o => o.ts > Date.now() - 3_600_000));
    }, 30_000);
    return () => clearInterval(t);
  }, []);

  // Derived values
  const rev      = liveRevenue ?? sales?.summary?.totalRevenue ?? 0;
  const orders   = liveOrders  ?? sales?.summary?.totalOrders ?? 0;
  const avg      = orders > 0 ? rev / orders : 0;
  const ydRev    = yesterday?.summary?.totalRevenue ?? 0;
  const ydOrders = yesterday?.summary?.totalOrders ?? 0;
  const mpesa    = sales?.paymentMethods?.mpesa ?? 0;
  const openShifts = (shifts ?? []).filter(s => s.status === 'open');
  const orders60count = orders60.length;
  const orders60rev   = orders60.reduce((s, o) => s + o.total, 0);

  const todayLabel = new Date().toLocaleDateString('en-KE', {
    weekday: 'long', day: 'numeric', month: 'long',
  });

  const isPetrol = business?.type === 'petrol_station';

  if (loading && !sales) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-gray-500 text-sm animate-pulse">Loading cockpit…</p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-6 bg-gray-950">
      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-3 mb-6">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold text-white">Cockpit</h1>
            <span className="flex items-center gap-1 text-[10px] text-green-400 font-medium px-1.5 py-0.5 bg-green-400/10 rounded-full border border-green-400/20">
              <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
              live
            </span>
          </div>
          <p className="text-gray-500 text-sm mt-0.5">
            {activeBranch?.name ?? 'All branches'} · {todayLabel}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {lastUpdated && (
            <span className="text-xs text-gray-600">
              Updated {fmtTime(lastUpdated.toISOString())}
            </span>
          )}
          <button onClick={load} disabled={loading}
            className="text-xs text-gray-500 hover:text-white border border-gray-800 rounded-lg px-3 py-1.5 transition-colors disabled:opacity-40">
            ↻ Refresh
          </button>
        </div>
      </div>

      {/* KPI row — live values */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
        <KpiCard label="Revenue today"                    value={fmt(rev, currency)} delta={deltaLabel(rev, ydRev)} accent />
        <KpiCard label={isPetrol ? 'Transactions today' : 'Orders today'} value={orders.toString()} delta={deltaLabel(orders, ydOrders)} />
        <KpiCard label={isPetrol ? 'Avg transaction' : 'Avg order'}       value={fmt(avg, currency)} />
        <KpiCard label="M-Pesa"                           value={fmt(mpesa, currency)}
          sub={rev > 0 ? `${Math.round((mpesa / rev) * 100)}% of revenue` : undefined} />
      </div>

      {/* Live row */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-5">
        {/* Last 60 minutes */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 sm:col-span-2">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <span className="text-white text-sm font-medium">Last 60 minutes</span>
              <span className="flex items-center gap-1 text-[10px] text-green-400 font-medium">
                <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />live
              </span>
            </div>
            <div className="text-right">
              <p className="text-white text-sm font-semibold tabular-nums">{fmt(orders60rev, currency)}</p>
              <p className="text-gray-500 text-xs">{orders60count} orders</p>
            </div>
          </div>
          <HourlySparkline orders60={orders60} />
          <div className="flex justify-between mt-1">
            {['-60m', '-50m', '-40m', '-30m', '-20m', '-10m'].map(l => (
              <span key={l} className="flex-1 text-center text-[9px] text-gray-700">{l}</span>
            ))}
          </div>
        </div>

        {/* Open shifts live */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-white text-sm font-medium">Open shifts</span>
            <span className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${
              openShifts.length > 0
                ? 'bg-green-500/10 text-green-400 border-green-500/20'
                : 'bg-gray-800 text-gray-500 border-gray-700'
            }`}>{openShifts.length}</span>
          </div>
          {openShifts.length === 0
            ? <p className="text-gray-600 text-xs">No open shifts right now.</p>
            : openShifts.slice(0, 3).map(s => (
              <div key={s.id} className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-white text-xs font-medium truncate">{s.cashier_name}</p>
                  <p className="text-gray-600 text-[10px]">{hoursAgo(s.opened_at)} · float {fmt(s.opening_float, currency)}</p>
                </div>
                <span className="w-1.5 h-1.5 rounded-full bg-green-400 flex-shrink-0" />
              </div>
            ))
          }
        </div>
      </div>

      {/* Main grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
        {/* Revenue trend */}
        <Section title="7-day trend" linkTo="/dashboard/reports" linkLabel="full report →">
          {(sales?.dailySeries?.length ?? 0) > 0
            ? <MiniBarChart series={sales!.dailySeries} />
            : <p className="text-gray-600 text-sm">No data yet.</p>}
        </Section>

        {/* Top sellers */}
        <Section title={isPetrol ? 'Top grades today' : 'Top sellers today'} live linkTo="/dashboard/reports?tab=items" linkLabel="item mix →">
          {topProducts.length === 0
            ? <p className="text-gray-600 text-sm">No sales yet today.</p>
            : (
              <div className="flex flex-col divide-y divide-gray-800">
                {topProducts.map((p, i) => (
                  <div key={p.product_id} className="flex items-center justify-between py-2 gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-gray-700 text-xs w-4 flex-shrink-0 tabular-nums">{i + 1}</span>
                      <div className="min-w-0">
                        <p className="text-white text-sm truncate">{p.name}</p>
                        <p className="text-gray-600 text-xs">{p.qty} sold</p>
                      </div>
                    </div>
                    <span className="text-white text-sm font-medium flex-shrink-0 tabular-nums">{fmt(p.revenue, currency)}</span>
                  </div>
                ))}
              </div>
            )
          }
        </Section>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
        {/* Payment split */}
        <Section title="Payment methods" sub="today">
          {!sales?.paymentMethods || Object.keys(sales.paymentMethods).length === 0
            ? <p className="text-gray-600 text-sm">No payments yet.</p>
            : (
              <div className="space-y-2">
                {Object.entries(sales.paymentMethods)
                  .sort(([, a], [, b]) => b - a)
                  .map(([method, amount]) => {
                    const pct = rev > 0 ? Math.round((amount / rev) * 100) : 0;
                    return (
                      <div key={method}>
                        <div className="flex justify-between text-sm mb-1">
                          <span className="text-gray-300 capitalize">{method.replace(/_/g, ' ')}</span>
                          <span className="text-white font-medium tabular-nums">
                            {fmt(amount, currency)} <span className="text-gray-500 font-normal text-xs">{pct}%</span>
                          </span>
                        </div>
                        <div className="h-1 bg-gray-800 rounded-full overflow-hidden">
                          <div className="h-full bg-blue-500 rounded-full" style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                    );
                  })}
              </div>
            )
          }
        </Section>

        {/* Low stock */}
        <Section title={isPetrol ? 'Tank levels' : 'Low stock'} linkTo={isPetrol ? '/dashboard/reports?tab=wet_stock' : '/dashboard/inventory'} linkLabel="manage →">
          {!activeBranchId
            ? <p className="text-gray-600 text-sm">Select a branch to see stock alerts.</p>
            : lowStock.length === 0
              ? <p className="text-gray-600 text-sm flex items-center gap-2"><span className="text-green-400">✓</span> All stock healthy.</p>
              : (
                <div className="flex flex-col divide-y divide-gray-800">
                  {lowStock.map(r => {
                    const critical = r.quantity === 0 || r.quantity <= Math.floor(r.low_stock_threshold / 2);
                    return (
                      <div key={r.product_id} className="flex items-center justify-between py-2 gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className={`w-2 h-2 rounded-full flex-shrink-0 ${critical ? 'bg-red-500' : 'bg-amber-400'}`} />
                          <div className="min-w-0">
                            <p className="text-white text-sm truncate">{r.products.name}</p>
                            <p className="text-gray-600 text-xs">threshold: {r.low_stock_threshold}</p>
                          </div>
                        </div>
                        <span className={`text-xs font-semibold px-2 py-0.5 rounded-full flex-shrink-0 ${
                          critical ? 'bg-red-500/10 text-red-400 border border-red-500/20'
                            : 'bg-amber-400/10 text-amber-400 border border-amber-400/20'}`}>
                          {r.quantity} left
                        </span>
                      </div>
                    );
                  })}
                </div>
              )
          }
        </Section>
      </div>

      {/* Branch breakdown — multi-branch only */}
      {!activeBranchId && branches && branches.length > 1 && sales?.branchBreakdown?.length ? (
        <Section title="Branch comparison" sub="today" linkTo="/dashboard/branches" linkLabel="manage →">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {sales.branchBreakdown
              .sort((a, b) => b.revenue - a.revenue)
              .map((b, i) => {
                const maxRev = sales.branchBreakdown![0]?.revenue ?? 1;
                const pct = Math.round((b.revenue / Math.max(maxRev, 1)) * 100);
                return (
                  <div key={b.branch_id} className="bg-gray-800 rounded-lg p-3">
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        {i === 0 && <span className="text-[10px] text-amber-400">★</span>}
                        <p className="text-white text-sm font-medium">{b.name}</p>
                      </div>
                      <span className="text-white text-sm font-semibold tabular-nums">{fmt(b.revenue, currency)}</span>
                    </div>
                    <div className="h-1 bg-gray-700 rounded-full overflow-hidden mb-1">
                      <div className="h-full bg-blue-500 rounded-full transition-all" style={{ width: `${pct}%` }} />
                    </div>
                    <p className="text-gray-500 text-xs">{b.orders} orders · avg {fmt(b.orders > 0 ? b.revenue / b.orders : 0, currency)}</p>
                  </div>
                );
              })}
          </div>
          <div className="flex justify-between items-center pt-2 border-t border-gray-800">
            <span className="text-gray-500 text-xs">Combined today</span>
            <span className="text-white text-base font-semibold tabular-nums">{fmt(rev, currency)}</span>
          </div>
        </Section>
      ) : null}
    </div>
  );
}
