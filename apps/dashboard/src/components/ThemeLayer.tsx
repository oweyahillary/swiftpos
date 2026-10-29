import { useEffect, useSyncExternalStore } from 'react';
import { api } from '../lib/api';
import { logoColoursFromDataUri } from '../lib/logoColours';   // A605
import { useBusiness } from '../context/BusinessContext';
import { useAuth } from '../context/AuthContext';
import { readBrandCache, saveBrandCache, clearBrandCache, hasSignInToken } from '../lib/themeBoot';   // A609
import { computeDashboardThemeVars, applyDashboardThemeVars, BRANDING_SAVED_EVENT, withBranchTheme, posBranchTheme, type BrandingForTheme,
  brandLookFor, setBrandLook, brandLook, subscribeBrandLook, type BrandLook } from '../lib/themeVars';

/**
 * A328: applies the signed-in business's action theme to the whole dashboard (the web POS and shared components use the
 * themeable `action-*` colours). Re-reads when the business changes and when Branding is saved. Renders nothing.
 * A597: + the owner's brand colours (the back office's swift-* too) and the shop's look in the chrome (useBrandLook) —
 * all only while the business has themes; off, nothing is set and the dashboard is exactly as before.
 * A609 (owner, 2026-10-29: "we show the default theme for ~4 seconds before theirs — it should be automatic"): what it
 * applies is cached (lib/themeBoot.ts) and put back before the first render; while the sign-in or the business is still
 * loading the cached look stays (it used to be wiped at once); signed out → wiped and the cache cleared; a different
 * business → today's look until its own branding arrives (never another shop's); themes off → the cache cleared.
 */
export default function ThemeLayer() {
  const { business } = useBusiness();
  const { session, loading: authLoading } = useAuth();
  const businessId = business?.id ?? null;
  const signedOut = !authLoading && !session && !hasSignInToken();
  useEffect(() => {
    if (!businessId) {
      // A609: still signing in / loading the business → keep the cached look; signed out → today's look, cache cleared.
      if (signedOut) { applyDashboardThemeVars(null); setBrandLook(null); clearBrandCache(); }
      return;
    }
    // A609: this business's cached look at once (main.tsx usually did already); another business's → today's look.
    const cached = readBrandCache(businessId);
    if (cached) { applyDashboardThemeVars(cached.vars); setBrandLook(cached.look); }
    else if (readBrandCache()) { applyDashboardThemeVars(null); setBrandLook(null); clearBrandCache(); }
    let cancelled = false;
    const load = () => {
      api.get<BrandingForTheme | null>('/api/business/branding')
        // A544: the web POS's branch theme, when it overrides the business's (and themes are on).
        .then((b) => {
          if (cancelled) return;
          applyDashboardThemeVars(computeDashboardThemeVars(withBranchTheme(b, posBranchTheme())));
          // A609: the chip already read for this same logo is kept, so the logo does not flip chips while it is re-read.
          const prev = readBrandCache(businessId)?.look, fresh = brandLookFor(b);
          const look = fresh?.logo && prev?.logo === fresh.logo && prev.logoChip ? { ...fresh, logoChip: prev.logoChip } : fresh;
          setBrandLook(look);
          // A609: the business's own look (not a web POS branch's) for the next start; themes off → nothing kept.
          const own = computeDashboardThemeVars(b);
          if (own) saveBrandCache(businessId, own, look); else clearBrandCache();
          // A605: which chip the logo reads best on (a white logo on a dark one) — read from its pixels, once per logo.
          if (look?.logo) {
            logoColoursFromDataUri(look.logo, 1)
              .then((c) => {
                if (cancelled) return;
                setBrandLook({ ...look, logoChip: c.chip });
                if (own) saveBrandCache(businessId, own, { ...look, logoChip: c.chip });   // A609: the chip too, no flip
              })
              .catch(() => { /* keep the white chip */ });
          }
        })
        .catch(() => { /* keep what is applied; the defaults are today's look */ });
    };
    load();
    window.addEventListener(BRANDING_SAVED_EVENT, load);
    return () => { cancelled = true; window.removeEventListener(BRANDING_SAVED_EVENT, load); };
  }, [businessId, signedOut]);
  return null;
}

/** A597: the shop's logo and colours for the dashboard's chrome (the menu's header, the charts) — null = today's look. */
export function useBrandLook(): BrandLook | null {
  return useSyncExternalStore(subscribeBrandLook, brandLook, () => null);
}
