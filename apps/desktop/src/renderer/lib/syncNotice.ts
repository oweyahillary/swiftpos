/**
 * syncNotice.ts — who sees the till's sync status, and what it says (A363, desktop 0.6.20).
 *
 * Owner, 2026-09-29: the cashier should not be shown sync internals — "we lock it under the manager? they can get a
 * small notification at the bottom with a resync option"; then, on a till that is offline for long: "that message
 * will be confusing". Agreed design:
 *   - Cashier: nothing. Selling, cash and M-Pesa (a typed code at the till) all work the same offline.
 *   - Manager / owner: a small notice at the bottom only when something waits ("4 sales waiting to sync · last synced
 *     today 10:15 · Sync now"), turning red when the cloud REFUSED something (this morning's case, which reached only
 *     the Tech screen) or sales failed; and a neutral "Last synced" line on the manager screen.
 *   - No "offline for N hours" nag — it would fire forever on a quiet till and teach people to ignore the red one.
 *   - Z-report: says what of the shift is not on the cloud yet (owner: "add the note on the zreport").
 */

export interface SyncStatusLike {
  online: boolean;
  pendingCount: number;
  failedCount: number;
  failedReason?: string;
  /** Records the cloud refused and the till parked (a drawer, a trading day, a float, an expense). */
  parkedCount?: number;
  parkedReason?: string;
  /** The last moment this till had nothing waiting for the cloud (ISO), or null if never. */
  lastSyncedAt?: string | null;
}

interface StaffLike { role?: string | null; permissions?: Record<string, boolean> | null }

/** Managers, supervisors and the owner — never a cashier. */
export function maySeeSync(staff: StaffLike | null | undefined): boolean {
  if (!staff) return false;
  const p = staff.permissions ?? {};
  if (p['*'] === true) return true;
  if (p['settings.manage'] === true || p['shifts.manage'] === true || p['orders.void'] === true) return true;
  return /\b(owner|manager|supervisor|admin)\b/i.test(staff.role ?? '');
}

const two = (n: number) => String(n).padStart(2, '0');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "today 10:15", "yesterday 18:02", "28 Sep 18:02", or "never" — in the till's local time. */
export function lastSyncedLabel(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return 'never';
  const t = new Date(iso);
  if (isNaN(t.getTime())) return 'never';
  const hm = `${two(t.getHours())}:${two(t.getMinutes())}`;
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((day(now) - day(t)) / 86_400_000);
  if (diff === 0) return `today ${hm}`;
  if (diff === 1) return `yesterday ${hm}`;
  return `${t.getDate()} ${MONTHS[t.getMonth()]} ${hm}`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export type SyncNotice =
  | { tone: 'alert'; text: string; action: 'retry-failed' | 'sync' }
  | { tone: 'quiet'; text: string; action: 'sync' };

/** The manager's bottom notice, or null when nothing waits. Refusals first — they need a person; failures next. */
export function syncNotice(s: SyncStatusLike, now: Date = new Date()): SyncNotice | null {
  const last = `last synced ${lastSyncedLabel(s.lastSyncedAt, now)}`;
  if ((s.parkedCount ?? 0) > 0) {
    return { tone: 'alert', action: 'sync',
      text: `The cloud refused ${plural(s.parkedCount!, 'record')}${s.parkedReason ? `: ${s.parkedReason}` : ''} · ${last}` };
  }
  if (s.failedCount > 0) {
    return { tone: 'alert', action: 'retry-failed',
      text: `${plural(s.failedCount, 'sale')} failed to sync${s.failedReason ? `: ${s.failedReason}` : ''} · ${last}` };
  }
  if (s.pendingCount > 0) {
    return { tone: 'quiet', action: 'sync',
      text: `${plural(s.pendingCount, 'record')} waiting to sync${s.online ? '' : ' (offline)'} · ${last}` };
  }
  return null;
}

/** The Z-report's line when part of the shift is not on the cloud yet; null when all of it is. */
export function zBackupNote(n: { sales: number; drawerRefused: boolean } | null | undefined): string | null {
  if (!n) return null;
  if (n.drawerRefused) return 'NOT BACKED UP: the cloud refused this shift — a manager must check the sync notice.';
  if (n.sales > 0) return `NOT BACKED UP YET: ${plural(n.sales, 'sale')} of this shift ${n.sales === 1 ? 'is' : 'are'} only on this till until it syncs.`;
  return null;
}
