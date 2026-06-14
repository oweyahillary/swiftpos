/**
 * ManagerDashboard — Branch-scoped dashboard for managers.
 *
 * Auth: SwiftPOS JWT (PIN login via /pos). Route: /manager
 *
 * IMPORTANT: posApi is a new object every render (not memoised in POSAuthContext).
 * Never put posApi in useCallback deps. Call posApi.get() directly inside
 * useEffect and use `// eslint-disable-line` to suppress the lint warning.
 */

import { useState, useEffect, useCallback } from 'react';
import { useNavigate }    from 'react-router-dom';
import { usePOSAuth }     from '../../context/POSAuthContext';
import { useBusiness }    from '../../context/BusinessContext';
import { useBranch }      from '../../context/BranchContext';
import { resolveRoute }   from '../../lib/posRouting';
import POSOrderHistoryTab from '../pos/POSOrderHistoryTab';
import POSInventoryTab    from '../pos/POSInventoryTab';
import POSCustomersTab    from '../pos/POSCustomersTab';
import StaffTab           from '../settings/StaffTab';
import PrintersPage       from '../settings/PrintersPage';
import ManagerReportsPage from './ManagerReportsPage';

// ── SVG icons (no external dependency) ───────────────────────────────────────
function Icon({ d, size = 18, className = '' }: { d: string; size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
      className={className} aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

// Icon path constants
const I = {
  overview:   "M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6",
  reports:    "M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z",
  orders:     "M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2",
  inventory:  "M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4",
  expenses:   "M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z",
  customers:  "M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z",
  credit:     "M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z",
  turnover:   "M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z",
  staff:      "M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z",
  printers:   "M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z",
  pos:        "M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17H3a2 2 0 01-2-2V5a2 2 0 012-2h14a2 2 0 012 2v10a2 2 0 01-2 2h-2",
  logout:     "M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1",
  menu:       "M4 6h16M4 12h16M4 18h16",
  logo:       "M13 10V3L4 14h7v7l9-11h-7z",
  warning:    "M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z",
  revenue:    "M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z",
  tag:        "M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z",
  building:   "M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4",
};


// ── Nav ───────────────────────────────────────────────────────────────────────

interface NavItem { key: string; label: React.ReactNode; permission: string | null; }

const NAV_ITEMS: NavItem[] = [
  { key: 'overview',  label: <><Icon d={I.overview}  className="flex-shrink-0" /><span className="truncate">Overview</span></>,  permission: null },
  { key: 'reports',   label: <><Icon d={I.reports}   className="flex-shrink-0" /><span className="truncate">Reports</span></>,   permission: 'reports.view' },
  { key: 'orders',    label: <><Icon d={I.orders}    className="flex-shrink-0" /><span className="truncate">Orders</span></>,    permission: 'orders.view_all' },
  { key: 'inventory', label: <><Icon d={I.inventory} className="flex-shrink-0" /><span className="truncate">Inventory</span></>, permission: 'inventory.view' },
  { key: 'expenses',  label: <><Icon d={I.expenses}  className="flex-shrink-0" /><span className="truncate">Expenses</span></>,  permission: 'expenses.view' },
  { key: 'customers', label: <><Icon d={I.customers} className="flex-shrink-0" /><span className="truncate">Customers</span></>, permission: 'customers.view' },
  { key: 'credit',    label: <><Icon d={I.credit}    className="flex-shrink-0" /><span className="truncate">Credit</span></>,    permission: 'customers.view' },
  { key: 'turnover',  label: <><Icon d={I.turnover}  className="flex-shrink-0" /><span className="truncate">Turnover</span></>,  permission: 'orders.view_all' },
  { key: 'staff',     label: <><Icon d={I.staff}     className="flex-shrink-0" /><span className="truncate">Staff</span></>,     permission: 'staff.manage' },
  { key: 'printers',  label: <><Icon d={I.printers}  className="flex-shrink-0" /><span className="truncate">Printers</span></>,  permission: 'settings.manage' },
];

// ── Types ─────────────────────────────────────────────────────────────────────

interface SalesSummary {
  summary: {
    totalRevenue: number; totalOrders: number;
    avgOrderValue: number; totalDiscount: number; totalVat: number;
  };
  paymentMethods: Record<string, number>;
  dailySeries: { date: string; revenue: number }[];
}

interface HourlyRow { hour: number; revenue: number; orders: number; }
interface TopProduct { product_id: string; name: string; qty: number; revenue: number; }
interface Shift { id: string; opened_at: string; status: string; opening_float: number; total_revenue?: number; }
interface Expense { id: string; description: string; amount: number; expense_date: string; category_name: string | null; paid_by_name: string | null; }
interface ExpenseCategory { id: string; name: string; }

// ── Helpers ───────────────────────────────────────────────────────────────────

const METHOD_LABELS: Record<string, string> = { cash: 'Cash', mpesa: 'M-Pesa', card: 'Card' };

function fmtNum(currency: string, n: number) {
  return `${currency} ${(n ?? 0).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function fmtShort(currency: string, n: number) {
  if (n >= 1_000_000) return `${currency} ${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${currency} ${(n / 1_000).toFixed(1)}K`;
  return `${currency} ${(n ?? 0).toFixed(0)}`;
}



// ── Parking Station Overview Tab ──────────────────────────────────────────────

function ParkingOverviewTab() {
  const { posApi, session } = usePOSAuth();
  const currency = session?.currency ?? 'KES';
  const today    = new Date().toISOString().slice(0, 10);

  const [sales,    setSales]    = useState<{ summary: { totalRevenue: number; totalOrders: number } } | null>(null);
  const [sessions, setSessions] = useState<any[]>([]);
  const [bays,     setBays]     = useState<any[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState('');

  useEffect(() => {
    if (!session?.branchId) return;
    let cancelled = false;

    async function load() {
      try {
        const p = new URLSearchParams({ from: today, to: today, branch_id: session!.branchId });
        const [salesRes, sessionsRes, baysRes] = await Promise.allSettled([
          posApi.get<any>(`/api/reports/sales?${p}`),
          posApi.get<any[]>(`/api/parking-sessions?branch_id=${session!.branchId}&status=open`),
          posApi.get<any[]>(`/api/tables?branch_id=${session!.branchId}&slot_type=parking_bay`),
        ]);
        if (cancelled) return;
        if (salesRes.status    === 'fulfilled') setSales(salesRes.value);
        if (sessionsRes.status === 'fulfilled') setSessions(sessionsRes.value ?? []);
        if (baysRes.status     === 'fulfilled') setBays(baysRes.value ?? []);
      } catch { if (!cancelled) setError('Could not load parking data.'); }
      finally  { if (!cancelled) setLoading(false); }
    }
    load();
    const interval = setInterval(load, 30_000); // refresh every 30s
    return () => { cancelled = true; clearInterval(interval); };
  }, [session?.branchId]); // eslint-disable-line react-hooks/exhaustive-deps

  const fmtCur  = (n: number) => `${currency} ${n.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const elapsed = (started_at: string) => {
    const mins = Math.floor((Date.now() - new Date(started_at).getTime()) / 60000);
    if (mins < 60) return `${mins}m`;
    return `${Math.floor(mins / 60)}h ${mins % 60}m`;
  };
  const isOverstay = (started_at: string) => {
    return (Date.now() - new Date(started_at).getTime()) > 8 * 3_600_000;
  };

  const occupied      = sessions.length;
  const totalBays     = bays.length;
  const free          = totalBays - occupied;
  const occupancyPct  = totalBays > 0 ? Math.round((occupied / totalBays) * 100) : 0;
  const overstays     = sessions.filter(s => isOverstay(s.started_at));

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-white">Parking Overview</h2>
        <p className="text-gray-500 text-sm mt-0.5">
          {session?.branchName} · Live · refreshes every 30s
        </p>
      </div>

      {error && <div className="bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-3 text-red-400 text-sm">{error}</div>}
      {loading ? (
        <div className="text-gray-500 text-sm py-12 text-center">Loading…</div>
      ) : (
        <>
          {/* Occupancy KPIs */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[
              { label: 'Total Bays',  value: String(totalBays),       color: '#94a3b8' },
              { label: 'Occupied',    value: String(occupied),         color: '#f59e0b' },
              { label: 'Free',        value: String(free),             color: '#22c55e' },
              { label: 'Occupancy',   value: `${occupancyPct}%`,       color: occupancyPct > 80 ? '#ef4444' : '#3b82f6' },
            ].map(k => (
              <div key={k.label} className="bg-gray-800/50 border border-gray-700 rounded-2xl p-4 text-center">
                <p className="text-2xl font-bold" style={{ color: k.color }}>{k.value}</p>
                <p className="text-gray-500 text-xs mt-1">{k.label}</p>
              </div>
            ))}
          </div>

          {/* Occupancy bar */}
          <div className="bg-gray-800/50 border border-gray-700 rounded-2xl p-4">
            <div className="flex justify-between text-xs text-gray-500 mb-2">
              <span>Occupancy</span>
              <span>{occupied} / {totalBays} bays</span>
            </div>
            <div className="h-3 bg-gray-700 rounded-full overflow-hidden">
              <div className="h-full rounded-full transition-all duration-700"
                style={{ width: `${occupancyPct}%`, background: occupancyPct > 80 ? '#ef4444' : occupancyPct > 60 ? '#f59e0b' : '#22c55e' }} />
            </div>
          </div>

          {/* Today's revenue */}
          {sales && (
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-gray-800/50 border border-gray-700 rounded-2xl p-4">
                <p className="text-gray-500 text-xs mb-1">Today's Revenue</p>
                <p className="text-green-400 font-bold text-2xl">{fmtCur(sales.summary.totalRevenue)}</p>
              </div>
              <div className="bg-gray-800/50 border border-gray-700 rounded-2xl p-4">
                <p className="text-gray-500 text-xs mb-1">Sessions Today</p>
                <p className="text-blue-400 font-bold text-2xl">{sales.summary.totalOrders}</p>
              </div>
            </div>
          )}

          {/* Overstay alert */}
          {overstays.length > 0 && (
            <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl px-4 py-3">
              <p className="text-amber-400 font-semibold text-sm mb-1 flex items-center gap-1.5"><Icon d={I.warning} size={14} /> Overstay Alert — {overstays.length} vehicle{overstays.length !== 1 ? 's' : ''} over 8 hours</p>
              <div className="space-y-1">
                {overstays.map(s => (
                  <p key={s.id} className="text-amber-400/70 text-xs">
                    {s.vehicle_plate ?? 'Unknown plate'} — {elapsed(s.started_at)} in bay
                  </p>
                ))}
              </div>
            </div>
          )}

          {/* Active sessions list */}
          {sessions.length > 0 && (
            <div className="bg-gray-800/50 border border-gray-700 rounded-2xl overflow-hidden">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider px-5 py-4 border-b border-gray-700">
                Active Sessions ({sessions.length})
              </p>
              <div className="divide-y divide-gray-800">
                {sessions
                  .sort((a, b) => new Date(a.started_at).getTime() - new Date(b.started_at).getTime())
                  .map(s => {
                    const over = isOverstay(s.started_at);
                    const hrs  = (Date.now() - new Date(s.started_at).getTime()) / 3_600_000;
                    const due  = Math.ceil(hrs) * (s.rate_per_hour ?? 0);
                    return (
                      <div key={s.id} className={`flex items-center gap-3 px-5 py-3 ${over ? 'bg-amber-500/5' : ''}`}>
                        <span className="text-xs font-medium text-gray-400">{s.vehicle_type === 'truck' ? 'Truck' : s.vehicle_type === 'motorbike' ? 'Motorbike' : 'Car'}</span>
                        <div className="flex-1 min-w-0">
                          <p className={`text-sm font-mono font-bold ${over ? 'text-amber-400' : 'text-white'}`}>
                            {s.vehicle_plate ?? '—'}
                          </p>
                          <p className="text-gray-500 text-xs">{elapsed(s.started_at)} · {fmtCur(s.rate_per_hour ?? 0)}/hr</p>
                        </div>
                        <div className="text-right">
                          <p className={`text-sm font-bold tabular-nums ${over ? 'text-amber-400' : 'text-green-400'}`}>{fmtCur(due)}</p>
                          {over && <p className="text-amber-400/60 text-[10px]">OVERSTAY</p>}
                        </div>
                      </div>
                    );
                  })}
              </div>
            </div>
          )}

          {sessions.length === 0 && (
            <div className="text-center py-12 text-gray-600 text-sm">🅿️ No active parking sessions.</div>
          )}
        </>
      )}
    </div>
  );
}

// ── Petrol Station Overview Tab ───────────────────────────────────────────────
// Shown instead of OverviewTab when businessType === 'petrol_station'
// KEY: same rule — call posApi directly inside useEffect, never in useCallback deps.

function PetrolOverviewTab() {
  const { posApi, session } = usePOSAuth();
  const currency = session?.currency ?? 'KES';
  const today    = new Date().toISOString().slice(0, 10);

  const [sales,        setSales]        = useState<{ summary: { totalRevenue: number; totalOrders: number }; grades: { name: string; litres: number; revenue: number }[] } | null>(null);
  const [tanks,        setTanks]        = useState<{ id: string; name: string; capacity_litres: number; current_level: number; reorder_level: number; products: { name: string } | null }[]>([]);
  const [pumps,        setPumps]        = useState<{ id: string; name: string; status: string }[]>([]);
  const [pumpMonitor,  setPumpMonitor]  = useState<any>(null);
  const [loading,      setLoading]      = useState(true);
  const [error,        setError]        = useState('');

  useEffect(() => {
    if (!session?.branchId) return;
    let cancelled = false;

    async function load() {
      try {
        const p = new URLSearchParams({ from: today, to: today, branch_id: session!.branchId });
        const [salesRes, tanksRes, pumpsRes] = await Promise.allSettled([
          posApi.get<any>(`/api/reports/fuel-sales?${p}`),
          posApi.get<any[]>(`/api/fuel-tanks?branch_id=${session!.branchId}`),
          posApi.get<any[]>(`/api/pumps?branch_id=${session!.branchId}`),
        ]);
        // Pump monitor (best-effort)
        try { const pm = await posApi.get<any>(`/api/reports/pump-monitor?branch_id=${session!.branchId}`); if (!cancelled) setPumpMonitor(pm); } catch {}
        if (cancelled) return;
        if (salesRes.status === 'fulfilled') setSales(salesRes.value);
        if (tanksRes.status === 'fulfilled') setTanks(tanksRes.value ?? []);
        if (pumpsRes.status === 'fulfilled') setPumps(pumpsRes.value ?? []);
      } catch { if (!cancelled) setError("Could not load petrol data."); }
      finally  { if (!cancelled) setLoading(false); }
    }
    load();
    return () => { cancelled = true; };
  }, [session?.branchId]); // eslint-disable-line react-hooks/exhaustive-deps

  const GRADE_COLORS: Record<string, string> = { diesel: '#f59e0b', premium: '#a78bfa', petrol: '#22c55e', kerosene: '#06b6d4' };
  function gradeColor(name: string) {
    const n = name.toLowerCase();
    if (n.includes('diesel'))  return GRADE_COLORS.diesel;
    if (n.includes('premium')) return GRADE_COLORS.premium;
    if (n.includes('kero'))    return GRADE_COLORS.kerosene;
    return GRADE_COLORS.petrol;
  }

  const dispensing = pumps.filter(p => p.status === 'dispensing').length;
  const idle       = pumps.filter(p => p.status === 'idle').length;
  const lowTanks   = tanks.filter(t => t.current_level <= t.reorder_level);

  const fmtCur = (n: number) => `${currency} ${n.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const fmtL   = (n: number) => `${n.toLocaleString('en-KE', { maximumFractionDigits: 1 })} L`;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-white">Station Overview</h2>
        <p className="text-gray-500 text-sm mt-0.5">
          {session?.branchName} · {new Date().toLocaleDateString('en-KE', { weekday: 'long', day: 'numeric', month: 'long' })}
        </p>
      </div>

      {error && <div className="bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-3 text-red-400 text-sm">{error}</div>}
      {loading ? (
        <div className="text-gray-500 text-sm py-12 text-center">Loading…</div>
      ) : (
        <>
          {/* Pump status strip */}
          <div className="grid grid-cols-3 gap-3">
            <div className="bg-gray-800/50 border border-gray-700 rounded-2xl p-4 text-center">
              <p className="text-3xl font-bold text-white">{pumps.length}</p>
              <p className="text-gray-500 text-xs mt-1">Total pumps</p>
            </div>
            <div className="bg-amber-500/5 border border-amber-500/20 rounded-2xl p-4 text-center">
              <p className="text-3xl font-bold text-amber-400">{dispensing}</p>
              <p className="text-gray-500 text-xs mt-1">Dispensing</p>
            </div>
            <div className="bg-green-500/5 border border-green-500/20 rounded-2xl p-4 text-center">
              <p className="text-3xl font-bold text-green-400">{idle}</p>
              <p className="text-gray-500 text-xs mt-1">Idle</p>
            </div>
          </div>

          {/* Low stock alert */}
          {lowTanks.length > 0 && (
            <div className="bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-3 flex items-center gap-3">
              <Icon d={I.warning} size={20} className="text-red-400 flex-shrink-0" />
              <div>
                <p className="text-red-400 font-semibold text-sm">Low tank alert</p>
                <p className="text-red-400/70 text-xs">{lowTanks.map(t => t.products?.name ?? t.name).join(', ')} below reorder level</p>
              </div>
            </div>
          )}

          {/* Today's fuel sales */}
          {sales && (
            <div className="bg-gray-800/50 border border-gray-700 rounded-2xl p-5">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-4">Today's Sales</p>
              <div className="grid grid-cols-2 gap-4 mb-4">
                <div>
                  <p className="text-gray-500 text-xs">Revenue</p>
                  <p className="text-green-400 font-bold text-2xl mt-1">{fmtCur(sales.summary.totalRevenue)}</p>
                </div>
                <div>
                  <p className="text-gray-500 text-xs">Transactions</p>
                  <p className="text-white font-bold text-2xl mt-1">{sales.summary.totalOrders}</p>
                </div>
              </div>
              {sales.grades.length > 0 && (
                <div className="space-y-2.5 border-t border-gray-700 pt-4">
                  {sales.grades.map(g => {
                    const maxL = sales.grades[0]?.litres || 1;
                    return (
                      <div key={g.name} className="flex items-center gap-3">
                        <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: gradeColor(g.name) }} />
                        <span className="text-gray-300 text-sm w-24 truncate">{g.name}</span>
                        <div className="flex-1 h-1.5 bg-gray-700 rounded-full overflow-hidden">
                          <div className="h-full rounded-full" style={{ width: `${(g.litres / maxL) * 100}%`, background: gradeColor(g.name) }} />
                        </div>
                        <span className="text-gray-400 text-xs w-20 text-right tabular-nums">{fmtL(g.litres)}</span>
                        <span className="text-white text-sm font-medium w-28 text-right tabular-nums">{fmtCur(g.revenue)}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Tank levels */}
          {tanks.length > 0 && (
            <div className="bg-gray-800/50 border border-gray-700 rounded-2xl p-5">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-4">Tank Levels</p>
              <div className="space-y-4">
                {tanks.map(tank => {
                  const pctLevel = tank.capacity_litres > 0
                    ? Math.min(100, Math.round((tank.current_level / tank.capacity_litres) * 100)) : 0;
                  const isLow  = tank.current_level <= tank.reorder_level;
                  const color  = gradeColor(tank.products?.name ?? '');
                  return (
                    <div key={tank.id}>
                      <div className="flex justify-between text-sm mb-1.5">
                        <div className="flex items-center gap-2">
                          <div className="w-2 h-2 rounded-full" style={{ background: color }} />
                          <span className="text-gray-300">{tank.name}</span>
                          <span className="text-gray-600 text-xs">{tank.products?.name}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          {isLow && <span className="text-[10px] text-red-400 font-bold">LOW</span>}
                          <span className={`font-semibold tabular-nums ${isLow ? 'text-red-400' : 'text-white'}`}>
                            {fmtL(tank.current_level)} <span className="text-gray-600 font-normal text-xs">/ {fmtL(tank.capacity_litres)}</span>
                          </span>
                        </div>
                      </div>
                      <div className="h-2 bg-gray-700 rounded-full overflow-hidden">
                        <div className="h-full rounded-full transition-all" style={{ width: `${pctLevel}%`, background: isLow ? '#ef4444' : color }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Pump monitor table — opening / sold / remaining */}
          {pumpMonitor && pumpMonitor.pumps?.length > 0 && (
            <div className="bg-gray-800/50 border border-gray-700 rounded-2xl overflow-hidden">
              <div className="flex items-center justify-between px-5 py-3.5 border-b border-gray-700">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Pump Monitor</p>
                <div className="flex items-center gap-3 text-xs text-gray-500">
                  <span>{fmtCur(pumpMonitor.totals?.total_revenue_today ?? 0)}</span>
                  <span>{(pumpMonitor.totals?.total_litres_today ?? 0).toFixed(1)} L sold</span>
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-700">
                      {['Pump','Grade','Opening','Sold','Remaining','%','Revenue','Tx','Status'].map(h => (
                        <th key={h} className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-700/50">
                    {(pumpMonitor.pumps as any[]).map((p: any) => {
                      const pct = p.capacity_litres && p.remaining_litres != null
                        ? Math.min(100, Math.round((p.remaining_litres / p.capacity_litres) * 100)) : null;
                      const colour = p.is_low ? 'text-red-400' : (pct ?? 100) < 50 ? 'text-amber-400' : 'text-green-400';
                      const fL = (n: number | null) => n != null ? `${n.toFixed(1)} L` : '—';
                      return (
                        <tr key={p.pump_id} className={p.is_low ? 'bg-red-500/5' : ''}>
                          <td className="px-4 py-3 font-semibold text-white whitespace-nowrap">{p.pump_name}</td>
                          <td className="px-4 py-3 text-gray-400">{p.product_name ?? '—'}</td>
                          <td className="px-4 py-3 text-gray-400 tabular-nums">{fL(p.opening_litres)}</td>
                          <td className="px-4 py-3 text-amber-400 font-medium tabular-nums">{fL(p.sold_litres)}</td>
                          <td className={`px-4 py-3 font-semibold tabular-nums ${colour}`}>
                            {fL(p.remaining_litres)}
                            {p.is_low && <span className="ml-1 text-[10px] bg-red-500/20 text-red-400 px-1.5 py-0.5 rounded-full">LOW</span>}
                          </td>
                          <td className="px-4 py-3">
                            {pct != null && (
                              <div className="flex items-center gap-1.5">
                                <div className="w-12 h-1.5 bg-gray-700 rounded-full overflow-hidden">
                                  <div className={`h-full rounded-full ${p.is_low ? 'bg-red-500' : pct < 50 ? 'bg-amber-400' : 'bg-green-500'}`}
                                    style={{ width: `${pct}%` }} />
                                </div>
                                <span className={`text-xs tabular-nums ${colour}`}>{pct}%</span>
                              </div>
                            )}
                          </td>
                          <td className="px-4 py-3 text-green-400 font-semibold tabular-nums">{fmtCur(p.revenue_today)}</td>
                          <td className="px-4 py-3 text-gray-400 tabular-nums text-center">{p.transactions_today}</td>
                          <td className="px-4 py-3">
                            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                              p.pump_status === 'dispensing' ? 'bg-blue-500/15 text-blue-400' :
                              p.pump_status === 'idle'       ? 'bg-green-500/15 text-green-400' :
                                                               'bg-gray-700 text-gray-400'
                            }`}>{p.pump_status ?? 'idle'}</span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Overview Tab ──────────────────────────────────────────────────────────────
// KEY: do NOT use useCallback for async loaders — posApi is a new object every render.
// Call posApi.get directly inside useEffect to avoid infinite re-render loops.

function OverviewTab() {
  const { posApi, session } = usePOSAuth();
  const currency = session?.currency ?? 'KES';

  const [sales,    setSales]    = useState<SalesSummary | null>(null);
  const [voidAlerts, setVoidAlerts] = useState<{ name: string; voids: number; rate: number }[]>([]);
  const [hourly,   setHourly]   = useState<HourlyRow[]>([]);
  const [topItems, setTopItems] = useState<TopProduct[]>([]);
  const [shift,    setShift]    = useState<Shift | null>(null);
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState('');

  // Single effect — directly call posApi, NOT via useCallback.
  // Deps: only session?.branchId (stable once logged in).
  useEffect(() => {
    if (!session?.branchId) return;

    const today  = new Date().toISOString().slice(0, 10);
    const params = new URLSearchParams({ from: today, to: today, branch_id: session.branchId });
    let cancelled = false;

    async function fetchAll() {
      try {
        // Run all 4 requests in parallel; individual failures don't block others
        const [salesRes, hourlyRes, productsRes, shiftRes] = await Promise.allSettled([
          posApi.get<SalesSummary>(`/api/reports/sales?${params}`),
          posApi.get<{ series: HourlyRow[] }>(`/api/reports/hourly?${params}`),
          posApi.get<{ products: TopProduct[] }>(`/api/reports/products-v2?${params}`),
          posApi.get<Shift | null>('/api/shifts/current'),
          posApi.get<{ voids: { cashier_name: string | null }[]; }>(`/api/reports/voids?${params}`),
          posApi.get<{ staff: { staff_name: string; orders: number; voids: number }[] }>(`/api/reports/staff?${params}`),
        ]);

        if (cancelled) return;

        if (salesRes.status    === 'fulfilled') setSales(salesRes.value);
        if (hourlyRes.status   === 'fulfilled') setHourly(hourlyRes.value?.series ?? []);
        if (productsRes.status === 'fulfilled') {
          const sorted = (productsRes.value?.products ?? []).sort((a, b) => b.qty - a.qty).slice(0, 5);
          setTopItems(sorted);
        }
        if (shiftRes.status === 'fulfilled' && shiftRes.value?.id) {
          setShift(shiftRes.value);
          // Try to load shift detail (may not exist — fail silently)
          try {
            const detail = await posApi.get<Shift>(`/api/shifts/${shiftRes.value.id}`);
            if (!cancelled) setShift(detail);
          } catch { /* use summary data */ }
        }
      } catch {
        if (!cancelled) setError("Could not load overview data.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchAll();
    return () => { cancelled = true; };
  }, [session?.branchId]); // eslint-disable-line react-hooks/exhaustive-deps

  const s = sales?.summary;
  const kpis: { label: string; value: string; icon: React.ReactNode; color: string }[] = [
    { label: "Today's Revenue", value: fmtNum(currency, s?.totalRevenue ?? 0),  icon: <Icon d={I.revenue}  size={20} />, color: '#22c55e' },
    { label: 'Orders',          value: String(s?.totalOrders ?? 0),              icon: <Icon d={I.orders}   size={20} />, color: '#3b82f6' },
    { label: 'Avg Order',       value: fmtNum(currency, s?.avgOrderValue ?? 0),  icon: <Icon d={I.reports}  size={20} />, color: '#a855f7' },
    { label: 'VAT Collected',   value: fmtNum(currency, s?.totalVat ?? 0),       icon: <Icon d={I.building} size={20} />, color: '#f59e0b' },
    { label: 'Discounts',       value: fmtNum(currency, s?.totalDiscount ?? 0),  icon: <Icon d={I.tag}      size={20} />, color: '#ef4444' },
  ];

  // Shift SPLH
  const shiftHours   = shift?.opened_at ? (Date.now() - new Date(shift.opened_at).getTime()) / 3_600_000 : 0;
  const shiftRevenue = (shift as any)?.total_revenue ?? 0;
  const splh         = shiftHours > 0.1 ? shiftRevenue / shiftHours : 0;

  // Hourly chart — last 12 hours
  const nowHour    = new Date().getHours();
  const hours12    = Array.from({ length: 12 }, (_, i) => (nowHour - 11 + i + 24) % 24);
  const hourMap    = Object.fromEntries(hourly.map(h => [h.hour, h]));
  const maxRevenue = hourly.reduce((m, h) => Math.max(m, h.revenue), 1);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-white">Branch Overview</h2>
        <p className="text-gray-500 text-sm mt-0.5">
          {session?.branchName} · {new Date().toLocaleDateString('en-KE', { weekday: 'long', day: 'numeric', month: 'long' })}
        </p>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-3 text-red-400 text-sm">{error}</div>
      )}

      {loading ? (
        <div className="text-gray-500 text-sm py-12 text-center">Loading today's data…</div>
      ) : (
        <>
          {/* KPI cards */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            {kpis.map(k => (
              <div key={k.label} className="bg-gray-800/50 border border-gray-700 rounded-2xl p-4">
                <div className="text-xl mb-2">{k.icon}</div>
                <div className="text-xl font-bold" style={{ color: k.color }}>{k.value}</div>
                <div className="text-gray-500 text-xs mt-1">{k.label}</div>
              </div>
            ))}
          </div>

          {/* ── Void Rate Fraud Alert ─────────────────────────────────────── */}
          {voidAlerts.length > 0 && (
            <div className="bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-3">
              <p className="text-red-400 font-semibold text-sm mb-2 flex items-center gap-1.5">
                <Icon d={I.warning} size={14} />
                High void rate detected — {voidAlerts.length} cashier{voidAlerts.length !== 1 ? 's' : ''}
              </p>
              <div className="space-y-1.5">
                {voidAlerts.map((a, i) => (
                  <div key={i} className="flex items-center justify-between">
                    <span className="text-red-300 text-sm">{a.name}</span>
                    <div className="flex items-center gap-2">
                      <span className="text-red-400 text-xs font-semibold">{a.voids} void{a.voids !== 1 ? 's' : ''}</span>
                      <span className="text-red-400/60 text-xs">({a.rate}% of orders)</span>
                    </div>
                  </div>
                ))}
              </div>
              <p className="text-red-400/50 text-xs mt-2">Review in Reports → Voids & Exceptions</p>
            </div>
          )}

          {/* Active shift + SPLH */}
          {shift && shift.status === 'open' && (
            <div className="bg-blue-500/5 border border-blue-500/20 rounded-2xl p-4">
              <div className="flex items-center justify-between mb-3">
                <p className="text-xs font-semibold text-blue-400 uppercase tracking-wider">
                  Active Shift — {session?.staffName}
                </p>
                <span className="text-xs text-green-400 font-semibold">● Open</span>
              </div>
              <div className="grid grid-cols-3 gap-4 text-center">
                <div>
                  <p className="text-gray-500 text-xs">Hours open</p>
                  <p className="text-white font-bold text-lg">{shiftHours.toFixed(1)}h</p>
                </div>
                <div>
                  <p className="text-gray-500 text-xs">Shift revenue</p>
                  <p className="text-white font-bold text-lg">{fmtShort(currency, shiftRevenue)}</p>
                </div>
                <div>
                  <p className="text-gray-500 text-xs">SPLH</p>
                  <p className={`font-bold text-lg ${splh >= 2000 ? 'text-green-400' : splh >= 800 ? 'text-amber-400' : 'text-gray-400'}`}>
                    {splh > 0 ? fmtShort(currency, splh) + '/hr' : '—'}
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Hourly chart + Top items */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            {hourly.length > 0 && (
              <div className="lg:col-span-2 bg-gray-800/50 border border-gray-700 rounded-2xl p-5">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-4">
                  Hourly Sales — Today
                </p>
                <div className="flex items-end gap-1 h-20">
                  {hours12.map(h => {
                    const d   = hourMap[h];
                    const pct = d ? (d.revenue / maxRevenue) * 100 : 0;
                    return (
                      <div key={h} className="flex-1 flex flex-col items-center gap-1">
                        <div
                          className="w-full rounded-t-sm"
                          style={{
                            height: `${Math.max(2, pct)}%`,
                            background: h === nowHour ? '#3b82f6' : '#374151',
                            minHeight: 2,
                          }}
                        />
                        <span className="text-[9px] text-gray-600">{h}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {topItems.length > 0 && (
              <div className="bg-gray-800/50 border border-gray-700 rounded-2xl p-5">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">Top Items Today</p>
                <div className="space-y-2.5">
                  {topItems.map((p, i) => (
                    <div key={p.product_id} className="flex items-center gap-2">
                      <span className="text-[10px] text-gray-600 w-4">{i + 1}</span>
                      <div className="flex-1 min-w-0">
                        <p className="text-white text-xs font-medium truncate">{p.name}</p>
                        <p className="text-gray-500 text-[10px]">{p.qty} sold</p>
                      </div>
                      <span className="text-xs text-gray-400 flex-shrink-0">{fmtShort(currency, p.revenue)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Payment methods */}
          {sales && Object.keys(sales.paymentMethods).length > 0 && (
            <div className="bg-gray-800/50 border border-gray-700 rounded-2xl p-5">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">
                Payment Methods — Today
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                {Object.entries(sales.paymentMethods)
                  .sort((a, b) => b[1] - a[1])
                  .map(([method, amount]) => {
                    const pct = s?.totalRevenue ? Math.round((amount / s.totalRevenue) * 100) : 0;
                    return (
                      <div key={method}>
                        <div className="flex justify-between text-sm mb-1">
                          <span className="text-gray-300">{METHOD_LABELS[method] ?? method}</span>
                          <span className="text-white font-medium">{fmtNum(currency, amount)}</span>
                        </div>
                        <div className="h-1.5 bg-gray-700 rounded-full overflow-hidden">
                          <div className="h-full bg-blue-500 rounded-full" style={{ width: `${pct}%` }} />
                        </div>
                        <p className="text-xs text-gray-600 mt-0.5 text-right">{pct}%</p>
                      </div>
                    );
                  })}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Expenses Tab ──────────────────────────────────────────────────────────────

function POSExpensesTab({ currency }: { currency: string }) {
  const { posApi, session, hasPermission } = usePOSAuth();
  const canManage = hasPermission('expenses.manage');
  const todayStr  = new Date().toISOString().slice(0, 10);

  const [expenses, setExpenses]     = useState<Expense[]>([]);
  const [categories, setCategories] = useState<ExpenseCategory[]>([]);
  const [total, setTotal]           = useState(0);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState('');
  const [from, setFrom] = useState(todayStr);
  const [to,   setTo]   = useState(todayStr);
  const [showForm, setShowForm]       = useState(false);
  const [formDesc, setFormDesc]       = useState('');
  const [formAmount, setFormAmount]   = useState('');
  const [formCat, setFormCat]         = useState('');
  const [formDate, setFormDate]       = useState(todayStr);
  const [formLoading, setFormLoading] = useState(false);
  const [formError, setFormError]     = useState('');

  const load = useCallback(async (f = from, t = to) => {
    setLoading(true); setError('');
    try {
      const params = new URLSearchParams({ from: f, to: t });
      if (session?.branchId) params.set('branch_id', session.branchId);
      const res = await posApi.get<{ expenses: Expense[]; total: number }>(`/api/expenses?${params}`);
      setExpenses(res.expenses ?? []);
      setTotal(res.total ?? 0);
    } catch (e: any) { setError(e?.message ?? 'Failed to load expenses'); }
    finally { setLoading(false); }
  }, [posApi, session?.branchId]); // eslint-disable-line

  useEffect(() => {
    posApi.get<ExpenseCategory[]>('/api/expenses/categories').then(d => setCategories(d ?? [])).catch(() => {});
    load();
  }, []); // eslint-disable-line

  const handleAdd = async () => {
    if (!formDesc.trim())    { setFormError('Description is required'); return; }
    if (!formAmount || Number(formAmount) <= 0) { setFormError('Enter a valid amount'); return; }
    setFormLoading(true); setFormError('');
    try {
      await posApi.post('/api/expenses', {
        branch_id: session?.branchId, description: formDesc.trim(),
        amount: Number(formAmount), expense_category_id: formCat || undefined, expense_date: formDate,
      });
      setFormDesc(''); setFormAmount(''); setFormCat(''); setFormDate(todayStr);
      setShowForm(false); load(from, to);
    } catch (e: any) { setFormError(e?.message ?? 'Failed to save'); }
    finally { setFormLoading(false); }
  };

  const fmtE = (n: number) => `${currency} ${Number(n).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-xl font-bold text-white">Expenses</h2>
          <p className="text-gray-500 text-sm mt-0.5">Branch spending for {session?.branchName}</p>
        </div>
        {canManage && (
          <button onClick={() => setShowForm(true)}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold rounded-xl transition-colors">
            + Add Expense
          </button>
        )}
      </div>
      <div className="flex gap-3 items-end flex-wrap">
        {[{ label: 'From', val: from, set: setFrom }, { label: 'To', val: to, set: setTo }].map(({ label, val, set }) => (
          <div key={label} className="flex flex-col gap-1">
            <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide">{label}</label>
            <input type="date" value={val} onChange={e => set(e.target.value)}
              className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500" />
          </div>
        ))}
        <button onClick={() => load(from, to)} disabled={loading}
          className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50">
          Apply
        </button>
      </div>
      {!loading && (
        <div className="bg-gray-800/50 border border-gray-700 rounded-xl px-4 py-3 flex items-center justify-between">
          <span className="text-gray-400 text-sm">Total — {from === to ? from : `${from} → ${to}`}</span>
          <span className="text-red-400 font-bold text-lg">{fmtE(total)}</span>
        </div>
      )}
      {error && <div className="bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-3 text-red-400 text-sm">{error}</div>}
      {loading && <div className="text-gray-500 text-sm py-12 text-center">Loading…</div>}
      {!loading && expenses.length === 0 && (
        <div className="text-gray-600 text-sm py-12 text-center">No expenses for this period.</div>
      )}
      <div className="space-y-2">
        {expenses.map(e => (
          <div key={e.id} className="flex items-center justify-between bg-gray-800/50 border border-gray-700 rounded-xl px-4 py-3 gap-3">
            <div className="flex-1 min-w-0">
              <p className="text-white text-sm font-medium truncate">{e.description}</p>
              <p className="text-gray-500 text-xs mt-0.5">
                {e.expense_date}{e.category_name ? ` · ${e.category_name}` : ''}
              </p>
            </div>
            <span className="text-red-400 font-semibold text-sm">{fmtE(e.amount)}</span>
          </div>
        ))}
      </div>
      {showForm && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-md p-6 space-y-4">
            <h3 className="text-white font-semibold text-lg">Add Expense</h3>
            <div>
              <label className="block text-sm text-gray-400 mb-1">Description</label>
              <input value={formDesc} onChange={e => setFormDesc(e.target.value)} placeholder="e.g. Cleaning supplies"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm text-gray-400 mb-1">Amount ({currency})</label>
                <input type="number" min="0" value={formAmount} onChange={e => setFormAmount(e.target.value)}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500" />
              </div>
              <div>
                <label className="block text-sm text-gray-400 mb-1">Date</label>
                <input type="date" value={formDate} onChange={e => setFormDate(e.target.value)}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500" />
              </div>
            </div>
            {categories.length > 0 && (
              <div>
                <label className="block text-sm text-gray-400 mb-1">Category (optional)</label>
                <select value={formCat} onChange={e => setFormCat(e.target.value)}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500">
                  <option value="">— None —</option>
                  {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
            )}
            {formError && <p className="text-red-400 text-sm">{formError}</p>}
            <div className="flex gap-3 pt-1">
              <button onClick={() => { setShowForm(false); setFormError(''); }}
                className="flex-1 bg-gray-800 hover:bg-gray-700 text-white rounded-xl py-2.5 text-sm transition-colors">Cancel</button>
              <button onClick={handleAdd} disabled={formLoading}
                className="flex-1 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-xl py-2.5 text-sm font-semibold transition-colors">
                {formLoading ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Loading state for tabs that need branchSynced ─────────────────────────────

function BranchLoading() {
  return (
    <div className="flex items-center justify-center py-20 gap-3 text-gray-500 text-sm">
      <span className="inline-block w-4 h-4 border-2 border-gray-600 border-t-blue-500 rounded-full animate-spin" />
      Syncing branch…
    </div>
  );
}

// ── Credit Accounts Tab (branch-operational; uses POS/PIN auth) ──────────────
interface MCreditCustomer {
  id: string; name: string; phone: string | null;
  credit_limit: number; credit_balance: number; available_credit: number; status: string;
}
interface MLedgerRow {
  id: string; type: 'charge' | 'payment' | 'adjustment';
  amount: number; balance_after: number; method: string | null;
  reference: string | null; notes: string | null; order_id: string | null; created_at: string;
}

function ManagerCreditTab({ currency }: { currency: string }) {
  const { posApi, hasPermission } = usePOSAuth();
  const canManage = hasPermission('customers.manage');
  const fmt = (n: number) => `${currency} ${Number(n).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const [rows, setRows] = useState<MCreditCustomer[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<MCreditCustomer | null>(null);
  const [ledger, setLedger] = useState<MLedgerRow[]>([]);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [limit, setLimit] = useState('');
  const [payAmount, setPayAmount] = useState('');
  const [payMethod, setPayMethod] = useState('cash');
  const [payRef, setPayRef] = useState('');
  const [adjAmount, setAdjAmount] = useState('');
  const [adjNotes, setAdjNotes] = useState('');
  const [busy, setBusy] = useState(false);

  const loadList = useCallback(async () => {
    setLoading(true);
    try {
      const data = await posApi.get<MCreditCustomer[]>(`/api/credit/customers${search ? `?search=${encodeURIComponent(search)}` : ''}`);
      setRows(data ?? []);
    } catch (e: any) { setMsg({ kind: 'err', text: e?.message ?? 'Failed to load' }); }
    finally { setLoading(false); }
  }, [posApi, search]);
  useEffect(() => { loadList(); }, [loadList]);

  const openCustomer = async (c: MCreditCustomer) => {
    setSelected(c); setLimit(String(c.credit_limit)); setMsg(null);
    setPayAmount(''); setPayRef(''); setAdjAmount(''); setAdjNotes('');
    try {
      const { customer, ledger } = await posApi.get<{ customer: MCreditCustomer; ledger: MLedgerRow[] }>(`/api/credit/customer/${c.id}`);
      setSelected(customer); setLimit(String(customer.credit_limit)); setLedger(ledger ?? []);
    } catch (e: any) { setMsg({ kind: 'err', text: e?.message ?? 'Failed to load account' }); }
  };
  const refreshSelected = async () => {
    if (!selected) return;
    const { customer, ledger } = await posApi.get<{ customer: MCreditCustomer; ledger: MLedgerRow[] }>(`/api/credit/customer/${selected.id}`);
    setSelected(customer); setLimit(String(customer.credit_limit)); setLedger(ledger ?? []);
    await loadList();
  };
  const saveLimit = async () => {
    if (!selected) return; setBusy(true); setMsg(null);
    try { await posApi.patch(`/api/credit/customer/${selected.id}/limit`, { credit_limit: Number(limit) || 0 }); setMsg({ kind: 'ok', text: 'Limit updated' }); await refreshSelected(); }
    catch (e: any) { setMsg({ kind: 'err', text: e?.message ?? 'Failed' }); } finally { setBusy(false); }
  };
  const recordPayment = async () => {
    if (!selected) return; const amt = Number(payAmount);
    if (!(amt > 0)) { setMsg({ kind: 'err', text: 'Enter a positive amount' }); return; }
    setBusy(true); setMsg(null);
    try { await posApi.post(`/api/credit/customer/${selected.id}/payment`, { amount: amt, method: payMethod, reference: payRef.trim() || null }); setMsg({ kind: 'ok', text: 'Payment recorded' }); setPayAmount(''); setPayRef(''); await refreshSelected(); }
    catch (e: any) { setMsg({ kind: 'err', text: e?.message ?? 'Failed' }); } finally { setBusy(false); }
  };
  const postAdjustment = async () => {
    if (!selected) return; const amt = Number(adjAmount);
    if (!amt) { setMsg({ kind: 'err', text: 'Enter a non-zero amount' }); return; }
    if (!adjNotes.trim()) { setMsg({ kind: 'err', text: 'A reason is required' }); return; }
    setBusy(true); setMsg(null);
    try { await posApi.post(`/api/credit/customer/${selected.id}/adjustment`, { amount: amt, notes: adjNotes.trim() }); setMsg({ kind: 'ok', text: 'Adjustment posted' }); setAdjAmount(''); setAdjNotes(''); await refreshSelected(); }
    catch (e: any) { setMsg({ kind: 'err', text: e?.message ?? 'Failed' }); } finally { setBusy(false); }
  };

  const totalOwed = rows.reduce((s, r) => s + Number(r.credit_balance), 0);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-white">Credit Accounts</h2>
          <p className="text-gray-500 text-sm mt-0.5">Customers buying on account · total outstanding {fmt(totalOwed)}</p>
        </div>
      </div>
      <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search by name…"
        className="w-full max-w-sm bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-white placeholder-gray-600" />
      {msg && !selected && <div className={`px-4 py-2.5 rounded-lg text-sm ${msg.kind === 'ok' ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400'}`}>{msg.text}</div>}
      {loading ? <p className="text-gray-500">Loading…</p> : rows.length === 0 ? (
        <p className="text-gray-500">No credit customers yet.</p>
      ) : (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead><tr className="text-gray-500 text-left text-xs border-b border-gray-800">
              <th className="p-3">Customer</th><th className="p-3">Phone</th>
              <th className="p-3 text-right">Limit</th><th className="p-3 text-right">Owed</th>
              <th className="p-3 text-right">Available</th><th className="p-3"></th>
            </tr></thead>
            <tbody>
              {rows.map(c => (
                <tr key={c.id} className="border-b border-gray-800 hover:bg-gray-800/50">
                  <td className="p-3 text-white">{c.name}</td>
                  <td className="p-3 text-gray-400">{c.phone ?? '—'}</td>
                  <td className="p-3 text-right text-gray-300">{fmt(c.credit_limit)}</td>
                  <td className={`p-3 text-right font-medium ${Number(c.credit_balance) > 0 ? 'text-yellow-400' : 'text-gray-500'}`}>{fmt(c.credit_balance)}</td>
                  <td className="p-3 text-right text-gray-300">{fmt(c.available_credit)}</td>
                  <td className="p-3 text-right"><button onClick={() => openCustomer(c)} className="text-green-400 hover:text-green-300 text-xs">Manage →</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selected && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={() => setSelected(null)}>
          <div className="bg-gray-900 border border-gray-800 rounded-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <div><h3 className="text-lg font-bold text-white">{selected.name}</h3><p className="text-xs text-gray-500">{selected.phone ?? 'no phone'}</p></div>
              <button onClick={() => setSelected(null)} className="text-gray-500 hover:text-white">✕</button>
            </div>
            {msg && <div className={`mb-4 px-4 py-2.5 rounded-lg text-sm ${msg.kind === 'ok' ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400'}`}>{msg.text}</div>}
            <div className="grid grid-cols-3 gap-3 mb-5">
              <div className="bg-gray-800 rounded-lg p-3"><p className="text-xs text-gray-500">Limit</p><p className="text-white font-semibold">{fmt(selected.credit_limit)}</p></div>
              <div className="bg-gray-800 rounded-lg p-3"><p className="text-xs text-gray-500">Owed</p><p className="text-yellow-400 font-semibold">{fmt(selected.credit_balance)}</p></div>
              <div className="bg-gray-800 rounded-lg p-3"><p className="text-xs text-gray-500">Available</p><p className="text-green-400 font-semibold">{fmt(selected.available_credit)}</p></div>
            </div>
            {canManage && (
              <>
                <div className="flex items-end gap-2 mb-4">
                  <div className="flex-1"><label className="block text-sm text-gray-400 mb-1.5">Credit limit</label>
                    <input type="number" value={limit} onChange={e => setLimit(e.target.value)} min={0} className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-white" /></div>
                  <button onClick={saveLimit} disabled={busy} className="px-4 py-2.5 bg-green-600 hover:bg-green-500 disabled:opacity-50 text-white rounded-lg text-sm">Save</button>
                </div>
                <div className="bg-gray-800/50 rounded-lg p-4 mb-4">
                  <p className="text-white font-medium text-sm mb-3">Record repayment</p>
                  <div className="grid grid-cols-3 gap-2 mb-2">
                    <input type="number" value={payAmount} onChange={e => setPayAmount(e.target.value)} placeholder="Amount" min={0} className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white placeholder-gray-600" />
                    <select value={payMethod} onChange={e => setPayMethod(e.target.value)} className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white"><option value="cash">Cash</option><option value="mpesa">M-Pesa</option><option value="card">Card</option></select>
                    <input value={payRef} onChange={e => setPayRef(e.target.value)} placeholder="Ref (optional)" className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white placeholder-gray-600" />
                  </div>
                  <button onClick={recordPayment} disabled={busy} className="px-4 py-2 bg-green-600 hover:bg-green-500 disabled:opacity-50 text-white rounded-lg text-sm">Record payment</button>
                </div>
                <div className="bg-gray-800/50 rounded-lg p-4 mb-5">
                  <p className="text-white font-medium text-sm mb-1">Manual adjustment</p>
                  <p className="text-xs text-gray-500 mb-3">Negative reduces balance, positive increases. Reason required.</p>
                  <div className="grid grid-cols-3 gap-2 mb-2">
                    <input type="number" value={adjAmount} onChange={e => setAdjAmount(e.target.value)} placeholder="+/- amount" className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white placeholder-gray-600" />
                    <input value={adjNotes} onChange={e => setAdjNotes(e.target.value)} placeholder="Reason" className="col-span-2 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white placeholder-gray-600" />
                  </div>
                  <button onClick={postAdjustment} disabled={busy} className="px-4 py-2 bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white rounded-lg text-sm">Post adjustment</button>
                </div>
              </>
            )}
            <p className="text-white font-medium text-sm mb-2">Statement</p>
            {ledger.length === 0 ? <p className="text-gray-500 text-sm">No transactions.</p> : (
              <table className="w-full text-sm">
                <thead><tr className="text-gray-500 text-left text-xs"><th className="pb-2">Date</th><th className="pb-2">Type</th><th className="pb-2 text-right">Amount</th><th className="pb-2 text-right">Balance</th><th className="pb-2">Note</th></tr></thead>
                <tbody>
                  {ledger.map(l => (
                    <tr key={l.id} className="border-t border-gray-800">
                      <td className="py-2 text-gray-500">{new Date(l.created_at).toLocaleDateString('en-KE')}</td>
                      <td className="py-2 capitalize text-gray-300">{l.type}</td>
                      <td className={`py-2 text-right ${Number(l.amount) > 0 ? 'text-yellow-400' : 'text-green-400'}`}>{Number(l.amount) > 0 ? '+' : ''}{fmt(l.amount)}</td>
                      <td className="py-2 text-right text-gray-300">{fmt(l.balance_after)}</td>
                      <td className="py-2 text-gray-500">{l.method ?? l.notes ?? (l.order_id ? 'sale' : '')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Table Turnover Tab (branch-operational; uses POS/PIN auth) ───────────────
interface MLiveRow { order_id: string; table_number: string | null; covers: number; seated_at: string | null; minutes_seated: number; over: boolean; }
interface MReportRow { table_number: string; covers_served: number; avg_minutes: number; }

function ManagerTurnoverTab() {
  const { posApi, session } = usePOSAuth();
  const branchId = session?.branchId;
  const [tab, setTab] = useState<'live' | 'report'>('live');
  const [threshold, setThreshold] = useState(90);
  const [live, setLive] = useState<MLiveRow[]>([]);
  const [report, setReport] = useState<MReportRow[]>([]);
  const [loading, setLoading] = useState(true);
  const hm = (mins: number) => { const h = Math.floor(mins / 60), m = mins % 60; return h > 0 ? `${h}h ${m}m` : `${m}m`; };

  const loadLive = useCallback(async () => {
    if (!branchId) { setLoading(false); return; }
    try {
      const data = await posApi.get<{ threshold_minutes: number; tables: MLiveRow[] }>(`/api/orders/turnover?branch_id=${branchId}`);
      setThreshold(data.threshold_minutes); setLive(data.tables ?? []);
    } catch { /* ignore */ } finally { setLoading(false); }
  }, [posApi, branchId]);
  const loadReport = useCallback(async () => {
    if (!branchId) return;
    try { const data = await posApi.get<{ tables: MReportRow[] }>(`/api/orders/turnover/report?branch_id=${branchId}`); setReport(data.tables ?? []); } catch { /* ignore */ }
  }, [posApi, branchId]);

  useEffect(() => { if (tab !== 'live') return; loadLive(); const t = setInterval(loadLive, 30000); return () => clearInterval(t); }, [tab, loadLive]);
  useEffect(() => { if (tab === 'report') loadReport(); }, [tab, loadReport]);

  return (
    <div className="space-y-4">
      <div><h2 className="text-xl font-bold text-white">Table Turnover</h2><p className="text-gray-500 text-sm mt-0.5">Live dwell time and average turnover for {session?.branchName}</p></div>
      <div className="flex gap-2">
        <button onClick={() => setTab('live')} className={`px-3 py-1.5 rounded-lg text-sm ${tab === 'live' ? 'bg-green-600 text-white' : 'bg-gray-800 text-gray-400'}`}>Live tables</button>
        <button onClick={() => setTab('report')} className={`px-3 py-1.5 rounded-lg text-sm ${tab === 'report' ? 'bg-green-600 text-white' : 'bg-gray-800 text-gray-400'}`}>Turnover report</button>
      </div>
      {tab === 'live' ? (
        loading ? <p className="text-gray-500">Loading…</p> : live.length === 0 ? <p className="text-gray-500">No occupied dine-in tables right now.</p> : (
          <>
            <p className="text-xs text-gray-500">Tables seated longer than {threshold} min are flagged.</p>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
              {live.map(t => (
                <div key={t.order_id} className={`rounded-xl p-4 border ${t.over ? 'bg-red-500/10 border-red-500/40' : 'bg-gray-900 border-gray-800'}`}>
                  <div className="flex items-center justify-between"><span className="text-white font-semibold">{t.table_number ? `Table ${t.table_number}` : 'Order'}</span>{t.over && <span className="text-red-400 text-xs font-medium">● Over</span>}</div>
                  <p className={`text-2xl font-bold mt-1 ${t.over ? 'text-red-400' : 'text-white'}`}>{hm(t.minutes_seated)}</p>
                  <p className="text-xs text-gray-500 mt-1">{t.covers} cover{t.covers === 1 ? '' : 's'}</p>
                </div>
              ))}
            </div>
          </>
        )
      ) : (
        report.length === 0 ? <p className="text-gray-500">No completed dine-in orders in range.</p> : (
          <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead><tr className="text-gray-500 text-left text-xs border-b border-gray-800"><th className="p-3">Table</th><th className="p-3 text-right">Covers served</th><th className="p-3 text-right">Avg turnover</th></tr></thead>
              <tbody>{report.map(r => (<tr key={r.table_number} className="border-b border-gray-800"><td className="p-3 text-white">Table {r.table_number}</td><td className="p-3 text-right text-gray-300">{r.covers_served}</td><td className="p-3 text-right text-gray-300">{hm(r.avg_minutes)}</td></tr>))}</tbody>
            </table>
          </div>
        )
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function ManagerDashboard() {
  const navigate  = useNavigate();
  const { session, clearCashierSession, hasPermission } = usePOSAuth();
  const { business }                = useBusiness();
  const { branches, setActiveBranch } = useBranch();
  const [active, setActive]           = useState('overview');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [branchSynced, setBranchSynced] = useState(false);

  // Auth guard — redirect if no session or wrong role
  useEffect(() => {
    if (!session) { navigate('/pos', { replace: true }); return; }
    const dest = resolveRoute(session.permissions, session.role);
    if (dest !== '/manager') navigate(dest, { replace: true });
  }, [session]); // eslint-disable-line

  // Sync BranchContext to manager's assigned branch (needed for StaffTab/PrintersPage)
  useEffect(() => {
    if (!session?.branchId || !branches.length) return;
    const myBranch = branches.find(b => b.id === session.branchId);
    if (myBranch) { setActiveBranch(myBranch); setBranchSynced(true); }
  }, [session?.branchId, branches]); // eslint-disable-line

  if (!session) return null;

  const currency      = session.currency ?? 'KES';
  const managerBranch = [{ id: session.branchId, name: session.branchName }];
  const visibleNav    = NAV_ITEMS.filter(i => i.permission === null || hasPermission(i.permission));

  function handleLogout() {
    clearCashierSession();
    localStorage.removeItem('swiftpos_access_token');
    localStorage.removeItem('swiftpos_refresh_token');
    navigate('/pos');
  }

  function renderContent() {
    switch (active) {
      case 'overview':
        if (session.businessType === 'petrol_station') return <PetrolOverviewTab />;
        if (session.businessType === 'parking')         return <ParkingOverviewTab />;
        return <OverviewTab />;
      case 'reports':   return <ManagerReportsPage />;
      case 'orders':    return <POSOrderHistoryTab currency={currency} />;
      case 'inventory': return <POSInventoryTab />;
      case 'expenses':  return <POSExpensesTab currency={currency} />;
      case 'customers': return <POSCustomersTab currency={currency} />;
      case 'credit':    return <ManagerCreditTab currency={currency} />;
      case 'turnover':  return <ManagerTurnoverTab />;
      case 'staff':
        if (!branchSynced) return <BranchLoading />;
        return (
          <div className="space-y-4">
            <div>
              <h2 className="text-xl font-bold text-white">Staff</h2>
              <p className="text-gray-500 text-sm mt-0.5">Manage cashiers for {session.branchName}</p>
            </div>
            <StaffTab branches={managerBranch} excludeRoles={['manager', 'owner', 'admin', 'supervisor']} />
          </div>
        );
      case 'printers':
        if (!branchSynced) return <BranchLoading />;
        return (
          <div className="space-y-4">
            <div>
              <h2 className="text-xl font-bold text-white">Printer Setup</h2>
              <p className="text-gray-500 text-sm mt-0.5">Configure printers for {session.branchName}</p>
            </div>
            <PrintersPage />
          </div>
        );
      default: return <OverviewTab />;
    }
  }

  return (
    <div className="flex h-screen bg-gray-950 text-white overflow-hidden">
      <aside className={`flex flex-col bg-gray-900 border-r border-gray-800 transition-all duration-200 flex-shrink-0 ${sidebarOpen ? 'w-56' : 'w-16'}`}>
        <div className="flex items-center gap-3 px-4 h-16 border-b border-gray-800 flex-shrink-0">
          <span className="flex-shrink-0 text-blue-400"><Icon d={I.logo} size={20} /></span>
          {sidebarOpen && (
            <div className="min-w-0">
              <p className="text-sm font-bold text-white truncate">{business?.name ?? 'SwiftPOS'}</p>
              <p className="text-xs text-gray-500 truncate">{session.branchName}</p>
            </div>
          )}
        </div>

        <nav className="flex-1 overflow-y-auto py-3 space-y-0.5 px-2">
          {visibleNav.map(item => (
            <button key={item.key} onClick={() => setActive(item.key)}
              title={!sidebarOpen ? item.label : undefined}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all ${
                active === item.key
                  ? 'bg-blue-600/20 text-blue-400 border border-blue-500/30'
                  : 'text-gray-400 hover:bg-gray-800 hover:text-white'
              }`}>
              <span className="flex items-center gap-3 min-w-0">{item.label}</span>
            </button>
          ))}
        </nav>

        <div className="border-t border-gray-800 p-3 space-y-1 flex-shrink-0">
          <button onClick={() => navigate('/pos/cashier')}
            title={!sidebarOpen ? 'Open POS' : undefined}
            className="w-full flex items-center gap-3 px-3 py-2 rounded-xl text-sm text-gray-400 hover:bg-gray-800 hover:text-white transition-colors">
            <Icon d={I.pos} size={18} className="flex-shrink-0" />
            {sidebarOpen && <span>Open POS</span>}
          </button>
          <button onClick={handleLogout}
            title={!sidebarOpen ? 'Sign out' : undefined}
            className="w-full flex items-center gap-3 px-3 py-2 rounded-xl text-sm text-red-400 hover:bg-red-500/10 transition-colors">
            <Icon d={I.logout} size={18} className="flex-shrink-0" />
            {sidebarOpen && <span>Sign out</span>}
          </button>
        </div>
      </aside>

      <div className="flex-1 flex flex-col overflow-hidden">
        <header className="flex items-center justify-between px-6 h-16 bg-gray-900 border-b border-gray-800 flex-shrink-0">
          <div className="flex items-center gap-4">
            <button onClick={() => setSidebarOpen(o => !o)} className="text-gray-500 hover:text-white transition-colors"><Icon d={I.menu} size={20} /></button>
            <h1 className="text-base font-semibold text-white">
              {visibleNav.find(n => n.key === active)?.label ?? 'Overview'}
            </h1>
          </div>
          <div className="flex items-center gap-3">
            <div className="text-right">
              <p className="text-sm font-medium text-white">{session.staffName}</p>
              <p className="text-xs text-gray-500 capitalize">{session.role} · {session.branchName}</p>
            </div>
            <div className="w-9 h-9 rounded-full bg-blue-600/20 border border-blue-500/30 flex items-center justify-center text-blue-400 font-bold text-sm flex-shrink-0">
              {session.staffName.charAt(0).toUpperCase()}
            </div>
          </div>
        </header>
        <main className="flex-1 overflow-y-auto p-6">
          {renderContent()}
        </main>
      </div>
    </div>
  );
}
