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

// A604 (owner, 2026-10-28: "why cant we move this switches to the owners side, why did you let them remain in admin while
// we were doing rights"): they were the owner's already (A490/A594) — the Features tab now says so plainly. The owner's
// options are shown as "On" / "Off" (never anything that looks like a switch); the three cashier switches retired into
// role permissions are not listed at all, and the three STANDARD keys (shared/posFeatures.ts STANDARD_POS_FEATURES,
// always on since 0.6.29 / A461, a stored value ignored) are one line instead of raw toggles.
export const OWNER_POS_OPTIONS_HEADING = 'POS options (set by the owner)';
export const OWNER_POS_OPTIONS_NOTE = 'The business owner changes these in their dashboard: Settings › Business › POS options.';
export const PER_ROLE_NOTE = 'Cashier rights (own sales only, reprints, cash in/out and expenses) are set per role by the owner: Settings › Users and access › Roles and permissions.';
export const ALWAYS_ON_NOTE = 'Always on for every business: blind shift close, cashier figures at confirm, manager approval of kitchen voids.';

/** A604: the owner's option that is not a POS switch (shared/posFeatures.ts) — listed with them, read-only. */
export const OWNER_LOYALTY = { key: 'loyalty_enabled', label: 'Loyalty points', description: 'Customers earn points on what they pay and spend them at the POS (the owner also sets the earn rate).' } as const;

/**
 * A604: a flag that still lands under "Other flags" (not a POS switch, not themes / analytics / attendance / web access /
 * the A601 cut-off) — its plain name. etims_enabled is live (lib/etims reads it before sending an invoice to KRA) and the
 * client's eTIMS page sets it too; the portal keeps its switch, named. Any other key keeps its switch under its own name.
 */
export const OTHER_FLAG_LABELS: Record<string, { label: string; description: string }> = {
  etims_enabled: {
    label: 'eTIMS (KRA) invoices',
    description: 'Sales are sent to KRA eTIMS. The client also turns this on or off on their own eTIMS page (Settings › Business › Tax & compliance).',
  },
};

/** A604: the "On" / "Off" a read-only value shows — plain words, never a switch. */
export function ownerValueText(on: boolean): 'On' | 'Off' {
  return on ? 'On' : 'Off';
}

/** May the admin portal still switch this feature flag? (The cloud is the real check — this only decides the UI.) */
export function adminSwitches(key: string): boolean {
  return !(OWNER_POS_OPTIONS as readonly string[]).includes(key) && !(key in PER_ROLE_SWITCHES);
}

/** The cloud's refusal of a setting the owner now holds — its own message, else a plain one. */
export function ownerSetsMessage(e: { code?: unknown; message?: unknown } | null | undefined): string | null {
  if (!e || e.code !== 'OWNER_SETS') return null;
  return typeof e.message === 'string' && e.message ? e.message : 'The owner sets this in their own dashboard now.';
}
