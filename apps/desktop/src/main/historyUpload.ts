/**
 * historyUpload.ts — A602: "going online later". New sales first; the history as a bulk backfill in quiet hours, back as
 * far as the owner chooses; an interruption is safe.
 *
 * Owner, 2026-10-28 (docs/DESKTOP-ONLY-CUTOFF-PLAN.md, decision 6, final): a desktop-only business cut off from the cloud
 * backup (A601) keeps every sale queued on this PC. When it buys the online licence (or ZapTill switches its cloud_backup
 * flag on), the normal push would send that queue one call per sale, 50 per pass, OLDEST first — a year of sales is
 * hundreds of thousands of calls, days of uploading, today's sales reaching the dashboard last, a slower POS while trading.
 *
 * Now:
 *   1. The backlog. It starts when the cloud takes this POS's backup again after this POS knew it was off (fromCut), or
 *      when more than BACKLOG_THRESHOLD sales wait (a POS long offline). Kept in maintenance_state 'history_upload' — no
 *      schema change. It ends when no sale older than the last 48 hours waits.
 *   2. New first. While it lasts, the normal push (syncEngine pushPendingOrders) sends only the sales of the last 48 hours,
 *      newest first, and the drawer push only what those need (historyUploadRules splitRecentCash): an open drawer always,
 *      a closed one from before then waits for the backfill with its floats, expenses and kitchen voids, a day goes with
 *      any drawer of it that goes. The dashboard is live from the first day.
 *   3. The backfill (runHistoryUpload, a stage of the sync pass — so never beside the normal push): the older sales,
 *      oldest first within the owner's window, BATCH_MAX a call, gzip'd, to POST /api/sync/backfill, WITH the pending
 *      drawers, days, floats, expenses and kitchen voids they need (cashForShifts) — the cloud writes those first, through
 *      the same handler as /api/sync/push, then each sale through the same handler as /api/orders. Only in quiet hours
 *      (owner-set, default 22:00–06:00) or after 10 minutes without use; never while a sale is under way (the cart, the
 *      payment screen, a print queued) — checked before every call, so it pauses the moment a sale starts; a pause between
 *      calls; at most PASS_BUDGET_MS per pass.
 *   4. One status column. Each sale the cloud stored (accepted, or already there: duplicate) is marked synced by the SAME
 *      statement the normal push uses (syncEngine markOrderSynced: the queue row, the order, a credit charge) — so the
 *      normal push never sends it again; a sale whose drawer is not there (424) waits as in the normal push; a refusal
 *      counts a try (5 → failed), as in the normal push; anything else stays pending and goes next time. A batch cut off
 *      half way (the PC switched off, the line dropped) changes nothing it did not hear back about: the next run sends
 *      those sales again and the cloud answers "duplicate" for any it had stored.
 *   5. How far back (the owner, Manager › Settings › Backup or the Tech page): the last 3 months (default), 12 months or
 *      everything. Older sales are marked 'local_only' in sync_queue (and their order, drawers, days, floats, expenses,
 *      kitchen voids, reversals the same in their sync_status) — kept on this PC and in its backups, never "waiting to
 *      sync": every count and notice reads 'pending' only. Widening the window puts them back to 'pending'. Applied only
 *      after a cut-off (fromCut) or once the owner has chosen — a POS that was merely offline sends everything.
 *   6. Progress: historyUploadStatus() — "History upload: 45% (12,300 of 27,000 sales), in quiet hours" (the manager's
 *      notice, the Tech page and the Backup tab: renderer/components/HistoryUploadPanel.tsx).
 */
import zlib from 'node:zlib';
import { getLocalDb } from './localDb';
import { getDeviceConfig } from './deviceConfig';
import { logLine } from './logFile';
import { activitySnapshot } from './activityTracker';
import {
  BACKLOG_THRESHOLD, BATCH_GAP_MS, BATCH_MAX, DRAWER_WAIT_RETRY_MS, HISTORY_WINDOW_LABEL,
  MAX_BATCH_BYTES, NEW_FIRST_MS, PASS_BUDGET_MS, cashForShifts, cleanHistorySettings, progressLabel, quietVerdict, windowStart,
  type CashTablesLike, type HistorySettings, type HistoryWindow,
} from './historyUploadRules';

export * from './historyUploadRules';

// ── state (maintenance_state) ───────────────────────────────────────────────────────────────────────────────────────
export interface HistoryState {
  active: boolean;
  /** Started because the cloud backup came back after this POS knew it was off (the owner's window applies). */
  fromCut: boolean;
  /** This POS has seen the backup off (A601) — the next "on" starts the history upload. */
  seenOff: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  /** Sales the backfill has had stored (accepted or already there) since it started. */
  done: number;
  lastBatchAt: string | null;
  lastResult: string | null;
}
const BLANK: HistoryState = { active: false, fromCut: false, seenOff: false, startedAt: null, finishedAt: null, done: 0, lastBatchAt: null, lastResult: null };
const STATE_KEY = 'history_upload';
const SETTINGS_KEY = 'history_upload_settings';
let _state: HistoryState | null = null;
let _settings: (HistorySettings & { chosen: boolean }) | null = null;

function readKey(key: string): unknown {
  try {
    const row = getLocalDb().prepare(`SELECT value FROM maintenance_state WHERE key = ?`).get(key) as { value?: string } | undefined;
    return row?.value ? JSON.parse(row.value) : null;
  } catch { return null; }
}
function writeKey(key: string, v: unknown): void {
  try {
    getLocalDb().prepare(`INSERT OR REPLACE INTO maintenance_state (key, value, updated_at) VALUES (?, ?, ?)`)
      .run(key, JSON.stringify(v), new Date().toISOString());
  } catch { /* kept in memory until the next write */ }
}
export function getHistoryState(): HistoryState {
  if (_state) return _state;
  const v = readKey(STATE_KEY) as Partial<HistoryState> | null;
  _state = { ...BLANK, ...(v && typeof v === 'object' ? v : {}) };
  _state.done = Math.max(0, Number(_state.done) || 0);
  return _state;
}
function saveState(patch: Partial<HistoryState>): HistoryState {
  _state = { ...getHistoryState(), ...patch };
  writeKey(STATE_KEY, _state);
  return _state;
}
export function getHistorySettings(): HistorySettings & { chosen: boolean } {
  if (_settings) return _settings;
  const v = readKey(SETTINGS_KEY) as Record<string, unknown> | null;
  _settings = { ...cleanHistorySettings(v ?? {}), chosen: v?.chosen === true };
  return _settings;
}

/** Tests only: the pause between calls and the clock (a 100,000-sale queue in seconds, not hours). */
let _seams: { sleep?: (ms: number) => Promise<void>; now?: () => number } = {};
export function _setHistorySeams(x: typeof _seams): void { _seams = x; }
/** Tests only. */
export function _forgetHistoryMemo(): void { _state = null; _settings = null; _batchCap = BATCH_MAX; _lastThresholdCheck = 0; _why = null; }

/** Is the history backlog being worked through (new first, the rest by the backfill)? Never throws. */
export function historyBacklogActive(): boolean {
  try { return getHistoryState().active; } catch { return false; }
}
/** New first: the normal push sends only sales from this instant on (ISO), or null when there is no backlog. */
export function newFirstCutoff(now: number = Date.now()): string | null {
  return historyBacklogActive() ? new Date(now - NEW_FIRST_MS).toISOString() : null;
}

// ── the window ("how far back") ─────────────────────────────────────────────────────────────────────────────────────
/**
 * Mark what is older than the window 'local_only' (and put back to 'pending' what the window now covers). One
 * transaction. Returns the sales kept on this PC only. Own records only (a branch server's peers mark their own).
 */
export function applyHistoryWindow(window: HistoryWindow, now: number = Date.now()): number {
  const db = getLocalDb();
  const start = windowStart(window, now);
  const dev = getDeviceConfig()?.device_id ?? null;
  const inWin = (col: string) => `(@start IS NULL OR julianday(${col}) >= julianday(@start))`;
  const before = (col: string) => `(@start IS NOT NULL AND julianday(${col}) < julianday(@start))`;
  const p = { start, dev };
  const run = (sql: string) => { try { db.prepare(sql).run(p); } catch (e: any) { logLine('sync', `history window: ${e?.message ?? e}`); } };
  db.transaction(() => {
    // Back to 'pending': what the window now covers (it was widened).
    run(`UPDATE sync_queue SET status='pending' WHERE status='local_only' AND ${inWin('created_at')}`);
    run(`UPDATE orders SET sync_status='pending' WHERE sync_status='local_only'
          -- branch-wide: by this POS's own queue (sync_queue), as the order push
          AND id IN (SELECT order_id FROM sync_queue WHERE status='pending')`);
    run(`UPDATE shifts SET sync_status='pending' WHERE sync_status='local_only' AND COALESCE(device_id,'') = COALESCE(@dev,'')
          AND (${inWin('COALESCE(closed_at, opened_at)')} OR EXISTS (SELECT 1 FROM orders o WHERE o.shift_id = shifts.id AND o.sync_status = 'pending'))`);
    run(`UPDATE business_days SET sync_status='pending' WHERE sync_status='local_only' AND COALESCE(device_id,'') = COALESCE(@dev,'')
          AND (${inWin('COALESCE(closed_at, opened_at)')} OR EXISTS (SELECT 1 FROM shifts s WHERE s.business_day_id = business_days.id AND s.sync_status = 'pending'))`);
    for (const t of ['float_transactions', 'expenses', 'kitchen_voids']) {
      const when = t === 'expenses' ? 'COALESCE(expense_date, created_at)' : 'created_at';
      run(`UPDATE ${t} SET sync_status='pending' WHERE sync_status='local_only' AND COALESCE(device_id,'') = COALESCE(@dev,'')
            AND ((shift_id IS NOT NULL AND shift_id NOT IN (SELECT id FROM shifts WHERE sync_status='local_only')) OR (shift_id IS NULL AND ${inWin(when)}))`);
    }
    run(`UPDATE pending_reversals SET sync_status='pending' WHERE sync_status='local_only' AND COALESCE(device_id,'') = COALESCE(@dev,'')
          AND order_id NOT IN (SELECT id FROM orders WHERE sync_status='local_only')`);
    run(`UPDATE shifts SET confirm_sync='pending' WHERE confirm_sync='local_only' AND sync_status <> 'local_only' AND COALESCE(device_id,'') = COALESCE(@dev,'')`);
    // To 'local_only': older than the window. A sale first; a drawer only when none of its sales still goes; a day only
    // when none of its drawers still goes; a drawer's floats / expenses / kitchen voids with it; a reversal with its sale.
    run(`UPDATE sync_queue SET status='local_only' WHERE status='pending' AND ${before('created_at')}`);
    run(`UPDATE orders SET sync_status='local_only' WHERE sync_status='pending'
          -- branch-wide: by this POS's own queue (sync_queue), as the order push
          AND id IN (SELECT order_id FROM sync_queue WHERE status='local_only')`);
    run(`UPDATE shifts SET sync_status='local_only' WHERE sync_status='pending' AND COALESCE(device_id,'') = COALESCE(@dev,'') AND status <> 'open'
          AND ${before('COALESCE(closed_at, opened_at)')} AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.shift_id = shifts.id AND o.sync_status = 'pending')`);
    run(`UPDATE business_days SET sync_status='local_only' WHERE sync_status='pending' AND COALESCE(device_id,'') = COALESCE(@dev,'') AND status = 'closed'
          AND ${before('COALESCE(closed_at, opened_at)')} AND NOT EXISTS (SELECT 1 FROM shifts s WHERE s.business_day_id = business_days.id AND s.sync_status = 'pending')`);
    for (const t of ['float_transactions', 'expenses', 'kitchen_voids']) {
      const when = t === 'expenses' ? 'COALESCE(expense_date, created_at)' : 'created_at';
      run(`UPDATE ${t} SET sync_status='local_only' WHERE sync_status='pending' AND COALESCE(device_id,'') = COALESCE(@dev,'')
            AND ((shift_id IS NOT NULL AND shift_id IN (SELECT id FROM shifts WHERE sync_status='local_only')) OR (shift_id IS NULL AND ${before(when)}))`);
    }
    run(`UPDATE pending_reversals SET sync_status='local_only' WHERE sync_status='pending' AND COALESCE(device_id,'') = COALESCE(@dev,'')
          AND order_id IN (SELECT id FROM orders WHERE sync_status='local_only')`);
    run(`UPDATE shifts SET confirm_sync='local_only' WHERE confirm_sync='pending' AND sync_status='local_only' AND COALESCE(device_id,'') = COALESCE(@dev,'')`);
  })();
  const kept = localOnlyCount();
  logLine('sync', `history upload: ${HISTORY_WINDOW_LABEL[window]} goes to the cloud${start ? ` (from ${start.slice(0, 10)})` : ''}; ${kept} older sale(s) stay on this PC only`);
  return kept;
}
function localOnlyCount(): number {
  try { return (getLocalDb().prepare(`SELECT COUNT(*) AS n FROM sync_queue WHERE status='local_only'`).get() as { n: number }).n; } catch { return 0; }
}

/** The owner's choice. A window change while the history goes up (or after a cut) is applied at once. */
export function setHistorySettings(v: unknown, now: number = Date.now()): HistorySettings & { chosen: boolean } {
  const before = getHistorySettings();
  const next = { ...cleanHistorySettings(v, before), chosen: before.chosen || (!!v && typeof v === 'object' && 'window' in (v as object)) };
  _settings = next;
  writeKey(SETTINGS_KEY, next);
  const st = getHistoryState();
  if (next.window !== before.window || (next.chosen && !before.chosen)) {
    if (st.active || st.fromCut || localOnlyCount() > 0) {
      applyHistoryWindow(next.window, now);
      if (!st.active && oldPendingCount(now) > 0) startBacklog(st.fromCut, now, 'the owner widened the window');
    }
  }
  logLine('sync', `history upload settings: ${HISTORY_WINDOW_LABEL[next.window]}, quiet hours ${next.quietFrom}–${next.quietTo}`);
  return next;
}

// ── starting and ending ─────────────────────────────────────────────────────────────────────────────────────────────
function startBacklog(fromCut: boolean, now: number, why: string): void {
  saveState({ active: true, fromCut, seenOff: false, startedAt: new Date(now).toISOString(), finishedAt: null, done: 0, lastResult: null });
  const s = getHistorySettings();
  if (fromCut || s.chosen) applyHistoryWindow(s.window, now);
  logLine('sync', `history upload started (${why}): new sales go first; the older ones go in quiet hours (${s.quietFrom}–${s.quietTo}) or when the POS is idle`);
}

let _lastThresholdCheck = 0;
/**
 * Every sync pass, before the backup gate (cheap: the state is in memory). The backup off (A601) → remembered; on again
 * after that → the history upload starts (fromCut). Otherwise, at most once a minute: a backlog over the threshold starts it.
 */
export function noteHistoryPass(backupOff: boolean, now: number = Date.now()): void {
  try {
    const st = getHistoryState();
    if (backupOff) { if (!st.seenOff) saveState({ seenOff: true }); return; }
    if (st.seenOff) { startBacklog(true, now, 'the cloud takes this POS\'s backup again'); return; }
    if (st.active || now - _lastThresholdCheck < 60_000) return;
    _lastThresholdCheck = now;
    const waitBefore = new Date(now - DRAWER_WAIT_RETRY_MS).toISOString();
    const n = (getLocalDb().prepare(`SELECT COUNT(*) AS n FROM sync_queue WHERE status='pending'
       AND (drawer_wait_at IS NULL OR julianday(drawer_wait_at) < julianday(?))`).get(waitBefore) as { n: number }).n;
    if (n > BACKLOG_THRESHOLD && oldPendingCount(now) > 0) startBacklog(false, now, `${n} sales waiting`);
  } catch (e: any) { logLine('sync', `history upload check failed: ${e?.message ?? e}`); }
}

/** Sales older than the new-first window still waiting (pending). */
function oldPendingCount(now: number): number {
  try {
    return (getLocalDb().prepare(`SELECT COUNT(*) AS n FROM sync_queue WHERE status='pending' AND julianday(created_at) < julianday(?)`)
      .get(new Date(now - NEW_FIRST_MS).toISOString()) as { n: number }).n;
  } catch { return 0; }
}

// ── the backfill ────────────────────────────────────────────────────────────────────────────────────────────────────
/** What the sync engine gives the backfill (its own transport, statements and answers — never a copy of them). */
export interface HistoryDeps {
  /** POST the gzip'd JSON to /api/sync/backfill (the 401 renewal inside). Throws on no answer. */
  post(gz: Buffer): Promise<{ status: number; body: any }>;
  /** Every pending drawer / day / float / expense / kitchen void of this POS (the drawer push's own reads). */
  readPendingCash(): CashTablesLike;
  /** Apply the cloud's /api/sync/push answer to the rows sent (the drawer push's own marking). */
  applyCashAnswer(batch: CashTablesLike, body: any, errors: string[]): number;
  /** The normal push's own "the cloud has this sale". */
  markSynced(queueId: number, orderId: string): void;
  /** syncEngine PARKED_DRAWER_SQL (alias q): a sale whose drawer the cloud refused waits with it. */
  parkedSql: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  activity?: () => { lastUse: number; busy: string | null };
}

let _batchCap = BATCH_MAX;   // halved on a 413 (in memory: a restart tries the full size again)
let _why: string | null = null;
let _running = false;

type QueueRow = { id: number; order_id: string; payload: string; created_at: string; shift_id: string | null };

/** The next batch: the oldest waiting sales before the new-first cutoff, and the cash rows they need. */
function nextBatch(deps: HistoryDeps, now: number, cap: number, skip: number[]): { rows: QueueRow[]; cash: CashTablesLike; json: string } | null {
  const db = getLocalDb();
  // branch-wide: this POS's own queue (sync_queue); its orders looked up by the queued order id, as the order push.
  const rows = db.prepare(`
    SELECT q.id, q.order_id, q.payload, q.created_at, (SELECT o.shift_id FROM orders o WHERE o.id = q.order_id) AS shift_id
      FROM sync_queue q
     WHERE q.status = 'pending' AND julianday(q.created_at) < julianday(@cutoff)
       AND NOT ${deps.parkedSql}
       AND (q.drawer_wait_at IS NULL OR julianday(q.drawer_wait_at) < julianday(@waitBefore))
       AND q.id NOT IN (SELECT value FROM json_each(@skip))
     ORDER BY q.created_at ASC, q.id ASC LIMIT @cap`).all({
    cutoff: new Date(now - NEW_FIRST_MS).toISOString(), waitBefore: new Date(now - DRAWER_WAIT_RETRY_MS).toISOString(), cap, skip: JSON.stringify(skip),
  }) as QueueRow[];
  if (!rows.length) return null;
  const all = deps.readPendingCash();
  let n = rows.length;
  for (;;) {
    const part = rows.slice(0, n);
    const cash = cashForShifts(all, part.map((r) => r.shift_id).filter((x): x is string => !!x));
    const orders = part.map((r) => { let body: unknown = null; try { body = JSON.parse(r.payload); } catch { body = null; } return { id: r.order_id, body }; })
      .filter((o) => o.body && typeof o.body === 'object');
    const json = JSON.stringify({ orders, ...cash });
    if (Buffer.byteLength(json) <= MAX_BATCH_BYTES || n <= 1) return { rows: part, cash, json };
    n = Math.max(1, Math.floor(n / 2));
  }
}

/** One call. 'done' = nothing left to send now; 'stop' = the cloud did not take it (sent again later); else the sales stored. */
async function sendOneBatch(deps: HistoryDeps, now: number, errors: string[], skip: number[]): Promise<number | 'done' | 'stop'> {
  const batch = nextBatch(deps, now, _batchCap, skip);
  if (!batch) {
    if (oldPendingCount(now) === 0) {
      const st = saveState({ active: false, finishedAt: new Date(now).toISOString(), lastResult: 'finished' });
      logLine('sync', `history upload finished: ${st.done} older sale(s) sent; new sales go as usual`);
    }
    return 'done';
  }
  const db = getLocalDb();
  const gz = zlib.gzipSync(Buffer.from(batch.json, 'utf8'));
  let res: { status: number; body: any };
  try { res = await deps.post(gz); }
  catch (e: any) {
    saveState({ lastResult: `not sent: ${String(e?.message ?? e).slice(0, 160)}` });
    errors.push(`History upload: ${e?.message ?? e}`);
    return 'stop';   // the rows were not touched: the same batch goes next time
  }
  saveState({ lastBatchAt: new Date(now).toISOString() });
  if (res.status === 413) _batchCap = Math.max(25, Math.floor(batch.rows.length / 2));
  const body = res.body;
  if (res.status < 200 || res.status >= 300 || !body || body.ok !== true || !Array.isArray(body.results)) {
    const why = typeof body?.error === 'string' ? body.error : `HTTP ${res.status}`;
    saveState({ lastResult: `the cloud did not take the batch: ${why.slice(0, 160)}` });
    logLine('sync', `history upload: the cloud did not take ${batch.rows.length} sale(s) (HTTP ${res.status}: ${why.slice(0, 200)}) - sent again later`);
    errors.push(`History upload: ${why}`);
    return 'stop';
  }
  // The drawers, days, floats, expenses and kitchen voids — the drawer push's own marking of the cloud's answer.
  if (body.cash && typeof body.cash === 'object') {
    try { deps.applyCashAnswer(batch.cash, body.cash, errors); } catch (e: any) { logLine('sync', `history upload: cash answer: ${e?.message ?? e}`); }
  }
  const byOrder = new Map<string, any>(body.results.filter((r: any) => r && typeof r.id === 'string').map((r: any) => [r.id, r]));
  const c = { stored: 0, waiting: 0, refused: 0, later: 0 };
  const waitStmt = db.prepare(`UPDATE sync_queue SET last_error=?, drawer_wait_at=? WHERE id=? AND status='pending'`);
  const laterStmt = db.prepare(`UPDATE sync_queue SET last_error=? WHERE id=? AND status='pending'`);
  // As the normal push: a refusal on the sale's merits counts a try, and the fifth makes it 'failed' (a person's job).
  const refusedStmt = db.prepare(`UPDATE sync_queue SET attempts=attempts+1, last_error=?,
      status=CASE WHEN attempts+1 >= 5 THEN 'failed' ELSE 'pending' END WHERE id=? AND status='pending'`);
  const stamp = new Date(now).toISOString();
  let firstRefusal: string | null = null;
  db.transaction(() => {
    for (const row of batch.rows) {
      const r = byOrder.get(row.order_id);
      const status = r?.status;
      if (status === 'accepted' || status === 'duplicate') { deps.markSynced(row.id, row.order_id); c.stored++; }
      else if (status === 'waiting') { waitStmt.run(String(r.error ?? 'drawer not on the cloud yet').slice(0, 500), stamp, row.id); c.waiting++; }
      else if (status === 'refused') {
        const msg = String(r.error ?? `HTTP ${r.http ?? '?'}`).slice(0, 500);
        refusedStmt.run(msg, row.id); c.refused++; skip.push(row.id);   // one try a pass, as the normal push
        firstRefusal ??= `${row.order_id}: ${msg}`;
      } else { laterStmt.run(String(r?.error ?? 'not reached in this upload - sent again').slice(0, 500), row.id); c.later++; skip.push(row.id); }
    }
  })();
  const st = saveState({ done: getHistoryState().done + c.stored,
    lastResult: `${c.stored} stored, ${c.waiting} waiting for their drawer, ${c.refused} refused, ${c.later} later` });
  logLine('sync', `history upload: ${batch.rows.length} sale(s) in one call - ${st.lastResult}${firstRefusal ? `; first refusal ${firstRefusal}` : ''}`);
  if (c.refused) errors.push(`History upload: ${c.refused} sale(s) refused${firstRefusal ? ` (${firstRefusal})` : ''}`);
  return c.stored;
}

/**
 * The backfill stage (syncEngine runPushStagesOnce, after the order push). Sends batches while it is quiet, at most
 * PASS_BUDGET_MS, a pause between calls. Returns the sales stored. Never throws.
 */
export async function runHistoryUpload(deps: HistoryDeps, errors: string[] = []): Promise<number> {
  if (!historyBacklogActive()) { _why = null; return 0; }
  const now = deps.now ?? _seams.now ?? Date.now;
  const sleep = deps.sleep ?? _seams.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const activity = deps.activity ?? (() => { const a = activitySnapshot(); return { lastUse: a.lastUse, busy: a.busy }; });
  const t0 = now();
  let stored = 0;
  const skip: number[] = [];   // refused or not reached in this pass: offered again next pass, not in this one
  try {
    for (let first = true; ; first = false) {
      const a = activity();
      const v = quietVerdict({ now: now(), settings: getHistorySettings(), lastUse: a.lastUse, busy: a.busy });
      _why = v.why;
      if (!v.go) break;
      if (!first && now() - t0 >= PASS_BUDGET_MS) break;
      _running = true;
      const r = await sendOneBatch(deps, now(), errors, skip);
      _running = false;
      if (r === 'done' || r === 'stop') break;
      stored += r;
      if (now() - t0 >= PASS_BUDGET_MS) break;
      await sleep(BATCH_GAP_MS);
    }
  } catch (e: any) {
    errors.push(`History upload: ${e?.message ?? e}`);
    logLine('sync', `history upload stage failed: ${e?.message ?? e}`);
  } finally { _running = false; }
  return stored;
}

// ── progress ────────────────────────────────────────────────────────────────────────────────────────────────────────
export interface HistoryUploadStatus {
  active: boolean;
  fromCut: boolean;
  window: HistoryWindow;
  windowLabel: string;
  quietFrom: string;
  quietTo: string;
  done: number;
  remaining: number;
  percent: number;
  /** "45% (12,300 of 27,000 sales)" */
  progress: string;
  /** "in quiet hours (22:00–06:00)", "paused: a sale is in the cart", "waits for quiet hours …" — the last check's words. */
  why: string | null;
  running: boolean;
  localOnly: number;
  startedAt: string | null;
  finishedAt: string | null;
  lastBatchAt: string | null;
  lastResult: string | null;
}
/** Where the history upload stands (the manager's notice, the Tech page, the Backup tab). Never throws. */
export function historyUploadStatus(now: number = Date.now()): HistoryUploadStatus {
  const st = getHistoryState();
  const s = getHistorySettings();
  const remaining = st.active ? oldPendingCount(now) : 0;
  const p = progressLabel(st.done, remaining);
  return {
    active: st.active, fromCut: st.fromCut, window: s.window, windowLabel: HISTORY_WINDOW_LABEL[s.window], quietFrom: s.quietFrom, quietTo: s.quietTo,
    done: st.done, remaining, percent: p.percent, progress: p.text, why: st.active ? (_why ?? `goes in quiet hours (${s.quietFrom}–${s.quietTo}) or after 10 minutes without use`) : null,
    running: _running, localOnly: localOnlyCount(), startedAt: st.startedAt, finishedAt: st.finishedAt, lastBatchAt: st.lastBatchAt, lastResult: st.lastResult,
  };
}

