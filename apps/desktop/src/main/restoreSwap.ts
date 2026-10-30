// restoreSwap.ts — A600: a restore takes effect at the next start, before the database opens.
// ─────────────────────────────────────────────────────────────────────────────
// A database cannot be replaced while it is open (Windows holds the file; and a live WAL beside it would be applied to
// the wrong file). So a restore is two halves:
//   1. backupService.stageRestore (while ZapTill runs): the chosen backup is checked, a safety copy of the current
//      database is taken, the backup is copied to restore/swiftpos-restore.db and restore/restore-plan.json is written.
//      ZapTill then restarts.
//   2. applyPendingRestore (here, from getLocalDb before the file is opened): the current database and its -wal / -shm
//      are MOVED (not deleted) into restore/before-restore-<time>/, the staged file takes its place, and the outcome is
//      written to restore/restore-done.json, which backupService.noteRestoreDone logs once the database is open.
// Nothing here imports localDb (it runs inside it) — only fs, path and the log.

import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import { logLine } from './logFile';

export function restoreDir(): string { return path.join(app.getPath('userData'), 'restore'); }
export function stagedRestorePath(): string { return path.join(restoreDir(), 'swiftpos-restore.db'); }
export function restorePlanPath(): string { return path.join(restoreDir(), 'restore-plan.json'); }
export function restoreDonePath(): string { return path.join(restoreDir(), 'restore-done.json'); }

/** The plan stageRestore writes; restore-done.json carries it with the outcome. */
export interface RestorePlan {
  staged_at: string;
  source: string;                 // the backup file the person chose
  safety_copy: string;            // the backup-API copy of the database taken before staging
  backup_taken_at: string | null; // when the chosen backup was made (its last_backup_at / file time)
  by: string;                     // who asked (the staff member, or "technician")
  by_tech: boolean;
  takes_over_device: string | null;   // the backup is another POS of this business: the device it was
}
export interface RestoreDone extends RestorePlan { applied: boolean; moved_to: string | null; error: string | null; done_at: string }

/** How many before-restore folders are kept (each is a whole database). */
const KEEP_BEFORE = 3;

/**
 * Called from getLocalDb, before the database is opened. Returns what it did (null: no restore was waiting). Never
 * throws: a failed swap leaves the current database where it was and says why.
 */
export function applyPendingRestore(dbPath: string, now = new Date()): RestoreDone | null {
  const planFile = restorePlanPath();
  if (!fs.existsSync(planFile)) return null;
  let plan: RestorePlan;
  try { plan = JSON.parse(fs.readFileSync(planFile, 'utf8')); }
  catch { try { fs.rmSync(planFile, { force: true }); } catch { /* */ } return null; }
  const staged = stagedRestorePath();
  const done: RestoreDone = { ...plan, applied: false, moved_to: null, error: null, done_at: now.toISOString() };
  try {
    if (!fs.existsSync(staged)) throw new Error('the staged backup is missing');
    const aside = path.join(restoreDir(), `before-restore-${now.toISOString().replace(/[:.]/g, '-')}`);
    fs.mkdirSync(aside, { recursive: true });
    const base = path.basename(dbPath);
    for (const suffix of ['', '-wal', '-shm']) {
      const from = dbPath + suffix;
      if (fs.existsSync(from)) fs.renameSync(from, path.join(aside, base + suffix));
    }
    done.moved_to = aside;
    try { fs.renameSync(staged, dbPath); }
    catch (err) {
      // Put the current database back — a half-done swap must never leave the PC with no database.
      for (const suffix of ['', '-wal', '-shm']) {
        const kept = path.join(aside, base + suffix);
        if (fs.existsSync(kept) && !fs.existsSync(dbPath + suffix)) fs.renameSync(kept, dbPath + suffix);
      }
      done.moved_to = null;
      throw err;
    }
    done.applied = true;
    pruneBeforeFolders();
  } catch (err: any) {
    done.error = err?.message ?? String(err);
    try { fs.rmSync(staged, { force: true }); } catch { /* */ }
  }
  try { fs.writeFileSync(restoreDonePath(), JSON.stringify(done, null, 2)); } catch { /* logged below */ }
  try { fs.rmSync(planFile, { force: true }); } catch { /* a plan left behind would be tried again: removed above */ }
  try {
    logLine('backup', done.applied
      ? `restore applied at start: ${plan.source} is now the database (asked by ${plan.by}); the previous database was moved to ${done.moved_to}`
      : `restore at start FAILED (${done.error}) — the database was left as it was`);
  } catch { /* the log is not up yet */ }
  return done;
}

function pruneBeforeFolders(): void {
  try {
    const dirs = fs.readdirSync(restoreDir()).filter(f => /^before-restore-/.test(f)).sort().reverse();
    for (const d of dirs.slice(KEEP_BEFORE)) fs.rmSync(path.join(restoreDir(), d), { recursive: true, force: true });
    const safety = fs.readdirSync(restoreDir()).filter(f => /^safety-.*\.db$/.test(f)).sort().reverse();
    for (const f of safety.slice(KEEP_BEFORE)) fs.rmSync(path.join(restoreDir(), f), { force: true });
  } catch { /* next restore */ }
}
