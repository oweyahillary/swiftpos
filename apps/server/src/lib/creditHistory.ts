/**
 * creditHistory.ts — A585: a customer's credit history, for the Credit history panel on their profile.
 *
 * Owner's backlog: "who approved a credit limit is recorded but no screen shows it". Two lists:
 *   limits  every grant / change / removal of the limit (audit_log, A567: who, when, before → after), newest first;
 *   sales   their recent sales on account (credit_confirmations, A545) with who sold it, who APPROVED it at the sale
 *           (approved_at_sale_by — the seller themselves or the approver whose PIN was entered) and, for a sale that
 *           waited, who confirmed or disputed it later.
 * Read-only. Before migration 157 (no credit_confirmations) the sales list is empty.
 */
import { supabase } from './supabase';
import { chunkIn } from './pgQuery';

export const LIMIT_ACTIONS = ['customer.credit_limit.granted', 'customer.credit_limit.changed', 'customer.credit_limit.removed'] as const;

export interface LimitChange { at: string; by_name: string | null; action: 'granted' | 'changed' | 'removed'; from: number; to: number;
  /** A585: the branch the person acted at (a manager), or null (the owner, or before A585). */
  branch_name?: string | null }
export interface CreditSaleLine {
  order_id: string; order_number: string | null; sold_at: string; amount: number; state: string; source: string;
  branch_name: string | null; cashier_name: string | null; approved_by_name: string | null; decided_by_name: string | null;
  over_limit: boolean;
}

/** An audit_log row → a limit change (pure). */
export function limitChange(r: { created_at?: string; user_name?: string | null; action?: string; before_data?: any; after_data?: any; branch_id?: string | null },
  branchName: (id: string) => string | null = () => null): LimitChange {
  const from = Number(r.before_data?.credit_limit) || 0;
  const to = Number(r.after_data?.credit_limit) || 0;
  const tail = String(r.action ?? '').split('.').pop();
  const action: LimitChange['action'] = tail === 'granted' ? 'granted' : tail === 'removed' || to === 0 ? 'removed' : 'changed';
  return { at: String(r.created_at ?? ''), by_name: r.user_name ?? null, action, from, to, branch_name: r.branch_id ? branchName(r.branch_id) : null };
}

export async function creditHistory(businessId: string, customerId: string, limit = 50):
  Promise<{ limits: LimitChange[]; sales: CreditSaleLine[] }> {
  const n = Math.min(Math.max(limit, 1), 200);
  const [audit, cc] = await Promise.all([
    supabase.from('audit_log').select('created_at, user_name, action, before_data, after_data, branch_id')
      .eq('business_id', businessId).eq('table_name', 'customers').eq('record_id', customerId)
      .in('action', [...LIMIT_ACTIONS]).order('created_at', { ascending: false }).limit(n),
    supabase.from('credit_confirmations')
      .select('order_id, branch_id, amount, state, source, over_limit, cashier_id, approved_at_sale_by, decided_by, decided_by_name, sold_at')
      .eq('business_id', businessId).eq('customer_id', customerId).order('sold_at', { ascending: false }).limit(n),
  ]);
  if (audit.error) console.warn(`[credit] A585: limit history not read: ${audit.error.message}`);
  if (cc.error) console.warn(`[credit] A585: credit sales not read (is migration 157 applied?): ${cc.error.message}`);
  const auditRows = (audit.data ?? []) as any[];
  const rows = (cc.error ? [] : (cc.data ?? [])) as Array<Record<string, any>>;
  const uniq = (xs: Array<string | null | undefined>) => [...new Set(xs.filter((x): x is string => !!x))];
  // A585: the branch a manager set a limit at.
  const limitBranches: Array<{ id: string; name: string | null }> = await chunkIn<{ id: string; name: string | null }>('branches', 'id', uniq(auditRows.map((r) => r.branch_id)), (x) => x.select('id, name').eq('business_id', businessId)).catch(() => []);
  const LB = new Map<string, string | null>(limitBranches.map((b) => [b.id, b.name ?? null] as [string, string | null]));
  const limits = auditRows.map((r) => limitChange(r, (id) => LB.get(id) ?? null));
  if (!rows.length) return { limits, sales: [] };
  const [orders, people, branches] = await Promise.all([
    chunkIn<{ id: string; order_number: string | null }>('orders', 'id', uniq(rows.map((r) => r.order_id)), (x) => x.select('id, order_number').eq('business_id', businessId)),
    chunkIn<{ id: string; name: string | null }>('users', 'id', uniq(rows.flatMap((r) => [r.cashier_id, r.approved_at_sale_by, r.decided_by])), (x) => x.select('id, name').eq('business_id', businessId)),
    chunkIn<{ id: string; name: string | null }>('branches', 'id', uniq(rows.map((r) => r.branch_id)), (x) => x.select('id, name').eq('business_id', businessId)),
  ]);
  const O = new Map(orders.map((x) => [x.id, x])), P = new Map(people.map((x) => [x.id, x])), B = new Map(branches.map((x) => [x.id, x]));
  const sales = rows.map((r) => ({
    order_id: r.order_id, order_number: O.get(r.order_id)?.order_number ?? null, sold_at: r.sold_at,
    amount: Number(r.amount) || 0, state: r.state, source: r.source, over_limit: !!r.over_limit,
    branch_name: B.get(r.branch_id)?.name ?? null, cashier_name: P.get(r.cashier_id)?.name ?? null,
    approved_by_name: r.approved_at_sale_by ? (P.get(r.approved_at_sale_by)?.name ?? null) : null,
    decided_by_name: r.decided_by_name ?? (r.decided_by ? P.get(r.decided_by)?.name ?? null : null),
  }));
  return { limits, sales };
}
