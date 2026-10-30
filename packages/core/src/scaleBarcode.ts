/**
 * scaleBarcode.ts — A577: items sold by weight, and the barcodes a weighing scale prints on their labels.
 *
 * Owner, 2026-10-23 (approved): goods sold by the kilo — meat, vegetables, sweets, nyama choma — are weighed on a label
 * scale that prints an EAN-13 whose digits carry the item's scale code (its PLU) and either the label's PRICE or the
 * WEIGHT. Scanning one at the till adds the item with the weight as its quantity (0.452 kg) and the right amount.
 *
 * Pure (no DOM, no Node): the till parses offline with it, the web POS and the settings' test box with it, the cloud
 * cleans the stored settings and checks a weighed line's amount with it.
 * Copies (scripts/check-shared-sync.mjs keeps them identical): apps/server/src/lib, apps/dashboard/src/lib,
 * apps/desktop/src/shared (the till's sale screen) and apps/desktop/src/main (the till's receipt).
 *
 * ── THE LABEL ────────────────────────────────────────────────────────────────────────────────────────────────────────
 * GS1 keeps EAN-13 prefixes 20–29 for numbers used inside one shop (shared/barcode.ts). ZapTill's own in-store codes use
 * "20" (A571), so a code starting "20" is NEVER read as a scale label, whatever the settings say. Scales use 21–29:
 *
 *     prefix (2 digits, or the single "2")  +  item code  +  [value check digit]  +  value  +  EAN check digit
 *     e.g. 22 01234 00294 C   →  item 01234, price KES 294            (2 + 5 + 5 + 1 = 13)
 *          21 01234 00452 C   →  item 01234, weight 0.452 kg          (weight in grams: 3 decimals)
 *          22 01234 6 2875 C  →  item 01234, price check digit 6, price 2875   (DIGI-style, 4-digit price)
 *
 * The lengths always add to 13; the settings say how the scale was set up (cleanScaleSettings refuses a layout that does
 * not add up). The EAN check digit must be right, and the value check digit too when the scale prints one (GS1's price
 * check digit, General Specifications 7.9.3 — weights 2- 2- 3 5- for four digits, 5+ 2- 5- 5+ 2- for five).
 *
 * ── THE AMOUNT ───────────────────────────────────────────────────────────────────────────────────────────────────────
 *   weight label:  quantity = the weight in kg (3 decimals); amount = price per kg × kg, rounded to the cent as every
 *                  other line (round2).
 *   price label:   the label's price IS the amount (the customer was charged what the label says); quantity = price ÷
 *                  price per kg, to the gram. The cloud accepts that amount when it is within half a gram's worth of
 *                  price-per-kg × quantity (weighedAmountAccepted) — so the label wins and a till cannot invent a price.
 */

// ── Settings ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export type ScaleValueType = 'price' | 'weight';

export interface ScaleSettings {
  /** Off = scale labels are not read (a code is looked up as an ordinary barcode). */
  enabled: boolean;
  /** Which preset these settings came from ('custom' once edited by hand). For the screen only. */
  preset: string;
  /** The label prefixes this business's scales print, each "21"…"29" or the single "2" (= 21–29). Never "20". */
  prefixes: string[];
  /** Digits of the item's scale code (its PLU) on the label. */
  itemDigits: number;
  /** What the label carries after the item code. */
  valueType: ScaleValueType;
  /** Digits of the price / weight. */
  valueDigits: number;
  /** Decimals in the value: a price 0 (whole shillings) or 2 (cents); a weight 3 (grams → kg) or 2 (10 g). */
  decimals: number;
  /** The scale prints GS1's price check digit just before the value (four- or five-digit values only). */
  valueCheckDigit: boolean;
}

export const SCALE_SETTINGS_KEY = 'scale_barcodes';

const ALL_2X = ['21', '22', '23', '24', '25', '26', '27', '28', '29'];

export interface ScalePreset {
  id: string;
  name: string;
  /** One line for the settings screen: what the label looks like. */
  layout: string;
  settings: Omit<ScaleSettings, 'enabled' | 'preset'>;
}

/**
 * Presets for the label scales sold in Kenya. Each is the layout that scale is commonly set to print; every scale can be
 * set up differently in its own menu, so the owner checks one label in the test box before relying on it.
 */
export const SCALE_PRESETS: readonly ScalePreset[] = [
  { id: 'generic-price', name: 'Standard — price on the label', layout: '2X + item code (5) + price (5) + check',
    settings: { prefixes: ALL_2X, itemDigits: 5, valueType: 'price', valueDigits: 5, decimals: 0, valueCheckDigit: false } },
  { id: 'generic-weight', name: 'Standard — weight on the label', layout: '2X + item code (5) + weight in grams (5) + check',
    settings: { prefixes: ALL_2X, itemDigits: 5, valueType: 'weight', valueDigits: 5, decimals: 3, valueCheckDigit: false } },
  { id: 'cas', name: 'CAS (CL5000, CL3000, LP-1000)', layout: '2X + item code (5) + price (5) + check',
    settings: { prefixes: ALL_2X, itemDigits: 5, valueType: 'price', valueDigits: 5, decimals: 0, valueCheckDigit: false } },
  { id: 'digi', name: 'DIGI (SM-100, SM-120, SM-5300)', layout: '2X + item code (5) + price check digit + price (4) + check',
    settings: { prefixes: ALL_2X, itemDigits: 5, valueType: 'price', valueDigits: 4, decimals: 0, valueCheckDigit: true } },
  { id: 'ishida', name: 'Ishida (Uni-3, Uni-5, BC-4000)', layout: '2X + item code (5) + weight in grams (5) + check',
    settings: { prefixes: ALL_2X, itemDigits: 5, valueType: 'weight', valueDigits: 5, decimals: 3, valueCheckDigit: false } },
  { id: 'six-digit-item', name: 'Six-digit item code — price', layout: '2 + item code (6) + price (5) + check',
    settings: { prefixes: ['2'], itemDigits: 6, valueType: 'price', valueDigits: 5, decimals: 0, valueCheckDigit: false } },
];

export const DEFAULT_SCALE_SETTINGS: ScaleSettings = { enabled: true, preset: 'generic-price', ...SCALE_PRESETS[0].settings };

/** The settings a preset gives (unknown id → the default). */
export function presetSettings(id: string): ScaleSettings {
  const p = SCALE_PRESETS.find((x) => x.id === id) ?? SCALE_PRESETS[0];
  return { enabled: true, preset: p.id, ...p.settings, prefixes: [...p.settings.prefixes] };
}

/** How many digits the layout uses, the EAN check digit included (must be 13). */
export function layoutLength(s: Pick<ScaleSettings, 'prefixes' | 'itemDigits' | 'valueDigits' | 'valueCheckDigit'>): number {
  const pl = s.prefixes.length ? s.prefixes[0].length : 2;
  return pl + s.itemDigits + (s.valueCheckDigit ? 1 : 0) + s.valueDigits + 1;
}

/**
 * Stored / sent settings → clean ones, or an error in plain words. Accepts the object or its JSON. null / '' → the
 * default. A layout that does not add up to 13 digits, a "20" prefix, mixed prefix lengths are refused (`error`).
 */
export function cleanScaleSettings(raw: unknown): { ok: true; settings: ScaleSettings } | { ok: false; error: string } {
  let v: unknown = raw;
  if (v === null || v === undefined || v === '') return { ok: true, settings: { ...DEFAULT_SCALE_SETTINGS, prefixes: [...ALL_2X] } };
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return { ok: false, error: 'The scale settings could not be read.' }; } }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false, error: 'The scale settings could not be read.' };
  const r = v as Record<string, unknown>;
  const int = (x: unknown, d: number) => (Number.isInteger(Number(x)) && x !== null && x !== '' && x !== undefined ? Number(x) : d);
  const prefixes = Array.isArray(r.prefixes)
    ? [...new Set(r.prefixes.map((p) => String(p).trim()).filter(Boolean))].sort()
    : [...ALL_2X];
  if (!prefixes.length) return { ok: false, error: 'Choose at least one label prefix (21 to 29).' };
  for (const p of prefixes) {
    if (p === '20' || p.startsWith('20')) return { ok: false, error: 'Prefix 20 is ZapTill\'s own in-store codes — scales use 21 to 29.' };
    if (!/^2[1-9]?$/.test(p)) return { ok: false, error: `"${p}" is not a scale prefix — use 21 to 29 (or 2 for all of them).` };
  }
  if (new Set(prefixes.map((p) => p.length)).size > 1) return { ok: false, error: 'Use either the single prefix 2 or two-digit prefixes, not both.' };
  const valueType: ScaleValueType = r.valueType === 'weight' ? 'weight' : 'price';
  const itemDigits = int(r.itemDigits, 5);
  const valueDigits = int(r.valueDigits, 5);
  const decimals = int(r.decimals, valueType === 'weight' ? 3 : 0);
  const valueCheckDigit = r.valueCheckDigit === true;
  if (itemDigits < 3 || itemDigits > 7) return { ok: false, error: 'The item code is 3 to 7 digits.' };
  if (valueDigits < 4 || valueDigits > 6) return { ok: false, error: 'The price or weight is 4 to 6 digits.' };
  if (decimals < 0 || decimals > 3) return { ok: false, error: 'Decimals are 0 to 3.' };
  if (valueCheckDigit && valueDigits !== 4 && valueDigits !== 5) return { ok: false, error: 'A price check digit goes with a 4- or 5-digit value.' };
  const settings: ScaleSettings = {
    enabled: r.enabled !== false,
    preset: typeof r.preset === 'string' && r.preset ? r.preset.slice(0, 40) : 'custom',
    prefixes, itemDigits, valueType, valueDigits, decimals, valueCheckDigit,
  };
  const len = layoutLength(settings);
  if (len !== 13) return { ok: false, error: `The layout is ${len} digits — a scale barcode (EAN-13) is 13. Check the item code and value lengths.` };
  return { ok: true, settings };
}

/** Clean settings, or the default when the stored value is bad (a till never stops selling over a setting). */
export function scaleSettingsOrDefault(raw: unknown): ScaleSettings {
  const c = cleanScaleSettings(raw);
  return c.ok ? c.settings : { ...DEFAULT_SCALE_SETTINGS, prefixes: [...ALL_2X] };
}

// ── Check digits ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** GS1 mod-10 check digit of a digit string without its check digit (same as shared/barcode.ts gs1CheckDigit). */
export function eanCheckDigit(body: string): number {
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    const d = body.charCodeAt(body.length - 1 - i) - 48;
    sum += i % 2 === 0 ? d * 3 : d;
  }
  return (10 - (sum % 10)) % 10;
}

// GS1 General Specifications 7.9.3 — the weighting factor tables for price / weight check digits.
const W2M = [0, 2, 4, 6, 8, 9, 1, 3, 5, 7];   // 2-
const W3 = [0, 3, 6, 9, 2, 5, 8, 1, 4, 7];    // 3
const W5P = [0, 5, 1, 6, 2, 7, 3, 8, 4, 9];   // 5+
const W5M = [0, 5, 9, 4, 8, 3, 7, 2, 6, 1];   // 5-

/** GS1's check digit for a 4- or 5-digit price / weight field (null for another length or not digits). */
export function valueCheckDigit(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const d = [...value].map(Number);
  if (d.length === 4) {
    const sum = W2M[d[0]] + W2M[d[1]] + W3[d[2]] + W5M[d[3]];
    return (sum * 3) % 10;
  }
  if (d.length === 5) {
    const sum = W5P[d[0]] + W2M[d[1]] + W5M[d[2]] + W5P[d[3]] + W2M[d[4]];
    const target = (10 - (sum % 10)) % 10;
    return W5M.indexOf(target);
  }
  return null;
}

// ── Parsing ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ScaleReading {
  /** The code as scanned. */
  code: string;
  prefix: string;
  /** The item's scale code as printed (leading zeros kept). */
  itemCode: string;
  valueType: ScaleValueType;
  /** price label: the amount in the business's currency (e.g. 294 or 293.80). */
  price?: number;
  /** weight label: kilograms (e.g. 0.452). */
  weightKg?: number;
}

export type ScaleExplain = { ok: true; reading: ScaleReading } | { ok: false; reason: string };

/**
 * Explain a scanned code against the settings — what the settings' test box shows. Never throws. `ok: false` says why
 * it is not a scale label (the till then looks it up as an ordinary barcode).
 */
export function explainScaleBarcode(code: unknown, settings: ScaleSettings): ScaleExplain {
  const c = String(code ?? '').trim();
  if (!settings.enabled) return { ok: false, reason: 'Scale labels are switched off.' };
  if (!/^\d{13}$/.test(c)) return { ok: false, reason: 'Not a 13-digit EAN-13 barcode.' };
  if (c.startsWith('20')) return { ok: false, reason: 'Prefix 20 is a ZapTill in-store code, not a scale label.' };
  const prefix = settings.prefixes.find((p) => c.startsWith(p));
  if (!prefix) return { ok: false, reason: `Its prefix ${c.slice(0, 2)} is not one of this business's scale prefixes (${settings.prefixes.join(', ')}).` };
  if (layoutLength(settings) !== 13) return { ok: false, reason: 'The scale layout does not add up to 13 digits.' };
  if (eanCheckDigit(c.slice(0, 12)) !== Number(c[12])) return { ok: false, reason: 'The barcode\'s check digit is wrong — scan it again.' };
  let at = prefix.length;
  const itemCode = c.slice(at, at + settings.itemDigits); at += settings.itemDigits;
  let printedCheck: number | null = null;
  if (settings.valueCheckDigit) { printedCheck = Number(c[at]); at += 1; }
  const raw = c.slice(at, at + settings.valueDigits);
  if (printedCheck !== null && valueCheckDigit(raw) !== printedCheck) {
    return { ok: false, reason: `The ${settings.valueType} check digit is wrong (${printedCheck}, expected ${valueCheckDigit(raw)}).` };
  }
  const value = Number(raw) / 10 ** settings.decimals;
  if (settings.valueType === 'price') {
    return { ok: true, reading: { code: c, prefix, itemCode, valueType: 'price', price: round2(value) } };
  }
  // A weight in kg: 2 decimals = tens of grams (0.45 kg), 3 = grams; never more precision than the gram.
  const kg = round3(value);
  if (!(kg > 0)) return { ok: false, reason: 'The label\'s weight is zero.' };
  return { ok: true, reading: { code: c, prefix, itemCode, valueType: 'weight', weightKg: kg } };
}

/** A scale label's reading, or null when the code is not one (look it up as an ordinary barcode). */
export function parseScaleBarcode(code: unknown, settings: ScaleSettings): ScaleReading | null {
  const r = explainScaleBarcode(code, settings);
  return r.ok ? r.reading : null;
}

/** The item code with its leading zeros dropped ("01234" → "1234", "00000" → "0"), so PLU 1234 matches label 01234. */
export function normaliseItemCode(code: unknown): string {
  const d = String(code ?? '').trim();
  if (!/^\d+$/.test(d)) return d;
  return d.replace(/^0+(?=\d)/, '');
}

/** The product whose PLU (scale item code) is the label's item code — the cloud's `plu_code`, the till's `plu`. */
export function findScaleProduct<P extends { plu_code?: string | null; plu?: string | null; status?: string | null }>(
  products: readonly P[], itemCode: string,
): P | undefined {
  const want = normaliseItemCode(itemCode);
  const active = products.filter((p) => !p.status || p.status === 'active');
  return active.find((p) => {
    const plu = p.plu_code ?? p.plu;
    return plu != null && String(plu).trim() !== '' && normaliseItemCode(plu) === want;
  });
}

// ── Weighed lines ────────────────────────────────────────────────────────────────────────────────────────────────────

/** Money as the app rounds it everywhere (the cloud's round2). */
export function round2(n: number): number { return Math.round((n + Number.EPSILON) * 100) / 100; }
/** A weight to the gram. */
export function round3(n: number): number { return Math.round((n + Number.EPSILON) * 1000) / 1000; }

/** Is the product sold by weight (its quantity is kilograms)? */
export function isSoldByWeight(p: { sold_by?: string | null } | null | undefined): boolean {
  return !!p && p.sold_by === 'weight';
}

/** How a weighed product's weight is shown: 'g' when its unit is grams, else 'kg' (the quantity is always kg). */
export function weightUnitOf(p: { unit_label?: string | null } | null | undefined): 'kg' | 'g' {
  return p?.unit_label === 'g' ? 'g' : 'kg';
}

export interface WeighedLine {
  /** Kilograms, to the gram. */
  quantity: number;
  /** Price per kg (the product's price). */
  unitPrice: number;
  /** What the line costs. */
  lineTotal: number;
}

/** A weight typed or read: kg × price per kg, rounded to the cent. */
export function weighedLine(pricePerKg: number, kg: number): WeighedLine {
  const q = round3(Math.max(0, Number(kg) || 0));
  const unit = Math.max(0, Number(pricePerKg) || 0);
  return { quantity: q, unitPrice: unit, lineTotal: round2(unit * q) };
}

/**
 * A scale label's line. Weight label → weighedLine. Price label → the label's price is the amount and the weight is
 * worked back from the price per kg (a product with no price per kg: 1 at the label's price).
 */
export function scaleLine(pricePerKg: number, reading: ScaleReading): WeighedLine {
  if (reading.valueType === 'weight') return weighedLine(pricePerKg, reading.weightKg ?? 0);
  const price = round2(Math.max(0, reading.price ?? 0));
  const unit = Math.max(0, Number(pricePerKg) || 0);
  if (!(unit > 0)) return { quantity: 1, unitPrice: price, lineTotal: price };
  return { quantity: Math.max(0.001, round3(price / unit)), unitPrice: unit, lineTotal: price };
}

/**
 * The cloud's check of a weighed line's amount: the till's amount stands when it is within half a gram's worth (plus a
 * cent) of price per kg × quantity — what a price label rounded to the gram gives. Anything further is re-priced.
 */
export function weighedAmountAccepted(pricePerKg: number, quantity: number, amount: number): boolean {
  const unit = Math.max(0, Number(pricePerKg) || 0);
  const q = Number(quantity) || 0;
  const a = Number(amount);
  if (!Number.isFinite(a) || a < 0 || !(q > 0)) return false;
  return Math.abs(a - unit * q) <= unit * 0.0005 + 0.01 + 1e-9;
}

// ── Showing a quantity ───────────────────────────────────────────────────────────────────────────────────────────────

/** A quantity as people read it: 3 → "3", 0.452 → "0.452", 1.5 → "1.5" (never more than 3 decimals, never "1.500"). */
export function formatQty(q: number): string {
  const n = Number(q) || 0;
  if (Number.isInteger(n)) return String(n);
  return String(round3(n)).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

/** A weight for a cart or a receipt: "0.452 kg", or "452 g" for an item shown in grams. */
export function formatWeight(kg: number, unit: 'kg' | 'g' = 'kg'): string {
  if (unit === 'g') return `${Math.round((Number(kg) || 0) * 1000)} g`;
  return `${(round3(Number(kg) || 0)).toFixed(3)} kg`;
}
