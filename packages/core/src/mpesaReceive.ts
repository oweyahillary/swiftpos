/**
 * mpesaReceive.ts — A492: how a branch's customers pay it by M-Pesa, set on the till by its manager.
 *
 * Owner, 2026-10-15: "payment method are not global each branch has a till number or paybill number … that should be set
 * on the desktop app not web, the manager should be the one doing it not the owner, if its paybill they have to set an
 * account number if its buy goods they dont have to".
 *
 *   Buy Goods — a till number (Lipa na M-Pesa → Buy Goods and Services): the number alone.
 *   Paybill   — a business number AND an account number (Lipa na M-Pesa → Pay Bill): both, always.
 *
 * Stored per branch in branch_settings as receipt_pay_label ('Buy Goods' | 'Paybill'), receipt_pay_number and
 * receipt_pay_account (A450's keys, so a till on an older build keeps printing the line). The receipt prints
 * "Buy Goods: 123456" or "Paybill: 4098201, Account 1234" (mpesaReceiptNumber goes in A450's number field).
 *
 * Pure, no imports. Copies kept identical by scripts/check-shared-sync.mjs.
 */

export type MpesaKind = 'buy_goods' | 'paybill';

export interface MpesaReceive {
  kind: MpesaKind;
  /** Buy Goods: the till number. Paybill: the business number. Digits only. */
  number: string;
  /** Paybill: the account number customers enter. Buy Goods: null. */
  account: string | null;
}

export const MPESA_KINDS: Array<{ kind: MpesaKind; label: string; numberLabel: string; help: string }> = [
  { kind: 'buy_goods', label: 'Buy Goods', numberLabel: 'Till number',
    help: 'Customers choose Buy Goods and Services and enter this till number.' },
  { kind: 'paybill', label: 'Paybill', numberLabel: 'Business number',
    help: 'Customers choose Pay Bill, enter the business number and then the account number.' },
];

/** Safaricom till and paybill numbers are 5–7 digits; 8 allowed for headroom. */
const NUMBER = /^\d{5,8}$/;
/** What a customer types as the account: letters, digits, spaces and dashes, up to 20. */
const ACCOUNT = /^[A-Za-z0-9][A-Za-z0-9 -]{0,19}$/;

export const mpesaLabel = (kind: MpesaKind): string => (kind === 'paybill' ? 'Paybill' : 'Buy Goods');

/** A form's values → a clean M-Pesa set-up, or the reason it is not one (in the manager's words). */
export function cleanMpesaReceive(input: { kind?: unknown; number?: unknown; account?: unknown } | null | undefined):
  { ok: true; value: MpesaReceive } | { ok: false; error: string } {
  const kind = input?.kind;
  if (kind !== 'buy_goods' && kind !== 'paybill') return { ok: false, error: 'Choose Buy Goods or Paybill.' };
  const number = String(input?.number ?? '').replace(/\s+/g, '');
  if (!NUMBER.test(number)) {
    return { ok: false, error: kind === 'paybill' ? 'The business number is 5 to 8 digits.' : 'The till number is 5 to 8 digits.' };
  }
  if (kind === 'buy_goods') return { ok: true, value: { kind, number, account: null } };
  const account = String(input?.account ?? '').trim().replace(/\s+/g, ' ');
  if (!account) return { ok: false, error: 'A Paybill needs the account number customers enter.' };
  if (!ACCOUNT.test(account)) return { ok: false, error: 'The account number is up to 20 letters, digits, spaces or dashes.' };
  return { ok: true, value: { kind, number, account } };
}

/** Stored settings → the set-up, or null when none (an A450 line with another label reads as Buy Goods). */
export function mpesaFromSettings(label: unknown, number: unknown, account: unknown): MpesaReceive | null {
  const n = String(number ?? '').trim();
  if (!n) return null;
  const paybill = /pay\s*bill/i.test(String(label ?? ''));
  const a = String(account ?? '').trim();
  return paybill ? { kind: 'paybill', number: n, account: a || null } : { kind: 'buy_goods', number: n, account: null };
}

/** What the receipt prints after the label: the number, and for a Paybill ", Account …". */
export function mpesaReceiptNumber(v: MpesaReceive | null | undefined): string {
  if (!v) return '';
  return v.kind === 'paybill' && v.account ? `${v.number}, Account ${v.account}` : v.number;
}

/** One line for a person ("Paybill 4098201, Account 1234"). */
export function mpesaDescribe(v: MpesaReceive | null | undefined): string {
  return v ? `${mpesaLabel(v.kind)} ${mpesaReceiptNumber(v)}` : 'not set';
}
