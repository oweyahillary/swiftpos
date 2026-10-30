/**
 * themes.ts — the curated ACTION themes and the BRAND-colour rule for client branding Phase 2 (A323/A324).
 *
 *  Byte-identical copies live at:
 *      shared/themes.ts                      (canonical)
 *      apps/desktop/src/shared/themes.ts     (the till)
 *      apps/dashboard/src/lib/themes.ts      (the web)
 *  scripts/check-shared-sync.mjs fails CI if they diverge. The cloud's copy joins when it validates theme ids.
 *
 *  Self-contained on purpose (no imports), so every app, the cloud and plain-Node tests load the same file.
 *
 *  TWO LAYERS (owner-approved proposal, docs/PROPOSAL-A295-phase2-themes.html):
 *   • BRAND colour — the business's own (the Phase 1 lock-screen accent). Lock screen, logo ring, sidebar tint, a
 *     brand strip. Never on anything clickable or any status, so the only rule is that it can be SEEN on the till's
 *     dark screens (3:1). Any hue is welcome here — yellow, red, green, amber included.
 *   • ACTION colour — one of THEMES below. Buttons, selected states, links. Every check applies, including that it
 *     can never be mistaken for the paid (green), warning (amber) or void (red) status colours.
 *
 *  A theme is ONE colour family with a FIXED shade per job — found by testing every family against the real
 *  surfaces; the same shade number worked for all of them:
 *     500  buttons / selected on the till (dark)     400  links / active labels on the till
 *     600  buttons on the light dashboard            700  links / active tabs on the light dashboard
 *     pressed = one shade darker                     950  optional sidebar tint
 *
 *  Adding or changing a theme: tests/themes-registry.test.mjs runs every check on every entry. A theme whose
 *  status difference is between STATUS_MIN and STATUS_CLEAR ships only after a real-till check (tillCheck: true).
 */

export type Hex = string;
export type Shade = 400 | 500 | 600 | 700 | 800 | 950;
export type ThemeId = 'ocean' | 'violet' | 'lagoon' | 'orchid' | 'sky' | 'teal' | 'blossom';

export interface Theme {
  id: ThemeId;
  name: string;            // shown to the business; rename freely, the id is what is stored
  family: string;          // the Tailwind v3 colour family the shades come from
  shades: Record<Shade, Hex>;
  tillCheck: boolean;      // status difference 15–20: ship only after a real-till check under shop lighting
}

export const THEMES: readonly Theme[] = [
  { id: 'ocean',   name: 'Ocean',   family: 'blue',    tillCheck: false,
    shades: { 400: '#60a5fa', 500: '#3b82f6', 600: '#2563eb', 700: '#1d4ed8', 800: '#1e40af', 950: '#172554' } },
  { id: 'violet',  name: 'Violet',  family: 'violet',  tillCheck: false,
    shades: { 400: '#a78bfa', 500: '#8b5cf6', 600: '#7c3aed', 700: '#6d28d9', 800: '#5b21b6', 950: '#2e1065' } },
  { id: 'lagoon',  name: 'Lagoon',  family: 'cyan',    tillCheck: false,
    shades: { 400: '#22d3ee', 500: '#06b6d4', 600: '#0891b2', 700: '#0e7490', 800: '#155e75', 950: '#083344' } },
  { id: 'orchid',  name: 'Orchid',  family: 'fuchsia', tillCheck: false,
    shades: { 400: '#e879f9', 500: '#d946ef', 600: '#c026d3', 700: '#a21caf', 800: '#86198f', 950: '#4a044e' } },
  { id: 'sky',     name: 'Sky',     family: 'sky',     tillCheck: false,
    shades: { 400: '#38bdf8', 500: '#0ea5e9', 600: '#0284c7', 700: '#0369a1', 800: '#075985', 950: '#082f49' } },
  { id: 'teal',    name: 'Teal',    family: 'teal',    tillCheck: true,
    shades: { 400: '#2dd4bf', 500: '#14b8a6', 600: '#0d9488', 700: '#0f766e', 800: '#115e59', 950: '#042f2e' } },
  { id: 'blossom', name: 'Blossom', family: 'pink',    tillCheck: true,
    shades: { 400: '#f472b6', 500: '#ec4899', 600: '#db2777', 700: '#be185d', 800: '#9d174d', 950: '#500724' } },
];

/** A business that turns themes on without choosing one gets Ocean. (With themes OFF, nothing changes — slice 3.) */
export const DEFAULT_THEME_ID: ThemeId = 'ocean';

// ── The real surfaces and status colours (Tailwind grays used by the till; the lock card; the light dashboard) ──
export const SURFACES = {
  darkPanels: ['#030712', '#111827', '#0d1424'] as Hex[],   // gray-950, gray-900, lock card — what a fill SITS ON
  textPanels: ['#111827', '#1f2937'] as Hex[],              // where links sit: gray-900, gray-800
  lightPanels: ['#ffffff', '#f9fafb'] as Hex[],
  sidebarText: '#d1d5db' as Hex,                            // gray-300
};
export const STATUS: Record<'paid' | 'warning' | 'void', Hex[]> = {
  paid: ['#22c55e', '#4ade80'], warning: ['#f59e0b', '#fbbf24'], void: ['#ef4444', '#f87171'],
};
export const RULES = {
  fill: 3,          // a fill against the panel it sits on (WCAG 1.4.11, non-text UI)
  text: 4.5,        // any text: labels on fills, links (WCAG 1.4.3)
  tintText: 7,      // sidebar text on the tint
  statusMin: 15,    // CIEDE2000 from every status colour, on both the 500 and 400 shades
  statusClear: 20,  // at or above: no till check needed
  pairMin: 10,      // between any two themes' 500 shades
  brandVisible: 3,  // a brand colour against the dark panels
};

// ── Colour maths (sRGB, WCAG 2.x contrast, CIE Lab D65, CIEDE2000, LCh hue) ──────────────────────────────────
const rgb = (h: Hex): number[] => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const lin = (c: number): number => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
export function luminance(h: Hex): number { const [r, g, b] = rgb(h).map(lin); return 0.2126 * r + 0.7152 * g + 0.0722 * b; }
export function contrast(a: Hex, b: Hex): number {
  const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
function lab(h: Hex): [number, number, number] {
  const [r, g, b] = rgb(h).map(lin);
  const X = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047, Y = r * 0.2126 + g * 0.7152 + b * 0.0722,
    Z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
}
export function deltaE(h1: Hex, h2: Hex): number {
  const [L1, a1, b1] = lab(h1), [L2, a2, b2] = lab(h2), rad = Math.PI / 180, deg = 180 / Math.PI;
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2), Cb = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1, a2p = (1 + G) * a2, C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
  const hh = (a: number, b: number) => { const x = Math.atan2(b, a) * deg; return x < 0 ? x + 360 : x; };
  const h1p = hh(a1p, b1), h2p = hh(a2p, b2), dL = L2 - L1, dC = C2p - C1p;
  let dh = h2p - h1p; if (C1p * C2p === 0) dh = 0; else if (dh > 180) dh -= 360; else if (dh < -180) dh += 360;
  const dH = 2 * Math.sqrt(C1p * C2p) * Math.sin((dh / 2) * rad), Lb = (L1 + L2) / 2, Cbp = (C1p + C2p) / 2;
  let hb = h1p + h2p;
  if (C1p * C2p !== 0) { hb = Math.abs(h1p - h2p) > 180 ? (h1p + h2p + 360) / 2 : (h1p + h2p) / 2; if (hb >= 360) hb -= 360; }
  const T = 1 - 0.17 * Math.cos((hb - 30) * rad) + 0.24 * Math.cos(2 * hb * rad) + 0.32 * Math.cos((3 * hb + 6) * rad)
    - 0.2 * Math.cos((4 * hb - 63) * rad);
  const dT = 30 * Math.exp(-(((hb - 275) / 25) ** 2)), RC = 2 * Math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7));
  const SL = 1 + (0.015 * (Lb - 50) ** 2) / Math.sqrt(20 + (Lb - 50) ** 2), SC = 1 + 0.045 * Cbp, SH = 1 + 0.015 * Cbp * T;
  const RT = -Math.sin(2 * dT * rad) * RC;
  return Math.sqrt((dL / SL) ** 2 + (dC / SC) ** 2 + (dH / SH) ** 2 + RT * (dC / SC) * (dH / SH));
}
export function hue(h: Hex): number { const [, a, b] = lab(h); const x = (Math.atan2(b, a) * 180) / Math.PI; return x < 0 ? x + 360 : x; }
/** Black or white — whichever reads better on the fill (the till's rule, as in contrast.ts). */
export function labelOn(fill: Hex): Hex { return contrast('#ffffff', fill) >= contrast('#000000', fill) ? '#ffffff' : '#000000'; }
const minContrast = (h: Hex, panels: Hex[]) => Math.min(...panels.map((p) => contrast(h, p)));
const HEX = /^#[0-9a-fA-F]{6}$/;

// ── Action themes ─────────────────────────────────────────────────────────────────────────────────────────────
/** A stored theme id → its theme. Unknown, empty or retired ids fall back to the default, never to nothing. */
export function resolveTheme(id: string | null | undefined): Theme {
  return THEMES.find((t) => t.id === id) ?? THEMES.find((t) => t.id === DEFAULT_THEME_ID)!;
}
export function isThemeId(id: unknown): id is ThemeId { return typeof id === 'string' && THEMES.some((t) => t.id === id); }

/** The colours each job uses, with the label colour each fill needs. What the apps turn into CSS variables. */
export function themeTokens(t: Theme) {
  const s = t.shades;
  return {
    fillDark: s[500], onFillDark: labelOn(s[500]), pressedDark: s[600], onPressedDark: labelOn(s[600]),
    textDark: s[400],
    fillLight: s[600], onFillLight: labelOn(s[600]), pressedLight: s[700], onPressedLight: labelOn(s[700]),
    textLight: s[700],
    tint: s[950],
  };
}

export interface ThemeCheck {
  fillDark: number; fillDarkLabel: number; textDark: number; fillLight: number; fillLightLabel: number;
  textLight: number; pressedDark: number; pressedLight: number; tintText: number;
  status: number; statusName: string; ok: boolean; needsTillCheck: boolean;
}
/** Every check a theme must pass — the proposal's table, as code. Also used on candidate colour families. */
export function checkTheme(shades: Record<Shade, Hex>): ThemeCheck {
  const c = {
    fillDark: minContrast(shades[500], SURFACES.darkPanels), fillDarkLabel: contrast(labelOn(shades[500]), shades[500]),
    textDark: minContrast(shades[400], SURFACES.textPanels),
    fillLight: minContrast(shades[600], SURFACES.lightPanels), fillLightLabel: contrast(labelOn(shades[600]), shades[600]),
    textLight: minContrast(shades[700], SURFACES.lightPanels),
    pressedDark: contrast(labelOn(shades[600]), shades[600]), pressedLight: contrast(labelOn(shades[700]), shades[700]),
    tintText: contrast(SURFACES.sidebarText, shades[950]),
  };
  let status = Infinity, statusName = '';
  for (const [name, hs] of Object.entries(STATUS)) for (const s of [500, 400] as const) for (const h of hs) {
    const d = deltaE(shades[s], h); if (d < status) { status = d; statusName = name; }
  }
  const ok = c.fillDark >= RULES.fill && c.fillDarkLabel >= RULES.text && c.textDark >= RULES.text
    && c.fillLight >= RULES.fill && c.fillLightLabel >= RULES.text && c.textLight >= RULES.text
    && c.pressedDark >= RULES.text && c.pressedLight >= RULES.text && c.tintText >= RULES.tintText
    && status >= RULES.statusMin;
  return { ...c, status, statusName, ok, needsTillCheck: ok && status < RULES.statusClear };
}

/** The action theme that sits best beside a brand colour: the complementary hue (yellow → Sky, red → Lagoon,
 *  green → Orchid). null for an invalid colour. */
export function suggestThemeFor(brand: Hex | null | undefined): ThemeId | null {
  if (!brand || !HEX.test(brand)) return null;
  const target = (hue(brand) + 180) % 360, gap = (x: number) => { const d = Math.abs(x - target) % 360; return d > 180 ? 360 - d : d; };
  return [...THEMES].sort((a, b) => gap(hue(a.shades[500])) - gap(hue(b.shades[500])))[0].id;
}

// ── Brand layer ───────────────────────────────────────────────────────────────────────────────────────────────
export interface BrandLayer { brand: Hex; onBrand: Hex; tint: Hex; visibility: number }
/** The business's own colour as the brand layer, or null when it cannot be used (invalid, or too dark to be seen on
 *  the till — then everything follows the action theme and the logo alone carries the brand). */
export function resolveBrandLayer(brand: Hex | null | undefined): BrandLayer | null {
  if (!brand || !HEX.test(brand)) return null;
  const visibility = minContrast(brand, SURFACES.darkPanels), onBrand = labelOn(brand);
  if (visibility < RULES.brandVisible || contrast(onBrand, brand) < RULES.text) return null;
  return { brand: brand.toUpperCase(), onBrand, tint: sidebarTint(brand), visibility };
}

/** Sidebar tint: as much of the colour as the sidebar text can bear (>= 7:1), mixed into the till's gray-950. */
export function sidebarTint(brand: Hex): Hex {
  const mixTo = (t: number) => '#' + rgb(brand).map((x, i) => Math.round(x * t + rgb('#030712')[i] * (1 - t))
    .toString(16).padStart(2, '0')).join('');
  let t = 0.28, tint = mixTo(t);
  while (contrast(SURFACES.sidebarText, tint) < RULES.tintText && t > 0.06) { t -= 0.02; tint = mixTo(t); }
  return tint;
}


// ── A597 / A605: the owner's brand colours — ANY colour, one palette ───────────────────────────────────────────────
// Owner, 2026-10-27: the business owner picks a PRIMARY and a SECONDARY colour on Branding, and any colour is accepted —
// never refused for legibility. Owner, 2026-10-28 (A605): "professional and clean, not just branding for the sake …
// match colors perfectly, give them a feel of their brand." So ONE palette engine, used the same way by the web dashboard,
// the web POS and the desktop POS:
//   • a tonal scale 50–950 of the colour in OKLCH (perceptual: even steps, the hue kept) whose base step IS the owner's
//     hex, exactly;
//   • every job (a button, a link, a focus ring, a selected row, a chart) takes the NEAREST shade on that scale that
//     reads there (WCAG 2.x: 4.5 for text and labels, 3 for rings, borders and chart marks) — the colour itself when it
//     already does. Very light colours (yellow, pastels) get a deep shade for text on white and dark ink on the colour;
//     very dark ones (navy, black) are lifted in dark mode so a button stands out from the page;
//   • the status colours (paid green, warning amber, void red) are never replaced: a button or link shade that would be
//     mistaken for one moves to a neighbouring shade (STATUS_GUARD), and the Branding page says so in plain words.
// Premium (the business's `themes` flag); the apps apply them only while the effective theme is not null.
// Precedence: brand colours set → they replace the curated theme's action shades; none → the curated theme as before.

/** Where each job's shade must read (WCAG 2.x: 4.5 for text and labels, 3 for a fill or a chart mark). */
export const BRAND_SURFACES = {
  darkLabels: ['#000000', '#030712', '#0f172a'] as Hex[],   // the dark labels on a fill: black, gray-950, its light-mode slate
  darkText: ['#030712', '#111827', '#1f2937'] as Hex[],     // where text sits on the dark screens: gray-950 / 900 / 800
  lightText: ['#ffffff', '#f8fafc', '#f1f5f9'] as Hex[],    // the light dashboard's surfaces
  chartDark: ['#111827'] as Hex[], chartLight: ['#ffffff'] as Hex[],   // the cards a chart is drawn on
};
/** How far a fill must stand out from the page under it (a button's edge; today's teal 500 on white is 2.5). */
export const BRAND_EDGE = 1.4;
/** '#RRGGBB' in any case (trimmed) → '#rrggbb'; anything else → null. The Branding page always sends six digits. */
export function cleanBrandHex(v: unknown): Hex | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(s) ? s : null;
}
/** `hex` mixed with `to` by t (0 = hex itself, 1 = to), in sRGB. Kept for callers; the palette below works in OKLCH. */
export function mixHex(hex: Hex, to: Hex, t: number): Hex {
  const a = rgb(hex), b = rgb(to);
  return '#' + a.map((x, i) => Math.round(x * (1 - t) + b[i] * t).toString(16).padStart(2, '0')).join('');
}
/** The nearest sRGB mix of `hex` toward `to` with at least `min` contrast against every colour in `against` (kept for
 *  callers; never fails: the last step is `to` itself). */
export function shadeFor(hex: Hex, to: Hex, against: Hex[], min: number): Hex {
  for (let i = 0; i <= 50; i++) { const c = mixHex(hex, to, i / 50); if (minContrast(c, against) >= min) return c; }
  return to;
}

// ── OKLab / OKLCH (Björn Ottosson's matrices), plain maths, no dependency ───────────────────────────────────────
const toLin = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGam = (c: number): number => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.max(0, c) ** (1 / 2.4) - 0.055);
/** sRGB hex → OKLab [L 0–1, a, b]. */
export function oklab(hex: Hex): [number, number, number] {
  const [r, g, b] = rgb(hex).map((x) => toLin(x / 255));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
function oklabToLinear(L: number, a: number, b: number): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3, m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3,
    s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
}
/** sRGB hex → OKLCH { L 0–1, C (chroma), H (hue, degrees) }. */
export function oklch(hex: Hex): { L: number; C: number; H: number } {
  const [L, a, b] = oklab(hex);
  const H = (Math.atan2(b, a) * 180) / Math.PI;
  return { L, C: Math.hypot(a, b), H: H < 0 ? H + 360 : H };
}
const inGamut = (c: number[]) => c.every((x) => x >= -1e-4 && x <= 1 + 1e-4);
/** OKLCH → the nearest sRGB hex of the SAME lightness and hue (chroma reduced until it fits the screen's colours). */
export function oklchHex(L: number, C: number, H: number): Hex {
  const Lc = Math.min(1, Math.max(0, L)), h = (H * Math.PI) / 180;
  const at = (c: number) => oklabToLinear(Lc, c * Math.cos(h), c * Math.sin(h));
  let lin = at(C);
  if (!inGamut(lin)) {
    let lo = 0, hi = C;
    for (let i = 0; i < 24; i++) { const mid = (lo + hi) / 2; if (inGamut(at(mid))) lo = mid; else hi = mid; }
    lin = at(lo);
  }
  return '#' + lin.map((x) => Math.round(Math.min(1, Math.max(0, toGam(x))) * 255).toString(16).padStart(2, '0')).join('');
}

// ── The tonal scale ─────────────────────────────────────────────────────────────────────────────────────────────
export const BRAND_STEPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950] as const;
export type BrandStep = typeof BRAND_STEPS[number];
/** The OKLCH lightness of each step on a typical scale (Tailwind-like spacing). The colour's own step is the nearest. */
export const BRAND_STEP_L: Record<BrandStep, number> = {
  50: 0.975, 100: 0.94, 200: 0.885, 300: 0.81, 400: 0.72, 500: 0.635, 600: 0.555, 700: 0.475, 800: 0.4, 900: 0.33, 950: 0.26,
};
interface Tone { hex: Hex; L: number; C: number; H: number }
function toneOf(hex: Hex): Tone { const o = oklch(hex); return { hex, ...o }; }
/**
 * The brand's colour at lightness L — the same hue, its chroma tapering toward white and toward black, so every shade
 * belongs to the colour. One exception, the one good palettes make: a yellow warms a little toward amber as it darkens
 * (a dark yellow reads as gold-brown, not olive). At the colour's own lightness: the colour itself, exactly.
 */
export function brandTone(t: Tone, L: number): Hex {
  if (Math.abs(L - t.L) < 1e-9) return t.hex;
  const Lc = Math.min(1, Math.max(0, L));
  // chroma follows the bell every colour family has (most colourful in the middle, none at white or black), scaled so
  // the colour's own lightness gives its own chroma — a navy's middle shades are blue, not grey (at most 2.5x)
  const C = t.C * Math.min(2.5, chromaBell(Lc) / Math.max(1e-6, chromaBell(t.L)));
  let H = t.H;
  if (Lc < t.L) {
    // yellows (OKLCH hue ~75–118) turn toward amber (~62°) as they darken; fades out at the edges of the band
    const u = (t.L - Lc) / Math.max(1e-6, t.L);
    const w = H < 75 || H > 118 ? 0 : Math.min(1, (H - 75) / 10, (118 - H) / 10);
    H = H + (62 - H) * w * Math.min(1, u * 1.4);
  }
  return oklchHex(Lc, C, H);
}
/** How colourful a family is at lightness L, relative to its most colourful shade (peak near L 0.62). */
function chromaBell(L: number): number { return Math.sin(Math.PI * Math.min(1, Math.max(0, L)) ** 1.45) ** 0.8; }
/** The colour's tonal scale, 50 (lightest) – 950 (darkest), in even perceptual steps; `baseStep` is the colour itself,
 *  exactly as chosen. null when it is not a #rrggbb colour. PURE. */
export function brandScale(hex: unknown): { steps: Record<BrandStep, Hex>; baseStep: BrandStep } | null {
  const base = cleanBrandHex(hex);
  if (!base) return null;
  const t = toneOf(base);
  let k: BrandStep = 500;
  for (const s of BRAND_STEPS) if (Math.abs(BRAND_STEP_L[s] - t.L) < Math.abs(BRAND_STEP_L[k] - t.L)) k = s;
  const top = BRAND_STEP_L[50], bottom = BRAND_STEP_L[950], Lk = BRAND_STEP_L[k];
  const steps = {} as Record<BrandStep, Hex>;
  for (const s of BRAND_STEPS) {
    const Ls = BRAND_STEP_L[s];
    // the steps either side of the colour are spread evenly between it and the ends of the scale
    const L = s === k ? t.L : Ls > Lk ? t.L + ((Ls - Lk) / (top - Lk)) * (Math.max(top, t.L) - t.L)
      : t.L - ((Lk - Ls) / (Lk - bottom)) * (t.L - Math.min(bottom, t.L));
    steps[s] = s === k ? base : brandTone(t, L);
  }
  return { steps, baseStep: k };
}

// ── The status colours a brand shade must never be mistaken for ──────────────────────────────────────────────────
/** Every shade the apps use for paid / warning / void (fills, text on dark, text on the light dashboard). */
export const STATUS_SHADES: Record<'paid' | 'warning' | 'void', Hex[]> = {
  paid: ['#22c55e', '#4ade80', '#16a34a', '#166534'],
  warning: ['#f59e0b', '#fbbf24', '#d97706', '#92400e'],
  void: ['#ef4444', '#f87171', '#dc2626', '#b91c1c'],
};
/** CIEDE2000 a button / link shade keeps from every status shade — "clearly a different colour side by side" (the status
 *  shades themselves are 7–10 apart within a family; a yellow-400 and an amber-400 are 5.1). */
export const STATUS_GUARD = 5;
const clearOfStatus = (h: Hex) => Object.values(STATUS_SHADES).every((hs) => hs.every((s) => deltaE(h, s) >= STATUS_GUARD));

// ── The palette: every job's shade, light and dark ──────────────────────────────────────────────────────────────
const W = '#ffffff', K = '#000000';
/** Readable text on a fill: white, or the brand's own dark ink (a near-black of its hue), whichever reads better —
 *  black when neither reaches 4.5 (one of black / white always does). */
function labelFor(fill: Hex, ink: Hex): Hex {
  const w = contrast(W, fill), k = contrast(ink, fill);
  if (w >= k) return w >= RULES.text ? W : K;
  return k >= RULES.text ? ink : K;
}
/** The nearest shade of the colour (either way along its scale, `prefer` first on a tie) that passes `ok`. */
function nearestTone(t: Tone, ok: (h: Hex) => boolean, prefer: 1 | -1, fromL = t.L): Hex | null {
  const first = brandTone(t, fromL);
  if (ok(first)) return first;
  for (let i = 1; i <= 200; i++) {
    for (const dir of [prefer, -prefer]) {
      const L = fromL + dir * i * 0.005;
      if (L < 0 || L > 1) continue;
      const h = brandTone(t, L);
      if (ok(h)) return h;
    }
  }
  return null;
}
/** With the status guard if at all possible (and the reason recorded), else without it, else black / white. */
function guardedTone(t: Tone, ok: (h: Hex) => boolean, prefer: 1 | -1, moved: { status: boolean }): Hex {
  const plain = nearestTone(t, ok, prefer);
  const guarded = nearestTone(t, (h) => ok(h) && clearOfStatus(h), prefer);
  if (guarded) { if (guarded !== plain) moved.status = true; return guarded; }
  return plain ?? (prefer > 0 ? W : K);
}

export interface BrandModeTokens {
  /** the key action: primary buttons, the POS pay button, the active menu marker, progress, selected fills */
  primary: Hex; onPrimary: Hex; primaryHover: Hex; primaryPressed: Hex;
  /** links, the active menu label, selected text — 4.5 on every page surface of the mode and on `subtle` */
  text: Hex; textHover: Hex;
  /** focus ring and the border of a selected card — 3:1 on the page */
  ring: Hex;
  /** the background of a selected row / the active menu item (very light in light mode, a deep tint in dark) */
  subtle: Hex;
  /** the sidebar's very faint brand tint (its text stays readable) */
  tint: Hex;
  /** a chart series, 3:1 on the card */
  chart: Hex;
}
export interface BrandPalette {
  base: Hex;                         // the colour exactly as chosen
  scale: Record<BrandStep, Hex>; baseStep: BrandStep;
  on: Hex;                           // readable text on the colour itself (the identity band, a swatch)
  ink: Hex;                          // the brand's dark ink (labels on light fills)
  light: BrandModeTokens; dark: BrandModeTokens;
  layer: Hex; onLayer: Hex; tint: Hex;   // the POS's dark screens: strip, lock screen (3:1), sidebar tint (7:1)
  name: string;                      // the colour in plain words ("yellow", "navy")
  nearStatus: 'paid' | 'warning' | 'void' | null;
  /** what had to move, for the plain-words note on the Branding page */
  adjusted: { lightText: boolean; darkLift: boolean; status: boolean };
}
const SIDEBAR_TEXT = { light: '#4f5d73', dark: '#9ca3af' };   // the menu's own grey text (index.css gray-400 by mode; A609, 2026-10-29: light #64748b → #4f5d73)

function modeTokens(t: Tone, ink: Hex, mode: 'light' | 'dark', moved: { status: boolean }): BrandModeTokens {
  const S = mode === 'light' ? BRAND_SURFACES.lightText : BRAND_SURFACES.darkText;
  const edge = mode === 'light' ? ['#ffffff', '#f8fafc'] : ['#111827', '#030712'];
  const away: 1 | -1 = mode === 'light' ? -1 : 1;   // the direction that stands out from the page
  const primary = guardedTone(t, (h) => contrast(labelFor(h, ink), h) >= RULES.text && minContrast(h, edge) >= BRAND_EDGE, away, moved);
  const onPrimary = labelFor(primary, ink);
  // hover / pressed: a touch darker (the usual), or lighter when darker would weaken the label
  const Lp = oklch(primary).L;
  const at = (dir: number, d: number) => brandTone(t, Math.min(1, Math.max(0, Lp + dir * d)));
  const reads = (h: Hex) => h !== primary && contrast(onPrimary, h) >= RULES.text;
  const dir = reads(at(-1, 0.04)) || !reads(at(1, 0.04)) ? -1 : 1;
  const pressStep = (d: number) => { const h = at(dir, d); return contrast(onPrimary, h) >= RULES.text ? h : primary; };
  const subtle = mode === 'light' ? oklchHex(0.965, Math.min(t.C, 0.035), t.H) : oklchHex(0.28, Math.min(t.C, 0.06), t.H);
  const text = guardedTone(t, (h) => minContrast(h, [...S, subtle]) >= RULES.text, away, moved);
  const Lt = oklch(text).L;
  const textHover = brandTone(t, Math.min(1, Math.max(0, Lt + away * 0.07)));
  const ring = nearestTone(t, (h) => minContrast(h, S) >= RULES.fill, away) ?? (away > 0 ? W : K);
  const chart = nearestTone(t, (h) => contrast(h, mode === 'light' ? '#ffffff' : '#111827') >= RULES.fill, away) ?? (away > 0 ? W : K);
  const tintL = mode === 'light' ? 0.985 : 0.235, sideText = SIDEBAR_TEXT[mode];
  let tint = oklchHex(tintL, Math.min(t.C, mode === 'light' ? 0.012 : 0.025), t.H);
  if (contrast(sideText, tint) < RULES.text) tint = mode === 'light' ? '#ffffff' : '#111827';
  return { primary, onPrimary, primaryHover: pressStep(0.04), primaryPressed: pressStep(0.08), text, textHover, ring, subtle, tint, chart };
}

/** The colour in plain words, for the Branding page's notes ("yellow", "navy", "grey"). */
export function colourName(hex: unknown): string {
  const h = cleanBrandHex(hex);
  if (!h) return 'colour';
  const { L, C, H } = oklch(h);
  if (C < 0.035) return L > 0.93 ? 'white' : L < 0.22 ? 'black' : 'grey';
  const fam = H < 12 || H >= 345 ? 'pink' : H < 40 ? 'red' : H < 75 ? 'orange' : H < 118 ? 'yellow' : H < 170 ? 'green'
    : H < 200 ? 'teal' : H < 268 ? 'blue' : H < 310 ? 'purple' : 'pink';
  if (L < 0.42) return fam === 'blue' ? 'navy' : fam === 'red' || fam === 'pink' ? 'maroon' : fam === 'orange' || fam === 'yellow' ? 'brown' : `dark ${fam}`;
  return fam;
}

/** Every job's shade of a brand colour — the tonal scale and each mode's tokens — or null when it is not a #rrggbb
 *  colour. PURE, and the same in every app (5 byte-identical copies). */
export function brandPalette(hex: unknown): BrandPalette | null {
  const base = cleanBrandHex(hex);
  if (!base) return null;
  const t = toneOf(base), sc = brandScale(base)!;
  const ink = brandTone(t, Math.min(t.L, 0.23));
  const moved = { status: false };
  const light = modeTokens(t, ink, 'light', moved), dark = modeTokens(t, ink, 'dark', moved);
  const layer = nearestTone(t, (h) => minContrast(h, SURFACES.darkPanels) >= RULES.brandVisible, 1) ?? W;
  return {
    base, scale: sc.steps, baseStep: sc.baseStep, on: labelFor(base, ink), ink, light, dark,
    layer, onLayer: labelFor(layer, ink), tint: sidebarTint(layer), name: colourName(base), nearStatus: brandNearStatus(base),
    adjusted: { lightText: light.text !== base && contrast(base, W) < 2, darkLift: dark.primary !== base && minContrast(base, ['#111827']) < BRAND_EDGE,
      status: moved.status },
  };
}

const STATUS_WORDS = { paid: ['the green that means paid', 'Paid'], warning: ['the amber of warnings', 'Warning'], void: ['the red of voids', 'Void'] } as const;
/** What the Branding page says about a colour — only when it matters, in plain words. [] = nothing to say. PURE. */
export function brandNotes(hex: unknown): string[] {
  const p = brandPalette(hex);
  if (!p) return [];
  const out: string[] = [];
  const inkName = colourName(p.ink), dark = inkName === 'black' || inkName.startsWith('dark ') ? inkName : `dark ${inkName}`;
  if (p.adjusted.lightText) {
    out.push(`Your ${p.name} is very light, so text on it is shown in ${p.on === p.ink ? dark : 'black'}, and links on white pages use a deeper ${p.name} to stay readable.`);
  }
  if (p.adjusted.darkLift) out.push(`Your ${p.name} is very dark, so in dark mode buttons use a lighter ${p.name} to stand out from the background.`);
  if (p.nearStatus) {
    const [what, label] = STATUS_WORDS[p.nearStatus];
    out.push(p.adjusted.status
      ? `Your ${p.name} is close to ${what}, so buttons and links use a slightly different shade of it to keep “${label}” easy to tell apart.`
      : `Your ${p.name} is close to ${what}. Fine to use; staff may take a button for that status at a glance.`);
  }
  return out;
}

export interface BrandTokens {
  base: Hex;                          // the colour as chosen
  on: Hex;                            // readable text on `base` (a chip, a swatch)
  fill: Hex; fillHover: Hex;          // fills with DARK labels (the curated themes' 500 job)
  strong: Hex; strongHover: Hex;      // fills with WHITE labels (the curated themes' 600 / 700 job)
  textDark: Hex; textDarkHover: Hex;  // links and active labels on the dark screens
  textLight: Hex; textLightHover: Hex; // links and active labels on the light dashboard
  layer: Hex; onLayer: Hex;           // seen on the POS's dark screens (3:1): the brand strip, the lock screen
  tint: Hex;                          // the POS sidebar tint (its text stays 7:1)
  chartDark: Hex; chartLight: Hex;    // a chart series on the dark / light card (3:1)
}
/** A597's jobs by label colour, now shades on the palette's scale (OKLCH, the hue kept). Kept for the callers that
 *  still pick a shade by its label; the apps' brand layer uses brandPalette. null when not a #rrggbb colour. PURE. */
export function brandTokens(hex: unknown): BrandTokens | null {
  const p = brandPalette(hex);
  if (!p) return null;
  const t = toneOf(p.base);
  // A fill must also stand out from the page it sits on (BRAND_EDGE): a white fill would vanish on the light dashboard
  // and a black one on the dark screens.
  const fill = nearestTone(t, (h) => minContrast(h, BRAND_SURFACES.darkLabels) >= RULES.text && contrast(h, W) >= BRAND_EDGE, 1) ?? '#d4d4d4';
  const strong = nearestTone(t, (h) => contrast(W, h) >= RULES.text && minContrast(h, BRAND_SURFACES.darkText) >= BRAND_EDGE, -1) ?? '#525252';
  const step = (h: Hex, d: number, keep: (x: Hex) => boolean) => { const x = brandTone(t, Math.min(1, Math.max(0, oklch(h).L + d))); return keep(x) ? x : h; };
  const textDark = nearestTone(t, (h) => minContrast(h, BRAND_SURFACES.darkText) >= RULES.text, 1) ?? W;
  const textLight = nearestTone(t, (h) => minContrast(h, BRAND_SURFACES.lightText) >= RULES.text, -1) ?? K;
  return {
    base: p.base, on: p.on,
    fill, fillHover: step(fill, 0.05, (x) => minContrast(x, BRAND_SURFACES.darkLabels) >= RULES.text),
    strong, strongHover: step(strong, -0.05, (x) => contrast(W, x) >= RULES.text),
    textDark, textDarkHover: step(textDark, 0.07, (x) => minContrast(x, BRAND_SURFACES.darkText) >= RULES.text),
    textLight, textLightHover: step(textLight, -0.07, (x) => minContrast(x, BRAND_SURFACES.lightText) >= RULES.text),
    layer: p.layer, onLayer: p.onLayer, tint: p.tint,
    chartDark: p.dark.chart, chartLight: p.light.chart,
  };
}
/** The status colour (paid / warning / void) a brand colour is close enough to be mistaken for, or null. Advice — the
 *  Branding page says so; the colour is never refused (buttons and links keep STATUS_GUARD from it, brandPalette). */
export function brandNearStatus(hex: unknown): 'paid' | 'warning' | 'void' | null {
  const base = cleanBrandHex(hex);
  if (!base) return null;
  for (const [name, hs] of Object.entries(STATUS)) if (hs.some((h) => deltaE(base, h) < RULES.statusMin)) return name as 'paid' | 'warning' | 'void';
  return null;
}
