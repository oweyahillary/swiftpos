/**
 * dayCutoff.ts — 0.6.34: the business day's end for the cloud's reports and daily email (lib/businessDay.ts).
 *
 * The business default ('business_day_cutoff' in business_settings), or a branch's own when a report is for one branch
 * (branch_settings). Cached a minute per business/branch — every report request reads it; a change is seen within a
 * minute (and at once on this instance: the settings routes call invalidateDayCutoff).
 */
import { supabase } from './supabase';
import { BUSINESS_DAY_CUTOFF_KEY, cleanCutoff } from '@zaptill/core/businessDay';
import { memoEnabled, catalogueGen } from './writeActivity';   // A593

const TTL_MS = 60_000;
/** A593: a cut-off changes only through a settings route (a catalogue router — it moves the catalogue generation, and
 *  calls invalidateDayCutoff): kept up to 10 minutes while that generation stands (the watchdog asks every 10 minutes). */
const QUIET_TTL_MS = 10 * 60_000;
const cache = new Map<string, { at: number; minutes: number; gen?: string }>();
const fresh = (hit: { at: number; gen?: string } | undefined, businessId: string, now: number): boolean => !!hit
  && (now - hit.at < TTL_MS || (memoEnabled() && hit.gen === catalogueGen(businessId) && now - hit.at < QUIET_TTL_MS));

export function invalidateDayCutoff(businessId: string | undefined): void {
  if (!businessId) return;
  for (const k of [...cache.keys()]) if (k.startsWith(`${businessId}|`)) cache.delete(k);
}

/** Minutes after midnight the business day ends (0 = midnight). Never throws: a failed read is midnight, as before. */
export async function getDayCutoff(businessId: string | undefined, branchId?: string | null): Promise<number> {
  if (!businessId) return 0;
  const key = `${businessId}|${branchId ?? ''}`;
  const hit = cache.get(key);
  if (hit && fresh(hit, businessId, Date.now())) return hit.minutes;
  const gen = catalogueGen(businessId);   // A593: before the read
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
  cache.set(key, { at: Date.now(), minutes, gen });
  return minutes;
}

/**
 * A593: the cut-offs of many businesses and branches in TWO reads (the watchdog's open days asked one or two reads per
 * day row, every 10 minutes). Fills the same memory getDayCutoff reads, with the same rule: the business's value, a
 * branch's own when it has one. A pair whose rows cannot be told apart (a duplicate key — maybeSingle would refuse it) or
 * any failed read is left out: getDayCutoff then reads it as before. Never throws.
 */
export async function primeDayCutoffs(pairs: Array<{ businessId: string; branchId?: string | null }>, now = Date.now()): Promise<void> {
  const want = pairs.filter((p) => p.businessId && !fresh(cache.get(`${p.businessId}|${p.branchId ?? ''}`), p.businessId, now));
  if (!want.length) return;
  try {
    const bizIds = [...new Set(want.map((p) => p.businessId))].slice(0, 500);
    const gens = new Map(bizIds.map((b) => [b, catalogueGen(b)]));   // before the reads
    const branchIds = [...new Set(want.map((p) => p.branchId).filter((x): x is string => !!x))].slice(0, 500);
    const { data: bs, error: bErr } = await supabase.from('business_settings').select('business_id, value')
      .in('business_id', bizIds).eq('key', BUSINESS_DAY_CUTOFF_KEY);
    if (bErr) return;
    const brRows = branchIds.length
      ? await supabase.from('branch_settings').select('business_id, branch_id, value').in('branch_id', branchIds).eq('key', BUSINESS_DAY_CUTOFF_KEY)
      : { data: [], error: null };
    if (brRows.error) return;
    const count = (rows: any[], k: (r: any) => string) => { const m = new Map<string, any[]>(); for (const r of rows) { const key = k(r); m.set(key, [...(m.get(key) ?? []), r]); } return m; };
    const byBiz = count((bs ?? []) as any[], (r) => String(r.business_id));
    const byBranch = count((brRows.data ?? []) as any[], (r) => `${r.business_id}|${r.branch_id}`);
    for (const p of want) {
      if (!bizIds.includes(p.businessId) || (p.branchId && !branchIds.includes(p.branchId))) continue;
      const b = byBiz.get(p.businessId) ?? [];
      if (b.length > 1) continue;
      let minutes = cleanCutoff(b[0]?.value) ?? 0;
      if (p.branchId) {
        const r = byBranch.get(`${p.businessId}|${p.branchId}`) ?? [];
        if (r.length > 1) continue;
        if (r[0]) minutes = cleanCutoff(r[0].value) ?? minutes;
      }
      cache.set(`${p.businessId}|${p.branchId ?? ''}`, { at: now, minutes, gen: gens.get(p.businessId) });
    }
  } catch { /* getDayCutoff reads each as before */ }
}
