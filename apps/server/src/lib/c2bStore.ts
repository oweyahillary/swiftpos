/**
 * c2bStore.ts — A621: the database side of M-Pesa payment notifications (migration 188). The rules are in lib/c2b.ts;
 * the routes (routes/c2b.ts, routes/c2bSettings.ts) only call these.
 *
 * Every read is narrow (the columns the caller shows, one branch, a time window) — the POS asks while its payment screen
 * is open, so a wide read would cost Supabase egress on every sale (lib/c2bActivity.ts skips the read when nothing moved).
 * The server tolerates migration 188 not having run: the tables missing read as "not switched on".
 */
import { supabase } from './supabase';
import { isMissingTable } from './branchMpesa';
import { claimRefusal, type C2bPayment, type ClaimRefusal, type PosPayment } from './c2b';

export const SETTINGS_TABLE = 'branch_c2b_settings';
export const PAYMENTS_TABLE = 'mpesa_c2b_payments';

export interface C2bSettingsRow {
  branch_id:              string;
  business_id:            string;
  enabled:                boolean;
  store_number:           string | null;
  token_hash:             string | null;
  registered_at:          string | null;
  registered_shortcode:   string | null;
  registered_environment: string | null;
  last_error:             string | null;
}

const SETTINGS_COLUMNS = 'branch_id, business_id, enabled, store_number, token_hash, registered_at, registered_shortcode, registered_environment, last_error';
const POS_COLUMNS = 'trans_id, amount, first_name, bill_ref, trans_time, created_at';

interface PosRow { trans_id: string; amount: unknown; first_name: string | null; bill_ref: string | null; trans_time: string | null; created_at: string }

/** A row as the POS shows it: the time paid is Safaricom's, else when it reached us. */
function asPosPayment(r: PosRow): PosPayment {
  return { trans_id: r.trans_id, amount: Number(r.amount), first_name: r.first_name, bill_ref: r.bill_ref, paid_at: r.trans_time ?? r.created_at };
}

// ── Settings ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Every branch's row of the business — { table: false } while migration 188 has not run. Throws on another error. */
export async function readAllC2bSettings(businessId: string): Promise<{ rows: C2bSettingsRow[]; table: boolean }> {
  const { data, error } = await supabase.from(SETTINGS_TABLE).select(SETTINGS_COLUMNS).eq('business_id', businessId);
  if (error) {
    if (isMissingTable(error)) return { rows: [], table: false };
    throw new Error(error.message);
  }
  return { rows: (data ?? []) as C2bSettingsRow[], table: true };
}

/** One branch's row, or null (none, the table missing, or a failed read — logged: notifications read as off). */
export async function readC2bSettings(businessId: string, branchId: string): Promise<C2bSettingsRow | null> {
  const { data, error } = await supabase.from(SETTINGS_TABLE).select(SETTINGS_COLUMNS)
    .eq('business_id', businessId).eq('branch_id', branchId).maybeSingle();
  if (error) {
    if (!isMissingTable(error)) console.warn(`[c2b] A621: could not read branch ${branchId}'s payment notifications:`, error.message);
    return null;
  }
  return (data as C2bSettingsRow | null) ?? null;
}

export interface WriteError { message: string; missingTable: boolean }

/** Writes a branch's row (added when it has none). Returns what went wrong, or null. */
export async function writeC2bSettings(businessId: string, branchId: string, patch: Partial<C2bSettingsRow>, userId: string | null): Promise<WriteError | null> {
  const { error } = await supabase.from(SETTINGS_TABLE).upsert({
    branch_id: branchId, business_id: businessId, ...patch, updated_at: new Date().toISOString(), updated_by: userId,
  }, { onConflict: 'branch_id' });
  return error ? { message: error.message, missingTable: isMissingTable(error) } : null;
}

/** The branch a callback token belongs to (by its hash), or null. */
export async function branchOfToken(tokenHash: string): Promise<Pick<C2bSettingsRow, 'branch_id' | 'business_id' | 'enabled'> | null> {
  const { data, error } = await supabase.from(SETTINGS_TABLE).select('branch_id, business_id, enabled').eq('token_hash', tokenHash).maybeSingle();
  if (error) {
    console.error('[c2b] A621: could not look up a callback token:', error.message);
    return null;
  }
  return (data as Pick<C2bSettingsRow, 'branch_id' | 'business_id' | 'enabled'> | null) ?? null;
}

// ── Payments arriving ────────────────────────────────────────────────────────────────────────────────────────────────

/** Keeps a confirmed payment. 'new' the first time; 'duplicate' for Safaricom's retry of the same code; 'error' (logged). */
export async function keepPayment(businessId: string, branchId: string, p: C2bPayment): Promise<'new' | 'duplicate' | 'error'> {
  const { data, error } = await supabase.from(PAYMENTS_TABLE).upsert({
    business_id: businessId, branch_id: branchId, shortcode: p.shortcode, trans_id: p.transId, trans_type: p.transType,
    amount: p.amount, trans_time: p.transTime, bill_ref: p.billRef, first_name: p.firstName, phone_masked: p.phoneMasked,
    status: 'received',
    // This server's clock, the same clock the POS list's 30-minute window is measured with (waitingPayments).
    created_at: new Date().toISOString(),
  }, { onConflict: 'trans_id', ignoreDuplicates: true }).select('trans_id');
  if (error) {
    console.error(`[c2b] A621: payment ${p.transId} (KES ${p.amount}) for branch ${branchId} was NOT kept — reconcile against the M-Pesa statement:`, error.message);
    return 'error';
  }
  return (data ?? []).length > 0 ? 'new' : 'duplicate';
}

// ── The POS's list ───────────────────────────────────────────────────────────────────────────────────────────────────

/** The branch's payments nobody has taken yet, arrived since `sinceIso`, newest first (at most 30). */
export async function waitingPayments(businessId: string, branchId: string, sinceIso: string): Promise<PosPayment[]> {
  const { data, error } = await supabase.from(PAYMENTS_TABLE).select(POS_COLUMNS)
    .eq('business_id', businessId).eq('branch_id', branchId).eq('status', 'received')
    .gte('created_at', sinceIso).order('created_at', { ascending: false }).limit(30);
  if (error) throw new Error(error.message);
  return ((data ?? []) as PosRow[]).map(asPosPayment);
}

// ── Claiming, releasing, using ───────────────────────────────────────────────────────────────────────────────────────

export type ClaimResult = { ok: true; payment: PosPayment } | { ok: false; refusal: ClaimRefusal };

/**
 * Takes a waiting payment for this POS's bill. One UPDATE … WHERE status = 'received': of two POSs tapping the same
 * payment, the database lets exactly one through — the other is told plainly. A payment this POS already holds (a retried
 * tap, the POS restarted) is taken again for this bill.
 */
export async function claimPayment(businessId: string, branchId: string, transId: string, holder: string, saleRef: string): Promise<ClaimResult> {
  const hold = { status: 'held', held_by: holder, held_ref: saleRef, held_at: new Date().toISOString() };
  const scoped = () => supabase.from(PAYMENTS_TABLE).update(hold)
    .eq('business_id', businessId).eq('branch_id', branchId).eq('trans_id', transId);

  const first = await scoped().eq('status', 'received').select(POS_COLUMNS);
  if (first.error) throw new Error(first.error.message);
  if ((first.data ?? []).length) return { ok: true, payment: asPosPayment(first.data![0] as PosRow) };

  const { data: row, error } = await supabase.from(PAYMENTS_TABLE).select('status, held_by, held_ref')
    .eq('business_id', businessId).eq('branch_id', branchId).eq('trans_id', transId).maybeSingle();
  if (error) throw new Error(error.message);
  const refusal = claimRefusal(row as { status: string; held_by: string | null; held_ref: string | null } | null, holder);
  if (refusal) return { ok: false, refusal };

  const again = await scoped().eq('status', 'held').eq('held_by', holder).select(POS_COLUMNS);
  if (again.error) throw new Error(again.error.message);
  if (!(again.data ?? []).length) return { ok: false, refusal: { status: 409, code: 'TAKEN', error: 'Another POS has just taken that payment for its bill.' } };
  return { ok: true, payment: asPosPayment(again.data![0] as PosRow) };
}

/** Gives a payment back to the list — only by the POS that holds it, for the same bill. true when one was given back. */
export async function releasePayment(businessId: string, branchId: string, transId: string, holder: string, saleRef: string): Promise<boolean> {
  const { data, error } = await supabase.from(PAYMENTS_TABLE)
    .update({ status: 'received', held_by: null, held_ref: null, held_at: null })
    .eq('business_id', businessId).eq('branch_id', branchId).eq('trans_id', transId)
    .eq('status', 'held').eq('held_by', holder).eq('held_ref', saleRef).select('trans_id');
  if (error) throw new Error(error.message);
  return (data ?? []).length > 0;
}

/**
 * The owner gives a held payment back to every POS's list, whoever holds it — a POS whose sale never reached the cloud
 * keeps it otherwise (owner, 2026-11-03: a Release button). Returns the payment's branch, or null when it was not held.
 */
export async function releaseHeldPayment(businessId: string, transId: string): Promise<string | null> {
  const { data, error } = await supabase.from(PAYMENTS_TABLE)
    .update({ status: 'received', held_by: null, held_ref: null, held_at: null })
    .eq('business_id', businessId).eq('trans_id', transId).eq('status', 'held').select('branch_id');
  if (error) throw new Error(error.message);
  return (data as Array<{ branch_id: string }> | null)?.[0]?.branch_id ?? null;
}

/**
 * An order reached the cloud carrying these M-Pesa codes: those payments are used (whoever held them, or none — a code
 * typed by hand counts too). Never throws: the sale is already safe; a failure is logged and the payment stays in the
 * day's unmatched list for the owner. Returns the branches whose list changed.
 */
export async function markPaymentsUsed(businessId: string, orderId: string, codes: string[]): Promise<string[]> {
  if (!codes.length) return [];
  const { data, error } = await supabase.from(PAYMENTS_TABLE)
    .update({ status: 'used', order_id: orderId, used_at: new Date().toISOString() })
    .eq('business_id', businessId).in('trans_id', codes).neq('status', 'used').select('branch_id');
  if (error) {
    if (!isMissingTable(error)) console.error(`[c2b] A621: order ${orderId}'s M-Pesa payments (${codes.join(', ')}) were not marked used:`, error.message);
    return [];
  }
  return [...new Set(((data ?? []) as Array<{ branch_id: string }>).map((r) => r.branch_id))];
}

// ── The owner's day list ─────────────────────────────────────────────────────────────────────────────────────────────

export interface DayPayment {
  trans_id: string; amount: number; first_name: string | null; phone_masked: string | null; bill_ref: string | null;
  paid_at: string; status: string; held_by: string | null; held_at: string | null; branch_id: string;
}

/** A day's payments not on any sale (waiting, or held by a POS whose sale has not arrived), oldest first. */
export async function unmatchedPayments(businessId: string, branchId: string | null, range: { start: string; end: string }): Promise<DayPayment[]> {
  let q = supabase.from(PAYMENTS_TABLE)
    .select('trans_id, amount, first_name, phone_masked, bill_ref, trans_time, created_at, status, held_by, held_at, branch_id')
    .eq('business_id', businessId).neq('status', 'used').gte('created_at', range.start).lte('created_at', range.end)
    .order('created_at', { ascending: true }).limit(500);
  if (branchId) q = q.eq('branch_id', branchId);
  const { data, error } = await q;
  if (error) {
    if (isMissingTable(error)) return [];
    throw error;
  }
  return ((data ?? []) as Array<Omit<DayPayment, 'paid_at'> & { trans_time: string | null; created_at: string }>).map((r) => ({
    trans_id: r.trans_id, amount: Number(r.amount), first_name: r.first_name, phone_masked: r.phone_masked, bill_ref: r.bill_ref,
    paid_at: r.trans_time ?? r.created_at, status: r.status, held_by: r.held_by, held_at: r.held_at, branch_id: r.branch_id,
  }));
}
