/**
 * adminAlerts.ts — A589: the admin's alert settings and the admin portal's bell, in the database (migration 174).
 *
 *   readAlertSettings()      public.admin_settings 'alert_settings' (cached a minute) → lib/adminAlertPolicy.ts defaults
 *                            for anything missing; a cloud before migration 174, or a failed read: the defaults.
 *   saveAlertSettings()      a super admin's change (routes/admin.ts PUT /alert-settings).
 *   addAdminNotifications()  rows for the bell (public.admin_notifications); a failed write is logged, never thrown.
 *   digest state             the Nairobi date the morning digest was last sent — once a day, across restarts.
 * Never throws: the alerts must keep working when this table is not there yet.
 */
import { supabase } from './supabase';
import { normalizeAlertSettings, type AlertSettings, type NotificationRow } from './adminAlertPolicy';

const SETTINGS_KEY = 'alert_settings';
const DIGEST_KEY = 'digest_state';
const CACHE_MS = 60_000;
let cache: { at: number; value: AlertSettings } | null = null;

export function forgetAlertSettings(): void { cache = null; }

export async function readAlertSettings(now = Date.now()): Promise<AlertSettings> {
  if (cache && now - cache.at < CACHE_MS) return cache.value;
  let value = normalizeAlertSettings(null);
  try {
    const { data, error } = await supabase.from('admin_settings').select('value').eq('key', SETTINGS_KEY).maybeSingle();
    if (!error && data) value = normalizeAlertSettings((data as { value: unknown }).value);
  } catch { /* the defaults */ }
  cache = { at: now, value };
  return value;
}

export async function saveAlertSettings(value: AlertSettings, by: string | null): Promise<{ ok: boolean; error?: string }> {
  const { error } = await supabase.from('admin_settings')
    .upsert({ key: SETTINGS_KEY, value, updated_by: by, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  forgetAlertSettings();
  return error ? { ok: false, error: error.message } : { ok: true };
}

export async function addAdminNotifications(rows: NotificationRow[], now = new Date()): Promise<boolean> {
  if (!rows.length) return true;
  try {
    // business_id: each row carries its client's business_id (null for a cloud-wide problem).
    const { error } = await supabase.from('admin_notifications').insert(rows.map((r) => ({ ...r, created_at: now.toISOString() })));
    if (error) { console.warn('[alerts] the admin notifications were not stored (migration 174?):', error.message); return false; }
    return true;
  } catch (err: any) {
    console.warn('[alerts] the admin notifications were not stored:', err?.message ?? err);
    return false;
  }
}

let lastDigestDate: string | null = null;

export async function readDigestDate(): Promise<string | null> {
  if (lastDigestDate) return lastDigestDate;
  try {
    const { data } = await supabase.from('admin_settings').select('value').eq('key', DIGEST_KEY).maybeSingle();
    const d = (data as { value?: { last_date?: unknown } } | null)?.value?.last_date;
    if (typeof d === 'string') lastDigestDate = d;
  } catch { /* none */ }
  return lastDigestDate;
}

export async function writeDigestDate(date: string): Promise<void> {
  lastDigestDate = date;
  try {
    await supabase.from('admin_settings').upsert({ key: DIGEST_KEY, value: { last_date: date }, updated_by: 'watchdog', updated_at: new Date().toISOString() }, { onConflict: 'key' });
  } catch { /* in memory still keeps it to once */ }
}

/** For tests. */
export function forgetDigestDate(): void { lastDigestDate = null; }
