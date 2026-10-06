/**
 * tillSessions.ts — A407: a till's sign-in is never lost by accident.
 *
 * Owner, 2026-10-05 (Pollo Fried Chicken: a till on the PIN screen with "Please sign in again."): "how do we prevent
 * this from ever happening". Until A415 a till signed in as the owner — its refresh token carried the owner's user id —
 * so anything that revoked "the owner's sessions" also revoked the till's:
 *   - the owner signing in on that till with their PIN (verify-pin revoked "this user on this device"),
 *   - a password change or reset (A402), "log out everywhere".
 * The till could not sign itself back in, so a person had to bring a new enrolment code.
 *
 * Now every session says what it is (refresh_tokens.session_kind, migration 125):
 *   device — the till itself (enrolment, device-token, and their renewals): revoked ONLY by blocking the till;
 *   pin    — a person signed in on a till with a PIN;
 *   web    — a browser (dashboard, web POS, admin).
 * scripts/check-till-sessions.mjs fails the build if a revoke of many sessions does not go through here or say why it
 * is till-safe.
 */
import { supabase } from './supabase';

export type SessionKind = 'device' | 'pin' | 'web';

/** What a token is, from its payload. A PIN sign-in on a till carries pinSignIn; the till itself is surface 'desktop'.
 *  A415: the till's own session names no person (refresh_tokens.user_id is null), so a revoke by person never finds it. */
export function sessionKind(p: { surface?: string | null; pinSignIn?: boolean | null } | null | undefined): SessionKind {
  if (p?.pinSignIn) return 'pin';
  if (p?.surface === 'desktop') return 'device';
  return 'web';
}

/** May this live session be revoked by an owner-level action? Never a till's own (by kind, or — rows from before
 *  migration 125 — because it names one of the business's enrolled devices). */
export function ownerActionMayRevoke(row: { session_kind?: string | null; device_hint?: string | null; session_id?: string | null },
  tills: Set<string>, keepSession?: string | null): boolean {
  if (row.session_kind === 'device') return false;
  if (row.device_hint && tills.has(row.device_hint)) return false;
  if (keepSession && row.session_id === keepSession) return false;
  return true;
}

/**
 * Sign these users out of every BROWSER (and every PIN sign-in), never a till: password change / reset, "log out
 * everywhere". `keepSession` = the browser that asked (stays signed in). Returns how many were revoked.
 */
export async function revokeBrowserSessions(userIds: string[], businessIds: string[], keepSession?: string | null): Promise<number> {
  if (!userIds.length) return 0;
  const tills = new Set<string>();
  if (businessIds.length) {
    const { data: devs } = await supabase.from('user_devices').select('device_id').in('business_id', businessIds);
    for (const d of (devs ?? []) as Array<{ device_id: string | null }>) if (d.device_id) tills.add(d.device_id);
  }
  const { data: live } = await supabase.from('refresh_tokens').select('id, session_id, device_hint, session_kind')
    .in('user_id', userIds).is('revoked_at', null);
  const ids = ((live ?? []) as Array<{ id: string; session_id: string | null; device_hint: string | null; session_kind?: string | null }>)
    .filter((t) => ownerActionMayRevoke(t, tills, keepSession)).map((t) => t.id);
  // till-safe: by id, only the rows ownerActionMayRevoke allowed
  if (ids.length) await supabase.from('refresh_tokens').update({ revoked_at: new Date().toISOString() }).in('id', ids);
  return ids.length;
}

/** A till could not sign itself back in — the watchdog emails it (critical) until it is back. */
export async function markTillSessionLost(businessId: string, deviceId: string, reason: string): Promise<void> {
  try {
    await supabase.from('user_devices').update({ session_lost_at: new Date().toISOString(), session_lost_reason: reason.slice(0, 200) })
      .eq('business_id', businessId).eq('device_id', deviceId).is('session_lost_at', null);
  } catch { /* before migration 125 — the till still gets its answer */ }
}

/** The till is signed in again (device secret, a new enrolment code, a healthy renewal) — the alert clears. */
export async function clearTillSessionLost(businessId: string, deviceId: string): Promise<void> {
  try {
    await supabase.from('user_devices').update({ session_lost_at: null, session_lost_reason: null })
      .eq('business_id', businessId).eq('device_id', deviceId).not('session_lost_at', 'is', null);
  } catch { /* before migration 125 */ }
}
