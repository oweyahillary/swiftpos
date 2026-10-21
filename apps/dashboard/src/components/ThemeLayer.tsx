import { useEffect } from 'react';
import { api } from '../lib/api';
import { useBusiness } from '../context/BusinessContext';
import { computeDashboardThemeVars, applyDashboardThemeVars, BRANDING_SAVED_EVENT, withBranchTheme, posBranchTheme, type BrandingForTheme } from '../lib/themeVars';

/**
 * A328: applies the signed-in business's action theme to the whole dashboard (the web POS and shared components use the
 * themeable `action-*` colours). Re-reads when the business changes and when Branding is saved. Renders nothing.
 */
export default function ThemeLayer() {
  const { business } = useBusiness();
  const businessId = business?.id ?? null;
  useEffect(() => {
    if (!businessId) { applyDashboardThemeVars(null); return; }
    let cancelled = false;
    const load = () => {
      api.get<BrandingForTheme | null>('/api/business/branding')
        // A544: the web POS's branch theme, when it overrides the business's (and themes are on).
        .then((b) => { if (!cancelled) applyDashboardThemeVars(computeDashboardThemeVars(withBranchTheme(b, posBranchTheme()))); })
        .catch(() => { /* keep what is applied; the defaults are today's look */ });
    };
    load();
    window.addEventListener(BRANDING_SAVED_EVENT, load);
    return () => { cancelled = true; window.removeEventListener(BRANDING_SAVED_EVENT, load); };
  }, [businessId]);
  return null;
}
