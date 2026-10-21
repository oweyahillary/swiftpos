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
  // Sidebar tint: as much of the brand as the sidebar text can bear (>= 7:1), mixed into the till's gray-950.
  const mixTo = (t: number) => '#' + rgb(brand).map((x, i) => Math.round(x * t + rgb('#030712')[i] * (1 - t))
    .toString(16).padStart(2, '0')).join('');
  let t = 0.28, tint = mixTo(t);
  while (contrast(SURFACES.sidebarText, tint) < RULES.tintText && t > 0.06) { t -= 0.02; tint = mixTo(t); }
  return { brand: brand.toUpperCase(), onBrand, tint, visibility };
}
