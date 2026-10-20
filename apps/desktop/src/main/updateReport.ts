/**
 * updateReport.ts — A534: the till tells the cloud where its update is, so the admin portal can answer "why isn't this
 * till updating?".
 *
 * Owner, 2026-10-20 ("add all of them since effort is small"): the admin portal's Desktop updates card listed each till's
 * version and nothing else — TJ'S PIZZA T1 sat on 1.0.5 while 1.0.19 was approved, and nobody could see why from there.
 *
 * What is sent (POST /api/desktop-update/state, the till's own session — the same router the hourly check asks): the
 * state autoUpdate.ts already keeps (checking / downloading n% / downloaded / error / idle), since when, the last check,
 * what the cloud approved, the error in its own words (short), why the idle install has not happened yet (A508), and
 * whether the Windows updater task is there (A509). Nothing about sales, nobody's name.
 *
 * When: only once the cloud has said it takes it (`reportsState: true` on GET /api/desktop-update/status — an older cloud
 * without the field is sent NOTHING), then whenever the state changes (a download's progress in 25 % steps) and at least
 * every 30 minutes while nothing changes. A refusal of the route (404 / 501: the cloud or its database is not there yet)
 * rests the reports for 6 hours. Never throws; never in the way of a sale or an update.
 */
import type { UpdateState, UpdateStatus } from './autoUpdate';

export interface UpdateStateReport {
  running: string;
  state: UpdateState;
  version: string | null;
  percent: number | null;
  /** When the till entered this state (e.g. downloaded at 14:02, failed at 14:10). */
  since: string | null;
  checked_at: string | null;
  approved: string | null;
  /** The error in its own words (state 'error' only), at most 160 characters. */
  error: string | null;
  /** A508: why the downloaded update has not installed itself yet ("in use 3 min ago", "not a quiet hour"). */
  idle_note: string | null;
  /** A509: the Windows updater task is installed (null: not known yet). */
  task: boolean | null;
}

export const REPORT_EVERY_MS = 30 * 60_000;
export const OLD_CLOUD_REST_MS = 6 * 60 * 60_000;

const clip = (s: unknown, n: number): string | null => {
  const t = typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '';
  return t ? t.slice(0, n) : null;
};

/** The report from what autoUpdate.ts holds. Pure. */
export function buildUpdateReport(s: { status: UpdateStatus; running: string; stateAt: string | null; idleNote: string | null; task: boolean | null }): UpdateStateReport {
  const st = s.status;
  const error = st.state === 'error' ? clip(String(st.note ?? '').replace(/^the last attempt failed:\s*/i, ''), 160) ?? 'unknown error' : null;
  return {
    running: s.running,
    state: st.state,
    version: st.version ?? null,
    percent: st.state === 'downloading' && typeof st.percent === 'number' ? Math.max(0, Math.min(100, Math.round(st.percent))) : null,
    since: s.stateAt,
    checked_at: st.checkedAt ?? null,
    approved: st.approved ?? null,
    error,
    idle_note: st.state === 'downloaded' ? clip(s.idleNote, 160) : null,
    task: s.task,
  };
}

/** What makes two reports "the same" — a download's progress counted in 25 % steps, the idle note without its numbers. */
export function reportKey(r: UpdateStateReport): string {
  const pct = r.percent === null ? '' : String(Math.floor(r.percent / 25));
  return [r.running, r.state, r.version, pct, r.since, r.approved, r.error, (r.idle_note ?? '').replace(/\d+/g, '#'), r.task].join('|');
}

export interface UpdateReporterDeps {
  build: () => UpdateStateReport;
  post: (body: UpdateStateReport) => Promise<{ status: number }>;
  now?: () => number;
  log?: (line: string) => void;
}
export type ReportOutcome = 'off' | 'same' | 'sent' | 'failed' | 'resting';

export function createUpdateReporter(d: UpdateReporterDeps) {
  const now = d.now ?? Date.now;
  let cloudTakes = false;
  let lastKey = '';
  let lastAt = 0;
  let restUntil = 0;
  let busy = false;
  /** The hourly check's answer: does the cloud take the report (`reportsState: true`)? */
  const setCloudTakes = (yes: boolean) => {
    if (yes && !cloudTakes) d.log?.('the cloud takes this machine\'s update state — reported from now on');
    cloudTakes = yes;
  };
  async function tick(): Promise<ReportOutcome> {
    if (!cloudTakes) return 'off';
    const t = now();
    if (t < restUntil) return 'resting';
    if (busy) return 'same';
    let r: UpdateStateReport;
    try { r = d.build(); } catch { return 'failed'; }
    const key = reportKey(r);
    if (key === lastKey && t - lastAt < REPORT_EVERY_MS) return 'same';
    busy = true;
    try {
      const res = await d.post(r);
      if (res.status === 404 || res.status === 501) {
        restUntil = t + OLD_CLOUD_REST_MS;
        d.log?.(`the cloud does not take the update state yet (HTTP ${res.status}) — asked again in 6 hours`);
        return 'resting';
      }
      if (res.status < 200 || res.status >= 300) return 'failed';
      lastKey = key; lastAt = t;
      return 'sent';
    } catch { return 'failed'; }
    finally { busy = false; }
  }
  return { tick, setCloudTakes, cloudTakes: () => cloudTakes };
}
