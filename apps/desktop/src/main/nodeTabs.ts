/**
 * nodeTabs.ts — the branch node's authoritative store of OPEN held orders (tabs),
 * so a tab opened on one till can be seen, locked, edited and charged from another
 * (register D9). Held orders are the app's most dangerous data — losing one, or
 * double-charging one, is its worst failure — so the concurrency model here is
 * deliberately conservative and node-arbitrated: there is one source of truth (the
 * node), and acquiring the right to act on a tab is a single ATOMIC claim, never a
 * peer-to-peer race to reconcile.
 *
 * Model (owner decision, 2026-09-10 — see docs/D9-decision-brief.md):
 *   - Any till may SEE every open tab (its own local tabs ∪ the node's).
 *   - To edit/charge/clear a tab a till must hold its LOCK. Claiming is atomic:
 *     one UPDATE ... WHERE (unlocked OR mine OR lease-expired) whose `.changes`
 *     is 1 for the winner and 0 for everyone else → 409. Same shape proven for
 *     D4's enrolment burn.
 *   - The lock is a 90-second LEASE, renewed on every edit. An actively-worked tab
 *     never expires; a crashed/abandoned till frees the tab in 90s so the table
 *     isn't stuck. Renewal correctness is the delicate part (a missed renewal =
 *     a stolen tab mid-edit) — it is unit-tested here and MUST be smoke-tested on
 *     two real tills.
 *   - CLEAR (discard without charging) and a FORCED lock-steal are the audited,
 *     manager-notified events (who opened / what changed / who cleared|stole). A
 *     normal claim→edit→charge is just service and is not notified.
 *
 * WHAT THIS FILE IS: the benchable core — schema + atomic operations, testable
 * under node:sqlite/PGlite. WHAT IT IS NOT: the live cross-till behaviour (poll
 * lag, a till dropping offline mid-charge, two tills racing) — that needs a
 * two-till rig and is the whole point of the feature; do not ship to a real floor
 * until it passes there (rule 16).
 */
import crypto from 'crypto';
import type BetterSqlite3 from 'better-sqlite3';

export const LEASE_MS = 90_000; // 90s; renewed on every edit (see brief)

export const NODE_TABS_SCHEMA = `
CREATE TABLE IF NOT EXISTS node_tabs (
  id               TEXT PRIMARY KEY,
  branch_id        TEXT NOT NULL,
  order_number     TEXT NOT NULL,
  label            TEXT NOT NULL,
  order_type       TEXT NOT NULL,
  table_number     TEXT NOT NULL DEFAULT '',
  delivery_person  TEXT,
  cart             TEXT NOT NULL,          -- JSON
  opened_by        TEXT NOT NULL,          -- staff/till that first opened it
  opened_at        TEXT NOT NULL,
  last_changed_by  TEXT,                   -- staff/till of the most recent edit
  last_changed_at  TEXT,
  locked_by        TEXT,                   -- NULL = claimable; else the holder
  lock_expires     TEXT                    -- ISO; a lease, renewed on edit
);
CREATE INDEX IF NOT EXISTS idx_node_tabs_branch ON node_tabs(branch_id);
`;

export interface TabRow {
  id: string; branch_id: string; order_number: string; label: string;
  order_type: string; table_number: string; delivery_person: string | null;
  cart: string; opened_by: string; opened_at: string;
  last_changed_by: string | null; last_changed_at: string | null;
  locked_by: string | null; lock_expires: string | null;
}

type DB = BetterSqlite3.Database;
const now = () => new Date().toISOString();
const leaseUntil = (ms = LEASE_MS) => new Date(Date.now() + ms).toISOString();

export function ensureNodeTabs(db: DB): void { db.exec(NODE_TABS_SCHEMA); }

/** Register (or upsert) an opened tab from the owning till. Idempotent on id. */
export function registerTab(db: DB, t: {
  id: string; branch_id: string; order_number: string; label: string;
  order_type: string; table_number?: string; delivery_person?: string | null;
  cart: unknown; opened_by: string;
}): TabRow {
  const at = now();
  db.prepare(`
    INSERT INTO node_tabs (id, branch_id, order_number, label, order_type,
                           table_number, delivery_person, cart, opened_by, opened_at)
    VALUES (@id, @branch_id, @order_number, @label, @order_type,
            @table_number, @delivery_person, @cart, @opened_by, @opened_at)
    ON CONFLICT(id) DO UPDATE SET
      cart = excluded.cart, label = excluded.label,
      table_number = excluded.table_number, delivery_person = excluded.delivery_person
  `).run({
    id: t.id, branch_id: t.branch_id, order_number: t.order_number, label: t.label,
    order_type: t.order_type, table_number: t.table_number ?? '',
    delivery_person: t.delivery_person ?? null, cart: JSON.stringify(t.cart),
    opened_by: t.opened_by, opened_at: at,
  });
  return getTab(db, t.id)!;
}

export function getTab(db: DB, id: string): TabRow | undefined {
  return db.prepare(`SELECT * FROM node_tabs WHERE id = ?`).get(id) as TabRow | undefined;
}

/** A tab's lock is effective iff locked_by is set AND the lease hasn't expired. */
export function isLocked(t: TabRow, at = now()): boolean {
  return !!t.locked_by && !!t.lock_expires && t.lock_expires > at;
}

export function listOpenTabs(db: DB, branchId: string): (TabRow & { locked: boolean })[] {
  const at = now();
  const rows = db.prepare(`SELECT * FROM node_tabs WHERE branch_id = ? ORDER BY opened_at`).all(branchId) as TabRow[];
  return rows.map(r => ({ ...r, locked: isLocked(r, at) }));
}

export type ClaimResult =
  | { ok: true; tab: TabRow; stole: boolean }
  | { ok: false; code: 409; lockedBy: string };

/**
 * Atomically acquire the lock for `who`. Wins iff the tab is unlocked, already
 * mine, OR the previous holder's lease has expired (a forced steal). One
 * conditional UPDATE — its `.changes` is 1 for exactly one caller, 0 for the
 * losers, so two tills cannot both hold it. `stole` is true when we took it from
 * a lapsed holder (the caller should audit + notify on a steal).
 */
export function claimTab(db: DB, id: string, who: string): ClaimResult {
  const before = getTab(db, id);
  if (!before) return { ok: false, code: 409, lockedBy: '(gone)' };
  const at = now();
  const stole = !!before.locked_by && before.locked_by !== who && !isLocked(before, at);
  const changes = db.prepare(`
    UPDATE node_tabs
       SET locked_by = @who, lock_expires = @exp,
           last_changed_by = COALESCE(last_changed_by, @who)
     WHERE id = @id
       AND ( locked_by IS NULL
          OR locked_by = @who
          OR lock_expires IS NULL
          OR lock_expires <= @at )
  `).run({ who, exp: leaseUntil(), id, at }).changes;
  if (changes === 1) return { ok: true, tab: getTab(db, id)!, stole };
  const cur = getTab(db, id);
  return { ok: false, code: 409, lockedBy: cur?.locked_by ?? '(unknown)' };
}

/** Save edits — only the lock-holder may, and each edit RENEWS the lease. */
export function updateTab(db: DB, id: string, who: string, cart: unknown, label?: string):
  { ok: true; tab: TabRow } | { ok: false; code: 409 | 423; lockedBy?: string } {
  const t = getTab(db, id);
  if (!t) return { ok: false, code: 409 };
  if (!t.locked_by || t.locked_by !== who || !isLocked(t)) {
    return { ok: false, code: 423, lockedBy: t.locked_by ?? undefined }; // 423 Locked (not yours / lapsed)
  }
  db.prepare(`
    UPDATE node_tabs
       SET cart = @cart, label = COALESCE(@label, label),
           last_changed_by = @who, last_changed_at = @at,
           lock_expires = @exp
     WHERE id = @id AND locked_by = @who
  `).run({ cart: JSON.stringify(cart), label: label ?? null, who, at: now(), exp: leaseUntil(), id });
  return { ok: true, tab: getTab(db, id)! };
}

/** Release the lock without other change (hold-again / explicit release). */
export function releaseTab(db: DB, id: string, who: string): { ok: boolean } {
  const changes = db.prepare(
    `UPDATE node_tabs SET locked_by = NULL, lock_expires = NULL WHERE id = ? AND locked_by = ?`
  ).run(id, who).changes;
  return { ok: changes === 1 };
}

export interface ClearAudit {
  tab_id: string; branch_id: string; order_number: string; label: string;
  opened_by: string; opened_at: string;
  last_changed_by: string | null; last_changed_at: string | null;
  cleared_by: string; cleared_at: string;
}

/**
 * Delete a tab. `reason` distinguishes a charge (tab became an order — routine,
 * not audited) from a clear (discarded — audited + manager-notified). Returns the
 * audit record for a clear so the caller can emit the notification event. Only
 * the lock-holder may clear; a charge is likewise holder-gated by the caller.
 */
export function deleteTab(db: DB, id: string, who: string, reason: 'charged' | 'cleared'):
  { ok: true; audit: ClearAudit | null } | { ok: false; code: 409 | 423; lockedBy?: string } {
  const t = getTab(db, id);
  if (!t) return { ok: false, code: 409 };
  if (!t.locked_by || t.locked_by !== who || !isLocked(t)) {
    return { ok: false, code: 423, lockedBy: t.locked_by ?? undefined };
  }
  const audit: ClearAudit | null = reason === 'cleared' ? {
    tab_id: t.id, branch_id: t.branch_id, order_number: t.order_number, label: t.label,
    opened_by: t.opened_by, opened_at: t.opened_at,
    last_changed_by: t.last_changed_by, last_changed_at: t.last_changed_at,
    cleared_by: who, cleared_at: now(),
  } : null;
  db.prepare(`DELETE FROM node_tabs WHERE id = ? AND locked_by = ?`).run(id, who);
  return { ok: true, audit };
}

/** For the steal-audit: build the record when claimTab reported stole=true. */
export function stealAudit(before: TabRow, who: string): Record<string, unknown> {
  return {
    tab_id: before.id, order_number: before.order_number, label: before.label,
    opened_by: before.opened_by, previous_holder: before.locked_by,
    stolen_by: who, stolen_at: now(),
  };
}

export const _test = { leaseUntil, now };
