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
 *
 * Stock is a web POS (pro) feature (owner, 2026-09-27: "stock should only appear if the web pos is enabled"): the Stock
 * item shows only when the business has the web POS — web access active or in grace, as the cloud reports it on every
 * catalogue pull — AND something tracks stock.
 */

import { useState, useEffect, useRef } from 'react';
import { posApi, ZReport } from '../lib/posApi';
import { MenuTab, StaffTab, CombosTab, ImportTab } from './ManageTabs';
import SettingsPanel from '../components/SettingsPanel';
import ExpenseTypesPanel from '../components/ExpenseTypesPanel';
import { mayAddExpenseType } from '../lib/expenseTypes';
import { buildManagerNav, groupOf, openGroup, type TabKey, type GroupKey } from '../lib/managerNav';
import PrintersScreen from '../screens/PrintersScreen';

// A STATION is a job (Kitchen / Dispatch / Till) and belongs to the business.
// A PRINTER is a machine and belongs to ONE terminal — which is why the
// assignment lives in the till's local database, not on the server. See the
// header of main/print/printWorker.ts.
/**
 * Fallback stations, used ONLY until a business has configured its own.
 *
 * This list used to be the whole story — hardcoded, so a client adding a
 * "Barista" station tomorrow needed a code change, a rebuild and a reinstall on
 * every till. The database has had the right model since migration 44
 * (`print_stations` per business, `category_stations` mapping menu categories
 * to them) and the till already pulls both down and serves them as
 * `stationRouting` with the catalogue — nothing read it.
 *
 * Kept as a fallback rather than deleted, for the same reason ipcHandlers keeps
 * the is_kitchen fallback: a till that upgrades before anyone has configured
 * stations must keep printing exactly as it did yesterday. The first symptom of
 * getting that wrong is a kitchen receiving nothing during service.
 */
const FALLBACK_STATIONS = [
  { id: 'kitchen',  name: 'Kitchen',  kind: 'kitchen'  as const },
  { id: 'dispatch', name: 'Dispatch', kind: 'dispatch' as const },
  { id: 'receipt',  name: 'Till',     kind: 'receipt'  as const },
];
import BranchCloseTab from './BranchCloseTab';
import DayCloseTab from './DayCloseTab';
import MenuWorkbench from './MenuWorkbench';
import MethodDot from '../components/MethodDot';
import { methodColour } from '../../shared/paymentColours';
import ReportRangeBar from '../components/ReportRangeBar';
import type { ReportRangeArg, ShiftSummary, ExpenseRow } from '../lib/posApi';
import { modeFlags } from '../lib/posMode';
import ZReportView from '../components/ZReportView';
import { printShiftReport } from '../lib/printShiftReport';
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
  expenses:  'M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6a2 2 0 002 2zm7-5a2 2 0 11-4 0 2 2 0 014 0z',
  zreport:   'M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z',
  stock:     'M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4',
  items:     'M4 6h16M4 12h16M4 18h7',
  prices:    'M7 7h.01M3 4a1 1 0 011-1h6.586a1 1 0 01.707.293l8 8a2 2 0 010 2.828l-6.586 6.586a2 2 0 01-2.828 0l-8-8A1 1 0 013 10V4z',
  tables:    'M3 10h18M3 14h18M10 4v16M14 4v16M5 4h14a2 2 0 012 2v12a2 2 0 01-2 2H5a2 2 0 01-2-2V6a2 2 0 012-2z',
  logout:    'M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1',
  pos:       'M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17H3a2 2 0 01-2-2V5a2 2 0 012-2h14a2 2 0 012 2v10a2 2 0 01-2 2h-2',
  warning:   'M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z',
  refresh:   'M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15',
  menu:      'M4 6h16M4 12h16M4 18h16',
  staffIcon: 'M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z',
  receipt:   'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h10a2 2 0 012 2v14a2 2 0 01-2 2z',
  printer:   'M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z',
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
      {sub && <p className={`text-xs mt-0.5 ${accent ? 'text-blue-200' : 'text-gray-300'}`}>{sub}</p>}
    </div>
  );
}

/**
 * A349: the money behind the headline revenue — VAT and, where levied, CTL (both reduced by any refund, as the cloud
 * reports them), refunds, tips and discounts. Owner: "does it [CTL] appear on … reports? add it in overview".
 */
// A357 (2026-09-28): `hideVat` where the layout already has a "VAT collected" box above — the owner saw VAT twice on
// the Overview. The strip then carries only what the boxes do not (CTL, refunds, discounts, tips), and is not drawn at
// all when none of those apply.
function MoneyStrip({ s, currency, hideVat = false }: { s: any; currency: string; hideVat?: boolean }) {
  if (!s) return null;
  const extras = s.ctlLevied || (s.totalRefunded ?? 0) > 0 || (s.totalDiscount ?? 0) > 0 || (s.totalTips ?? 0) > 0;
  if (hideVat && !extras) return null;
  const item = (label: string, value: number) => (
    <span className="whitespace-nowrap"><span className="text-gray-400">{label}</span>{' '}
      <span className="text-white font-medium tabular-nums">{fmt(value, currency)}</span></span>
  );
  return (
    <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm bg-gray-800/60 border border-gray-700 rounded-xl px-4 py-2.5">
      {!hideVat && item('VAT', s.totalVat ?? 0)}
      {s.ctlLevied && item('CTL', s.totalCtl ?? 0)}
      {(s.totalRefunded ?? 0) > 0 && item('Refunds', -(s.totalRefunded ?? 0))}
      {(s.totalDiscount ?? 0) > 0 && item('Discounts', s.totalDiscount ?? 0)}
      {(s.totalTips ?? 0) > 0 && item('Tips (not revenue)', s.totalTips ?? 0)}
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
  return <div className="flex items-center justify-center py-12 text-gray-300 text-sm">Loading…</div>;
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
      // A290: settle each independently — a failure in one (e.g. tableOccupancy
      // on an old schema) must NOT blank the KPIs and top sellers. The old shared
      // try/catch zeroed the whole Overview when any single call threw.
      const [s, t, tb] = await Promise.allSettled([
        posApi.manager.salesSummary(),
        posApi.manager.topProducts(),
        posApi.manager.tableOccupancy(),
      ]);
      if (!live) return;
      if (s.status === 'fulfilled') setSales(s.value);
      else console.warn('[Overview] salesSummary failed:', s.reason);
      if (t.status === 'fulfilled') setTopItems(t.value);
      else console.warn('[Overview] topProducts failed:', t.reason);
      if (tb.status === 'fulfilled') setTables(tb.value);
      else console.warn('[Overview] tableOccupancy failed:', tb.reason);
      setLoading(false);
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
      <MoneyStrip s={s} currency={currency} hideVat />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Payment split */}
        <Card title="Payment methods — today">
          {!sales?.paymentMethods || Object.keys(sales.paymentMethods).length === 0
            ? <p className="text-gray-300 text-sm">No payments yet today.</p>
            : (
              <div className="space-y-2">
                {Object.entries(sales.paymentMethods as Record<string, number>)
                  .sort(([, a], [, b]) => b - a)
                  .map(([method, amount]) => {
                    // A349: share of what was PAID (tips included, refunds out) — against revenue a tip pushed it past 100 %.
                    const total = Object.values(sales.paymentMethods as Record<string, number>).reduce((a, b) => a + Number(b), 0);
                    const pct   = total > 0 ? Math.round((amount / total) * 100) : 0;
                    return (
                      <div key={method}>
                        <div className="flex justify-between text-sm mb-1">
                          <span className="text-gray-300 capitalize"><MethodDot method={method} />{method.replace(/_/g, ' ')}</span>
                          <span className="text-white font-medium tabular-nums">{fmt(amount, currency)} <span className="text-gray-300 text-xs">{pct}%</span></span>
                        </div>
                        <div className="h-1 bg-gray-700 rounded-full overflow-hidden">
                          <div className="h-full rounded-full" style={{ width: `${pct}%`, background: methodColour(method).dot }} />
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
            ? <p className="text-gray-300 text-sm">No sales yet today.</p>
            : (
              <div className="divide-y divide-gray-700">
                {topItems.map((p, i) => (
                  <div key={p.name} className="flex items-center justify-between py-2 gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-gray-400 text-xs w-4 tabular-nums">{i + 1}</span>
                      <div className="min-w-0">
                        <p className="text-white text-sm truncate">{p.name}</p>
                        <p className="text-gray-300 text-xs">{Number(p.qty).toFixed(0)} sold</p>
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
                <p className="text-gray-300 text-[10px] mt-0.5">{t.capacity} seats</p>
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
          ? <p className="text-gray-300 text-sm">No pumps configured. Add pumps in server settings.</p>
          : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-700">
                    {['Pump', 'Grade', 'Sold today', 'Revenue', 'Status'].map(h => (
                      <th key={h} className="pb-2 text-left text-xs font-medium text-gray-300 pr-4">{h}</th>
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
                    <td colSpan={2} className="pt-2 text-gray-300">Total</td>
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

      <MoneyStrip s={sales?.summary} currency={currency} />

      {/* Payment split */}
      {sales?.paymentMethods && Object.keys(sales.paymentMethods).length > 0 && (
        <Card title="Payment methods — today">
          <div className="space-y-2">
            {Object.entries(sales.paymentMethods as Record<string, number>)
              .sort(([, a], [, b]) => b - a)
              .map(([method, amount]) => {
                // A349: share of what was PAID (tips included, refunds out).
                const total = Object.values(sales.paymentMethods as Record<string, number>).reduce((a, b) => a + Number(b), 0);
                const pct   = total > 0 ? Math.round((amount / total) * 100) : 0;
                return (
                  <div key={method}>
                    <div className="flex justify-between text-sm mb-1">
                      <span className="text-gray-300 capitalize"><MethodDot method={method} />{method.replace(/_/g, ' ')}</span>
                      <span className="text-white font-medium tabular-nums">{fmt(amount, currency)} <span className="text-gray-300 text-xs">{pct}%</span></span>
                    </div>
                    <div className="h-1 bg-gray-700 rounded-full overflow-hidden">
                      <div className="h-full rounded-full" style={{ width: `${pct}%`, background: methodColour(method).dot }} />
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
      <MoneyStrip s={s} currency={currency} hideVat />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card title="Payment methods — today">
          {!sales?.paymentMethods || Object.keys(sales.paymentMethods).length === 0
            ? <p className="text-gray-300 text-sm">No payments yet.</p>
            : (
              <div className="space-y-2">
                {Object.entries(sales.paymentMethods as Record<string, number>).sort(([, a], [, b]) => b - a).map(([method, amount]) => {
                  // A349: share of what was PAID (tips included, refunds out).
                  const total = Object.values(sales.paymentMethods as Record<string, number>).reduce((a, b) => a + Number(b), 0);
                  const pct = total > 0 ? Math.round((amount / total) * 100) : 0;
                  return (
                    <div key={method}>
                      <div className="flex justify-between text-sm mb-1">
                        <span className="text-gray-300 capitalize"><MethodDot method={method} />{method.replace(/_/g, ' ')}</span>
                        <span className="text-white font-medium tabular-nums">{fmt(amount, currency)} <span className="text-gray-300 text-xs">{pct}%</span></span>
                      </div>
                      <div className="h-1 bg-gray-700 rounded-full overflow-hidden">
                        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: methodColour(method).dot }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
        </Card>

        <Card title="Top sellers — today">
          {topItems.length === 0
            ? <p className="text-gray-300 text-sm">No sales yet today.</p>
            : (
              <div className="divide-y divide-gray-700">
                {topItems.map((p, i) => (
                  <div key={p.name} className="flex items-center justify-between py-2 gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-gray-400 text-xs w-4 tabular-nums">{i + 1}</span>
                      <p className="text-white text-sm truncate">{p.name}</p>
                    </div>
                    <div className="text-right flex-shrink-0">
                      <p className="text-white text-sm font-medium tabular-nums">{fmt(Number(p.revenue), currency)}</p>
                      <p className="text-gray-300 text-xs">{Number(p.qty).toFixed(0)} units</p>
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
      <p className="text-xs text-gray-300 mb-3">
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
        {[0, 6, 12, 18, 23].map(h => <span key={h} className="text-[9px] text-gray-400">{h}:00</span>)}
      </div>
    </>
  );
}

// ── Orders Tab ────────────────────────────────────────────────────────────────
// A small segmented selector, the "like the print option" control the owner
// asked for (A105). Used to fold two sibling tabs into one — Orders/Item Mix and
// Current shift/Shift report — so a manager picks the view inside one nav item
// rather than hunting two.
function SegmentedSelector<T extends string>({ options, value, onChange }: {
  options: { key: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex rounded-lg border border-gray-700 bg-gray-900 p-0.5">
      {options.map(o => (
        <button
          key={o.key}
          onClick={() => onChange(o.key)}
          className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${
            value === o.key ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-gray-200'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// A351: Orders, Item Mix, Current shift and Shift report are the tabs of the Sales page (lib/managerNav.ts); before
// that A105 had put them in pairs under Orders and Shift.
function OrdersTab({ currency }: { currency: string }) {
  const [orders,  setOrders]  = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [range, setRange] = useState<ReportRangeArg>({ preset: 'today' });
  // Cross-sync stage 1 (2026-09-27): this till's own list (local, works offline) or every till at the
  // branch (read from the cloud — owner: "Branch view, read from cloud"). Offline → this till, said so.
  const [scope, setScope] = useState<'till' | 'branch'>('till');
  const [scopeNote, setScopeNote] = useState('');

  // 500 rather than 30: a date range is asked for in order to see the range, and
  // silently showing the newest 30 of a month would be a lie the totals confirm.
  // The CSV export is uncapped — the screen is capped only to stay responsive.
  const fetchOrders = async (r: ReportRangeArg, sc: 'till' | 'branch'): Promise<{ list: any[]; note: string }> => {
    if (sc === 'branch') {
      try { return { list: await posApi.manager.branchOrders({ ...r, limit: 500 }), note: '' }; }
      catch { /* offline or the cloud did not answer — fall through to this till's own list */ }
      return { list: await posApi.manager.recentOrders({ ...r, limit: 500 }),
               note: 'The cloud could not be reached — showing this till only.' };
    }
    return { list: await posApi.manager.recentOrders({ ...r, limit: 500 }), note: '' };
  };
  const load = (r: ReportRangeArg) => {
    setLoading(true);
    fetchOrders(r, scope)
      .then(({ list, note }) => { setOrders(list); setScopeNote(note); }).catch(() => {}).finally(() => setLoading(false));
  };

  useEffect(() => {
    let live = true;
    setLoading(true);
    fetchOrders(range, scope)
      .then(({ list, note }) => { if (live) { setOrders(list); setScopeNote(note); } }).catch(() => {})
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [range.preset, range.from, range.to, scope]);

  const rangeTotal = orders.reduce((s, o) => s + Number(o.total ?? 0), 0);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold text-white">Orders</h2>
          <p className="text-gray-300 text-sm">
            {loading ? 'Loading…' : `${orders.length} order${orders.length === 1 ? '' : 's'} · ${fmt(rangeTotal, currency)}`}
            {orders.length === 500 && <span className="text-amber-400"> · showing first 500, download for all</span>}
          </p>
        </div>
        <button onClick={() => load(range)}
          className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-white border border-gray-700 rounded-lg px-3 py-1.5 transition-colors">
          <Icon d={I.refresh} size={14} /> Refresh
        </button>
      </div>

      <SegmentedSelector
        options={[{ key: 'till', label: 'This till' }, { key: 'branch', label: 'All tills at this branch' }]}
        value={scope}
        onChange={v => setScope(v)}
      />

      <ReportRangeBar value={range} onChange={setRange} exportKind="orders" showDailyReport
        scopeOverride={scope === 'branch' && !scopeNote ? 'All tills at this branch — read from the cloud' : null} />
      {scopeNote && <p data-testid="branch-offline" className="text-[11px] text-amber-400/80">⚠ {scopeNote}</p>}

      {loading && <Spinner />}

      {!loading && orders.length === 0
        ? <div className="text-center py-12 text-gray-300">No orders in this date range.</div>
        : loading ? null : (
          <div className="bg-gray-800 border border-gray-700 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-700">
                  {['Order #', 'Time', 'Type', 'Payment', 'Total', 'Status'].map(h => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-medium text-gray-300">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-700/50">
                {orders.map(o => {
                  const method = o.payments?.[0]?.method ?? '—';
                  return (
                    <tr key={o.id} className="hover:bg-gray-700/30 transition-colors">
                      <td className="px-4 py-3 font-mono text-xs text-gray-300">
                        {o.order_number}
                        {o.origin === 'web' && (
                          <span className="ml-1.5 font-sans text-[10px] px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-400"
                            title="Rung on the web POS on this till's drawer">web</span>
                        )}
                        {scope === 'branch' && !scopeNote && o.this_till && (
                          <span className="ml-1.5 font-sans text-[10px] text-gray-400">this till</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-gray-400 text-xs whitespace-nowrap">{timeAgo(o.created_at)}</td>
                      <td className="px-4 py-3 text-gray-300 capitalize">{(o.order_type ?? 'retail').replace(/_/g, ' ')}</td>
                      <td className="px-4 py-3 text-gray-300 capitalize"><MethodDot method={method} />{method.replace(/_/g, ' ')}</td>
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
    posApi.shift.current({ includeForeign: true }).then(r => { if (live) setReport(r); }).catch(() => {}).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, []);

  if (loading) return <Spinner />;

  if (!report) {
    return (
      <div className="text-center py-16">
        <p className="text-gray-400 font-medium">No open shift</p>
        <p className="text-gray-400 text-sm mt-1">A cashier must open a shift from the POS to see shift data here.</p>
      </div>
    );
  }

  const { shift, byMethod, totals } = report;

  return (
    <div className="space-y-4 max-w-2xl">
      <div>
        <h2 className="text-lg font-bold text-white">Current Shift</h2>
        <p className="text-gray-300 text-sm">
          {shift.cashier_name} · opened {timeAgo(shift.opened_at)}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <KpiCard label="Gross sales"   value={fmt(totals.grossSales, currency)} accent />
        <KpiCard label="Orders"        value={String(totals.orderCount)} />
        <KpiCard label="Opening float" value={fmt(shift.opening_float, currency)} />
        <KpiCard label="Expected cash" value={fmt(totals.expectedCash, currency)} />
      </div>
      {(totals as any).foreign?.orders > 0 && (
        <p data-testid="foreign-note" className="text-gray-300 text-xs">
          Includes {(totals as any).foreign.orders} web POS sale{(totals as any).foreign.orders !== 1 ? 's' : ''} on this drawer
          not yet downloaded to this till — they appear in Orders within about 20 seconds when online.
        </p>
      )}

      {/* Payment split */}
      <Card title="Sales by payment method">
        {byMethod.length === 0
          ? <p className="text-gray-300 text-sm">No payments yet this shift.</p>
          : (
            <div className="divide-y divide-gray-700">
              {byMethod.map(m => (
                <div key={m.method} className="flex items-center justify-between py-2.5">
                  <span className="text-gray-300 capitalize text-sm"><MethodDot method={m.method} />{m.method.replace(/_/g, ' ')}</span>
                  <div className="text-right">
                    <p className="text-white font-semibold tabular-nums text-sm">{fmt(m.amount, currency)}</p>
                    <p className="text-gray-300 text-xs">{m.orders} order{m.orders !== 1 ? 's' : ''}</p>
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
  // 0.6.11 (owner: "I should be able to print previous shift reports"): the open shift's live report
  // AND every past shift this till ran — pick one, see it, print it.
  const [shifts,   setShifts]   = useState<ShiftSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);   // null = the open shift (live)
  const [report,   setReport]   = useState<ZReport | null>(null);
  const [loading,  setLoading]  = useState(true);
  const printRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    posApi.shift.history().then(setShifts).catch(() => setShifts([]));
  }, []);

  useEffect(() => {
    let live = true;
    setLoading(true);
    const load = selected ? posApi.shift.zreport(selected) : posApi.shift.current({ includeForeign: true });
    load.then(r => { if (live) setReport(r); }).catch(() => { if (live) setReport(null); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [selected]);

  const [printMsg, setPrintMsg] = useState('');

  const handlePrint = async () => {
    if (!report) return;
    setPrintMsg('');
    // ESC/POS, like every other document. The HTML route printed roughly a third
    // of this report and stopped — see lib/printShiftReport.ts.
    const r = await printShiftReport(report);
    if (!r.ok) setPrintMsg(r.error ?? 'Could not print the shift report.');
  };

  const past = shifts.filter(x => x.status !== 'open');
  const when = (iso: string | null) =>
    iso ? new Date(iso).toLocaleString('en-KE', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-bold text-white">Shift Report</h2>
          <p className="text-gray-300 text-sm">
            {selected ? 'Z-report of a closed shift' : 'Live preview — not a closed Z-report'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select data-testid="shift-picker" value={selected ?? ''} onChange={e => setSelected(e.target.value || null)}
            className="bg-gray-800 border border-gray-700 text-gray-200 text-sm rounded-lg px-3 py-2">
            <option value="">Current shift (live)</option>
            {past.map(x => (
              <option key={x.id} value={x.id}>
                {when(x.opened_at)} → {when(x.closed_at)} · {x.cashier_name ?? 'Cashier'}
                {x.status === 'closed_unreconciled' ? ' · force-closed' : ''}
              </option>
            ))}
          </select>
          <button onClick={handlePrint} disabled={!report}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-sm font-medium rounded-xl transition-colors">
            Print report
          </button>
        </div>
      </div>
      {past.length === 0 && <p className="text-gray-400 text-xs">No closed shifts on this till yet.</p>}

      {loading ? <Spinner /> : !report ? (
        <div className="text-center py-16">
          <p className="text-gray-400 font-medium">{selected ? 'That shift could not be loaded' : 'No open shift'}</p>
          <p className="text-gray-400 text-sm mt-1">
            {selected ? 'Choose another shift above.' : 'Open a shift from the POS, or choose a previous shift above.'}
          </p>
        </div>
      ) : (
        <div className="bg-white rounded-xl p-4 max-w-sm">
          <ZReportView ref={printRef} report={report} />
          {printMsg && <p className="text-amber-400 text-xs mt-2">⚠ {printMsg}</p>}
        </div>
      )}
    </div>
  );
}

// ── Expenses Tab (0.6.11) ─────────────────────────────────────────────────────
// Owner (2026-09-27): "I should be able to see expenses". Cash this till's drawers paid out, by date range —
// the same rows the shift report deducts. Recorded from the POS (Shift → Expenses); this screen only reads.
function ExpensesTab({ currency, canAddType }: { currency: string; canAddType: boolean }) {
  const [range, setRange] = useState<ReportRangeArg>({ preset: 'today' });
  const [data, setData] = useState<{ rows: ExpenseRow[]; total: number; label: string } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    setLoading(true);
    posApi.expense.range(range).then(d => { if (live) setData(d); }).catch(() => { if (live) setData(null); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [range.preset, range.from, range.to]);

  const rows = data?.rows ?? [];
  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-lg font-bold text-white">Expenses</h2>
        <p className="text-gray-300 text-sm" data-testid="expenses-summary">
          {loading ? 'Loading…' : `${rows.length} expense${rows.length === 1 ? '' : 's'} · ${fmt(data?.total ?? 0, currency)} paid out`}
        </p>
      </div>
      {/* A358: the expense types, and "+ Add type" here as well as in Shift → Expenses (owner, on v0.6.18). */}
      <ExpenseTypesPanel canAdd={canAddType} />
      <ReportRangeBar value={range} onChange={setRange} />
      {loading ? <Spinner /> : rows.length === 0 ? (
        <div className="text-center py-12 text-gray-300">No expenses in this date range. Record one from the POS: Shift → Expenses.</div>
      ) : (
        <div className="bg-gray-800 border border-gray-700 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-700">
                {['When', 'Description', 'Paid by', 'Amount'].map(h => (
                  <th key={h} className={`px-4 py-3 text-xs font-medium text-gray-300 ${h === 'Amount' ? 'text-right' : 'text-left'}`}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-700/50">
              {rows.map(e => (
                <tr key={e.id} className="hover:bg-gray-700/30 transition-colors">
                  <td className="px-4 py-3 text-gray-400 text-xs whitespace-nowrap">
                    {new Date(e.created_at).toLocaleString('en-KE', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                  </td>
                  <td className="px-4 py-3 text-gray-200">
                    {e.description}
                    {e.sync_status !== 'synced' && <span className="ml-1.5 text-[10px] text-amber-400">not synced</span>}
                  </td>
                  <td className="px-4 py-3 text-gray-300">{e.paid_by_name ?? '—'}</td>
                  <td className="px-4 py-3 text-right font-semibold text-white tabular-nums">{fmt(e.amount, currency)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-gray-700">
                <td colSpan={3} className="px-4 py-3 text-gray-300 font-medium">Total</td>
                <td className="px-4 py-3 text-right font-bold text-white tabular-nums">{fmt(data?.total ?? 0, currency)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
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
          <p className="text-gray-300 text-sm">{stock.length} products · {low.length} low or critical</p>
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
        ? <div className="text-center py-12 text-gray-300">
            {filter === 'low' ? 'All stock is healthy.' : 'No products found in local storage.'}
          </div>
        : (
          <div className="bg-gray-800 border border-gray-700 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-700">
                  {['Product', 'Category', 'Qty', 'Threshold', 'Status'].map(h => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-medium text-gray-300">{h}</th>
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
                      <td className="px-4 py-2.5 text-gray-300 tabular-nums">{s.low_stock_threshold}</td>
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
  // A296: Item Mix was hard-wired to today. Give it the same range control as the
  // Orders tab. getTopProducts already accepts a resolved range and the
  // manager:topProducts IPC already resolves the preset (managerReports.ts /
  // ipcHandlers.ts:1795), so this is a renderer wire-up only — no query, handler
  // or schema change. limit lifted 8 -> 50 so a month's mix is not clipped to
  // eight rows, while staying a bounded "top sellers" (never the 500 an order
  // list needs).
  const [range, setRange] = useState<ReportRangeArg>({ preset: 'today' });

  useEffect(() => {
    let live = true;
    setLoading(true);
    posApi.manager.topProducts({ ...range, limit: 50 })
      .then(t => { if (live) setItems(t); }).catch(() => {}).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [range.preset, range.from, range.to]);

  const totalRev = items.reduce((s, i) => s + Number(i.revenue), 0);

  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-lg font-bold text-white">Item Mix</h2>
        <p className="text-gray-300 text-sm">Top sellers from local order data · {fmt(totalRev, currency)} total</p>
      </div>

      <ReportRangeBar value={range} onChange={setRange} exportKind="products" />

      {loading && <Spinner />}

      {!loading && (items.length === 0
        ? <div className="text-center py-12 text-gray-300">No sales in this date range.</div>
        : (
          <div className="bg-gray-800 border border-gray-700 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-700">
                  {['#', 'Item', 'Qty sold', 'Revenue', '% of total'].map(h => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-medium text-gray-300">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-700/50">
                {items.map((item, i) => {
                  const pct = totalRev > 0 ? Math.round((item.revenue / totalRev) * 100) : 0;
                  return (
                    <tr key={item.name} className="hover:bg-gray-700/30">
                      <td className="px-4 py-2.5 text-gray-300 tabular-nums">{i + 1}</td>
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
        ))}
    </div>
  );
}

// ── Main ManagerPage ──────────────────────────────────────────────────────────

interface Props {
  business:  { name: string; currency?: string; type?: string };
  staff:     { role: string | null; branchId: string; branchName: string | null; staff: { name: string } | null };
  onOpenPOS: () => void;   // switch back to till
  onLogout:  () => void;   // end shift → PIN screen
  // Full owner sign-out → email login. Moved off the PIN pad, where any
  // cashier could end the owner session and leave the floor unable to sign
  // back in without the owner's password.
  onSwitchAccount?: () => void;
}

// ── Prices Tab — branch price management (manager = branch authority) ─────────
function PricesTab({ currency }: { currency: string }) {
  const [rows,    setRows]    = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [query,   setQuery]   = useState('');
  const [drafts,  setDrafts]  = useState<Record<string, string>>({});
  const [busy,    setBusy]    = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    posApi.manager.priceList()
      .then(r => { setRows(r as any[]); setDrafts({}); })
      .catch(() => {})
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  if (loading) return <Spinner />;

  const visible = rows.filter(r =>
    r.product_name.toLowerCase().includes(query.toLowerCase()) ||
    (r.category_name ?? '').toLowerCase().includes(query.toLowerCase())
  );
  const overrides = rows.filter(r => r.branch_price !== null).length;

  async function save(r: any) {
    const raw = drafts[r.product_id];
    const price = Number(raw);
    if (raw === undefined || raw === '' || !Number.isFinite(price) || price < 0) return;
    setBusy(r.product_id);
    try { await posApi.manager.setBranchPrice(r.product_id, price); load(); }
    finally { setBusy(null); }
  }
  async function clearOverride(r: any) {
    setBusy(r.product_id);
    try { await posApi.manager.clearBranchPrice(r.product_id); load(); }
    finally { setBusy(null); }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-lg font-bold text-white">Branch Prices</h2>
          <p className="text-gray-300 text-sm">
            {rows.length} products · {overrides} with a branch price
          </p>
        </div>
        <input
          value={query} onChange={e => setQuery(e.target.value)}
          placeholder="Search products…"
          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 w-56"
        />
      </div>

      <div className="bg-blue-500/10 border border-blue-500/30 rounded-xl px-4 py-3 text-sm text-blue-200">
        Prices set here apply to <span className="font-semibold">this branch</span> and take effect on this
        device immediately. A blank override uses the default price. Changes are queued to sync to the
        cloud when web access is on.
      </div>

      {visible.length === 0
        ? <div className="text-center py-12 text-gray-300">No matching products.</div>
        : (
          <div className="bg-gray-800 border border-gray-700 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-700">
                  {['Product', 'Category', 'Default', 'Branch price', ''].map(h => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-medium text-gray-300">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-700/50">
                {visible.map(r => {
                  const hasOverride = r.branch_price !== null;
                  const draft = drafts[r.product_id];
                  return (
                    <tr key={r.product_id} className="hover:bg-gray-700/30">
                      <td className="px-4 py-2.5 text-white font-medium">
                        {r.product_name}
                        {r.pending && (
                          <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-400 align-middle">unsynced</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-gray-400">{r.category_name ?? '—'}</td>
                      <td className="px-4 py-2.5 text-gray-300 tabular-nums">{fmt(r.base_price, currency)}</td>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-2">
                          <span className="text-gray-300 text-xs">{currency}</span>
                          <input
                            type="number" min="0" step="0.01"
                            value={draft !== undefined ? draft : (hasOverride ? String(r.branch_price) : '')}
                            placeholder={String(r.base_price)}
                            onChange={e => setDrafts(d => ({ ...d, [r.product_id]: e.target.value }))}
                            className={`w-28 bg-gray-900 border rounded-lg px-2 py-1 text-sm tabular-nums focus:outline-none focus:border-blue-500 ${hasOverride ? 'border-action-600/50 text-action-300' : 'border-gray-700 text-white'}`}
                          />
                        </div>
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => save(r)}
                            disabled={busy === r.product_id || draft === undefined || draft === ''}
                            className="px-3 py-1 rounded-md text-xs font-medium bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
                            Save
                          </button>
                          {hasOverride && (
                            <button
                              onClick={() => clearOverride(r)}
                              disabled={busy === r.product_id}
                              className="px-3 py-1 rounded-md text-xs font-medium text-red-400 hover:bg-red-500/10 disabled:opacity-40 transition-colors">
                              Clear
                            </button>
                          )}
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
export default function ManagerPage({ business, staff, onOpenPOS, onLogout, onSwitchAccount }: Props) {
  const currency     = business.currency ?? 'KES';
  const businessName = business.name;
  const flags        = modeFlags(business.type);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  /**
   * The business's own print stations, pulled down with the catalogue.
   * Empty until loaded, and empty on a business that has configured none —
   * both fall back to FALLBACK_STATIONS so printing never stops.
   */
  const [escposStations, setEscposStations] = useState<typeof FALLBACK_STATIONS>([]);
  useEffect(() => {
    void (async () => {
      try {
        // The REAL station source is GET /api/stations (print_stations), the same
        // one the Stations tab uses — so both tabs agree. This used to read
        // pos.init().stationRouting, a field the server never actually emits, so
        // the list always collapsed to the single synthetic receipt below and a
        // venue's Kitchen/Dispatch stations vanished from the Printers tab (a
        // configured station showed nowhere to bind a printer). (A89.)
        const rows = await posApi.manage.listStations();
        const live = (rows ?? [])
          .filter(s => s.active !== false)
          .map(s => ({ id: s.id, name: s.name, kind: s.kind }));

        if (live.length === 0) {
          // No stations configured on the server yet. Seed the day-one defaults
          // so the till works offline without a dashboard round-trip (A91). A
          // restaurant gets all three — Kitchen, Dispatch, Till — matching
          // shared/printing's kitchen/dispatch/receipt presets, the incumbent's
          // three-station layout, and the escpos routing fallback
          // (is_kitchen → ids.kitchen, else ids.dispatch), which recognises
          // these built-in ids. A retail shop has no kitchen or dispatch, so it
          // gets the receipt alone. Previously the loader pushed only a synthetic
          // receipt here, collapsing a restaurant's Printers tab to one station
          // and never reaching FALLBACK_STATIONS.
          const seeded = flags.isRestaurant
            ? FALLBACK_STATIONS.map(s => ({ ...s }))
            : FALLBACK_STATIONS.filter(s => s.kind === 'receipt').map(s => ({ ...s }));
          setEscposStations(seeded);
          return;
        }

        // Configured stations exist. EVERY till still needs somewhere to print
        // the customer receipt — if the business defined none, add the receipt
        // fallback (its id matches the escpos:canPrint checks) so a printer can
        // still be bound to it.
        if (!live.some(s => s.kind === 'receipt')) {
          live.push({ id: 'receipt', name: 'Till receipt', kind: 'receipt' });
        }

        setEscposStations(live);
      } catch { /* fallback list stands */ }
    })();
  }, []);

  // Server enforces these too — hiding a tab is a courtesy, not the control.
  const perms = (staff as any)?.permissions ?? {};
  const has = (key: string) => perms['*'] === true || perms[key] === true;
  const canManageProducts = has('products.manage');
  const canManageStaff    = has('staff.manage');
  const canManageSettings = has('settings.manage');
  // A59/A45 · Gate Receipt on the permission KEYS the cloud enforces, not the role.
  // Cloud: business.ts POST /settings → requireAnyPermission('receipt.manage','settings.manage').
  // receipt.manage is granted to manager roles by migration 78; settings.manage
  // covers managers who already hold it, so no current manager loses the tab.
  const canManageReceipt  = has('receipt.manage') || canManageSettings;

  // Closing the trading day is a CASH operation, not a settings one, so it must
  // not hide behind settings.manage. Gated on the same rule dayService.isManager()
  // applies in the main process — role, wildcard, or settings.manage — so the
  // button appears exactly when the action will actually be permitted.
  //
  // This was wrong on first release: the tab was gated on settings.manage alone,
  // so a user whose role IS Manager but who lacks that specific permission saw no
  // Close Day tab at all — and since the day gate blocks the till until the day is
  // closed, that left the terminal with no way out. Same gate is why Receipt and
  // Printers were also missing for that user.
  const MANAGER_ROLES = ['manager', 'supervisor', 'admin', 'branch_manager'];
  const isManagerRole =
    MANAGER_ROLES.includes(String((staff as any)?.role ?? '').toLowerCase())
    || has('settings.manage');

  // Stock only for a business with the web POS (A346), and only once something actually tracks stock.
  const [showStock, setShowStock] = useState(false);
  useEffect(() => {
    let live = true;
    (async () => {
      const cfg = await posApi.config.get().catch(() => null);
      if (cfg?.web_pos_enabled !== true) { if (live) setShowStock(false); return; }
      const rows = await posApi.manager.stockLevels().catch(() => []);
      if (live) setShowStock(Array.isArray(rows) && rows.length > 0);
    })();
    return () => { live = false; };
  }, []);

  // A351 (2026-09-28): the sidebar in groups — Sales, Close and Settings open as one page with tabs across the top.
  // The rules (which tabs each role sees, where a tap lands) live in lib/managerNav.ts; every gate below is the one each
  // page had as its own sidebar item. Why each gate is what it is:
  //  - Close Day / Close Branch — isManagerRole: closing the trading day is a CASH operation and the escape route for
  //    the day gate, so it never hides behind settings.manage alone.
  //  - Printing — stations.manage OR the receipt text (A59/A90). NOT settings.manage, which migration 59 makes
  //    owner/admin-only; re-pointing a printer mid-service sends receipts to the wrong station, so cashiers keep only
  //    the read-only view on the POS screen. PrintersScreen shows the sub-tabs each permission allows.
  //  - Stock — only with the web POS and something stock-tracked (A346).
  //  - Menu — ONE Menu page (prices, combos and import are reached from inside it).
  const nav = buildManagerNav({
    isRestaurant: flags.isRestaurant,
    isManagerRole,
    canManageProducts,
    canManageStaff,
    canManageSettings,
    canPrinting: has('stations.manage') || canManageReceipt,
    showStock,
  });
  const GROUP_ICON: Record<GroupKey, string> = {
    overview: I.overview, sales: I.orders, expenses: I.expenses, close: I.shift,
    menu: I.menu, settings: I.receipt, stock: I.stock,
  };

  const [active, setActive] = useState<TabKey>('overview');
  // The tab last used in each group, so Settings reopens on Printing if that is where the manager was.
  const [lastTab, setLastTab] = useState<Partial<Record<GroupKey, TabKey>>>({});
  const activeGroup = groupOf(nav, active);
  const openTab = (tab: TabKey) => {
    setActive(tab);
    const g = groupOf(nav, tab);
    if (g && g.tabs.some(t => t.key === tab)) setLastTab(prev => ({ ...prev, [g.key]: tab }));
  };

  function renderContent() {
    switch (active) {
      case 'overview':
        if (flags.isPetrol)     return <PetrolOverview     currency={currency} />;
        if (flags.isRestaurant) return <RestaurantOverview currency={currency} />;
        return <RetailOverview currency={currency} />;
      case 'orders':  return <OrdersTab currency={currency} />;
      case 'shift':   return <ShiftTab currency={currency} />;
      case 'expenses': return <ExpensesTab currency={currency} canAddType={mayAddExpenseType(staff as any)} />;
      case 'dayclose': return <DayCloseTab currency={currency} />;
      case 'branchclose': return <BranchCloseTab currency={currency} />;
      // Tabs of Sales (A351): Shift report, Item Mix (restaurant).
      case 'zreport': return <ZReportTab businessName={businessName} currency={currency} />;
      case 'items':   return <TopItemsTab currency={currency} />;
      case 'prices':  return <PricesTab   currency={currency} />;
      case 'menu':    return <MenuWorkbench currency={currency} onOpenImport={() => openTab('import')} />;
      case 'combos':  return <CombosTab  currency={currency} />;
      case 'import':  return <ImportTab  currency={currency} />;
      case 'staff':   return <StaffTab   branchId={staff.branchId} />;
      case 'settings': return <SettingsPanel canEdit={canManageSettings || canManageProducts} />;
      // PrintersScreen (A83/A90): sub-tabs under one "Printing" nav item —
      // Stations, Printers, Exclusions (all stations.manage) and Receipt
      // (receipt.manage/settings.manage). Per-tab gating passed in below.
      case 'printers': return <PrintersScreen
        stations={escposStations.length ? escposStations : FALLBACK_STATIONS}
        canManageStations={has('stations.manage')}
        canManageReceipt={canManageReceipt}
      />;
      case 'stock':   return showStock ? <StockTab currency={currency} /> : <RetailOverview currency={currency} />;
      default:        return <RetailOverview currency={currency} />;
    }
  }

  return (
    <div className="flex h-screen bg-gray-950 text-white overflow-hidden">

      {/* Sidebar */}
      {/* A326: tinted by the business's brand colour (or theme) when themes are ON; the fallback IS gray-900, so OFF is unchanged. */}
      <aside style={{ backgroundColor: 'var(--sidebar-tint, #111827)' }} className={`flex flex-col bg-gray-900 border-r border-gray-800 transition-all duration-200 flex-shrink-0 ${sidebarOpen ? 'w-52' : 'w-16'}`}>
        {/* Header */}
        <div className="flex items-center gap-3 px-4 h-16 border-b border-gray-800 flex-shrink-0">
          <span className="flex-shrink-0 text-blue-400">
            <Icon d={I.zreport} size={20} />
          </span>
          {sidebarOpen && (
            <div className="min-w-0">
              <p className="text-sm font-bold text-white truncate">{businessName}</p>
              <p className="text-xs text-gray-300 truncate capitalize">{staff.role ?? 'Manager'} · {staff.branchName ?? 'Branch'}</p>
            </div>
          )}
        </div>

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto py-3 px-2 space-y-0.5">
          {nav.map(group => (
            <button key={group.key} onClick={() => openTab(openGroup(group, lastTab))}
              title={!sidebarOpen ? group.label : undefined}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all ${
                activeGroup?.key === group.key
                  ? 'bg-blue-600/20 text-blue-400 border border-blue-500/30'
                  : 'text-gray-400 hover:bg-gray-800 hover:text-white'
              }`}>
              <Icon d={GROUP_ICON[group.key]} size={18} cls="flex-shrink-0" />
              {sidebarOpen && <span className="truncate">{group.label}</span>}
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
          {/* This ends the STAFF shift and returns to the PIN pad — it was
              labelled "Sign out", which reads like it signs the business out.
              The owner sign-out below is the one that actually does that. */}
          <button onClick={onLogout}
            title={!sidebarOpen ? 'Lock till' : undefined}
            className="w-full flex items-center gap-3 px-3 py-2 rounded-xl text-sm text-gray-200 hover:bg-gray-800 hover:text-white transition-colors">
            <Icon d={I.logout} size={18} cls="flex-shrink-0" />
            {sidebarOpen && <span>Lock till</span>}
          </button>
          {/* The running build, where someone on the phone can read it out.
              Three tills are updated by hand and drift; "which version are you
              on?" is the first question of any support call and there was
              nowhere to answer it outside the install wizard. */}
          {sidebarOpen && (
            <p className="px-3 pt-1 pb-2 text-[11px] text-gray-400">
              SwiftPOS v{posApi.version} · {posApi.platform}
            </p>
          )}
          {onSwitchAccount && canManageSettings && (
            <button onClick={onSwitchAccount}
              title={!sidebarOpen ? 'Sign out business' : undefined}
              className="w-full flex items-center gap-3 px-3 py-2 rounded-xl text-sm text-red-400 hover:bg-red-500/10 transition-colors">
              <Icon d={I.logout} size={18} cls="flex-shrink-0" />
              {sidebarOpen && <span>Sign out business</span>}
            </button>
          )}
        </div>
      </aside>

      {/* Main */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Topbar */}
        <header className="flex items-center justify-between px-6 h-16 bg-gray-900 border-b border-gray-800 flex-shrink-0">
          <div className="flex items-center gap-4">
            <button onClick={() => setSidebarOpen(o => !o)}
              className="text-gray-300 hover:text-white transition-colors">
              <Icon d={I.menu} size={20} />
            </button>
            <h1 className="text-base font-semibold text-white">
              {activeGroup?.label ?? 'Overview'}
            </h1>
          </div>
          <div className="text-right">
            <p className="text-sm font-medium text-white">{staff.staff?.name ?? 'Manager'}</p>
            <p className="text-xs text-gray-300 capitalize">{staff.role} · {staff.branchName}</p>
          </div>
        </header>

        {/* Content */}
        <main className="flex-1 overflow-y-auto p-6">
          {/* A351: a group's tabs; none when the role sees only one of them. */}
          {activeGroup && activeGroup.tabs.length > 1 && (
            <div className="mb-5">
              <SegmentedSelector options={activeGroup.tabs} value={active} onChange={openTab} />
            </div>
          )}
          {renderContent()}
        </main>
      </div>
    </div>
  );
}
