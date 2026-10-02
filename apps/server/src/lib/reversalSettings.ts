/**
 * reversalSettings.ts — 0.6.30 (A336 stage 3): read a business's void/refund rules (business_settings rows the owner
 * sets on the web or the till) on the cloud. What each setting means lives in the shared lib/reversalRules.ts; this is
 * the one database read.
 */
import { supabase } from './supabase';
import { parseReversalRules, REVERSAL_SETTING_KEYS, type ReversalRules } from './reversalRules';

export async function businessReversalRules(businessId: string | undefined | null): Promise<ReversalRules> {
  if (!businessId) return parseReversalRules(null);
  const { data } = await supabase.from('business_settings').select('key, value')
    .eq('business_id', businessId).in('key', [...REVERSAL_SETTING_KEYS]);
  return parseReversalRules((data ?? []) as Array<{ key: string; value: unknown }>);
}
