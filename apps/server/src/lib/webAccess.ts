// Web access state — the single source of truth for whether a business may use
// the cloud web portal, and to what degree.
//
// Web access is the recurring product (10k/yr, per business). Its state is
// derived from businesses.web_access_expires_at so there is one clock, not a
// stored status that can drift:
//
//   active        — within the paid term. Full portal.
//   grace         — up to ~3 weeks past expiry. Still full portal (soft landing).
//   reports_only  — the following ~1 week. Portal management locked; reports readable.
//   locked        — beyond that. Login blocked; "Renew licence" banner.
//   none          — never subscribed / explicitly disabled. Login blocked.
//
// Offline desktop POS is NOT affected by any of this — desktop tills keep selling
// regardless of web-access state (a till's own session, /api/auth/enrol/redeem, does not gate).
//
// Transition safety: if web_access_expires_at is NULL, we fall back to the legacy
// feature_flags.web_hosting boolean, so existing accounts behave exactly as before
// until a renewal date is set.
//
// A569 — a CLOUD TRIAL (lib/cloudTrial.ts: 30 days from the first desktop licence, no invoice) has its own, shorter
// ladder: active until the trial's end, then reports_only for 7 days (no 21-day grace), then locked with
// "Your cloud trial has ended" (CLOUD_TRIAL_ENDED). "Disable web access" during a trial ends it at once (none).
// A converted trial (the admin's "Enable web access") is an ordinary paid term again.

import { supabase } from './supabase';
import { CLOUD_TRIAL_KEY, TRIAL_REPORTS_ONLY_DAYS, cleanTrial, type CloudTrial } from './cloudTrial';

export type WebAccessState = 'active' | 'grace' | 'reports_only' | 'locked' | 'none';

// Days past expiry for each step of the renewal ladder.
export const GRACE_DAYS         = 21; // full access after expiry
export const REPORTS_ONLY_DAYS  = 28; // = grace + ~1 week reports-only, then locked

export interface WebAccess {
  state:      WebAccessState;
  expiresAt:  string | null;
  // True when the portal should still be fully usable (active or grace).
  fullAccess: boolean;
  // True when login is permitted at all (anything except locked/none).
  canLogin:   boolean;
  // A569: on a cloud trial not yet converted to paid (its end is expiresAt).
  trial?:     boolean;
}

/**
 * A569: the ladder state at `now` for an expiry — a paid term (21 days' grace, then a week of reports only) or a trial
 * (no grace: a week of reports only straight after its end). Pure; getWebAccess reads the dates.
 */
export function ladderState(expiresAt: string, now: number, trial = false): WebAccessState {
  const expiry  = new Date(expiresAt).getTime();
  const grace   = expiry + (trial ? 0 : GRACE_DAYS) * DAY_MS;
  const readEnd = expiry + (trial ? TRIAL_REPORTS_ONLY_DAYS : REPORTS_ONLY_DAYS) * DAY_MS;
  if (now < expiry)  return 'active';
  if (now < grace)   return 'grace';
  if (now < readEnd) return 'reports_only';
  return 'locked';
}

/**
 * A569: why sign-in is refused, in words (auth.ts answers it on every web sign-in). A lapsed trial says so — not
 * "your subscription has expired", which it never was.
 */
export function webAccessRefusal(w: WebAccess): { error: string; code: string } {
  if (w.state === 'locked' && w.trial) {
    return { error: 'Your cloud trial has ended. Contact ZapTill to keep the web dashboard — your tills keep working.', code: 'CLOUD_TRIAL_ENDED' };
  }
  return w.state === 'locked'
    ? { error: 'Your web portal subscription has expired. Please renew to continue.', code: 'WEB_ACCESS_EXPIRED' }
    : { error: 'Web portal access is not enabled for your account. Please contact ZapTill to upgrade.', code: 'WEB_HOSTING_REQUIRED' };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Resolve a business's current web-access state.
 * `suspended` businesses are always locked (hard off-switch), independent of dates.
 */
export async function getWebAccess(
  businessId: string,
  businessStatus?: string,
): Promise<WebAccess> {
  if (businessStatus === 'suspended') {
    return { state: 'locked', expiresAt: null, fullAccess: false, canLogin: false };
  }

  const [{ data: biz }, { data: trialRow }] = await Promise.all([
    supabase
      .from('businesses')
      .select('web_access_expires_at')
      .eq('id', businessId)
      .maybeSingle(),
    // A569: a trial not yet converted runs on its own ladder (a failed read: no trial known — the paid ladder, as before).
    supabase
      .from('business_settings')
      .select('value')
      .eq('business_id', businessId)
      .eq('key', CLOUD_TRIAL_KEY)
      .maybeSingle(),
  ]);

  const expiresAt: string | null = biz?.web_access_expires_at ?? null;
  const trialRec: CloudTrial | null = cleanTrial((trialRow as { value?: unknown } | null)?.value);
  const onTrial = !!trialRec && !trialRec.converted_at;

  // ── Legacy path: no dated subscription yet → honour the old boolean flag ──
  if (!expiresAt) {
    const { data: flag } = await supabase
      .from('feature_flags')
      .select('enabled')
      .eq('business_id', businessId)
      .eq('key', 'web_hosting')
      .maybeSingle();
    const enabled = !!flag?.enabled;
    return {
      state:      enabled ? 'active' : 'none',
      expiresAt:  null,
      fullAccess: enabled,
      canLogin:   enabled,
    };
  }

  // ── A569: a trial the admin switched off ("Disable web access") is over at once ──
  if (onTrial) {
    const { data: flag } = await supabase
      .from('feature_flags')
      .select('enabled')
      .eq('business_id', businessId)
      .eq('key', 'web_hosting')
      .maybeSingle();
    if (flag && !flag.enabled) {
      return { state: 'none', expiresAt, fullAccess: false, canLogin: false, trial: true };
    }
  }

  // ── Dated path: derive the ladder state from now() vs expiry ──
  const state = ladderState(expiresAt, Date.now(), onTrial);

  return {
    state,
    expiresAt,
    fullAccess: state === 'active' || state === 'grace',
    canLogin:   state !== 'locked',
    ...(onTrial ? { trial: true } : {}),
  };
}
