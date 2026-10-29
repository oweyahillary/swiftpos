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
import { resolveTheme, themeTokens, resolveBrandLayer, brandPalette, cleanBrandHex, contrast, type Hex, type BrandPalette } from './themes';

/** A597: + the owner's brand colours and the logo (GET /api/business/branding). */
export interface BrandingForTheme {
  theme_id?: string | null; themes_enabled?: boolean;
  primary_hex?: string | null; secondary_hex?: string | null; logo_png?: string | null;
}
/** A597 / A605: the brand layer's variables — the primary's palette (shared themes.ts brandPalette) by mode (-l light, -d
 *  dark), its identity band, and the secondary's few. index.css `:root[data-brand]` maps the back office's swift-*, the
 *  web POS's action-* / act-* and the labels on them onto these (A605's colour map, docs/AUDIT-REGISTER.md). */
const MODE_VARS = (pre: string, m: 'l' | 'd') => [`${pre}-primary-${m}`, `${pre}-on-primary-${m}`, `${pre}-primary-hover-${m}`,
  `${pre}-primary-pressed-${m}`, `${pre}-text-${m}`, `${pre}-text-${m}-hover`, `${pre}-ring-${m}`, `${pre}-subtle-${m}`, `${pre}-tint-${m}`, `${pre}-chart-${m}`];
export const DASHBOARD_BRAND_VARS = [...MODE_VARS('bp', 'l'), ...MODE_VARS('bp', 'd'), 'bp-band', 'bp-on-band', 'bp-edge-l',
  ...MODE_VARS('bs', 'l'), ...MODE_VARS('bs', 'd')] as const;
export const DASHBOARD_THEME_VARS = ['action-t-500', 'action-t-600', 'action-d-400', 'action-l-400', ...DASHBOARD_BRAND_VARS] as const;

const channels = (hex: Hex): string => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(' ');

export function computeDashboardThemeVars(b: BrandingForTheme | null | undefined): Record<string, string> | null {
  if (!b || b.themes_enabled !== true) return null;
  // A597 / A605: the owner's primary colour wins over the curated theme — its palette on the back office AND the web POS
  // (index.css data-brand), each job the nearest shade on the colour's own scale that reads there.
  const p = brandPalette(b.primary_hex);
  if (p) return brandColourVars(p, brandPalette(b.secondary_hex));
  const k = themeTokens(resolveTheme(b.theme_id ?? null));
  return {
    'action-t-500': channels(k.fillDark),       // 500: dark-text fills — dark text reads on every theme's 500
    'action-t-600': channels(k.pressedLight),   // 700: white-text fills — white reads on every theme's 700
    'action-d-400': channels(k.textDark),       // 400: links on the dark dashboard
    'action-l-400': channels(k.textLight),      // 700: links on the light dashboard
  };
}

/** A605: a palette's variables, light and dark (channels "r g b"). The secondary's only when one is chosen. PURE. */
export function brandColourVars(p: BrandPalette, s: BrandPalette | null = null): Record<string, string> {
  // A609: the light pages' hairline round a brand fill — the ring shade when the fill barely stands out from white (a
  // yellow is 1.5:1), else the fill itself (the hairline vanishes into it). index.css :root[data-brand]:not(.dark).
  const edge = contrast(p.light.primary, '#ffffff') < 3 ? p.light.ring : p.light.primary;
  const v: Record<string, string> = { 'bp-band': channels(p.base), 'bp-on-band': channels(p.on), 'bp-edge-l': channels(edge) };
  const put = (pre: string, pal: BrandPalette) => {
    for (const [m, k] of [['l', pal.light], ['d', pal.dark]] as const) {
      v[`${pre}-primary-${m}`] = channels(k.primary); v[`${pre}-on-primary-${m}`] = channels(k.onPrimary);
      v[`${pre}-primary-hover-${m}`] = channels(k.primaryHover); v[`${pre}-primary-pressed-${m}`] = channels(k.primaryPressed);
      v[`${pre}-text-${m}`] = channels(k.text); v[`${pre}-text-${m}-hover`] = channels(k.textHover);
      v[`${pre}-ring-${m}`] = channels(k.ring); v[`${pre}-subtle-${m}`] = channels(k.subtle);
      v[`${pre}-tint-${m}`] = channels(k.tint); v[`${pre}-chart-${m}`] = channels(k.chart);
    }
  };
  put('bp', p);
  if (s) put('bs', s);
  return v;
}

export function applyDashboardThemeVars(v: Record<string, string> | null, root: HTMLElement = document.documentElement): void {
  for (const n of DASHBOARD_THEME_VARS) root.style.removeProperty(`--${n}`);
  // A597: the marker index.css keys the back office's brand colours on — only while the brand shades are set.
  if (v && v['bp-primary-l']) root.setAttribute?.('data-brand', ''); else root.removeAttribute?.('data-brand');
  // A609: the secondary's accents (index.css :root[data-brand-2]) — only when a secondary is chosen beside the primary.
  if (v && v['bp-primary-l'] && v['bs-ring-l']) root.setAttribute?.('data-brand-2', ''); else root.removeAttribute?.('data-brand-2');
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

/** A597 / A605: the web POS's strip — ONE colour, the brand's identity line: the lock-screen accent, or else the primary
 *  at its shade seen on the dark screens (the secondary is kept for accents and charts, not the strip). A CSS background,
 *  or null (themes off / no colour). PURE. */
export function posBrandStripColours(themeId: string | null | undefined, accentHex: string | null | undefined,
  primaryHex: string | null | undefined, _secondaryHex?: string | null | undefined): string | null {
  if (!themeId) return null;
  return posBrandStrip(themeId, accentHex) ?? brandPalette(primaryHex)?.layer ?? null;
}

// ── A597: the shop's own look in the dashboard's chrome ─────────────────────────────────────────────────────────────
// Owner, 2026-10-27: "the web portal must adopt the shop branding" — the shop's logo at the top of the menu, its colours
// as a band under it, and the secondary colour on the charts' single-series accent. Premium: nothing without themes.
export interface BrandLook {
  logo: string | null; primary: Hex | null; secondary: Hex | null;
  /** A605: the surface the logo reads best on (lib/logoColours.ts — a white logo on a dark chip); undefined = not yet read. */
  logoChip?: 'light' | 'dark';
}
/** What the chrome shows, or null (themes off, or nothing chosen) — then the dashboard is exactly as before. PURE. */
export function brandLookFor(b: BrandingForTheme | null | undefined): BrandLook | null {
  if (!b || b.themes_enabled !== true) return null;
  const primary = cleanBrandHex(b.primary_hex), secondary = cleanBrandHex(b.secondary_hex);
  const logo = typeof b.logo_png === 'string' && /^data:image\/(?:png|jpeg);base64,/i.test(b.logo_png) ? b.logo_png : null;
  return primary || secondary || logo ? { logo, primary, secondary } : null;
}
/** A605: the identity band at the top of the menu — the primary exactly as chosen (else the secondary), ONE colour. PURE. */
export function brandBand(l: BrandLook | null | undefined): string | null {
  return l?.primary ?? l?.secondary ?? null;
}
/** A605: the FIRST chart series in the brand — the primary (else the secondary) at a shade seen on the card (3:1). */
export function brandChartAccent(l: BrandLook | null | undefined, mode: 'light' | 'dark'): Hex | null {
  const p = brandPalette(l?.primary ?? l?.secondary ?? null);
  return p ? p[mode].chart : null;
}
/** A605: the SECOND chart series — the secondary at its chart shade, only when both colours are chosen. */
export function brandChartSecond(l: BrandLook | null | undefined, mode: 'light' | 'dark'): Hex | null {
  const s = l?.primary ? brandPalette(l?.secondary ?? null) : null;
  return s ? s[mode].chart : null;
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
