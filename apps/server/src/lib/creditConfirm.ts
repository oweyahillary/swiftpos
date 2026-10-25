/**
 * creditConfirm.ts — A545: every sale on account (credit) is confirmed by a manager.
 *
 * Owner, 2026-10-21: "for credit I think the manager has to know which sale is on credit and they have to confirm that it
 * was done."
 *
 * One row per sale with an on-account payment (credit_confirmations, migration 157):
 *   awaiting  → confirmed (by whom, when)  or  disputed (by whom, when, why).
 *
 * Born state: a sale approved AT THE MOMENT OF SALE — a manager's PIN (A511), or the seller holding customers.credit, or
 * the owner — is born `confirmed` by that person: the manager already knew of it and said yes, asking again would be the
 * same question twice. Everything else (a sale a till already took and sent later — it cannot carry a PIN) is born
 * `awaiting`. A disputed sale stays on the customer's balance (money is owed until someone voids or refunds the sale the
 * normal way); the ledger marks it.
 *
 * Who decides: someone holding customers.credit (A511's key — "Approve sales on account…"; managers by default; the
 * owner always). A manager decides sales of their own branch, the owner any. A sale already decided is re-decided only
 * by the owner (a manager cannot overturn another's dispute). A till that queued a decision while offline sends it
 * later under its own sign-in, naming who decided (`by`): the cloud checks that person may (customers.credit, at the
 * sale's branch) and that the sale is the till's branch's — the A365 / 0.6.30 replay pattern.
 *
 * Day close is NEVER blocked on it (the owner: no deadlocks) — the Close Day / Close Branch screens and the daily e-mail
 * say how many wait.
 */
import { supabase } from './supabase';
import { chunkIn } from './pgQuery';

export type CreditState = 'awaiting' | 'confirmed' | 'disputed';
export type CreditDecision = 'confirm' | 'dispute';
export const CREDIT_STATES: readonly CreditState[] = ['awaiting', 'confirmed', 'disputed'];

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export interface CreditSaleRecord {
  businessId: string;
  orderId: string;
  branchId: string | null;
  customerId: string | null;
  amount: number;
  /** web: a live sale (cloud / web POS) · till: a sale a till already took, sent later. */
  source: 'web' | 'till';
  /** Approved at the moment of sale (A511's PIN approver, or the seller holding customers.credit / the owner). */
  approvedAtSale: boolean;
  /** Who approved it then — a users row, or null (an owner whose sign-in has no users row: approverName 'Owner'). */
  approvedBy: string | null;
  approverName?: string | null;
  cashierId: string | null;
  overLimit?: boolean;
  soldAt?: string | null;
}

/** A545: approved at the moment of sale → born confirmed by that person; else awaiting a manager. */
export function bornState(approvedAtSale: boolean): CreditState {
  return approvedAtSale ? 'confirmed' : 'awaiting';
}

/** The row written for a sale on account (pure — the test runs this exact shape). */
export function creditRow(r: CreditSaleRecord, now: string = new Date().toISOString()) {
  const state = bornState(r.approvedAtSale);
  const soldAt = r.soldAt && !Number.isNaN(Date.parse(r.soldAt)) ? new Date(r.soldAt).toISOString() : now;
  return {
    order_id: r.orderId, business_id: r.businessId, branch_id: r.branchId, customer_id: r.customerId,
    amount: round2(Math.abs(Number(r.amount) || 0)), state, source: r.source, over_limit: !!r.overLimit,
    cashier_id: r.cashierId, approved_at_sale_by: r.approvedBy ?? null,
    decided_by: state === 'confirmed' ? r.approvedBy : null,
    decided_by_name: state === 'confirmed' ? (r.approverName ?? null) : null,
    decided_at: state === 'confirmed' ? soldAt : null,
    sold_at: soldAt,
  };
}

/**
 * Record a sale on account. Never fails the sale: before migration 157 (or on any error) it is logged and the sale
 * stands. A repeat for the same order (a till's retry) keeps the first row.
 */
export async function recordCreditSale(r: CreditSaleRecord): Promise<void> {
  try {
    const row = creditRow(r);
    // business_id: set by creditRow (r.businessId, the sale's business) — both upserts below write that row.
    let { error } = await supabase.from('credit_confirmations').upsert(row, { onConflict: 'order_id', ignoreDuplicates: true });
    // The cashier may be an id with no users row (an owner's last-resort sign-in): the sale is still listed, unnamed.
    if (error && row.cashier_id && /foreign key|23503/i.test(`${error.message} ${(error as { code?: string }).code ?? ''}`)) {
      ({ error } = await supabase.from('credit_confirmations').upsert({ ...row, cashier_id: null }, { onConflict: 'order_id', ignoreDuplicates: true }));
    }
    if (error) console.warn(`[credit] A545: confirmation row not written for order ${r.orderId} (is migration 157 applied?): ${error.message}`);
  } catch (e: any) {
    console.warn(`[credit] A545: confirmation row not written for order ${r.orderId}: ${e?.message ?? e}`);
  }
}

export interface DecisionInput { decision: CreditDecision; reason?: unknown }
export type Refusal = { status: number; body: { error: string; code: string } };

/** What is wrong with a decision on a sale in `state`, or null. `mayOverturn` = the owner (re-deciding a decided sale). */
export function decisionRefusal(state: CreditState | null | undefined, d: DecisionInput, mayOverturn: boolean): Refusal | null {
  if (!state) return { status: 404, body: { error: 'That sale on account was not found.', code: 'CREDIT_SALE_NOT_FOUND' } };
  if (d.decision !== 'confirm' && d.decision !== 'dispute') return { status: 400, body: { error: 'Confirm or dispute.', code: 'BAD_DECISION' } };
  if (d.decision === 'dispute' && !cleanReason(d.reason)) {
    return { status: 400, body: { error: 'Say why it is disputed.', code: 'REASON_REQUIRED' } };
  }
  if (state !== 'awaiting' && state !== targetState(d.decision) && !mayOverturn) {
    return { status: 409, body: { error: `That sale was already ${state} — only the owner can change it now.`, code: 'ALREADY_DECIDED' } };
  }
  return null;
}

export const targetState = (d: CreditDecision): CreditState => (d === 'confirm' ? 'confirmed' : 'disputed');
export function cleanReason(v: unknown): string {
  return typeof v === 'string' ? v.trim().slice(0, 300) : '';
}

/** The decision's own time: the till's (when it was decided offline) if sane — not in the future, not over 30 days old. */
export function decisionTime(at: unknown, now = Date.now()): string {
  const t = typeof at === 'string' ? Date.parse(at) : NaN;
  if (Number.isFinite(t) && t <= now + 5 * 60_000 && t >= now - 30 * 86_400_000) return new Date(t).toISOString();
  return new Date(now).toISOString();
}

export interface CreditListRow {
  order_id: string; order_number: string | null; branch_id: string | null; branch_name: string | null;
  customer_id: string | null; customer_name: string | null; amount: number; state: CreditState; source: string;
  over_limit: boolean; cashier_name: string | null; approved_by_name: string | null; decided_by_name: string | null;
  decided_at: string | null; dispute_reason: string | null; sold_at: string;
}

/** A582: a branch (eq), a partner's "All my branches" (in — never empty: an empty set matches nothing), or every (null). */
function atBranches<Q>(q: Q, b: string | readonly string[] | null): Q {
  if (Array.isArray(b)) return (q as any).in('branch_id', b.length ? [...b] : ['00000000-0000-0000-0000-000000000000']);
  return b ? (q as any).eq('branch_id', b) : q;
}

/** The list a manager (own branch) or the owner (every branch, or the one picked) sees. Before 157: empty. */
export async function listCreditSales(businessId: string, branchId: string | readonly string[] | null, states: CreditState[], limit = 200):
  Promise<CreditListRow[]> {
  let q = supabase.from('credit_confirmations')
    .select('order_id, branch_id, customer_id, amount, state, source, over_limit, cashier_id, approved_at_sale_by, decided_by, decided_by_name, decided_at, dispute_reason, sold_at')
    .eq('business_id', businessId).in('state', states).order('sold_at', { ascending: false }).limit(Math.min(Math.max(limit, 1), 500));
  q = atBranches(q, branchId);   // A582: one branch, a partner's set, or every branch
  const { data, error } = await q;
  if (error) { console.warn(`[credit] A545: list not read (is migration 157 applied?): ${error.message}`); return []; }
  const rows = (data ?? []) as Array<Record<string, any>>;
  if (!rows.length) return [];
  const uniq = (xs: Array<string | null | undefined>) => [...new Set(xs.filter((x): x is string => !!x))];
  const [orders, customers, people, branches] = await Promise.all([
    chunkIn<{ id: string; order_number: string | null }>('orders', 'id', uniq(rows.map((r) => r.order_id)), (x) => x.select('id, order_number').eq('business_id', businessId)),
    chunkIn<{ id: string; name: string | null }>('customers', 'id', uniq(rows.map((r) => r.customer_id)), (x) => x.select('id, name').eq('business_id', businessId)),
    chunkIn<{ id: string; name: string | null }>('users', 'id', uniq(rows.flatMap((r) => [r.cashier_id, r.approved_at_sale_by, r.decided_by])), (x) => x.select('id, name').eq('business_id', businessId)),
    chunkIn<{ id: string; name: string | null }>('branches', 'id', uniq(rows.map((r) => r.branch_id)), (x) => x.select('id, name').eq('business_id', businessId)),
  ]);
  const name = (list: Array<{ id: string; name?: string | null; order_number?: string | null }>) => new Map(list.map((x) => [x.id, x]));
  const O = name(orders), C = name(customers), P = name(people), B = name(branches);
  return rows.map((r) => ({
    order_id: r.order_id, order_number: O.get(r.order_id)?.order_number ?? null,
    branch_id: r.branch_id ?? null, branch_name: B.get(r.branch_id)?.name ?? null,
    customer_id: r.customer_id ?? null, customer_name: C.get(r.customer_id)?.name ?? null,
    amount: Number(r.amount) || 0, state: r.state, source: r.source, over_limit: !!r.over_limit,
    cashier_name: P.get(r.cashier_id)?.name ?? null, approved_by_name: P.get(r.approved_at_sale_by)?.name ?? null,
    decided_by_name: r.decided_by_name ?? P.get(r.decided_by)?.name ?? null, decided_at: r.decided_at ?? null,
    dispute_reason: r.dispute_reason ?? null, sold_at: r.sold_at,
  }));
}

export interface CreditCounts { awaiting: number; awaiting_amount: number; disputed: number; disputed_amount: number }

/** How many wait / are disputed (a branch, or every branch). Before 157 (or on error): zeros — never blocks anything. */
export async function creditCounts(businessId: string, branchId: string | readonly string[] | null): Promise<CreditCounts> {
  const out: CreditCounts = { awaiting: 0, awaiting_amount: 0, disputed: 0, disputed_amount: 0 };
  try {
    let q = supabase.from('credit_confirmations').select('state, amount').eq('business_id', businessId).in('state', ['awaiting', 'disputed']).limit(5000);
    q = atBranches(q, branchId);   // A582: one branch, a partner's set, or every branch
    const { data, error } = await q;
    if (error) return out;
    for (const r of (data ?? []) as Array<{ state: CreditState; amount: number | string }>) {
      if (r.state === 'awaiting') { out.awaiting++; out.awaiting_amount = round2(out.awaiting_amount + (Number(r.amount) || 0)); }
      if (r.state === 'disputed') { out.disputed++; out.disputed_amount = round2(out.disputed_amount + (Number(r.amount) || 0)); }
    }
  } catch { /* zeros */ }
  return out;
}

/** "N credit sales await a manager's confirmation" — '' when none. The words the Close screens and the e-mail use. */
export function awaitingSentence(n: number): string {
  if (!(n > 0)) return '';
  return `${n} credit sale${n === 1 ? '' : 's'} await${n === 1 ? 's' : ''} a manager's confirmation`;
}

const escHtml = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const fmt = (n: number) => n.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * The daily e-mail's credit block: how many wait for a manager, and the disputed ones listed for the owner. '' when
 * there is nothing (the e-mail is unchanged).
 */
export function creditEmailBlock(counts: CreditCounts, disputed: CreditListRow[], currency: string): string {
  if (!counts.awaiting && !counts.disputed) return '';
  const c = escHtml(currency);
  const waiting = counts.awaiting
    ? `<p style="margin:0;">${escHtml(awaitingSentence(counts.awaiting))} — ${c} ${fmt(counts.awaiting_amount)} on account.</p>` : '';
  const list = disputed.slice(0, 20).map((d) => `<li>${escHtml(d.order_number ?? d.order_id.slice(0, 8))} · ${escHtml(d.customer_name ?? 'a customer')} · ${c} ${fmt(d.amount)}`
    + ` — disputed by ${escHtml(d.decided_by_name ?? 'a manager')}: ${escHtml(d.dispute_reason ?? '')}</li>`).join('');
  const disputes = counts.disputed
    ? `<p style="margin:${counts.awaiting ? '8px' : '0'} 0 0;color:#f97316;">Disputed credit sales: <strong>${counts.disputed}</strong> (${c} ${fmt(counts.disputed_amount)}) — still owed until voided or refunded.</p>`
      + (list ? `<ul style="margin:6px 0 0;padding-left:18px;font-size:12px;color:#d1d5db;">${list}</ul>` : '') : '';
  return `
  <tr><td style="padding-top:20px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#111;border:1px solid ${counts.disputed ? '#7c2d12' : '#222'};border-radius:8px;">
      <tr><td style="padding:14px 18px;font-size:13px;color:#fff;">
        ${waiting}${disputes}
        <p style="margin:6px 0 0;font-size:11px;color:#6b7280;">Customers › Credit › Credit sales to confirm.</p>
      </td></tr>
    </table>
  </td></tr>`;
}
