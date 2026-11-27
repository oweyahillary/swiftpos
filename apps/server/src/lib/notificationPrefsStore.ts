/**
 * notificationPrefs.ts — A627 W3: the server side of per-person EMAIL alert preferences (migration 200,
 * user_notification_prefs). Service role only. An ABSENT row means ON; a row with email_enabled=false is an opt-out that
 * silences that one alert for that one person, overriding the automatic include (reports.overview / the owner).
 *
 * The email jobs (dailySummary, lowStockChecker, ownerAlerts) carry EMAIL addresses, so the enforcement helper resolves the
 * opted-out user ids to their lowercased e-mails: each job then drops them from its recipient list in one line. The staff
 * route reads/writes the raw per-user rows.
 */
import { supabase } from './supabase';
import { NOTIFICATION_ALERT_KEYS } from '@zaptill/core/notificationPrefs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The user ids at a business that have turned OFF this alert (email_enabled=false). Absent row = on. */
export async function optedOutUserIds(businessId: string, alertType: string): Promise<Set<string>> {
  const { data, error } = await supabase.from('user_notification_prefs')
    .select('user_id').eq('business_id', businessId).eq('alert_type', alertType).eq('email_enabled', false);
  if (error) return new Set();   // a read failure must never silence everyone — fall back to "nobody opted out"
  return new Set(((data ?? []) as Array<{ user_id: string }>).map((r) => r.user_id));
}

/**
 * The lowercased e-mail addresses to DROP from an alert's recipient list — the people (the owner and/or staff) who opted
 * out of this alert. A job filters its recipients with `recipients.filter(e => !dropped.has(e.toLowerCase()))`. On any
 * read failure this is empty, so an opt-out never hides an alert from everyone by accident.
 */
export async function emailOptedOut(businessId: string, ownerId: string | null, alertType: string): Promise<Set<string>> {
  const ids = await optedOutUserIds(businessId, alertType);
  if (!ids.size) return new Set();
  const emails = new Set<string>();
  // The owner is not a users row — resolve their auth e-mail.
  if (ownerId && ids.has(ownerId) && UUID_RE.test(ownerId)) {
    try {
      const { data, error } = await supabase.auth.admin.getUserById(ownerId);
      const e = !error ? data?.user?.email?.trim().toLowerCase() : null;
      if (e) emails.add(e);
    } catch { /* ignore — the owner keeps their mail if we cannot resolve it */ }
  }
  const staffIds = [...ids].filter((id) => id !== ownerId);
  if (staffIds.length) {
    const { data } = await supabase.from('users').select('id, email').eq('business_id', businessId).in('id', staffIds);
    for (const u of (data ?? []) as Array<{ id: string; email: string | null }>) {
      const e = (u.email ?? '').trim().toLowerCase();
      if (e.includes('@')) emails.add(e);
    }
  }
  return emails;
}

/** A person's current prefs as a full map (every known alert → enabled), defaulting ON where no row exists. */
export async function prefsFor(businessId: string, userId: string): Promise<Record<string, boolean>> {
  const out: Record<string, boolean> = {};
  for (const k of NOTIFICATION_ALERT_KEYS) out[k] = true;
  const { data, error } = await supabase.from('user_notification_prefs')
    .select('alert_type, email_enabled').eq('business_id', businessId).eq('user_id', userId);
  // A627: a read failure (e.g. the table is missing on this environment) must stay fail-safe — show every alert ON rather
  // than hide one — but never silently: log it, or a broken DB layer looks exactly like "nobody opted out".
  if (error) { console.error('[notificationPrefs] prefsFor read failed — showing all alerts on', { businessId, userId }, error.message); return out; }
  for (const r of (data ?? []) as Array<{ alert_type: string; email_enabled: boolean }>) {
    if (r.alert_type in out) out[r.alert_type] = r.email_enabled !== false;
  }
  return out;
}

/** Upsert one person's pref for one alert. Only known alert keys are written. */
export async function setPref(businessId: string, userId: string, alertType: string, enabled: boolean, by: string | null): Promise<void> {
  if (!NOTIFICATION_ALERT_KEYS.includes(alertType)) return;
  const { error } = await supabase.from('user_notification_prefs').upsert(
    { business_id: businessId, user_id: userId, alert_type: alertType, email_enabled: enabled, updated_at: new Date().toISOString(), updated_by: by },
    { onConflict: 'user_id,alert_type' },
  );
  // A627: NEVER swallow a write failure. A silent fail here answered the browser {ok:true} while nothing was stored — so a
  // toggle sprang back ON on reload, and worse, if it HAD stored, mail could stop while the screen still read ON. Throw so
  // the PUT route returns an error and the toggle shows it, instead of lying that the change was saved.
  if (error) throw new Error(`could not save notification pref (${alertType}): ${error.message}`);
}
