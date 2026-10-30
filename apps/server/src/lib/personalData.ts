/**
 * personalData.ts — A595: customers' and staff's phone numbers and e-mails are shown only to someone who may see them.
 *
 * Owner, 2026-10-26: "break down any right that you feel is too big and exposes data". The audit (docs/PERMISSIONS-AUDIT.md
 * F1, F2, F4, F5): `customers.view` showed every customer's phone and e-mail to every cashier, and the numbers also
 * travelled with sales (an order's customer_phone, the M-Pesa payer's number). Kenya Data Protection Act 2019: data limited
 * to what the purpose needs, protection by design and by default.
 *
 *   customers.contacts  full customer phone numbers and e-mails (a part of customers.view — migration 176 gave it to
 *                       every holder of customers.view, so nobody sees less on the day; the owner then unticks it)
 *   staff.contacts      staff phone numbers and e-mails on the staff list (a part of staff.view and of staff.edit)
 *
 * Without the key a phone number is MASKED, never removed — 07•• ••• 678: the last three digits tell two Marys apart at
 * the counter — and an e-mail is masked the same way (m•••@gmail.com). Rule 4 of A490 holds: what a person may not see is
 * not sent. A masked value sent back (a form saved with what it was shown) is never written over the real one
 * (isMasked): an order keeps the customer's real number, a customer edit leaves the number alone.
 *
 * Pure apart from `can` (middleware/rbac.ts): the tests run these exact functions.
 */
import type { Request, Response, NextFunction } from 'express';
import { can } from '../middleware/rbac';

/** The character a masked value is made of. Never typed by anyone: a value carrying it was masked here. */
export const MASK = '•';

/** Was this value masked by this file (and so must never be stored)? */
export function isMasked(v: unknown): boolean {
  return typeof v === 'string' && v.includes(MASK);
}

/** '0712345678' → '07•• ••• 678'; '+254712345678' → '+25•• ••• 678'. A short or empty value → '•••' / as it was. */
export function maskPhone(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return s;
  if (isMasked(s)) return s;
  const digits = s.replace(/\D/g, '');
  if (digits.length < 6) return `${MASK}${MASK}${MASK}`;
  return `${s.startsWith('+') ? '+' : ''}${digits.slice(0, 2)}${MASK}${MASK} ${MASK}${MASK}${MASK} ${digits.slice(-3)}`;
}

/** 'mary.k@gmail.com' → 'm•••@gmail.com'. Not an e-mail → masked whole. */
export function maskEmail(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return s;
  if (isMasked(s)) return s;
  const at = s.indexOf('@');
  if (at < 1) return `${MASK}${MASK}${MASK}`;
  return `${s[0]}${MASK}${MASK}${MASK}${s.slice(at)}`;
}

/**
 * A595 (owner, 2026-10-27, decision D1): a customer's KRA PIN — a letter, 9 digits, a letter (A123456789Z); stored upper
 * case; blank means none. Personal and tax data: shown in full only to holders of customers.contacts (masked A•••Z).
 */
export const KRA_PIN_RE = /^[A-Z][0-9]{9}[A-Z]$/;
export function cleanKraPin(v: unknown): { ok: true; value: string | null } | { ok: false; error: string } {
  if (v === undefined || v === null) return { ok: true, value: null };
  const s = String(v).replace(/\s+/g, '').toUpperCase();
  if (!s) return { ok: true, value: null };
  return KRA_PIN_RE.test(s) ? { ok: true, value: s }
    : { ok: false, error: 'A KRA PIN is a letter, 9 digits and a letter - for example A123456789Z.' };
}
export function maskKraPin(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v);
  if (!s || isMasked(s)) return s;
  return s.length < 3 ? `${MASK}${MASK}${MASK}` : `${s[0]}${MASK}${MASK}${MASK}${s[s.length - 1]}`;
}

/** The fields that carry a customer's phone number or e-mail, wherever they appear in an answer. */
export const PHONE_FIELDS: readonly string[] = ['phone', 'customer_phone', 'mpesa_phone', 'payer_phone', 'msisdn', 'phone_number'];
export const EMAIL_FIELDS: readonly string[] = ['email', 'customer_email'];

/**
 * A copy of `body` with every phone / e-mail field masked, at any depth (lists, nested orders and payments). Bounded:
 * at most 8 levels deep (an answer is never deeper; a cycle is never followed). `keepPhone` — the one number the asker
 * typed themselves (GET /loyalty/customer?phone=): left as it is.
 */
export function maskContacts<T>(body: T, opts: { keepPhone?: string | null } = {}): T {
  const keep = opts.keepPhone ? String(opts.keepPhone).trim() : null;
  const walk = (v: unknown, depth: number): unknown => {
    if (depth > 8 || v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    if (v instanceof Date) return v;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (PHONE_FIELDS.includes(k) && (typeof x === 'string' || typeof x === 'number')) {
        out[k] = keep && String(x).trim() === keep ? x : maskPhone(x);
      } else if (EMAIL_FIELDS.includes(k) && typeof x === 'string') {
        out[k] = maskEmail(x);
      } else if (k === 'kra_pin' && typeof x === 'string') {
        out[k] = maskKraPin(x);   // A595 D1
      } else {
        out[k] = walk(x, depth + 1);
      }
    }
    return out;
  };
  return walk(body, 0) as T;
}

/** A595: may this caller see customers' full phone numbers and e-mails? */
export function seesCustomerContacts(req: Request): boolean {
  // The POS's own session is no person: never the full numbers (and never a till-scope check to log).
  if (req.isTill) return false;
  return can(req, 'customers.contacts');
}

/** A595: may this caller see staff phone numbers and e-mails? */
export function seesStaffContacts(req: Request): boolean {
  if (req.isTill) return false;
  return can(req, 'staff.contacts');
}

/**
 * Express middleware: every JSON answer of the routes after it has customers' phones and e-mails masked unless the caller
 * holds customers.contacts. Mounted on a whole router (credit, analytics, M-Pesa reads) or on one route.
 */
export function maskCustomerContacts() {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (seesCustomerContacts(req)) { next(); return; }
    const json = res.json.bind(res);
    res.json = ((body: unknown) => json(maskContacts(body))) as Response['json'];
    next();
  };
}

/**
 * A595: the search of the customer list as a PostgREST or() filter, built safely. The audit (docs/PERMISSIONS-AUDIT.md,
 * appendix) found the raw search text pasted into `name.ilike.%…%,phone.ilike.%…%`: a comma or a bracket in the search
 * added filter terms of the caller's choosing. Each value is now one double-quoted PostgREST literal (a quote or a
 * backslash escaped), and LIKE's own wildcards (% _ \) in the search are literal characters.
 * Without customers.contacts a phone matches only when the WHOLE number is typed (digits compared, spaces aside) — a
 * partial number would let someone read the masked numbers back digit by digit. Returns null for an empty search.
 */
export function customerSearchFilter(search: string, seesContacts: boolean): string | null {
  const s = String(search ?? '').trim().slice(0, 100);
  if (!s) return null;
  const likeLiteral = (v: string) => v.replace(/[\\%_]/g, (c) => '\\' + c);
  const quoted = (v: string) => `"${v.replace(/["\\]/g, (c) => '\\' + c)}"`;
  const name = `name.ilike.${quoted(`%${likeLiteral(s)}%`)}`;
  const digits = s.replace(/[\s-]/g, '');
  if (seesContacts) return `${name},phone.ilike.${quoted(`%${likeLiteral(s)}%`)}`;
  if (/^\+?\d{9,15}$/.test(digits)) return `${name},phone.eq.${quoted(digits)}`;
  return name;
}
