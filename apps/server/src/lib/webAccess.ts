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
// regardless of web-access state (see /api/auth/desktop-login, which does not gate).
//
// Transition safety: if web_access_expires_at is NULL, we fall back to the legacy
// feature_flags.web_hosting boolean, so existing accounts behave exactly as before
// until a renewal date is set.

import { supabase } from './supabase';

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

  const { data: biz } = await supabase
    .from('businesses')
    .select('web_access_expires_at')
    .eq('id', businessId)
    .maybeSingle();

  const expiresAt: string | null = biz?.web_access_expires_at ?? null;

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

  // ── Dated path: derive the ladder state from now() vs expiry ──
  const now     = Date.now();
  const expiry  = new Date(expiresAt).getTime();
  const grace   = expiry + GRACE_DAYS * DAY_MS;
  const readEnd = expiry + REPORTS_ONLY_DAYS * DAY_MS;

  let state: WebAccessState;
  if (now < expiry)        state = 'active';
  else if (now < grace)    state = 'grace';
  else if (now < readEnd)  state = 'reports_only';
  else                     state = 'locked';

  return {
    state,
    expiresAt,
    fullAccess: state === 'active' || state === 'grace',
    canLogin:   state !== 'locked',
  };
}
