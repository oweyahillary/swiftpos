/**
 * spoolStore.sqlite — the JobStore backed by the till's local database.
 *
 * The queue has to survive the app being closed, the machine being restarted,
 * and the power going out mid-service. In-memory would lose a kitchen ticket
 * every time Electron crashed, which is exactly when you least want to.
 *
 * shared/printing/src/spoolStore.memory.ts is the executable specification for
 * this file. If the two disagree, that one is right.
 *
 * CLAIMING IS ATOMIC. `claimNext` selects and marks 'printing' inside one
 * transaction. Without that, a tick that overlaps another can hand the same job
 * to two sends and the printer receives two interleaved streams, which is one
 * ribbon of garbage rather than two receipts.
 */

import type Database from 'better-sqlite3';
import type { JobStore, PrintJob } from '@swiftpos/printing';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS print_jobs (
  id              TEXT PRIMARY KEY,
  station_id      TEXT NOT NULL,
  station_name    TEXT NOT NULL,
  target          TEXT NOT NULL,
  bytes           BLOB NOT NULL,
  order_id        TEXT,
  kind            TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'queued',
  last_error      TEXT,
  next_attempt_at INTEGER NOT NULL,
  created_at      INTEGER NOT NULL,
  recovered       INTEGER NOT NULL DEFAULT 0
);

-- The worker's hot query: due queued jobs, oldest first. Without this it scans
-- the whole table four times a second.
CREATE INDEX IF NOT EXISTS idx_print_jobs_due
  ON print_jobs(status, next_attempt_at, created_at);

CREATE INDEX IF NOT EXISTS idx_print_jobs_station
  ON print_jobs(station_id, status);
`;

type Row = {
  id: string; station_id: string; station_name: string; target: string;
  bytes: Buffer; order_id: string | null; kind: string; attempts: number;
  status: string; last_error: string | null; next_attempt_at: number;
  created_at: number; recovered: number;
};

const toJob = (r: Row): PrintJob => ({
  id: r.id,
  stationId: r.station_id,
  stationName: r.station_name,
  target: r.target,
  bytes: r.bytes,
  orderId: r.order_id,
  kind: r.kind,
  attempts: r.attempts,
  status: r.status as PrintJob['status'],
  lastError: r.last_error,
  nextAttemptAt: r.next_attempt_at,
  createdAt: r.created_at,
  recovered: r.recovered === 1,
});

export class SqliteJobStore implements JobStore {
  constructor(private readonly db: Database.Database) {
    db.exec(SCHEMA);
  }

  insert(job: PrintJob): void {
    this.db.prepare(`
      INSERT INTO print_jobs
        (id, station_id, station_name, target, bytes, order_id, kind,
         attempts, status, last_error, next_attempt_at, created_at, recovered)
      VALUES (@id, @stationId, @stationName, @target, @bytes, @orderId, @kind,
              @attempts, @status, @lastError, @nextAttemptAt, @createdAt, @recovered)
    `).run({ ...job, recovered: job.recovered ? 1 : 0 });
  }

  claimNext(now: number, busyTargets: string[]): PrintJob | null {
    // IMMEDIATE so the write lock is taken up front. A deferred transaction can
    // upgrade and lose, handing the same row to a second caller.
    const claim = this.db.transaction((now: number, busy: string[]): PrintJob | null => {
      const placeholders = busy.length ? busy.map(() => '?').join(',') : null;
      const sql = `
        SELECT * FROM print_jobs
        WHERE status = 'queued' AND next_attempt_at <= ?
        ${placeholders ? `AND target NOT IN (${placeholders})` : ''}
        ORDER BY created_at ASC
        LIMIT 1
      `;
      const row = this.db.prepare(sql).get(now, ...busy) as Row | undefined;
      if (!row) return null;
      this.db.prepare(`UPDATE print_jobs SET status='printing' WHERE id=?`).run(row.id);
      return toJob(row);
    });
    return claim.immediate(now, busyTargets);
  }

  markDone(id: string, _now: number): void {
    this.db.prepare(`UPDATE print_jobs SET status='done', last_error=NULL WHERE id=?`).run(id);
  }

  markFailed(id: string, error: string, _now: number): void {
    this.db.prepare(
      `UPDATE print_jobs SET status='failed', last_error=?, attempts=attempts+1 WHERE id=?`,
    ).run(error, id);
  }

  reschedule(id: string, error: string, nextAttemptAt: number): void {
    this.db.prepare(`
      UPDATE print_jobs
      SET status='queued', last_error=?, attempts=attempts+1, next_attempt_at=?
      WHERE id=?
    `).run(error, nextAttemptAt, id);
  }

  takeStuck(now: number): PrintJob[] {
    const rows = this.db.prepare(`SELECT * FROM print_jobs WHERE status='printing'`).all() as Row[];
    if (rows.length) {
      this.db.prepare(`
        UPDATE print_jobs SET status='queued', recovered=1, next_attempt_at=?
        WHERE status='printing'
      `).run(now);
    }
    return rows.map(toJob);
  }

  list(limit: number): PrintJob[] {
    return (this.db.prepare(
      `SELECT * FROM print_jobs ORDER BY created_at DESC LIMIT ?`,
    ).all(limit) as Row[]).map(toJob);
  }

  countsByStation(): Record<string, { queued: number; failed: number }> {
    const rows = this.db.prepare(`
      SELECT station_id, status, COUNT(*) AS n
      FROM print_jobs WHERE status IN ('queued','failed')
      GROUP BY station_id, status
    `).all() as { station_id: string; status: string; n: number }[];
    const out: Record<string, { queued: number; failed: number }> = {};
    for (const r of rows) {
      out[r.station_id] ??= { queued: 0, failed: 0 };
      if (r.status === 'queued') out[r.station_id].queued = r.n;
      else out[r.station_id].failed = r.n;
    }
    return out;
  }

  requeue(id: string, now: number): void {
    this.db.prepare(`
      UPDATE print_jobs SET status='queued', attempts=0, next_attempt_at=?, last_error=NULL
      WHERE id=?
    `).run(now, id);
  }

  /** Completed jobs are kept briefly so a cashier can reprint from the queue,
   *  then dropped. Receipts are reprinted from the ORDER, not from here, so
   *  nothing is lost by purging. */
  purgeDone(olderThan: number): number {
    return this.db.prepare(
      `DELETE FROM print_jobs WHERE status='done' AND created_at < ?`,
    ).run(olderThan).changes;
  }
}
