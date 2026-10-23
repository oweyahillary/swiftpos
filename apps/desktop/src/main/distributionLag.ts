/**
 * distributionLag.ts — A534 (register A23): how far a branch server's distribution to the cloud is behind.
 *
 * A branch server holds its own sales and the sales its tills hand it (A19: forwarded into its own sync_queue) until the
 * cloud takes them. If the server's disk dies first, the sales not yet on the cloud are gone — and nothing on the server
 * said how many there were, or for how long. Owner, 2026-10-20: "add all of them since effort is small".
 *
 * The Tech page (ServerDistributionPanel) shows, read from this machine's own database:
 *   - how many records wait for the cloud, by table (sales — of them from this branch's tills — drawers, days, pay-ins
 *     and pay-outs, expenses, kitchen voids, offline voids and refunds);
 *   - the age of the oldest of them;
 *   - the last successful push (any batch the cloud took — notePushOk, stamped by syncEngine) and the last moment
 *     nothing waited (last_synced_at, A363);
 *   - the runbook line: do not wipe or reinstall a failed server before a technician has copied its swiftpos.db.
 * A till behind a server already shows what the SERVER has not yet confirmed of its own records (A501 nodeQueueDepth,
 * BranchSyncPanel). Read-only; never throws (a database before a table's schema counts it as 0).
 */
import { getLocalDb } from './localDb';

export const RUNBOOK_LINE = 'If this server fails, do not wipe or reinstall it until a technician has copied its swiftpos.db — sales not yet on the cloud live only on its disk.';
const PUSH_OK_KEY = 'last_push_ok_at';
const SYNCED_KEY = 'last_synced_at';

type Db = ReturnType<typeof getLocalDb>;

/** Stamp a push the cloud took (a sale, or a batch of drawers / days / expenses). Never throws. */
export function notePushOk(db: Db = getLocalDb(), now = new Date()): void {
  try {
    db.prepare(`INSERT INTO maintenance_state (key, value, updated_at) VALUES (?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .run(PUSH_OK_KEY, now.toISOString(), now.toISOString());
  } catch { /* the Tech page shows the last stamp it has */ }
}

export interface DistributionLag {
  waiting: { orders: number; ordersFromTills: number; shifts: number; days: number; floats: number; expenses: number; kitchenVoids: number; reversals: number };
  total: number;
  /** The oldest record not yet on the cloud (ISO), and its age in ms (null when nothing waits). */
  oldestAt: string | null;
  oldestAgeMs: number | null;
  lastPushOkAt: string | null;
  lastSyncedAt: string | null;
  runbook: string;
}

/** SQLite's datetime('now') ("2026-10-20 09:00:00", UTC) or an ISO stamp → ISO; anything else → null. */
function toIso(v: unknown): string | null {
  if (typeof v !== 'string' || !v) return null;
  const s = /T/.test(v) ? v : `${v.replace(' ', 'T')}Z`;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** `ownDevice`: this server's device id — a waiting sale whose order names another device is one forwarded for a till. */
export function distributionLag(db: Db = getLocalDb(), now = Date.now(), ownDevice: string | null = null): DistributionLag {
  const one = (sql: string, ...args: unknown[]): { n: number; oldest: string | null } => {
    try {
      const r = db.prepare(sql).get(...args) as { n?: number; oldest?: string | null } | undefined;
      return { n: Number(r?.n ?? 0), oldest: r?.oldest ?? null };
    } catch { return { n: 0, oldest: null }; }
  };
  // Sales: everything in the cloud queue not yet taken ('pending', and 'failed' — a failed sale is still not on the cloud).
  const orders = one(`SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM sync_queue WHERE status IN ('pending', 'failed')`);
  // Of them, the ones this server forwards for its tills (A19: the order row keeps its till's device id).
  const fromTills = ownDevice
    // branch-wide: the sales this server forwards for its tills are exactly the other terminals' rows
    ? one(`SELECT COUNT(*) AS n FROM sync_queue q JOIN orders o ON o.id = q.order_id
            WHERE q.status IN ('pending', 'failed') AND o.device_id IS NOT NULL AND o.device_id <> ?`, ownDevice)
    : { n: 0, oldest: null };
  // The server's own drawers, days and money records still to push — its own rows, as pushLocalRecords sends them (a
  // till's rows held here are 'peer'; the till sends those itself).
  const dev = ownDevice;
  const shifts = one(`SELECT COUNT(*) AS n, MIN(opened_at) AS oldest FROM shifts WHERE sync_status = 'pending' AND COALESCE(device_id,'') = COALESCE(?,'')`, dev);
  const days = one(`SELECT COUNT(*) AS n, MIN(opened_at) AS oldest FROM business_days WHERE sync_status = 'pending' AND COALESCE(device_id,'') = COALESCE(?,'')`, dev);
  const floats = one(`SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM float_transactions WHERE sync_status = 'pending' AND COALESCE(device_id,'') = COALESCE(?,'')`, dev);
  const expenses = one(`SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM expenses WHERE sync_status = 'pending' AND COALESCE(device_id,'') = COALESCE(?,'')`, dev);
  const kv = one(`SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM kitchen_voids WHERE sync_status = 'pending' AND COALESCE(device_id,'') = COALESCE(?,'')`, dev);
  const rev = one(`SELECT COUNT(*) AS n, MIN(approved_at) AS oldest FROM pending_reversals WHERE sync_status = 'pending' AND COALESCE(device_id,'') = COALESCE(?,'')`, dev);
  const parts = [orders, shifts, days, floats, expenses, kv, rev];
  const stamps = parts.filter((p) => p.n > 0).map((p) => toIso(p.oldest)).filter((s): s is string => !!s).sort();
  const oldestAt = stamps[0] ?? null;
  const kvGet = (k: string): string | null => { try { return toIso((db.prepare(`SELECT value FROM maintenance_state WHERE key = ?`).get(k) as any)?.value); } catch { return null; } };
  const waiting = { orders: orders.n, ordersFromTills: fromTills.n, shifts: shifts.n, days: days.n, floats: floats.n, expenses: expenses.n, kitchenVoids: kv.n, reversals: rev.n };
  return {
    waiting,
    total: orders.n + shifts.n + days.n + floats.n + expenses.n + kv.n + rev.n,
    oldestAt,
    oldestAgeMs: oldestAt ? Math.max(0, now - Date.parse(oldestAt)) : null,
    lastPushOkAt: kvGet(PUSH_OK_KEY),
    lastSyncedAt: kvGet(SYNCED_KEY),
    runbook: RUNBOOK_LINE,
  };
}
