/**
 * dayCutoff.ts — 0.6.34: the business day's end for the cloud's reports and daily email (lib/businessDay.ts).
 *
 * The business default ('business_day_cutoff' in business_settings), or a branch's own when a report is for one branch
 * (branch_settings). Cached a minute per business/branch — every report request reads it; a change is seen within a
 * minute (and at once on this instance: the settings routes call invalidateDayCutoff).
 */
import { supabase } from './supabase';
import { BUSINESS_DAY_CUTOFF_KEY, cleanCutoff } from './businessDay';

const TTL_MS = 60_000;
const cache = new Map<string, { at: number; minutes: number }>();

export function invalidateDayCutoff(businessId: string | undefined): void {
  if (!businessId) return;
  for (const k of [...cache.keys()]) if (k.startsWith(`${businessId}|`)) cache.delete(k);
}

/** Minutes after midnight the business day ends (0 = midnight). Never throws: a failed read is midnight, as before. */
export async function getDayCutoff(businessId: string | undefined, branchId?: string | null): Promise<number> {
  if (!businessId) return 0;
  const key = `${businessId}|${branchId ?? ''}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.minutes;
  let minutes = 0;
  try {
    const { data: biz } = await supabase.from('business_settings').select('value')
      .eq('business_id', businessId).eq('key', BUSINESS_DAY_CUTOFF_KEY).maybeSingle();
    minutes = cleanCutoff((biz as any)?.value) ?? 0;
    if (branchId) {
      const { data: br } = await supabase.from('branch_settings').select('value')
        .eq('business_id', businessId).eq('branch_id', branchId).eq('key', BUSINESS_DAY_CUTOFF_KEY).maybeSingle();
      if (br) minutes = cleanCutoff((br as any).value) ?? minutes;
    }
  } catch { minutes = 0; }
  cache.set(key, { at: Date.now(), minutes });
  return minutes;
}
