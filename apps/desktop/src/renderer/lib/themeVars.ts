/**
 * themeVars.ts — A326 (client branding Phase 2, slice 3): turn a business's theme + brand colour into the CSS
 * variables behind the till's `action-*` / `brand-*` / `on-brand` Tailwind colours (tailwind.config.js).
 *
 *  • themes OFF (themeId null)  → null: NOTHING is overridden, the index.css defaults (Tailwind green) apply — the till
 *    looks exactly as it did before Phase 2.
 *  • themes ON                   → action-* = the curated theme's shades (fixed shade per job, shared/themes.ts);
 *    brand-* = the business's own colour when it can be seen on the till (resolveBrandLayer), otherwise the theme's
 *    500 (the proposal: "a business with no brand colour gets its action theme on the lock screen too");
 *    on-brand = black or white, whichever reads on that colour; plus a brand strip and a sidebar tint.
 *
 *  computeThemeVars is PURE (no DOM) so it is tested directly; applyThemeVars is the only DOM write.
 */
import { resolveTheme, resolveBrandLayer, labelOn, brandPalette, type Hex, type BrandPalette } from '../../shared/themes';

/** A597: primaryHex / secondaryHex — the owner's brand colours, already resolved (getBranding's `effective`: none while
 *  themes are off or a branch's own theme overrides). Set, the primary's derived shades replace the theme's action shades. */
export interface ThemeInput { themeId?: string | null; accentHex?: string | null; primaryHex?: string | null; secondaryHex?: string | null }
export interface ThemeVars {
  /** CSS custom properties WITHOUT the leading `--`; colour channels as "r g b", except sidebar-tint (a colour). */
  vars: Record<string, string>;
  /** The brand strip across the top — only when the business has a visible brand colour. */
  strip: Hex | null;
  /** A605: true when the owner's brand colours drive the screens (applyThemeVars marks <html data-brand>, index.css). */
  brand?: boolean;
}

/** Every property this module may set — so switching themes OFF removes them all. */
export const THEME_VAR_NAMES = [
  'action-300', 'action-400', 'action-500', 'action-600', 'action-700', 'action-900',
  'brand-400', 'brand-500', 'brand-600', 'brand-700', 'on-brand', 'sidebar-tint',
  // A605: the brand palette's label, hover, focus ring and selected background (index.css :root[data-brand])
  'on-action', 'action-hover', 'action-ring', 'action-subtle',
  // A609: the secondary colour's accent (index.css: the active tab's underline) — only with a secondary chosen
  'action-accent',
] as const;

const channels = (hex: Hex): string =>
  [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(' ');
const darken = (hex: Hex, by: number): Hex =>
  '#' + [1, 3, 5].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * (1 - by)).toString(16).padStart(2, '0')).join('');

export function computeThemeVars(b: ThemeInput | null | undefined): ThemeVars | null {
  if (!b || !b.themeId) return null;                       // themes OFF → today's look, untouched
  const p = brandPalette(b.primaryHex);                    // A597 / A605: the owner's primary (any colour), or null
  if (p) return brandColourVars(b, p, brandPalette(b.secondaryHex));
  const s = resolveTheme(b.themeId).shades;                // unknown id → the default theme, never nothing
  const brand = resolveBrandLayer(b.accentHex ?? null);    // null when unset, invalid, or too dark to be seen
  const base = brand ? brand.brand : s[500];
  return {
    vars: {
      // The till's action classes use shades 300–900; the theme defines 400–950 (fixed shade per job).
      'action-300': channels(s[400]), 'action-400': channels(s[400]), 'action-500': channels(s[500]),
      // A331: the till's 600/700 fills carry WHITE labels (Start selling, Day close, Stations save, Menu workbench, report
      // chip, update banner) — white on a theme's 600 is < 4.5 for 5 of 7 themes, so 600 → the theme's 700, 700 → its 800.
      'action-600': channels(s[700]), 'action-700': channels(s[800]), 'action-900': channels(s[800]),
      'brand-400': channels(base), 'brand-500': channels(base), 'brand-600': channels(base),
      'brand-700': channels(darken(base, 0.2)),            // pressed
      'on-brand': channels(labelOn(base)),
      'sidebar-tint': brand ? brand.tint : s[950],         // both keep the sidebar text at 7:1 or better
    },
    strip: brand ? brand.brand : null,
  };
}

/**
 * A597 / A605: the owner's brand colours on the POS — the primary's palette for the dark screens (shared themes.ts
 * brandPalette, the same engine as the web): 500 / 600 = the key action (primary buttons, the pay button, selected fills —
 * the colour itself whenever it reads, lifted just enough when it is too dark to stand out), with ONE label that reads on
 * it (on-action; index.css swaps the buttons' white / dark labels for it); 700 / 900 pressed; 300 / 400 links and active
 * labels (4.5:1); action-ring focus and selected borders (3:1); action-subtle a selected background. The brand layer
 * (lock curtain, strip, sidebar tint): the lock-screen accent when one is set and can be seen (as before), otherwise the
 * primary's shade seen on the dark screens. The strip is ONE colour (the secondary is for accents, not the strip).
 */
function brandColourVars(b: ThemeInput, p: BrandPalette, s: BrandPalette | null = null): ThemeVars {
  const accent = resolveBrandLayer(b.accentHex ?? null);
  const layer = accent ? accent.brand : p.layer;
  const d = p.dark;
  return {
    vars: {
      'action-300': channels(d.textHover), 'action-400': channels(d.text), 'action-500': channels(d.primary),
      'action-600': channels(d.primary), 'action-700': channels(d.primaryPressed), 'action-900': channels(d.primaryPressed),
      'brand-400': channels(layer), 'brand-500': channels(layer), 'brand-600': channels(layer),
      'brand-700': channels(darken(layer, 0.2)),
      'on-brand': channels(labelOn(layer)),
      'sidebar-tint': accent ? accent.tint : p.tint,
      'on-action': channels(d.onPrimary), 'action-hover': channels(d.primaryHover),
      'action-ring': channels(d.ring), 'action-subtle': channels(d.subtle),
      // A609 (owner, 2026-10-29: "the secondary colour does not take effect"): its ring shade (3:1 on the dark screens)
      // for the same accents as the web; none chosen → not set, and index.css falls back to the primary's ring (as before).
      ...(s ? { 'action-accent': channels(s.dark.ring) } : {}),
    },
    strip: layer,
    brand: true,
  };
}

/** The strip's CSS background (one colour), or null. */
export function stripBackground(t: Pick<ThemeVars, 'strip'> | null | undefined): string | null {
  return t?.strip ?? null;
}

/** The only DOM write: set the variables on <html>, or remove them all (themes off). */
export function applyThemeVars(t: ThemeVars | null, root: HTMLElement = document.documentElement): void {
  for (const name of THEME_VAR_NAMES) root.style.removeProperty(`--${name}`);
  // A605: the marker index.css keys the brand labels, hovers and rings on — only while the brand colours drive the screens.
  if (t?.brand) root.setAttribute?.('data-brand', ''); else root.removeAttribute?.('data-brand');
  if (!t) return;
  for (const [name, value] of Object.entries(t.vars)) root.style.setProperty(`--${name}`, value);
}
