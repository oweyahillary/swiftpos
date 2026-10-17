/**
 * tillSync.ts — A522: how the web says when a till was last heard from, before it acts for that till.
 *
 * Owner, 2026-10-17: "nothing may wait on a till that is switched off". The web may close a drawer or a day while the till
 * is off — it says so first: "T2 last synced 3 h ago — its sales since then are not in this close; it applies this when it
 * next connects". A till syncs about every 90 s while it is on; one heard from within RECENT_SYNC_MIN is current.
 */

/** A till heard from within this long is "recent" — no warning before acting for it. */
export const RECENT_SYNC_MIN = 15;

/** "3 h ago", "12 min ago", "never". */
export function agoLabel(iso: string | null | undefined, now = Date.now()): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return 'never';
  const min = Math.max(0, Math.round((now - t) / 60_000));
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

export function syncRecent(iso: string | null | undefined, now = Date.now()): boolean {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) && now - t < RECENT_SYNC_MIN * 60_000;
}

/** The warning before closing for a till that is not recent — null when it is. */
export function tillBehindLine(till: string, lastSyncAt: string | null | undefined, now = Date.now()): string | null {
  if (syncRecent(lastSyncAt, now)) return null;
  const when = lastSyncAt ? `last synced ${agoLabel(lastSyncAt, now)}` : 'has never synced';
  return `${till} ${when} — its sales since then are not in this close; it applies this when it next connects.`;
}
