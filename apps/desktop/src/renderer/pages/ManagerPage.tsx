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

import { Fragment, useState, useEffect, useRef, useCallback } from 'react';
import { posApi, ZReport } from '../lib/posApi';
import { methodLabel } from '../../shared/paymentCatalogue';   // A452
import { useOnlineLicence } from '../lib/onlineLicence';   // A460
import TransfersTab from '../components/TransfersTab';   // A197
import BranchStockTab from '../components/BranchStockTab';   // A564
import LabelsTab from '../components/LabelsTab';   // A571
import MonthlyPackTab from '../components/MonthlyPackTab';   // A466
import CreditSalesTab from '../components/CreditSalesTab';   // A545
import { overviewRange, dayWord, stepDay, todayYmd } from '../lib/overviewDate';   // A441
import { MenuTab, StaffTab, CombosTab, ImportTab } from './ManageTabs';
import SettingsPanel from '../components/SettingsPanel';
import ExpenseTypesPanel from '../components/ExpenseTypesPanel';
import { can, canAny, isOwner as isOwnerSession, mayMoveMoney, mayMpesa, SELL_REFUSAL } from '../lib/access';   // A490: the one rule (+ A492)
import { buildManagerNav, relabelCatalogue, groupOf, openGroup, firstTab, type TabKey, type GroupKey } from '../lib/managerNav';
import PrintersScreen from '../screens/PrintersScreen';
import TillWastage from '../components/TillWastage';   // A414
import Pager, { usePageSize } from '../components/Pager';   // A475
import { paginate } from '../../shared/paginate';

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
  { id: 'receipt',  name: 'POS',     kind: 'receipt'  as const },
];
import BranchCloseTab from './BranchCloseTab';
import DayCloseTab from './DayCloseTab';
import MenuWorkbench from './MenuWorkbench';
import MethodDot from '../components/MethodDot';
import { methodColour } from '../../shared/paymentColours';
import ReportRangeBar from '../components/ReportRangeBar';
import type { ReportRangeArg, ShiftSummary, ExpenseRow, BranchDay, BranchShiftState, BranchShiftRow, BranchShiftListRow } from '../lib/posApi';
import ConfirmShiftModal from '../components/ConfirmShiftModal';   // A433
import { modeFlags } from '../lib/posMode';
import ZReportView from '../components/ZReportView';
import { printShiftReport } from '../lib/printShiftReport';
import { usePrinterSettings } from '../hooks/usePrinterSettings';
import { lastSyncedLabel } from '../lib/syncNotice';
import OrderDetailPanel from '../components/OrderDetailPanel';   // A444
import OffersScreen from '../screens/OffersScreen';   // A445
import RecordExpenseForm from '../components/RecordExpenseForm';   // A447
import TillChangesNotice from '../components/TillChangesNotice';   // A448
import { VOID_WINDOW_MIN, type ReverseRights } from '../lib/voidRefund';
import { businessTerms } from '../../shared/businessTerms';   // A573: Menu (a restaurant) / Products (a shop)

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
// A457 (owner, 2026-10-12: "can you make the desktop overview beautiful i know we can do better"): the headline cards
// carry a colour each, the first (revenue) a full gradient; the figures are unchanged.
// A465 (owner, 2026-10-13: "remove the icons on the cards on the desktop overview but leave the colors"): no icons.
// A468 (owner, 2026-10-13: "match the desktop look and feel of the overview of the desktop app to that of the website"):
// the cards are the web Overview's (apps/dashboard/src/pages/OverviewPage.tsx KpiCard) — revenue the solid accent (the
// till's theme colour, as the web's swift-strong), the others the web's one plain card, with the web's "vs yesterday".
/** Green means good — a rise, money taken (A326: status and money keep green; the till's actions take the theme). */
const GOOD_TEXT = 'text-green-400';
type Delta = { pct: number; up: boolean } | null;
/** The web's deltaLabel: the change on the day before, none when there is nothing to compare with. */
function deltaOf(curr: number, prev: number | null | undefined): Delta {
  if (!prev) return null;
  const pct = Math.round(((curr - prev) / prev) * 100);
  return { pct, up: pct >= 0 };
}
// A468 (owner, 2026-10-13: "remove the icons … but leave the colors"): the web's plain card keeps a soft tint per card.
type KpiTone = 'sky' | 'violet' | 'amber' | 'rose';
const KPI_TINT: Record<KpiTone, string> = {
  sky: 'from-sky-500/15', violet: 'from-violet-500/15', amber: 'from-amber-500/15', rose: 'from-rose-500/15',
};
function KpiCard({ label, value, sub, accent, tone, delta = null, vs = 'yesterday' }: {
  label: string; value: string; sub?: string; accent?: boolean; tone?: KpiTone; delta?: Delta; vs?: string;
}) {
  return (
    <div data-testid="overview-kpi" className={`relative overflow-hidden rounded-xl p-4 flex flex-col gap-1.5 border ${accent
      ? 'bg-action-600 border-action-600'
      : 'bg-gray-900 border-gray-800'}`}>
      {!accent && tone && <div aria-hidden className={`pointer-events-none absolute inset-x-0 top-0 h-14 bg-gradient-to-b ${KPI_TINT[tone]} to-transparent`} />}
      <span className={`relative text-xs uppercase tracking-wider font-medium ${accent ? 'text-white/80' : 'text-gray-500'}`}>{label}</span>
      <span className="relative text-xl font-semibold tabular-nums text-white">{value}</span>
      {delta != null && (
        <span data-testid="overview-delta" className={`relative text-xs font-medium ${delta.up ? GOOD_TEXT : 'text-red-400'}`}>
          {delta.up ? '▲' : '▼'} {Math.abs(delta.pct)}% vs {vs}
        </span>
      )}
      {sub && <span className={`relative text-xs ${accent ? 'text-white/75' : 'text-gray-500'}`}>{sub}</span>}
    </div>
  );
}

/**
 * The web Overview's section card: a title, the day (or a count) beside it in gray, an optional link on the right
 * ("item mix →", "manage →") that opens that page of the manager screen — offered only where this role has it.
 */
function Section({ title, sub, link, right, className = '', testid, children }: {
  title: string; sub?: string; link?: { label: string; onClick: () => void } | null; right?: React.ReactNode;
  className?: string; testid?: string; children: React.ReactNode;
}) {
  return (
    <div data-testid={testid} className={`bg-gray-900 border border-gray-800 rounded-xl p-4 flex flex-col gap-3 ${className}`}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-white text-sm font-medium">{title}</span>
          {sub && <span className="text-xs text-gray-500 truncate">{sub}</span>}
        </div>
        {right}
        {link && (
          <button type="button" onClick={link.onClick}
            className="text-xs text-gray-500 hover:text-white transition-colors whitespace-nowrap">{link.label}</button>
        )}
      </div>
      {children}
    </div>
  );
}

/** Opens a page of the manager screen from an Overview link, or undefined when this role does not have that page. */
type LinkTo = (tab: TabKey) => (() => void) | undefined;

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
    <span className="whitespace-nowrap rounded-full bg-gray-900 border border-gray-800 px-3 py-1"><span className="text-gray-500">{label}</span>{' '}
      <span className="text-white font-medium tabular-nums">{fmt(value, currency)}</span></span>
  );
  return (
    <div className="flex flex-wrap gap-2 text-sm">
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
    <div className="bg-gray-800/80 border border-gray-700/70 rounded-2xl overflow-hidden shadow-sm">
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700/70">
        <span className="flex items-center gap-2 text-sm font-semibold text-white">
          <span className="w-1 h-4 rounded-full bg-action-500" />{title}
        </span>
        {action}
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

function Spinner() {
  return <div className="flex items-center justify-center py-12 text-gray-300 text-sm">Loading…</div>;
}

// ── A431 / A432: every till, and the shift report ────────────────────────────
// Owner, 2026-10-09: "the manager should view sales across all tills no matter the till they have logged into … add a
// shift report in the overview". The Overview's figures come from manager:branchDay — the cloud's branch, else what this
// till holds — and this line says which, so a till's partial view is never read as the branch's takings.
function ScopeLine({ day }: { day: BranchDay | null }) {
  if (!day) return null;
  const cloud = day.source === 'cloud';
  // A480 (owner, 2026-10-14: the yellow line on every branch server): a branch server's own records ARE the branch (every
  // till syncs to it) — that is said quietly, in gray, like the cloud's; amber is kept for "this till only".
  const calm = cloud || day.localCoversBranch;
  return (
    <div data-testid="overview-scope" className={`text-xs rounded-lg px-3 py-2 border ${calm
      ? 'text-gray-400 bg-gray-900 border-gray-800'
      : 'text-amber-300 bg-amber-400/10 border-amber-400/20'}`}>
      <span className="font-semibold">{day.scopeLabel}</span>
      {cloud ? ' · from the cloud' : !day.localCoversBranch && day.fallbackReason ? ` · ${day.fallbackReason}` : ''}
    </div>
  );
}

const SHIFT_STATE: Record<BranchShiftState, { label: string; cls: string }> = {
  open:      { label: 'Open',             cls: 'text-blue-300 bg-blue-400/10 border-blue-400/20' },
  awaiting:  { label: 'Awaiting manager', cls: 'text-amber-300 bg-amber-400/10 border-amber-400/20' },
  confirmed: { label: 'Confirmed',        cls: 'text-gray-200 bg-gray-700/60 border-gray-600' },
  closed:    { label: 'Closed',           cls: 'text-gray-300 bg-gray-800 border-gray-700' },
};

function hhmm(iso: string | null) {
  return iso ? new Date(iso).toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit' }) : '—';
}

function BranchShiftsAndTills({ day, currency, when = 'today' }: { day: BranchDay | null; currency: string; when?: string }) {
  const [open, setOpen] = useState<string | null>(null);
  // A433 (owner, 2026-10-10: "yes if they have logged in as the manager"): a signed-in manager confirms any till's shift
  // from here — this till's on its own record (as Close does), another till's on the cloud (that till picks it up).
  const [canConfirm, setCanConfirm] = useState(false);
  const [confirming, setConfirming] = useState<BranchShiftRow | null>(null);
  const [done, setDone] = useState<Record<string, string>>({});
  useEffect(() => { posApi.shift.canConfirm().then((v) => setCanConfirm(v === true)).catch(() => setCanConfirm(false)); }, []);
  if (!day) return null;
  const money = (v: number | null) => (v == null ? '—' : fmt(v, currency));
  return (
    <>
      {/* A468: the web's Branch comparison, for the tills of this branch — each till's takings against the best one. */}
      {day.byTill.length > 1 && (() => {
        const best = Math.max(...day.byTill.map(t => t.revenue), 1);
        return (
          <Section title="By POS" sub={when}>
            <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-3" data-testid="overview-by-till">
              {day.byTill.map(t => (
                <div key={t.device_id ?? 'web'} className="bg-gray-800 rounded-lg p-3">
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <p className="text-white text-sm font-medium truncate">{t.label}{t.this_till && <span className="text-gray-500 text-xs font-normal ml-2">this POS</span>}</p>
                    <span className="text-white text-sm font-semibold tabular-nums whitespace-nowrap">{fmt(t.revenue, currency)}</span>
                  </div>
                  <div className="h-1 bg-gray-700 rounded-full overflow-hidden mb-1">
                    <div className="h-full bg-action-500 rounded-full" style={{ width: `${Math.round((t.revenue / best) * 100)}%` }} />
                  </div>
                  <p className="text-gray-500 text-xs">{t.orders} orders · avg {fmt(t.orders > 0 ? t.revenue / t.orders : 0, currency)}</p>
                </div>
              ))}
            </div>
          </Section>
        );
      })()}

      <Section title={when === 'today' ? 'Shift report — today' : `Shift report — ${when}`}>
        {day.shifts.length === 0
          ? <p className="text-gray-500 text-sm">{when === 'today' ? 'No shifts today.' : `No shifts on ${when}.`}</p>
          : (
            <div className="overflow-x-auto" data-testid="overview-shift-report">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-gray-500 uppercase tracking-wide border-b border-gray-800">
                    <th className="py-2 pr-3 font-medium">POS</th>
                    <th className="py-2 pr-3 font-medium">Cashier</th>
                    <th className="py-2 pr-3 font-medium">Time</th>
                    <th className="py-2 pr-3 font-medium text-right">Sales</th>
                    <th className="py-2 pr-3 font-medium text-right">Expected cash</th>
                    <th className="py-2 pr-3 font-medium text-right">Counted</th>
                    <th className="py-2 pr-3 font-medium text-right">Difference</th>
                    <th className="py-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800">
                  {day.shifts.map(sh => {
                    const st = SHIFT_STATE[sh.state];
                    const diff = sh.variance;
                    return (
                      <Fragment key={sh.id}>
                        <tr onClick={() => setOpen(open === sh.id ? null : sh.id)} className="cursor-pointer hover:bg-gray-800/40">
                          <td className="py-2 pr-3 text-white whitespace-nowrap">{sh.till}{sh.this_till && <span className="text-gray-400 text-xs ml-1">(this)</span>}</td>
                          <td className="py-2 pr-3 text-gray-200">{sh.cashier}</td>
                          <td className="py-2 pr-3 text-gray-300 whitespace-nowrap tabular-nums">{hhmm(sh.opened_at)}–{sh.state === 'open' ? 'now' : hhmm(sh.closed_at)}</td>
                          <td className="py-2 pr-3 text-right text-white tabular-nums">{fmt(sh.sales, currency)}<span className="block text-gray-400 text-xs">{sh.orders} orders</span></td>
                          <td className="py-2 pr-3 text-right text-gray-200 tabular-nums">{money(sh.expected_cash)}</td>
                          <td className="py-2 pr-3 text-right text-gray-200 tabular-nums">{money(sh.counted_cash)}</td>
                          <td className={`py-2 pr-3 text-right tabular-nums ${diff == null || Math.round(diff * 100) === 0 ? 'text-gray-300' : diff < 0 ? 'text-red-400' : 'text-amber-300'}`}>
                            {diff == null ? '—' : `${diff > 0 ? '+' : ''}${fmt(diff, currency)}`}</td>
                          <td className="py-2">
                            {done[sh.id] !== undefined
                              ? <span className={`inline-block text-xs rounded-md border px-2 py-0.5 whitespace-nowrap ${SHIFT_STATE.confirmed.cls}`}>Confirmed</span>
                              : <span className={`inline-block text-xs rounded-md border px-2 py-0.5 whitespace-nowrap ${st.cls}`}>{st.label}{sh.force_closed ? ' · forced' : ''}</span>}
                            {(done[sh.id] || sh.confirmed_by) && <span className="block text-gray-400 text-xs mt-0.5">by {done[sh.id] || sh.confirmed_by}</span>}
                            {sh.state === 'awaiting' && done[sh.id] === undefined && canConfirm && (
                              <button data-testid="overview-confirm" onClick={(e) => { e.stopPropagation(); setConfirming(sh); }}
                                className="block mt-1 text-xs font-semibold text-action-400 hover:text-action-300">Confirm</button>
                            )}
                          </td>
                        </tr>
                        {open === sh.id && (
                          <tr>
                            <td colSpan={8} className="pb-3 pt-1">
                              <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs bg-gray-800/60 rounded-lg px-3 py-2">
                                <span className="text-gray-400">Opening float <span className="text-white tabular-nums">{fmt(sh.opening_float, currency)}</span></span>
                                {sh.by_method.length === 0
                                  ? <span className="text-gray-400">No payments</span>
                                  : sh.by_method.map(m => (
                                    <span key={m.method} className="text-gray-300 capitalize"><MethodDot method={m.method} />{m.method.replace(/_/g, ' ')}{' '}
                                      <span className="text-white tabular-nums">{fmt(m.amount, currency)}</span></span>
                                  ))}
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
      </Section>
      <StaffPerformance day={day} currency={currency} when={when} />
      {confirming && (
        <ConfirmShiftModal
          shiftId={confirming.id}
          cashierName={confirming.cashier}
          methods={confirming.declare_codes}
          currency={currency}
          openedAt={confirming.opened_at}
          closedAt={confirming.closed_at}
          remote={!confirming.this_till}
          onDone={(c) => { setDone((d) => ({ ...d, [confirming.id]: c.confirmed_by_name ?? '' })); setConfirming(null); }}
          onClose={() => setConfirming(null)}
        />
      )}
    </>
  );
}

// ── A440: staff performance ───────────────────────────────────────────────────
// Owner, 2026-10-10: "can we add a staff performance report on the desktop, maybe under overview". Each person's sales
// on the day by who rang them up (cashier B selling on cashier A's shift is B's — A438), with their money by payment
// method a tap away. From the cloud: every till; offline: what this till holds (the scope line above says which).
function StaffPerformance({ day, currency, when }: { day: BranchDay; currency: string; when: string }) {
  const [openRows, setOpenRows] = useState<string[]>([]);
  const [all, setAll] = useState(false);
  const rows = day.byStaff ?? [];
  const total = rows.reduce((t, r) => t + r.revenue, 0);
  const shown = (id: string) => all || openRows.includes(id);
  const toggle = (id: string) => setOpenRows((r) => (r.includes(id) ? r.filter((x) => x !== id) : [...r, id]));
  return (
    <Section title="Staff performance" sub={when}>
      {rows.length === 0 ? (
        <p className="text-gray-500 text-sm">{when === 'today' ? 'No sales yet today.' : 'No sales that day.'}</p>
      ) : (
        <div data-testid="overview-staff">
          <div className="flex justify-end mb-2">
            <button type="button" onClick={() => { setAll((v) => !v); setOpenRows([]); }} data-testid="overview-staff-all"
              className="text-xs rounded-lg border border-gray-800 px-2.5 py-1 text-gray-400 hover:text-white hover:border-gray-600">
              {all ? 'Hide payment methods' : 'Payment methods for everyone'}
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-500 uppercase tracking-wide border-b border-gray-800">
                  <th className="py-2 pr-3 font-medium">#</th>
                  <th className="py-2 pr-3 font-medium">Staff</th>
                  <th className="py-2 pr-3 font-medium text-right">Orders</th>
                  <th className="py-2 pr-3 font-medium text-right">Sales</th>
                  <th className="py-2 pr-3 font-medium text-right">Avg order</th>
                  <th className="py-2 pr-3 font-medium text-right">Share</th>
                  <th className="py-2 font-medium" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800">
                {rows.map((r, i) => {
                  const share = total > 0 ? (r.revenue / total) * 100 : 0;
                  return (
                    <Fragment key={r.id || 'unknown'}>
                      <tr>
                        <td className="py-2 pr-3 text-gray-400 tabular-nums">{i + 1}</td>
                        <td className="py-2 pr-3 text-white">{r.name}</td>
                        <td className="py-2 pr-3 text-right text-gray-200 tabular-nums">{r.orders}</td>
                        <td className="py-2 pr-3 text-right text-white font-medium tabular-nums">{fmt(r.revenue, currency)}</td>
                        <td className="py-2 pr-3 text-right text-gray-300 tabular-nums">{fmt(r.avg, currency)}</td>
                        <td className="py-2 pr-3">
                          <div className="flex items-center justify-end gap-2">
                            <div className="w-16 h-1 bg-gray-800 rounded-full overflow-hidden">
                              <div className="h-full bg-action-500 rounded-full" style={{ width: `${share}%` }} />
                            </div>
                            <span className="text-xs text-gray-400 tabular-nums w-10 text-right">{share.toFixed(1)}%</span>
                          </div>
                        </td>
                        <td className="py-2 text-right">
                          {r.by_method.length > 0 && !all && (
                            <button type="button" onClick={() => toggle(r.id)} data-testid="overview-staff-methods"
                              className="text-xs font-semibold text-action-400 hover:text-action-300 whitespace-nowrap">
                              {shown(r.id) ? 'Hide' : 'Payment methods'}
                            </button>
                          )}
                        </td>
                      </tr>
                      {shown(r.id) && r.by_method.length > 0 && (
                        <tr>
                          <td />
                          <td colSpan={6} className="pb-3 pt-1">
                            <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs bg-gray-800/60 rounded-lg px-3 py-2">
                              {r.by_method.map((m) => (
                                <span key={m.method} className="text-gray-300 capitalize">
                                  <MethodDot method={m.method} />{m.method === 'unpaid' ? 'not paid' : m.method.replace(/_/g, ' ')}{' '}
                                  <span className="text-white tabular-nums">{fmt(m.amount, currency)}</span>
                                </span>
                              ))}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Section>
  );
}

// ── A441: the Overview's day ──────────────────────────────────────────────────
// Owner, 2026-10-10: "under overview can we add select date to view that date?". Today unless the manager picks a day
// (a calendar, or a day back / forward); every card follows it and says which day it is.
// A468: laid out as the web Overview's header — the day on the left, "Updated" and ↻ Refresh on the right. Refresh asks
// the same reads again (the cards below remount); nothing new is fetched.
function OverviewForDay({ render }: { render: (date: string | null) => React.ReactNode }) {
  const [date, setDate] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [updated, setUpdated] = useState(() => new Date());
  useEffect(() => { setUpdated(new Date()); }, [date, reload]);
  const today = todayYmd();
  const when = dayWord(date);
  const step = 'rounded-lg border border-gray-800 bg-gray-900 px-3 py-1.5 text-sm text-gray-300 hover:text-white hover:border-gray-600';
  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div className="flex flex-wrap items-center gap-2" data-testid="overview-date">
          <button type="button" onClick={() => setDate((d) => stepDay(d, -1))} aria-label="The day before" className={step}>‹</button>
          <input type="date" value={date ?? today} max={today} data-testid="overview-date-input"
            onChange={(e) => setDate(e.target.value && e.target.value < today ? e.target.value : null)}
            className="rounded-lg border border-gray-800 bg-gray-900 px-3 py-1.5 text-sm text-white [color-scheme:dark]" />
          <button type="button" onClick={() => setDate((d) => stepDay(d, 1))} disabled={date === null} aria-label="The day after"
            className={`${step} disabled:opacity-30`}>›</button>
          {date !== null && (
            <button type="button" onClick={() => setDate(null)} data-testid="overview-date-today"
              className="rounded-lg border border-gray-800 px-3 py-1.5 text-sm text-gray-300 hover:text-white hover:border-gray-600">Back to today</button>
          )}
          <span className="text-sm text-gray-500 ml-1">Showing <span className="text-white font-medium">{when}</span></span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-gray-500 tabular-nums">Updated {hhmm(updated.toISOString())}</span>
          <button type="button" onClick={() => setReload((n) => n + 1)} data-testid="overview-refresh"
            className="text-xs text-gray-500 hover:text-white border border-gray-800 rounded-lg px-3 py-1.5 transition-colors">↻ Refresh</button>
        </div>
      </div>
      <Fragment key={reload}>{render(date)}</Fragment>
    </div>
  );
}

// ── A468: the web Overview's parts the till has the data for ─────────────────
type OverviewProps = {
  currency: string; date?: string | null;
  /** Opens a page from a section's link ("item mix →", "manage →") — only pages this role has. */
  linkTo?: LinkTo;
  /** The Stock page's own gate (A346: the web POS, and something stock-tracked) — the Low stock card follows it. */
  showLowStock?: boolean;
};
function linkOf(linkTo: LinkTo | undefined, tab: TabKey, label: string) {
  const go = linkTo?.(tab);
  return go ? { label, onClick: go } : null;
}

/**
 * The day before the one shown, read the same way (the branch from the cloud, else this till — manager:branchDay), for
 * the web's "vs yesterday". Compared only when both days come from the same place, so a till's partial day is never set
 * against the branch's; nothing to compare (offline twice is fine — both local) shows no delta.
 */
function useDayBefore(date: string | null): BranchDay | null {
  const [prev, setPrev] = useState<BranchDay | null>(null);
  useEffect(() => {
    let live = true;
    setPrev(null);
    posApi.manager.branchDay(overviewRange(stepDay(date, -1))).then((d) => { if (live) setPrev(d); }).catch(() => { /* no comparison */ });
    return () => { live = false; };
  }, [date]);
  return prev;
}
function comparable(day: BranchDay | null | undefined, prev: BranchDay | null): any {
  return day && prev && day.source === prev.source ? prev.summary : null;
}
const vsWord = (when: string) => (when === 'today' ? 'yesterday' : 'the day before');

/** The web's live row: the day's sales by hour (two columns) beside the shifts open now. */
function LiveRow({ day, currency, when }: { day: BranchDay | null; currency: string; when: string }) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
      <HourlyChart hourly={day?.hourly ?? []} currency={currency} when={when} />
      <OpenShifts day={day} currency={currency} />
    </div>
  );
}

/** The web's "Open shifts": who is on, since when, and their float — from the day's shift report (every till). */
function OpenShifts({ day, currency }: { day: BranchDay | null; currency: string }) {
  const open = (day?.shifts ?? []).filter((sh) => sh.state === 'open');
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 flex flex-col gap-2" data-testid="overview-open-shifts">
      <div className="flex items-center justify-between">
        <span className="text-white text-sm font-medium">Open shifts</span>
        <span className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${open.length > 0
          ? SHIFT_STATE.open.cls
          : 'bg-gray-800 text-gray-500 border-gray-700'}`}>{open.length}</span>
      </div>
      {open.length === 0
        ? <p className="text-gray-500 text-xs">No open shifts right now.</p>
        : open.map((sh) => (
          <div key={sh.id} className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="text-white text-xs font-medium truncate">{sh.cashier}<span className="text-gray-500 font-normal"> · {sh.till}</span></p>
              <p className="text-gray-500 text-[10px]">opened {timeAgo(sh.opened_at)} · float {fmt(sh.opening_float, currency)}</p>
            </div>
            <span className="w-1.5 h-1.5 rounded-full bg-blue-400 flex-shrink-0" />
          </div>
        ))}
    </div>
  );
}

/** The web's "Low stock": the five lowest at or under their threshold, read from this till (as the Stock page reads it). */
function LowStock({ link }: { link: { label: string; onClick: () => void } | null }) {
  const [rows, setRows] = useState<any[] | null>(null);
  useEffect(() => {
    let live = true;
    posApi.manager.stockLevels().then((s) => { if (live) setRows(Array.isArray(s) ? s : []); }).catch(() => { if (live) setRows([]); });
    return () => { live = false; };
  }, []);
  const low = (rows ?? []).filter((r) => r.quantity <= r.low_stock_threshold).sort((a, b) => a.quantity - b.quantity).slice(0, 5);
  return (
    <Section title="Low stock" link={link} testid="overview-low-stock">
      {rows === null
        ? <p className="text-gray-500 text-sm">Loading…</p>
        : low.length === 0
          ? <p className="text-gray-500 text-sm flex items-center gap-2"><span className={GOOD_TEXT}>✓</span> All stock healthy.</p>
          : (
            <div className="flex flex-col divide-y divide-gray-800">
              {low.map((r) => {
                const critical = r.quantity === 0 || r.quantity <= Math.floor(r.low_stock_threshold / 2);
                return (
                  <div key={r.product_id} className="flex items-center justify-between py-2 gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={`w-2 h-2 rounded-full flex-shrink-0 ${critical ? 'bg-red-500' : 'bg-amber-400'}`} />
                      <div className="min-w-0">
                        <p className="text-white text-sm truncate">{r.product_name}</p>
                        <p className="text-gray-500 text-xs">threshold: {r.low_stock_threshold}</p>
                      </div>
                    </div>
                    <span className={`text-xs font-semibold px-2 py-0.5 rounded-full flex-shrink-0 border ${critical
                      ? 'bg-red-500/10 text-red-400 border-red-500/20'
                      : 'bg-amber-400/10 text-amber-400 border-amber-400/20'}`}>{r.quantity} left</span>
                  </div>
                );
              })}
            </div>
          )}
    </Section>
  );
}

// ── Overview Tab — Restaurant ─────────────────────────────────────────────────
function RestaurantOverview({ currency, date = null, linkTo, showLowStock = false }: OverviewProps) {
  const when = dayWord(date);   // A441: the day shown — 'today' unless the manager picked another
  const [sales,    setSales]    = useState<any>(null);
  const [topItems, setTopItems] = useState<any[]>([]);
  const [tables,   setTables]   = useState<any[]>([]);
  const [loading,  setLoading]  = useState(true);
  const prev = useDayBefore(date);   // A468: "vs yesterday"

  useEffect(() => {
    let live = true;
    async function load() {
      // A290: settle each independently — a failure in one (e.g. tableOccupancy
      // on an old schema) must NOT blank the KPIs and top sellers. The old shared
      // try/catch zeroed the whole Overview when any single call threw.
      const [s, t, tb] = await Promise.allSettled([
        posApi.manager.branchDay(overviewRange(date)),   // A431: every till at the branch; A441: the day chosen
        posApi.manager.topProducts(overviewRange(date)),
        posApi.manager.tableOccupancy(),
      ]);
      if (!live) return;
      if (s.status === 'fulfilled') setSales(s.value);
      else console.warn('[Overview] salesSummary failed:', s.reason);
      if (t.status === 'fulfilled') setTopItems(t.value);
      else console.warn('[Overview] topProducts failed:', t.reason);
      // A433: from the cloud, every till's top sellers; else this till's (the title says so).
      if (s.status === 'fulfilled' && s.value?.source === 'cloud') setTopItems((s.value.topProducts ?? []).slice(0, 8));
      if (tb.status === 'fulfilled') setTables(tb.value);
      else console.warn('[Overview] tableOccupancy failed:', tb.reason);
      setLoading(false);
    }
    load();
    return () => { live = false; };
  }, [date]);

  if (loading) return <Spinner />;

  const s = sales?.summary;
  const p = comparable(sales, prev);
  const vs = vsWord(when);

  return (
    <div className="space-y-4">
      <ScopeLine day={sales} />
      {/* KPIs — the web's row: revenue (accent) and orders against the day before, average, and VAT (A357: once) */}
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
        <KpiCard label={`Revenue ${when}`}   value={fmt(s?.totalRevenue ?? 0, currency)} delta={p && deltaOf(s?.totalRevenue ?? 0, p.totalRevenue)} vs={vs} accent />
        <KpiCard label={`Orders ${when}`}    value={String(s?.totalOrders ?? 0)} delta={p && deltaOf(s?.totalOrders ?? 0, p.totalOrders)} vs={vs} tone="sky" />
        <KpiCard label="Avg order"       value={fmt(s?.avgOrderValue ?? 0, currency)} tone="violet" />
        <KpiCard label="VAT collected"   value={fmt(s?.totalVat ?? 0, currency)} tone="amber" />
      </div>
      <MoneyStrip s={s} currency={currency} hideVat />

      <LiveRow day={sales} currency={currency} when={when} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Section title="Payment methods" sub={when}>
          <PaymentMix methods={sales?.paymentMethods} currency={currency}
            empty={when === 'today' ? 'No payments yet today.' : 'No payments that day.'} />
        </Section>

        {/* Top items */}
        <Section title="Top sellers" sub={`${when}${sales && sales.source !== 'cloud' && !sales.localCoversBranch ? ' (this POS)' : ''}`}
          link={linkOf(linkTo, 'items', 'item mix →')}>
          <TopSellers items={topItems} currency={currency} empty={when === 'today' ? 'No sales yet today.' : 'No sales that day.'} />
        </Section>
      </div>

      {(showLowStock || tables.length > 0) && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {showLowStock && <LowStock link={linkOf(linkTo, 'stock', 'manage →')} />}
          {tables.length > 0 && (
            <Section title="Tables" sub={`${tables.length} configured`} className={showLowStock ? '' : 'lg:col-span-2'}>
              <div className={`grid gap-2 ${showLowStock ? 'grid-cols-3 xl:grid-cols-4' : 'grid-cols-4 sm:grid-cols-6 lg:grid-cols-8'}`}>
                {tables.map(t => (
                  <div key={t.id} className="bg-gray-800 rounded-lg p-2 text-center">
                    <p className="text-white text-sm font-medium truncate">{t.name}</p>
                    <p className="text-gray-500 text-[10px] mt-0.5">{t.capacity} seats</p>
                  </div>
                ))}
              </div>
            </Section>
          )}
        </div>
      )}
      <BranchShiftsAndTills day={sales} currency={currency} when={when} />
    </div>
  );
}

// ── Overview Tab — Petrol ─────────────────────────────────────────────────────
function PetrolOverview({ currency, date = null, linkTo, showLowStock = false }: OverviewProps) {
  const when = dayWord(date);   // A441: the day shown — 'today' unless the manager picked another
  const [fuel,    setFuel]    = useState<any>(null);
  const [pumps,   setPumps]   = useState<any[]>([]);
  const [sales,   setSales]   = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const prev = useDayBefore(date);   // A468: "vs the day before"

  useEffect(() => {
    let live = true;
    async function load() {
      try {
        const [f, p, s] = await Promise.all([
          posApi.manager.fuelSales(),
          posApi.manager.pumpStatus(),
          posApi.manager.branchDay(overviewRange(date)),   // A431: every till at the branch; A441: the day chosen
        ]);
        if (!live) return;
        setFuel(f); setPumps(p); setSales(s);
      } catch { /* best effort */ }
      finally { if (live) setLoading(false); }
    }
    load();
    return () => { live = false; };
  }, [date]);

  if (loading) return <Spinner />;

  const f = fuel?.summary;
  // A468: today's revenue is the pumps' (fuel sales), not the branch day's — so it is compared only on another day,
  // where the card shows the branch day's revenue and both days are read the same way.
  const p = when === 'today' ? null : comparable(sales, prev);
  const pumpLitres = pumps.reduce((a, x) => a + Number(x.sold_litres), 0);
  const pumpRevenue = pumps.reduce((a, x) => a + Number(x.revenue_today), 0);

  return (
    <div className="space-y-4">
      <ScopeLine day={sales} />
      {when !== 'today' && (
        <p className="text-xs text-gray-500" data-testid="overview-pumps-today-only">Pumps, litres and fuel grades show for today only — the sales, payments, shifts and staff below are {when}'s.</p>
      )}
      {/* Pump monitor — first, as on the web */}
      {when === 'today' && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden" data-testid="overview-pump-monitor">
          <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-3.5 border-b border-gray-800">
            <div className="flex items-center gap-2">
              <span className="text-white text-sm font-medium">Pump Monitor</span>
              <span className="text-xs text-gray-500">today</span>
            </div>
            {pumps.length > 0 && (
              <div className="flex flex-wrap items-center gap-4 text-xs text-gray-500 tabular-nums">
                <span>{fmt(pumpRevenue, currency)} today</span>
                <span>{fmtL(pumpLitres)} sold</span>
              </div>
            )}
          </div>
          {pumps.length === 0
            ? <p className="text-gray-500 text-sm px-5 py-4">No pumps configured. Add pumps in server settings.</p>
            : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-800">
                      {['Pump', 'Grade', 'Sold today', 'Revenue', 'Status'].map(h => (
                        <th key={h} className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-800/50">
                    {pumps.map(pu => (
                      <tr key={pu.pump_id} className="hover:bg-gray-800/30 transition-colors">
                        <td className="px-4 py-3 font-medium text-white whitespace-nowrap">{pu.pump_name}</td>
                        <td className="px-4 py-3 text-gray-300">{pu.product_name ?? '—'}</td>
                        <td className="px-4 py-3 text-amber-400 font-medium tabular-nums">{fmtL(pu.sold_litres)}</td>
                        <td className={`px-4 py-3 ${GOOD_TEXT} font-semibold tabular-nums`}>{fmt(pu.revenue_today, currency)}</td>
                        <td className="px-4 py-3">
                          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                            pu.pump_status === 'dispensing' ? 'bg-blue-500/15 text-blue-400' :
                            pu.pump_status === 'idle'       ? 'bg-green-500/15 text-green-400' :
                            pu.pump_status === 'error'      ? 'bg-red-500/15 text-red-400' :
                                                              'bg-gray-700 text-gray-400'
                          }`}>{pu.pump_status ?? 'idle'}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t border-gray-700">
                      <td colSpan={2} className="px-4 py-2.5 text-xs text-gray-500 font-medium">Totals</td>
                      <td className="px-4 py-2.5 text-xs font-semibold text-amber-400 tabular-nums">{fmtL(pumpLitres)}</td>
                      <td className={`px-4 py-2.5 text-xs font-semibold ${GOOD_TEXT} tabular-nums`}>{fmt(pumpRevenue, currency)}</td>
                      <td />
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
        </div>
      )}

      {/* KPIs */}
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
        <KpiCard label={`Revenue ${when}`}     value={fmt((when === 'today' ? f?.totalRevenue : sales?.summary?.totalRevenue) ?? 0, currency)} delta={p && deltaOf(sales?.summary?.totalRevenue ?? 0, p.totalRevenue)} vs={vsWord(when)} accent />
        <KpiCard label="Litres sold"        value={fmtL(f?.totalLitres ?? 0)} tone="amber" />
        <KpiCard label="Transactions"       value={String(f?.totalTransactions ?? 0)} tone="sky" />
        <KpiCard label="Avg per transaction"
          value={f?.totalTransactions > 0
            ? fmt((f.totalRevenue / f.totalTransactions), currency)
            : '—'} tone="violet" />
      </div>
      <MoneyStrip s={sales?.summary} currency={currency} />

      <LiveRow day={sales} currency={currency} when={when} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Section title="Payment methods" sub={when}>
          <PaymentMix methods={sales?.paymentMethods} currency={currency}
            empty={when === 'today' ? 'No payments yet today.' : 'No payments that day.'} />
        </Section>

        {/* Grade breakdown — the web's "Top grades" */}
        {when === 'today' && (fuel?.grades?.length ?? 0) > 0 && (
          <Section title="By fuel grade" sub="today">
            <div className="flex flex-col divide-y divide-gray-800">
              {(fuel.grades as any[]).map((g: any) => {
                const maxRev = fuel.grades[0]?.revenue ?? 1;
                return (
                  <div key={g.grade} className="py-2.5 flex items-center gap-3">
                    <span className="text-white text-sm w-28 truncate">{g.grade}</span>
                    <div className="flex-1 h-1 bg-gray-800 rounded-full overflow-hidden">
                      <div className="h-full bg-amber-400 rounded-full" style={{ width: `${Math.round((g.revenue / maxRev) * 100)}%` }} />
                    </div>
                    <span className="text-gray-500 text-xs tabular-nums w-20 text-right">{fmtL(g.litres)}</span>
                    <span className="text-white text-sm font-medium tabular-nums w-28 text-right">{fmt(g.revenue, currency)}</span>
                  </div>
                );
              })}
            </div>
          </Section>
        )}
      </div>

      {showLowStock && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <LowStock link={linkOf(linkTo, 'stock', 'manage →')} />
        </div>
      )}
      <BranchShiftsAndTills day={sales} currency={currency} when={when} />
    </div>
  );
}

// ── Overview Tab — Retail / default ──────────────────────────────────────────
function RetailOverview({ currency, date = null, linkTo, showLowStock = false }: OverviewProps) {
  const when = dayWord(date);   // A441: the day shown — 'today' unless the manager picked another
  const [sales,    setSales]    = useState<any>(null);
  const [topItems, setTopItems] = useState<any[]>([]);
  const [loading,  setLoading]  = useState(true);
  const prev = useDayBefore(date);   // A468: "vs yesterday"

  useEffect(() => {
    let live = true;
    async function load() {
      try {
        const [s, t] = await Promise.all([
          posApi.manager.branchDay(overviewRange(date)),   // A431: every till at the branch; A441: the day chosen
          posApi.manager.topProducts(overviewRange(date)),
        ]);
        if (!live) return;
        // A433: from the cloud, every till's top sellers; else this till's (the title says so).
        setSales(s); setTopItems(s?.source === 'cloud' ? (s.topProducts ?? []).slice(0, 8) : t);
      } catch { /* best effort */ }
      finally { if (live) setLoading(false); }
    }
    load();
    return () => { live = false; };
  }, [date]);

  if (loading) return <Spinner />;
  const s = sales?.summary;
  const p = comparable(sales, prev);
  const vs = vsWord(when);

  return (
    <div className="space-y-4">
      <ScopeLine day={sales} />
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
        <KpiCard label={`Revenue ${when}`}  value={fmt(s?.totalRevenue ?? 0, currency)} delta={p && deltaOf(s?.totalRevenue ?? 0, p.totalRevenue)} vs={vs} accent />
        <KpiCard label={`Orders ${when}`}   value={String(s?.totalOrders ?? 0)} delta={p && deltaOf(s?.totalOrders ?? 0, p.totalOrders)} vs={vs} tone="sky" />
        <KpiCard label="Avg order"      value={fmt(s?.avgOrderValue ?? 0, currency)} tone="violet" />
        <KpiCard label="VAT collected"  value={fmt(s?.totalVat ?? 0, currency)} tone="amber" />
      </div>
      <MoneyStrip s={s} currency={currency} hideVat />

      <LiveRow day={sales} currency={currency} when={when} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Section title="Payment methods" sub={when}>
          <PaymentMix methods={sales?.paymentMethods} currency={currency}
            empty={when === 'today' ? 'No payments yet today.' : 'No payments that day.'} />
        </Section>

        <Section title="Top sellers" sub={`${when}${sales && sales.source !== 'cloud' && !sales.localCoversBranch ? ' (this POS)' : ''}`}
          link={linkOf(linkTo, 'items', 'item mix →')}>
          <TopSellers items={topItems} currency={currency} empty={when === 'today' ? 'No sales yet today.' : 'No sales that day.'} />
        </Section>
      </div>

      {showLowStock && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <LowStock link={linkOf(linkTo, 'stock', 'manage →')} />
        </div>
      )}
      <BranchShiftsAndTills day={sales} currency={currency} when={when} />
    </div>
  );
}

// ── A457: payment mix (donut + bars) and top sellers, shared by the Overviews ──
// A468: drawn as the web Overview draws its lists — thin bars on the card, the share beside the amount.
/** Share of what was PAID (tips included, refunds out — A349), as a ring and a bar per method. */
function PaymentMix({ methods, currency, empty }: { methods: Record<string, number> | null | undefined; currency: string; empty: string }) {
  const rows = Object.entries(methods ?? {}).map(([m, a]) => [m, Number(a) || 0] as const).sort(([, a], [, b]) => b - a);
  const total = rows.reduce((a, [, v]) => a + v, 0);
  if (rows.length === 0) return <p className="text-gray-500 text-sm">{empty}</p>;
  const R = 15.915;   // circumference 100: dash lengths are percentages
  let at = 0;
  return (
    <div className="flex items-center gap-5" data-testid="overview-payment-mix">
      <div className="relative w-24 h-24 flex-shrink-0">
        <svg viewBox="0 0 36 36" className="w-full h-full -rotate-90">
          <circle cx="18" cy="18" r={R} fill="none" stroke="currentColor" strokeWidth="3.5" className="text-gray-800" />
          {rows.map(([m, v]) => {
            const pct = total > 0 ? (v / total) * 100 : 0;
            const seg = <circle key={m} cx="18" cy="18" r={R} fill="none" strokeWidth="3.5" stroke={methodColour(m).dot}
              strokeDasharray={`${Math.max(0, pct - 0.6)} ${100 - Math.max(0, pct - 0.6)}`} strokeDashoffset={-at} />;
            at += pct;
            return seg;
          })}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-[10px] uppercase tracking-wider text-gray-500">Paid</span>
          <span className="text-xs font-semibold text-white tabular-nums">{Math.round(total).toLocaleString('en-KE')}</span>
        </div>
      </div>
      <div className="flex-1 min-w-0 space-y-2">
        {rows.map(([method, amount]) => {
          const pct = total > 0 ? Math.round((amount / total) * 100) : 0;
          return (
            <div key={method}>
              <div className="flex justify-between text-sm mb-1 gap-2">
                <span className="text-gray-300 capitalize truncate"><MethodDot method={method} />{method.replace(/_/g, ' ')}</span>
                <span className="text-white font-medium tabular-nums whitespace-nowrap">{fmt(amount, currency)} <span className="text-gray-500 font-normal text-xs">{pct}%</span></span>
              </div>
              <div className="h-1 bg-gray-800 rounded-full overflow-hidden">
                <div className="h-full rounded-full" style={{ width: `${pct}%`, background: methodColour(method).dot }} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** The day's best sellers, as the web lists them — rank, name, units, revenue — with a thin bar against the top one. */
function TopSellers({ items, currency, empty }: { items: any[]; currency: string; empty: string }) {
  if (items.length === 0) return <p className="text-gray-500 text-sm">{empty}</p>;
  const top = Math.max(...items.map((p) => Number(p.revenue) || 0), 1);
  return (
    <div className="flex flex-col divide-y divide-gray-800" data-testid="overview-top-sellers">
      {items.map((p, i) => (
        <div key={p.name} className="py-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-gray-500 text-xs w-4 flex-shrink-0 tabular-nums">{i + 1}</span>
              <div className="min-w-0">
                <p className="text-white text-sm truncate">{p.name}</p>
                <p className="text-gray-500 text-xs">{Number(p.qty).toFixed(0)} sold</p>
              </div>
            </div>
            <span className="text-white text-sm font-medium flex-shrink-0 tabular-nums">{fmt(Number(p.revenue), currency)}</span>
          </div>
          <div className="ml-6 mt-1.5 h-1 bg-gray-800 rounded-full overflow-hidden">
            <div className="h-full rounded-full bg-action-500/70" style={{ width: `${Math.round(((Number(p.revenue) || 0) / top) * 100)}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Hourly chart (shared) ─────────────────────────────────────────────────────
// A468: the web's live chart look — flat rounded bars in the theme colour, the figure on the right of the title: the
// peak hour, or the hour pointed at.
function HourlyChart({ hourly, currency, when }: { hourly: { hour: number; revenue: number; orders: number }[]; currency: string; when: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(...hourly.map(h => h.revenue), 1);
  const peakHour = hourly.length ? hourly.reduce((b, h) => h.revenue > b.revenue ? h : b, hourly[0]) : null;
  const shown = hover !== null ? hourly.find(r => r.hour === hover) ?? { hour: hover, revenue: 0, orders: 0 } : peakHour;
  const hh = (h: number) => `${String(h).padStart(2, '0')}:00`;

  return (
    <Section title="Hourly sales" sub={when} className="lg:col-span-2" testid="overview-hourly"
      right={shown && (
        <div className="text-right ml-auto" data-testid="overview-hourly-readout">
          <p className="text-white text-sm font-semibold tabular-nums">{fmt(shown.revenue, currency)}</p>
          <p className="text-gray-500 text-xs tabular-nums">{hover === null ? 'Peak ' : ''}{hh(shown.hour)} · {shown.orders} orders</p>
        </div>
      )}>
      {hourly.length === 0
        ? <p className="text-gray-500 text-sm">{when === 'today' ? 'No sales yet today.' : 'No sales that day.'}</p>
        : (
          <div>
            <div className="flex items-end gap-1 h-36">
              {Array.from({ length: 24 }, (_, h) => {
                const row  = hourly.find(r => r.hour === h);
                const pct  = row?.revenue ? Math.max(4, Math.round((row.revenue / max) * 100)) : 2;
                const isPeak = h === peakHour?.hour;
                return (
                  <div key={h} className="flex-1 flex flex-col justify-end h-full cursor-default"
                    onMouseEnter={() => setHover(h)} onMouseLeave={() => setHover(null)}
                    title={`${h}:00  ${row ? fmt(row.revenue, currency) : '—'}`}>
                    <div style={{ height: `${pct}%` }}
                      className={`rounded-sm transition-all ${row?.revenue
                        ? (hover === h ? 'bg-action-400' : isPeak ? 'bg-action-500' : 'bg-action-500/60')
                        : 'bg-gray-800'}`} />
                  </div>
                );
              })}
            </div>
            <div className="flex justify-between mt-1">
              {[0, 3, 6, 9, 12, 15, 18, 21].map(h => <span key={h} className="text-[10px] text-gray-600 tabular-nums">{hh(h)}</span>)}
            </div>
            <p className="mt-1 text-[10px] text-gray-600">Point at a bar for its hour</p>
          </div>
        )}
    </Section>
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
function OrdersTab({ currency, rights = { void: false, refund: false } }: { currency: string; rights?: ReverseRights }) {
  const [orders,  setOrders]  = useState<any[]>([]);
  // A444: the order opened here — its items, Reprint and Void / Refund (this till's or, from the cloud, any till's).
  const [detailId, setDetailId] = useState<string | null>(null);
  const [voidWindowMin, setVoidWindowMin] = useState(VOID_WINDOW_MIN);
  useEffect(() => { posApi.pos.reversalRules().then((r) => setVoidWindowMin(r.voidWindowMinutes)).catch(() => { /* the default */ }); }, []);
  const [loading, setLoading] = useState(true);
  const [range, setRange] = useState<ReportRangeArg>({ preset: 'today' });
  // Cross-sync stage 1 (2026-09-27): this till's own list (local, works offline) or every till at the
  // branch (read from the cloud — owner: "Branch view, read from cloud"). Offline → this till, said so.
  // A433 (owner, 2026-10-10: "under sales report it should cover all tills"): every till first; offline → this till, said so.
  const [scope, setScope] = useState<'till' | 'branch'>('branch');
  const [scopeNote, setScopeNote] = useState('');

  // 500 rather than 30: a date range is asked for in order to see the range, and
  // silently showing the newest 30 of a month would be a lie the totals confirm.
  // The CSV export is uncapped — the screen is capped only to stay responsive.
  const fetchOrders = async (r: ReportRangeArg, sc: 'till' | 'branch'): Promise<{ list: any[]; note: string }> => {
    if (sc === 'branch') {
      try { return { list: await posApi.manager.branchOrders({ ...r, limit: 500 }), note: '' }; }
      catch { /* offline or the cloud did not answer — fall through to this till's own list */ }
      return { list: await posApi.manager.recentOrders({ ...r, limit: 500 }),
               note: 'The cloud could not be reached — showing this POS only.' };
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
  // A475: the list in pages (25 / 50 / 100, remembered on this till); a new period or scope → page 1, a Refresh or a
  // void / refund keeps the page (clamped). The count and the total above stay every order in the range.
  const [ordersPage, setOrdersPage] = useState(1);
  const [ordersPageSize, setOrdersPageSize] = usePageSize('swiftpos.pageSize.orders');
  useEffect(() => { setOrdersPage(1); }, [range.preset, range.from, range.to, scope]);
  const ordersPaged = paginate(orders, ordersPage, ordersPageSize);
  useEffect(() => { if (ordersPaged.page !== ordersPage) setOrdersPage(ordersPaged.page); }, [ordersPaged.page, ordersPage]);

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
        options={[{ key: 'till', label: 'This POS' }, { key: 'branch', label: 'All points of sale at this branch' }]}
        value={scope}
        onChange={v => setScope(v)}
      />

      <ReportRangeBar value={range} onChange={setRange} exportKind="orders" showDailyReport
        scopeOverride={scope === 'branch' && !scopeNote ? 'All points of sale at this branch — read from the cloud' : null} />
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
                {ordersPaged.items.map(o => {
                  const method = o.payments?.[0]?.method ?? '—';
                  return (
                    <tr key={o.id} data-testid="manager-order-row" onClick={() => setDetailId(o.id)} title="See the items in this order"
                      className="hover:bg-gray-700/30 transition-colors cursor-pointer">
                      <td className="px-4 py-3 font-mono text-xs text-gray-300">
                        {o.order_number}
                        {o.origin === 'web' && (
                          <span className="ml-1.5 font-sans text-[10px] px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-400"
                            title="Rung on the web POS on this desktop POS's drawer">web</span>
                        )}
                        {scope === 'branch' && !scopeNote && o.this_till && (
                          <span className="ml-1.5 font-sans text-[10px] text-gray-400">this POS</span>
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
            <Pager paged={ordersPaged} noun="orders" onPage={setOrdersPage} onSize={n => { setOrdersPageSize(n); setOrdersPage(1); }} />
          </div>
        )}
      {/* A444: the order's items, payments, Reprint and Void / Refund. */}
      {detailId && (
        <OrderDetailPanel orderId={detailId} currency={currency} rights={rights} windowMin={voidWindowMin}
          onClose={() => setDetailId(null)} onChanged={() => load(range)} />
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
          not yet downloaded to this POS — they appear in Orders within about 20 seconds when online.
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
  // A433 (owner, 2026-10-10: "under sales report it should cover all tills when logged in as the manager"): every till's
  // shifts from the cloud too. This till's own are read from its own records (offline as well); another till's Z-report
  // comes from the cloud. A shift awaiting a manager can be confirmed here.
  const [shifts,   setShifts]   = useState<ShiftSummary[]>([]);
  const [branch,   setBranch]   = useState<BranchShiftListRow[] | null>(null);
  const [branchNote, setBranchNote] = useState('');
  const [selected, setSelected] = useState<string | null>(null);   // null = the open shift (live)
  const [report,   setReport]   = useState<ZReport | null>(null);
  const [loading,  setLoading]  = useState(true);
  const [canConfirm, setCanConfirm] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const printRef = useRef<HTMLDivElement>(null);
  // Owner, 2026-10-10: "if there are two shifts running will the manager see two z reports side by side, and if more" —
  // with nothing picked, every running shift at the branch, each its own live report, side by side (wrapping for more).
  const [live, setLive] = useState<Array<{ id: string; till: string; this_till: boolean; report: ZReport | null }>>([]);

  useEffect(() => {
    posApi.shift.history().then(setShifts).catch(() => setShifts([]));
    posApi.manager.branchShifts()
      .then(r => { setBranch(r); setBranchNote(''); })
      .catch(() => { setBranch(null); setBranchNote("Shifts on other points of sale need the cloud — showing this POS's only."); });
    posApi.shift.canConfirm().then(v => setCanConfirm(v === true)).catch(() => setCanConfirm(false));
  }, [reloadKey]);

  // This till holds it → its own record; anything else → the cloud.
  const local = new Set(shifts.map(x => x.id));
  const remote = (id: string) => !local.has(id);

  useEffect(() => {
    let on = true;
    setLoading(true);
    if (!selected) {
      // Every running shift: this till's from its own records, another till's from the cloud. Offline → this till's.
      const open = (branch ?? []).filter(x => x.status === 'open');
      const mine = posApi.shift.current({ includeForeign: true }).catch(() => null);
      const others = open.filter(x => !x.this_till).map(x =>
        posApi.manager.remoteZReport(x.id).then(r => ({ id: x.id, till: x.till, this_till: false, report: r as ZReport | null }))
          .catch(() => ({ id: x.id, till: x.till, this_till: false, report: null })));
      Promise.all([mine, ...others]).then(([m, ...rest]) => {
        if (!on) return;
        const ownTill = open.find(x => x.this_till)?.till ?? 'This POS';
        const list = [...(m ? [{ id: (m as ZReport).shift.id, till: ownTill, this_till: true, report: m as ZReport }] : []), ...rest];
        setLive(list);
        setReport(list.length === 1 ? list[0].report : null);
      }).finally(() => { if (on) setLoading(false); });
      return () => { on = false; };
    }
    const load = remote(selected) ? posApi.manager.remoteZReport(selected) : posApi.shift.zreport(selected);
    load.then(r => { if (on) setReport(r); }).catch(() => { if (on) setReport(null); })
      .finally(() => { if (on) setLoading(false); });
    return () => { on = false; };
  }, [selected, reloadKey, shifts.length, branch]);

  const [printMsg, setPrintMsg] = useState('');

  const handlePrint = async (which: ZReport | null = report) => {
    if (!which) return;
    setPrintMsg('');
    // ESC/POS, like every other document. The HTML route printed roughly a third
    // of this report and stopped — see lib/printShiftReport.ts.
    const r = await printShiftReport(which);
    if (!r.ok) setPrintMsg(r.error ?? 'Could not print the shift report.');
  };

  const when = (iso: string | null) =>
    iso ? new Date(iso).toLocaleString('en-KE', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
  // Every till's (the cloud) — but this till's open drawer is the "Current shift (live)" line; else this till's past ones.
  const options = branch
    ? branch.filter(x => !(x.this_till && x.status === 'open')).map(x => ({
        id: x.id,
        label: `${x.till}${x.this_till ? ' (this)' : ''} · ${when(x.opened_at)} → ${x.status === 'open' ? 'open' : when(x.closed_at)} · ${x.cashier_name ?? 'Cashier'}`
          + `${x.status === 'closed_unreconciled' ? ' · force-closed' : ''}${x.awaiting ? ' · awaiting manager' : ''}`,
      }))
    : shifts.filter(x => x.status !== 'open').map(x => ({
        id: x.id,
        label: `${when(x.opened_at)} → ${when(x.closed_at)} · ${x.cashier_name ?? 'Cashier'}${x.status === 'closed_unreconciled' ? ' · force-closed' : ''}`,
      }));
  const awaiting = !!selected && report?.confirmation?.status === 'awaiting';

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-bold text-white">Shift Report</h2>
          <p className="text-gray-300 text-sm">
            {selected ? 'Z-report of a shift' : `Live — ${live.length} running shift${live.length === 1 ? '' : 's'}, not closed Z-reports`}
            {branch ? ' · every POS at this branch' : ''}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <select data-testid="shift-picker" value={selected ?? ''} onChange={e => setSelected(e.target.value || null)}
            className="bg-gray-800 border border-gray-700 text-gray-200 text-sm rounded-lg px-3 py-2 max-w-full">
            <option value="">Running shifts — every POS (live)</option>
            {options.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
          {awaiting && canConfirm && (
            <button data-testid="zreport-confirm" onClick={() => setConfirming(true)}
              className="px-4 py-2 bg-action-500 hover:bg-action-400 text-gray-950 text-sm font-bold rounded-xl transition-colors">
              Confirm this shift
            </button>
          )}
          <button onClick={() => void handlePrint()} disabled={!report}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-sm font-medium rounded-xl transition-colors">
            Print report
          </button>
        </div>
      </div>
      {branchNote && <p className="text-amber-300 text-xs" data-testid="zreport-scope-note">{branchNote}</p>}
      {options.length === 0 && <p className="text-gray-400 text-xs">No closed shifts yet.</p>}

      {loading ? <Spinner /> : !selected && live.length > 1 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 items-start" data-testid="live-zreports">
          {live.map(l => (
            <div key={l.id} className="bg-white rounded-xl p-4">
              <div className="flex items-center justify-between mb-2 gap-2">
                <span className="text-gray-900 text-sm font-bold">{l.till}{l.this_till ? ' (this POS)' : ''}</span>
                <button onClick={() => void handlePrint(l.report)} disabled={!l.report}
                  className="px-3 py-1 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-xs font-medium rounded-lg">Print</button>
              </div>
              {l.report ? <ZReportView report={l.report} />
                : <p className="text-gray-500 text-sm">Could not be loaded — it needs the cloud.</p>}
            </div>
          ))}
          {printMsg && <p className="text-amber-400 text-xs">⚠ {printMsg}</p>}
        </div>
      ) : !report ? (
        <div className="text-center py-16">
          <p className="text-gray-400 font-medium">{selected ? 'That shift could not be loaded' : 'No open shift'}</p>
          <p className="text-gray-400 text-sm mt-1">
            {selected ? (remote(selected) ? "Another POS's shift needs the cloud — check the connection, or choose another." : 'Choose another shift above.')
              : 'Open a shift from the POS, or choose a previous shift above.'}
          </p>
        </div>
      ) : (
        <div className="bg-white rounded-xl p-4 max-w-sm">
          <ZReportView ref={printRef} report={report} />
          {printMsg && <p className="text-amber-400 text-xs mt-2">⚠ {printMsg}</p>}
        </div>
      )}

      {confirming && selected && report && (
        <ConfirmShiftModal
          shiftId={selected}
          cashierName={report.shift.cashier_name}
          methods={report.confirmation?.methods ?? []}
          currency={currency}
          openedAt={report.shift.opened_at}
          closedAt={report.shift.closed_at}
          remote={remote(selected)}
          onDone={() => { setConfirming(false); setReloadKey(k => k + 1); }}
          onClose={() => setConfirming(false)}
        />
      )}
    </div>
  );
}

// ── Expenses Tab (0.6.11) ─────────────────────────────────────────────────────
// Owner (2026-09-27): "I should be able to see expenses". Cash this till's drawers paid out, by date range —
// the same rows the shift report deducts. Recorded from the POS (Shift → Expenses); this screen only reads.
function ExpensesTab({ currency, canAddType, canRecord = false }: { currency: string; canAddType: boolean; canRecord?: boolean }) {
  const [range, setRange] = useState<ReportRangeArg>({ preset: 'today' });
  const [data, setData] = useState<{ rows: ExpenseRow[]; total: number; label: string } | null>(null);
  const [loading, setLoading] = useState(true);
  // A447: a manager records an expense here too (it was the cashier's Shift → Expenses only).
  const [recording, setRecording] = useState(false);
  const [saved, setSaved] = useState('');
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let live = true;
    setLoading(true);
    posApi.expense.range(range).then(d => { if (live) setData(d); }).catch(() => { if (live) setData(null); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [range.preset, range.from, range.to, reload]);

  const all = data?.rows ?? [];
  // A452 (owner, 2026-10-12): "what payment method was used and a filter to payment method, who paid, and a subtotal per
  // method if a filter is applied".
  const [method, setMethod] = useState('');
  const [payer, setPayer] = useState('');
  const methods = [...new Set(all.map((e) => e.payment_method || 'cash'))].sort();
  const payers = [...new Map(all.filter((e) => e.paid_by).map((e) => [e.paid_by as string, e.paid_by_name ?? 'Unknown'])).entries()];
  const rows = all.filter((e) => (!method || (e.payment_method || 'cash') === method) && (!payer || e.paid_by === payer));
  const filtered = !!(method || payer);
  const shownTotal = rows.reduce((a, e) => a + Number(e.amount || 0), 0);
  const byMethod = [...rows.reduce((m, e) => m.set(e.payment_method || 'cash', (m.get(e.payment_method || 'cash') ?? 0) + Number(e.amount || 0)), new Map<string, number>()).entries()]
    .sort((a, b) => b[1] - a[1]);
  // A475: the list in pages (25 / 50 / 100, remembered on this till); a new period or filter → page 1, a new expense
  // keeps the page (clamped). The summary, the per-method subtotals and the Total row stay every filtered expense.
  const [expensesPage, setExpensesPage] = useState(1);
  const [expensesPageSize, setExpensesPageSize] = usePageSize('swiftpos.pageSize.expenses');
  useEffect(() => { setExpensesPage(1); }, [range.preset, range.from, range.to, method, payer]);
  const expensesPaged = paginate(rows, expensesPage, expensesPageSize);
  useEffect(() => { if (expensesPaged.page !== expensesPage) setExpensesPage(expensesPaged.page); }, [expensesPaged.page, expensesPage]);
  const selectCls = 'bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200';
  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-white">Expenses</h2>
          <p className="text-gray-300 text-sm" data-testid="expenses-summary">
            {loading ? 'Loading…' : `${rows.length} expense${rows.length === 1 ? '' : 's'} · ${fmt(shownTotal, currency)} paid out${filtered ? ` (of ${fmt(data?.total ?? 0, currency)})` : ''}`}
          </p>
        </div>
        {!recording && canRecord && (
          <button data-testid="record-expense" onClick={() => { setRecording(true); setSaved(''); }}
            className="shrink-0 px-3 py-2 rounded-lg bg-action-500 hover:bg-action-400 text-gray-950 text-sm font-semibold">
            + Record expense
          </button>
        )}
      </div>
      {recording && (
        <RecordExpenseForm currency={currency} onCancel={() => setRecording(false)}
          onSaved={(msg) => { setRecording(false); setSaved(msg); setReload((n) => n + 1); }} />
      )}
      {saved && <p className="text-sm text-gray-200" data-testid="record-expense-saved">{saved}</p>}
      {/* A358: the expense types, and "+ Add type" here as well as in Shift → Expenses (owner, on v0.6.18). */}
      <ExpenseTypesPanel canAdd={canAddType} />
      <ReportRangeBar value={range} onChange={setRange} />
      {all.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <select data-testid="expense-filter-method" value={method} onChange={(e) => setMethod(e.target.value)} className={selectCls}>
            <option value="">All payment methods</option>
            {methods.map((m) => <option key={m} value={m}>{methodLabel(m)}</option>)}
          </select>
          <select data-testid="expense-filter-payer" value={payer} onChange={(e) => setPayer(e.target.value)} className={selectCls}>
            <option value="">Everyone who paid</option>
            {payers.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
          {filtered && <button onClick={() => { setMethod(''); setPayer(''); }} className="text-sm text-gray-300 hover:text-white underline">Clear</button>}
        </div>
      )}
      {filtered && rows.length > 0 && (
        <div data-testid="expense-method-subtotals" className="flex flex-wrap gap-2">
          {byMethod.map(([m, amt]) => (
            <div key={m} className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm">
              <span className="text-gray-300">{methodLabel(m)}</span>
              <span className="ml-2 font-semibold text-white tabular-nums">{fmt(amt, currency)}</span>
            </div>
          ))}
        </div>
      )}
      {loading ? <Spinner /> : rows.length === 0 ? (
        <div className="text-center py-12 text-gray-300">{filtered ? 'No expenses match these filters.' : 'No expenses in this date range. Record one with + Record expense, or from the POS: Shift → Expenses.'}</div>
      ) : (
        <div className="bg-gray-800 border border-gray-700 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-700">
                {['When', 'Description', 'Type', 'Paid with', 'Paid by', 'Amount'].map(h => (
                  <th key={h} className={`px-4 py-3 text-xs font-medium text-gray-300 ${h === 'Amount' ? 'text-right' : 'text-left'}`}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-700/50">
              {expensesPaged.items.map(e => (
                <tr key={e.id} className="hover:bg-gray-700/30 transition-colors">
                  <td className="px-4 py-3 text-gray-400 text-xs whitespace-nowrap">
                    {new Date(e.created_at).toLocaleString('en-KE', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                  </td>
                  <td className="px-4 py-3 text-gray-200">
                    {e.description}
                    {e.sync_status !== 'synced' && <span className="ml-1.5 text-[10px] text-amber-400">not synced</span>}
                  </td>
                  <td className="px-4 py-3 text-gray-300">{e.expense_type_name ?? '—'}</td>
                  <td className="px-4 py-3 text-gray-300">{methodLabel(e.payment_method || 'cash')}</td>
                  <td className="px-4 py-3 text-gray-300">{e.paid_by_name ?? '—'}</td>
                  <td className="px-4 py-3 text-right font-semibold text-white tabular-nums">{fmt(e.amount, currency)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-gray-700">
                <td colSpan={5} className="px-4 py-3 text-gray-300 font-medium">{filtered ? 'Total (filtered)' : 'Total'}</td>
                <td className="px-4 py-3 text-right font-bold text-white tabular-nums">{fmt(shownTotal, currency)}</td>
              </tr>
            </tfoot>
          </table>
          <Pager paged={expensesPaged} noun="expenses" onPage={setExpensesPage} onSize={n => { setExpensesPageSize(n); setExpensesPage(1); }} />
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

  const low      = stock.filter(s => s.quantity <= s.low_stock_threshold);
  const visible  = filter === 'low' ? low : stock;
  // A475: the list in pages (25 / 50 / 100, remembered on this till); All / Low stock → page 1. The counts stay every product.
  const [stockPage, setStockPage] = useState(1);
  const [stockPageSize, setStockPageSize] = usePageSize('swiftpos.pageSize.stock');
  useEffect(() => { setStockPage(1); }, [filter]);
  const stockPaged = paginate(visible, stockPage, stockPageSize);
  useEffect(() => { if (stockPaged.page !== stockPage) setStockPage(stockPaged.page); }, [stockPaged.page, stockPage]);

  if (loading) return <Spinner />;

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
                {stockPaged.items.map(s => {
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
            <Pager paged={stockPaged} noun="products" onPage={setStockPage} onSize={n => { setStockPageSize(n); setStockPage(1); }} />
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
  // A433: every till at the branch (the cloud), else what this till holds — and the line under the title says which.
  const [scopeLine, setScopeLine] = useState('');

  useEffect(() => {
    let live = true;
    setLoading(true);
    posApi.manager.branchDay(range)
      .then(d => {
        if (!live) return;
        setItems(d.topProducts ?? []);
        setScopeLine(d.source === 'cloud' ? 'All points of sale at this branch'
          : d.localCoversBranch ? 'What this branch server holds' : `This POS only${d.fallbackReason ? ` — ${d.fallbackReason}` : ''}`);
      })
      .catch(() => {}).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [range.preset, range.from, range.to]);

  const totalRev = items.reduce((s, i) => s + Number(i.revenue), 0);

  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-lg font-bold text-white">Item Mix</h2>
        <p className="text-gray-300 text-sm" data-testid="item-mix-scope">{scopeLine || 'Top sellers'} · {fmt(totalRev, currency)} total</p>
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
  onOpenPOS?: () => void;   // switch back to till — A519: absent for someone whose role cannot sell
  onLogout:  () => void;   // end shift → PIN screen
  /** 0.6.35 (A384): open "What to do when". */
  onHelp?: () => void;
  /** A405: open on this tab (the day-lock banner's "Close day now" → Close Day), when this manager may see it. */
  initialTab?: TabKey;
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

  const visible = rows.filter(r =>
    r.product_name.toLowerCase().includes(query.toLowerCase()) ||
    (r.category_name ?? '').toLowerCase().includes(query.toLowerCase())
  );
  const overrides = rows.filter(r => r.branch_price !== null).length;
  // A475: the list in pages (25 / 50 / 100, remembered on this till); a new search → page 1, a Save / Clear keeps the
  // page (clamped). The counts above stay every product.
  const [pricesPage, setPricesPage] = useState(1);
  const [pricesPageSize, setPricesPageSize] = usePageSize('swiftpos.pageSize.prices');
  useEffect(() => { setPricesPage(1); }, [query]);
  const pricesPaged = paginate(visible, pricesPage, pricesPageSize);
  useEffect(() => { if (pricesPaged.page !== pricesPage) setPricesPage(pricesPaged.page); }, [pricesPaged.page, pricesPage]);

  if (loading) return <Spinner />;

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
                {pricesPaged.items.map(r => {
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
            <Pager paged={pricesPaged} noun="products" onPage={setPricesPage} onSize={n => { setPricesPageSize(n); setPricesPage(1); }} />
          </div>
        )}
    </div>
  );
}
export default function ManagerPage({ business, staff, onOpenPOS, onLogout, onHelp, initialTab }: Props) {
  const currency     = business.currency ?? 'KES';
  const businessName = business.name;
  const flags        = modeFlags(business.type);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  // 0.6.25 (owner: "Where its b foods can we add the logo there"): the client's logo beside the business name, read like the
  // PIN and lock screens read it (branding:get, refreshed when a pull lands). None → the report icon, as before.
  const [brandLogo, setBrandLogo] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      posApi.branding.get().then((b) => { if (!cancelled) setBrandLogo(b?.logoPng ?? null); }).catch(() => { /* keep what is shown */ });
    };
    load();
    const unsubscribe = posApi.pos.onCatalogueChanged(load);
    return () => { cancelled = true; unsubscribe(); };
  }, []);

  // A363: a neutral "Last synced" — information, not an alarm (the red notice on the POS is for refusals only).
  const [lastSynced, setLastSynced] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    const read = () => posApi.sync.status().then(st => setLastSynced(st.lastSyncedAt ?? null)).catch(() => {});
    read();
    const t = setInterval(read, 60_000);
    return () => clearInterval(t);
  }, []);

  /**
   * The business's own print stations, pulled down with the catalogue.
   * Empty until loaded, and empty on a business that has configured none —
   * both fall back to FALLBACK_STATIONS so printing never stops.
   */
  const [escposStations, setEscposStations] = useState<typeof FALLBACK_STATIONS>([]);
  // 2026-10-04 (owner: "i created the drink printer under stations and it does not appear under printers"): this was
  // read ONCE, when the manager screen opened, so a station added on the Stations tab never reached the Printers tab
  // until the till was locked or restarted. Now a reload the Printers tab calls each time it is opened.
  const reloadStations = useCallback(() => {
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
          live.push({ id: 'receipt', name: 'POS receipt', kind: 'receipt' });
        }

        setEscposStations(live);
      } catch { /* fallback list stands */ }
    })();
  }, [flags.isRestaurant]);
  useEffect(() => { reloadStations(); }, [reloadStations]);

  // A490: every gate names a FINE key (lib/access.ts — the owner's role holds everything; an older cloud's broad keys are
  // expanded). The main process checks the same keys again — hiding a tab is a courtesy, not the control.
  const has = (key: string) => can(staff, key);
  const hasAny = (...keys: string[]) => canAny(staff, ...keys);
  const canManageReceipt = has('receipt.manage');
  // A453 → A490: recording money (an expense here) — shifts.cash_movements (before migration 134, the admin switch).
  const [noMoneyOut, setNoMoneyOut] = useState(false);
  useEffect(() => { posApi.pos.features().then((f: any) => setNoMoneyOut(f?.cashier_no_money_out === true)).catch(() => {}); }, []);

  // A460: the online licence — offers, variants / combos, wastage and transfers are shown only with it.
  const online = useOnlineLicence();
  // A564: requests from other branches waiting for this branch's answer — read once when the screen opens (no polling);
  // the Other branches page refreshes it after each answer.
  const [branchRequests, setBranchRequests] = useState(0);
  useEffect(() => {
    if (!online || !can(staff, 'inventory.transfer')) return;
    posApi.branchStock.requests().then((r) => { if (r.ok && r.data) setBranchRequests(Number(r.data.incoming_open) || 0); }).catch(() => {});
  }, [online]);
  // A520: the branch server (node / office) shows Close Branch alone under Close.
  const [isBranchServer, setIsBranchServer] = useState(false);
  useEffect(() => {
    posApi.config.get().then((c: any) => setIsBranchServer(c?.device_role === 'node' || c?.device_role === 'office')).catch(() => {});
  }, []);
  // Stock only for a business with the web POS (A346), and only once something actually tracks stock.
  const [showStock, setShowStock] = useState(false);
  useEffect(() => {
    let live = true;
    (async () => {
      const cfg = await posApi.config.get().catch(() => null);
      if (cfg?.web_pos_enabled !== true || !can(staff, 'inventory.view')) { if (live) setShowStock(false); return; }   // A490
      const rows = await posApi.manager.stockLevels().catch(() => []);
      if (live) setShowStock(Array.isArray(rows) && rows.length > 0);
    })();
    return () => { live = false; };
  }, []);

  // A351 (2026-09-28): the sidebar in groups — Sales, Close and Settings open as one page with tabs across the top.
  // The rules live in lib/managerNav.ts. A490: each page by its own fine key — a person with no key for a page does not
  // see it, a group with none leaves the sidebar:
  //  - Overview reports.overview · Orders orders.view_all · Item Mix reports.items · Current shift / Shift report
  //    reports.shifts or shifts.confirm · Monthly pack reports.monthly_pack or expenses.manage (A481) · Expenses
  //    expenses.view or expenses.manage · Close Day shifts.close_day (the day gate's escape route) · Close Branch shifts.close_branch (A520).
  //  - Menu menu.edit or menu.prices · Offers menu.offers (online licence) · Settings › General settings.business or
  //    settings.payments (each panel by its own) · Printing stations.manage or receipt.manage (A59/A90) · Staff staff.view.
  //  - Stock inventory.view (web POS on and something stock-tracked, A346) · Wastage inventory.waste · Transfers
  //    inventory.transfer (both with the online licence, A460).
  const words = businessTerms(flags.mode);   // A573
  const nav = relabelCatalogue(buildManagerNav({
    isRestaurant: flags.isRestaurant,
    canOverview: has('reports.overview'),
    canOrders: has('orders.view_all'),
    canItems: has('reports.items'),
    canShifts: hasAny('reports.shifts', 'shifts.confirm'),
    canMonthly: has('reports.monthly_pack') || has('expenses.manage'),
    canCredit: has('customers.credit'),   // A545
    canExpenses: hasAny('expenses.view', 'expenses.manage'),
    canCloseDay: has('shifts.close_day'),
    canCloseBranch: has('shifts.close_branch'),   // A520
    isBranchServer,   // A520: Close Branch alone on the branch server
    canMenu: hasAny('menu.edit', 'menu.prices'),
    canOffers: has('menu.offers'),
    canSettings: hasAny('settings.business', 'settings.payments') || mayMpesa(staff),   // A492: the branch's M-Pesa number
    canPrinting: has('stations.manage') || canManageReceipt,
    canStaff: hasAny('staff.view', 'staff.edit'),
    showStock,
    canWaste: has('inventory.waste'),   // A414
    online,   // A460
    canTransfer: has('inventory.transfer'),   // A197
    canBranchStock: has('inventory.view'),   // A564: another branch's stock (asking for it: inventory.transfer)
    branchRequests,   // A564
    canLabels: hasAny('menu.edit', 'inventory.view'),   // A571: barcode labels
  }), words.catalogue);   // A573: "Menu" / "Products"
  const GROUP_ICON: Record<GroupKey, string> = {
    overview: I.overview, sales: I.orders, expenses: I.expenses, close: I.shift,
    menu: I.menu, settings: I.receipt, stock: I.stock,
  };

  // A490: the page asked for when the person has it, else the first page they have (not always the Overview).
  const [active, setActive] = useState<TabKey>(() => firstTab(nav, initialTab) ?? 'overview');
  // The person's keys can change while the screen is open (a fresher map, auth:permissionsChanged): a page they no
  // longer have is left for the first one they do.
  useEffect(() => {
    // A520: on the branch server "Close day now" (the day-lock banner) lands on Close Branch — its day closes there.
    if (isBranchServer && active === 'dayclose' && groupOf(nav, 'branchclose')) { setActive('branchclose'); return; }
    if (!groupOf(nav, active)) { const t = firstTab(nav); if (t) setActive(t); }
  });
  // The tab last used in each group, so Settings reopens on Printing if that is where the manager was.
  const [lastTab, setLastTab] = useState<Partial<Record<GroupKey, TabKey>>>({});
  const activeGroup = groupOf(nav, active);
  const openTab = (tab: TabKey) => {
    setActive(tab);
    const g = groupOf(nav, tab);
    if (g && g.tabs.some(t => t.key === tab)) setLastTab(prev => ({ ...prev, [g.key]: tab }));
  };

  const overviewLink: LinkTo = (tab) => (groupOf(nav, tab) ? () => openTab(tab) : undefined);   // A468

  const renderNothing = () => (
    <p className="text-sm text-gray-300" data-testid="manager-nothing">Nothing here is open to your role. Use Open POS, or ask the owner (Settings › Roles and permissions).</p>
  );
  function renderContent() {
    // A490: a page the person does not have is never drawn (a stale `active`, an Overview link).
    if (!groupOf(nav, active)) return renderNothing();
    switch (active) {
      case 'overview':
        // A441: the Overview for the day the manager picks (today unless they pick another).
        // A468: section links open the page they name, where this role has it; Low stock follows the Stock page's gate.
        return <OverviewForDay render={(date) => (flags.isPetrol ? <PetrolOverview currency={currency} date={date} linkTo={overviewLink} showLowStock={showStock} />
          : flags.isRestaurant ? <RestaurantOverview currency={currency} date={date} linkTo={overviewLink} showLowStock={showStock} />
          : <RetailOverview currency={currency} date={date} linkTo={overviewLink} showLowStock={showStock} />)} />;
      case 'orders':  return <OrdersTab currency={currency} rights={{ void: has('sales.void'), refund: has('sales.refund') }} />;
      case 'shift':   return <ShiftTab currency={currency} />;
      case 'expenses': return <ExpensesTab currency={currency} canAddType={has('expenses.manage')}
                                           canRecord={has('expenses.record') || mayMoveMoney(staff, noMoneyOut)} />;   // A594: Record expenses
      case 'dayclose': return <DayCloseTab currency={currency} />;
      case 'branchclose': return <BranchCloseTab currency={currency} businessName={businessName} />;
      // Tabs of Sales (A351): Shift report, Item Mix (restaurant).
      case 'zreport': return <ZReportTab businessName={businessName} currency={currency} />;
      case 'items':   return <TopItemsTab currency={currency} />;
      case 'prices':  return <PricesTab   currency={currency} />;
      case 'menu':    return <MenuWorkbench currency={currency} onOpenImport={() => openTab('import')} canEdit={has('menu.edit')} canPrices={has('menu.prices')} title={words.catalogue} />;
      // A445: the owner sets offers for every branch or this one; anyone else for this branch (the cloud enforces it).
      case 'offers':  return online ? <OffersScreen currency={currency} isOwner={isOwnerSession(staff)} /> : <RetailOverview currency={currency} />;   // A460
      case 'combos':  return online ? <CombosTab  currency={currency} /> : <RetailOverview currency={currency} />;   // A460
      case 'import':  return <ImportTab  currency={currency} what={words.importWhat} />;
      case 'staff':   return <StaffTab   branchId={staff.branchId} canEdit={has('staff.edit')} />;   // A490
      case 'settings': return <SettingsPanel canBusiness={has('settings.business')} canPayments={has('settings.payments')}
                                             canMpesa={mayMpesa(staff)} isOwner={isOwnerSession(staff)} />;   // 0.6.30; A490: each panel by its key
      // PrintersScreen (A83/A90): sub-tabs under one "Printing" nav item —
      // Stations, Printers, Exclusions (all stations.manage) and Receipt
      // (receipt.manage/settings.manage). Per-tab gating passed in below.
      case 'printers': return <PrintersScreen
        stations={escposStations.length ? escposStations : FALLBACK_STATIONS}
        canManageStations={has('stations.manage')}
        canManageReceipt={canManageReceipt}
        reloadStations={reloadStations}
      />;
      case 'stock':   return showStock ? <StockTab currency={currency} /> : <RetailOverview currency={currency} />;
      case 'wastage': return online ? <TillWastage /> : <RetailOverview currency={currency} />;   // A414; A460
      case 'transfers': return online ? <TransfersTab /> : <RetailOverview currency={currency} />;   // A197
      case 'labels': return online ? <LabelsTab /> : <RetailOverview currency={currency} />;   // A571
      case 'branchstock': return online ? <BranchStockTab canRequest={has('inventory.transfer')} onCount={setBranchRequests} /> : <RetailOverview currency={currency} />;   // A564
      // A466: the web's Monthly pack; recording for the books as the web gates it (expenses.manage).
      case 'monthly': return <MonthlyPackTab currency={currency} canRecord={has('expenses.manage')} />;
      // A545: every sale on account, confirmed or disputed by a manager (as themselves; offline kept and sent later).
      case 'credit': return <CreditSalesTab currency={currency} />;
      default:        return nav.length ? <RetailOverview currency={currency} /> : (
        <p className="text-sm text-gray-300" data-testid="manager-nothing">Nothing here is open to your role. Use Open POS, or ask the owner (Settings › Roles and permissions).</p>
      );
    }
  }

  return (
    <div className="flex app-screen bg-gray-950 text-white overflow-hidden">

      {/* Sidebar */}
      {/* A326: tinted by the business's brand colour (or theme) when themes are ON; the fallback IS gray-900, so OFF is unchanged. */}
      <aside style={{ backgroundColor: 'var(--sidebar-tint, #111827)' }} className={`flex flex-col bg-gray-900 border-r border-gray-800 transition-all duration-200 flex-shrink-0 ${sidebarOpen ? 'w-52' : 'w-16'}`}>
        {/* Header */}
        <div className={`flex items-center gap-3 border-b border-gray-800 flex-shrink-0 ${brandLogo ? 'px-3 h-20' : 'px-4 h-16'}`}>
          {brandLogo ? (
            // The logo on a small white tile (logos are made for a light background), visible even when collapsed.
            <span data-testid="sidebar-logo" className="flex-shrink-0 bg-white rounded-lg flex items-center justify-center"
                  style={{ width: sidebarOpen ? 52 : 40, height: sidebarOpen ? 52 : 40, padding: 3 }}>
              <img src={brandLogo} alt="" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', display: 'block' }} />
            </span>
          ) : (
            <span className="flex-shrink-0 text-blue-400">
              <Icon d={I.zreport} size={20} />
            </span>
          )}
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
          {/* A519: someone whose role cannot sell (a Storekeeper, an Accountant) sees the button disabled, with why. */}
          <button onClick={onOpenPOS} disabled={!onOpenPOS} data-testid="manager-open-pos"
            title={!onOpenPOS ? SELL_REFUSAL : !sidebarOpen ? 'Open POS' : undefined}
            className={`w-full flex items-center gap-3 px-3 py-2 rounded-xl text-sm transition-colors ${onOpenPOS ? 'text-gray-400 hover:bg-gray-800 hover:text-white' : 'text-gray-600 cursor-not-allowed'}`}>
            <Icon d={I.pos} size={18} cls="flex-shrink-0" />
            {sidebarOpen && <span>Open POS</span>}
          </button>
          {onHelp && (
            <button onClick={onHelp} data-testid="manager-help"
              title={!sidebarOpen ? 'Help' : undefined}
              className="w-full flex items-center gap-3 px-3 py-2 rounded-xl text-sm text-gray-400 hover:bg-gray-800 hover:text-white transition-colors">
              <span className="w-[18px] text-center flex-shrink-0 font-bold">?</span>
              {sidebarOpen && <span>Help</span>}
            </button>
          )}
          {/* This ends the STAFF shift and returns to the PIN pad — it was
              labelled "Sign out", which reads like it signs the business out.
              The owner sign-out below is the one that actually does that. */}
          <button onClick={onLogout}
            title={!sidebarOpen ? 'Lock POS' : undefined}
            className="w-full flex items-center gap-3 px-3 py-2 rounded-xl text-sm text-gray-200 hover:bg-gray-800 hover:text-white transition-colors">
            <Icon d={I.logout} size={18} cls="flex-shrink-0" />
            {sidebarOpen && <span>Lock POS</span>}
          </button>
          {/* The running build, where someone on the phone can read it out.
              Three tills are updated by hand and drift; "which version are you
              on?" is the first question of any support call and there was
              nowhere to answer it outside the install wizard. */}
          {sidebarOpen && (
            <p className="px-3 pt-1 pb-2 text-[11px] text-gray-400">
              ZapTill v{posApi.version} · {posApi.platform}
            </p>
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
            {lastSynced !== undefined && (
              <p data-testid="last-synced" className="text-[11px] text-gray-400">Last synced: {lastSyncedLabel(lastSynced)}</p>
            )}
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
          <TillChangesNotice />   {/* A448: changes made here that have not settled with the cloud */}
          {renderContent()}
        </main>
      </div>
    </div>
  );
}
