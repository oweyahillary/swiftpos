/**
 * ownerSettings.ts — A491 (follows A490, docs/PERMISSIONS-A490.md "Moved from the admin portal to the owner").
 *
 * The owner now sets these in their own dashboard; the cloud refuses the admin portal's write (403, code OWNER_SETS).
 * The portal still SHOWS each one (support needs to see what a client has), read-only, and says where the owner sets it.
 * Stays admin-only (switched here): themes, web hosting / web access, branch licences, licence and plan, billing,
 * clear test data.
 *
 * Pure, so the test reads it.
 */

/** Settings › Business › POS options — the owner switches them. */
/** A563: + 'When an item's stock reaches zero' (two switches, one owner choice). */
/** A594: + 'approval_pin' (A562's separate approval PIN — the owner's alone now). */
export const OWNER_POS_OPTIONS = ['delivery_fee', 'pay_later_tabs', 'pay_before_kitchen', 'login_codes', 'loyalty_enabled',
  'stock_zero_sold_out', 'stock_zero_hide', 'approval_pin'] as const;

/** Were cashier switches; now a permission each role holds or not. */
export const PER_ROLE_SWITCHES: Record<string, string> = {
  cashier_own_history:  'See every cashier’s sales (sales.history_all)',
  // A594: three rights now — Record cash in, Record cash out / pay-outs, Record expenses.
  cashier_no_money_out: 'Record cash in, cash out / pay-outs and expenses (shifts.cash_movements, shifts.cash_out, expenses.record)',
  cashier_no_reprint:   'Reprint receipts (sales.reprint)',
};

export const OWNER_POS_OPTIONS_WHERE = 'Set by the owner — Settings › Business › POS options';
export const PER_ROLE_WHERE = 'Now set per role by the owner — Settings › Users and access › Roles and permissions';

/** May the admin portal still switch this feature flag? (The cloud is the real check — this only decides the UI.) */
export function adminSwitches(key: string): boolean {
  return !(OWNER_POS_OPTIONS as readonly string[]).includes(key) && !(key in PER_ROLE_SWITCHES);
}

/** The cloud's refusal of a setting the owner now holds — its own message, else a plain one. */
export function ownerSetsMessage(e: { code?: unknown; message?: unknown } | null | undefined): string | null {
  if (!e || e.code !== 'OWNER_SETS') return null;
  return typeof e.message === 'string' && e.message ? e.message : 'The owner sets this in their own dashboard now.';
}
