/**
 * c2b.ts — A621: M-Pesa payment notifications (Safaricom C2B). The pure rules: no database, no network, so the tests can
 * drive every one directly. lib/c2bStore.ts keeps the payments, lib/c2bDaraja.ts talks to Safaricom.
 *
 * Owner, 2026-11-02: "Some customers do not like giving out their number, they prefer paying to the till or paybill
 * directly; what the cashier gets is a notification of the payments done, then they match it to the bill." The cashier
 * always TAPS the payment that belongs to the bill — never matched by amount alone. Exact-amount payments come first (and,
 * on a Paybill, one whose account number is the bill or table number), so the right one is usually the top of the list.
 */
import crypto from 'crypto';

/** One payment Safaricom told us about, as we keep it. Never the payer's full phone number. */
export interface C2bPayment {
  transId:     string;
  transType:   string | null;
  amount:      number;
  /** When the customer paid (Safaricom's TransTime, Kenyan time) as an ISO instant; null when Safaricom sent none. */
  transTime:   string | null;
  shortcode:   string;
  billRef:     string | null;
  firstName:   string | null;
  phoneMasked: string | null;
}

// ── Safaricom's confirmation ─────────────────────────────────────────────────────────────────────────────────────────

/** M-Pesa transaction codes are 10 capitals and digits today; a little room either side for older or newer codes. */
const TRANS_ID = /^[A-Z0-9]{8,20}$/;
const SHORTCODE = /^\d{5,8}$/;

function text(v: unknown): string {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number') return String(v);
  return '';
}

/** At most `max` characters of plain text, or null — a name or an account number typed by a customer is not trusted. */
function shortText(v: unknown, max: number): string | null {
  const t = text(v).replace(/[\u0000-\u001f<>]/g, '').slice(0, max).trim();
  return t || null;
}

/**
 * Safaricom's TransTime ("20261102143005", Kenyan time, UTC+3, no daylight saving) → an ISO instant. null when it is not
 * a real date — the payment is still kept (the time it reached us stands in).
 */
export function kenyanTime(v: unknown): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(text(v));
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  const utc = Date.UTC(y, mo - 1, d, h - 3, mi, s);
  const check = new Date(utc + 3 * 3_600_000);
  const real = check.getUTCFullYear() === y && check.getUTCMonth() === mo - 1 && check.getUTCDate() === d && h < 24 && mi < 60 && s < 60;
  return real ? new Date(utc).toISOString() : null;
}

/**
 * The payer's number as the cashier may see it. Safaricom now sends it masked ("2547 ***** 149") or hashed, sometimes in
 * full: a full Kenyan number keeps only its first and last three digits ("071****149"); a masked one keeps Safaricom's
 * mask; a hash or anything else is dropped. The full number is never kept.
 */
export function maskPayerPhone(v: unknown): string | null {
  const raw = text(v);
  const compact = raw.replace(/\s+/g, '');
  if (/^254[17]\d{8}$/.test(compact)) return `0${compact.slice(3, 5)}****${compact.slice(-3)}`;
  const safaricomMasked = /^[\d*]{9,20}$/.test(compact) && compact.includes('*');
  if (safaricomMasked) return raw.replace(/\s+/g, ' ');
  return null;
}

/** Safaricom's confirmation body → the payment, or null when it is not one (no code, no amount, no shortcode). */
export function parseConfirmation(body: unknown): C2bPayment | null {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const transId = text(b.TransID).toUpperCase();
  const amount = Number(text(b.TransAmount));
  const shortcode = text(b.BusinessShortCode);
  if (!TRANS_ID.test(transId) || !SHORTCODE.test(shortcode)) return null;
  if (!Number.isFinite(amount) || amount <= 0 || amount > 10_000_000) return null;
  return {
    transId,
    transType: shortText(b.TransactionType, 40),
    amount: Math.round(amount * 100) / 100,
    transTime: kenyanTime(b.TransTime),
    shortcode,
    billRef: shortText(b.BillRefNumber, 40),
    firstName: shortText(b.FirstName, 40)?.toUpperCase() ?? null,
    phoneMasked: maskPayerPhone(b.MSISDN),
  };
}

/** What Safaricom must hear back — at once, whatever we did with the payment (its money has moved already). */
export const ACCEPTED = { ResultCode: 0, ResultDesc: 'Accepted' } as const;

// ── The addresses Safaricom calls ────────────────────────────────────────────────────────────────────────────────────

/** Safaricom refuses a callback address containing any of these, in any case. */
export const FORBIDDEN_URL_WORDS = ['mpesa', 'm-pesa', 'safaricom', 'exe', 'exec', 'cmd', 'sql', 'query'] as const;

export const CONFIRM_PATH = '/api/payments/c2b/confirm';
export const VALIDATE_PATH = '/api/payments/c2b/validate';

export function forbiddenWordIn(url: string): string | null {
  const lower = url.toLowerCase();
  return FORBIDDEN_URL_WORDS.find((w) => lower.includes(w)) ?? null;
}

/**
 * The two addresses for a branch's token, or the reason they cannot be registered. The token is hex, which can never spell
 * a forbidden word; the base address (MPESA_CALLBACK_BASE_URL) could.
 */
export function c2bUrls(base: string, token: string): { ok: true; confirm: string; validate: string } | { ok: false; error: string } {
  let root = base.trim();
  while (root.endsWith('/')) root = root.slice(0, -1);
  if (!/^https:\/\/[^/\s]+/i.test(root)) return { ok: false, error: 'The server\'s public address must start with https:// — Safaricom calls only secure addresses.' };
  const confirm = `${root}${CONFIRM_PATH}/${token}`;
  const validate = `${root}${VALIDATE_PATH}/${token}`;
  const word = forbiddenWordIn(confirm);
  if (word) return { ok: false, error: `Safaricom refuses an address containing "${word}". The server's public address must change first.` };
  return { ok: true, confirm, validate };
}

/** A new branch token: 24 random bytes as hex (48 characters — no letter past f, so never a forbidden word). */
export function newC2bToken(): string {
  return crypto.randomBytes(24).toString('hex');
}

/** What we keep of a token: its SHA-256. Safaricom's calls carry the token; a stolen database row cannot forge one. */
export function hashC2bToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function looksLikeToken(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-f]{48}$/.test(v);
}

// ── The cashier's list ───────────────────────────────────────────────────────────────────────────────────────────────

/** How far back the POS's list reaches: a payment older than this is the day list's (the dashboard), not the counter's. */
export const RECENT_MINUTES = 30;

/** A payment as the POS shows it. */
export interface PosPayment {
  trans_id:    string;
  amount:      number;
  first_name:  string | null;
  bill_ref:    string | null;
  paid_at:     string;
}

const sameRef = (a: string | null, b: string | null): boolean =>
  !!a && !!b && a.replace(/\s+/g, '').toUpperCase() === b.replace(/\s+/g, '').toUpperCase();

/** How well a payment fits this bill: 3 the exact amount and the bill's number, 2 the exact amount, 1 the number, 0 neither. */
export function fitScore(p: Pick<PosPayment, 'amount' | 'bill_ref'>, amount: number | null, billRef: string | null): number {
  const exact = amount !== null && Math.abs(p.amount - amount) < 0.005;
  const named = sameRef(p.bill_ref, billRef);
  if (exact && named) return 3;
  if (exact) return 2;
  return named ? 1 : 0;
}

/** The list in the order the cashier reads it: the best fit first, then the newest. Never filtered — the cashier taps. */
export function sortForBill<T extends PosPayment>(list: T[], amount: number | null, billRef: string | null): T[] {
  return [...list].sort((a, b) => fitScore(b, amount, billRef) - fitScore(a, amount, billRef) || b.paid_at.localeCompare(a.paid_at));
}

/** "?amount=1080" → 1080, or null when absent or not a positive amount. */
export function amountParam(v: unknown): number | null {
  const n = Number(text(v));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

// ── Claiming a payment ───────────────────────────────────────────────────────────────────────────────────────────────

/** The stored row, as far as a claim needs it. */
export interface ClaimRow { status: string; held_by: string | null; held_ref: string | null }

export type ClaimRefusal = { status: 404 | 409; code: string; error: string };

/**
 * Why a claim that did not take the payment was refused — or null when the row is already this POS's (a retried tap, or
 * the same POS after a restart: it may take it again for this sale).
 */
export function claimRefusal(row: ClaimRow | null, holder: string): ClaimRefusal | null {
  if (!row) return { status: 404, code: 'NOT_FOUND', error: 'That payment is not in this branch\'s list.' };
  if (row.status === 'used') return { status: 409, code: 'USED', error: 'That payment is already on another sale.' };
  if (row.status === 'held' && row.held_by !== holder) return { status: 409, code: 'TAKEN', error: 'Another POS has just taken that payment for its bill.' };
  return null;
}

/** Who holds a payment: this POS (its device) or, on the web, the person signed in. */
export function holderOf(req: { deviceId?: string | null; userId?: string | null }): string | null {
  if (req.deviceId) return `device:${req.deviceId}`;
  if (req.userId) return `user:${req.userId}`;
  return null;
}

/** The sale's own reference for a claim ("PAY-…" — letters, digits and dashes), or null. */
export function saleRefParam(v: unknown): string | null {
  const t = text(v);
  return /^[A-Za-z0-9-]{1,40}$/.test(t) ? t : null;
}

/** An M-Pesa code from a request or an order's payment leg (capitals), or null. */
export function transIdParam(v: unknown): string | null {
  const t = text(v).toUpperCase();
  return TRANS_ID.test(t) ? t : null;
}

/** The M-Pesa codes an order's payment legs carry (its M-Pesa legs' references) — the payments the order used. */
export function mpesaCodesOf(legs: Array<{ method?: unknown; reference?: unknown }> | null | undefined): string[] {
  const codes = new Set<string>();
  for (const leg of legs ?? []) {
    if (leg?.method !== 'mpesa') continue;
    const code = transIdParam(leg.reference);
    if (code) codes.add(code);
  }
  return [...codes];
}

// ── The owner's unmatched list ───────────────────────────────────────────────────────────────────────────────────────

export const MAX_LIST_DAYS = 31;

/** "?from=…&to=…" (YYYY-MM-DD) → the days, `today` for one left out; null when backwards or longer than 31 days. */
export function dayRange(fromRaw: unknown, toRaw: unknown, today: string): { from: string; to: string } | null {
  const day = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(`${v}T00:00:00Z`)) ? v : null);
  const to = day(toRaw) ?? today;
  const from = day(fromRaw) ?? to;
  const span = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
  return span >= 0 && span < MAX_LIST_DAYS ? { from, to } : null;
}

// ── Settings ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The store number typed on the settings screen: 5 to 8 digits, blank = the STK details' shortcode. */
export function cleanStoreNumber(v: unknown): { ok: true; value: string | null } | { ok: false; error: string } {
  const t = text(v).replace(/\s+/g, '');
  if (!t) return { ok: true, value: null };
  return SHORTCODE.test(t) ? { ok: true, value: t } : { ok: false, error: 'The store number is 5 to 8 digits (or leave it blank).' };
}

/**
 * The number Safaricom registers the addresses for. Paybill: the Paybill number. Buy Goods: the STORE number (head office
 * shortcode) — not the Till number on the receipt; the owner's own entry wins, else the STK details' shortcode, which is
 * the store number for Buy Goods already.
 */
export function registerShortcode(cfg: { type: string; shortcode: string }, storeNumber: string | null): string {
  if (cfg.type === 'CustomerBuyGoodsOnline' && storeNumber) return storeNumber;
  return cfg.shortcode;
}
