/**
 * analyticsAccess.ts — A549: may a business use Analytics v1? A per-business feature flag, feature_flags key 'analytics',
 * OFF by default — a premium switch set by ZapTill in the admin portal (as 'themes', lib/themeAccess.ts). The client
 * cannot set it (PUT /api/flags refuses every key not in CLIENT_SETTABLE_FLAGS). The rules are in analyticsRules.ts.
 */
import { supabase } from './supabase';
import { ANALYTICS_FLAG } from './analyticsRules';

export async function analyticsEnabled(businessId: string | undefined | null): Promise<boolean> {
  if (!businessId) return false;
  const { data } = await supabase
    .from('feature_flags')
    .select('enabled')
    .eq('business_id', businessId)
    .eq('key', ANALYTICS_FLAG)
    .maybeSingle();
  return data?.enabled === true;
}
