/**
 * branchDay.ts — A431 / A432 (owner, 2026-10-09): "the manager should view sales across all tills no matter the till they
 * have logged into, the server they should also see the same … add a shift report in the overview".
 *
 * The Overview read this till's database only, and every shift query here is this till's alone — so a manager on till B
 * never saw till A. Now the Overview asks the cloud for the branch (GET /api/shifts/branch-report — every till and the web
 * POS; through the branch server on a till behind one, A410), with the manager's own sign-in (A415: the till's session is
 * not a person). When the cloud cannot be reached it falls back to what this till holds — every till's rows on a branch
 * server or a till that receives them, else this till's — and SAYS which (`source`, `scopeLabel`), so a till's partial
 * view is never read as the branch's takings.
 *
 * Read-only. Confirming a shift and closing the day are unchanged.
 */
import { getLocalDb } from './localDb';
import { getCloudUrl, getDeviceConfig } from './deviceConfig';
import { readStaffTokens } from './tokenStore';
import { cloudFetch } from './cloudGateway';
import { getSalesSummary, getTopProducts, getReportScope, type ReportRange } from './managerReports';
import { computeZReport } from './shiftService';
import { money2, refundedSql } from './orderMoney';

export type ShiftState = 'open' | 'awaiting' | 'confirmed' | 'closed';

export interface BranchShiftRow {
  id: string; device_id: string | null; till: string; this_till: boolean; cashier: string;
  opened_at: string; closed_at: string | null; state: ShiftState; force_closed: boolean; confirmed_by: string | null;
  opening_float: number; orders: number; sales: number; by_method: Array<{ method: string; amount: number }>;
  expected_cash: number | null; counted_cash: number | null; variance: number | null;
  /** A433: what a manager recounts to confirm it — the methods the cashier declared (cash is always counted). */
  declare_codes: string[];
}

export interface BranchDay {
  /** 'cloud' — every till at the branch; 'local' — what this till holds (see scopeLabel). */
  source: 'cloud' | 'local';
  scopeLabel: string;
  /** Why the cloud was not used (no manager sign-in, offline, an older cloud) — shown beside a local view. */
  fallbackReason: string | null;
  /** Whether this till's own database holds every till (a branch server) — Top sellers and Item mix still read it. */
  localCoversBranch: boolean;
  summary: ReturnType<typeof getSalesSummary>['summary'];
  paymentMethods: Record<string, number>;
  hourly: Array<{ hour: number; revenue: number; orders: number }>;
  byTill: Array<{ device_id: string | null; label: string; this_till: boolean; orders: number; revenue: number }>;
  shifts: BranchShiftRow[];
  /** A433: Item Mix — every till's from the cloud; offline, what this till holds (`localCoversBranch` says how much). */
  topProducts: Array<{ name: string; qty: number; revenue: number }>;
  /** A440: staff performance — each person's sales in the range by who rang them up, and their money by method. */
  byStaff: StaffRow[];
}

export interface StaffRow {
  id: string; name: string; orders: number; revenue: number; avg: number;
  by_method: Array<{ method: string; amount: number }>;
}

/**
 * A440 (owner, 2026-10-10: "can we add a staff performance report on the desktop, maybe under overview"): from rows of
 * sales — who (the cashier, else the shift's owner), the kept total (after refunds), and the sale's payments — each
 * person's orders, sales, average and money by payment method (a sale's kept total shared over its payments, as the
 * cloud's branchReport.ts). Biggest seller first. Pure, so the test runs it.
 */
export function staffRows(sales: Array<{ id: string; who: string | null; name: string | null; kept: number }>,
  payments: Array<{ order_id: string; method: string; amount: number }>): StaffRow[] {
  const pays = new Map<string, Array<{ method: string; amount: number }>>();
  for (const p of payments) if (Number(p.amount) > 0) { const l = pays.get(p.order_id) ?? []; l.push(p); pays.set(p.order_id, l); }
  const by = new Map<string, { id: string; name: string; orders: number; revenue: number; methods: Record<string, number> }>();
  for (const o of sales) {
    const id = o.who ?? '';
    const row = by.get(id) ?? { id, name: (o.name ?? '').trim() || 'Unknown', orders: 0, revenue: 0, methods: {} };
    by.set(id, row);
    row.orders += 1; row.revenue += o.kept;
    const parts = pays.get(o.id) ?? [];
    const paid = parts.reduce((t, x) => t + Number(x.amount), 0);
    if (!parts.length || paid <= 0) { row.methods.unpaid = (row.methods.unpaid ?? 0) + o.kept; continue; }
    for (const x of parts) row.methods[x.method] = (row.methods[x.method] ?? 0) + o.kept * (Number(x.amount) / paid);
  }
  return [...by.values()].map((r) => ({
    id: r.id, name: r.name, orders: r.orders, revenue: money2(r.revenue), avg: r.orders ? money2(r.revenue / r.orders) : 0,
    by_method: Object.entries(r.methods).map(([method, amount]) => ({ method, amount: money2(amount) }))
      .filter((m) => m.amount !== 0).sort((a, b) => b.amount - a.amount),
  })).sort((a, b) => b.revenue - a.revenue || a.name.localeCompare(b.name));
}

const withinMs = <T,>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('The cloud took too long to answer')), ms))]);

/** The shift state from the columns the till keeps — the same words as the cloud (A365). */
export function localShiftState(s: { status: string; confirmed_at: string | null; declared_methods: string | null }): ShiftState {
  if (s.status === 'open') return 'open';
  if (s.confirmed_at) return 'confirmed';
  if (s.declared_methods != null) return 'awaiting';
  return 'closed';
}

function declaredCodes(raw: string | null): string[] {
  if (!raw) return [];
  try { const m = JSON.parse(raw); return m && typeof m === 'object' ? Object.keys(m) : []; } catch { return []; }
}

/** The branch from the cloud. Throws with a reason the screen can show. */
export async function cloudBranchDay(range: ReportRange): Promise<BranchDay> {
  const cfg = getDeviceConfig();
  const token = readStaffTokens().token;
  if (!token) throw new Error('Sign in as a manager to see every till');
  const q = new URLSearchParams({
    from: range.from, to: range.to,
    // Minutes east of UTC, so the cloud draws the hours as this till does (Kenya: 180).
    tz_offset_min: String(-new Date(range.from).getTimezoneOffset()),
  });
  if (cfg?.branch_id) q.set('branch_id', cfg.branch_id);
  const res = await withinMs(cloudFetch(`${getCloudUrl()}/api/shifts/branch-report?${q}`, {
    headers: { Authorization: `Bearer ${token}`, 'x-device-id': cfg?.device_id ?? '', ...(cfg?.branch_id ? { 'x-branch-id': cfg.branch_id } : {}) },
  }), 10_000);
  if (res.status === 404) throw new Error('The cloud is not updated for this yet');
  if (res.status === 403) throw new Error('Only a manager sees every till');
  if (!res.ok) throw new Error(`The cloud did not answer (HTTP ${res.status})`);
  const body = await res.json() as any;
  const own = cfg?.device_id ?? null;
  const ctlLevied = Number(cfg?.ctl_rate ?? 0) > 0 || Number(body.summary?.totalCtl ?? 0) > 0;
  return {
    source: 'cloud',
    scopeLabel: 'All tills at this branch',
    fallbackReason: null,
    localCoversBranch: getReportScope().coversBranch,
    summary: { ...body.summary, ctlLevied },
    paymentMethods: body.paymentMethods ?? {},
    hourly: body.hourly ?? [],
    byTill: (body.byTill ?? []).map((t: any) => ({ ...t, this_till: !!own && t.device_id === own })),
    shifts: (body.shifts ?? []).map((s: any) => ({ ...s, declare_codes: s.declare_codes ?? [], this_till: !!own && s.device_id === own })),
    topProducts: body.topProducts ?? [],
    byStaff: body.byStaff ?? [],   // A440 (absent from an older cloud: the card says so)
  };
}

/** What this till holds — every till's rows on a branch server (or a till that receives them), else its own. */
export function localBranchDay(range: ReportRange, fallbackReason: string | null): BranchDay {
  const db = getLocalDb();
  const own = getDeviceConfig()?.device_id ?? null;
  const scope = getReportScope();
  const sales = getSalesSummary(range);

  // branch-wide: A431 — the manager's Overview covers every till this till holds (all of them on a branch server).
  const byTill = (db.prepare(`
    SELECT o.device_id, MAX(s.terminal_code) AS code, COUNT(*) AS orders, COALESCE(SUM(o.total - ${refundedSql('o')}), 0) AS revenue
      FROM orders o LEFT JOIN shifts s ON s.id = o.shift_id
     WHERE o.status = 'completed' AND o.created_at >= ? AND o.created_at <= ?
     GROUP BY o.device_id
  `).all(range.from, range.to) as Array<{ device_id: string | null; code: string | null; orders: number; revenue: number }>)
    .map(t => ({
      device_id: t.device_id, label: t.code || (t.device_id === own ? 'This till' : 'Till'),
      this_till: t.device_id === own, orders: Number(t.orders), revenue: money2(Number(t.revenue)),
    })).sort((a, b) => b.revenue - a.revenue);

  // branch-wide: A431 — every shift this till holds that was open in the range; on a branch server that is every till.
  const rows = db.prepare(`
    SELECT s.id, s.device_id, s.terminal_code, s.status, s.opened_at, s.closed_at, s.opening_float, s.closing_float,
           s.expected_cash, s.cash_variance, s.close_method, s.declared_methods, s.confirmed_at,
           u.name AS cashier, c.name AS confirmer
      FROM shifts s LEFT JOIN users u ON u.id = s.cashier_id LEFT JOIN users c ON c.id = s.confirmed_by
     WHERE s.opened_at <= ? AND (s.status = 'open' OR s.closed_at >= ?)
     ORDER BY s.opened_at DESC LIMIT 200
  `).all(range.to, range.from) as any[];
  const perShift = db.prepare(`
    SELECT COUNT(*) AS orders, COALESCE(SUM(total - ${refundedSql()}), 0) AS sales
      FROM orders WHERE shift_id = ? AND status = 'completed'
  `);
  const perMethod = db.prepare(`
    SELECT p.method, COALESCE(SUM(p.amount), 0) AS amount
      FROM payments p JOIN orders o ON o.id = p.order_id
     WHERE o.shift_id = ? AND o.status = 'completed'
     GROUP BY p.method ORDER BY amount DESC
  `);
  const shifts: BranchShiftRow[] = rows.map(s => {
    const state = localShiftState(s);
    const t = perShift.get(s.id) as { orders: number; sales: number };
    let expected: number | null = state === 'open' ? null : (s.expected_cash == null ? null : Number(s.expected_cash));
    if (state === 'open') { try { expected = computeZReport(s.id).totals.expectedCash; } catch { expected = null; } }
    return {
      id: s.id, device_id: s.device_id ?? null,
      till: s.terminal_code || (s.device_id === own ? 'This till' : 'Till'),
      this_till: s.device_id === own,
      cashier: s.cashier || 'Unknown',
      opened_at: s.opened_at, closed_at: s.closed_at ?? null, state,
      force_closed: s.close_method === 'forced',
      confirmed_by: s.confirmer ?? null,
      opening_float: money2(Number(s.opening_float) || 0),
      orders: Number(t?.orders ?? 0), sales: money2(Number(t?.sales ?? 0)),
      by_method: (perMethod.all(s.id) as Array<{ method: string; amount: number }>).map(m => ({ method: m.method, amount: money2(Number(m.amount)) })),
      expected_cash: expected == null ? null : money2(expected),
      counted_cash: state === 'open' || s.closing_float == null ? null : money2(Number(s.closing_float)),
      variance: state === 'open' || s.cash_variance == null ? null : money2(Number(s.cash_variance)),
      declare_codes: declaredCodes(s.declared_methods),
    };
  }).sort((a, b) => (a.state === 'open' ? 0 : 1) - (b.state === 'open' ? 0 : 1) || b.opened_at.localeCompare(a.opened_at));

  // branch-wide: A440 — staff performance over every sale this till holds in the range (all tills on a branch server).
  const staffSales = db.prepare(`
    SELECT o.id, COALESCE(o.cashier_id, s.cashier_id) AS who, u.name AS name, o.total - ${refundedSql('o')} AS kept
      FROM orders o LEFT JOIN shifts s ON s.id = o.shift_id LEFT JOIN users u ON u.id = COALESCE(o.cashier_id, s.cashier_id)
     WHERE o.status = 'completed' AND o.created_at >= ? AND o.created_at <= ?
  `).all(range.from, range.to) as Array<{ id: string; who: string | null; name: string | null; kept: number }>;
  // branch-wide: A440 — the payments of those sales.
  const staffPays = db.prepare(`
    SELECT p.order_id, p.method, p.amount FROM payments p JOIN orders o ON o.id = p.order_id
     WHERE o.status = 'completed' AND o.created_at >= ? AND o.created_at <= ?
  `).all(range.from, range.to) as Array<{ order_id: string; method: string; amount: number }>;

  return {
    source: 'local',
    scopeLabel: scope.coversBranch
      ? 'What this branch server holds — every till that has synced to it'
      : scope.scopeLabel,
    fallbackReason,
    localCoversBranch: scope.coversBranch,
    summary: sales.summary,
    paymentMethods: sales.paymentMethods,
    hourly: sales.hourly,
    byTill,
    shifts,
    topProducts: getTopProducts(50, range),
    byStaff: staffRows(staffSales.map((o) => ({ ...o, kept: Number(o.kept) || 0 })), staffPays),
  };
}

/** The Overview's figures: the cloud's branch, else this till's, saying which. */
export async function branchDay(range: ReportRange): Promise<BranchDay> {
  try {
    return await cloudBranchDay(range);
  } catch (e) {
    return localBranchDay(range, (e as Error)?.message ?? 'The cloud could not be reached');
  }
}
