/**
 * notificationPrefs.ts — A627 W3 (owner, 2026-11-26: "people who receive daily mails … not every general manager and owner
 * loves to see emails daily" + "disable for a specific person, I can't find the UI"): the EMAIL alerts a person can be
 * opted out of, each gated by the right that lets them see the underlying data.
 *
 * The single source of truth for the cloud (the email jobs + the staff route) and the dashboard (the staff card's "Email
 * alerts" toggles). An ABSENT preference row means ON — the person still receives it, exactly as before W3 — so nothing
 * changes for anyone until they opt out; a row with email_enabled=false silences that one alert for that one person,
 * overriding the automatic include. A person is only offered (and only ever receives) an alert whose permission they hold.
 *
 * Pure: no imports.
 */
export interface NotificationAlert {
  key: string;
  label: string;
  description: string;
  /** A person is offered and receives this alert only if they hold this permission (or '*'). */
  permission: string;
}

export const NOTIFICATION_ALERTS: readonly NotificationAlert[] = [
  { key: 'daily_summary', label: 'Daily summary', description: 'The end-of-day sales summary e-mail.', permission: 'reports.overview' },
  { key: 'low_stock', label: 'Low-stock alerts', description: 'An e-mail when a product runs low or sells past its stock.', permission: 'reports.inventory' },
  { key: 'owner_alert', label: 'Operations alerts', description: 'A POS left open at close, a failed backup and other operations alerts.', permission: 'reports.overview' },
];

export const NOTIFICATION_ALERT_KEYS: readonly string[] = NOTIFICATION_ALERTS.map((a) => a.key);
const BY_KEY = new Map(NOTIFICATION_ALERTS.map((a) => [a.key, a]));

/** Is this a known alert key? */
export function isNotificationAlert(key: unknown): key is string {
  return typeof key === 'string' && BY_KEY.has(key);
}

/** May a person who holds `heldKeys` receive `alertKey` (they hold its permission, or '*')? */
export function alertAppliesTo(alertKey: string, heldKeys: ReadonlySet<string> | readonly string[]): boolean {
  const a = BY_KEY.get(alertKey);
  if (!a) return false;
  const has = (k: string) => (Array.isArray(heldKeys) ? (heldKeys as readonly string[]).includes(k) : (heldKeys as ReadonlySet<string>).has(k));
  return has('*') || has(a.permission);
}

/** The alerts a person who holds `heldKeys` may receive — what the staff card shows and the route returns. */
export function alertsForKeys(heldKeys: ReadonlySet<string> | readonly string[]): NotificationAlert[] {
  return NOTIFICATION_ALERTS.filter((a) => alertAppliesTo(a.key, heldKeys));
}
