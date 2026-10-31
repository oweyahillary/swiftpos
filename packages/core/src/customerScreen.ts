/**
 * customerScreen.ts — A606: the customer-facing second screen (a dual-screen POS shows the customer what is rung up).
 *
 * Owner, 2026-10-28: "Yesterday I saw a POS with two screens, one facing the client and the other for the cashier."
 *
 *   STANDARD (every client): the items, quantities and prices as they are rung up, the discounts and the running total; at
 *     payment the amount due and, for cash, the amount given and the change; then "Thank you" and back to idle. Idle shows
 *     the business name plainly.
 *   PREMIUM: the logo and brand colours (the business's 'themes' flag, exactly as A597 / A605: the POS is told a theme id
 *     only while it is on); an idle slideshow of the owner's images and the M-Pesa details at payment (the ONLINE LICENCE,
 *     web_pos_enabled — A460).
 *
 * What crosses to the customer's screen is ONE small state (DisplayState), and it is cleaned by sanitiseDisplayState on
 * the way: a whitelist of fields — never a cost price, a staff name, a PIN, another customer or anything a manager sees.
 * The slideshow is an ordered list of the owner's uploaded images (the same image store as product pictures) and how many
 * seconds each shows, kept in business_settings under CUSTOMER_SCREEN_KEY — no migration.
 *
 * Pure, no imports. Copies kept identical by scripts/check-shared-sync.mjs: shared/, apps/server/src/lib/,
 * apps/desktop/src/main/, apps/desktop/src/shared/, apps/dashboard/src/lib/.
 */

// ── The slideshow (owner's images) ──────────────────────────────────────────────────────────────────────────────────

export const CUSTOMER_SCREEN_KEY = 'customer_screen';
export const MAX_SLIDES = 10;
export const SLIDE_SECONDS_MIN = 3;
export const SLIDE_SECONDS_MAX = 60;
export const SLIDE_SECONDS_DEFAULT = 8;
/** The largest image the owner may upload, and the largest a POS downloads. */
export const MAX_SLIDE_BYTES = 2 * 1024 * 1024;
export const SLIDE_TYPES: readonly string[] = ['image/jpeg', 'image/png', 'image/webp'];
/** How long "Thank you" stays before the screen goes back to idle (the cashier may not press New order at once). */
export const THANKS_MS = 8000;

export interface Slide { url: string }
export interface CustomerScreenSlides { slides: Slide[]; seconds: number }

/** An uploaded image: the image store's https address (Cloudinary, as product pictures), a JPEG, PNG or WebP file. */
const SLIDE_URL = /^https:\/\/res\.cloudinary\.com\/[A-Za-z0-9_-]+\/image\/upload\/[^\s?#"'<>\\]+\.(?:jpe?g|png|webp)$/i;
export function slideUrlOk(url: unknown): url is string {
  return typeof url === 'string' && url.length <= 500 && SLIDE_URL.test(url) && !url.includes('..');
}

const intIn = (v: unknown, min: number, max: number): number | null => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isInteger(n) && n >= min && n <= max ? n : null;
};

/** The owner's save → a clean list, or why it is refused (in the owner's words). Duplicates are dropped. */
export function cleanCustomerScreen(input: unknown): { ok: true; value: CustomerScreenSlides } | { ok: false; error: string } {
  const o = (input && typeof input === 'object' ? input : {}) as { slides?: unknown; seconds?: unknown };
  if (!Array.isArray(o.slides)) return { ok: false, error: 'Send the images as a list.' };
  if (o.slides.length > MAX_SLIDES) return { ok: false, error: `Up to ${MAX_SLIDES} images.` };
  const slides: Slide[] = [];
  for (let i = 0; i < o.slides.length; i++) {
    const s = o.slides[i] as { url?: unknown } | string;
    const url = typeof s === 'string' ? s : s?.url;
    if (!slideUrlOk(url)) return { ok: false, error: `Image ${i + 1} is not an uploaded JPEG, PNG or WebP image.` };
    if (!slides.some((x) => x.url === url)) slides.push({ url });
  }
  const seconds = o.seconds === undefined || o.seconds === null ? SLIDE_SECONDS_DEFAULT : intIn(o.seconds, SLIDE_SECONDS_MIN, SLIDE_SECONDS_MAX);
  if (seconds === null) return { ok: false, error: `Each image shows for ${SLIDE_SECONDS_MIN} to ${SLIDE_SECONDS_MAX} seconds.` };
  return { ok: true, value: { slides, seconds } };
}

/** What a POS was sent (or stored) → the list it may show: bad entries dropped, never more than MAX_SLIDES. null = none. */
export function slidesFromWire(v: unknown): CustomerScreenSlides | null {
  let o = v;
  if (typeof o === 'string') { try { o = JSON.parse(o); } catch { return null; } }
  if (!o || typeof o !== 'object' || !Array.isArray((o as any).slides)) return null;
  const slides: Slide[] = [];
  for (const s of (o as any).slides as unknown[]) {
    const url = typeof s === 'string' ? s : (s as any)?.url;
    if (slideUrlOk(url) && !slides.some((x) => x.url === url) && slides.length < MAX_SLIDES) slides.push({ url });
  }
  const seconds = intIn((o as any).seconds, SLIDE_SECONDS_MIN, SLIDE_SECONDS_MAX) ?? SLIDE_SECONDS_DEFAULT;
  return { slides, seconds };
}

/** A file the owner picked → why it cannot be uploaded, or null. */
export function slideFileError(f: { type?: string; size?: number } | null | undefined): string | null {
  if (!f) return 'Choose an image.';
  if (!SLIDE_TYPES.includes(String(f.type ?? '').toLowerCase())) return 'Use a JPEG, PNG or WebP image.';
  if (!(Number(f.size) > 0)) return 'That file is empty.';
  if (Number(f.size) > MAX_SLIDE_BYTES) return `Each image may be up to ${MAX_SLIDE_BYTES / (1024 * 1024)} MB.`;
  return null;
}

/** Who may save the list: the OWNER signed in as themselves, with the online licence. Emptying it needs no licence. */
export function customerScreenWriteError(who: { owner: boolean; licensed: boolean }, emptying: boolean):
  { status: 403; error: string; code: string } | null {
  if (!who.owner) return { status: 403, error: 'Only the owner chooses the customer screen images.', code: 'OWNER_ONLY' };
  if (!emptying && !who.licensed) {
    return { status: 403, error: 'The customer screen slideshow is part of the online licence — ask ZapTill to turn it on.', code: 'ONLINE_LICENCE' };
  }
  return null;
}

// ── What the customer's screen shows ────────────────────────────────────────────────────────────────────────────────

export type DisplayStage = 'idle' | 'sale' | 'payment' | 'thanks';
export const DISPLAY_STAGES: readonly DisplayStage[] = ['idle', 'sale', 'payment', 'thanks'];
export type DisplayMode = 'restaurant' | 'cafe' | 'retail' | 'minimart' | 'parking' | 'petrol_station' | 'other';
const MODES: readonly DisplayMode[] = ['restaurant', 'cafe', 'retail', 'minimart', 'parking', 'petrol_station', 'other'];
export type DisplayMethod = 'cash' | 'mpesa' | 'card' | 'other';

export interface DisplayLine {
  name: string;
  /** The chosen options as the receipt prints them ("Large, extra cheese"), or null. */
  detail: string | null;
  qty: number;
  /** 'L' a fuel line (litres), 'kg' / 'g' a weighed line, null a count. */
  unit: 'L' | 'kg' | 'g' | null;
  unitPrice: number;
  lineTotal: number;
  /** What an offer took off this line (0 = none). */
  discount: number;
}

export interface DisplayState {
  stage: DisplayStage;
  mode: DisplayMode;
  currency: string;
  lines: DisplayLine[];
  subtotal: number;
  /** Everything taken off: the offers' and a discount given at payment. */
  discount: number;
  total: number;
  amountDue: number;
  /** Cash handed over (the cash legs' tendered amounts); 0 for other methods. */
  paid: number;
  change: number;
  method: DisplayMethod | null;
  /** A restaurant's table on the bill being charged, else null. */
  table: string | null;
  /** When this stage began (ms since the epoch) — "Thank you" leaves after THANKS_MS. */
  since: number;
}

export const MAX_DISPLAY_LINES = 80;

const money = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round((Math.abs(n) + Number.EPSILON) * 100) / 100 : 0;
};
const qty3 = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 1000) / 1000 : 0;
};
const text = (v: unknown, max: number): string => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

export function idleState(mode: DisplayMode = 'other', currency = 'KES', since = 0): DisplayState {
  return { stage: 'idle', mode, currency, lines: [], subtotal: 0, discount: 0, total: 0, amountDue: 0, paid: 0, change: 0, method: null, table: null, since };
}

/**
 * Anything the POS hands over → exactly the fields the customer may see. A whitelist: every other field (a cost price, a
 * cashier, a PIN, a customer's name, the order's notes) is dropped because it is never copied. Idle carries no sale;
 * "Thank you" carries the totals and the change, never the lines.
 */
export function sanitiseDisplayState(raw: unknown): DisplayState {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const stage: DisplayStage = DISPLAY_STAGES.includes(r.stage as DisplayStage) ? (r.stage as DisplayStage) : 'idle';
  const mode: DisplayMode = MODES.includes(r.mode as DisplayMode) ? (r.mode as DisplayMode) : 'other';
  const currency = typeof r.currency === 'string' && /^[A-Z]{3}$/.test(r.currency) ? r.currency : 'KES';
  const since = Number.isFinite(Number(r.since)) && Number(r.since) > 0 ? Math.floor(Number(r.since)) : 0;
  if (stage === 'idle') return idleState(mode, currency, since);
  const lines: DisplayLine[] = stage === 'thanks' ? [] : (Array.isArray(r.lines) ? r.lines : []).slice(-MAX_DISPLAY_LINES).map((x) => {
    const l = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
    const unit = l.unit === 'L' || l.unit === 'kg' || l.unit === 'g' ? l.unit : null;
    const detail = text(l.detail, 80);
    return { name: text(l.name, 60) || 'Item', detail: detail || null, qty: qty3(l.qty), unit,
      unitPrice: money(l.unitPrice), lineTotal: money(l.lineTotal), discount: money(l.discount) };
  });
  const method: DisplayMethod | null = ['cash', 'mpesa', 'card', 'other'].includes(r.method as string) ? (r.method as DisplayMethod) : null;
  const table = (mode === 'restaurant' || mode === 'cafe') ? (text(r.table, 12) || null) : null;
  return {
    stage, mode, currency, lines,
    subtotal: money(r.subtotal), discount: money(r.discount), total: money(r.total), amountDue: money(r.amountDue),
    paid: stage === 'sale' ? 0 : money(r.paid), change: stage === 'sale' ? 0 : money(r.change),
    method: stage === 'sale' ? null : method, table, since,
  };
}

/** The stage the customer sees now: "Thank you" goes back to idle after THANKS_MS (no sale is left on the screen). */
export function shownStage(s: Pick<DisplayState, 'stage' | 'since'>, now: number): DisplayStage {
  if (s.stage === 'thanks' && s.since > 0 && now - s.since >= THANKS_MS) return 'idle';
  return s.stage;
}

/** A payment method code → how the customer's screen groups it (a custom method is 'other'). */
export function displayMethod(code: unknown): DisplayMethod | null {
  const c = String(code ?? '').toLowerCase();
  if (!c) return null;
  return c === 'cash' || c === 'mpesa' || c === 'card' ? c : 'other';
}

// ── The words, by business type ─────────────────────────────────────────────────────────────────────────────────────

export interface DisplayWords {
  /** Over the list: "Your order" (food), "Your purchase" (petrol), "Your items". */
  heading: string;
  /** The idle line under the business name. */
  welcome: string;
  /** Shown when the list is empty during a sale. */
  empty: string;
  thanks: string;
}

export function displayWords(mode: DisplayMode): DisplayWords {
  if (mode === 'restaurant' || mode === 'cafe') {
    return { heading: 'Your order', welcome: 'Welcome', empty: 'Your order will show here.', thanks: 'Thank you — enjoy your meal' };
  }
  if (mode === 'petrol_station') {
    return { heading: 'Your purchase', welcome: 'Welcome', empty: 'Your fuel and items will show here.', thanks: 'Thank you — drive safely' };
  }
  if (mode === 'parking') {
    return { heading: 'Your parking', welcome: 'Welcome', empty: 'Your parking fee will show here.', thanks: 'Thank you — drive safely' };
  }
  return { heading: 'Your items', welcome: 'Welcome', empty: 'Your items will show here.', thanks: 'Thank you for shopping with us' };
}

const fmtN = (n: number, dp: number) => n.toLocaleString('en-KE', { minimumFractionDigits: dp, maximumFractionDigits: dp });

/** The quantity line under an item: "2 × 150.00", fuel "24.390 L × 184.50 per litre", weighed "0.452 kg × 650.00 per kg". */
export function lineQuantityText(l: Pick<DisplayLine, 'qty' | 'unit' | 'unitPrice'>): string {
  if (l.unit === 'L') return `${fmtN(l.qty, 3)} L × ${fmtN(l.unitPrice, 2)} per litre`;
  if (l.unit === 'kg') return `${fmtN(l.qty, 3)} kg × ${fmtN(l.unitPrice, 2)} per kg`;
  if (l.unit === 'g') return `${fmtN(Math.round(l.qty * 1000), 0)} g × ${fmtN(l.unitPrice, 2)} per kg`;
  return `${fmtN(l.qty, Number.isInteger(l.qty) ? 0 : 3)} × ${fmtN(l.unitPrice, 2)}`;
}

// ── Premium content: what the customer's screen may wear ───────────────────────────────────────────────────────────

export interface DisplayMpesa { kind: 'buy_goods' | 'paybill'; number: string; account: string | null }

export interface DisplayContentInput {
  businessName: string | null;
  /** The effective theme id: non-null only while the business's 'themes' flag is on (A325). */
  themeId: string | null;
  logo: string | null;
  primaryHex: string | null;
  secondaryHex: string | null;
  accentHex: string | null;
  /** The online licence (web_pos_enabled). */
  licensed: boolean;
  slides: CustomerScreenSlides | null;
  mpesa: DisplayMpesa | null;
}

export interface DisplayContent {
  businessName: string;
  /** Brand colours and the logo: only while themes are on. */
  brand: { themeId: string; logo: string | null; primaryHex: string | null; secondaryHex: string | null; accentHex: string | null } | null;
  /** The slideshow and the M-Pesa details: only with the online licence. */
  slides: Slide[];
  seconds: number;
  mpesa: DisplayMpesa | null;
}

const RASTER = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
const hexOrNull = (v: unknown): string | null => (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : null);

/** The premium gate, in one place: brand colours and logo follow themes; the slideshow and M-Pesa follow the licence. */
export function gateDisplayContent(i: DisplayContentInput): DisplayContent {
  const themesOn = typeof i.themeId === 'string' && i.themeId !== '';
  const m = i.mpesa;
  const mpesa = i.licensed && m && /^\d{5,8}$/.test(m.number) && (m.kind === 'buy_goods' || m.kind === 'paybill')
    ? { kind: m.kind, number: m.number, account: m.kind === 'paybill' ? (text(m.account, 20) || null) : null } : null;
  return {
    businessName: text(i.businessName, 80) || 'Welcome',
    brand: themesOn ? {
      themeId: i.themeId as string,
      logo: typeof i.logo === 'string' && i.logo.length < 400_000 && RASTER.test(i.logo) ? i.logo : null,
      primaryHex: hexOrNull(i.primaryHex), secondaryHex: hexOrNull(i.secondaryHex), accentHex: hexOrNull(i.accentHex),
    } : null,
    slides: i.licensed ? (i.slides?.slides ?? []).filter((s) => slideUrlOk(s.url) || /^data:image\//.test(s.url)).slice(0, MAX_SLIDES) : [],
    seconds: i.slides?.seconds ?? SLIDE_SECONDS_DEFAULT,
    mpesa,
  };
}

/** The receipt's M-Pesa line (A450 / A492: "Paybill" + "4098201, Account 1234") → the details the screen shows large. */
export function mpesaFromReceiptLine(label: unknown, number: unknown): DisplayMpesa | null {
  const raw = String(number ?? '').trim();
  const m = /^(\d{5,8})(?:\s*,\s*Account\s+(.+))?$/i.exec(raw);
  if (!m) return null;
  const paybill = /pay\s*bill/i.test(String(label ?? ''));
  return paybill ? { kind: 'paybill', number: m[1], account: text(m[2], 20) || null } : { kind: 'buy_goods', number: m[1], account: null };
}

// ── Choosing the screen (the desktop) ──────────────────────────────────────────────────────────────────────────────

export interface ScreenInfo { id: number; x: number; y: number; width: number; height: number; primary: boolean }
export interface NumberedScreen extends ScreenInfo { n: number }
export interface DisplayChoice { enabled: boolean; displayId: number | null }

/** The PC's screens numbered as Windows lays them out: left to right, then top to bottom; 1-based. */
export function numberScreens(screens: ScreenInfo[]): NumberedScreen[] {
  return [...screens].sort((a, b) => a.x - b.x || a.y - b.y || a.id - b.id).map((s, i) => ({ ...s, n: i + 1 }));
}

/** A stored choice → a clean one (off when unreadable). */
export function cleanDisplayChoice(v: unknown): DisplayChoice {
  const o = (v && typeof v === 'object' ? v : {}) as { enabled?: unknown; displayId?: unknown };
  const id = Number(o.displayId);
  return { enabled: o.enabled === true, displayId: Number.isFinite(id) && o.displayId !== null && o.displayId !== '' ? id : null };
}

/**
 * Where the customer screen goes: the chosen screen while it is connected and is not the cashier's (primary) screen;
 * otherwise nowhere, with the one line the Tech page shows. Off → nowhere, no note.
 */
export function pickScreen(screens: ScreenInfo[], choice: DisplayChoice): { screen: NumberedScreen | null; note: string | null } {
  if (!choice.enabled) return { screen: null, note: null };
  const all = numberScreens(screens);
  const chosen = choice.displayId === null ? null : all.find((s) => s.id === choice.displayId) ?? null;
  if (!chosen) {
    return { screen: null, note: all.length < 2
      ? 'The customer screen is on, but only one screen is connected — it stays off until the second screen is plugged in.'
      : 'The customer screen chosen is not connected — choose a screen again.' };
  }
  if (chosen.primary) return { screen: null, note: 'The customer screen cannot be the cashier\'s own screen — choose the other screen.' };
  return { screen: chosen, note: null };
}
