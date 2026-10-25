/**
 * ownerAlertsData.ts — A476: the reads behind the owner's emails (open tills, cash differences, voids and refunds,
 * tills not syncing, expenses, the weekly figures) and who receives them. Every read is scoped to one business, paged
 * or capped, and throws on a database error so the caller can drop that one section (or that one business) and carry on.
 *
 * The decisions are in ownerAlertsDecision.ts and the HTML in ownerEmails.ts; this file only fetches and shapes.
 */
import { hasPermission } from '../lib/permissions';   // A490
import { isOwnerRoleName } from '../lib/ownerRole';
import { keysForRow } from '../lib/effectiveKeys';
import { supabase } from '../lib/supabase';
import { chunkIn } from '../lib/pgQuery';
import { webTillName } from '../lib/terminalLabel';
import { computeExpectedCash } from '../routes/shifts';
import {
  cashDifference, selectOpenTills, type OpenTillRow, type ShiftLite, type DeviceLite, type AlertSettings,
} from './ownerAlertsDecision';
import {
  openTillsSection, variancesSection, voidsRefundsSection, notSyncingSection, expensesSection,
  type OpenTillLine, type VarianceLine, type ReversalLine, type SyncLine, type ExpenseLine, type WeekFigures,
} from './ownerEmails';

const PAGE = 500;
/** No email section reads more than this many rows (a week of a very busy business stays well under it). */
const MAX_ROWS = 50_000;
/** At most this many open drawers get a live expected-cash figure per email (each is a few queries). */
const MAX_EXPECTED = 50;

/** Every row of a query, page by page in id order, up to MAX_ROWS. */
export async function pageAll<T>(build: () => any, maxRows = MAX_ROWS): Promise<T[]> {
  const out: T[] = [];
  for (let at = 0; at < maxRows; at += PAGE) {
    const { data, error } = await build().order('id', { ascending: true }).range(at, at + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as T[]));
    if ((data ?? []).length < PAGE) break;
  }
  return out;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The owner's sign-in email, lower-cased; null when there is none (or the id is not a UUID — getUserById throws). */
export async function ownerEmailOf(ownerId: string | null | undefined): Promise<string | null> {
  if (!ownerId || !UUID_RE.test(ownerId)) return null;
  try {
    const { data, error } = await supabase.auth.admin.getUserById(ownerId);
    if (error) return null;
    return data?.user?.email?.trim().toLowerCase() || null;
  } catch { return null; }
}

/** The owner + the addresses the owner added in the Report Scheduler, de-duplicated. */
export async function ownerAndExtras(biz: { owner_id: string }, schedule: { recipients?: unknown }): Promise<string[]> {
  const set = new Set<string>();
  const owner = await ownerEmailOf(biz.owner_id);
  if (owner) set.add(owner);
  for (const r of Array.isArray(schedule.recipients) ? schedule.recipients : []) {
    const e = String(r ?? '').trim().toLowerCase();
    if (e.includes('@')) set.add(e);
  }
  return [...set];
}

/**
 * A490: who gets a branch's report e-mails — staff (never the owner's role: the owner is sent theirs anyway) whose
 * effective keys hold `reports.overview`. It used to be the role NAMES Manager / Branch Manager.
 */
export function receivesBranchReports(u: { roles?: any; user_permissions?: any[] | null }): boolean {
  const role = Array.isArray(u.roles) ? u.roles[0] : u.roles;
  if (isOwnerRoleName(role?.name)) return false;
  return hasPermission(keysForRow({ roles: role ?? null, user_permissions: u.user_permissions ?? [] }, false), 'reports.overview');
}

/**
 * Each branch's managers: active users with an email who hold reports.overview (receivesBranchReports), on the branches
 * they are assigned to (user_branches; a manager with no assignment works every branch, as sign-in treats them).
 */
export async function branchManagerEmails(businessId: string): Promise<{ byBranch: Map<string, string[]>; everyBranch: string[] }> {
  const { data, error } = await supabase
    .from('users').select('id, email, roles ( name, role_permissions ( permissions ( key ) ) ), user_branches ( branch_id ), user_permissions ( granted, permissions ( key ) )')
    .eq('business_id', businessId).eq('status', 'active').not('email', 'is', null)
    .limit(2000);
  if (error) throw new Error(error.message);
  const byBranch = new Map<string, string[]>();
  const every = new Set<string>();
  for (const u of (data ?? []) as any[]) {
    if (!receivesBranchReports(u)) continue;
    const email = String(u.email ?? '').trim().toLowerCase();
    if (!email.includes('@')) continue;
    const branches = ((u.user_branches ?? []) as any[]).map((b) => b?.branch_id).filter(Boolean) as string[];
    if (!branches.length) { every.add(email); continue; }
    for (const b of branches) byBranch.set(b, [...new Set([...(byBranch.get(b) ?? []), email])]);
  }
  return { byBranch, everyBranch: [...every] };
}

export function managersOf(m: { byBranch: Map<string, string[]>; everyBranch: string[] }, branchId: string): string[] {
  return [...new Set([...(m.byBranch.get(branchId) ?? []), ...m.everyBranch])];
}

export async function branchNames(businessId: string): Promise<Map<string, string>> {
  const { data, error } = await supabase.from('branches').select('id, name').eq('business_id', businessId).limit(1000);
  if (error) throw new Error(error.message);
  return new Map(((data ?? []) as any[]).map((b) => [b.id, b.name ?? 'Branch']));
}

export async function userNames(ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  const uniq = [...new Set(ids.filter((x): x is string => typeof x === 'string' && x.length > 0))];
  const rows = await chunkIn<{ id: string; name: string | null }>('users', 'id', uniq, (q) => q.select('id, name'));
  return new Map(rows.map((r) => [r.id, r.name ?? '']));
}

async function tillNames(businessId: string, deviceIds: (string | null | undefined)[]): Promise<Map<string, string>> {
  const uniq = [...new Set(deviceIds.filter((x): x is string => typeof x === 'string' && x.length > 0))];
  const rows = await chunkIn<{ device_id: string; device_label: string | null; terminal_code: string | null }>(
    'user_devices', 'device_id', uniq, (q) => q.select('device_id, device_label, terminal_code').eq('business_id', businessId));
  const out = new Map<string, string>();
  for (const r of rows) {
    const name = r.terminal_code || r.device_label;
    if (name && !out.has(r.device_id)) out.set(r.device_id, name);
  }
  return out;
}

// ── open / unconfirmed tills ─────────────────────────────────────────────────

export interface OpenShiftRow extends ShiftLite {
  cashier_id: string | null;
  device_id: string | null;
  terminal_code: string | null;
  opening_float: number | string | null;
  expected_cash: number | string | null;
  expected_methods: unknown;
}

const OPEN_COLS = 'id, branch_id, cashier_id, device_id, terminal_code, opened_at, closed_at, status, business_date, declared_methods, confirmed_at, opening_float, expected_cash, expected_methods';

/** Every drawer still open, and every closed one waiting for a manager's count — 500 of each at most. */
export async function loadOpenShifts(businessId: string, branchId?: string): Promise<OpenShiftRow[]> {
  let open = supabase.from('shifts').select(OPEN_COLS).eq('business_id', businessId).eq('status', 'open');
  let waiting = supabase.from('shifts').select(OPEN_COLS).eq('business_id', businessId).neq('status', 'open')
    .not('declared_methods', 'is', null).is('confirmed_at', null);
  if (branchId) { open = open.eq('branch_id', branchId); waiting = waiting.eq('branch_id', branchId); }
  const [a, b] = await Promise.all([
    open.order('opened_at', { ascending: true }).limit(500),
    waiting.order('closed_at', { ascending: false }).limit(500),
  ]);
  if (a.error) throw new Error(a.error.message);
  if (b.error) throw new Error(b.error.message);
  return [...((a.data ?? []) as OpenShiftRow[]), ...((b.data ?? []) as OpenShiftRow[])];
}

const methodCash = (v: unknown): number | null => {
  let o: unknown = v;
  if (typeof o === 'string') { try { o = JSON.parse(o); } catch { return null; } }
  const x = o && typeof o === 'object' ? Number((o as any).cash) : NaN;
  return Number.isFinite(x) ? x : null;
};

/** The lines an email shows for the chosen shifts: branch, till, cashier, opened, status, expected cash. */
export async function openTillLines(businessId: string, rows: OpenTillRow<OpenShiftRow>[], branches: Map<string, string>): Promise<OpenTillLine[]> {
  if (!rows.length) return [];
  const [people, tills] = await Promise.all([
    userNames(rows.map((r) => r.shift.cashier_id)),
    tillNames(businessId, rows.map((r) => r.shift.device_id)),
  ]);
  const expected = new Map<string, number | null>();
  let live = 0;
  for (const r of rows) {
    const s = r.shift;
    if (r.state === 'awaiting_confirm') {
      const e = methodCash(s.expected_methods);
      const n = e !== null ? e : (s.expected_cash === null || s.expected_cash === undefined ? null : Number(s.expected_cash));
      expected.set(s.id, Number.isFinite(n as number) ? (n as number) : null);
    } else if (live < MAX_EXPECTED) {
      live++;
      try { expected.set(s.id, await computeExpectedCash(s.id, Number(s.opening_float) || 0)); } catch { expected.set(s.id, null); }
    }
  }
  return rows.map((r) => {
    const s = r.shift;
    const branch = branches.get(s.branch_id) ?? 'Branch';
    return {
      branch,
      till: (s.device_id && tills.get(s.device_id)) || s.terminal_code || webTillName(branch),
      cashier: (s.cashier_id && people.get(s.cashier_id)) || 'Unknown',
      openedAt: s.opened_at,
      state: r.state,
      older: r.older,
      expectedCash: expected.get(s.id) ?? null,
    };
  });
}

// ── tills (devices) ──────────────────────────────────────────────────────────

export interface DeviceRow extends DeviceLite {
  device_label: string | null;
  terminal_code: string | null;
  session_lost_reason?: string | null;
  security_alert_reason?: string | null;
}

/** The business's live tills. Without migration 125 (no session_lost_at) it reads them without the sign-in state. */
export async function loadDevices(businessId: string): Promise<DeviceRow[]> {
  const base = 'id, device_id, branch_id, device_label, terminal_code, status, retired_at, last_seen_at, last_sync_at, app_version';   // A579: app_version (migration 36)
  const q = (cols: string) => supabase.from('user_devices').select(cols)
    .eq('business_id', businessId).eq('status', 'approved').is('retired_at', null).limit(500);
  // A477 (migration 131): and whether another computer seems to hold its data.
  const full = await q(`${base}, session_lost_at, session_lost_reason, security_alert_at, security_alert_reason`);
  if (!full.error) return (full.data ?? []) as unknown as DeviceRow[];
  const first = await q(`${base}, session_lost_at, session_lost_reason`);
  if (!first.error) return (first.data ?? []) as unknown as DeviceRow[];
  const second = await q(base);
  if (second.error) throw new Error(second.error.message);
  return (second.data ?? []) as unknown as DeviceRow[];
}

export const deviceName = (d: { device_label?: string | null; terminal_code?: string | null }): string =>
  d.terminal_code || d.device_label || 'POS';

// ── the daily email's new sections ───────────────────────────────────────────

export interface DailyExtrasInput {
  businessId: string;
  currency: string;
  settings: AlertSettings;
  reportDate: string;       // the business day being reported (YYYY-MM-DD)
  cutoff: number;           // minutes
  range: { start: string; end: string };
  now: Date;
}

/** One section, isolated: a failed read drops that section (logged), never the email. */
async function section(name: string, f: () => Promise<string>): Promise<string> {
  try { return await f(); } catch (e: any) { console.error(`[dailySummary] ${name} section skipped:`, e?.message); return ''; }
}

/** The daily email's A476 sections as HTML rows, each only when switched on and when it has something to say. */
export async function dailyExtrasHtml(i: DailyExtrasInput): Promise<string> {
  const { businessId, currency, settings: s } = i;
  let branches = new Map<string, string>();
  try { branches = await branchNames(businessId); } catch (e: any) { console.error('[dailySummary] branch names:', e?.message); }
  let html = '';

  if (s.open_tills) html += await section('open points of sale', async () => {
    const rows = selectOpenTills(await loadOpenShifts(businessId), i.reportDate, i.cutoff, 'report');
    return openTillsSection(await openTillLines(businessId, rows, branches), currency);
  });

  if (s.variances) html += await section('variances', async () => {
    const { data, error } = await supabase.from('shifts')
      .select('id, branch_id, cashier_id, device_id, terminal_code, expected_methods, confirmed_methods, cash_variance, confirm_reasons, confirmed_at')
      .eq('business_id', businessId).gte('confirmed_at', i.range.start).lte('confirmed_at', i.range.end)
      .order('confirmed_at', { ascending: true }).limit(500);
    if (error) throw new Error(error.message);
    const withDiff = ((data ?? []) as any[]).map((x) => ({ x, d: cashDifference(x) })).filter((v) => v.d !== null && Math.abs(v.d) >= 0.01);
    if (!withDiff.length) return '';
    const [people, tills] = await Promise.all([userNames(withDiff.map((v) => v.x.cashier_id)), tillNames(businessId, withDiff.map((v) => v.x.device_id))]);
    return variancesSection(withDiff.map(({ x, d }) => varianceLine(x, d as number, branches, people, tills)), currency);
  });

  if (s.voids_refunds) html += await section('voids and refunds', async () => {
    const voids = await pageAll<any>(() => supabase.from('orders')
      .select('id, order_number, total, void_reason, cashier_id, voided_by, branch_id, created_at, voided_at')
      .eq('business_id', businessId).eq('status', 'voided').gte('created_at', i.range.start).lte('created_at', i.range.end), 5000);
    const refunds = await pageAll<any>(() => supabase.from('orders')
      .select('id, order_number, refunded_amount, refund_reason, cashier_id, refunded_by, branch_id, refunded_at')
      .eq('business_id', businessId).not('refunded_at', 'is', null).gte('refunded_at', i.range.start).lte('refunded_at', i.range.end), 5000);
    if (!voids.length && !refunds.length) return '';
    const all = [
      ...voids.map((o) => ({ o, kind: 'void' as const, amount: Number(o.total) || 0, by: o.voided_by || o.cashier_id, reason: o.void_reason, at: o.voided_at || o.created_at })),
      ...refunds.map((o) => ({ o, kind: 'refund' as const, amount: Number(o.refunded_amount) || 0, by: o.refunded_by || o.cashier_id, reason: o.refund_reason, at: o.refunded_at })),
    ].sort((a, b) => b.amount - a.amount);
    const top = all.slice(0, 10);
    const people = await userNames(top.map((t) => t.by));
    const lines: ReversalLine[] = top.map((t) => ({
      kind: t.kind, orderNumber: String(t.o.order_number ?? t.o.id).slice(0, 40), branch: branches.get(t.o.branch_id) ?? '—',
      cashier: (t.by && people.get(t.by)) || 'Unknown', amount: t.amount, reason: t.reason ?? null, at: t.at ?? null,
    }));
    return voidsRefundsSection(lines, {
      voids: voids.length, voidValue: voids.reduce((x, o) => x + (Number(o.total) || 0), 0),
      refunds: refunds.length, refundValue: refunds.reduce((x, o) => x + (Number(o.refunded_amount) || 0), 0),
    }, currency);
  });

  if (s.tills_not_syncing) html += await section('points of sale not syncing', async () => {
    const lines: SyncLine[] = [];
    for (const d of await loadDevices(businessId)) {
      const hours = d.last_sync_at ? (i.now.getTime() - Date.parse(d.last_sync_at)) / 3_600_000 : null;
      const refused = !!d.session_lost_at;
      if (!refused && (hours === null || hours < s.not_syncing_hours)) continue;
      lines.push({ branch: (d.branch_id && branches.get(d.branch_id)) || '—', till: deviceName(d), lastSyncAt: d.last_sync_at ?? null, hours, refused });
    }
    return notSyncingSection(lines.sort((a, b) => Number(b.refused) - Number(a.refused) || (b.hours ?? 0) - (a.hours ?? 0)));
  });

  if (s.expenses) html += await section('expenses', async () => {
    const rows = await pageAll<any>(() => supabase.from('expenses')
      .select('id, branch_id, description, amount, payment_method, expense_categories ( name )')
      .eq('business_id', businessId).eq('expense_date', i.reportDate), 5000);
    if (!rows.length) return '';
    const total = rows.reduce((x, e) => x + (Number(e.amount) || 0), 0);
    const lines: ExpenseLine[] = [...rows].sort((a, b) => (Number(b.amount) || 0) - (Number(a.amount) || 0)).slice(0, 15).map((e) => ({
      branch: branches.get(e.branch_id) ?? '—',
      description: e.description ?? '',
      category: (Array.isArray(e.expense_categories) ? e.expense_categories[0]?.name : e.expense_categories?.name) || 'Uncategorised',
      method: e.payment_method ?? 'cash',
      amount: Number(e.amount) || 0,
    }));
    return expensesSection(lines, total, rows.length, currency);
  });

  return html;
}

export function varianceLine(x: any, d: number, branches: Map<string, string>, people: Map<string, string>, tills: Map<string, string>): VarianceLine & { confirmedBy?: string | null } {
  const cash = (v: unknown) => methodCash(v);
  let reasons: any = x.confirm_reasons;
  if (typeof reasons === 'string') { try { reasons = JSON.parse(reasons); } catch { reasons = null; } }
  const branch = branches.get(x.branch_id) ?? '—';
  return {
    branch,
    till: (x.device_id && tills.get(x.device_id)) || x.terminal_code || webTillName(branch),
    cashier: (x.cashier_id && people.get(x.cashier_id)) || 'Unknown',
    expected: cash(x.expected_methods),
    counted: cash(x.confirmed_methods),
    difference: d,
    reason: reasons && typeof reasons.cash === 'string' ? reasons.cash : null,
    confirmedBy: x.confirmed_by ? (people.get(x.confirmed_by) ?? null) : null,
  };
}

// ── the weekly figures ───────────────────────────────────────────────────────

export async function weekFigures(businessId: string, range: { start: string; end: string }, fromDate: string, toDate: string): Promise<WeekFigures> {
  const orders = await pageAll<{ id: string; total: number | string }>(() => supabase.from('orders').select('id, total')
    .eq('business_id', businessId).eq('status', 'completed').gte('created_at', range.start).lte('created_at', range.end));
  const voids = await pageAll<{ id: string; total: number | string }>(() => supabase.from('orders').select('id, total')
    .eq('business_id', businessId).eq('status', 'voided').gte('created_at', range.start).lte('created_at', range.end), 10_000);
  const expenses = await pageAll<{ id: string; amount: number | string }>(() => supabase.from('expenses').select('id, amount')
    .eq('business_id', businessId).gte('expense_date', fromDate).lte('expense_date', toDate), 10_000);
  const { data: conf, error: cErr } = await supabase.from('shifts')
    .select('id, expected_methods, confirmed_methods, cash_variance, confirmed_at')
    .eq('business_id', businessId).gte('confirmed_at', range.start).lte('confirmed_at', range.end).limit(2000);
  if (cErr) throw new Error(cErr.message);
  const diffs = ((conf ?? []) as any[]).map((s) => cashDifference(s)).filter((d): d is number => d !== null && Math.abs(d) >= 0.01);

  const sales = orders.reduce((x, o) => x + (Number(o.total) || 0), 0);
  // top items: the week's order lines, 20,000 orders at most (chunked; a URL never overflows)
  const items = await chunkIn<{ product_name: string; quantity: string; subtotal: string }>(
    'order_items', 'order_id', orders.slice(0, 20_000).map((o) => o.id), (q) => q.select('product_name, quantity, subtotal'));
  const byName = new Map<string, { qty: number; revenue: number }>();
  for (const it of items) {
    const k = it.product_name ?? 'Item';
    const v = byName.get(k) ?? { qty: 0, revenue: 0 };
    byName.set(k, { qty: v.qty + (Number(it.quantity) || 0), revenue: v.revenue + (Number(it.subtotal) || 0) });
  }
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return {
    sales: r2(sales), orders: orders.length, avg: orders.length ? r2(sales / orders.length) : 0,
    voids: voids.length, voidValue: r2(voids.reduce((x, o) => x + (Number(o.total) || 0), 0)),
    expenses: r2(expenses.reduce((x, e) => x + (Number(e.amount) || 0), 0)),
    varianceShifts: diffs.length, varianceNet: r2(diffs.reduce((x, d) => x + d, 0)),
    topItems: [...byName].map(([name, v]) => ({ name, qty: v.qty, revenue: r2(v.revenue) })).sort((a, b) => b.revenue - a.revenue).slice(0, 5),
  };
}
