/**
 * monthlyPackData.ts — A455: read a branch's month for the monthly pack (lib/monthlyPack.ts lays it out).
 *
 * Every read is paged: a month of a busy branch is thousands of orders, and a plain select stops silently at the row
 * cap (lib/pgQuery.ts). Days are business days — the business's "day ends at" cut-off (A382), as every other report.
 */
import { supabase } from './supabase';
import { chunkIn } from './pgQuery';
import { getDayCutoff } from './dayCutoff';
import { businessDateEAT, businessRangeEAT } from './businessDay';
import { buildPack, monthDays, MOVEMENT_KINDS, type Pack, type PackInput, type MovementKind } from './monthlyPack';

const PAGE = 500;

/** Every row a query returns, page by page, ordered by id so no row is read twice or missed. */
async function pageAll<T>(build: () => any): Promise<T[]> {
  const out: T[] = [];
  for (let at = 0; ; at += PAGE) {
    const { data, error } = await build().order('id', { ascending: true }).range(at, at + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as T[]));
    if ((data ?? []).length < PAGE) return out;
  }
}

async function namesOf(ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  const uniq = [...new Set(ids.filter((x): x is string => typeof x === 'string' && x.length > 0))];
  const rows = await chunkIn<{ id: string; name: string | null }>('users', 'id', uniq, (q) => q.select('id, name'));
  return new Map(rows.map((r) => [r.id, r.name ?? '']));
}

const asMap = (v: unknown): Record<string, number> | null => {
  if (!v) return null;
  let o: unknown = v;
  if (typeof o === 'string') { try { o = JSON.parse(o); } catch { return null; } }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const out: Record<string, number> = {};
  for (const [k, x] of Object.entries(o as Record<string, unknown>)) if (Number.isFinite(Number(x))) out[k] = Number(x);
  return out;
};

/** A manager's reasons per method ({ cash: "found 30 under the tray" }), as stored at confirmation (migration 111). */
const asReasons = (v: unknown): Record<string, string> | null => {
  let o: unknown = v;
  if (typeof o === 'string') { try { o = JSON.parse(o); } catch { return null; } }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(o as Record<string, unknown>)) if (typeof x === 'string' && x.trim()) out[k] = x.trim();
  return Object.keys(out).length ? out : null;
};

export async function loadPack(businessId: string, branchId: string, month: string): Promise<Pack> {
  const days = monthDays(month);
  if (!days.length) throw Object.assign(new Error('month must be YYYY-MM'), { status: 400 });
  const [{ data: biz }, { data: br }] = await Promise.all([
    supabase.from('businesses').select('name, currency').eq('id', businessId).maybeSingle(),
    supabase.from('branches').select('id, name').eq('id', branchId).eq('business_id', businessId).maybeSingle(),
  ]);
  if (!br) throw Object.assign(new Error('Branch not found'), { status: 404 });

  const cutoff = await getDayCutoff(businessId, branchId);
  const first = days[0], last = days[days.length - 1];
  const range = businessRangeEAT(first, last, cutoff);
  const dayOf = (iso: string) => businessDateEAT(new Date(iso), cutoff);

  const [orders, shifts, expenses, floats, movements] = await Promise.all([
    pageAll<any>(() => supabase.from('orders').select('id, created_at, payments ( method, amount, status )')
      .eq('business_id', businessId).eq('branch_id', branchId).eq('status', 'completed')
      .gte('created_at', range.start).lte('created_at', range.end)),
    pageAll<any>(() => supabase.from('shifts')
      .select('id, business_date, opened_at, status, cashier_id, expected_methods, confirmed_methods, confirm_reasons, confirmed_at')
      .eq('business_id', businessId).eq('branch_id', branchId)
      .gte('business_date', first).lte('business_date', last)),
    pageAll<any>(() => supabase.from('expenses')
      .select('id, expense_date, description, amount, payment_method, recorded_by, paid_by, expense_categories ( name )')
      .eq('business_id', businessId).eq('branch_id', branchId)
      .gte('expense_date', first).lte('expense_date', last)),
    pageAll<any>(() => supabase.from('float_transactions').select('id, created_at, type, amount, reason')
      .eq('branch_id', branchId).gte('created_at', range.start).lte('created_at', range.end)),
    pageAll<any>(() => supabase.from('money_movements')
      .select('id, movement_date, method, kind, amount, note, recorded_by_name')
      .eq('business_id', businessId).eq('branch_id', branchId)
      .gte('movement_date', first).lte('movement_date', last)),
  ]);
  const names = await namesOf([...shifts.map((s) => s.cashier_id), ...expenses.map((e) => e.recorded_by ?? e.paid_by)]);

  const input: PackInput = {
    businessName: (biz as any)?.name ?? 'ZapTill',
    branchName: (br as any).name ?? 'Branch',
    currency: (biz as any)?.currency ?? 'KES',
    month,
    days,
    orders: orders.map((o) => ({ day: dayOf(o.created_at), payments: (o.payments ?? []).map((p: any) => ({ method: String(p.method), amount: Number(p.amount) || 0, status: String(p.status) })) })),
    shifts: shifts.map((s) => ({
      day: s.business_date ?? dayOf(s.opened_at),
      cashier: names.get(s.cashier_id) || 'Cashier',
      closed: s.status !== 'open',
      expected: asMap(s.expected_methods),
      confirmed: s.confirmed_at ? asMap(s.confirmed_methods) : null,
      reasons: asReasons(s.confirm_reasons),
    })),
    expenses: expenses.map((e) => ({
      day: String(e.expense_date).slice(0, 10),
      type: e.expense_categories?.name ?? null,
      description: String(e.description ?? ''),
      amount: Number(e.amount) || 0,
      method: String(e.payment_method || 'cash'),
      by: names.get(e.recorded_by ?? e.paid_by) || null,
    })),
    floats: floats.map((f) => ({ day: dayOf(f.created_at), type: f.type === 'float_in' ? 'float_in' : 'float_out', amount: Number(f.amount) || 0, reason: f.reason ?? null })),
    movements: movements
      .filter((m) => (MOVEMENT_KINDS as readonly string[]).includes(m.kind))
      .map((m) => ({ day: String(m.movement_date).slice(0, 10), method: String(m.method), kind: m.kind as MovementKind, amount: Number(m.amount) || 0, note: m.note ?? null, by: m.recorded_by_name ?? null })),
  };
  return buildPack(input);
}
