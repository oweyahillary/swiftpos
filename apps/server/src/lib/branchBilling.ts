/**
 * branchBilling.ts — A612 phases 3 and 4: the cloud billed per branch, and premium per branch (docs/A612-per-branch-cloud.md).
 *
 * Owner, 2026-10-30: "the owner should be the one who gets the invoice not individual branch" · "we itemize the items being
 * billed, give unit price and under note we add list of branches" · the items "Cloud - dashboard and, backup, remote till
 * management", "Analytics", "Attendance", "Themes" · "one premium package that of 15000 that covers all the items" (the
 * Cloud AND every premium item, a branch a month) · "You can use dummy information … in the admin panel we can add the true
 * ones later".
 *
 *   ZapTill's billing details   admin_settings 'billing_details': the seller (legal name, address, KRA PIN, phone, email,
 *                               M-Pesa Paybill or Till, the account reference) and the monthly prices (Cloud, Analytics,
 *                               Attendance, Themes, the package). Until saved: the sample seller (marked on the invoice)
 *                               and DEFAULT_PRICES. Set in the admin portal (super admin), read by the billing job.
 *   A branch's bill             its row (branch_cloud_plans): the package → one package line (its monthly price × the
 *                               period's months); else the Cloud (the row's amount — its price for the period) and each
 *                               premium item it pays for (monthly price × months).
 *   Premium per branch          a branch has a feature when the business has it (feature_flags — ZapTill's master switch)
 *                               AND the branch pays for it (premium, or the package). A business billed as one: the
 *                               business's flag alone, as before.
 *
 * Pure rules first (the tests run them), storage after.
 */
import { supabase } from './supabase';
import { PERIOD_MONTHS, type PlanPeriod, type BranchPlanRow, type CloudFactsRow } from './cloudPlan';
import { SAMPLE_SELLER, type InvoiceSeller, type BranchBill } from './cloudPlanEmail';

export const PREMIUM_KEYS = ['analytics', 'attendance', 'themes'] as const;
export type PremiumKey = typeof PREMIUM_KEYS[number];
export const PREMIUM_NAME: Record<PremiumKey, string> = { analytics: 'Analytics', attendance: 'Attendance', themes: 'Themes' };
export const isPremiumKey = (v: unknown): v is PremiumKey => typeof v === 'string' && (PREMIUM_KEYS as readonly string[]).includes(v);

/** Monthly prices, KES. Placeholders until ZapTill sets its own (Analytics and Attendance: the owner's figures). */
export interface BillingPrices { cloud: number; analytics: number; attendance: number; themes: number; package: number }
export const DEFAULT_PRICES: BillingPrices = { cloud: 3000, analytics: 10000, attendance: 2000, themes: 1000, package: 15000 };

export interface BillingDetails { seller: InvoiceSeller; prices: BillingPrices; saved: boolean }
export const BILLING_DETAILS_KEY = 'billing_details';

const str = (v: unknown, max: number): string | null => {
  const s = typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, max) : '';
  return s || null;
};
const price = (v: unknown, fallback: number): number => {
  const n = typeof v === 'string' ? Number(v.replace(/[, ]/g, '')) : Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 10_000_000 ? Math.round(n) : fallback;
};

/** The details as stored (anything missing or malformed: the sample's / the default). Pure. */
export function cleanBillingDetails(raw: unknown): BillingDetails {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  const s = (r.seller && typeof r.seller === 'object' ? r.seller : null) as Record<string, unknown> | null;
  const p = (r.prices && typeof r.prices === 'object' ? r.prices : {}) as Record<string, unknown>;
  const digits = (v: unknown) => { const d = str(v, 12)?.replace(/\D/g, '') ?? ''; return d.length >= 5 ? d : null; };
  const seller: InvoiceSeller = s ? {
    legalName: str(s.legalName, 120) ?? SAMPLE_SELLER.legalName,
    address: str(s.address, 200) ?? SAMPLE_SELLER.address,
    kraPin: str(s.kraPin, 20)?.toUpperCase() ?? null,
    phone: str(s.phone, 30) ?? SAMPLE_SELLER.phone,
    email: str(s.email, 120)?.includes('@') ? str(s.email, 120) : null,
    mpesaPaybill: digits(s.mpesaPaybill),
    mpesaTill: digits(s.mpesaTill),
    accountRef: s.accountRef === 'business' ? 'business' : 'invoice',
    sample: false,
  } : SAMPLE_SELLER;
  const prices: BillingPrices = {
    cloud: price(p.cloud, DEFAULT_PRICES.cloud), analytics: price(p.analytics, DEFAULT_PRICES.analytics),
    attendance: price(p.attendance, DEFAULT_PRICES.attendance), themes: price(p.themes, DEFAULT_PRICES.themes),
    package: price(p.package, DEFAULT_PRICES.package),
  };
  return { seller, prices, saved: !!s };
}

/** A branch's premium features: the package is every one. Pure. */
export function premiumOf(row: Pick<BranchPlanRow, 'premium' | 'package'> | null | undefined): Set<PremiumKey> {
  if (!row) return new Set();
  if (row.package) return new Set(PREMIUM_KEYS);
  return new Set((row.premium ?? []).filter(isPremiumKey));
}

/** How many months a period is (custom: the days to its end over 30, at least one). Pure. */
export function periodMonths(period: PlanPeriod, start?: string | null, end?: string | null): number {
  if (period !== 'custom') return PERIOD_MONTHS[period];
  const a = start ? Date.parse(start) : NaN, b = end ? Date.parse(end) : NaN;
  return Number.isFinite(a) && Number.isFinite(b) && b > a ? Math.max(1, Math.round((b - a) / (30 * 86_400_000))) : 1;
}

/** A branch's lines on an invoice for one period. Pure. */
export function branchBill(row: Pick<BranchPlanRow, 'amount' | 'premium' | 'package' | 'period'>, branchName: string, prices: BillingPrices,
  months: number): BranchBill {
  if (row.package) return { branch: branchName, cloud: 0, package: prices.package * months, period: row.period };
  const premium = [...premiumOf(row)].map((k) => ({ name: PREMIUM_NAME[k], price: prices[k] * months }));
  return { branch: branchName, cloud: Number(row.amount ?? 0), premium, package: null, period: row.period };
}

/**
 * The branches that have a premium feature: null when the business is billed as one (its flag alone decides, as before);
 * else the branches whose row pays for it (premium or the package). The business's flag is checked by the caller. Pure.
 */
export function featureBranches(f: Pick<CloudFactsRow, 'branchIds' | 'branchPlans'> | null | undefined, feature: PremiumKey): string[] | null {
  const rows = f?.branchPlans ?? [];
  if (!f || !rows.length) return null;
  const rowBy = new Map(rows.map((r) => [String(r.branch_id), r]));
  return (f.branchIds ?? []).filter((id) => premiumOf(rowBy.get(id)).has(feature));
}

// ── Storage ──────────────────────────────────────────────────────────────────────────────────────────────────────────

let detailsKept: { at: number; v: BillingDetails } | null = null;
const DETAILS_TTL_MS = 5 * 60_000;

/** ZapTill's billing details (kept 5 minutes; a save forgets them). A failed read: the sample (never a crash). */
export async function readBillingDetails(now: number = Date.now()): Promise<BillingDetails> {
  if (detailsKept && now - detailsKept.at < DETAILS_TTL_MS) return detailsKept.v;
  let v: BillingDetails;
  try {
    const { data, error } = await supabase.from('admin_settings').select('value').eq('key', BILLING_DETAILS_KEY).maybeSingle();
    v = cleanBillingDetails(error ? null : (data as { value?: unknown } | null)?.value);
  } catch { v = cleanBillingDetails(null); }
  detailsKept = { at: now, v };
  return v;
}
export function forgetBillingDetails(): void { detailsKept = null; }
