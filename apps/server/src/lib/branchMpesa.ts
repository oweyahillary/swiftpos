/**
 * branchMpesa.ts — A618: the M-Pesa STK push (Daraja) details a payment uses, per branch, with the business's as default.
 *
 * Owner, 2026-11-01: "it should be per branch since different branches might have different payment method some paybill
 * some buy goods". Until now the details were the business's only (business_settings mpesa_*) and could be put in only by
 * SQL. Now:
 *   - a branch may have its own (branch_mpesa_settings, migration 186): Paybill or Buy Goods, its own shortcode, keys;
 *   - a branch without its own — or whose own is incomplete — uses the business's (business_settings, as before);
 *   - neither: M-Pesa is not set up there (the POS offers the manual reference only).
 * The server tolerates migration 186 not having run: the branch table missing reads as "no branch has its own".
 *
 * Buy Goods: Safaricom signs the request with the STORE number (BusinessShortCode, the password's shortcode); the money goes
 * to the Till number (PartyB) — the same number when the owner left the Till number blank. Paybill: both the shortcode.
 *
 * consumer_secret and passkey are encrypted at rest (lib/crypto.ts, as business.ts does for the business's keys — H9); a
 * legacy plain-text value still decrypts. They never leave the server: the settings screen sees only "saved" / "not saved"
 * and the consumer key's last 4 characters.
 */
import { supabase } from './supabase';
import { decryptSecret } from './crypto';
import { mpesaLabel, type MpesaKind, type MpesaReceive } from './mpesaReceive';

export type MpesaType = 'CustomerPayBillOnline' | 'CustomerBuyGoodsOnline';
export type MpesaEnvironment = 'sandbox' | 'production';
export const MPESA_TYPES: readonly MpesaType[] = ['CustomerPayBillOnline', 'CustomerBuyGoodsOnline'];
export const MPESA_ENVIRONMENTS: readonly MpesaEnvironment[] = ['sandbox', 'production'];

export interface MpesaConfig {
  consumerKey:    string;
  consumerSecret: string;
  shortcode:      string;
  /** Buy Goods: the Till number customers pay to (PartyB); null = the shortcode itself. Paybill: null. */
  tillNumber:     string | null;
  passkey:        string;
  type:           MpesaType;
  /** What the details are for ('sandbox' | 'production'); null = not recorded (details put in by SQL before A618). */
  environment:    MpesaEnvironment | null;
  source:         'branch' | 'business';
}

/** The business's keys in business_settings (A618 adds the Till number, the environment and who saved them). */
export const BUSINESS_MPESA_KEYS = [
  'mpesa_consumer_key', 'mpesa_consumer_secret', 'mpesa_shortcode', 'mpesa_passkey', 'mpesa_type',
  'mpesa_till_number', 'mpesa_environment', 'mpesa_updated_by',
] as const;

/** A branch's own row (branch_mpesa_settings), as stored. */
export interface BranchMpesaRow {
  branch_id:       string;
  business_id:     string;
  type:            string;
  shortcode:       string;
  till_number:     string | null;
  consumer_key:    string;
  consumer_secret: string;
  passkey:         string;
  environment:     string;
  updated_at?:     string | null;
  updated_by?:     string | null;
}

const DIGITS = /^\d{5,8}$/;

// Decrypt without throwing — a missing/rotated APP_ENCRYPTION_KEY or a corrupt value shouldn't crash the payment flow; a
// credential that cannot be read is treated as missing ("not set up"), the visible failure (as lib/etims/index.ts).
function safeDecrypt(v: unknown): string | null {
  if (typeof v !== 'string' || !v) return null;
  try { return decryptSecret(v) || null; } catch { return null; }
}

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim());
const asType = (v: unknown): MpesaType => (v === 'CustomerPayBillOnline' ? 'CustomerPayBillOnline' : 'CustomerBuyGoodsOnline');
const asEnvironment = (v: unknown): MpesaEnvironment | null => (v === 'sandbox' || v === 'production' ? v : null);

/** business_settings rows (key, value) → a key → text map. */
export function settingsMap(rows: Array<{ key: string; value: unknown }> | null | undefined): Record<string, string> {
  const m: Record<string, string> = {};
  for (const r of rows ?? []) m[r.key] = text(r.value);
  return m;
}

/** The business's details → a complete config, or null (a credential missing or unreadable). */
export function businessConfigFrom(cfg: Record<string, string>): MpesaConfig | null {
  const consumerSecret = safeDecrypt(cfg.mpesa_consumer_secret);
  const passkey        = safeDecrypt(cfg.mpesa_passkey);
  if (!cfg.mpesa_consumer_key || !consumerSecret || !cfg.mpesa_shortcode || !passkey) return null;
  const type = asType(cfg.mpesa_type);
  return {
    consumerKey: cfg.mpesa_consumer_key, consumerSecret, shortcode: cfg.mpesa_shortcode, passkey, type,
    tillNumber: type === 'CustomerBuyGoodsOnline' && DIGITS.test(cfg.mpesa_till_number ?? '') ? cfg.mpesa_till_number : null,
    environment: asEnvironment(cfg.mpesa_environment), source: 'business',
  };
}

/** A branch's own row → a complete config, or null (no row, or a credential missing or unreadable: the default applies). */
export function branchConfigFrom(row: BranchMpesaRow | null | undefined): MpesaConfig | null {
  if (!row) return null;
  const consumerSecret = safeDecrypt(row.consumer_secret);
  const passkey        = safeDecrypt(row.passkey);
  if (!text(row.consumer_key) || !consumerSecret || !text(row.shortcode) || !passkey) return null;
  const type = asType(row.type);
  return {
    consumerKey: text(row.consumer_key), consumerSecret, shortcode: text(row.shortcode), passkey, type,
    tillNumber: type === 'CustomerBuyGoodsOnline' && DIGITS.test(text(row.till_number)) ? text(row.till_number) : null,
    environment: asEnvironment(row.environment), source: 'branch',
  };
}

/** The branch's own when complete, else the business's, else null. */
export function resolveMpesaConfig(branch: MpesaConfig | null, business: MpesaConfig | null): MpesaConfig | null {
  return branch ?? business ?? null;
}

/** The STK request's parties: who signs it, where the money goes, and how. */
export function stkParties(cfg: Pick<MpesaConfig, 'shortcode' | 'tillNumber' | 'type'>): { BusinessShortCode: string; PartyB: string; TransactionType: MpesaType } {
  const buyGoods = cfg.type === 'CustomerBuyGoodsOnline';
  return { BusinessShortCode: cfg.shortcode, PartyB: buyGoods && cfg.tillNumber ? cfg.tillNumber : cfg.shortcode, TransactionType: cfg.type };
}

/** Where customers' money goes, in the receipt's terms (shared/mpesaReceive.ts): Buy Goods + the Till number, or Paybill. */
export function payTarget(cfg: Pick<MpesaConfig, 'shortcode' | 'tillNumber' | 'type'>): { kind: MpesaKind; number: string } {
  return { kind: cfg.type === 'CustomerPayBillOnline' ? 'paybill' : 'buy_goods', number: stkParties(cfg).PartyB };
}

/**
 * The warning when a branch's receipt says one M-Pesa number and the STK prompt takes the money to another — a customer
 * paying by hand would pay somewhere else. null when they agree, or either is not set.
 */
export function receiptMismatch(receipt: MpesaReceive | null | undefined, cfg: Pick<MpesaConfig, 'shortcode' | 'tillNumber' | 'type'> | null | undefined): string | null {
  if (!receipt || !cfg) return null;
  const t = payTarget(cfg);
  if (t.kind === receipt.kind && t.number === receipt.number) return null;
  return `Receipts at this branch say ${mpesaLabel(receipt.kind)} ${receipt.number}, but STK payments go to ${mpesaLabel(t.kind)} ${t.number}.`;
}

/** The consumer key's last 4 characters — enough for the owner to recognise it, never the key. */
export function keyLast4(key: unknown): string | null {
  const k = text(key);
  return k.length >= 8 ? k.slice(-4) : k ? '…' : null;
}

/** Safaricom's address for these details. */
export function darajaBase(env: MpesaEnvironment): string {
  return env === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke';
}

// ── The settings form ────────────────────────────────────────────────────────────────────────────────────────────────

export interface MpesaSettingsInput {
  type:            MpesaType;
  shortcode:       string;
  tillNumber:      string | null;
  environment:     MpesaEnvironment;
  /** null = keep the stored one (left blank on the form). */
  consumerKey:     string | null;
  consumerSecret:  string | null;
  passkey:         string | null;
}

/**
 * A form's values → clean details, or the reason they are not (in the owner's words). Blank key, secret or passkey keeps
 * the stored one — so the shortcode can change without typing the secrets again — but the first save needs all three.
 */
export function cleanMpesaSettings(
  body: Record<string, unknown> | null | undefined,
  stored: { key: boolean; secret: boolean; passkey: boolean },
): { ok: true; value: MpesaSettingsInput } | { ok: false; error: string } {
  const b = body ?? {};
  const type = b.type;
  if (type !== 'CustomerPayBillOnline' && type !== 'CustomerBuyGoodsOnline') return { ok: false, error: 'Choose Paybill or Buy Goods.' };
  const shortcode = text(b.shortcode).replace(/\s+/g, '');
  if (!DIGITS.test(shortcode)) {
    return { ok: false, error: type === 'CustomerPayBillOnline' ? 'The Paybill number is 5 to 8 digits.' : 'The store number (shortcode) is 5 to 8 digits.' };
  }
  let tillNumber: string | null = null;
  if (type === 'CustomerBuyGoodsOnline') {
    const t = text(b.till_number).replace(/\s+/g, '');
    if (t && !DIGITS.test(t)) return { ok: false, error: 'The Buy Goods Till number is 5 to 8 digits (or leave it blank).' };
    tillNumber = t || null;
  }
  const environment = b.environment;
  if (environment !== 'sandbox' && environment !== 'production') return { ok: false, error: 'Choose Sandbox or Live.' };
  const consumerKey = text(b.consumer_key) || null;
  const consumerSecret = text(b.consumer_secret) || null;
  const passkey = text(b.passkey) || null;
  if (!consumerKey && !stored.key) return { ok: false, error: 'Enter the consumer key from the Daraja portal.' };
  if (!consumerSecret && !stored.secret) return { ok: false, error: 'Enter the consumer secret from the Daraja portal.' };
  if (!passkey && !stored.passkey) return { ok: false, error: 'Enter the Lipa Na M-Pesa Online passkey.' };
  if ([consumerKey, consumerSecret, passkey].some((v) => v !== null && v.length > 300)) return { ok: false, error: 'A key is too long — paste it again.' };
  return { ok: true, value: { type, shortcode, tillNumber, environment, consumerKey, consumerSecret, passkey } };
}

// ── Reading them ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** PostgREST's answer for a table the database does not have yet (migration 186 not run). */
export function isMissingTable(e: { code?: unknown; message?: unknown } | null | undefined): boolean {
  if (!e) return false;
  return ['42P01', 'PGRST205'].includes(String(e.code ?? '')) || /does not exist|could not find the table|schema cache/i.test(String(e.message ?? ''));
}

/** The business's rows (key, value, updated_at). Throws on a read error. */
export async function readBusinessMpesaRows(businessId: string): Promise<Array<{ key: string; value: unknown; updated_at?: string | null }>> {
  const { data, error } = await supabase.from('business_settings').select('key, value, updated_at')
    .eq('business_id', businessId).in('key', [...BUSINESS_MPESA_KEYS]);
  if (error) throw new Error(error.message);
  return (data ?? []) as Array<{ key: string; value: unknown; updated_at?: string | null }>;
}

/** A branch's own row, or null — also null (logged) when the table is missing or the read fails: the default applies. */
export async function readBranchMpesaRow(businessId: string, branchId: string | null | undefined): Promise<BranchMpesaRow | null> {
  if (!branchId) return null;
  const { data, error } = await supabase.from('branch_mpesa_settings').select('*')
    .eq('business_id', businessId).eq('branch_id', branchId).maybeSingle();
  if (error) {
    if (!isMissingTable(error)) console.warn(`[mpesa] A618: could not read branch ${branchId}'s own M-Pesa details — using the business's:`, error.message);
    return null;
  }
  return (data as BranchMpesaRow | null) ?? null;
}

/**
 * The details a payment at this branch uses: the branch's own when complete, else the business's, else null ("not set
 * up"). Never throws — a failed read is "not set up", as before.
 */
export async function getMpesaConfig(businessId: string, branchId?: string | null): Promise<MpesaConfig | null> {
  const branch = branchConfigFrom(await readBranchMpesaRow(businessId, branchId).catch(() => null));
  if (branch) return branch;
  try {
    return businessConfigFrom(settingsMap(await readBusinessMpesaRows(businessId)));
  } catch {
    return null;
  }
}

// ── Test connection ──────────────────────────────────────────────────────────────────────────────────────────────────

export const TEST_TIMEOUT_MS = 15_000;

/** Daraja's error, in its own words where it gave some. */
export function darajaErrorText(status: number, body: string): string {
  let msg = '';
  try {
    const j = JSON.parse(body) as Record<string, unknown>;
    msg = text(j.errorMessage ?? j.error_description ?? j.error ?? j.ResponseDescription ?? '');
  } catch { msg = text(body); }
  if (!msg) msg = status === 400 || status === 401 ? 'The consumer key or secret was not accepted.' : `Safaricom answered ${status}.`;
  return msg.slice(0, 300);
}

/**
 * Asks Daraja for an access token with these details — the whole test: nobody is charged and nothing is sent to a phone.
 * Sandbox or Live from the details' own environment (the server's when not recorded).
 */
export async function testDarajaConnection(
  cfg: Pick<MpesaConfig, 'consumerKey' | 'consumerSecret'>, env: MpesaEnvironment,
  fetchImpl: typeof fetch = fetch, timeoutMs = TEST_TIMEOUT_MS,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const auth = Buffer.from(`${cfg.consumerKey}:${cfg.consumerSecret}`).toString('base64');
  try {
    const r = await fetchImpl(`${darajaBase(env)}/oauth/v1/generate?grant_type=client_credentials`, {
      headers: { Authorization: `Basic ${auth}` }, signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await r.text();
    if (r.ok) {
      let token = '';
      try { token = text((JSON.parse(body) as Record<string, unknown>).access_token); } catch { /* not JSON */ }
      if (token) return { ok: true };
      return { ok: false, error: 'Safaricom answered without an access token.' };
    }
    return { ok: false, error: darajaErrorText(r.status, body) };
  } catch (e: any) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return { ok: false, error: `Safaricom did not answer within ${Math.round(timeoutMs / 1000)} seconds.` };
    return { ok: false, error: `Could not reach Safaricom (${String(e?.message ?? e).slice(0, 120)}).` };
  }
}
