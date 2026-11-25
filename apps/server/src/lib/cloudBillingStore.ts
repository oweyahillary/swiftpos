/**
 * cloudBillingStore.ts — A626: the Supabase side of ZapTill's cloud-billing Paybill (migration 195). Service role only.
 * Mirrors lib/c2bStore.ts: a single registration row and a raw receipts feed deduped on the M-Pesa code (trans_id).
 */
import { supabase } from './supabase';
import { normalizeBillRef } from './cloudBilling';
import type { C2bPayment } from './c2b';

export const SETTINGS_TABLE = 'zaptill_billing_c2b';
export const RECEIPTS_TABLE = 'cloud_billing_receipts';

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
}
export interface WriteError { message: string; missingTable: boolean }

const SETTINGS_COLUMNS = 'token_hash, registered_at, registered_shortcode, registered_environment, last_error';
const RECEIPT_COLUMNS = 'id, trans_id, shortcode, trans_type, amount, trans_time, bill_ref, bill_ref_norm, first_name, phone_masked, status, business_id, created_at';
const isMissingTable = (e: { code?: string } | null): boolean => e?.code === '42P01';

/** The single registration row (null when none yet); `table:false` when migration 195 has not run. */
export async function readBillingC2bSettings(): Promise<{ row: BillingC2bSettings | null; table: boolean }> {
  const { data, error } = await supabase.from(SETTINGS_TABLE).select(SETTINGS_COLUMNS).eq('singleton', true).maybeSingle();
  if (error) return { row: null, table: !isMissingTable(error as { code?: string }) };
  return { row: (data as BillingC2bSettings) ?? null, table: true };
}

/** Upsert the single registration row. */
export async function writeBillingC2bSettings(patch: Partial<BillingC2bSettings>, userId: string | null): Promise<WriteError | null> {
  const { error } = await supabase.from(SETTINGS_TABLE).upsert(
    { singleton: true, ...patch, updated_at: new Date().toISOString(), updated_by: userId },
    { onConflict: 'singleton' },
  );
  if (error) return { message: error.message, missingTable: isMissingTable(error as { code?: string }) };
  return null;
}

/** Does the incoming callback token's SHA-256 match the registered one? (The plaintext token lives only in Safaricom's URL.) */
export async function billingTokenMatches(tokenHash: string): Promise<boolean> {
  const { data, error } = await supabase.from(SETTINGS_TABLE).select('singleton').eq('token_hash', tokenHash).maybeSingle();
  if (error) return false;
  return !!data;
}

/** Keep one confirmed payment, once per M-Pesa code. 'new' the first time, 'duplicate' on a retry, 'error' on failure. */
export async function keepReceipt(p: C2bPayment): Promise<'new' | 'duplicate' | 'error'> {
  const { data, error } = await supabase.from(RECEIPTS_TABLE).upsert(
    {
      trans_id: p.transId, shortcode: p.shortcode, trans_type: p.transType, amount: p.amount, trans_time: p.transTime,
      bill_ref: p.billRef, bill_ref_norm: normalizeBillRef(p.billRef), first_name: p.firstName, phone_masked: p.phoneMasked,
      status: 'received', created_at: new Date().toISOString(),
    },
    { onConflict: 'trans_id', ignoreDuplicates: true },
  ).select('id');
  if (error) return 'error';
  return (data ?? []).length ? 'new' : 'duplicate';
}

/** The receipts feed for the admin, newest first. */
export async function recentReceipts(fromIso: string | null, toIso: string | null, limit = 100): Promise<BillingReceipt[]> {
  let q = supabase.from(RECEIPTS_TABLE).select(RECEIPT_COLUMNS).order('created_at', { ascending: false }).limit(Math.min(Math.max(limit, 1), 500));
  if (fromIso) q = q.gte('created_at', fromIso);
  if (toIso) q = q.lte('created_at', toIso);
  const { data, error } = await q;
  if (error) return [];
  return (data ?? []) as BillingReceipt[];
}
