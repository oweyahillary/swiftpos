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
import { resolveTheme, themeTokens, resolveBrandLayer, type Hex } from '@zaptill/core/themes';

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

// ── A544: the web POS's branch theme ─────────────────────────────────────────────────────────────────────────────────
// Owner, 2026-10-21: per-branch branding ("yes start"). While the web POS is open for a branch that overrides the theme,
// the dashboard wears that theme (resolved by usePOSData with lib/branchBranding.ts — the till's rule); leaving the POS
// gives the business's back. Never with the business's themes off (withBranchTheme keeps the gate).
let posBranchThemeId: string | null = null;
/** usePOSData sets (or clears) its branch's theme; ThemeLayer re-reads and applies it. */
export function setPosBranchTheme(themeId: string | null): void {
  if (posBranchThemeId === themeId) return;
  posBranchThemeId = themeId;
  try { window.dispatchEvent(new Event(BRANDING_SAVED_EVENT)); } catch { /* no window (a test) */ }
}
export function posBranchTheme(): string | null { return posBranchThemeId; }
/** The business branding with the web POS's branch theme over it — only when the business has themes on. PURE. */
export function withBranchTheme(b: BrandingForTheme | null | undefined, branchThemeId: string | null): BrandingForTheme | null {
  if (!b) return null;
  if (!branchThemeId || b.themes_enabled !== true) return b;
  return { ...b, theme_id: branchThemeId };
}

// ── A547: the web POS's brand layer (A544's "not done" (b)) ──────────────────────────────────────────────────────────
// The till (A326, renderer/lib/themeVars.ts computeThemeVars `strip`) draws the business's own colour — its branch's
// override first (A544) — as a 3-px strip across the top of every screen, only while themes are on and only when that
// colour can be seen on the dark screens (resolveBrandLayer, 3:1). The web POS had no brand layer; it now draws the same
// strip, from the same resolved colour (usePOSData: lib/branchBranding.ts, the till's rule). The till's other brand
// places — the lock curtain's dots and Enter, the sidebar tint — have no web POS counterpart (no lock curtain, no sidebar).
/** The colour of the web POS's brand strip, or null: themes off (the effective theme null), no colour, or one too dark to
 *  be seen. PURE — `themeId` / `accentHex` are the RESOLVED ones (branch → business). */
export function posBrandStrip(themeId: string | null | undefined, accentHex: string | null | undefined): Hex | null {
  if (!themeId) return null;
  const hex = typeof accentHex === 'string' ? accentHex.trim().toLowerCase() : '';
  return resolveBrandLayer(/^#[0-9a-f]{6}$/.test(hex) ? hex : null)?.brand ?? null;
}
