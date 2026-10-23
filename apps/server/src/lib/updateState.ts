/**
 * updateState.ts — A534: a till's update state as the cloud stores it (user_devices.update_state, migration 154).
 *
 * Owner, 2026-10-20 ("add all of them since effort is small"): the admin portal's Desktop updates card showed each till's
 * version and nothing else — an old till stuck (TJ'S PIZZA T1 on 1.0.5 while 1.0.19 was approved) could not be explained
 * from there. A till from 1.0.20 reports what its updater knows (apps/desktop/src/main/updateReport.ts); this keeps only
 * the known fields, each checked and cut to size — a till's report is never trusted to be well formed.
 *
 * Shown to ZapTill only (super admin and agent: GET /api/admin/clients/:id/devices). No route a client calls reads it.
 * Pure — the test imports it.
 */
export const UPDATE_STATES = ['idle', 'checking', 'available', 'downloading', 'downloaded', 'error'] as const;
export type StoredUpdateState = {
  running: string | null; state: typeof UPDATE_STATES[number]; version: string | null; percent: number | null;
  since: string | null; checked_at: string | null; approved: string | null; error: string | null;
  idle_note: string | null; task: boolean | null;
  // A541 (owner, 2026-10-20: "most apps are not updating, they are stuck in the old version"): why a downloaded update has
  // not installed. A till before 1.0.20's A541 sends none of these — stored as null / false.
  blocker: string | null; server: boolean; waiting_server: boolean; downloaded_at: string | null; startup_failed: boolean;
  /** A554: the till answers a log pull from the admin portal (A533) — said by the till itself, not read off its version. */
  log_pull: boolean;
};

const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
const ver = (v: unknown): string | null => (typeof v === 'string' && VERSION_RE.test(v) ? v : null);
const iso = (v: unknown): string | null => {
  if (typeof v !== 'string' || v.length > 40) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};
const text = (v: unknown, n: number): string | null => {
  const t = typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim() : '';
  return t ? t.slice(0, n) : null;
};

/** The report as stored, or null when it is not a report (no known state). */
export function cleanUpdateState(body: unknown): StoredUpdateState | null {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const state = typeof b.state === 'string' && (UPDATE_STATES as readonly string[]).includes(b.state) ? b.state as StoredUpdateState['state'] : null;
  if (!state) return null;
  const pct = typeof b.percent === 'number' && Number.isFinite(b.percent) ? Math.max(0, Math.min(100, Math.round(b.percent))) : null;
  return {
    running: ver(b.running),
    state,
    version: ver(b.version),
    percent: state === 'downloading' ? pct : null,
    since: iso(b.since),
    checked_at: iso(b.checked_at),
    approved: ver(b.approved),
    error: state === 'error' ? (text(b.error, 160) ?? 'unknown error') : null,
    idle_note: text(b.idle_note, 160),
    task: typeof b.task === 'boolean' ? b.task : null,
    blocker: state === 'downloaded' ? text(b.blocker, 160) : null,   // A541
    server: b.server === true,
    waiting_server: state !== 'downloaded' && b.waiting_server === true,
    downloaded_at: state === 'downloaded' ? iso(b.downloaded_at) : null,
    startup_failed: b.startup_failed === true,
    log_pull: b.log_pull === true,   // A554
  };
}
