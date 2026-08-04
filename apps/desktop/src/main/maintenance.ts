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
// SNAPSHOTS (node only). Nightly copy of the database to a second location,
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
const DEFAULT_SNAPSHOT_KEEP = 14;

export function retentionDays(): number {
  const n = Number(getState('replica_retention_days'));
  return Number.isFinite(n) && n >= 7 ? n : DEFAULT_RETENTION_DAYS;   // floor of 7: a sub-week window is a misconfiguration, not a policy
}
export function snapshotKeep(): number {
  const n = Number(getState('snapshot_keep'));
  return Number.isFinite(n) && n >= 2 ? n : DEFAULT_SNAPSHOT_KEEP;
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

export interface SnapshotResult { ok: boolean; path?: string; bytes?: number; error?: string; pruned?: number }

export function snapshotDir(): string {
  return getState('backup_dir') || path.join(app.getPath('userData'), 'backups');
}

/**
 * One consistent snapshot of the whole database into the backup directory,
 * plus retention. The result — success OR failure — is recorded in
 * maintenance_state, because a backup job that fails silently for a month is
 * indistinguishable from one that works until the day it matters.
 */
export async function takeSnapshot(now = new Date()): Promise<SnapshotResult> {
  try {
    const dir = snapshotDir();
    fs.mkdirSync(dir, { recursive: true });
    const stamp = now.toISOString().replace(/[:.]/g, '-');
    const dest = path.join(dir, `swiftpos-${stamp}.db`);

    // better-sqlite3's backup API: page-by-page, transactionally consistent,
    // correct against a live WAL. fs.copyFile on an open WAL database is how
    // a "backup" restores to a corrupt file.
    await getLocalDb().backup(dest);
    const bytes = fs.statSync(dest).size;

    // Retention: newest N stay.
    const snaps = fs.readdirSync(dir)
      .filter(f => /^swiftpos-.*\.db$/.test(f))
      .sort()               // ISO stamps sort chronologically
      .reverse();
    let pruned = 0;
    for (const f of snaps.slice(snapshotKeep())) {
      try { fs.unlinkSync(path.join(dir, f)); pruned++; } catch { /* next run */ }
    }

    setState('last_backup_at', now.toISOString());
    setState('last_backup_path', dest);
    setState('last_backup_status', `ok — ${(bytes / 1024 / 1024).toFixed(1)} MB, keeping ${Math.min(snaps.length, snapshotKeep())}`);
    return { ok: true, path: dest, bytes, pruned };
  } catch (err: any) {
    setState('last_backup_at', now.toISOString());
    setState('last_backup_status', `FAILED — ${err?.message ?? 'unknown error'}`);
    return { ok: false, error: err?.message ?? 'snapshot failed' };
  }
}

/** Nightly, node only, scheduled from index.ts. */
export async function snapshotIfDue(now = new Date()): Promise<SnapshotResult | null> {
  if (!isNodeRole(getDeviceConfig()?.device_role)) return null;
  const last = getState('last_backup_at');
  if (last && now.getTime() - new Date(last).getTime() < 20 * 3_600_000) return null;
  return takeSnapshot(now);
}

/** What a person sees on the tech card. */
export function maintenanceStatus(): {
  last_backup_at: string | null; last_backup_status: string | null; backup_dir: string;
  last_prune_at: string | null; retention_days: number;
} {
  return {
    last_backup_at: getState('last_backup_at'),
    last_backup_status: getState('last_backup_status'),
    backup_dir: snapshotDir(),
    last_prune_at: getState('last_prune_at'),
    retention_days: retentionDays(),
  };
}
