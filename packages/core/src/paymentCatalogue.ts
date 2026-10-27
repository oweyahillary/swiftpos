/**
 * paymentCatalogue.ts — A429 (owner, 2026-10-09: "the payment methods now we have them hard coded … list common payment
 * methods and they are selected by the manager's branch"; 2026-10-10: "add them but as toggles — by default the current
 * payment methods are on but the manager can turn them on or off; add the others but the manager has to turn them on;
 * per branch is also valid and I like it").
 *
 * Kenya's common ways to pay and the delivery apps, each a switch per branch. On until switched off: what the tills and
 * the web POS took before (Cash, M-Pesa, Card, Glovo, On account). Off until switched on: the rest. Codes never change —
 * `cash` is the drawer count, `mpesa` the STK prompt and C2B matching; the cloud takes any ^[a-z0-9_]{1,40}$ code
 * (migration 89). A business's own methods (A96, payment_methods) still come after these.
 *
 * The setting (business default, branch override — the A387 pattern), key `payment_methods_enabled`: a JSON list of the
 * codes switched on. Absent (or unreadable) = the defaults.
 *
 * ONE file: shared/paymentCatalogue.ts, copied to the till, the web and the cloud (scripts/check-shared-sync.mjs).
 */

export type MethodKind = 'cash' | 'mobile' | 'card' | 'bank' | 'account' | 'voucher' | 'room' | 'delivery';

export interface CatalogueMethod {
  code: string;
  name: string;
  icon: string;
  kind: MethodKind;
  /** On for a branch that has not chosen (what the tills and the web POS took before A429). */
  defaultOn: boolean;
  /** What the reference box asks for (null: no reference). */
  reference: string | null;
  /** A method only the web POS takes (none now). A552: the till takes On account too — offered there only when this till
   *  holds a customer with a credit account (main/creditSale.ts), so the till's payment screen decides that itself. */
  webOnly?: boolean;
}

export const PAYMENT_CATALOGUE: CatalogueMethod[] = [
  { code: 'cash',          name: 'Cash',                    icon: '💵', kind: 'cash',     defaultOn: true,  reference: null },
  { code: 'mpesa',         name: 'M-Pesa',                  icon: '📱', kind: 'mobile',   defaultOn: true,  reference: 'QHX4K2L9MP' },
  { code: 'card',          name: 'Card',                    icon: '💳', kind: 'card',     defaultOn: true,  reference: 'Txn ID' },
  { code: 'glovo',         name: 'Glovo',                   icon: '🛵', kind: 'delivery', defaultOn: true,  reference: 'Glovo order #' },
  { code: 'credit',        name: 'On account',              icon: '📒', kind: 'account',  defaultOn: true,  reference: null },
  { code: 'airtel_money',  name: 'Airtel Money',            icon: '📲', kind: 'mobile',   defaultOn: false, reference: 'Transaction ID' },
  { code: 'tkash',         name: 'T-Kash',                  icon: '📲', kind: 'mobile',   defaultOn: false, reference: 'Transaction ID' },
  { code: 'bank_transfer', name: 'Bank transfer / Pesalink', icon: '🏦', kind: 'bank',     defaultOn: false, reference: 'Bank reference' },
  { code: 'cheque',        name: 'Cheque',                  icon: '🧾', kind: 'bank',     defaultOn: false, reference: 'Cheque no.' },
  { code: 'voucher',       name: 'Voucher / gift card',     icon: '🎟️', kind: 'voucher',  defaultOn: false, reference: 'Voucher code' },
  { code: 'room_charge',   name: 'Room charge',             icon: '🛏️', kind: 'room',     defaultOn: false, reference: 'Room no.' },
  { code: 'uber_eats',     name: 'Uber Eats',               icon: '🛵', kind: 'delivery', defaultOn: false, reference: 'Uber Eats order #' },
  { code: 'bolt_food',     name: 'Bolt Food',               icon: '🛵', kind: 'delivery', defaultOn: false, reference: 'Bolt order #' },
  { code: 'yum',           name: 'Yum',                     icon: '🛵', kind: 'delivery', defaultOn: false, reference: 'Yum order #' },
];

export const PAYMENT_METHODS_ENABLED_KEY = 'payment_methods_enabled';

const BY_CODE = new Map(PAYMENT_CATALOGUE.map((m) => [m.code, m]));

export function catalogueMethod(code: string | null | undefined): CatalogueMethod | null {
  return BY_CODE.get(String(code ?? '').trim().toLowerCase()) ?? null;
}

export const DEFAULT_ENABLED: string[] = PAYMENT_CATALOGUE.filter((m) => m.defaultOn).map((m) => m.code);

/**
 * The codes switched on, from the setting as stored (a JSON list, an array, or nothing). Unknown codes are dropped;
 * nothing usable (absent, unreadable, not a list) = the defaults. An empty list is allowed — every method off — and
 * the screens then still offer the business's own methods.
 */
export function enabledFromSetting(raw: unknown): string[] {
  let v: unknown = raw;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return [...DEFAULT_ENABLED]; } }
  if (!Array.isArray(v)) return [...DEFAULT_ENABLED];
  const want = new Set(v.map((c) => String(c).trim().toLowerCase()));
  return PAYMENT_CATALOGUE.filter((m) => want.has(m.code)).map((m) => m.code);
}

/** The value to store, or null when it is not a list of catalogue codes (the cloud refuses it). In catalogue order. */
export function enabledSettingValue(raw: unknown): string | null {
  let v: unknown = raw;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return null; } }
  if (!Array.isArray(v) || v.some((c) => typeof c !== 'string' || !BY_CODE.has(c))) return null;
  return JSON.stringify(PAYMENT_CATALOGUE.filter((m) => v.includes(m.code)).map((m) => m.code));
}

/**
 * The buttons a payment screen shows: the catalogue's switched-on methods (in catalogue order; without the web-only ones
 * on the till), then the business's own methods whose codes are not already there.
 */
export function paymentButtons(enabled: string[], own: Array<{ code: string; name: string }>, where: 'till' | 'web'):
  Array<{ code: string; name: string; icon: string; reference: string | null }> {
  const on = new Set(enabled);
  const out = PAYMENT_CATALOGUE.filter((m) => on.has(m.code) && !(where === 'till' && m.webOnly))
    .map((m) => ({ code: m.code, name: m.name, icon: m.icon, reference: m.reference }));
  const seen = new Set(out.map((m) => m.code));
  for (const o of own) {
    const code = String(o.code ?? '').trim().toLowerCase();
    if (!code || seen.has(code) || BY_CODE.has(code)) continue;
    seen.add(code);
    out.push({ code, name: o.name || code, icon: '🏦', reference: 'Reference' });
  }
  return out;
}

/** A method's name for a report or a list — the catalogue's, else the code tidied ("other_bank" → "Other bank"). */
export function methodLabel(code: string | null | undefined): string {
  const m = catalogueMethod(code);
  if (m) return m.name;
  const c = String(code ?? '').trim();
  return c ? c.replace(/_/g, ' ').replace(/^./, (x) => x.toUpperCase()) : '—';
}
