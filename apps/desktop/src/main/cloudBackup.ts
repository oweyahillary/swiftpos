/**
 * cloudBackup.ts — A601: the desktop-only cut-off, as this POS knows it.
 *
 * Owner, 2026-10-28 (docs/DESKTOP-ONLY-CUTOFF-PLAN.md): a business with no online licence (the cloud calls it
 * not_on_plan) keeps setup, sign-in, the catalogue and staff changes and support logs, but from the date ZapTill sets
 * (DESKTOP_ONLY_CUTOFF_AT on the cloud) its POS no longer backs up sales, shifts, drawers, reversals and day closes to the
 * cloud. Until the date the manager sees the notice.
 *
 * The cloud says so with every catalogue pull (/api/pos/init `cloudBackup: { on, phase, cutoffAt }`, and a 'money'
 * change when the cloud_backup flag is switched), and a branch server relays it to its POSs in its bundle. Kept in
 * maintenance_state (the key/value table) — no device_config column, no schema change. undefined = not said (an older
 * cloud, an older branch server) → keep. Never written by the renderer.
 *
 * When off:
 *   - the push stages that send the backup to the cloud are skipped (syncEngine runPushStagesOnce): no request, no error,
 *     no 5-minute probing. Everything stays queued on this PC (the queue is what A602's "going online later" sends).
 *   - the background polls that only serve the backup stop: the web's sales on this POS's drawers, drawers closed or
 *     confirmed on the web, the web's day closes, a branch server's drawers poll (branchDrawers.ts).
 *   - kept: the catalogue pull and the change channel, the staff list, sign-in, the catalogue and staff changes push,
 *     prices, station routing, wastage, a logo, support logs, the test-data clears, and everything on the shop network
 *     (a POS's records to its branch server, the server's answers).
 * When the cloud says on again (a plan, the cloud_backup flag), the stages run again and the queue drains as usual.
 * A 503 CLOUD_BACKUP_OFF (a write that went before this POS heard) is taken as "off" at once.
 *
 * The pure rules are in cloudBackupWire.ts (the tests run them); the storage here.
 */
import { getLocalDb } from './localDb';

import { cleanCloudBackup, effectiveCloudBackup, backupOff, type CloudBackup } from './cloudBackupWire';
export { cleanCloudBackup, effectiveCloudBackup, backupOff, type CloudBackup, type CloudBackupPhase } from './cloudBackupWire';

// ── storage (maintenance_state) ─────────────────────────────────────────────────────────────────────────────────────
const KEY = 'cloud_backup';
let _memo: { v: CloudBackup | null } | null = null;   // read on every push pass: kept in memory, written through

/** Store what the cloud said. undefined (not said) → keep. Returns whether it changed. */
export function setCloudBackup(v: unknown): boolean {
  const c = cleanCloudBackup(v);
  if (!c) return false;
  const before = getCloudBackup();
  if (before && before.on === c.on && before.phase === c.phase && before.cutoffAt === c.cutoffAt) return false;
  try {
    getLocalDb().prepare(`INSERT OR REPLACE INTO maintenance_state (key, value, updated_at) VALUES (?, ?, ?)`)
      .run(KEY, JSON.stringify(c), new Date().toISOString());
  } catch { /* the next pull */ }
  _memo = { v: c };
  return true;
}

/** What this POS last heard (null: never told — the backup is on, as before A601). */
export function getCloudBackup(): CloudBackup | null {
  if (_memo) return _memo.v;
  let v: CloudBackup | null = null;
  try {
    const row = getLocalDb().prepare(`SELECT value FROM maintenance_state WHERE key = ?`).get(KEY) as { value?: string } | undefined;
    v = row?.value ? (cleanCloudBackup(JSON.parse(row.value)) ?? null) : null;
  } catch { v = null; }
  _memo = { v };
  return v;
}

/** A 503 CLOUD_BACKUP_OFF: the cloud refuses this POS's backup now — taken as off at once (the date kept when known). */
export function noteBackupRefused(cutoffAt?: string | null): boolean {
  const had = getCloudBackup();
  if (had && had.on === false && had.phase === 'cut') return false;
  return setCloudBackup({ on: false, phase: 'cut', cutoffAt: cutoffAt ?? had?.cutoffAt ?? null });
}

/** Is the cloud backup off for this POS now (stored answer, by this POS's clock)? Never throws. */
export function cloudBackupOffNow(now: number = Date.now()): boolean {
  try { return backupOff(getCloudBackup(), now); } catch { return false; }
}

/** The answer for the manager's notice (getSyncStatus), by this POS's clock; null when never told. */
export function cloudBackupNow(now: number = Date.now()): CloudBackup | null {
  try { return effectiveCloudBackup(getCloudBackup(), now); } catch { return null; }
}

/** Tests only. */
export function _forgetCloudBackupMemo(): void { _memo = null; }
