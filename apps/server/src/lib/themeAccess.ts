/**
 * themeAccess.ts — A325 (client branding Phase 2, slice 2): is a business allowed to use themes?
 * A per-business feature flag, feature_flags key 'themes', OFF by default — the premium switch (A323). Same table
 * and shape as 'web_hosting' (lib/webAccess.ts); switched from the admin portal. The rules that use the answer are
 * pure functions in themeRules.ts.
 */
import { supabase } from './supabase';
import { THEMES_FLAG } from './themeRules';
export { THEMES_FLAG, effectiveThemeId, themeWriteError } from './themeRules';

export async function themesEnabled(businessId: string): Promise<boolean> {
  const { data } = await supabase
    .from('feature_flags')
    .select('enabled')
    .eq('business_id', businessId)
    .eq('key', THEMES_FLAG)
    .maybeSingle();
  return data?.enabled === true;
}
