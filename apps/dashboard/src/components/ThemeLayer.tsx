import { useEffect, useSyncExternalStore } from 'react';
import { api } from '../lib/api';
import { logoColoursFromDataUri } from '../lib/logoColours';   // A605
import { useBusiness } from '../context/BusinessContext';
import { computeDashboardThemeVars, applyDashboardThemeVars, BRANDING_SAVED_EVENT, withBranchTheme, posBranchTheme, type BrandingForTheme,
  brandLookFor, setBrandLook, brandLook, subscribeBrandLook, type BrandLook } from '../lib/themeVars';

/**
 * A328: applies the signed-in business's action theme to the whole dashboard (the web POS and shared components use the
 * themeable `action-*` colours). Re-reads when the business changes and when Branding is saved. Renders nothing.
 * A597: + the owner's brand colours (the back office's swift-* too) and the shop's look in the chrome (useBrandLook) —
 * all only while the business has themes; off, nothing is set and the dashboard is exactly as before.
 */
export default function ThemeLayer() {
  const { business } = useBusiness();
  const businessId = business?.id ?? null;
  useEffect(() => {
    if (!businessId) { applyDashboardThemeVars(null); setBrandLook(null); return; }
    let cancelled = false;
    const load = () => {
      api.get<BrandingForTheme | null>('/api/business/branding')
        // A544: the web POS's branch theme, when it overrides the business's (and themes are on).
        .then((b) => {
          if (cancelled) return;
          applyDashboardThemeVars(computeDashboardThemeVars(withBranchTheme(b, posBranchTheme())));
          const look = brandLookFor(b);
          setBrandLook(look);
          // A605: which chip the logo reads best on (a white logo on a dark one) — read from its pixels, once per logo.
          if (look?.logo) {
            logoColoursFromDataUri(look.logo, 1)
              .then((c) => { if (!cancelled) setBrandLook({ ...look, logoChip: c.chip }); })
              .catch(() => { /* keep the white chip */ });
          }
        })
        .catch(() => { /* keep what is applied; the defaults are today's look */ });
    };
    load();
    window.addEventListener(BRANDING_SAVED_EVENT, load);
    return () => { cancelled = true; window.removeEventListener(BRANDING_SAVED_EVENT, load); };
  }, [businessId]);
  return null;
}

/** A597: the shop's logo and colours for the dashboard's chrome (the menu's header, the charts) — null = today's look. */
export function useBrandLook(): BrandLook | null {
  return useSyncExternalStore(subscribeBrandLook, brandLook, () => null);
}
