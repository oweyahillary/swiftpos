// backupService.ts — A600: the Backup panel's rules, and restoring a backup safely.
// ─────────────────────────────────────────────────────────────────────────────
// Owner, 2026-10-28 (docs/DESKTOP-ONLY-CUTOFF-PLAN.md, decision 5): every PC backs itself up, and the owner or a manager
// sees it and can act on it without a technician. After the cut a desktop-only business's PC holds the only copy of its
// sales, so a backup nobody can see, or one that cannot be put back, is not a backup.
//
// WHO (checked here, in main — the hidden button on the screen is only a courtesy):
//   - the Backup panel (see it, "Back up now", choose the folder): a technician signed in, or someone holding
//     settings.business (the business settings — the owner, a General Manager) or shifts.close_branch (who closes the
//     branch at night — every Manager by default). No new permission key: a key the cloud does not know would need a
//     cloud migration, and these two are already "runs the place".
//   - Restore (replaces this PC's database): the owner ('*') or a technician signed in, and the word RESTORE typed.
//
// RESTORE — what is checked before anything is replaced (inspectBackup):
//   1. it is a SQLite file ("SQLite format 3" header) and passes PRAGMA quick_check AND integrity_check;
//   2. it is a ZapTill database (a device_config row) made by this version or an older one (never a newer schema);
//   3. it is THIS business's: the business id kept in the database (session, else backup_business_id, which every
//      backup writes into itself) must match. Another business's backup is refused, always. A PC not set up yet (no
//      business, no branch) cannot check, so only a technician may restore onto it;
//   4. it is THIS POS's: a backup from another POS of the same business is refused while this PC has sales of its own
//      (they would be lost and two PCs would share one identity). On a PC with no sales of its own (a new PC replacing a
//      dead one) it is allowed, with a clear warning: this PC takes over as the POS that made the backup — use it only
//      when that PC is no longer in use.
// Then (stageRestore): a safety copy of the current database is taken (SQLite's backup API, into restore/), the checked
// copy is staged, and ZapTill restarts; restoreSwap.ts swaps it in before the database opens.

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { getLocalDb, LOCAL_SCHEMA_VERSION } from './localDb';
import { getDeviceConfig, isNodeRole } from './deviceConfig';
import { logLine } from './logFile';
import { getActiveSession, logTechAction } from './techService';
import { signedIn, signedInCan, signedInKeys } from './tillAccess';
import { getState, setState, snapshotDir } from './maintenance';
import { restoreDir, stagedRestorePath, restorePlanPath, restoreDonePath, type RestorePlan, type RestoreDone } from './restoreSwap';

// ── Rights ───────────────────────────────────────────────────────────────────

export const BACKUP_KEYS = ['settings.business', 'shifts.close_branch'] as const;
export const BACKUP_REFUSAL = 'Only the owner or a manager can manage the backups.';
export const RESTORE_REFUSAL = 'Only the owner or a technician can restore a backup.';
export const RESTORE_WORD = 'RESTORE';

function techOn(): boolean { try { return !!getActiveSession(); } catch { return false; } }

export function mayBackup(): boolean { return techOn() || signedInCan(...BACKUP_KEYS); }
export function mayRestore(): boolean { return techOn() || signedInKeys().has('*'); }
export function assertMayBackup(): void {
  if (techOn()) return;
  if (!signedIn()) throw new Error('Not signed in');
  if (!signedInCan(...BACKUP_KEYS)) throw new Error(BACKUP_REFUSAL);
}
export function assertMayRestore(): void {
  if (techOn()) return;
  if (!signedIn()) throw new Error('Not signed in');
  if (!signedInKeys().has('*')) throw new Error(RESTORE_REFUSAL);
}
function whoAsked(): string {
  if (techOn()) return 'technician';
  const me = signedIn();
  return me ? `${me.name ?? 'staff'} (${me.roleName ?? 'no role'})` : 'unknown';
}

// ── Reading a database's identity ──────────────────────────────────────────────

export interface DbIdentity {
  business_id: string | null; business_name: string | null;
  branch_id: string | null; device_id: string | null; device_name: string | null; terminal_code: string | null;
  schema_version: number; orders: number; last_sale_at: string | null; last_backup_at: string | null;
}

function one<T>(db: Database.Database, sql: string, ...args: unknown[]): T | undefined {
  try { return db.prepare(sql).get(...args) as T | undefined; } catch { return undefined; }
}

export function identityOf(db: Database.Database): DbIdentity & { has_config: boolean } {
  const sess = one<{ business_id?: string; business_name?: string }>(db, `SELECT business_id, business_name FROM session WHERE id = 1`);
  const kv = (k: string) => one<{ value: string | null }>(db, `SELECT value FROM maintenance_state WHERE key = ?`, k)?.value ?? null;
  const cfg = one<{ branch_id?: string; device_id?: string; device_name?: string; terminal_code?: string }>(db,
    `SELECT * FROM device_config WHERE id = 1`);
  const ver = one<{ version: number }>(db, `SELECT version FROM schema_version WHERE id = 1`)?.version ?? 0;
  const own = cfg?.device_id ?? null;
  const orders = one<{ n: number; at: string | null }>(db,
    `SELECT COUNT(*) n, MAX(created_at) at FROM orders WHERE COALESCE(device_id,'') = COALESCE(?,'')`, own);
  return {
    has_config: !!cfg,
    business_id: sess?.business_id || kv('backup_business_id'),
    business_name: sess?.business_name || kv('backup_business_name'),
    branch_id: cfg?.branch_id ?? null, device_id: own, device_name: cfg?.device_name ?? null,
    terminal_code: cfg?.terminal_code ?? null, schema_version: Number(ver) || 0,
    orders: Number(orders?.n ?? 0), last_sale_at: orders?.at ?? null, last_backup_at: kv('last_backup_at'),
  };
}

/** This PC's own identity (its live database). */
export function currentIdentity(): DbIdentity {
  const id = identityOf(getLocalDb());
  const cfg = getDeviceConfig();
  return { ...id, branch_id: cfg?.branch_id ?? id.branch_id, device_id: cfg?.device_id ?? id.device_id,
    device_name: cfg?.device_name ?? id.device_name, terminal_code: cfg?.terminal_code ?? id.terminal_code };
}

// ── Inspecting a chosen backup ─────────────────────────────────────────────────

export interface BackupCheck {
  ok: boolean;
  /** Why it cannot be restored (ok false). */
  refusal: string | null;
  /** What the person must know before typing RESTORE (ok true). */
  warnings: string[];
  /** Only a technician may restore it (a PC not set up yet cannot check the business). */
  needs_tech: boolean;
  /** It is another POS of this business; restoring makes this PC that POS. */
  takes_over_device: string | null;
  backup: { file: string; bytes: number; taken_at: string | null; business_name: string | null; pos_name: string | null;
            orders: number; last_sale_at: string | null } | null;
  /** Hands the checked copy to stageRestore (kept in main; the screen never names a path to restore). */
  token: string | null;
}

const _checked = new Map<string, { copy: string; source: string; check: BackupCheck; at: number }>();
const CHECK_TTL_MS = 30 * 60_000;

function refuse(refusal: string, backup: BackupCheck['backup'] = null): BackupCheck {
  return { ok: false, refusal, warnings: [], needs_tech: false, takes_over_device: null, backup, token: null };
}

/** When the backup was made: its file name (swiftpos-<ISO>.db), else the file's time. */
function takenAt(file: string): string | null {
  const m = /swiftpos-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(path.basename(file));
  if (m) return `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`;
  try { return fs.statSync(file).mtime.toISOString(); } catch { return null; }
}

/**
 * Check a backup file without touching this PC's database. The file is copied into restore/ first (so the original on
 * the USB stick is never opened for writing, and what is staged later is exactly what was checked).
 */
export function inspectBackup(file: string): BackupCheck {
  const source = String(file ?? '').trim();
  if (!source) return refuse('Choose a backup file.');
  let bytes = 0;
  try {
    const st = fs.statSync(source);
    if (!st.isFile()) return refuse('That is not a file.');
    bytes = st.size;
    const fd = fs.openSync(source, 'r');
    const head = Buffer.alloc(16);
    try { fs.readSync(fd, head, 0, 16, 0); } finally { fs.closeSync(fd); }
    if (head.toString('latin1') !== 'SQLite format 3\u0000') return refuse('This file is not a ZapTill backup.');
  } catch (err: any) {
    return refuse(`The file could not be read: ${err?.message ?? 'unknown error'}`);
  }
  if (path.resolve(source).toLowerCase() === path.resolve(getLocalDb().name).toLowerCase()) {
    return refuse('That is the database this POS is using now, not a backup.');
  }

  fs.mkdirSync(restoreDir(), { recursive: true });
  const copy = path.join(restoreDir(), `checking-${randomUUID()}.db`);
  const drop = () => { for (const s of ['', '-wal', '-shm']) { try { fs.rmSync(copy + s, { force: true }); } catch { /* */ } } };
  let bak: ReturnType<typeof identityOf>;
  try {
    fs.copyFileSync(source, copy);
    const db = new Database(copy, { fileMustExist: true });
    try {
      const quick = db.pragma('quick_check', { simple: true });
      const full = db.pragma('integrity_check', { simple: true });
      if (quick !== 'ok' || full !== 'ok') { db.close(); drop(); return refuse('This backup is damaged and cannot be restored. Choose another one.'); }
      bak = identityOf(db);
    } finally { try { db.close(); } catch { /* */ } }
  } catch (err: any) {
    drop();
    return refuse(/not a database|malformed|corrupt/i.test(String(err?.message))
      ? 'This backup is damaged and cannot be restored. Choose another one.'
      : `The backup could not be opened: ${err?.message ?? 'unknown error'}`);
  }

  const summary = { file: source, bytes, taken_at: takenAt(source), business_name: bak.business_name,
    pos_name: bak.device_name || bak.terminal_code, orders: bak.orders, last_sale_at: bak.last_sale_at };
  const fail = (why: string) => { drop(); return refuse(why, summary); };

  if (!bak.has_config || !bak.device_id) return fail('This file is not a ZapTill backup.');
  if (bak.schema_version > LOCAL_SCHEMA_VERSION) return fail('This backup was made by a newer ZapTill. Update this POS first, then restore it.');

  const cur = currentIdentity();
  const warnings: string[] = [];
  let needsTech = false;

  // 3. The business.
  if (cur.business_id && bak.business_id) {
    if (cur.business_id !== bak.business_id) {
      return fail(`This backup belongs to another business${bak.business_name ? ` (${bak.business_name})` : ''}. It cannot be restored here.`);
    }
  } else if (cur.branch_id && bak.branch_id && cur.branch_id === bak.branch_id) {
    // Same branch → same business (a branch belongs to one business).
  } else if (!cur.business_id && !cur.branch_id) {
    needsTech = true;
    warnings.push('This POS is not set up yet, so it cannot check that the backup is this business\'s. Only a technician can restore it.');
  } else {
    return fail('This backup cannot be checked against this business. Ask your technician.');
  }
  if (cur.branch_id && bak.branch_id && cur.branch_id !== bak.branch_id) warnings.push('This backup is from another branch of this business.');

  // 4. The POS.
  let takesOver: string | null = null;
  if (cur.device_id && bak.device_id !== cur.device_id) {
    const ownSales = currentIdentity().orders;
    if (ownSales > 0) {
      return fail(`This backup is from another POS${summary.pos_name ? ` (${summary.pos_name})` : ''}. This POS has ${ownSales} sale${ownSales === 1 ? '' : 's'} of its own that would be lost, so it cannot be restored here. Restore it on the POS that made it.`);
    }
    takesOver = bak.device_id;
    warnings.push(`This backup is from another POS${summary.pos_name ? ` (${summary.pos_name})` : ''}. This PC will become that POS. Only do this when the PC that made the backup is no longer used.`);
  }
  warnings.push('Everything recorded on this POS after the backup was made is replaced. A safety copy of the current data is kept first.');
  if (isNodeRole(getDeviceConfig()?.device_role)) {
    warnings.push('This PC is the branch server: sales the other POS sent to it after the backup was made are not in the backup. Ask your technician to check them after the restore.');
  }

  const token = randomUUID();
  const check: BackupCheck = { ok: true, refusal: null, warnings, needs_tech: needsTech, takes_over_device: takesOver, backup: summary, token };
  // One checked backup at a time: an older check's copy is dropped.
  for (const [k, v] of _checked) { try { fs.rmSync(v.copy, { force: true }); } catch { /* */ } _checked.delete(k); }
  _checked.set(token, { copy, source, check, at: Date.now() });
  return check;
}

// ── Staging the restore ────────────────────────────────────────────────────────

export interface StageResult { ok: boolean; error?: string; safety_copy?: string; restart?: boolean }

/**
 * Take the safety copy, stage the checked backup and write the plan. The caller restarts ZapTill (restoreSwap.ts swaps
 * it in at the next start). Rights and the typed word are checked here as well as in the handler.
 */
export async function stageRestore(token: string, typed: string, now = new Date()): Promise<StageResult> {
  assertMayRestore();
  if (String(typed ?? '').trim().toUpperCase() !== RESTORE_WORD) return { ok: false, error: `Type ${RESTORE_WORD} to confirm.` };
  const entry = _checked.get(String(token ?? ''));
  if (!entry || Date.now() - entry.at > CHECK_TTL_MS || !fs.existsSync(entry.copy)) {
    return { ok: false, error: 'Choose the backup file again — the check has expired.' };
  }
  if (entry.check.needs_tech && !techOn()) return { ok: false, error: 'Only a technician can restore a backup on a POS that is not set up yet.' };

  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const safety = path.join(restoreDir(), `safety-${stamp}.db`);
  try {
    fs.mkdirSync(restoreDir(), { recursive: true });
    await getLocalDb().backup(safety, { progress: () => 256 });   // the safety copy FIRST — the same API as the nightly backup
  } catch (err: any) {
    return { ok: false, error: `The safety copy of the current data could not be made (${err?.message ?? 'unknown error'}), so nothing was restored.` };
  }
  try {
    fs.rmSync(stagedRestorePath(), { force: true });
    fs.renameSync(entry.copy, stagedRestorePath());
    const plan: RestorePlan = {
      staged_at: now.toISOString(), source: entry.source, safety_copy: safety, backup_taken_at: entry.check.backup?.taken_at ?? null,
      by: whoAsked(), by_tech: techOn(), takes_over_device: entry.check.takes_over_device,
    };
    fs.writeFileSync(restorePlanPath(), JSON.stringify(plan, null, 2));
    _checked.delete(String(token));
    logLine('backup', `restore staged by ${plan.by}: ${plan.source} (made ${plan.backup_taken_at ?? 'unknown'})${plan.takes_over_device ? `, taking over POS ${plan.takes_over_device}` : ''}; safety copy ${safety}; ZapTill restarts to apply it`);
    if (plan.by_tech) { try { logTechAction('backup.restore', { source: plan.source, safety_copy: safety, takes_over: plan.takes_over_device }); } catch { /* */ } }
    return { ok: true, safety_copy: safety, restart: true };
  } catch (err: any) {
    try { fs.rmSync(restorePlanPath(), { force: true }); } catch { /* */ }
    return { ok: false, error: `The backup could not be prepared: ${err?.message ?? 'unknown error'}` };
  }
}

/**
 * After the start that swapped a restore in (the database is open, the log is up): record it in the restored database
 * (the old database's log and audit were swapped out with it) and keep the note for the Backup panel.
 */
export function noteRestoreDone(): RestoreDone | null {
  const file = restoreDonePath();
  if (!fs.existsSync(file)) return null;
  let done: RestoreDone | null = null;
  try { done = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* */ }
  try { fs.renameSync(file, path.join(restoreDir(), `restore-done-${Date.now()}.json`)); } catch { try { fs.rmSync(file, { force: true }); } catch { /* */ } }
  if (!done) return null;
  setState('last_restore', JSON.stringify({ at: done.done_at, applied: done.applied, source: done.source, by: done.by,
    safety_copy: done.safety_copy, moved_to: done.moved_to, error: done.error }));
  logLine('backup', done.applied ? `this POS now runs on the restored backup ${done.source}` : `the restore did not happen: ${done.error}`);
  if (done.by_tech) { try { logTechAction(done.applied ? 'backup.restored' : 'backup.restore_failed', { source: done.source, error: done.error }); } catch { /* */ } }
  return done;
}

/** The last restore, for the Backup panel (null: never). */
export function lastRestore(): { at: string; applied: boolean; source: string; by: string; error: string | null } | null {
  try { return JSON.parse(getState('last_restore') ?? 'null'); } catch { return null; }
}

/** Where the file chooser opens: the backup folder. */
export function restoreChooserDir(): string { return snapshotDir(); }
