/**
 * promotionOffers.ts — A518: a promotion (Menu › Promotions, menu.promotions) charged at the sale, through the ONE offers
 * engine (lib/offers.ts = shared/offers.ts) that the till, the web POS and the cloud's check of a sale already run.
 *
 * Before: promotions were stored and listed but nothing ever applied them — not the cloud, not the web POS (A445 took its
 * cart display out: it was never charged), not the till — and a "Specific products" one could not even name its products
 * (A506). Now each promotion that may be charged becomes an offer row in the list pos/init sends (`offers`, which every
 * till since 1.0.6 applies by its own clock — no till change) and is recognised by the cloud's recheck (checkOfferClaim).
 *
 * The mapping (promotions' own words → the engine's):
 *   applies_to   'product' → 'products' (product_ids), 'category' → 'categories' (category_ids), 'all' → 'all'. The engine
 *                reads 'products' / 'categories': passing the promotion's word through would have priced EVERY item.
 *   happy_hour   percentage → percent_off, fixed → amount_off (off each item in scope); its days, dates and hours.
 *   bogo         buy min_quantity (1 if unset) of the items in scope, get free_quantity (1) of the same items free.
 *   quantity_discount — the engine has no "N or more of an item" rule: not charged (promotionChargeable says why; the page
 *                shows it). An Offer does this job.
 * Only a promotion saved since A518 (`applies_at_sale`, migration 144) is charged: the rows from before were never charged
 * anywhere, and switching them all on with a release would change prices nobody chose. Opening and saving one switches it on.
 *
 * Pure apart from promotionOffersFor / promotionOffersByIds (one read each).
 */
import { supabase } from './supabase';
import { cleanOffer, type Offer } from './offers';

export interface PromotionRow {
  id: string; name: string; promo_type: string; status?: string | null; applies_at_sale?: boolean | null;
  start_date?: string | null; end_date?: string | null; start_time?: string | null; end_time?: string | null;
  days_of_week?: number[] | null; applies_to?: string | null; product_ids?: string[] | null; category_ids?: string[] | null;
  discount_type?: string | null; discount_value?: number | string | null; min_quantity?: number | null; free_quantity?: number | null;
}

/** Why a promotion is not charged at the sale, or null when it is (given it is switched on and saved since A518). */
export function promotionChargeable(p: PromotionRow): string | null {
  if (p.promo_type === 'quantity_discount') return 'A quantity discount is not charged at the POS - set it up as an Offer.';
  if (p.promo_type === 'happy_hour' && !(Number(p.discount_value) > 0)) return 'Enter the discount.';
  if (p.promo_type !== 'happy_hour' && p.promo_type !== 'bogo') return 'This kind of promotion is not charged.';
  if (p.applies_to === 'product' && !(p.product_ids ?? []).length) return 'Choose the products.';
  if (p.applies_to === 'category' && !(p.category_ids ?? []).length) return 'Choose the categories.';
  return null;
}

/** The offer row (the shape pos/init sends and cleanOffer reads) a promotion is charged as — null when it is not charged. */
export function promotionAsOfferRow(p: PromotionRow, opts: { ignoreSwitches?: boolean } = {}): Record<string, unknown> | null {
  if (!opts.ignoreSwitches && (p.status !== 'active' || p.applies_at_sale !== true)) return null;
  if (promotionChargeable(p)) return null;
  const applies_to = p.applies_to === 'product' ? 'products' : p.applies_to === 'category' ? 'categories' : 'all';
  const base = {
    id: p.id, name: p.name, value: 0, spend_type: 'amount', applies_to,
    product_ids: applies_to === 'products' ? [...(p.product_ids ?? [])] : [],
    category_ids: applies_to === 'categories' ? [...(p.category_ids ?? [])] : [],
    buy_qty: 0, get_qty: 0, get_product_id: null, min_spend: 0, meal_items: [],
    start_date: p.start_date ? String(p.start_date).slice(0, 10) : null,
    end_date: p.end_date ? String(p.end_date).slice(0, 10) : null,
    days: Array.isArray(p.days_of_week) ? p.days_of_week : null,
    // A time window is a happy hour's; the engine needs both ends (or neither).
    start_time: p.promo_type === 'happy_hour' && p.start_time && p.end_time ? String(p.start_time).slice(0, 5) : null,
    end_time: p.promo_type === 'happy_hour' && p.start_time && p.end_time ? String(p.end_time).slice(0, 5) : null,
    branch_ids: null,   // a promotion runs at every branch (A494)
    active: true,
    source: 'promotion',
  };
  const row = p.promo_type === 'bogo'
    ? { ...base, kind: 'buy_get', buy_qty: Math.max(1, Math.floor(Number(p.min_quantity) || 1)), get_qty: Math.max(1, Math.floor(Number(p.free_quantity) || 1)) }
    : { ...base, kind: p.discount_type === 'fixed' ? 'amount_off' : 'percent_off', value: Number(p.discount_value) };
  return cleanOffer(row).ok ? row : null;   // never hand a till a row its engine would refuse
}

/** The offers the promotions are charged as, cleaned (the cloud's recheck). */
export function promotionOffers(rows: PromotionRow[], opts: { ignoreSwitches?: boolean } = {}): Offer[] {
  return rows.flatMap((p) => {
    const row = promotionAsOfferRow(p, opts);
    const c = row ? cleanOffer(row) : null;
    return c && c.ok ? [c.offer] : [];
  });
}

/** A518: the business's promotions charged at a sale now, as pos/init offer rows. A failed read is none (never wedge init). */
export async function promotionOffersFor(businessId: string): Promise<Record<string, unknown>[]> {
  const { data, error } = await supabase.from('promotions').select('*').eq('business_id', businessId).eq('status', 'active');
  if (error) return [];
  return ((data ?? []) as PromotionRow[]).flatMap((p) => { const r = promotionAsOfferRow(p); return r ? [r] : []; });
}

/**
 * A518: the promotions a sale claims (by id), as offers for the cloud's recheck. Like an offer, one switched off since the
 * sale is honoured (the till priced it while it ran) — but only one that was charged at all (saved since A518).
 */
export async function promotionOffersByIds(businessId: string, ids: string[]): Promise<Offer[]> {
  if (!ids.length) return [];
  const { data, error } = await supabase.from('promotions').select('*').eq('business_id', businessId).in('id', ids);
  if (error) return [];
  return promotionOffers(((data ?? []) as PromotionRow[]).filter((p) => p.applies_at_sale === true), { ignoreSwitches: true });
}
