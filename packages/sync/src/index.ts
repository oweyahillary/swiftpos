// @swiftpos/sync — Offline sync engine (Step 8)
// ─────────────────────────────────────────────
// STEP 8 REMINDER — Conflict resolution strategy:
//   Orders/payments  → local wins  (they are facts that happened)
//   Product prices   → remote wins (owner may have changed via dashboard)
//   Stock levels     → delta merge  (never overwrite with absolute value)
// ─────────────────────────────────────────────
// Full implementation deferred to Step 8 of the build order.

export type SyncStatus = 'pending' | 'syncing' | 'synced' | 'error';

export interface SyncQueueItem {
  id: string;
  table_name: string;
  operation: 'INSERT' | 'UPDATE' | 'DELETE';
  record_id: string;
  payload: Record<string, unknown>;
  created_at: string;
  attempts: number;
  status: SyncStatus;
}
