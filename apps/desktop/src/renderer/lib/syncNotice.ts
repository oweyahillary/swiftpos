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
  /** A448: the branch server refused this till — nothing reaches the cloud through it until it is fixed. A501: and why
   *  (an older main process sends no reason: the access code, as before). */
  nodeRefused?: { status: number; since: string; reason?: 'access_code' | 'device_key' | 'branch' | 'tls' } | null;
  /** A501: what this till still owes its branch server (computed for years, shown nowhere). */
  nodeBacklog?: { pending: number; failed: number; oldestPendingAt?: string | null; failedReason?: string | null };
  /** A529: the cloud could not be reached on the last try — no answer, its 5xx, or another server's page (a suspended
   *  Render service, a Cloudflare page, a captive portal). Sales left 'failed' by the line are counted as waiting
   *  (syncEngine getSyncStatus), so an outage is never red. */
  cloudUnreachable?: { since: string; why: string } | null;
  /** A581: the cloud refuses this business's sync — its ZapTill cloud plan lapsed (records stay queued on the till). */
  cloudLapsed?: { since: string; message?: string } | null;
}

/** A501: records waiting this long for the branch server are worth a manager's line (the beat sends every 15 s). */
export const NODE_BACKLOG_QUIET_MS = 10 * 60_000;

/** A501: what the branch server refused, in words that point at the right fix (it always said "access code"). */
export function nodeRefusalText(reason: string | undefined): string {
  switch (reason) {
    case 'device_key': return 'The branch server does not recognise this till (its device key) — sales are kept on this till but reach nothing else. A technician rejoins it from the branch server (Find my server)';
    case 'branch': return 'This till is set to another branch than its branch server — sales are kept on this till but do not reach the branch server. A technician checks it (Tech › Branch sync)';
    case 'tls': return "The branch server refused this till's unencrypted connection — sales are kept on this till but reach nothing else. A technician checks it (Tech › Shop network)";
    default: return "The branch server refused this till's access code — sales are kept on this till but reach nothing else. A technician re-enters the code (Install › Branch access code)";
  }
}

// A490: WHO sees it is lib/access.ts backOffice(session) — anyone beyond the shop floor, or the owner; never a cashier.
// (It was maySeeSync: a role-name pattern and three broad keys.)

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
  // A581: the business's cloud plan lapsed — the cloud refuses its sync until it is paid; nothing is lost.
  if (s.cloudLapsed) {
    return { tone: 'alert', action: 'sync',
      text: `ZapTill cloud subscription ended — ${plural(s.pendingCount, 'record')} kept on this till, sent when renewed (ZapTill 0717 675 635) · ${last}` };
  }
  // A448: first — it stops everything reaching the cloud, and only a person can fix it (before: the log alone said so).
  if (s.nodeRefused) {
    return { tone: 'alert', action: 'sync', text: `${nodeRefusalText(s.nodeRefused.reason)} · ${last}` };
  }
  if ((s.parkedCount ?? 0) > 0) {
    return { tone: 'alert', action: 'sync',
      text: `The cloud refused ${plural(s.parkedCount!, 'record')}${s.parkedReason ? `: ${s.parkedReason}` : ''} · ${last}` };
  }
  if (s.failedCount > 0) {
    return { tone: 'alert', action: 'retry-failed',
      text: `${plural(s.failedCount, 'sale')} failed to sync${s.failedReason ? `: ${s.failedReason}` : ''} · ${last}` };
  }
  // A501: records the branch server refused (after five tries) — the other tills and the branch report lack them.
  if ((s.nodeBacklog?.failed ?? 0) > 0) {
    return { tone: 'alert', action: 'sync',
      text: `The branch server refused ${plural(s.nodeBacklog!.failed, 'record')}${s.nodeBacklog!.failedReason ? `: ${s.nodeBacklog!.failedReason}` : ''} — a technician retries them (Tech › Branch sync) · ${last}` };
  }
  const nodeWaiting = s.nodeBacklog && s.nodeBacklog.pending > 0 && s.nodeBacklog.oldestPendingAt
    && now.getTime() - new Date(s.nodeBacklog.oldestPendingAt).getTime() > NODE_BACKLOG_QUIET_MS ? s.nodeBacklog.pending : 0;
  if (s.pendingCount > 0) {
    // A529 (owner, 2026-10-19: "the could not sync error some clients did not like it"): an outage is quiet — what waits,
    // that the cloud cannot be reached, and when it last synced. Red is only for a refusal by our cloud (above).
    const why = !s.online ? ' (offline)' : s.cloudUnreachable ? ' · the cloud cannot be reached' : '';
    return { tone: 'quiet', action: 'sync',
      text: `${plural(s.pendingCount, 'record')} waiting to sync${why}${nodeWaiting ? ` · ${nodeWaiting} waiting for the branch server` : ''} · ${last}` };
  }
  // A501: the cloud has everything, but the branch server has not had some of it for a while (it is off, or refusing).
  if (nodeWaiting) {
    return { tone: 'quiet', action: 'sync', text: `${plural(nodeWaiting, 'record')} waiting for the branch server · ${last}` };
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
