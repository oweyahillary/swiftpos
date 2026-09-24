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
import { resolveTheme, resolveBrandLayer, labelOn, type Hex } from '../../shared/themes';

export interface ThemeInput { themeId?: string | null; accentHex?: string | null }
export interface ThemeVars {
  /** CSS custom properties WITHOUT the leading `--`; colour channels as "r g b", except sidebar-tint (a colour). */
  vars: Record<string, string>;
  /** The brand strip across the top — only when the business has a visible brand colour. */
  strip: Hex | null;
}

/** Every property this module may set — so switching themes OFF removes them all. */
export const THEME_VAR_NAMES = [
  'action-300', 'action-400', 'action-500', 'action-600', 'action-700', 'action-900',
  'brand-400', 'brand-500', 'brand-600', 'brand-700', 'on-brand', 'sidebar-tint',
] as const;

const channels = (hex: Hex): string =>
  [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(' ');
const darken = (hex: Hex, by: number): Hex =>
  '#' + [1, 3, 5].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * (1 - by)).toString(16).padStart(2, '0')).join('');

export function computeThemeVars(b: ThemeInput | null | undefined): ThemeVars | null {
  if (!b || !b.themeId) return null;                       // themes OFF → today's look, untouched
  const s = resolveTheme(b.themeId).shades;                // unknown id → the default theme, never nothing
  const brand = resolveBrandLayer(b.accentHex ?? null);    // null when unset, invalid, or too dark to be seen
  const base = brand ? brand.brand : s[500];
  return {
    vars: {
      // The till's action classes use shades 300–900; the theme defines 400–950 (fixed shade per job).
      'action-300': channels(s[400]), 'action-400': channels(s[400]), 'action-500': channels(s[500]),
      'action-600': channels(s[600]), 'action-700': channels(s[700]), 'action-900': channels(s[800]),
      'brand-400': channels(base), 'brand-500': channels(base), 'brand-600': channels(base),
      'brand-700': channels(darken(base, 0.2)),            // pressed
      'on-brand': channels(labelOn(base)),
      'sidebar-tint': brand ? brand.tint : s[950],         // both keep the sidebar text at 7:1 or better
    },
    strip: brand ? brand.brand : null,
  };
}

/** The only DOM write: set the variables on <html>, or remove them all (themes off). */
export function applyThemeVars(t: ThemeVars | null, root: HTMLElement = document.documentElement): void {
  for (const name of THEME_VAR_NAMES) root.style.removeProperty(`--${name}`);
  if (!t) return;
  for (const [name, value] of Object.entries(t.vars)) root.style.setProperty(`--${name}`, value);
}
