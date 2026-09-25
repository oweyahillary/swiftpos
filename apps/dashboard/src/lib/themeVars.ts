/**
 * themeVars.ts (dashboard) — A328 (client branding Phase 2, slice 4b-1): a business's action theme → the CSS variables
 * behind the web POS's `action-*` colours (tailwind.config.js, src/index.css).
 *
 *  • themes OFF, or no branding → null: nothing is set; index.css falls back to Tailwind green — unchanged.
 *  • themes ON → the theme's fixed shades (shared registry, lib/themes.ts `themeTokens`), mapped so every existing label
 *    stays readable: 500 fills (dark text) → fillDark (500); 600 fills (white text) → pressedLight (700); links → textDark
 *    (400) in dark mode, textLight (700) in light mode. An unknown or unchosen theme id resolves to the default.
 *  computeDashboardThemeVars is PURE; applyDashboardThemeVars is the only DOM write.
 */
import { resolveTheme, themeTokens, type Hex } from './themes';

export interface BrandingForTheme { theme_id?: string | null; themes_enabled?: boolean }
export const DASHBOARD_THEME_VARS = ['action-t-500', 'action-t-600', 'action-d-400', 'action-l-400'] as const;

const channels = (hex: Hex): string => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(' ');

export function computeDashboardThemeVars(b: BrandingForTheme | null | undefined): Record<string, string> | null {
  if (!b || b.themes_enabled !== true) return null;
  const k = themeTokens(resolveTheme(b.theme_id ?? null));
  return {
    'action-t-500': channels(k.fillDark),       // 500: dark-text fills — dark text reads on every theme's 500
    'action-t-600': channels(k.pressedLight),   // 700: white-text fills — white reads on every theme's 700
    'action-d-400': channels(k.textDark),       // 400: links on the dark dashboard
    'action-l-400': channels(k.textLight),      // 700: links on the light dashboard
  };
}

export function applyDashboardThemeVars(v: Record<string, string> | null, root: HTMLElement = document.documentElement): void {
  for (const n of DASHBOARD_THEME_VARS) root.style.removeProperty(`--${n}`);
  if (!v) return;
  for (const [n, val] of Object.entries(v)) root.style.setProperty(`--${n}`, val);
}

/** BrandingTab fires this after a save or reset, so the dashboard re-reads its own theme at once. */
export const BRANDING_SAVED_EVENT = 'swiftpos:branding-saved';
