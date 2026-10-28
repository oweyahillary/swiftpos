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

// ── A597: the owner's brand colours — ANY colour ───────────────────────────────────────────────────────────────
// Owner, 2026-10-27: the business owner picks a PRIMARY and a SECONDARY colour on Branding, and any colour is accepted —
// never refused for legibility. Instead every job gets the NEAREST shade of that colour that reads there: the colour
// itself when it already does, otherwise mixed toward white (lighter jobs) or black (darker jobs) in 2 % steps until it
// does — pure white / black at the end, which always does. So white, black, yellow and mid-grey all work, in light and
// dark mode. Premium (the business's `themes` flag); the apps apply them only while the effective theme is not null.
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
/** `hex` mixed with `to` by t (0 = hex itself, 1 = to). */
export function mixHex(hex: Hex, to: Hex, t: number): Hex {
  const a = rgb(hex), b = rgb(to);
  return '#' + a.map((x, i) => Math.round(x * (1 - t) + b[i] * t).toString(16).padStart(2, '0')).join('');
}
/** The nearest shade of `hex` toward `to` ('#ffffff' lighter, '#000000' darker) with at least `min` contrast against
 *  EVERY colour in `against`. Never fails: the last step is `to` itself. */
export function shadeFor(hex: Hex, to: Hex, against: Hex[], min: number): Hex {
  for (let i = 0; i <= 50; i++) { const c = mixHex(hex, to, i / 50); if (minContrast(c, against) >= min) return c; }
  return to;
}

export interface BrandTokens {
  base: Hex;                          // the colour as chosen
  on: Hex;                            // black or white, whichever reads on `base` (a chip, a swatch)
  fill: Hex; fillHover: Hex;          // fills with DARK labels (the dashboard's bg-swift / action 500, the POS's 500)
  strong: Hex; strongHover: Hex;      // fills with WHITE labels (bg-swift-strong / action 600, the POS's 600 / 700)
  textDark: Hex; textDarkHover: Hex;  // links and active labels on the dark screens
  textLight: Hex; textLightHover: Hex; // links and active labels on the light dashboard
  layer: Hex; onLayer: Hex;           // seen on the POS's dark screens (3:1): the brand strip, the lock screen
  tint: Hex;                          // the POS sidebar tint (its text stays 7:1)
  chartDark: Hex; chartLight: Hex;    // a chart series on the dark / light card (3:1)
}
/** Every job's shade of a brand colour, or null when it is not a #rrggbb colour. PURE. */
export function brandTokens(hex: unknown): BrandTokens | null {
  const base = cleanBrandHex(hex);
  if (!base) return null;
  const W = '#ffffff', K = '#000000';
  // A fill must also stand out from the page it sits on (BRAND_EDGE): a white fill would vanish on the light dashboard and
  // a black one on the dark screens. The second step only ever moves a little and keeps its label far above 4.5.
  const fill = shadeFor(shadeFor(base, W, BRAND_SURFACES.darkLabels, RULES.text), K, BRAND_SURFACES.lightText.slice(0, 1), BRAND_EDGE);
  const strong = shadeFor(shadeFor(base, K, [W], RULES.text), W, BRAND_SURFACES.darkText, BRAND_EDGE);
  const textDark = shadeFor(base, W, BRAND_SURFACES.darkText, RULES.text);
  const textLight = shadeFor(base, K, BRAND_SURFACES.lightText, RULES.text);
  const layer = shadeFor(base, W, SURFACES.darkPanels, RULES.brandVisible);
  return {
    base, on: labelOn(base),
    fill, fillHover: mixHex(fill, W, 0.2),            // lighter: the dark label reads better still
    strong, strongHover: mixHex(strong, K, 0.2),      // darker: the white label reads better still
    textDark, textDarkHover: mixHex(textDark, W, 0.3),
    textLight, textLightHover: mixHex(textLight, K, 0.3),
    layer, onLayer: labelOn(layer), tint: sidebarTint(layer),
    chartDark: shadeFor(base, W, BRAND_SURFACES.chartDark, RULES.fill),
    chartLight: shadeFor(base, K, BRAND_SURFACES.chartLight, RULES.fill),
  };
}
/** The status colour (paid / warning / void) a brand colour is close enough to be mistaken for, or null. Advice only —
 *  the Branding page says so; the colour is never refused. */
export function brandNearStatus(hex: unknown): 'paid' | 'warning' | 'void' | null {
  const base = cleanBrandHex(hex);
  if (!base) return null;
  for (const [name, hs] of Object.entries(STATUS)) if (hs.some((h) => deltaE(base, h) < RULES.statusMin)) return name as 'paid' | 'warning' | 'void';
  return null;
}
