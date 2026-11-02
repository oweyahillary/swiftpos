/**
 * themeBoot.ts — A609 (owner, 2026-10-29: "when loading the client's site we show the default theme for ~4 seconds before
 * theirs — it should be automatic"). ThemeLayer can only colour the dashboard after the sign-in, the business and then
 * /api/business/branding have loaded; until then every client saw ZapTill teal. Now the last look ThemeLayer applied (its
 * CSS variables and the menu's logo / colours) is kept in localStorage and put back BEFORE the first React render:
 *
 *   • bootBrandTheme() — main.tsx calls it once, before ReactDOM.createRoot. index.html's inline script does the same for
 *     the variables a moment earlier (before the bundle has even downloaded); this also seeds the menu's logo (useBrandLook).
 *   • saveBrandCache / clearBrandCache — ThemeLayer refreshes the copy every time it applies a business's branding, and
 *     clears it on sign-out, themes off and a different business (another shop's look is never shown).
 *   • Keys: `zaptill-brand:<business id>` (the look) and `zaptill-brand:last` (which business that was) — one business kept.
 *
 * Premium is unchanged: the cache only ever holds what ThemeLayer applied (themes on). Nothing is applied without a sign-in
 * token on this browser. Every storage access is wrapped — a private window or blocked storage just means today's start.
 */
import { applyDashboardThemeVars, setBrandLook, DASHBOARD_THEME_VARS, type BrandLook } from './themeVars';
import { cleanBrandHex } from './themes';

export const BRAND_CACHE_PREFIX = 'zaptill-brand:';
export const BRAND_CACHE_LAST = 'zaptill-brand:last';

export interface BrandCache { bid: string; vars: Record<string, string>; look: BrandLook | null }

const VAR_NAMES = new Set<string>(DASHBOARD_THEME_VARS);
const CHANNELS = /^\d{1,3} \d{1,3} \d{1,3}$/;
const LOGO = /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/=]+$/;

/** Only what ThemeLayer itself could have written: known variable names with "r g b" values, a clean look. PURE. */
export function cleanBrandCache(raw: unknown, bid: string): BrandCache | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { bid?: unknown; vars?: unknown; look?: unknown };
  if (r.bid !== bid || !r.vars || typeof r.vars !== 'object') return null;
  const vars: Record<string, string> = {};
  for (const [k, v] of Object.entries(r.vars as Record<string, unknown>)) {
    if (VAR_NAMES.has(k) && typeof v === 'string' && CHANNELS.test(v)) vars[k] = v;
  }
  if (!Object.keys(vars).length) return null;
  let look: BrandLook | null = null;
  if (r.look && typeof r.look === 'object') {
    const l = r.look as Record<string, unknown>;
    const logo = typeof l.logo === 'string' && LOGO.test(l.logo) ? l.logo : null;
    const primary = cleanBrandHex(l.primary), secondary = cleanBrandHex(l.secondary);
    if (logo || primary || secondary) {
      look = { logo, primary, secondary };
      if (l.logoChip === 'light' || l.logoChip === 'dark') look.logoChip = l.logoChip;
    }
  }
  return { bid, vars, look };
}

/** The cached look — of `bid`, or of the last business when none is given. null: nothing (or unreadable). */
export function readBrandCache(bid?: string | null): BrandCache | null {
  try {
    const id = bid ?? localStorage.getItem(BRAND_CACHE_LAST);
    if (!id) return null;
    const raw = localStorage.getItem(BRAND_CACHE_PREFIX + id);
    return raw ? cleanBrandCache(JSON.parse(raw), id) : null;
  } catch { return null; }
}

/** Every zaptill-brand:* key but `keep`'s. */
function dropOthers(keep: string | null): void {
  const gone: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(BRAND_CACHE_PREFIX) && k !== BRAND_CACHE_LAST && k !== (keep ? BRAND_CACHE_PREFIX + keep : null)) gone.push(k);
  }
  for (const k of gone) localStorage.removeItem(k);
}

/** ThemeLayer: what it has just applied for `bid`. A logo too big for the browser's storage is left out (the colours stay). */
export function saveBrandCache(bid: string, vars: Record<string, string>, look: BrandLook | null): void {
  try {
    dropOthers(bid);
    const put = (l: BrandLook | null) => localStorage.setItem(BRAND_CACHE_PREFIX + bid, JSON.stringify({ bid, vars, look: l }));
    try { put(look); } catch { put(look ? { ...look, logo: null } : null); }
    localStorage.setItem(BRAND_CACHE_LAST, bid);
  } catch { /* storage full or blocked: the next start is today's */ }
}

export function clearBrandCache(): void {
  try { dropOthers(null); localStorage.removeItem(BRAND_CACHE_LAST); } catch { /* blocked */ }
}

/** Someone is signed in on this browser (an owner / staff token, the web POS's token, or a Supabase session). */
export function hasSignInToken(): boolean {
  try {
    for (const k of ['swiftpos_access_token', 'swiftpos_refresh_token', 'swiftpos_pos_token', 'swiftpos_pos_refresh_token']) {
      if (localStorage.getItem(k)) return true;
    }
    for (let i = 0; i < localStorage.length; i++) if (/^sb-.+-auth-token$/.test(localStorage.key(i) ?? '')) return true;
  } catch { /* blocked */ }
  return false;
}

/** main.tsx, before the first render: the last business's look, at once. Nothing without a cache or a sign-in. */
export function bootBrandTheme(): void {
  try {
    if (!hasSignInToken()) return;
    const c = readBrandCache();
    if (!c) return;
    applyDashboardThemeVars(c.vars);
    setBrandLook(c.look);
  } catch { /* today's start */ }
}
