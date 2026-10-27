/**
 * branchCredit.ts — A595 (owner decision D4, 2026-10-27): credit limits with branches.
 *
 *   1. CEILING   business setting `credit_max_limit` (KES): nobody but the owner gives a customer a limit above it — a
 *                manager, a General Manager, a partner are refused with a plain message. None set: no ceiling.
 *   2. LOCK      when the OWNER sets a limit they may lock it (customers.credit_limit_locked, locked_by / at): a locked limit
 *                — and that customer's branch limits — is changed by the owner only.
 *   3. BRANCHES  branch setting `credit_enabled` ('false' = no sales on account at that branch; absent = on, as before):
 *                the POS (desktop and web) refuses a sale on account there and the cloud refuses it too.
 *   4. PARTNERS  owner setting `credit_partner_branches` (owner only): when on, a partner turns credit on / off for their own
 *                branches and sets a customer's limit AT one of their branches (customer_branch_credit_limits) — what the
 *                customer may owe at that branch only; never another branch's; capped by the ceiling; refused when the
 *                owner locked that customer's limit.
 *   5. AT A SALE the balance owed AT THAT BRANCH against its branch limit when one is set; else the business-wide limit
 *                against everything owed (today's rule). "Owed here / owed in total" on the POS picker and the profile.
 *   6. AUDIT     every change in the audit log (who, branch, old → new) — the Credit history panel (lib/creditHistory.ts).
 * Pure rules first (the tests run them as they are), then the reads.
 */
import { supabase } from './supabase';

export const CREDIT_MAX_KEY = 'credit_max_limit';
export const PARTNER_CREDIT_KEY = 'credit_partner_branches';
export const BRANCH_CREDIT_KEY = 'credit_enabled';

export interface CreditSettings { maxLimit: number | null; partnersDecide: boolean }

/** A stored value → the ceiling (a positive number) or none. */
export function readMaxLimit(raw: unknown): number | null {
  let v: unknown = raw;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { /* a plain number string */ } }
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}
export function readOn(raw: unknown): boolean {
  let v: unknown = raw;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { /* as it is */ } }
  return v === true || v === 'true';
}
/** A branch's `credit_enabled` value: only an explicit off turns credit off (absent = on, as before A595). */
export function branchCreditOn(raw: unknown): boolean {
  let v: unknown = raw;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { /* as it is */ } }
  return !(v === false || v === 'false' || v === 0 || v === '0');
}

export const OVER_CEILING = (max: number) => ({ error: `Only the owner sets a credit limit above ${max.toFixed(2)} (the owner's maximum).`, code: 'OVER_CREDIT_CEILING' });
export const LIMIT_LOCKED = { error: 'The owner locked this customer\'s credit limit — only the owner changes it.', code: 'CREDIT_LIMIT_LOCKED' } as const;
export const CREDIT_OFF_HERE = { error: 'This branch does not sell on account. The owner turns credit on for a branch in Credit settings.', code: 'CREDIT_OFF_AT_BRANCH' } as const;
export const PARTNERS_OFF = { error: 'Only the owner decides credit at a branch (the owner can let partners decide at their own branches).', code: 'PARTNERS_DO_NOT_DECIDE' } as const;
export const NOT_YOUR_BRANCH = { error: 'You can only decide credit at your own branches.', code: 'NOT_YOUR_BRANCH' } as const;

/** Why this limit may not be set by this person (null = it may). Pure. */
export function limitRefusal(o: { owner: boolean; amount: number; max: number | null; locked: boolean }): { error: string; code: string } | null {
  if (o.owner) return null;
  if (o.locked) return { ...LIMIT_LOCKED };
  if (o.max !== null && o.amount > o.max + 1e-9) return OVER_CEILING(o.max);
  return null;
}

/**
 * What a customer may still take on account at a branch (pure): with a branch limit, that limit less what they owe AT that
 * branch; else the business-wide limit less everything they owe (A552's rule).
 */
export function creditAvailable(o: { limit: number; owedTotal: number; branchLimit: number | null; owedHere: number }): number {
  const r = (n: number) => Math.round(n * 100) / 100;
  return o.branchLimit !== null ? r(o.branchLimit - o.owedHere) : r(o.limit - o.owedTotal);
}

/** May this partner decide credit at this branch: the owner's switch on, and the branch one of theirs. Pure. */
export function partnerDecidesAt(req: { webPartner?: unknown; allBranches?: unknown; partnerBranches?: unknown; branchSet?: unknown },
  settings: CreditSettings, branchId: string): { error: string; code: string } | null {
  if (req.webPartner !== true) return { ...PARTNERS_OFF };
  if (!settings.partnersDecide) return { ...PARTNERS_OFF };
  const mine = Array.isArray(req.partnerBranches) ? (req.partnerBranches as unknown[]) : [];
  if (req.allBranches === true || mine.includes(branchId)) return null;
  return { ...NOT_YOUR_BRANCH };
}

// ── reads ──────────────────────────────────────────────────────────────────────────────────────────────────────────
export async function loadCreditSettings(businessId: string): Promise<CreditSettings> {
  try {
    const { data } = await supabase.from('business_settings').select('key, value').eq('business_id', businessId)
      .in('key', [CREDIT_MAX_KEY, PARTNER_CREDIT_KEY]);
    const by = new Map(((data ?? []) as Array<{ key: string; value: unknown }>).map((r) => [r.key, r.value]));
    return { maxLimit: readMaxLimit(by.get(CREDIT_MAX_KEY)), partnersDecide: readOn(by.get(PARTNER_CREDIT_KEY)) };
  } catch { return { maxLimit: null, partnersDecide: false }; }
}

/** Is credit on at this branch (absent / unreadable = on, as before). */
export async function branchCreditEnabled(businessId: string, branchId: string | null | undefined): Promise<boolean> {
  if (!branchId) return true;
  try {
    const { data } = await supabase.from('branch_settings').select('value').eq('business_id', businessId)
      .eq('branch_id', branchId).eq('key', BRANCH_CREDIT_KEY).maybeSingle();
    return branchCreditOn((data as { value?: unknown } | null)?.value ?? null);
  } catch { return true; }
}

/** The customer's limit at a branch (null = none set) — before the table exists (migration 178): none. */
export async function branchLimitOf(businessId: string, customerId: string, branchId: string | null | undefined): Promise<number | null> {
  if (!branchId) return null;
  try {
    const { data, error } = await supabase.from('customer_branch_credit_limits').select('credit_limit')
      .eq('business_id', businessId).eq('customer_id', customerId).eq('branch_id', branchId).maybeSingle();
    if (error || !data) return null;
    const n = Number((data as { credit_limit?: unknown }).credit_limit);
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}

/** What the customer owes at a branch: the sum of their ledger lines recorded there (charges less repayments there). */
export async function owedAtBranch(businessId: string, customerId: string, branchId: string | null | undefined): Promise<number> {
  if (!branchId) return 0;
  try {
    const { data } = await supabase.from('customer_credit_transactions').select('amount')
      .eq('business_id', businessId).eq('customer_id', customerId).eq('branch_id', branchId);
    return Math.round(((data ?? []) as Array<{ amount: unknown }>).reduce((s, r) => s + (Number(r.amount) || 0), 0) * 100) / 100;
  } catch { return 0; }
}

/** Every branch limit of a business (the POS's offline copy, one branch). */
export async function branchLimitsAt(businessId: string, branchId: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  try {
    const { data, error } = await supabase.from('customer_branch_credit_limits').select('customer_id, credit_limit')
      .eq('business_id', businessId).eq('branch_id', branchId);
    if (error) return out;
    for (const r of (data ?? []) as Array<{ customer_id: string; credit_limit: unknown }>) out.set(r.customer_id, Number(r.credit_limit) || 0);
  } catch { /* none */ }
  return out;
}

/** What each customer owes at a branch (the POS's offline copy). */
export async function owedByCustomerAt(businessId: string, branchId: string, customerIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!customerIds.length) return out;
  try {
    const { data } = await supabase.from('customer_credit_transactions').select('customer_id, amount')
      .eq('business_id', businessId).eq('branch_id', branchId).in('customer_id', customerIds);
    for (const r of (data ?? []) as Array<{ customer_id: string; amount: unknown }>) out.set(r.customer_id, (out.get(r.customer_id) ?? 0) + (Number(r.amount) || 0));
  } catch { /* none */ }
  for (const [k, v] of out) out.set(k, Math.round(v * 100) / 100);
  return out;
}

/** A595 D4: one audit line (best-effort, never fails the change). */
export async function auditCredit(req: any, action: string, customerId: string | null, before: unknown, after: unknown, branchId: string | null = null): Promise<void> {
  try {
    const { data: me } = req.userId ? await supabase.from('users').select('name').eq('id', req.userId).maybeSingle() : { data: null };
    const { error } = await supabase.from('audit_log').insert({
      business_id: req.businessId, branch_id: branchId, user_id: req.userId ?? null,
      user_name: (me as { name?: string } | null)?.name ?? (req.isOwner ? 'Owner' : null),
      action, table_name: customerId ? 'customers' : 'branch_settings', record_id: customerId, before_data: before, after_data: after,
    });
    if (error) console.error('[credit] A595 audit not written:', error.message);
  } catch (e) { console.error('[credit] A595 audit not written:', (e as Error)?.message ?? e); }
}
