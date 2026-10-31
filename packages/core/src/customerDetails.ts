/**
 * customerDetails.ts — A607: the customer's details at the counter, typed by the cashier or by the customer, on the main
 * screen or on the customer screen (A606's second screen).
 *
 * Owner, 2026-10-28: "a feature where clients details can be captured by the cashier both on the main screen and the second
 * screen also, and if mpesa integration is available the client can key in their mpesa, if KRA is integrated they can key
 * in KRA pin etc" — "should work for both main and second screen".
 *
 *   - The phone (Kenyan 07XX / 01XX / 2547XX / +2547XX → 2547XXXXXXXX, as the cloud's STK push expects), the name, and the
 *     KRA PIN when eTIMS is on for the business (a letter A or P, 9 digits, a letter: A123456789Z — upper case).
 *   - What the customer types on a customer-facing form comes back to the cashier, who accepts or corrects it BEFORE it is
 *     attached to the sale. Only the customer's own typed fields come back (cleanAnswer reads exactly id, name, phone,
 *     kraPin, save); the request that goes TO the customer's screen carries no customer, staff or sale detail (sanitiseAsk).
 *   - Consent (Kenya Data Protection Act 2019): one plain line on the form, and "Save my details for next time" decides
 *     whether a customer record is made. Without it the details serve this sale only: the PIN goes on the invoice
 *     (orders.buyer_kra_pin → KRA), the name on the receipt, and the phone only to the M-Pesa prompt (consentPlan).
 *   - The M-Pesa prompt's progress, as the customer may see it (sanitiseStk / stkWords): never the phone number.
 *   - Who gets what: the cashier's capture, "Customer types it" on the main screen and the PIN to eTIMS are STANDARD; the
 *     customer typing on the SECOND screen is PREMIUM (the online licence, as A606's premium parts) and needs the per-PC
 *     "The customer screen is a touch screen" (secondScreenAsk); the M-Pesa prompt needs the business's own M-Pesa
 *     integration and a connection (stkOffered).
 *
 * Pure, no imports. Copies kept identical by scripts/check-shared-sync.mjs: shared/, apps/server/src/lib/,
 * apps/desktop/src/main/, apps/desktop/src/shared/, apps/dashboard/src/lib/.
 */

// ── The words on every customer-facing form ─────────────────────────────────────────────────────────────────────────

export const CONSENT_LINE = 'Your details are used for this receipt and, if you agree, to recognise you next time.';
export const SAVE_LABEL = 'Save my details for next time';

// ── KRA PIN ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A KRA PIN: A (a person) or P (a company), 9 digits, a letter — A123456789Z. The SQL CHECK (migration 181) is the same. */
export const KRA_PIN_RE = /^[AP][0-9]{9}[A-Z]$/;

/** What was typed → upper case, no spaces or dashes ("a123 456 789-z" → "A123456789Z"). */
export function normaliseKraPin(v: unknown): string {
  return String(v ?? '').replace(/[\s-]+/g, '').toUpperCase().slice(0, 20);
}
export function kraPinOk(v: unknown): boolean { return KRA_PIN_RE.test(normaliseKraPin(v)); }
/** Blank → null (no PIN is fine); otherwise why it is not a PIN, or null. */
export function kraPinError(v: unknown): string | null {
  const p = normaliseKraPin(v);
  if (!p) return null;
  return KRA_PIN_RE.test(p) ? null : 'A KRA PIN is A or P, 9 digits and a letter — for example A123456789Z.';
}

// ── Phone ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A Kenyan mobile number → 2547XXXXXXXX / 2541XXXXXXXX (what the cloud's STK push sends Safaricom), or null.
 * 0712 345 678, 0112 345 678, 712345678, 254712345678, +254 712 345 678 all → 254712345678.
 */
export function normaliseKenyanPhone(v: unknown): string | null {
  const raw = String(v ?? '').trim();
  if (!raw || raw.length > 24 || /[^\d\s+()-]/.test(raw)) return null;
  if (raw.indexOf('+') > 0) return null;
  const d = raw.replace(/\D/g, '');
  if (raw.startsWith('+') && !d.startsWith('254')) return null;   // "+" only before the country code
  let nine: string;
  if (/^0[17]\d{8}$/.test(d)) nine = d.slice(1);
  else if (/^254[17]\d{8}$/.test(d)) nine = d.slice(3);
  else if (/^[17]\d{8}$/.test(d) && !raw.startsWith('+')) nine = d;
  else return null;
  return `254${nine}`;
}
export function phoneError(v: unknown, required: boolean): string | null {
  const s = String(v ?? '').trim();
  if (!s) return required ? 'Enter the M-Pesa phone number.' : null;
  return normaliseKenyanPhone(s) ? null : 'Enter a Kenyan mobile number — 07XX XXX XXX or 01XX XXX XXX.';
}
/** 254712345678 → "0712 345 678" (how a Kenyan reads it back). */
export function localPhone(p254: string | null | undefined): string {
  const p = String(p254 ?? '');
  return /^254\d{9}$/.test(p) ? `0${p.slice(3, 6)} ${p.slice(6, 9)} ${p.slice(9)}` : p;
}
/** As lib/personalData.ts masks it for someone without customers.contacts: "07•• ••• 678". */
export function maskTypedPhone(p254: string | null | undefined): string {
  const l = localPhone(p254).replace(/\D/g, '');
  return l.length >= 6 ? `${l.slice(0, 2)}•• ••• ${l.slice(-3)}` : '•••';
}

// ── Name ────────────────────────────────────────────────────────────────────────────────────────────────────────────

export const MAX_NAME = 60;
/** Letters, spaces and the marks names use; controls removed; trimmed; at most MAX_NAME. */
export function cleanName(v: unknown): string {
  return String(v ?? '').replace(/[\u0000-\u001f\u007f<>{}[\]\\|`^~$#@*=+_;:"]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
}

// ── The request TO the customer's screen, the answer FROM it ─────────────────────────────────────────────────────────

export type AskPurpose = 'details' | 'mpesa';
export interface AskRequest {
  /** Matches the answer to the request (a fresh one each time the cashier asks). */
  id: string;
  /** 'details': name, phone and (eTIMS on) the KRA PIN, and the save choice. 'mpesa': the M-Pesa number only. */
  purpose: AskPurpose;
  /** Ask for the KRA PIN (eTIMS is on for the business). */
  needPin: boolean;
  /** The bill total (the one sale figure the customer sees on the form). */
  amount: number;
  currency: string;
}

const money = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round((n + Number.EPSILON) * 100) / 100 : 0;
};

/** Anything the cashier's side hands over → exactly the request the customer's screen may see (a whitelist), or null. */
export function sanitiseAsk(raw: unknown): AskRequest | null {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const id = typeof r.id === 'string' && /^[A-Za-z0-9-]{4,40}$/.test(r.id) ? r.id : null;
  const purpose: AskPurpose | null = r.purpose === 'details' || r.purpose === 'mpesa' ? r.purpose : null;
  if (!id || !purpose) return null;
  const currency = typeof r.currency === 'string' && /^[A-Z]{3}$/.test(r.currency) ? r.currency : 'KES';
  return { id, purpose, needPin: purpose === 'details' && r.needPin === true, amount: money(r.amount), currency };
}

export interface CustomerAnswer {
  id: string;
  name: string | null;
  /** 2547XXXXXXXX, or null. */
  phone: string | null;
  /** Upper case, or null (always null when the request did not ask for it). */
  kraPin: string | null;
  /** "Save my details for next time". */
  save: boolean;
}

/**
 * What came back from a customer-facing form → the answer, or what is wrong with it (in the customer's words, by field).
 * ONLY id, name, phone, kraPin and save are read — anything else the form (or something pretending to be it) sends is
 * dropped. The answer must be to the request that is open (the same id).
 */
export function cleanAnswer(raw: unknown, ask: AskRequest | null):
  { ok: true; value: CustomerAnswer } | { ok: false; errors: Record<string, string> } {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  if (!ask || r.id !== ask.id) return { ok: false, errors: { form: 'This form is no longer open.' } };
  const errors: Record<string, string> = {};
  const phoneRaw = typeof r.phone === 'string' ? r.phone : '';
  const phone = normaliseKenyanPhone(phoneRaw);
  const pErr = phoneError(phoneRaw, ask.purpose === 'mpesa');
  if (pErr) errors.phone = pErr;
  if (ask.purpose === 'mpesa') {
    return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value: { id: ask.id, name: null, phone, kraPin: null, save: false } };
  }
  const name = cleanName(typeof r.name === 'string' ? r.name : '') || null;
  const pinRaw = ask.needPin && typeof r.kraPin === 'string' ? r.kraPin : '';
  const kErr = kraPinError(pinRaw);
  if (kErr) errors.kraPin = kErr;
  const kraPin = !kErr && pinRaw ? normaliseKraPin(pinRaw) : null;
  const save = r.save === true;
  if (save && (!name || !phone)) errors.save = 'To save your details, enter your name and phone number.';
  if (!name && !phone && !kraPin && !Object.keys(errors).length) errors.form = 'Enter your details, or press Skip.';
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value: { id: ask.id, name, phone, kraPin, save } };
}

/** A fresh request id (not a secret — it only pairs an answer with its request). */
export function newAskId(rand: () => number = Math.random): string {
  let s = '';
  for (let i = 0; i < 12; i++) s += 'abcdefghjkmnpqrstuvwxyz23456789'[Math.floor(rand() * 31) % 31];
  return `ask-${s}`;
}

// ── Consent: what the details are used for ──────────────────────────────────────────────────────────────────────────

export interface SaleDetails {
  /** On the receipt ("Customer: Mary"). */
  customer_name?: string;
  /** Only with "save" — the customer's record keeps it; without it the phone goes to the M-Pesa prompt only. */
  customer_phone?: string;
  /** On the invoice and to KRA (eTIMS on). */
  buyer_kra_pin?: string;
}
export interface ConsentPlan {
  /** Make (or update) the customer's record — only when they ticked "Save my details for next time". */
  saveCustomer: { name: string; phone: string; kra_pin?: string } | null;
  /** What the sale carries. */
  sale: SaleDetails;
  /** The number the M-Pesa prompt goes to, or null. */
  stkPhone: string | null;
}

export function consentPlan(a: Pick<CustomerAnswer, 'name' | 'phone' | 'kraPin' | 'save'>, etimsOn: boolean): ConsentPlan {
  const name = cleanName(a.name ?? '') || null;
  const phone = normaliseKenyanPhone(a.phone ?? '');
  const pin = etimsOn && a.kraPin && kraPinOk(a.kraPin) ? normaliseKraPin(a.kraPin) : null;
  const sale: SaleDetails = {};
  if (name) sale.customer_name = name;
  if (pin) sale.buyer_kra_pin = pin;
  const saving = a.save === true && !!name && !!phone;
  if (saving) sale.customer_phone = phone as string;
  return {
    saveCustomer: saving ? { name: name as string, phone: phone as string, ...(pin ? { kra_pin: pin } : {}) } : null,
    sale,
    stkPhone: phone,
  };
}

/** The sale's buyer PIN as an order may carry it: a valid PIN (upper case), null for none, or 'bad'. */
export function saleBuyerPin(v: unknown): string | null | 'bad' {
  if (v === undefined || v === null || v === '') return null;
  const p = normaliseKraPin(v);
  if (!p) return null;
  return KRA_PIN_RE.test(p) ? p : 'bad';
}

// ── The M-Pesa prompt, as both screens show it ──────────────────────────────────────────────────────────────────────

export type StkStage = 'idle' | 'sending' | 'waiting' | 'paid' | 'failed';
const STK_STAGES: readonly StkStage[] = ['idle', 'sending', 'waiting', 'paid', 'failed'];
export interface StkView {
  stage: StkStage;
  amount: number;
  currency: string;
  /** Why it did not complete, in plain words (never a phone number). */
  reason: string | null;
}

const text = (v: unknown, max: number): string => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/** What the customer's screen may show of the prompt: the stage, the amount, a short reason — digits runs of 6+ removed. */
export function sanitiseStk(raw: unknown): StkView {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const stage: StkStage = STK_STAGES.includes(r.stage as StkStage) ? (r.stage as StkStage) : 'idle';
  const currency = typeof r.currency === 'string' && /^[A-Z]{3}$/.test(r.currency) ? r.currency : 'KES';
  const reason = stage === 'failed' ? (text(r.reason, 120).replace(/\+?\d[\d\s]{5,}\d/g, '…') || null) : null;
  return { stage, amount: stage === 'idle' ? 0 : money(r.amount), currency, reason };
}

export function stkWords(stage: StkStage): { title: string; sub: string } {
  if (stage === 'sending') return { title: 'Sending the M-Pesa prompt…', sub: 'One moment.' };
  if (stage === 'waiting') return { title: 'Waiting for M-Pesa… (check your phone)', sub: 'Enter your M-Pesa PIN on your phone to pay.' };
  if (stage === 'paid') return { title: 'Paid ✓', sub: 'Thank you — your M-Pesa payment is received.' };
  if (stage === 'failed') return { title: 'Not completed — try again / pay by M-Pesa Till number', sub: 'The M-Pesa prompt was not completed.' };
  return { title: '', sub: '' };
}

/** The cloud's /api/mpesa/status answer → the stage ('completed' → paid; 'failed' / 'cancelled' / 'not_found' → failed). */
export function stkStageFromStatus(status: unknown): StkStage {
  const s = String(status ?? '').toLowerCase();
  if (s === 'completed') return 'paid';
  if (s === 'failed' || s === 'cancelled' || s === 'not_found') return 'failed';
  return 'waiting';
}

/** Daraja takes whole shillings, 1 to 250,000 per prompt; the amount is rounded UP (the cloud does the same). */
export const STK_MAX_AMOUNT = 250_000;
export function stkAmount(v: unknown): number | null {
  const n = Math.ceil(Number(v) - 1e-9);
  return Number.isFinite(n) && n >= 1 && n <= STK_MAX_AMOUNT ? n : null;
}

// ── Who gets what ───────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * PREMIUM: the customer types on the SECOND screen only with the online licence (web_pos_enabled), the per-PC "The customer
 * screen is a touch screen" and the customer screen showing. Otherwise the cashier types, or uses "Customer types it" on
 * the main screen (standard).
 */
export function secondScreenAsk(i: { touch: boolean; licensed: boolean; open: boolean }): { allowed: boolean; why: string | null } {
  if (!i.licensed) return { allowed: false, why: 'The customer typing on the customer screen is part of the online licence.' };
  if (!i.touch) return { allowed: false, why: 'Turn on "The customer screen is a touch screen" in the Customer screen setup.' };
  if (!i.open) return { allowed: false, why: 'The customer screen is not showing.' };
  return { allowed: true, why: null };
}

/** The M-Pesa prompt is offered only when the business's M-Pesa integration is set up and the POS is online. */
export function stkOffered(i: { configured: boolean; online: boolean }): boolean {
  return i.configured === true && i.online === true;
}
