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
import { resolveTheme, themeTokens, resolveBrandLayer, brandTokens, cleanBrandHex, type Hex } from './themes';

/** A597: + the owner's brand colours and the logo (GET /api/business/branding). */
export interface BrandingForTheme {
  theme_id?: string | null; themes_enabled?: boolean;
  primary_hex?: string | null; secondary_hex?: string | null; logo_png?: string | null;
}
/** A597: the back office's brand shades (index.css `:root[data-brand]` maps the swift-* tokens onto them). */
export const DASHBOARD_BRAND_VARS = ['bp-fill', 'bp-fill-hover', 'bp-strong', 'bp-strong-hover', 'bp-text-d', 'bp-text-d-hover', 'bp-text-l', 'bp-text-l-hover'] as const;
export const DASHBOARD_THEME_VARS = ['action-t-500', 'action-t-600', 'action-d-400', 'action-l-400', ...DASHBOARD_BRAND_VARS] as const;

const channels = (hex: Hex): string => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(' ');

export function computeDashboardThemeVars(b: BrandingForTheme | null | undefined): Record<string, string> | null {
  if (!b || b.themes_enabled !== true) return null;
  // A597: the owner's primary colour wins over the curated theme — the web POS's action shades AND the back office's
  // swift-* (until A597 a fixed ZapTill teal), each the nearest shade of that colour that reads for its job.
  const p = brandTokens(b.primary_hex);
  if (p) return brandColourVars(p);
  const k = themeTokens(resolveTheme(b.theme_id ?? null));
  return {
    'action-t-500': channels(k.fillDark),       // 500: dark-text fills — dark text reads on every theme's 500
    'action-t-600': channels(k.pressedLight),   // 700: white-text fills — white reads on every theme's 700
    'action-d-400': channels(k.textDark),       // 400: links on the dark dashboard
    'action-l-400': channels(k.textLight),      // 700: links on the light dashboard
  };
}

/** A597: the primary's shade per job. Same jobs and labels as a theme's (above), so every existing label stays readable:
 *  500 fills carry dark labels, 600 fills white ones, links switch shade with the mode. PURE. */
function brandColourVars(p: NonNullable<ReturnType<typeof brandTokens>>): Record<string, string> {
  return {
    'action-t-500': channels(p.fill), 'action-t-600': channels(p.strong),
    'action-d-400': channels(p.textDark), 'action-l-400': channels(p.textLight),
    'bp-fill': channels(p.fill), 'bp-fill-hover': channels(p.fillHover),
    'bp-strong': channels(p.strong), 'bp-strong-hover': channels(p.strongHover),
    'bp-text-d': channels(p.textDark), 'bp-text-d-hover': channels(p.textDarkHover),
    'bp-text-l': channels(p.textLight), 'bp-text-l-hover': channels(p.textLightHover),
  };
}

export function applyDashboardThemeVars(v: Record<string, string> | null, root: HTMLElement = document.documentElement): void {
  for (const n of DASHBOARD_THEME_VARS) root.style.removeProperty(`--${n}`);
  // A597: the marker index.css keys the back office's brand colours on — only while the brand shades are set.
  if (v && v['bp-fill']) root.setAttribute?.('data-brand', ''); else root.removeAttribute?.('data-brand');
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
  // A597: a branch's own theme wins over the business's brand colours too (the branch wears its theme whole).
  return { ...b, theme_id: branchThemeId, primary_hex: null, secondary_hex: null };
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

/** A597: the web POS's strip with the owner's brand colours — the lock-screen accent (or else the primary, at its shade
 *  seen on the dark screens), the secondary beside it. A CSS background, or null (themes off / no colour). PURE. */
export function posBrandStripColours(themeId: string | null | undefined, accentHex: string | null | undefined,
  primaryHex: string | null | undefined, secondaryHex: string | null | undefined): string | null {
  if (!themeId) return null;
  const first = posBrandStrip(themeId, accentHex) ?? brandTokens(primaryHex)?.layer ?? null;
  const second = brandTokens(secondaryHex)?.layer ?? null;
  if (!first) return second;
  return second ? `linear-gradient(90deg, ${first} 0%, ${first} 50%, ${second} 50%, ${second} 100%)` : first;
}

// ── A597: the shop's own look in the dashboard's chrome ─────────────────────────────────────────────────────────────
// Owner, 2026-10-27: "the web portal must adopt the shop branding" — the shop's logo at the top of the menu, its colours
// as a band under it, and the secondary colour on the charts' single-series accent. Premium: nothing without themes.
export interface BrandLook { logo: string | null; primary: Hex | null; secondary: Hex | null }
/** What the chrome shows, or null (themes off, or nothing chosen) — then the dashboard is exactly as before. PURE. */
export function brandLookFor(b: BrandingForTheme | null | undefined): BrandLook | null {
  if (!b || b.themes_enabled !== true) return null;
  const primary = cleanBrandHex(b.primary_hex), secondary = cleanBrandHex(b.secondary_hex);
  const logo = typeof b.logo_png === 'string' && /^data:image\/(?:png|jpeg);base64,/i.test(b.logo_png) ? b.logo_png : null;
  return primary || secondary || logo ? { logo, primary, secondary } : null;
}
/** The band's CSS background: the primary and the secondary side by side (either alone fills it), or null. PURE. */
export function brandBand(l: BrandLook | null | undefined): string | null {
  const a = l?.primary ?? l?.secondary ?? null, b = l?.secondary ?? l?.primary ?? null;
  if (!a || !b) return null;
  return a === b ? a : `linear-gradient(90deg, ${a} 0%, ${a} 50%, ${b} 50%, ${b} 100%)`;
}
/** A chart's single-series accent in the brand: the secondary (else the primary) at a shade seen on the card (3:1). */
export function brandChartAccent(l: BrandLook | null | undefined, mode: 'light' | 'dark'): Hex | null {
  const t = brandTokens(l?.secondary ?? l?.primary ?? null);
  return t ? (mode === 'light' ? t.chartLight : t.chartDark) : null;
}
let currentLook: BrandLook | null = null;
const lookListeners = new Set<() => void>();
/** ThemeLayer sets it after each read of the branding; the chrome re-renders (useBrandLook). */
export function setBrandLook(l: BrandLook | null): void {
  if (JSON.stringify(l) === JSON.stringify(currentLook)) return;
  currentLook = l;
  for (const f of lookListeners) f();
}
export function brandLook(): BrandLook | null { return currentLook; }
export function subscribeBrandLook(f: () => void): () => void { lookListeners.add(f); return () => { lookListeners.delete(f); }; }
