/**
 * platformPrices.ts — A619 (owner, 2026-11-01): delivery platform prices.
 *
 * Owner: Glovo, Uber Eats and Bolt Food charge fees, so prices on those platforms are higher — "assume 3 piece chicken is
 * 1000 normal price ordering with glovo it is 1150 a 15% bump so the receipt shows 1150 not the percentage increase but
 * the price in glovo". And: "why cant we maintain the same but the moment a cashier picks glovo or uber eats as the
 * payment method the price changes"; "a confirmation of payment method when a cashier clicks charge glovo, uber but cash
 * there is no need".
 *
 *   - Each platform, per branch (business default, branch override — the A387 pattern), key `delivery_platform_prices`:
 *     an uplift by PERCENTAGE (+15%: 1,000 → 1,150) or by a FIXED AMOUNT on every item (+250: a 350 soda → 600).
 *     Blank / 0 = normal prices.
 *   - The rounding, once per business (`delivery_platform_rounding`): exact (to the cent), the nearest shilling, up to the
 *     nearest 5, up to the nearest 10 — applied to each bumped UNIT price.
 *   - An item's own platform price (products.platform_prices, { glovo: 1200 }) wins over the uplift for that item.
 *   - A sale is rung at normal prices; picking a platform as the payment method re-prices every catalogue line (its
 *     add-ons too) with that platform's rule; any other method restores the normal prices. The platform pays the whole
 *     bill (no split). Lines with no catalogue product (a parking bill, a quick charge) keep their price.
 *
 * ONE pure file — the web POS and the desktop POS payment screens, the desktop's main process (the sale), the cloud's
 * check of a sale and the branch server all price with it. Copied verbatim (scripts/check-shared-sync.mjs).
 */

export type PlatformRounding = 'exact' | 'shilling' | 'up5' | 'up10';
export type UpliftKind = 'percent' | 'amount';

export interface PlatformRule { kind: UpliftKind; value: number }
/** What a POS holds: the business's rounding and its branch's rule per platform (a platform absent = normal prices). */
export interface PlatformPricing { rounding: PlatformRounding; rules: Record<string, PlatformRule> }

export const PLATFORM_PRICES_KEY = 'delivery_platform_prices';
export const PLATFORM_ROUNDING_KEY = 'delivery_platform_rounding';

/** The payment catalogue's delivery platforms (kind 'delivery' in paymentCatalogue.ts — the test keeps the two in step). */
export const PLATFORM_METHODS: readonly string[] = ['glovo', 'uber_eats', 'bolt_food', 'yum'];

export const PLATFORM_ROUNDINGS: ReadonlyArray<{ id: PlatformRounding; label: string }> = [
  { id: 'exact', label: 'Exact (to the cent)' },
  { id: 'shilling', label: 'Nearest shilling' },
  { id: 'up5', label: 'Up to the nearest 5' },
  { id: 'up10', label: 'Up to the nearest 10' },
];

export const NO_PLATFORM_PRICING: PlatformPricing = { rounding: 'exact', rules: {} };

const MAX_PERCENT = 500;
const MAX_AMOUNT = 1_000_000;

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

function parsed(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); } catch { return null; }
}

export function isPlatformMethod(code: unknown): boolean {
  return PLATFORM_METHODS.includes(String(code ?? '').trim().toLowerCase());
}

// ── The settings ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** One platform's rule, or null (blank, 0, unreadable = normal prices). */
export function cleanRule(raw: unknown): PlatformRule | null {
  const r = parsed(raw) as { kind?: unknown; value?: unknown } | null;
  if (!r || typeof r !== 'object') return null;
  const kind: UpliftKind | null = r.kind === 'percent' || r.kind === 'amount' ? r.kind : null;
  const value = round2(num(r.value));
  if (!kind || !(value > 0)) return null;
  if (value > (kind === 'percent' ? MAX_PERCENT : MAX_AMOUNT)) return null;
  return { kind, value };
}

/** The rules as stored (a JSON object by platform code, or the object) — unknown platforms and blank rules dropped. */
export function cleanRules(raw: unknown): Record<string, PlatformRule> {
  const v = parsed(raw);
  const out: Record<string, PlatformRule> = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const code of PLATFORM_METHODS) {
    const rule = cleanRule((v as Record<string, unknown>)[code]);
    if (rule) out[code] = rule;
  }
  return out;
}

/** The value to store for the rules, or null when it is not an object of platform rules (the cloud refuses it). */
export function rulesSettingValue(raw: unknown): string | null {
  const v = parsed(raw);
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  for (const [code, rule] of Object.entries(v as Record<string, unknown>)) {
    if (!isPlatformMethod(code)) return null;
    const blank = rule === null || rule === '' || (typeof rule === 'object' && !num((rule as { value?: unknown }).value));
    if (!blank && !cleanRule(rule)) return null;
  }
  return JSON.stringify(cleanRules(v));
}

export function cleanRounding(raw: unknown): PlatformRounding {
  const v = typeof raw === 'string' ? raw.trim().replace(/^"|"$/g, '') : raw;
  return PLATFORM_ROUNDINGS.some((r) => r.id === v) ? (v as PlatformRounding) : 'exact';
}

/** The rounding to store, or null when it is not one of the four. */
export function roundingSettingValue(raw: unknown): PlatformRounding | null {
  const v = typeof raw === 'string' ? raw.trim() : raw;
  return PLATFORM_ROUNDINGS.some((r) => r.id === v) ? (v as PlatformRounding) : null;
}

/** What a POS holds, from the wire or a stored copy ({ rounding, rules }); anything unreadable = normal prices. */
export function cleanPricing(raw: unknown): PlatformPricing {
  const v = parsed(raw) as { rounding?: unknown; rules?: unknown } | null;
  if (!v || typeof v !== 'object') return { ...NO_PLATFORM_PRICING, rules: {} };
  return { rounding: cleanRounding(v.rounding), rules: cleanRules(v.rules) };
}

/** An item's own platform prices (products.platform_prices) — { glovo: 1200 }; blank, 0 and unknown platforms dropped. */
export function cleanOwnPrices(raw: unknown): Record<string, number> {
  const v = parsed(raw);
  const out: Record<string, number> = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const code of PLATFORM_METHODS) {
    const p = round2(num((v as Record<string, unknown>)[code]));
    if (p > 0 && p <= MAX_AMOUNT) out[code] = p;
  }
  return out;
}

/** The own prices to store (an object, {} = none), or null when a price is not a price or a platform is unknown. */
export function ownPricesValue(raw: unknown): Record<string, number> | null {
  const v = parsed(raw);
  if (v === null || v === undefined || v === '') return {};
  if (typeof v !== 'object' || Array.isArray(v)) return null;
  for (const [code, price] of Object.entries(v as Record<string, unknown>)) {
    if (!isPlatformMethod(code)) return null;
    if (price === null || price === '' || price === undefined) continue;
    const n = Number(price);
    if (!Number.isFinite(n) || n < 0 || n > MAX_AMOUNT) return null;
  }
  return cleanOwnPrices(v);
}

// ── The price ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A bumped unit price rounded the business's way. "Up to" never rounds a price down; a whole number stays as it is. */
export function roundPrice(n: number, mode: PlatformRounding): number {
  const x = round2(n);
  if (mode === 'shilling') return Math.round(x);
  if (mode === 'up5') return Math.ceil(x / 5 - 1e-9) * 5;
  if (mode === 'up10') return Math.ceil(x / 10 - 1e-9) * 10;
  return x;
}

/** The rule applied to one price (rounded); null rule or 0 = unchanged. */
function bump(price: number, rule: PlatformRule | null, rounding: PlatformRounding, addAmount: boolean): number {
  if (!rule || !(price > 0)) return round2(price);
  if (rule.kind === 'percent') return roundPrice(price * (1 + rule.value / 100), rounding);
  return addAmount ? roundPrice(price + rule.value, rounding) : round2(price);
}

/**
 * The platform's unit price of an item. `unit` is its normal unit price (its branch's price + its options), `variants` the
 * options' part of it, `own` the item's own platform price (null: none).
 *   - own price: it replaces the item's price; its options are bumped by a percentage (a fixed amount is per item, already
 *     in the own price) and the total rounded — with no options the own price is charged exactly as the owner set it;
 *   - else the whole unit price is bumped: × (1 + %) or + the amount, then rounded.
 */
export function platformUnitPrice(input: { unit: number; variants?: number; own?: number | null }, rule: PlatformRule | null,
  rounding: PlatformRounding): number {
  const unit = Math.max(0, num(input.unit));
  const own = input.own !== null && input.own !== undefined && num(input.own) > 0 ? round2(num(input.own)) : null;
  if (own === null) return bump(unit, rule, rounding, true);
  const variants = num(input.variants);
  if (Math.abs(variants) < 0.005) return own;
  const options = rule?.kind === 'percent' ? variants * (1 + rule.value / 100) : variants;
  return Math.max(0, roundPrice(own + options, rounding));
}

/** An add-on's platform price: bumped by a percentage; a fixed amount is per item, so an add-on keeps its price. */
export function platformModifierPrice(price: number, rule: PlatformRule | null, rounding: PlatformRounding): number {
  return bump(Math.max(0, num(price)), rule, rounding, false);
}

// ── A cart line ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** The parts of a cart line (the web POS's, the desktop's, the cloud's order item) this file reads and re-prices. */
export interface PriceableLine {
  product?: { id?: string | null; name?: string | null; platform_prices?: unknown } | null;
  quantity: number | string;
  unitPrice: number | string;
  lineTotal?: number | string | null;
  selectedVariants?: Array<{ priceAdjustment?: number | string | null }> | null;
  selectedModifiers?: Array<{ price?: number | string | null }> | null;
}

const variantsOf = (l: PriceableLine) => (l.selectedVariants ?? []).reduce((s, v) => s + num(v?.priceAdjustment), 0);
const modifiersOf = (l: PriceableLine) => (l.selectedModifiers ?? []).reduce((s, m) => s + Math.max(0, num(m?.price)), 0);

/** The line at the platform's prices (a new object; its add-ons' prices too). A line with no product keeps its price. */
export function priceLineForPlatform<T extends PriceableLine>(line: T, platform: string, pricing: PlatformPricing,
  own?: number | null): T {
  if (!line?.product?.id) return line;
  const rule = pricing.rules[platform] ?? null;
  const ownPrice = own !== undefined ? own : (cleanOwnPrices(line.product.platform_prices)[platform] ?? null);
  const unitPrice = platformUnitPrice({ unit: num(line.unitPrice), variants: variantsOf(line), own: ownPrice }, rule, pricing.rounding);
  const selectedModifiers = (line.selectedModifiers ?? []).map((m) => ({ ...m, price: platformModifierPrice(num(m?.price), rule, pricing.rounding) }));
  const mods = selectedModifiers.reduce((s, m) => s + m.price, 0);
  return { ...line, unitPrice, selectedModifiers, lineTotal: round2((unitPrice + mods) * num(line.quantity)) };
}

/** Every line at the platform's prices — or the lines as they are when no platform is chosen. */
export function priceCartForPlatform<T extends PriceableLine>(lines: T[], platform: string | null, pricing: PlatformPricing): T[] {
  if (!platform || !isPlatformMethod(platform)) return lines;
  return lines.map((l) => priceLineForPlatform(l, platform, pricing));
}

/** What a line comes to: its own line total, else (unit + add-ons) × quantity. */
export function lineAmount(l: PriceableLine): number {
  const lt = l.lineTotal;
  if (lt !== undefined && lt !== null && lt !== '' && Number.isFinite(Number(lt))) return round2(Number(lt));
  return round2((num(l.unitPrice) + modifiersOf(l)) * num(l.quantity));
}

export interface PlatformQuote<T> {
  platform: string;
  lines: T[];
  normalSubtotal: number;
  platformSubtotal: number;
  /** platform − normal: what the platform prices add ("of which uplift" in the reports). */
  uplift: number;
  /** Each line whose unit price changed: "3 Piece Chicken 1,000 → 1,150" (unit prices, add-ons included). */
  changes: Array<{ name: string; from: number; to: number }>;
}

/** The cart at a platform's prices, with what changed — null when `platform` is not a delivery platform. */
export function platformQuote<T extends PriceableLine>(lines: T[], platform: string | null, pricing: PlatformPricing): PlatformQuote<T> | null {
  if (!platform || !isPlatformMethod(platform)) return null;
  const priced = priceCartForPlatform(lines, platform, pricing);
  const unitOf = (l: PriceableLine) => round2(num(l.unitPrice) + modifiersOf(l));
  const changes = lines.flatMap((l, i) => {
    const from = unitOf(l), to = unitOf(priced[i]);
    return Math.abs(to - from) >= 0.005 ? [{ name: String(l.product?.name ?? 'Item'), from, to }] : [];
  });
  const normalSubtotal = round2(lines.reduce((s, l) => s + lineAmount(l), 0));
  const platformSubtotal = round2(priced.reduce((s, l) => s + lineAmount(l), 0));
  return { platform, lines: priced, normalSubtotal, platformSubtotal, uplift: round2(platformSubtotal - normalSubtotal), changes };
}

/** "1,000 → 1,150" — the first change (and how many more), or "normal prices" when nothing changed. */
export function changesText(changes: Array<{ from: number; to: number }>): string {
  if (!changes.length) return 'normal prices';
  const f = (n: number) => n.toLocaleString('en-KE', { maximumFractionDigits: 2 });
  const first = `${f(changes[0].from)} → ${f(changes[0].to)}`;
  return changes.length > 1 ? `${first} (+${changes.length - 1} more)` : first;
}

// ── The sale ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** What an order records of the pricing that applied (orders.price_list / platform_rule / platform_uplift). */
export interface PlatformRecord {
  price_list: string;
  platform_rule: { kind: UpliftKind | null; value: number; rounding: PlatformRounding };
  platform_uplift: number;
}
export function platformRecord(platform: string, pricing: PlatformPricing, uplift: number): PlatformRecord {
  const rule = pricing.rules[platform] ?? null;
  return { price_list: platform, platform_rule: { kind: rule?.kind ?? null, value: rule?.value ?? 0, rounding: pricing.rounding },
    platform_uplift: round2(uplift) };
}

/**
 * The platform a sale is priced for: the one it claims (price_list) when it is a delivery platform and the sale's only
 * payment is that platform; anything else (no claim, a split, another method) = normal prices (null).
 */
export function salePlatform(priceList: unknown, legMethods: unknown[]): string | null {
  const claim = String(priceList ?? '').trim().toLowerCase();
  if (!claim || !isPlatformMethod(claim)) return null;
  return legMethods.length === 1 && String(legMethods[0] ?? '').trim().toLowerCase() === claim ? claim : null;
}

// ── The payment screen ───────────────────────────────────────────────────────────────────────────────────────────────

/** Charge asks first only for a platform ("Charge to Glovo?"); every other method charges at once. (The desktop's legs:
 *  renderer/lib/payment.ts platformOfLegs / legsAfterPick — kept out of this file so the desktop loads it on demand.) */
export function needsPlatformConfirm(method: string | null | undefined): boolean {
  return isPlatformMethod(method);
}
