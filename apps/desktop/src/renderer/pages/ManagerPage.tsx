/**
 * ManagerPage.tsx — Desktop manager / supervisor dashboard.
 *
 * Auth:    PIN login → role is manager / supervisor / admin → App.tsx routes here.
 * Reports: Decision D9 — operational depth only (today / shift / this branch).
 *          Web = full analytics. Desktop = summary, view-only.
 *
 * Vertical-aware:
 *   petrol_station → Overview (pump monitor + fuel sales) · Orders · Shift · Z-report · Stock
 *   restaurant/cafe → Overview (tables + revenue) · Orders · Shift · Z-report · Top items · Stock
 *   retail/other   → Overview (revenue KPIs) · Orders · Shift · Z-report · Stock
 */

import { useState, useEffect, useRef } from 'react';
import { posApi, ZReport } from '../lib/posApi';
import { modeFlags } from '../lib/posMode';
import ZReportView from '../components/ZReportView';
import { printReceipt } from '../lib/printReceipt';
import { usePrinterSettings } from '../hooks/usePrinterSettings';

// ── SVG icons (zero dependency) ───────────────────────────────────────────────
function Icon({ d, size = 18, cls = '' }: { d: string; size?: number; cls?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
      className={cls} aria-hidden>
      <path d={d} />
    </svg>
  );
}
const I = {
  overview:  'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6',
  orders:    'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2',
  shift:     'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z',
  zreport:   'M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z',
  stock:     'M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4',
  items:     'M4 6h16M4 12h16M4 18h7',
  tables:    'M3 10h18M3 14h18M10 4v16M14 4v16M5 4h14a2 2 0 012 2v12a2 2 0 01-2 2H5a2 2 0 01-2-2V6a2 2 0 012-2z',
  logout:    'M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1',
  pos:       'M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17H3a2 2 0 01-2-2V5a2 2 0 012-2h14a2 2 0 012 2v10a2 2 0 01-2 2h-2',
  warning:   'M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z',
  refresh:   'M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15',
  menu:      'M4 6h16M4 12h16M4 18h16',
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmt(n: number, currency: string) {
  return `${currency} ${Number(n).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function fmtL(n: number) {
  return `${Number(n).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} L`;
}
function timeAgo(iso: string) {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1)  return 'just now';
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m ago`;
}

// ── Shared card components ─────────────────────────────────────────────────────
function KpiCard({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: boolean }) {
  return (
    <div className={`rounded-xl p-4 border ${accent ? 'bg-blue-600 border-blue-500' : 'bg-gray-800 border-gray-700'}`}>
      <p className={`text-xs font-medium uppercase tracking-wide mb-1 ${accent ? 'text-blue-100' : 'text-gray-400'}`}>{label}</p>
      <p className={`text-xl font-bold tabular-nums ${accent ? 'text-white' : 'text-white'}`}>{value}</p>
      {sub && <p className={`text-xs mt-0.5 ${accent ? 'text-blue-200' : 'text-gray-500'}`}>{sub}</p>}
    </div>
  );
}

function Card({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="bg-gray-800 border border-gray-700 rounded-xl overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
        <span className="text-sm font-semibold text-white">{title}</span>
        {action}
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

function Spinner() {
  return <div className="flex items-center justify-center py-12 text-gray-500 text-sm">Loading…</div>;
}

// ── Overview Tab — Restaurant ─────────────────────────────────────────────────
function RestaurantOverview({ currency }: { currency: string }) {
  const [sales,    setSales]    = useState<any>(null);
  const [topItems, setTopItems] = useState<any[]>([]);
  const [tables,   setTables]   = useState<any[]>([]);
  const [loading,  setLoading]  = useState(true);

  useEffect(() => {
    let live = true;
    async function load() {
      try {
        const [s, t, tb] = await Promise.all([
          posApi.manager.salesSummary(),
          posApi.manager.topProducts(),
          posApi.manager.tableOccupancy(),
        ]);
        if (!live) return;
        setSales(s); setTopItems(t); setTables(tb);
      } catch { /* best effort */ }
      finally { if (live) setLoading(false); }
    }
    load();
    return () => { live = false; };
  }, []);

  if (loading) return <Spinner />;

  const s = sales?.summary;
  const occupiedCount = 0; // Held orders cross-reference would need heldOrders lib — show total

  return (
    <div className="space-y-4">
      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard label="Revenue today"   value={fmt(s?.totalRevenue ?? 0, currency)} accent />
        <KpiCard label="Orders today"    value={String(s?.totalOrders ?? 0)} />
        <KpiCard label="Avg order"       value={fmt(s?.avgOrderValue ?? 0, currency)} />
        <KpiCard label="VAT collected"   value={fmt(s?.totalVat ?? 0, currency)} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Payment split */}
        <Card title="Payment methods — today">
          {!sales?.paymentMethods || Object.keys(sales.paymentMethods).length === 0
            ? <p className="text-gray-500 text-sm">No payments yet today.</p>
            : (
              <div className="space-y-2">
                {Object.entries(sales.paymentMethods as Record<string, number>)
                  .sort(([, a], [, b]) => b - a)
                  .map(([method, amount]) => {
                    const total = s?.totalRevenue ?? 1;
                    const pct   = total > 0 ? Math.round((amount / total) * 100) : 0;
                    return (
                      <div key={method}>
                        <div className="flex justify-between text-sm mb-1">
                          <span className="text-gray-300 capitalize">{method.replace(/_/g, ' ')}</span>
                          <span className="text-white font-medium tabular-nums">{fmt(amount, currency)} <span className="text-gray-500 text-xs">{pct}%</span></span>
                        </div>
                        <div className="h-1 bg-gray-700 rounded-full overflow-hidden">
                          <div className="h-full bg-blue-500 rounded-full" style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                    );
                  })}
              </div>
            )}
        </Card>

        {/* Top items */}
        <Card title="Top sellers — today">
          {topItems.length === 0
            ? <p className="text-gray-500 text-sm">No sales yet today.</p>
            : (
              <div className="divide-y divide-gray-700">
                {topItems.map((p, i) => (
                  <div key={p.name} className="flex items-center justify-between py-2 gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-gray-600 text-xs w-4 tabular-nums">{i + 1}</span>
                      <div className="min-w-0">
                        <p className="text-white text-sm truncate">{p.name}</p>
                        <p className="text-gray-500 text-xs">{Number(p.qty).toFixed(0)} sold</p>
                      </div>
                    </div>
                    <span className="text-white text-sm font-medium tabular-nums flex-shrink-0">{fmt(Number(p.revenue), currency)}</span>
                  </div>
                ))}
              </div>
            )}
        </Card>
      </div>

      {/* Tables */}
      {tables.length > 0 && (
        <Card title={`Tables — ${tables.length} configured`}>
          <div className="grid grid-cols-4 sm:grid-cols-6 lg:grid-cols-8 gap-2">
            {tables.map(t => (
              <div key={t.id} className="bg-gray-700/50 border border-gray-600 rounded-lg p-2 text-center">
                <p className="text-white text-sm font-medium truncate">{t.name}</p>
                <p className="text-gray-500 text-[10px] mt-0.5">{t.capacity} seats</p>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Hourly chart */}
      {(sales?.hourly?.length ?? 0) > 0 && (
        <Card title="Hourly sales — today">
          <HourlyChart hourly={sales.hourly} currency={currency} />
        </Card>
      )}
    </div>
  );
}

// ── Overview Tab — Petrol ─────────────────────────────────────────────────────
function PetrolOverview({ currency }: { currency: string }) {
  const [fuel,    setFuel]    = useState<any>(null);
  const [pumps,   setPumps]   = useState<any[]>([]);
  const [sales,   setSales]   = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    async function load() {
      try {
        const [f, p, s] = await Promise.all([
          posApi.manager.fuelSales(),
          posApi.manager.pumpStatus(),
          posApi.manager.salesSummary(),
        ]);
        if (!live) return;
        setFuel(f); setPumps(p); setSales(s);
      } catch { /* best effort */ }
      finally { if (live) setLoading(false); }
    }
    load();
    return () => { live = false; };
  }, []);

  if (loading) return <Spinner />;

  const f = fuel?.summary;

  return (
    <div className="space-y-4">
      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard label="Revenue today"     value={fmt(f?.totalRevenue ?? 0, currency)} accent />
        <KpiCard label="Litres sold"        value={fmtL(f?.totalLitres ?? 0)} />
        <KpiCard label="Transactions"       value={String(f?.totalTransactions ?? 0)} />
        <KpiCard label="Avg per transaction"
          value={f?.totalTransactions > 0
            ? fmt((f.totalRevenue / f.totalTransactions), currency)
            : '—'} />
      </div>

      {/* Pump monitor table */}
      <Card title="Pump Monitor — today">
        {pumps.length === 0
          ? <p className="text-gray-500 text-sm">No pumps configured. Add pumps in server settings.</p>
          : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-700">
                    {['Pump', 'Grade', 'Sold today', 'Revenue', 'Status'].map(h => (
                      <th key={h} className="pb-2 text-left text-xs font-medium text-gray-500 pr-4">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-700/50">
                  {pumps.map(p => (
                    <tr key={p.pump_id}>
                      <td className="py-2.5 font-semibold text-white pr-4 whitespace-nowrap">{p.pump_name}</td>
                      <td className="py-2.5 text-gray-400 pr-4">{p.product_name ?? '—'}</td>
                      <td className="py-2.5 text-amber-400 font-medium tabular-nums pr-4">{fmtL(p.sold_litres)}</td>
                      <td className="py-2.5 text-green-400 font-semibold tabular-nums pr-4">{fmt(p.revenue_today, currency)}</td>
                      <td className="py-2.5">
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                          p.pump_status === 'dispensing' ? 'bg-blue-500/20 text-blue-400' :
                          p.pump_status === 'idle'       ? 'bg-green-500/20 text-green-400' :
                                                           'bg-gray-700 text-gray-400'
                        }`}>{p.pump_status ?? 'idle'}</span>
                      </td>
                    </tr>
                  ))}
                  {/* Totals row */}
                  <tr className="border-t border-gray-600 font-semibold text-xs">
                    <td colSpan={2} className="pt-2 text-gray-500">Total</td>
                    <td className="pt-2 text-amber-400 tabular-nums">
                      {fmtL(pumps.reduce((s, p) => s + Number(p.sold_litres), 0))}
                    </td>
                    <td className="pt-2 text-green-400 tabular-nums">
                      {fmt(pumps.reduce((s, p) => s + Number(p.revenue_today), 0), currency)}
                    </td>
                    <td />
                  </tr>
                </tbody>
              </table>
            </div>
          )}
      </Card>

      {/* Grade breakdown */}
      {(fuel?.grades?.length ?? 0) > 0 && (
        <Card title="By fuel grade — today">
          <div className="divide-y divide-gray-700">
            {(fuel.grades as any[]).map((g: any) => {
              const maxRev = fuel.grades[0]?.revenue ?? 1;
              return (
                <div key={g.grade} className="py-3 flex items-center gap-3">
                  <span className="text-gray-300 text-sm w-28 truncate">{g.grade}</span>
                  <div className="flex-1 h-1.5 bg-gray-700 rounded-full overflow-hidden">
                    <div className="h-full bg-amber-400 rounded-full" style={{ width: `${Math.round((g.revenue / maxRev) * 100)}%` }} />
                  </div>
                  <span className="text-gray-400 text-xs tabular-nums w-20 text-right">{fmtL(g.litres)}</span>
                  <span className="text-white text-sm font-medium tabular-nums w-28 text-right">{fmt(g.revenue, currency)}</span>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {/* Payment split */}
      {sales?.paymentMethods && Object.keys(sales.paymentMethods).length > 0 && (
        <Card title="Payment methods — today">
          <div className="space-y-2">
            {Object.entries(sales.paymentMethods as Record<string, number>)
              .sort(([, a], [, b]) => b - a)
              .map(([method, amount]) => {
                const total = sales.summary?.totalRevenue ?? 1;
                const pct   = total > 0 ? Math.round((amount / total) * 100) : 0;
                return (
                  <div key={method}>
                    <div className="flex justify-between text-sm mb-1">
                      <span className="text-gray-300 capitalize">{method.replace(/_/g, ' ')}</span>
                      <span className="text-white font-medium tabular-nums">{fmt(amount, currency)} <span className="text-gray-500 text-xs">{pct}%</span></span>
                    </div>
                    <div className="h-1 bg-gray-700 rounded-full overflow-hidden">
                      <div className="h-full bg-amber-500 rounded-full" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                );
              })}
          </div>
        </Card>
      )}
    </div>
  );
}

// ── Overview Tab — Retail / default ──────────────────────────────────────────
function RetailOverview({ currency }: { currency: string }) {
  const [sales,    setSales]    = useState<any>(null);
  const [topItems, setTopItems] = useState<any[]>([]);
  const [loading,  setLoading]  = useState(true);

  useEffect(() => {
    let live = true;
    async function load() {
      try {
        const [s, t] = await Promise.all([
          posApi.manager.salesSummary(),
          posApi.manager.topProducts(),
        ]);
        if (!live) return;
        setSales(s); setTopItems(t);
      } catch { /* best effort */ }
      finally { if (live) setLoading(false); }
    }
    load();
    return () => { live = false; };
  }, []);

  if (loading) return <Spinner />;
  const s = sales?.summary;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard label="Revenue today"  value={fmt(s?.totalRevenue ?? 0, currency)} accent />
        <KpiCard label="Orders today"   value={String(s?.totalOrders ?? 0)} />
        <KpiCard label="Avg order"      value={fmt(s?.avgOrderValue ?? 0, currency)} />
        <KpiCard label="VAT collected"  value={fmt(s?.totalVat ?? 0, currency)} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card title="Payment methods — today">
          {!sales?.paymentMethods || Object.keys(sales.paymentMethods).length === 0
            ? <p className="text-gray-500 text-sm">No payments yet.</p>
            : (
              <div className="space-y-2">
                {Object.entries(sales.paymentMethods as Record<string, number>).sort(([, a], [, b]) => b - a).map(([method, amount]) => {
                  const total = s?.totalRevenue ?? 1;
                  const pct = total > 0 ? Math.round((amount / total) * 100) : 0;
                  return (
                    <div key={method}>
                      <div className="flex justify-between text-sm mb-1">
                        <span className="text-gray-300 capitalize">{method.replace(/_/g, ' ')}</span>
                        <span className="text-white font-medium tabular-nums">{fmt(amount, currency)} <span className="text-gray-500 text-xs">{pct}%</span></span>
                      </div>
                      <div className="h-1 bg-gray-700 rounded-full overflow-hidden">
                        <div className="h-full bg-blue-500 rounded-full" style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
        </Card>

        <Card title="Top sellers — today">
          {topItems.length === 0
            ? <p className="text-gray-500 text-sm">No sales yet today.</p>
            : (
              <div className="divide-y divide-gray-700">
                {topItems.map((p, i) => (
                  <div key={p.name} className="flex items-center justify-between py-2 gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-gray-600 text-xs w-4 tabular-nums">{i + 1}</span>
                      <p className="text-white text-sm truncate">{p.name}</p>
                    </div>
                    <div className="text-right flex-shrink-0">
                      <p className="text-white text-sm font-medium tabular-nums">{fmt(Number(p.revenue), currency)}</p>
                      <p className="text-gray-500 text-xs">{Number(p.qty).toFixed(0)} units</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
        </Card>
      </div>

      {(sales?.hourly?.length ?? 0) > 0 && (
        <Card title="Hourly sales — today">
          <HourlyChart hourly={sales.hourly} currency={currency} />
        </Card>
      )}
    </div>
  );
}

// ── Hourly chart (shared) ─────────────────────────────────────────────────────
function HourlyChart({ hourly, currency }: { hourly: { hour: number; revenue: number; orders: number }[]; currency: string }) {
  const max = Math.max(...hourly.map(h => h.revenue), 1);
  const peakHour = hourly.reduce((b, h) => h.revenue > b.revenue ? h : b, hourly[0]);

  return (
    <>
      <p className="text-xs text-gray-500 mb-3">
        Peak: {peakHour?.hour}:00 · {fmt(peakHour?.revenue ?? 0, currency)} · {peakHour?.orders ?? 0} orders
      </p>
      <div className="flex items-end gap-0.5 h-20">
        {Array.from({ length: 24 }, (_, h) => {
          const row  = hourly.find(r => r.hour === h);
          const pct  = row ? Math.max(4, Math.round((row.revenue / max) * 100)) : 4;
          const isPeak = h === peakHour?.hour;
          return (
            <div key={h} className="flex-1 flex flex-col justify-end h-full"
              title={`${h}:00  ${row ? fmt(row.revenue, currency) : '—'}`}>
              <div style={{ height: `${pct}%` }}
                className={`rounded-sm ${row?.revenue ? (isPeak ? 'bg-blue-500' : 'bg-blue-400/60') : 'bg-gray-700/30'}`} />
            </div>
          );
        })}
      </div>
      <div className="flex justify-between mt-1">
        {[0, 6, 12, 18, 23].map(h => <span key={h} className="text-[9px] text-gray-600">{h}:00</span>)}
      </div>
    </>
  );
}

// ── Orders Tab ────────────────────────────────────────────────────────────────
function OrdersTab({ currency }: { currency: string }) {
  const [orders,  setOrders]  = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    posApi.manager.recentOrders().then(o => { if (live) setOrders(o); }).catch(() => {}).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, []);

  if (loading) return <Spinner />;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold text-white">Recent Orders</h2>
          <p className="text-gray-500 text-sm">Last {orders.length} orders from local storage</p>
        </div>
        <button onClick={() => { setLoading(true); posApi.manager.recentOrders().then(setOrders).catch(() => {}).finally(() => setLoading(false)); }}
          className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-white border border-gray-700 rounded-lg px-3 py-1.5 transition-colors">
          <Icon d={I.refresh} size={14} /> Refresh
        </button>
      </div>

      {orders.length === 0
        ? <div className="text-center py-12 text-gray-500">No orders found in local storage.</div>
        : (
          <div className="bg-gray-800 border border-gray-700 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-700">
                  {['Order #', 'Time', 'Type', 'Payment', 'Total', 'Status'].map(h => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-medium text-gray-500">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-700/50">
                {orders.map(o => {
                  const method = o.payments?.[0]?.method ?? '—';
                  return (
                    <tr key={o.id} className="hover:bg-gray-700/30 transition-colors">
                      <td className="px-4 py-3 font-mono text-xs text-gray-300">{o.order_number}</td>
                      <td className="px-4 py-3 text-gray-400 text-xs whitespace-nowrap">{timeAgo(o.created_at)}</td>
                      <td className="px-4 py-3 text-gray-300 capitalize">{(o.order_type ?? 'retail').replace(/_/g, ' ')}</td>
                      <td className="px-4 py-3 text-gray-300 capitalize">{method.replace(/_/g, ' ')}</td>
                      <td className="px-4 py-3 font-semibold text-white tabular-nums">{fmt(Number(o.total), currency)}</td>
                      <td className="px-4 py-3">
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                          o.status === 'completed' ? 'bg-green-500/15 text-green-400' :
                          o.status === 'voided'    ? 'bg-red-500/15 text-red-400' :
                                                     'bg-gray-700 text-gray-400'
                        }`}>{o.status}</span>
                        {o.sync_status === 'pending' && (
                          <span className="ml-1.5 text-[10px] text-amber-400">not synced</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
    </div>
  );
}

// ── Shift Tab ─────────────────────────────────────────────────────────────────
function ShiftTab({ currency }: { currency: string }) {
  const [report,  setReport]  = useState<ZReport | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    posApi.shift.current().then(r => { if (live) setReport(r); }).catch(() => {}).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, []);

  if (loading) return <Spinner />;

  if (!report) {
    return (
      <div className="text-center py-16">
        <p className="text-gray-400 font-medium">No open shift</p>
        <p className="text-gray-600 text-sm mt-1">A cashier must open a shift from the POS to see shift data here.</p>
      </div>
    );
  }

  const { shift, byMethod, totals } = report;

  return (
    <div className="space-y-4 max-w-2xl">
      <div>
        <h2 className="text-lg font-bold text-white">Current Shift</h2>
        <p className="text-gray-500 text-sm">
          {shift.cashier_name} · opened {timeAgo(shift.opened_at)}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <KpiCard label="Gross sales"   value={fmt(totals.grossSales, currency)} accent />
        <KpiCard label="Orders"        value={String(totals.orderCount)} />
        <KpiCard label="Opening float" value={fmt(shift.opening_float, currency)} />
        <KpiCard label="Expected cash" value={fmt(totals.expectedCash, currency)} />
      </div>

      {/* Payment split */}
      <Card title="Sales by payment method">
        {byMethod.length === 0
          ? <p className="text-gray-500 text-sm">No payments yet this shift.</p>
          : (
            <div className="divide-y divide-gray-700">
              {byMethod.map(m => (
                <div key={m.method} className="flex items-center justify-between py-2.5">
                  <span className="text-gray-300 capitalize text-sm">{m.method.replace(/_/g, ' ')}</span>
                  <div className="text-right">
                    <p className="text-white font-semibold tabular-nums text-sm">{fmt(m.amount, currency)}</p>
                    <p className="text-gray-500 text-xs">{m.orders} order{m.orders !== 1 ? 's' : ''}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
      </Card>

      {totals.voidCount > 0 && (
        <div className="flex items-center gap-2 bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-3">
          <Icon d={I.warning} size={16} cls="text-red-400 flex-shrink-0" />
          <p className="text-red-400 text-sm">{totals.voidCount} void{totals.voidCount !== 1 ? 's' : ''} this shift</p>
        </div>
      )}
    </div>
  );
}

// ── Z-Report Tab ──────────────────────────────────────────────────────────────
function ZReportTab({ businessName, currency }: { businessName: string; currency: string }) {
  const [report,  setReport]  = useState<ZReport | null>(null);
  const [loading, setLoading] = useState(true);
  const printRef = useRef<HTMLDivElement>(null);
  const { settings: printerSettings } = usePrinterSettings();

  useEffect(() => {
    let live = true;
    posApi.shift.current().then(r => { if (live) setReport(r); }).catch(() => {}).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, []);

  const handlePrint = async () => {
    if (!printRef.current) return;
    await printReceipt(printRef.current.innerHTML, printerSettings, `${businessName} — Shift Report`);
  };

  if (loading) return <Spinner />;
  if (!report)  return (
    <div className="text-center py-16">
      <p className="text-gray-400 font-medium">No open shift</p>
      <p className="text-gray-600 text-sm mt-1">Open a shift from the POS first.</p>
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold text-white">Shift Report</h2>
          <p className="text-gray-500 text-sm">Live preview — not a closed Z-report</p>
        </div>
        <button onClick={handlePrint}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-xl transition-colors">
          Print report
        </button>
      </div>
      <div className="bg-white rounded-xl p-4 max-w-sm">
        <ZReportView ref={printRef} report={report} />
      </div>
    </div>
  );
}

// ── Stock Tab ─────────────────────────────────────────────────────────────────
function StockTab({ currency }: { currency: string }) {
  const [stock,   setStock]   = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter,  setFilter]  = useState<'all' | 'low'>('all');

  useEffect(() => {
    let live = true;
    posApi.manager.stockLevels().then(s => { if (live) setStock(s); }).catch(() => {}).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, []);

  if (loading) return <Spinner />;

  const low      = stock.filter(s => s.quantity <= s.low_stock_threshold);
  const visible  = filter === 'low' ? low : stock;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-lg font-bold text-white">Stock Levels</h2>
          <p className="text-gray-500 text-sm">{stock.length} products · {low.length} low or critical</p>
        </div>
        <div className="flex gap-1 bg-gray-800 border border-gray-700 rounded-lg p-1">
          {(['all', 'low'] as const).map(f => (
            <button key={f} onClick={() => setFilter(f)}
              className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                filter === f ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white'
              }`}>
              {f === 'all' ? `All (${stock.length})` : `Low stock (${low.length})`}
            </button>
          ))}
        </div>
      </div>

      {visible.length === 0
        ? <div className="text-center py-12 text-gray-500">
            {filter === 'low' ? 'All stock is healthy.' : 'No products found in local storage.'}
          </div>
        : (
          <div className="bg-gray-800 border border-gray-700 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-700">
                  {['Product', 'Category', 'Qty', 'Threshold', 'Status'].map(h => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-medium text-gray-500">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-700/50">
                {visible.map(s => {
                  const critical = s.quantity === 0 || s.quantity <= Math.floor(s.low_stock_threshold / 2);
                  const isLow    = s.quantity <= s.low_stock_threshold;
                  return (
                    <tr key={s.product_id} className={`hover:bg-gray-700/30 ${critical ? 'bg-red-500/5' : ''}`}>
                      <td className="px-4 py-2.5 text-white font-medium">{s.product_name}</td>
                      <td className="px-4 py-2.5 text-gray-400">{s.category_name ?? '—'}</td>
                      <td className={`px-4 py-2.5 font-semibold tabular-nums ${critical ? 'text-red-400' : isLow ? 'text-amber-400' : 'text-white'}`}>
                        {s.quantity}
                      </td>
                      <td className="px-4 py-2.5 text-gray-500 tabular-nums">{s.low_stock_threshold}</td>
                      <td className="px-4 py-2.5">
                        {critical
                          ? <span className="text-xs px-2 py-0.5 rounded-full bg-red-500/20 text-red-400 font-medium">Critical</span>
                          : isLow
                          ? <span className="text-xs px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-400 font-medium">Low</span>
                          : <span className="text-xs px-2 py-0.5 rounded-full bg-green-500/10 text-green-400">OK</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
    </div>
  );
}

// ── Top Items Tab (restaurant extra) ─────────────────────────────────────────
function TopItemsTab({ currency }: { currency: string }) {
  const [items,   setItems]   = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    posApi.manager.topProducts().then(t => { if (live) setItems(t); }).catch(() => {}).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, []);

  if (loading) return <Spinner />;

  const totalRev = items.reduce((s, i) => s + Number(i.revenue), 0);

  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-lg font-bold text-white">Item Mix — today</h2>
        <p className="text-gray-500 text-sm">Top sellers from local order data · {fmt(totalRev, currency)} total</p>
      </div>

      {items.length === 0
        ? <div className="text-center py-12 text-gray-500">No sales yet today.</div>
        : (
          <div className="bg-gray-800 border border-gray-700 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-700">
                  {['#', 'Item', 'Qty sold', 'Revenue', '% of total'].map(h => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-medium text-gray-500">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-700/50">
                {items.map((item, i) => {
                  const pct = totalRev > 0 ? Math.round((item.revenue / totalRev) * 100) : 0;
                  return (
                    <tr key={item.name} className="hover:bg-gray-700/30">
                      <td className="px-4 py-2.5 text-gray-500 tabular-nums">{i + 1}</td>
                      <td className="px-4 py-2.5 text-white font-medium">{item.name}</td>
                      <td className="px-4 py-2.5 text-gray-300 tabular-nums">{Number(item.qty).toFixed(0)}</td>
                      <td className="px-4 py-2.5 font-semibold text-white tabular-nums">{fmt(Number(item.revenue), currency)}</td>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-2">
                          <div className="w-16 h-1.5 bg-gray-700 rounded-full overflow-hidden">
                            <div className="h-full bg-blue-500 rounded-full" style={{ width: `${pct}%` }} />
                          </div>
                          <span className="text-gray-400 text-xs tabular-nums">{pct}%</span>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
    </div>
  );
}

// ── Main ManagerPage ──────────────────────────────────────────────────────────

interface Props {
  business:  { name: string; currency?: string; type?: string };
  staff:     { role: string | null; branchId: string; branchName: string | null; staff: { name: string } | null };
  onOpenPOS: () => void;   // switch back to till
  onLogout:  () => void;   // end shift → PIN screen
}

export default function ManagerPage({ business, staff, onOpenPOS, onLogout }: Props) {
  const currency     = business.currency ?? 'KES';
  const businessName = business.name;
  const flags        = modeFlags(business.type);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  // Build nav from vertical
  type TabKey = 'overview' | 'orders' | 'shift' | 'zreport' | 'stock' | 'items';

  const navItems: { key: TabKey; label: string; icon: string }[] = [
    { key: 'overview', label: 'Overview',     icon: I.overview },
    { key: 'orders',   label: 'Orders',       icon: I.orders   },
    { key: 'shift',    label: 'Shift',        icon: I.shift    },
    { key: 'zreport',  label: 'Shift Report', icon: I.zreport  },
    ...(flags.isRestaurant ? [{ key: 'items' as TabKey, label: 'Item Mix', icon: I.items }] : []),
    { key: 'stock',    label: 'Stock',        icon: I.stock    },
  ];

  const [active, setActive] = useState<TabKey>('overview');

  function renderContent() {
    switch (active) {
      case 'overview':
        if (flags.isPetrol)     return <PetrolOverview     currency={currency} />;
        if (flags.isRestaurant) return <RestaurantOverview currency={currency} />;
        return <RetailOverview currency={currency} />;
      case 'orders':  return <OrdersTab  currency={currency} />;
      case 'shift':   return <ShiftTab   currency={currency} />;
      case 'zreport': return <ZReportTab businessName={businessName} currency={currency} />;
      case 'items':   return <TopItemsTab currency={currency} />;
      case 'stock':   return <StockTab   currency={currency} />;
      default:        return <RetailOverview currency={currency} />;
    }
  }

  return (
    <div className="flex h-screen bg-gray-950 text-white overflow-hidden">

      {/* Sidebar */}
      <aside className={`flex flex-col bg-gray-900 border-r border-gray-800 transition-all duration-200 flex-shrink-0 ${sidebarOpen ? 'w-52' : 'w-16'}`}>
        {/* Header */}
        <div className="flex items-center gap-3 px-4 h-16 border-b border-gray-800 flex-shrink-0">
          <span className="flex-shrink-0 text-blue-400">
            <Icon d={I.zreport} size={20} />
          </span>
          {sidebarOpen && (
            <div className="min-w-0">
              <p className="text-sm font-bold text-white truncate">{businessName}</p>
              <p className="text-xs text-gray-500 truncate capitalize">{staff.role ?? 'Manager'} · {staff.branchName ?? 'Branch'}</p>
            </div>
          )}
        </div>

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto py-3 px-2 space-y-0.5">
          {navItems.map(item => (
            <button key={item.key} onClick={() => setActive(item.key)}
              title={!sidebarOpen ? item.label : undefined}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all ${
                active === item.key
                  ? 'bg-blue-600/20 text-blue-400 border border-blue-500/30'
                  : 'text-gray-400 hover:bg-gray-800 hover:text-white'
              }`}>
              <Icon d={item.icon} size={18} cls="flex-shrink-0" />
              {sidebarOpen && <span className="truncate">{item.label}</span>}
            </button>
          ))}
        </nav>

        {/* Bottom actions */}
        <div className="border-t border-gray-800 p-3 space-y-1 flex-shrink-0">
          <button onClick={onOpenPOS}
            title={!sidebarOpen ? 'Open POS' : undefined}
            className="w-full flex items-center gap-3 px-3 py-2 rounded-xl text-sm text-gray-400 hover:bg-gray-800 hover:text-white transition-colors">
            <Icon d={I.pos} size={18} cls="flex-shrink-0" />
            {sidebarOpen && <span>Open POS</span>}
          </button>
          <button onClick={onLogout}
            title={!sidebarOpen ? 'Sign out' : undefined}
            className="w-full flex items-center gap-3 px-3 py-2 rounded-xl text-sm text-red-400 hover:bg-red-500/10 transition-colors">
            <Icon d={I.logout} size={18} cls="flex-shrink-0" />
            {sidebarOpen && <span>Sign out</span>}
          </button>
        </div>
      </aside>

      {/* Main */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Topbar */}
        <header className="flex items-center justify-between px-6 h-16 bg-gray-900 border-b border-gray-800 flex-shrink-0">
          <div className="flex items-center gap-4">
            <button onClick={() => setSidebarOpen(o => !o)}
              className="text-gray-500 hover:text-white transition-colors">
              <Icon d={I.menu} size={20} />
            </button>
            <h1 className="text-base font-semibold text-white">
              {navItems.find(n => n.key === active)?.label ?? 'Overview'}
            </h1>
          </div>
          <div className="text-right">
            <p className="text-sm font-medium text-white">{staff.staff?.name ?? 'Manager'}</p>
            <p className="text-xs text-gray-500 capitalize">{staff.role} · {staff.branchName}</p>
          </div>
        </header>

        {/* Content */}
        <main className="flex-1 overflow-y-auto p-6">
          {renderContent()}
        </main>
      </div>
    </div>
  );
}
