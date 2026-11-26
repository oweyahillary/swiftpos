/**
 * cloudBillingStore.ts — A626: the Supabase side of ZapTill's cloud-billing Paybill (migrations 195, 196). Service role
 * only. A single registration row, a raw receipts feed deduped on the M-Pesa code, and the per-client billing code the
 * account number is matched to. Phase 2a: match a receipt to a client by its code; assign an unmatched one by hand.
 */
import crypto from 'node:crypto';
import { supabase } from './supabase';
import { normalizeBillRef } from './cloudBilling';
import type { C2bPayment } from './c2b';

// Table names are written as string LITERALS in every .from(...) below (not a const) so the schema-drift parser
// (scripts/check-api-schema-drift.mjs, regex-based) resolves each table and never mis-attributes a column.

export interface BillingC2bSettings {
  token_hash: string | null;
  registered_at: string | null;
  registered_shortcode: string | null;
  registered_environment: string | null;
  last_error: string | null;
}
export interface BillingReceipt {
  id: string; trans_id: string; shortcode: string; trans_type: string | null; amount: number; trans_time: string | null;
  bill_ref: string | null; bill_ref_norm: string | null; first_name: string | null; phone_masked: string | null;
  status: string; business_id: string | null; created_at: string;
  business_name?: string | null;   // A626 Phase 2a: the matched client (attached below), null when unmatched
}
export interface WriteError { message: string; missingTable: boolean }

const SETTINGS_COLUMNS = 'token_hash, registered_at, registered_shortcode, registered_environment, last_error';
const RECEIPT_COLUMNS = 'id, trans_id, shortcode, trans_type, amount, trans_time, bill_ref, bill_ref_norm, first_name, phone_masked, status, business_id, created_at';
const isMissingTable = (e: { code?: string } | null): boolean => e?.code === '42P01';
const isUniqueViolation = (e: { code?: string } | null): boolean => e?.code === '23505';

// ── the registration ─────────────────────────────────────────────────────────────────────────────────────────────────
/** The single registration row (null when none yet); `table:false` when migration 195 has not run. */
export async function readBillingC2bSettings(): Promise<{ row: BillingC2bSettings | null; table: boolean }> {
  const { data, error } = await supabase.from('zaptill_billing_c2b').select(SETTINGS_COLUMNS).eq('singleton', true).maybeSingle();
  if (error) return { row: null, table: !isMissingTable(error as { code?: string }) };
  return { row: (data as BillingC2bSettings) ?? null, table: true };
}

/** Upsert the single registration row. */
export async function writeBillingC2bSettings(patch: Partial<BillingC2bSettings>, userId: string | null): Promise<WriteError | null> {
  const { error } = await supabase.from('zaptill_billing_c2b').upsert(
    { singleton: true, ...patch, updated_at: new Date().toISOString(), updated_by: userId },
    { onConflict: 'singleton' },
  );
  if (error) return { message: error.message, missingTable: isMissingTable(error as { code?: string }) };
  return null;
}

/** Does the incoming callback token's SHA-256 match the registered one? (The plaintext token lives only in Safaricom's URL.) */
export async function billingTokenMatches(tokenHash: string): Promise<boolean> {
  const { data, error } = await supabase.from('zaptill_billing_c2b').select('singleton').eq('token_hash', tokenHash).maybeSingle();
  if (error) return false;
  return !!data;
}

// ── the billing code (the account number → a client) ─────────────────────────────────────────────────────────────────
/** The business whose billing code matches this normalised account number, or null (Phase 2a: exact-on-normalised only). */
export async function matchBillingCode(norm: string | null): Promise<string | null> {
  if (!norm) return null;
  const { data, error } = await supabase.from('businesses').select('id').eq('billing_code_norm', norm).maybeSingle();
  if (error) return null;
  return (data as { id: string } | null)?.id ?? null;
}

/** A client's billing code, or null. */
export async function billingCodeOf(businessId: string): Promise<string | null> {
  const { data } = await supabase.from('businesses').select('billing_code').eq('id', businessId).maybeSingle();
  return (data as { billing_code: string | null } | null)?.billing_code ?? null;
}

/** Set a client's billing code (keeps billing_code_norm in step); a code another client holds → an error. */
export async function setBillingCode(businessId: string, code: string): Promise<{ code: string } | { error: string }> {
  const clean = code.trim();
  const norm = normalizeBillRef(clean);
  if (!norm) return { error: 'The code must have letters or numbers.' };
  const { error } = await supabase.from('businesses').update({ billing_code: clean, billing_code_norm: norm }).eq('id', businessId);
  if (error) return { error: isUniqueViolation(error as { code?: string }) ? 'That code is already used by another client.' : error.message };
  return { code: clean };
}

/** A client's code, generating one from its name (unique) if it has none. Null when there is no such client. */
export async function ensureBillingCode(businessId: string): Promise<string | null> {
  const { data: biz } = await supabase.from('businesses').select('name, billing_code').eq('id', businessId).maybeSingle();
  if (!biz) return null;
  const existing = (biz as { billing_code: string | null }).billing_code;
  if (existing) return existing;
  const base = (String((biz as { name: string | null }).name ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6)) || 'BIZ';
  for (let n = 1; n <= 50; n++) {
    const cand = n === 1 ? base : `${base}${n}`;
    if (await matchBillingCode(normalizeBillRef(cand))) continue;
    const r = await setBillingCode(businessId, cand);
    if ('code' in r) return r.code;   // a race on the unique index → try the next suffix
  }
  return existing ?? null;
}

// ── the receipts ─────────────────────────────────────────────────────────────────────────────────────────────────────
/** Keep one confirmed payment, once per M-Pesa code, matched to a client by its account code. 'new' / 'duplicate' / 'error'. */
export async function keepReceipt(p: C2bPayment): Promise<'new' | 'duplicate' | 'error'> {
  const norm = normalizeBillRef(p.billRef);
  const business_id = await matchBillingCode(norm);   // A626 Phase 2a: who paid, by the account code
  const { data, error } = await supabase.from('cloud_billing_receipts').upsert(
    {
      id: crypto.randomUUID(), trans_id: p.transId, shortcode: p.shortcode, trans_type: p.transType, amount: p.amount, trans_time: p.transTime,
      bill_ref: p.billRef, bill_ref_norm: norm, first_name: p.firstName, phone_masked: p.phoneMasked,
      business_id, status: business_id ? 'matched' : 'unmatched', created_at: new Date().toISOString(),
    },
    { onConflict: 'trans_id', ignoreDuplicates: true },
  ).select('id');
  if (error) return 'error';
  return (data ?? []).length ? 'new' : 'duplicate';
}

/** Assign an unmatched receipt to a client (an admin fixes a typo'd account number). */
export async function assignReceipt(receiptId: string, businessId: string): Promise<{ ok: true } | { error: string }> {
  const { data, error } = await supabase.from('cloud_billing_receipts').update({ business_id: businessId, status: 'matched' }).eq('id', receiptId).select('id');
  if (error) return { error: error.message };
  if (!(data ?? []).length) return { error: 'No such receipt.' };
  return { ok: true };
}

/** The receipts feed, newest first, with each matched client's name attached. */
export async function recentReceipts(fromIso: string | null, toIso: string | null, limit = 100): Promise<BillingReceipt[]> {
  let q = supabase.from('cloud_billing_receipts').select(RECEIPT_COLUMNS).order('created_at', { ascending: false }).limit(Math.min(Math.max(limit, 1), 500));
  if (fromIso) q = q.gte('created_at', fromIso);
  if (toIso) q = q.lte('created_at', toIso);
  const { data, error } = await q;
  if (error) return [];
  const rows = (data ?? []) as BillingReceipt[];
  const ids = [...new Set(rows.map((r) => r.business_id).filter((x): x is string => !!x))];
  if (ids.length) {
    const { data: bizs } = await supabase.from('businesses').select('id, name').in('id', ids);
    const name = new Map(((bizs ?? []) as Array<{ id: string; name: string | null }>).map((b) => [b.id, b.name]));
    for (const r of rows) r.business_name = r.business_id ? (name.get(r.business_id) ?? null) : null;
  }
  return rows;
}

/** One receipt by its M-Pesa code (so the callback can allocate what it just kept). */
export async function receiptByTransId(transId: string): Promise<{ id: string; business_id: string | null; amount: number } | null> {
  const { data } = await supabase.from('cloud_billing_receipts').select('id, business_id, amount').eq('trans_id', transId).maybeSingle();
  return (data as { id: string; business_id: string | null; amount: number } | null) ?? null;
}

/** Move a receipt's status (received → matched/unmatched → allocated). */
export async function setReceiptStatus(receiptId: string, status: string): Promise<void> {
  await supabase.from('cloud_billing_receipts').update({ status }).eq('id', receiptId);
}

// ── the credit wallet (A626 Phase 2b) ────────────────────────────────────────────────────────────────────────────────
export interface CreditEntry { id: string; delta: number; reason: string | null; receipt_id: string | null; created_by: string | null; created_at: string }

/** A client's credit balance (0 when it has no wallet row yet). */
export async function walletOf(businessId: string): Promise<number> {
  const { data } = await supabase.from('business_cloud_credit').select('balance').eq('business_id', businessId).maybeSingle();
  return Number((data as { balance: number | string } | null)?.balance ?? 0);
}

/** The credit ledger, newest first. */
export async function creditEntries(businessId: string, limit = 50): Promise<CreditEntry[]> {
  const { data } = await supabase.from('cloud_credit_entries').select('id, delta, reason, receipt_id, created_by, created_at')
    .eq('business_id', businessId).order('created_at', { ascending: false }).limit(Math.min(Math.max(limit, 1), 200));
  return (data ?? []) as CreditEntry[];
}

/** Add `delta` to a client's wallet (never below 0) and record the ledger entry. Returns the new balance. */
export async function addCredit(businessId: string, delta: number, reason: string, receiptId: string | null, by: string | null): Promise<number> {
  const next = Math.max(Math.round((await walletOf(businessId) + delta) * 100) / 100, 0);
  await supabase.from('business_cloud_credit').upsert(
    { business_id: businessId, balance: next, currency: 'KES', updated_at: new Date().toISOString() },
    { onConflict: 'business_id' },
  );
  await supabase.from('cloud_credit_entries').insert(
    { id: crypto.randomUUID(), business_id: businessId, delta, reason, receipt_id: receiptId, created_by: by, created_at: new Date().toISOString() },
  );
  return next;
}

/** Clients that currently hold credit (balance > 0) — the auto-drain pass touches only these. */
export async function businessesWithCredit(): Promise<string[]> {
  const { data } = await supabase.from('business_cloud_credit').select('business_id').gt('balance', 0);
  return ((data ?? []) as Array<{ business_id: string }>).map((r) => r.business_id);
}
