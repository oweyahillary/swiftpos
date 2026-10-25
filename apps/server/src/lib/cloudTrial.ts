/**
 * cloudTrial.ts — A569 (2026-10-22): a one-month cloud trial starts with a client's FIRST desktop licence.
 *
 * Owner: "they should get a 1 month trial plan for cloud if they have subscribed on the desktop platform".
 *
 * THE RULE
 *   When a branch's desktop licence is activated (admin portal › Branches & tills › "Activate licence") and the client
 *   has no other licensed branch, has never had web access (no web_hosting flag row, on or off; no dated web-access
 *   expiry) and has never had a trial, the client gets a 30-day cloud trial:
 *     - web access on (feature_flags.web_hosting = true), businesses.web_access_expires_at = activation + 30 days;
 *     - the trial recorded in business_settings 'cloud_trial' { started_at, ends_at, branch_id, started_by, converted_at };
 *     - NO invoice.
 *   Once per client, ever: the 'cloud_trial' row is never deleted, and (business_id, key) is unique, so a second insert
 *   fails even when two licences are activated at the same moment.
 *
 * THE END (lib/cloudPlan.ts cloudStanding; lib/webAccess.ts reads it)
 *   A587 (owner, 2026-10-24: "Yes they get an invoice then as usual"): the trial's end is its DUE day — the billing job
 *   raises and emails an invoice like a paid client's — then the same 7 unpaid days (everything works), then locked:
 *   sign-in refused with "Your cloud trial has ended" (CLOUD_TRIAL_ENDED, the code kept), sync refused, no POS joins.
 *   A569's week of reports only is gone. The owner keeps the quiet notice in the trial's last 7 days (before its end).
 *   Points of sale keep selling.
 *
 * CONVERT TO PAID
 *   A581/A584: Record payment on the Cloud plan (routes/cloudPlanAdmin.ts) marks the trial converted and runs a paid period
 *   from that day; a complimentary paid-until does too. The old "Enable web access" (a year, KES 10,000) is retired —
 *   the cloud refuses a bare enable (WEB_ACCESS_BY_PLAN). "Disable web access" during a trial ends it at once.
 *
 * No migration: business_settings already exists, is unique per (business_id, key), and the key is refused by
 * POST /api/business/settings (READ_ONLY_KEY), so an owner cannot write or reset it.
 */
import { supabase } from './supabase';

export const CLOUD_TRIAL_KEY = 'cloud_trial';
export const TRIAL_DAYS = 30;
/** A569: reports only for this many days after the trial (A587: no longer given — a trial ends like a paid period). Kept for older callers. */
export const TRIAL_REPORTS_ONLY_DAYS = 7;
/** The owner's dashboard shows its notice in the trial's last this-many days. */
export const TRIAL_NOTICE_DAYS = 7;
/** A converted trial's paid term (web access is KES 10,000 a year). */
export const PAID_TERM_YEARS = 1;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface CloudTrial {
  started_at:   string;
  ends_at:      string;
  branch_id:    string | null;
  started_by:   string | null;
  converted_at: string | null;
}

/** 'active' — within the 30 days; 'ended' — after it (A587: invoiced, 7 days, then locked); 'converted' — paid.
 *  'reports_only' is kept in the type for older readers and is no longer given. */
export type TrialPhase = 'active' | 'reports_only' | 'ended' | 'converted';

const isoOrNull = (v: unknown): string | null => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null);

/** A stored value → a trial, or null when it is not one (never throws). */
export function cleanTrial(v: unknown): CloudTrial | null {
  let o: any = v;
  if (typeof o === 'string') { try { o = JSON.parse(o); } catch { return null; } }
  if (!o || typeof o !== 'object') return null;
  const started = isoOrNull(o.started_at), ends = isoOrNull(o.ends_at);
  if (!started || !ends) return null;
  return {
    started_at: started, ends_at: ends,
    branch_id: typeof o.branch_id === 'string' ? o.branch_id : null,
    started_by: typeof o.started_by === 'string' ? o.started_by : null,
    converted_at: isoOrNull(o.converted_at),
  };
}

/** Where a trial stands at `now`. */
export function trialPhase(trial: CloudTrial, now: number = Date.now()): TrialPhase {
  if (trial.converted_at) return 'converted';
  const end = Date.parse(trial.ends_at);
  if (now < end) return 'active';
  return 'ended';   // A587: no week of reports only — the invoice, the 7 days and the lock are the billing rules'
}

export interface TrialFacts {
  /** The client's trial record, if it ever had one. */
  trial: CloudTrial | null;
  /** Branches of the client, OTHER than the one being licensed, that hold a desktop licence. */
  otherLicensedBranches: number;
  /** The client's web_hosting flag row, if any (a row at all means web access was switched before — on or off). */
  webHostingFlag: { enabled: boolean } | null;
  /** businesses.web_access_expires_at — a dated web-access term means it was set up (paid) before. */
  webAccessExpiresAt: string | null;
}

/** Does activating this licence start the client's cloud trial? The reason is for the audit and the tests. */
export function trialEligibility(f: TrialFacts): { eligible: boolean; reason: string } {
  if (f.trial) return { eligible: false, reason: 'had_trial' };
  if (f.otherLicensedBranches > 0) return { eligible: false, reason: 'not_first_licence' };
  if (f.webHostingFlag) return { eligible: false, reason: f.webHostingFlag.enabled ? 'web_access_on' : 'web_access_was_set' };
  if (f.webAccessExpiresAt) return { eligible: false, reason: 'web_access_dated' };
  return { eligible: true, reason: 'first_licence' };
}

/** A new trial starting at `now`. */
export function newTrial(now: number, branchId: string | null, by: string | null): CloudTrial {
  return {
    started_at: new Date(now).toISOString(),
    ends_at: new Date(now + TRIAL_DAYS * DAY_MS).toISOString(),
    branch_id: branchId, started_by: by, converted_at: null,
  };
}

/** One year from `now` (the paid term a conversion starts). */
export function paidTermEnd(now: number): string {
  const d = new Date(now);
  d.setUTCFullYear(d.getUTCFullYear() + PAID_TERM_YEARS);
  return d.toISOString();
}

/**
 * The client's plan in plain words, for the admin portal's client list and header (it read "Plan: None" for every
 * desktop client — no plan rows exist): 'Cloud trial' (in its 30 days), 'Cloud trial ended' (after, not converted),
 * 'Cloud' (web access on, paid), 'Desktop' (a licensed branch, no web), or 'No licence yet'.
 */
export function planLabel(x: { trial: CloudTrial | null; webHosting: boolean; licensedBranches: number; now?: number }): string {
  const phase = x.trial ? trialPhase(x.trial, x.now ?? Date.now()) : null;
  if (phase === 'active') return 'Cloud trial';
  if (phase === 'reports_only' || phase === 'ended') return 'Cloud trial ended';
  if (x.webHosting) return 'Cloud';
  if (x.licensedBranches > 0) return 'Desktop';
  return 'No licence yet';
}

// ── Storage ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The client's trial, or null. A read error is thrown (never "no trial" — that would start a second one). */
export async function readTrial(businessId: string): Promise<CloudTrial | null> {
  const { data, error } = await supabase.from('business_settings').select('value')
    .eq('business_id', businessId).eq('key', CLOUD_TRIAL_KEY).maybeSingle();
  if (error) throw error;
  return cleanTrial((data as { value?: unknown } | null)?.value);
}

/** Trials of several clients at once (the admin's client list). Unreadable → none known (labels only). */
export async function readTrials(businessIds: string[]): Promise<Map<string, CloudTrial>> {
  const out = new Map<string, CloudTrial>();
  if (!businessIds.length) return out;
  const { data, error } = await supabase.from('business_settings').select('business_id, value')
    .eq('key', CLOUD_TRIAL_KEY).in('business_id', businessIds);
  if (error) { console.warn('[cloud-trial] could not read trials for the client list', error.message); return out; }
  for (const r of (data ?? []) as Array<{ business_id: string; value: unknown }>) {
    const t = cleanTrial(r.value);
    if (t) out.set(r.business_id, t);
  }
  return out;
}

export type TrialStart = { started: true; trial: CloudTrial } | { started: false; reason: string };

/**
 * Called after a branch's desktop licence is switched ON. Starts the trial when trialEligibility says so; never throws
 * (a trial that could not start must not undo the licence — the reason says why, and the route audits it).
 */
export async function startTrialIfEligible(p: { businessId: string; branchId: string; by: string | null; now?: number }): Promise<TrialStart> {
  const now = p.now ?? Date.now();
  try {
    const [trial, others, flag, biz] = await Promise.all([
      readTrial(p.businessId),
      supabase.from('branches').select('id', { count: 'exact', head: true })
        .eq('business_id', p.businessId).eq('desktop_licensed', true).neq('id', p.branchId),
      supabase.from('feature_flags').select('enabled').eq('business_id', p.businessId).eq('key', 'web_hosting').maybeSingle(),
      supabase.from('businesses').select('web_access_expires_at').eq('id', p.businessId).maybeSingle(),
    ]);
    if (others.error || flag.error || biz.error) return { started: false, reason: 'read_failed' };
    const verdict = trialEligibility({
      trial,
      otherLicensedBranches: others.count ?? 0,
      webHostingFlag: flag.data ? { enabled: (flag.data as { enabled?: boolean }).enabled === true } : null,
      webAccessExpiresAt: (biz.data as { web_access_expires_at?: string | null } | null)?.web_access_expires_at ?? null,
    });
    if (!verdict.eligible) return { started: false, reason: verdict.reason };

    const t = newTrial(now, p.branchId, p.by);
    // The record first: unique per (business_id, key), so only one of two simultaneous activations gets here.
    const ins = await supabase.from('business_settings').insert({ business_id: p.businessId, key: CLOUD_TRIAL_KEY, value: t });
    if (ins.error) return { started: false, reason: (ins.error as { code?: string }).code === '23505' ? 'had_trial' : 'write_failed' };
    const upd = await supabase.from('businesses').update({ web_access_expires_at: t.ends_at }).eq('id', p.businessId);
    if (upd.error) return { started: false, reason: 'write_failed' };
    const fl = await supabase.from('feature_flags').upsert({
      business_id: p.businessId, key: 'web_hosting', enabled: true,
      notes: `Cloud trial (${TRIAL_DAYS} days, no invoice) — started with the first desktop licence; ends ${t.ends_at.slice(0, 10)}`,
      set_by: p.by, updated_at: new Date(now).toISOString(),
    }, { onConflict: 'business_id,key' });
    if (fl.error) return { started: false, reason: 'write_failed' };
    return { started: true, trial: t };
  } catch (e) {
    console.error('[cloud-trial] could not start the trial', (e as Error)?.message ?? e);
    return { started: false, reason: 'read_failed' };
  }
}

/**
 * The admin switched web access ON (the paid flow): a trial not yet converted is marked converted and the web-access
 * term runs one year from today. null when there is no trial to convert.
 */
export async function convertTrialIfAny(businessId: string, now: number = Date.now()): Promise<{ trial: CloudTrial; expiresAt: string } | null> {
  const trial = await readTrial(businessId);
  if (!trial || trial.converted_at) return null;
  const converted: CloudTrial = { ...trial, converted_at: new Date(now).toISOString() };
  const expiresAt = paidTermEnd(now);
  const s = await supabase.from('business_settings').update({ value: converted, updated_at: new Date(now).toISOString() })
    .eq('business_id', businessId).eq('key', CLOUD_TRIAL_KEY);
  if (s.error) throw s.error;
  const b = await supabase.from('businesses').update({ web_access_expires_at: expiresAt }).eq('id', businessId);
  if (b.error) throw b.error;
  return { trial: converted, expiresAt };
}

/**
 * The plan labels of several clients (the admin's client list): their trials, web_hosting flags and licensed branches in
 * three reads. A read that fails leaves that fact unknown (a label is information, never a gate).
 */
export async function planLabelsFor(businessIds: string[], now: number = Date.now()): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!businessIds.length) return out;
  const [trials, flags, branches] = await Promise.all([
    readTrials(businessIds),
    supabase.from('feature_flags').select('business_id, enabled').eq('key', 'web_hosting').in('business_id', businessIds),
    supabase.from('branches').select('business_id').eq('desktop_licensed', true).in('business_id', businessIds),
  ]);
  const web = new Set(((flags.data ?? []) as Array<{ business_id: string; enabled: boolean }>).filter((f) => f.enabled).map((f) => f.business_id));
  const licensed = new Map<string, number>();
  for (const b of (branches.data ?? []) as Array<{ business_id: string }>) licensed.set(b.business_id, (licensed.get(b.business_id) ?? 0) + 1);
  for (const id of businessIds) {
    out.set(id, planLabel({ trial: trials.get(id) ?? null, webHosting: web.has(id), licensedBranches: licensed.get(id) ?? 0, now }));
  }
  return out;
}
