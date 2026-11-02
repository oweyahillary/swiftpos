// maintenance.ts — Phase 2c: bounded replicas and the snapshot job
// ─────────────────────────────────────────────────────────────────────────────
// Two jobs that keep the replicated star honest over months, not days:
//
// PRUNING (peers only). A replica is a rolling operational cache, not an
// archive: a till prunes OTHER devices' rows past the retention window. The
// archive-confirmation rule is satisfied BY CONSTRUCTION for a peer — every
// replica row it holds arrived from the node, so the node provably holds it.
// The NODE prunes nothing in this version, either mode: offline it IS the
// archive; online, confirming the cloud's custody of another device's rows
// needs a server capability that does not exist yet (named in the design as
// deferred, not forgotten). What the bound buys: a stolen PEER till exposes
// one retention window of one branch, not the business's life.
//
// SNAPSHOTS (every PC since A600; the branch server only before). A copy every 6 hours and after a day close (A600
// follow-up) of the database to a second location,
// N-snapshot retention, result recorded where a person can see it — a backup
// nobody can see the age of is a hope, and one that has never been restored
// is a guess. Uses SQLite's own backup API (transactionally consistent, safe
// against a live WAL), never fs.copyFile. When 2d lands, snapshots become
// encrypted automatically because the database file itself will be.

import fs from 'fs';
import { isNodeRole } from './deviceConfig';
import path from 'path';
import { app } from 'electron';
import { getLocalDb, getDbPath } from './localDb';
import { getDeviceConfig } from './deviceConfig';
import { REPLICATED_TABLES } from './nodeIngest';
import { logLine } from './logFile';   // A600 follow-up
import { onClosed, type CloseKind } from './closeHooks';   // A600 follow-up

// ── maintenance_state ────────────────────────────────────────────────────────

export function getState(key: string): string | null {
  const row = getLocalDb().prepare(`SELECT value FROM maintenance_state WHERE key = ?`).get(key) as { value: string | null } | undefined;
  return row?.value ?? null;
}
export function setState(key: string, value: string | null): void {
  getLocalDb().prepare(`
    INSERT INTO maintenance_state (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, value, new Date().toISOString());
}

const DEFAULT_RETENTION_DAYS = 90;
// A600 follow-up (owner, 2026-10-28): "the system deletes old backups, keeping only the 10 most recent".
export const DEFAULT_SNAPSHOT_KEEP = 10;

export function retentionDays(): number {
  const n = Number(getState('replica_retention_days'));
  return Number.isFinite(n) && n >= 7 ? n : DEFAULT_RETENTION_DAYS;   // floor of 7: a sub-week window is a misconfiguration, not a policy
}
export function snapshotKeep(): number {
  // A technician's snapshot_keep may keep fewer (2 at least), never more than the owner's 10.
  const n = Number(getState('snapshot_keep'));
  return Number.isFinite(n) && n >= 2 ? Math.min(Math.floor(n), DEFAULT_SNAPSHOT_KEEP) : DEFAULT_SNAPSHOT_KEEP;
}

/**
 * A600 follow-up: exactly the name runSnapshot gives a copy (swiftpos-<ISO time with : and . as ->.db). Only these are
 * counted and only these are ever deleted — anything else in the folder (the owner's own files on a USB stick, a
 * renamed copy, a restore's safety copy) is never touched.
 */
export const BACKUP_FILE_RE = /^swiftpos-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.db$/;
export function backupFiles(dir: string): string[] {
  try { return fs.readdirSync(dir).filter(f => BACKUP_FILE_RE.test(f)).sort(); } catch { return []; }   // ISO stamps sort chronologically
}

// ── Pruning ──────────────────────────────────────────────────────────────────

export interface PruneResult { cutoff: string; deleted: Record<string, number>; skipped: string | null }

/**
 * Delete OTHER devices' rows older than the retention window. Own rows are
 * never touched at any age — this till is the authority for them. Events are
 * pruned only once applied or refused (an unapplied event is a mutation still
 * owed to a row that may yet arrive). Order children go with their orders in
 * the same transaction.
 */
export function pruneReplicas(now = new Date()): PruneResult {
  const cfg = getDeviceConfig();
  const own = cfg?.device_id ?? '';
  const cutoff = new Date(now.getTime() - retentionDays() * 86_400_000).toISOString();
  const deleted: Record<string, number> = {};

  // The node is the archive (offline) or holds the full-history role until
  // cloud-confirmed pruning exists (online). Either way: it keeps everything.
  if (isNodeRole(cfg?.device_role)) {
    return { cutoff, deleted, skipped: 'node keeps everything — it is the archive tier' };
  }
  if (!own) return { cutoff, deleted, skipped: 'no device identity yet' };

  const db = getLocalDb();
  db.transaction(() => {
    // Children first, keyed to the orders about to go.
    for (const child of ['order_items', 'payments'] as const) {
      deleted[child] = db.prepare(`
        DELETE FROM ${child} WHERE order_id IN (
          -- branch-wide: pruning selects OTHER devices' expired replicas by
          -- design; own rows are excluded by the same predicate everywhere.
          SELECT id FROM orders
           WHERE COALESCE(device_id,'') != COALESCE(?,'') AND created_at < ?
        )
      `).run(own, cutoff).changes;
    }
    for (const table of REPLICATED_TABLES) {
      if (table === 'events') continue;   // separate rule below
      deleted[table] = db.prepare(`
        -- branch-wide: same predicate — expired replicas only, never own rows.
        DELETE FROM ${table}
         WHERE COALESCE(device_id,'') != COALESCE(?,'') AND created_at < ?
      `).run(own, cutoff).changes;
    }
    deleted.events = db.prepare(`
      -- branch-wide: other devices' SETTLED events (applied or refused). An
      -- unapplied event (0) is never pruned at any age — it is a mutation
      -- still owed to a row that may yet arrive.
      DELETE FROM events
       WHERE COALESCE(device_id,'') != COALESCE(?,'') AND created_at < ?
         AND applied != 0
    `).run(own, cutoff).changes;
  })();

  setState('last_prune_at', now.toISOString());
  setState('last_prune_summary', JSON.stringify(deleted));
  return { cutoff, deleted, skipped: null };
}

/** Run at most once per day, scheduled from index.ts. */
export function pruneIfDue(now = new Date()): PruneResult | null {
  const last = getState('last_prune_at');
  if (last && now.getTime() - new Date(last).getTime() < 20 * 3_600_000) return null;
  return pruneReplicas(now);
}

// ── Snapshots ────────────────────────────────────────────────────────────────

export interface SnapshotResult { ok: boolean; path?: string; bytes?: number; error?: string; pruned?: number; skipped?: 'space' }

export function defaultSnapshotDir(): string {
  return path.join(app.getPath('userData'), 'backups');
}
export function snapshotDir(): string {
  return getState('backup_dir') || defaultSnapshotDir();
}

/**
 * A380: is this folder on the database's own disk? A failed disk (or a stolen PC) takes the database and such backups
 * together. Compared by volume (fs dev — the volume serial on Windows) when both exist, else by drive / UNC root.
 * A network share (\\server\share) is another machine: not the same disk.
 */
export function onDatabaseDisk(dir: string, dbPath = getDbPath()): boolean {
  // A share (\\server\share, or //server/share) is another machine — read off the path as given: resolving first turns
  // it into a folder under the current one on anything but Windows.
  if (/^(\\\\|\/\/)/.test(String(dir).trim())) return false;
  const resolved = path.resolve(dir);
  try {
    const existing = fs.existsSync(resolved) ? resolved : path.dirname(resolved);
    return fs.statSync(existing).dev === fs.statSync(dbPath).dev;
  } catch {
    return path.parse(resolved).root.toLowerCase() === path.parse(path.resolve(dbPath)).root.toLowerCase();
  }
}

/**
 * A380 (owner, 2026-10-03: "we add the backup folder setting later"; 2026-10-13: "A380 is okay we can build it"): the
 * branch server's backups go to the folder the technician chooses (a USB drive, a second disk). Proven at once: a backup
 * is written there now; if that fails the previous folder stays and the reason is returned. null = back to the default.
 */
export async function setBackupDir(dir: string | null, now = new Date()): Promise<SnapshotResult & { dir: string; same_disk: boolean }> {
  const previous = getState('backup_dir');
  const target = dir && dir.trim() ? path.resolve(dir.trim()) : null;
  setState('backup_dir', target);
  const r = await takeSnapshot(now, 'folder');
  if (!r.ok) {
    setState('backup_dir', previous);
    return { ...r, error: `Could not write a backup to ${target ?? defaultSnapshotDir()}: ${r.error ?? 'unknown error'} — the backups stay in ${snapshotDir()}.`, dir: snapshotDir(), same_disk: onDatabaseDisk(snapshotDir()) };
  }
  return { ...r, dir: snapshotDir(), same_disk: onDatabaseDisk(snapshotDir()) };
}

/**
 * One consistent snapshot of the whole database into the backup directory,
 * plus retention. The result — success OR failure — is recorded in
 * maintenance_state, because a backup job that fails silently for a month is
 * indistinguishable from one that works until the day it matters.
 *
 * A600: in small steps (BACKUP_PAGES_PER_STEP pages, then the event loop is free again — a sale rung mid-backup is
 * answered between two steps, never after the whole copy), one at a time (a "Back up now" while the nightly one runs
 * waits for it and gets its result), and the business is written into the copy (backup_business_id), so a restore can
 * tell a backup of this business from another's even when nobody was signed in.
 */
export const BACKUP_PAGES_PER_STEP = 256;   // 1 MB of 4 KB pages a step
/** A600 follow-up: why a copy was made (kept in last_backup_reason; the panel says "after the day was closed"). */
export type BackupReason = 'scheduled' | 'manual' | 'folder' | 'day_close' | 'shift_close';
let _inFlight: Promise<SnapshotResult> | null = null;
export function takeSnapshot(now = new Date(), reason: BackupReason = 'manual'): Promise<SnapshotResult> {
  if (_inFlight) return _inFlight;
  _inFlight = runSnapshot(now, reason).finally(() => { _inFlight = null; });
  return _inFlight;
}
/** A600: a backup is being written right now. */
export function backupRunning(): boolean { return _inFlight !== null; }

/** A600: who this database belongs to, kept in the database itself (so it is in every backup). */
export function noteBusinessIdentity(): void {
  try {
    const s = getLocalDb().prepare(`SELECT business_id, business_name FROM session WHERE id = 1`).get() as { business_id?: string; business_name?: string } | undefined;
    if (s?.business_id && getState('backup_business_id') !== s.business_id) setState('backup_business_id', s.business_id);
    if (s?.business_name && getState('backup_business_name') !== s.business_name) setState('backup_business_name', s.business_name);
  } catch { /* no session table yet */ }
}

// ── A600 follow-up: the free-space guard ───────────────────────────────────────────────────────────────────────────
//
// A copy that fills the disk can stop the POS itself (SQLite cannot grow its own file or WAL, so the next sale fails).
// Before each copy the target drive must have 2 × the database (the copy, and room for the database to keep growing)
// plus SPACE_MARGIN_BYTES. Too little: no copy, one log line when it starts (not every 5 minutes), the panel turns red
// ("Not enough free space for a backup on E:"), and no "failed attempt" is recorded — so the 5-minute check tries again
// as soon as space is freed (it costs one statfs), not an hour later.

export const SPACE_MARGIN_BYTES = 200 * 1024 * 1024;
let _freeProbe: ((dir: string) => number | null) | null = null;
/** Tests: pretend the drive has this much free space (null: the real drive). */
export function setFreeSpaceProbe(fn: ((dir: string) => number | null) | null): void { _freeProbe = fn; }

/** Free bytes on the drive holding `dir` (fs.statfs — Node 18.15+), or null when it cannot be told (then no guard). */
export function freeBytes(dir: string): number | null {
  if (_freeProbe) return _freeProbe(dir);
  try {
    const statfs = (fs as any).statfsSync as ((p: string) => { bavail: number | bigint; bsize: number | bigint }) | undefined;
    if (typeof statfs !== 'function') return null;
    const st = statfs(dir);
    const n = Number(st.bavail) * Number(st.bsize);
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch { return null; }
}
/** The database as it is on disk now (the file and its WAL). */
export function databaseBytes(dbPath = getDbPath()): number {
  let n = 0;
  for (const f of [dbPath, `${dbPath}-wal`]) { try { n += fs.statSync(f).size; } catch { /* no WAL */ } }
  return n;
}
export function spaceNeeded(): number { return 2 * databaseBytes() + SPACE_MARGIN_BYTES; }
/** What a person calls the drive: "E:", a share's \\server\share, else the folder itself. */
export function driveOf(dir: string): string {
  const raw = String(dir).trim();
  if (/^(\\\\|\/\/)/.test(raw)) { const m = /^([\\/]{2}[^\\/]+[\\/][^\\/]+)/.exec(raw); return m ? m[1] : raw; }
  const root = path.parse(path.resolve(raw)).root;
  if (/^[A-Za-z]:[\\/]?$/.test(root)) return root.slice(0, 2).toUpperCase();
  return root.length > 1 ? root.replace(/[\\/]+$/, '') : raw;
}
export function spaceShortMessage(drive: string): string {
  return `Not enough free space for a backup on ${drive}. Free some space or choose another folder.`;
}
interface SpaceShort { dir: string; drive: string; free: number; need: number; since: string }
function readSpaceShort(): SpaceShort | null {
  try { return JSON.parse(getState('backup_space_short') ?? 'null'); } catch { return null; }
}

/** Retention: the newest `keep` ZapTill backups in `dir` stay; older ones go. Nothing else in the folder is touched. */
export function rotateBackups(dir: string, keep = snapshotKeep()): number {
  let pruned = 0;
  for (const f of backupFiles(dir).reverse().slice(keep)) {
    try { fs.unlinkSync(path.join(dir, f)); pruned++; } catch { /* next run */ }
  }
  return pruned;
}

async function runSnapshot(now: Date, reason: BackupReason): Promise<SnapshotResult> {
  try {
    const dir = snapshotDir();
    fs.mkdirSync(dir, { recursive: true });

    // A600 follow-up: the free-space guard (see above).
    const free = freeBytes(dir);
    const need = spaceNeeded();
    if (free !== null && free < need) {
      const drive = driveOf(dir);
      const was = readSpaceShort();
      if (!was || was.dir !== dir) {   // once when it starts — the 5-minute check never fills the log
        const short: SpaceShort = { dir, drive, free, need, since: now.toISOString() };
        setState('backup_space_short', JSON.stringify(short));
        setState('last_backup_status', `SKIPPED — not enough free space on ${drive}`);
        try { logLine('backup', `no backup: ${drive} has ${(free / 1048576).toFixed(0)} MB free, ${(need / 1048576).toFixed(0)} MB needed (2 × the database + 200 MB); tried again every 5 minutes, logged again only once it works`); } catch { /* */ }
      }
      return { ok: false, skipped: 'space', error: spaceShortMessage(drive) };
    }
    const short = readSpaceShort();
    if (short) {
      setState('backup_space_short', null);
      if (short.dir === dir) { try { logLine('backup', `free space on ${short.drive} again — backing up`); } catch { /* */ } }
    }

    const stamp = now.toISOString().replace(/[:.]/g, '-');
    const dest = path.join(dir, `swiftpos-${stamp}.db`);
    noteBusinessIdentity();

    // better-sqlite3's backup API: page-by-page, transactionally consistent,
    // correct against a live WAL. fs.copyFile on an open WAL database is how
    // a "backup" restores to a corrupt file.
    await getLocalDb().backup(dest, { progress: () => BACKUP_PAGES_PER_STEP });
    const bytes = fs.statSync(dest).size;

    // Retention: newest N stay (A600 follow-up: 10, and only files named exactly as a backup).
    const pruned = rotateBackups(dir);
    const kept = backupFiles(dir).length;

    setState('last_backup_at', now.toISOString());
    setState('last_backup_path', dest);
    setState('last_backup_bytes', String(bytes));   // A600: shown on Manager › Settings › Backup
    setState('last_backup_reason', reason);
    setState('last_backup_status', `ok — ${(bytes / 1024 / 1024).toFixed(1)} MB, keeping ${kept}`);
    return { ok: true, path: dest, bytes, pruned };
  } catch (err: any) {
    // A380: a failure is recorded as a failed ATTEMPT — last_backup_at stays the last GOOD backup, so the Tech page never
    // shows a failure as a recent backup, and the scheduled job tries again within the hour.
    setState('last_backup_attempt_at', now.toISOString());
    setState('last_backup_status', `FAILED — ${err?.message ?? 'unknown error'}`);
    return { ok: false, error: err?.message ?? 'snapshot failed' };
  }
}

// ── A600: the backup on every PC, every 6 hours ─────────────────────────────────────────────────────────────────────
//
// Owner, 2026-10-28 (docs/DESKTOP-ONLY-CUTOFF-PLAN.md, decision 5): "local backup on every PC first", a standalone POS
// included — after the cut a desktop-only business's PC holds the only copy of its sales. Before A600 only the branch
// server backed itself up; a POS on its own (role 'till', the default) never did.
// Follow-up, owner, 2026-10-28 (final): "back up every 6 hours", and right after the business day is closed; "the system
// deletes old backups, keeping only the 10 most recent".
//
// THE RULE — one backup per 6-hour slot, caught up if the PC was off or busy:
//   - slots at BACKUP_SLOT_HOURS (03:00, 09:00, 15:00, 21:00 local time). A slot is due once its time has passed and no
//     backup (scheduled, "Back up now", after a close) has been taken since it began — so at most one scheduled copy
//     per slot, four a day;
//   - a PC that was off or busy at the slot backs up once nobody has touched it for IDLE_SECONDS (between customers),
//     or anyway once it has waited FORCE_AFTER_MS — the copy runs in small steps and never blocks a sale;
//   - a failed one is tried again after an hour (A380); one skipped for lack of space at the next 5-minute check;
//   - right after a day close on this PC (closeDayCore — at the POS, from Close Branch, adopted from the web, or an
//     empty old day closing itself), and on a standalone POS (no branch server) after a shift close too: a copy at
//     once (closeHooks.ts → wireCloseBackups, from index.ts). It counts as that slot's backup.
// EVERY role: a POS beside a branch server keeps its own sales too (its replicas are the others' rows, pruned at 90
// days, so its copy stays small). Cost: one state read and one statfs every 5 minutes, ~4–6 copies a day, 10 on disk.

export const BACKUP_SLOT_HOURS = [3, 9, 15, 21] as const;
export const IDLE_SECONDS = 120;
export const FORCE_AFTER_MS = 30 * 60_000;
/** The panel turns red after 12 hours without a backup (two slots missed) once this PC has been on long enough to have
 *  caught up (WARN_GRACE_AFTER_START_MS), and after 2 days whatever happened. */
export const WARN_AFTER_MS = 12 * 3_600_000;
export const WARN_ALWAYS_AFTER_MS = 2 * 86_400_000;
export const WARN_GRACE_AFTER_START_MS = 45 * 60_000;
const _startedAt = Date.now();

/** The latest backup slot (local time) at or before `now` — the start of the current 6-hour window. */
export function lastBackupSlot(now: Date): Date {
  const hours = [...BACKUP_SLOT_HOURS].reverse();
  for (let back = 0; back <= 1; back++) {
    for (const h of hours) {
      const slot = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back, h, 0, 0, 0);
      if (slot.getTime() <= now.getTime()) return slot;
    }
  }
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, hours[0], 0, 0, 0);   // not reached
}

/** Is the current slot's backup still owed? (No backup ever: yes.) */
export function backupDueAt(now = new Date()): boolean {
  const last = getState('last_backup_at');
  return !last || new Date(last).getTime() < lastBackupSlot(now).getTime();
}

let _dueSince: number | null = null;   // when this run first found the slot's backup due with somebody at the PC
/** Tests: forget when the current wait began. */
export function resetBackupWait(): void { _dueSince = null; }

/**
 * Every role. Scheduled from index.ts every 5 minutes and soon after start. `idleSeconds`: how long since anyone
 * touched the PC (powerMonitor) — null when unknown (a headless branch server, a test), which counts as idle.
 */
export async function snapshotIfDue(now = new Date(), idleSeconds: number | null = null): Promise<SnapshotResult | null> {
  if (!backupDueAt(now)) { _dueSince = null; return null; }
  const last = getState('last_backup_at');
  const tried = getState('last_backup_attempt_at');   // A380: a failed one is tried again after an hour
  if (tried && (!last || tried > last) && now.getTime() - new Date(tried).getTime() < 3_600_000) return null;
  if (_inFlight) return null;
  const idle = idleSeconds === null || idleSeconds >= IDLE_SECONDS;
  if (!idle) {
    if (_dueSince === null) _dueSince = now.getTime();
    if (now.getTime() - _dueSince < FORCE_AFTER_MS) return null;
  }
  _dueSince = null;
  return takeSnapshot(now, 'scheduled');
}

// ── A600 follow-up: a backup right after a close ────────────────────────────────────────────────────────────────────

/** A POS with no branch server (and not one itself): the only PC holding its sales. */
export function standalonePos(): boolean {
  const cfg = getDeviceConfig();
  return !!cfg && !isNodeRole(cfg.device_role) && !cfg.node_url;
}

let _closeWaiting = false;
/**
 * A copy right after a close: every PC after a day close, a standalone POS after a shift close too. At once (the person
 * who closed is not selling; the copy is stepped anyway), not held by the 1-hour retry. A copy already running started
 * before the close, so this one waits for it and takes a fresh one; closes that arrive while one is waiting share it.
 */
export async function backupAfterClose(kind: CloseKind, now?: Date): Promise<SnapshotResult | null> {
  if (kind === 'shift' && !standalonePos()) return null;
  if (_closeWaiting) return null;   // the copy already waiting starts after this close too
  if (_inFlight) {
    _closeWaiting = true;
    try { await _inFlight.catch(() => null); } finally { _closeWaiting = false; }
  }
  return takeSnapshot(now ?? new Date(), kind === 'day' ? 'day_close' : 'shift_close');
}

/** index.ts: back up after every close on this PC (closeHooks.ts). Returns the unsubscribe. */
export function wireCloseBackups(): () => void {
  return onClosed((kind) => {
    backupAfterClose(kind).then((r) => {
      if (!r) return;
      try { logLine('backup', `after the ${kind} close: ${r.ok ? `backed up (${r.path})` : `no backup — ${r.error ?? 'unknown error'}`}`); } catch { /* */ }
    }).catch((err) => console.error('[maintenance] backup after close:', err));
  });
}

/** A600: what the Backup panel shows. */
export interface BackupStatus {
  last_backup_at: string | null; last_backup_path: string | null; last_backup_bytes: number | null;
  last_backup_status: string | null; failed: boolean;
  /** Why the last copy was made (a close, Back up now, the schedule). */
  last_backup_reason: BackupReason | null;
  /** No good backup for 12 hours once this PC has been on 45 minutes, for 2 days whatever, or none ever — red. */
  warn: boolean;
  /** Hours since the last good backup (null: none). */
  hours_since: number | null;
  dir: string; default_dir: string; custom_dir: boolean; same_disk: boolean; keep: number; copies: number;
  /** The space the copies in the folder take. */
  copies_bytes: number;
  /** The last copy was skipped for lack of space on this folder's drive (red, with the drive named). */
  space_short: { drive: string; free: number; need: number; message: string } | null;
  running: boolean;
}
export function backupStatus(now = new Date(), startedAtMs = _startedAt): BackupStatus {
  const last = getState('last_backup_at');
  const status = getState('last_backup_status');
  const dir = snapshotDir();
  const files = backupFiles(dir);
  let copiesBytes = 0;
  for (const f of files) { try { copiesBytes += fs.statSync(path.join(dir, f)).size; } catch { /* gone meanwhile */ } }
  const bytes = Number(getState('last_backup_bytes'));
  const age = last ? now.getTime() - new Date(last).getTime() : null;
  const short = readSpaceShort();
  const reason = getState('last_backup_reason') as BackupReason | null;
  return {
    last_backup_at: last,
    last_backup_path: getState('last_backup_path'),
    last_backup_bytes: Number.isFinite(bytes) && bytes > 0 ? bytes : null,
    last_backup_status: status,
    failed: /^FAILED/.test(status ?? ''),
    last_backup_reason: reason,
    warn: age === null || age > WARN_ALWAYS_AFTER_MS || (age > WARN_AFTER_MS && now.getTime() - startedAtMs >= WARN_GRACE_AFTER_START_MS),
    hours_since: age === null ? null : Math.max(0, Math.floor(age / 3_600_000)),
    dir, default_dir: defaultSnapshotDir(), custom_dir: !!getState('backup_dir'),
    same_disk: onDatabaseDisk(dir), keep: snapshotKeep(), copies: files.length, copies_bytes: copiesBytes,
    space_short: short && short.dir === dir ? { drive: short.drive, free: short.free, need: short.need, message: spaceShortMessage(short.drive) } : null,
    running: _inFlight !== null,
  };
}

/** What a person sees on the tech card. */
export function maintenanceStatus(): {
  last_backup_at: string | null; last_backup_status: string | null; backup_dir: string;
  last_prune_at: string | null; retention_days: number;
  /** A380: the folder is on the database's own disk; the technician chose it (else the default). */
  same_disk: boolean; custom_dir: boolean; keep: number;
} {
  return {
    last_backup_at: getState('last_backup_at'),
    last_backup_status: getState('last_backup_status'),
    backup_dir: snapshotDir(),
    same_disk: onDatabaseDisk(snapshotDir()),
    custom_dir: !!getState('backup_dir'),
    keep: snapshotKeep(),
    last_prune_at: getState('last_prune_at'),
    retention_days: retentionDays(),
  };
}
