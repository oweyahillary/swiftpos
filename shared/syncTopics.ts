/**
 * syncTopics.ts — A531: what a change on the cloud is about, and how soon a till takes it.
 *
 * Owner, 2026-10-19: "this should only happen when there is a change, no need to keep asking for the same item … a change
 * in menu do this, change in financial settings do this, change in system settings do this. Critical should be instant,
 * non-critical can take effect after 1 hr or 30 min." And: "if I change fries from 100 to 150 the trigger should only send
 * the affected product and price, not the whole menu … if Eugene's PIN changes only Eugene's change gets synced, not all
 * 150 staff."
 *
 * The database writes one entry per changed row into public.sync_changes (migration 151, trigger log_sync_change). Each
 * entry names a LOGICAL table (what GET /api/pos/changes serves: the row as the till stores it), the row, and its TOPIC:
 *
 *   menu   (critical)  products, categories, variants / add-ons, combos, branch prices, offers, promotions, stock counts
 *   staff  (critical)  people, their branches, grants, roles and role grants
 *   money  (critical)  payment methods, money settings (M-Pesa, tax, voids / refunds, delivery, loyalty, business day,
 *                      cashier money views), POS switches (feature_flags), the business rates (VAT, CTL, currency)
 *   look   (≤ 30 min)  logo / colours / theme, receipt header and footer, the business name and contact settings
 *   setup  (≤ 30 min)  print stations and their categories, tables, pumps, branches, every other setting
 *
 * This file is the ONE classification for the TypeScript side; public.sync_setting_topic (migration 151) is its SQL
 * mirror, and scripts/test-migration-151.mjs runs both on the same keys. To move a setting: change both, run that test.
 * Copied verbatim: shared/, apps/server/src/lib/, apps/desktop/src/main/ (scripts/check-shared-sync.mjs).
 */

export const SYNC_TOPICS = ['menu', 'staff', 'money', 'look', 'setup'] as const;
export type SyncTopicName = (typeof SYNC_TOPICS)[number];

/** Applied at once. The others wait for an idle moment, a shift opening or closing, or at most NON_CRITICAL_WAIT_MS. */
export const CRITICAL_TOPICS: readonly SyncTopicName[] = ['menu', 'staff', 'money'];
export const NON_CRITICAL_WAIT_MS = 30 * 60_000;

export function isCriticalTopic(t: string): boolean {
  return (CRITICAL_TOPICS as readonly string[]).includes(t);
}
export function isSyncTopic(t: unknown): t is SyncTopicName {
  return typeof t === 'string' && (SYNC_TOPICS as readonly string[]).includes(t);
}

// ── business_settings / branch_settings keys ─────────────────────────────────────────────────────────────────────────
/** The e-mail jobs' last-sent marks (A528): no till reads them — they log nothing. */
export const BOOKKEEPING_SETTING_KEYS: readonly string[] = ['owner_alerts_state', 'weekly_summary_last_sent', 'monthly_pack_last_sent', 'report_schedule_last_sent'];
export const BOOKKEEPING_SETTING_PREFIXES: readonly string[] = ['branch_open_tills_last_sent:'];

export const MENU_SETTING_KEYS: readonly string[] = ['stock_count_freeze'];

export const MONEY_SETTING_KEYS: readonly string[] = [
  'payment_methods_enabled', 'continuous_operation', 'business_day_cutoff',
  'cashier_history_methods', 'cashier_sees_shift_sales', 'cashier_history_totals', 'cashier_own_history',
  'cashier_no_reprint', 'cashier_no_money_out', 'service_charge_pct', 'pay_later_tabs', 'pay_before_kitchen',
  'etims_enabled', 'default_parking_rate',
];
export const MONEY_SETTING_PREFIXES: readonly string[] = [
  'mpesa_', 'receipt_pay_', 'aggregator_commission_', 'parking_rate_', 'loyalty_', 'delivery_', 'void_', 'offline_', 'ctl_',
];
/** Any key naming tax or VAT is money too ("tax/VAT/CTL and other money keys"). */
export const MONEY_SETTING_WORDS: readonly string[] = ['tax', 'vat'];

export const LOOK_SETTING_KEYS: readonly string[] = ['thank_you_message'];
export const LOOK_SETTING_PREFIXES: readonly string[] = ['receipt_', 'business_', 'contact_'];

/** The topic of a business / branch setting by its key; null = bookkeeping (logs nothing). Rules in this order. */
export function settingTopic(key: string): SyncTopicName | null {
  const k = String(key ?? '');
  if (BOOKKEEPING_SETTING_KEYS.includes(k) || BOOKKEEPING_SETTING_PREFIXES.some((p) => k.startsWith(p))) return null;
  if (MENU_SETTING_KEYS.includes(k)) return 'menu';
  if (MONEY_SETTING_KEYS.includes(k) || MONEY_SETTING_PREFIXES.some((p) => k.startsWith(p))
      || MONEY_SETTING_WORDS.some((w) => k.includes(w))) return 'money';
  if (LOOK_SETTING_KEYS.includes(k) || LOOK_SETTING_PREFIXES.some((p) => k.startsWith(p))) return 'look';
  return 'setup';
}

// ── What /api/pos/changes serves ─────────────────────────────────────────────────────────────────────────────────────
/**
 * The logical tables of the change log, each with its topic ('config' carries its topic as the row id: money / look /
 * setup) and the database tables whose rows log into it (the trigger in migration 151 is the source of truth; the
 * migration test checks it against this list).
 */
export const CHANGE_TABLES = {
  products:        { topic: 'menu',  from: ['products', 'combo_items', 'branch_prices'] },
  product_choices: { topic: 'menu',  from: ['variant_groups', 'variant_options', 'variant_group_products', 'modifier_groups', 'modifier_options'] },
  categories:      { topic: 'menu',  from: ['categories'] },
  offers:          { topic: 'menu',  from: ['offers'] },
  promotions:      { topic: 'menu',  from: ['promotions'] },
  stock_count:     { topic: 'menu',  from: ['stock_takes', 'business_settings'] },
  staff:           { topic: 'staff', from: ['users', 'user_branches', 'user_permissions'] },
  roles:           { topic: 'staff', from: ['roles', 'role_permissions'] },
  config:          { topic: null,    from: ['business_settings', 'branch_settings', 'feature_flags', 'businesses', 'payment_methods', 'branches'] },
  branding:        { topic: 'look',  from: ['business_branding', 'feature_flags'] },
  print_stations:  { topic: 'setup', from: ['print_stations', 'category_stations'] },
  tables:          { topic: 'setup', from: ['tables'] },
  pumps:           { topic: 'setup', from: ['pumps'] },
} as const;
export type ChangeTable = keyof typeof CHANGE_TABLES;

/**
 * pos/init's settings-like keys, by topic — a 'config' change is answered with its topic's keys (a handful of values,
 * some derived from several settings: the M-Pesa line, the reversal rules), never the menu.
 */
export const CONFIG_KEYS = {
  money: ['paymentMethods', 'paymentMethodsEnabled', 'mpesa', 'receiptPayLabel', 'receiptPayNumber', 'vatRate', 'ctlRate',
    'currency', 'maxDiscountPct', 'loyaltyEnabled', 'posFeatures', 'reversalRules', 'webPosEnabled', 'continuousOperation',
    'businessDayCutoff', 'cashierHistoryMethods', 'cashierSeesShiftSales', 'cashierHistoryTotals'],
  look: ['receiptHeader', 'receiptFooter', 'businessName'],
  setup: ['kitchenExclusions', 'noteQuickPicks', 'businessType', 'support', 'branchId', 'pricingBranchId'],
} as const;

/** One entry of GET /api/pos/changes. `row` is absent on a delete (and on an upsert whose row is no longer the till's). */
export interface ChangeEntry {
  seq: number;
  topic: SyncTopicName;
  table: ChangeTable;
  id: string;
  op: 'upsert' | 'delete';
  row?: unknown;
}
export interface ChangesAnswer {
  last_seq: number;
  changes: ChangeEntry[];
  more?: boolean;
  full_resync_needed?: boolean;
}
