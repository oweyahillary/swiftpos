/**
 * spool — the print queue.
 *
 * ── THE ONE RULE ─────────────────────────────────────────────────────────────
 * THE TILL NEVER WAITS FOR A PRINTER. `enqueue` writes a row and returns. A
 * cashier finishing a sale must not be held up because a kitchen printer is out
 * of paper, and a sale must never fail because of one. Printing is a
 * consequence of the sale, not part of it.
 *
 * This is the behaviour an office printer already has and everyone expects:
 * jobs pile up while it is off and come out when it is back on. Nothing needs
 * re-ringing.
 *
 * ── ONE JOB AT A TIME PER PRINTER ────────────────────────────────────────────
 * Two jobs interleaved on one printer produce one ribbon of garbage, because
 * ESC/POS is a stream with no framing — a mode change from job B lands in the
 * middle of job A's text. The worker holds a lease per TARGET, not per station,
 * because two stations are often assigned the same physical machine in a small
 * shop.
 *
 * ── RETRYABLE VERSUS PERMANENT ───────────────────────────────────────────────
 * A printer that is switched off is retryable: back off and try again, possibly
 * for hours. A hostname that does not resolve is permanent: retrying forever
 * fills the queue with jobs that can never drain, and the operator never learns
 * why nothing prints. transport.ts makes that call; the spool honours it and
 * surfaces permanent failures to the UI immediately.
 */

export type JobStatus = 'queued' | 'printing' | 'done' | 'failed';

export interface PrintJob {
  id: string;
  stationId: string;
  stationName: string;
  /** Printer target spec, e.g. "192.168.1.50:9100". Resolved at ENQUEUE time,
   *  so re-pointing a station later does not silently redirect queued jobs. */
  target: string;
  /** ESC/POS. Rendered at enqueue time and never re-rendered — a job that sat
   *  in the queue through a menu change must print what was sold. */
  bytes: Buffer;
  orderId: string | null;
  kind: string;
  attempts: number;
  status: JobStatus;
  lastError: string | null;
  /** Epoch ms. A queued job is invisible to the worker until now >= this. */
  nextAttemptAt: number;
  createdAt: number;
  /** Set when the job was found mid-print after a crash. See recoverStuck(). */
  recovered: boolean;
}

export type NewJob = Omit<
  PrintJob,
  'id' | 'attempts' | 'status' | 'lastError' | 'nextAttemptAt' | 'createdAt' | 'recovered'
>;

export interface JobStore {
  insert(job: PrintJob): void;
  /** Oldest due queued job whose target is not in `busyTargets`. Must mark it
   *  'printing' in the same operation, or two workers will claim one job. */
  claimNext(now: number, busyTargets: string[]): PrintJob | null;
  markDone(id: string, now: number): void;
  markFailed(id: string, error: string, now: number): void;
  reschedule(id: string, error: string, nextAttemptAt: number): void;
  /** Jobs left 'printing' when the process died. */
  takeStuck(now: number): PrintJob[];
  list(limit: number): PrintJob[];
  countsByStation(): Record<string, { queued: number; failed: number }>;
  requeue(id: string, now: number): void;
  purgeDone(olderThan: number): number;
}

export interface SpoolOptions {
  /** How often the worker looks for due work. */
  tickMs?: number;
  /**
   * How long a job may keep retrying before it is given up on. TIME, not
   * attempts — attempts are a poor proxy once backoff caps out. With a 60s
   * ceiling, 20 attempts is about 18 minutes, so a printer out of paper through
   * one lunch rush would silently lose its tickets. Four hours covers a
   * service; anything still failing after that needs a human, not another try.
   */
  maxAgeMs?: number;
  /** Safety net against a pathological fast-failing target. Deliberately high;
   *  maxAgeMs is the real limit. */
  maxAttempts?: number;
  /** Backoff schedule in ms; the last value repeats. */
  backoffMs?: number[];
  send: (target: string, bytes: Buffer) => Promise<void>;
  /** True when the failure is worth retrying. transport.PrinterError.retryable. */
  isRetryable: (err: unknown) => boolean;
  now?: () => number;
  onChange?: () => void;
}

const DEFAULT_BACKOFF = [1_000, 2_000, 5_000, 15_000, 30_000, 60_000];

let counter = 0;
function newId(now: number): string {
  // Monotonic within a process and sortable by time. Not a UUID: these rows are
  // local to one till and never sync, so collision across devices cannot occur.
  counter = (counter + 1) % 1_000_000;
  return `pj_${now.toString(36)}_${counter.toString(36)}`;
}

export class Spool {
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = new Set<string>();
  private readonly opts: Required<Omit<SpoolOptions, 'onChange'>> & { onChange?: () => void };

  constructor(private readonly store: JobStore, opts: SpoolOptions) {
    this.opts = {
      tickMs: opts.tickMs ?? 250,
      maxAgeMs: opts.maxAgeMs ?? 4 * 60 * 60 * 1000,
      maxAttempts: opts.maxAttempts ?? 500,
      backoffMs: opts.backoffMs ?? DEFAULT_BACKOFF,
      send: opts.send,
      isRetryable: opts.isRetryable,
      now: opts.now ?? (() => Date.now()),
      onChange: opts.onChange,
    };
  }

  /** Returns immediately. The caller is never told whether it printed, because
   *  at this point nobody knows and the sale must not depend on it. */
  enqueue(job: NewJob): string {
    const now = this.opts.now();
    const row: PrintJob = {
      ...job,
      id: newId(now),
      attempts: 0,
      status: 'queued',
      lastError: null,
      nextAttemptAt: now,
      createdAt: now,
      recovered: false,
    };
    this.store.insert(row);
    this.opts.onChange?.();
    return row.id;
  }

  /**
   * Anything left 'printing' means the process died mid-job. Requeue it: a
   * missing kitchen ticket costs a wrong order, while a duplicate costs a sheet
   * of paper. The `recovered` flag lets a receipt reprint carry the Duplicate
   * Print banner so it can never be passed off as an original.
   */
  recoverStuck(): number {
    const now = this.opts.now();
    const stuck = this.store.takeStuck(now);
    this.opts.onChange?.();
    return stuck.length;
  }

  start(): void {
    if (this.timer) return;
    this.recoverStuck();
    this.timer = setInterval(() => { void this.tick(); }, this.opts.tickMs);
    // Node only: do not hold the process open for the spool alone.
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Exposed so tests can drive the loop deterministically instead of sleeping. */
  async tick(): Promise<boolean> {
    const now = this.opts.now();
    const job = this.store.claimNext(now, [...this.busy]);
    if (!job) return false;

    this.busy.add(job.target);
    this.opts.onChange?.();
    try {
      await this.opts.send(job.target, job.bytes);
      this.store.markDone(job.id, this.opts.now());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const attempts = job.attempts + 1;
      if (!this.opts.isRetryable(err)) {
        this.store.markFailed(job.id, `${message} (not retryable)`, this.opts.now());
      } else if (this.opts.now() - job.createdAt >= this.opts.maxAgeMs) {
        const mins = Math.round((this.opts.now() - job.createdAt) / 60000);
        this.store.markFailed(job.id, `${message} (gave up after ${mins} minutes)`, this.opts.now());
      } else if (attempts >= this.opts.maxAttempts) {
        this.store.markFailed(job.id, `${message} (gave up after ${attempts} attempts)`, this.opts.now());
      } else {
        const b = this.opts.backoffMs;
        const delay = b[Math.min(attempts - 1, b.length - 1)];
        this.store.reschedule(job.id, message, this.opts.now() + delay);
      }
    } finally {
      this.busy.delete(job.target);
      this.opts.onChange?.();
    }
    return true;
  }

  /** Works through everything currently due, then returns. For tests and for a
   *  "print now" button on the settings screen. */
  async drain(maxIterations = 5000): Promise<void> {
    for (let i = 0; i < maxIterations; i++) {
      if (!(await this.tick())) return;
    }
  }

  status() {
    return {
      counts: this.store.countsByStation(),
      recent: this.store.list(50),
      busy: [...this.busy],
    };
  }

  retry(id: string): void {
    this.store.requeue(id, this.opts.now());
    this.opts.onChange?.();
  }
}
