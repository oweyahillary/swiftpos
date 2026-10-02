/**
 * posFeatureFlags.ts — 0.6.27: read a business's POS switches (feature_flags rows the admin portal sets) on the cloud.
 * The rules for what each switch means live in the shared lib/posFeatures.ts; this is the one database read.
 */
import { supabase } from './supabase';
import { parsePosFeatures, POS_FEATURE_KEYS, type PosFeatures } from './posFeatures';

export async function businessPosFeatures(businessId: string | undefined | null): Promise<PosFeatures> {
  if (!businessId) return parsePosFeatures(null);
  const { data } = await supabase.from('feature_flags').select('key, enabled')
    .eq('business_id', businessId).in('key', [...POS_FEATURE_KEYS]);
  return parsePosFeatures(data ?? []);
}
