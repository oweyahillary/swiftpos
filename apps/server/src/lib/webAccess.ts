// Web access state — the single source of truth for whether a business may use
// the cloud web portal, and to what degree.
//
// Its state is derived from businesses.web_access_expires_at (the cloud plan's paid-until) so there is one clock, not a
// stored status that can drift. A584 (2026-10-23) — owner: "after 7 days the access gets revoked immediately, no warning
// for web". The paid ladder (lib/billingClock.ts, Nairobi days):
//
//   active        — within the paid period. Full portal.
//   grace         — the 7 unpaid days after the due date (A584: no longer 21). Full portal, and NOTHING on the dashboard
//                   says so — the client has the invoice; ZapTill has the admin notices.
//   locked        — from the end of the 7th unpaid day. Sign-in refused and every web request answered 403
//                   CLOUD_ACCESS_PAUSED: "Your ZapTill cloud access is paused. Call 0717 675 635 to renew."
//   none          — never subscribed / explicitly disabled. Login blocked.
//   (reports_only — a cloud TRIAL's week after its end only — A569; paid clients have no reports-only stage any more.)
//
// Offline desktop POS is NOT affected by any of this — desktop tills keep selling regardless of web-access state.
//
// Transition safety: if web_access_expires_at is NULL, we fall back to the legacy feature_flags.web_hosting boolean, so
// those accounts behave exactly as before ("No expiry set" in the admin portal — A584). A dated business that the billing
// job has not yet bridged onto a plan (A584) is never locked meanwhile.
//
// A569 — a CLOUD TRIAL (lib/cloudTrial.ts: 30 days from the first desktop licence, no invoice). A587 (owner, 2026-10-24:
// "they get an invoice then as usual"): at its end it is invoiced like a paid client (due on the end day), keeps the 7
// unpaid days with full access, then locks with "Your cloud trial has ended" (CLOUD_TRIAL_ENDED — the code kept). The
// reports-only week (A569) is gone. "Disable web access" during a trial ends it at once (none). A trial converted by a
// recorded payment (A581) is an ordinary paid term.
// A587 (decision 5): "Disable web access" on any dated / planned business is a hard off at once (locked).

import { readCloudFacts, cloudStanding, PAUSED_WORDS, TRIAL_ENDED_WORDS, type CloudFacts } from './cloudPlan';
import { DAY_MS, effectiveDue, paidState, UNPAID_DAYS } from './billingClock';

export type WebAccessState = 'active' | 'grace' | 'reports_only' | 'locked' | 'none';

/** A584: the unpaid days a paid client keeps full access after its due date (was a 21-day grace, then a reports-only week). */
export const GRACE_DAYS = UNPAID_DAYS;

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
 * The ladder state at `now`: a paid term (A584: the 7 unpaid days, then locked at the end of the 7th, Nairobi) — and, A587,
 * a trial the same way from its end (A569's week of reports only is gone). `billingFrom` — the day the business was put on its
 * plan — moves a due date that had already passed then to that day. Pure; getWebAccess reads the dates.
 */
export function ladderState(expiresAt: string, now: number, trial = false, billingFrom: string | null = null): WebAccessState {
  // A587: a trial ends like a paid period (its end is the due day) — no reports-only week any more.
  const p = paidState(trial ? expiresAt : effectiveDue(expiresAt, billingFrom), now);
  return p === 'active' ? 'active' : p === 'unpaid' ? 'grace' : 'locked';
}

/**
 * Why sign-in is refused, in words (auth.ts answers it on every web sign-in). A lapsed trial says so; a paid client that
 * is locked reads the plain paused words (A584 — no blame, no dates).
 */
export function webAccessRefusal(w: WebAccess): { error: string; code: string } {
  if (w.state === 'locked' && w.trial) return { error: TRIAL_ENDED_WORDS, code: 'CLOUD_TRIAL_ENDED' };
  return w.state === 'locked'
    ? { error: PAUSED_WORDS, code: 'CLOUD_ACCESS_PAUSED' }
    : { error: 'Web portal access is not enabled for your account. Please contact ZapTill to upgrade.', code: 'WEB_HOSTING_REQUIRED' };
}

/** The web access of a business from its facts at `now` — the same standing the till gate and the billing job read. Pure. */
export function webAccessFor(f: CloudFacts, now: number = Date.now()): WebAccess {
  const expiresAt = f.expiresAt && Number.isFinite(Date.parse(f.expiresAt)) ? f.expiresAt : null;
  // ── Legacy path: no dated subscription → honour the old boolean flag ("No expiry set") ──
  if (!expiresAt) {
    const enabled = f.webHosting === true;
    return { state: enabled ? 'active' : 'none', expiresAt: null, fullAccess: enabled, canLogin: enabled };
  }
  const s = cloudStanding(f, now);
  // "End trial" (web access switched off during a trial): at once, as A569.
  if (s.trial && s.state === 'ended') return { state: 'none', expiresAt, fullAccess: false, canLogin: false, trial: true };
  // A587: a trial ends like a paid period (its 7 unpaid days after its end, then locked — CLOUD_TRIAL_ENDED); a client
  // switched off by the admin ('off', a hard off) or "Not interested" is locked like any unpaid one.
  const state: WebAccessState = s.state === 'locked' || s.state === 'not_interested' || s.state === 'off' ? 'locked'
    : s.state === 'unpaid' ? 'grace' : 'active';
  return { state, expiresAt, fullAccess: state === 'active' || state === 'grace', canLogin: state !== 'locked', ...(s.trial ? { trial: true } : {}) };
}

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
  const f = (await readCloudFacts([businessId])).get(businessId);
  if (!f) return { state: 'none', expiresAt: null, fullAccess: false, canLogin: false };
  if (f.suspended) return { state: 'locked', expiresAt: null, fullAccess: false, canLogin: false };
  return webAccessFor(f);
}

export { DAY_MS };
