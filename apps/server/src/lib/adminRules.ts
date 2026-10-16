/**
 * adminRules.ts — A495: the admin portal's input rules and its export filter, in one place so the routes and the tests
 * read the same lists.
 */

/** The business types a client may be (routes/admin.ts VALID_TYPES and routes/onboarding.ts agree with this). */
export const BUSINESS_TYPES = ['restaurant', 'cafe', 'retail', 'minimart', 'parking', 'petrol_station', 'other'] as const;

/** What an invoice's status may be set to. */
export const INVOICE_STATUSES = ['pending', 'paid', 'failed', 'refunded'] as const;   // invoices_status_check (baseline)

/** Where a branch may be switched to. */
export const MODE_SWITCH_TARGETS = ['local', 'cloud'] as const;

/**
 * The problem with a client's tax / money fields, or null. Only the fields present are checked.
 *   vat_rate — a number from 0 to 100 · currency — three letters (ISO 4217) · type — one of BUSINESS_TYPES
 */
export function adminInputProblems(v: { vat_rate?: unknown; currency?: unknown; type?: unknown }): string | null {
  if (v.vat_rate !== undefined) {
    const n = typeof v.vat_rate === 'number' ? v.vat_rate : typeof v.vat_rate === 'string' && v.vat_rate.trim() !== '' ? Number(v.vat_rate) : NaN;
    if (!Number.isFinite(n) || n < 0 || n > 100) return 'VAT rate must be a number from 0 to 100.';
  }
  if (v.currency !== undefined && !(typeof v.currency === 'string' && /^[A-Za-z]{3}$/.test(v.currency.trim()))) {
    return 'Currency must be a three-letter code, e.g. KES.';
  }
  if (v.type !== undefined && !(typeof v.type === 'string' && (BUSINESS_TYPES as readonly string[]).includes(v.type))) {
    return `Type must be one of: ${BUSINESS_TYPES.join(', ')}.`;
  }
  return null;
}

/** Column names that are never exported: password / PIN / OTP material, tokens, keys, reveal codes. */
const SECRET_COLUMN = /(hash|secret|password|passkey|token|api_key|private_key|otp_|^pin$|reveal_code|encrypted)/i;

/** A495: a copy of the row without its secret columns (pre-purge export). */
export function stripSecretColumns<T extends Record<string, unknown>>(row: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row ?? {})) if (!SECRET_COLUMN.test(k)) out[k] = v;
  return out as Partial<T>;
}

/** A whole number of years from 1 to 5, or null. */
export function renewYears(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : null;
}
