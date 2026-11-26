/**
 * cloudBilling.ts — A626: ZapTill's own cloud-billing M-Pesa Paybill (clients pay their subscription with a code).
 *
 * Phase 1 (the pipe): ZapTill's single Daraja credentials come from ENV (deployment config, not a DB form — these are
 * ZapTill's master keys), the C2B callback registers under /api/cloud-billing/c2b/... (A621's branch C2B uses
 * /api/payments/c2b/... — a distinct path so they never collide), and a raw receipt is kept per M-Pesa code.
 *
 * Reuses lib/c2b.ts for the token + forbidden-word rules and the confirmation parse; lib/c2bDaraja.ts (register, simulate)
 * and lib/branchMpesa.ts (darajaBase) for Safaricom. Matching/wallet/allocation are Phase 2.
 */
import { forbiddenWordIn } from './c2b';
import type { MpesaEnvironment } from './branchMpesa';

export const BILLING_CONFIRM_PATH = '/api/cloud-billing/c2b/confirm';
export const BILLING_VALIDATE_PATH = '/api/cloud-billing/c2b/validate';

/** ZapTill's single Daraja config for the billing Paybill, from env — or null when it is not fully set. `type` is the
 *  Daraja CommandID (what c2bDaraja's simulate expects); the owner chose a Paybill (A626 §12.3), so it defaults to it. */
export interface ZaptillDaraja { consumerKey: string; consumerSecret: string; shortcode: string; type: 'CustomerPayBillOnline' | 'CustomerBuyGoodsOnline' }
export function zaptillDaraja(): ZaptillDaraja | null {
  const consumerKey = (process.env.ZAPTILL_MPESA_CONSUMER_KEY ?? '').trim();
  const consumerSecret = (process.env.ZAPTILL_MPESA_CONSUMER_SECRET ?? '').trim();
  const shortcode = (process.env.ZAPTILL_MPESA_SHORTCODE ?? '').trim();
  if (!consumerKey || !consumerSecret || !/^\d{5,8}$/.test(shortcode)) return null;
  const type = process.env.ZAPTILL_MPESA_TYPE === 'buygoods' ? 'CustomerBuyGoodsOnline' : 'CustomerPayBillOnline';
  return { consumerKey, consumerSecret, shortcode, type };
}

/** The Daraja environment the server runs against (shared with the branch M-Pesa code). */
export function serverEnvironment(): MpesaEnvironment {
  return process.env.MPESA_ENVIRONMENT === 'production' ? 'production' : 'sandbox';
}

/** The cloud's public https base Safaricom calls (same env var the branch C2B uses). */
export function callbackBase(): string {
  return process.env.MPESA_CALLBACK_BASE_URL ?? 'https://api.zaptill.co.ke';
}

/**
 * The two addresses for a billing token, or the reason they cannot be registered — mirrors c2bUrls but under the
 * cloud-billing path. The token is hex (never a forbidden word); only the base address could trip the check.
 */
export function billingC2bUrls(base: string, token: string): { ok: true; confirm: string; validate: string } | { ok: false; error: string } {
  let root = base.trim();
  while (root.endsWith('/')) root = root.slice(0, -1);
  if (!/^https:\/\/[^/\s]+/i.test(root)) return { ok: false, error: 'The server\'s public address must start with https:// — Safaricom calls only secure addresses.' };
  const confirm = `${root}${BILLING_CONFIRM_PATH}/${token}`;
  const validate = `${root}${BILLING_VALIDATE_PATH}/${token}`;
  const word = forbiddenWordIn(confirm);
  if (word) return { ok: false, error: `Safaricom refuses an address containing "${word}". The server's public address must change first.` };
  return { ok: true, confirm, validate };
}

/**
 * A reversal of an earlier payment: Safaricom's confirmation body is a reversal (TransactionType "Reversal"), not a fresh
 * payment — so the pipe never records a reversed payment as income. Returns the reversed payment's M-Pesa code (the
 * OriginalTransactionID, under Safaricom's spellings) plus the reversal's own code, or null when the body is not a reversal.
 * The admin's Reverse action is the reliable path; this only catches a reversal Safaricom happens to push in this shape.
 */
export function reversalOf(body: unknown): { originalTransId: string | null; transId: string | null } | null {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  if (!/revers/i.test(String(b.TransactionType ?? ''))) return null;
  const code = (v: unknown): string | null => {
    const t = (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '').trim().toUpperCase();
    return /^[A-Z0-9]{8,20}$/.test(t) ? t : null;
  };
  return {
    originalTransId: code(b.OriginalTransactionID) ?? code(b.OriginalTransactionId) ?? code(b.OriginalTransID),
    transId: code(b.TransID),
  };
}

/**
 * Validate a super-admin wallet adjustment (a credit, or a debit/refund paid out-of-band) against the current balance.
 * A debit may not exceed the balance — the wallet never goes negative and the ledger stays honest (the recorded delta
 * always equals the balance change). Returns the clean signed delta + reason, or an error with a code.
 */
export function creditAdjustment(deltaRaw: unknown, reasonRaw: unknown, balance: number): { delta: number; reason: string } | { error: string; code: string } {
  const delta = Math.round(Number(deltaRaw) * 100) / 100;
  if (!Number.isFinite(delta) || delta === 0) return { error: 'Enter an amount to add or remove.', code: 'BAD_AMOUNT' };
  if (Math.abs(delta) > 10_000_000) return { error: 'That amount is too large.', code: 'BAD_AMOUNT' };
  const reason = (typeof reasonRaw === 'string' ? reasonRaw.trim() : '').slice(0, 120);
  if (!reason) return { error: 'A reason is required for a wallet adjustment.', code: 'NO_REASON' };
  const held = Math.round(Number(balance) * 100) / 100;
  if (delta < 0 && -delta > held + 1e-9) return { error: `Cannot remove more than the KES ${held.toLocaleString('en-KE')} balance.`, code: 'INSUFFICIENT' };
  return { delta, reason };
}

/** A client's billing code / the account number a payer types — normalised for storage and (Phase 2) matching: trimmed,
 *  upper-cased, non-alphanumerics stripped, so "acme", "ACME ", "Acme", "ac-me" all become "ACME". null when empty. */
export function normalizeBillRef(v: string | null | undefined): string | null {
  const s = (v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return s || null;
}
