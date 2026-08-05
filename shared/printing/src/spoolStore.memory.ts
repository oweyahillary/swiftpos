/**
 * spoolStore.memory — a JobStore that keeps everything in an array.
 *
 * Used by the tests, and it is the executable specification of what the SQLite
 * adapter must do. If the two ever disagree, this file is right and the adapter
 * is wrong.
 */

import type { JobStore, PrintJob } from './spool';

export class MemoryJobStore implements JobStore {
  private rows: PrintJob[] = [];

  insert(job: PrintJob): void {
    this.rows.push({ ...job });
  }

  claimNext(now: number, busyTargets: string[]): PrintJob | null {
    const busy = new Set(busyTargets);
    // Oldest first, so a kitchen ticket rung at 19:40 prints before one rung at
    // 19:41 even if the printer was off in between.
    const row = this.rows
      .filter(r => r.status === 'queued' && r.nextAttemptAt <= now && !busy.has(r.target))
      .sort((a, b) => a.createdAt - b.createdAt)[0];
    if (!row) return null;
    row.status = 'printing';
    return { ...row };
  }

  markDone(id: string, _now: number): void {
    const r = this.find(id);
    if (r) { r.status = 'done'; r.lastError = null; }
  }

  markFailed(id: string, error: string, _now: number): void {
    const r = this.find(id);
    if (r) { r.status = 'failed'; r.lastError = error; r.attempts += 1; }
  }

  reschedule(id: string, error: string, nextAttemptAt: number): void {
    const r = this.find(id);
    if (r) {
      r.status = 'queued';
      r.lastError = error;
      r.attempts += 1;
      r.nextAttemptAt = nextAttemptAt;
    }
  }

  takeStuck(now: number): PrintJob[] {
    const stuck = this.rows.filter(r => r.status === 'printing');
    for (const r of stuck) {
      r.status = 'queued';
      r.recovered = true;
      r.nextAttemptAt = now;
    }
    return stuck.map(r => ({ ...r }));
  }

  list(limit: number): PrintJob[] {
    return [...this.rows].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit).map(r => ({ ...r }));
  }

  countsByStation(): Record<string, { queued: number; failed: number }> {
    const out: Record<string, { queued: number; failed: number }> = {};
    for (const r of this.rows) {
      if (r.status !== 'queued' && r.status !== 'failed') continue;
      out[r.stationId] ??= { queued: 0, failed: 0 };
      if (r.status === 'queued') out[r.stationId].queued++;
      else out[r.stationId].failed++;
    }
    return out;
  }

  requeue(id: string, now: number): void {
    const r = this.find(id);
    if (r) { r.status = 'queued'; r.attempts = 0; r.nextAttemptAt = now; r.lastError = null; }
  }

  purgeDone(olderThan: number): number {
    const before = this.rows.length;
    this.rows = this.rows.filter(r => !(r.status === 'done' && r.createdAt < olderThan));
    return before - this.rows.length;
  }

  private find(id: string) {
    return this.rows.find(r => r.id === id);
  }
}
