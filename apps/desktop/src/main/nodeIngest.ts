// nodeIngest.ts — branch replication: sequencing, ingest, and the node outbox
// ─────────────────────────────────────────────────────────────────────────────
// Three things live here, and they are together because they are the parts of
// replication that do NOT change when the transport does.
//
//   1. seq allocation — a per-device monotonic counter, stamped on rows this
//      terminal creates.
//   2. applyPeerRows — taking a peer's rows into this device's tables without
//      them becoming this device's rows.
//   3. the node outbox — what this till still owes the node.
//
// Phase 2 replaces push with pull (`GET /node/since?device=X&after=N`). When it
// does, (1) and (2) are unchanged and (3) is deleted: the peer stops pushing and
// starts serving, the node stops receiving and starts asking. Keeping the
// transport out of this file is what makes that a one-module change.
//
// ── THE RULE THAT MATTERS ────────────────────────────────────────────────────
// An ingested row keeps the PEER's device_id and the PEER's seq. Stamping this
// node's own would erase the only distinction the ownership work exists to
// create — and that distinction is what the sell gate reads. getOpenShift() on
// a node with mis-attributed peer rows returns another cashier's open drawer and
// the till sells against it.
//
// So this module refuses rather than guesses. Every rejection below is a case
// where continuing would produce a plausible, wrong number.

import crypto from 'crypto';
import { getLocalDb } from './localDb';
import { getDeviceConfig } from './deviceConfig';
import { buildPeerRelay, buildCloudOrderPayload } from './peerRelay';

/** The tables that replicate across the branch LAN. */
export const REPLICATED_TABLES = [
  'orders', 'shifts', 'float_transactions', 'expenses', 'business_days', 'events',
] as const;
export type ReplicatedTable = typeof REPLICATED_TABLES[number];

export function isReplicatedTable(t: string): t is ReplicatedTable {
  return (REPLICATED_TABLES as readonly string[]).includes(t);
}

/**
 * The columns each table replicates, in order. Explicit rather than
 * `SELECT *`: a column added locally and not yet in Postgres would otherwise
 * start crossing the LAN silently, and a peer on an older build would reject
 * the whole row rather than the column it does not know.
 *
 * `sync_status` is deliberately absent. It describes THIS device's relationship
 * with the cloud and means nothing on another machine — copying it is how a
 * node would come to believe a peer's unsynced shift was already delivered.
 */
const COLUMNS: Record<ReplicatedTable, string[]> = {
  orders: [
    'id', 'business_id', 'branch_id', 'order_number', 'order_type', 'delivery_person',
    'status', 'subtotal', 'vat_amount', 'ctl_amount', 'discount_amount', 'tip_amount',
    'total', 'covers', 'cashier_id', 'shift_id', 'customer_id', 'customer_name',
    'customer_phone', 'created_at', 'device_id', 'pump_id', 'seq',
  ],
  shifts: [
    'id', 'business_id', 'branch_id', 'cashier_id', 'opened_at', 'closed_at', 'status',
    'opening_float', 'closing_float', 'expected_cash', 'cash_variance', 'notes',
    'created_at', 'closed_by', 'close_method', 'business_day_id', 'business_date',
    'device_id', 'terminal_code', 'drawer_label', 'opened_by', 'seq',
  ],
  float_transactions: [
    'id', 'shift_id', 'branch_id', 'cashier_id', 'type', 'amount', 'reason',
    'created_at', 'device_id', 'seq',
  ],
  expenses: [
    'id', 'business_id', 'branch_id', 'expense_category_id', 'description', 'amount',
    'paid_by', 'expense_date', 'shift_id', 'created_at', 'device_id', 'seq',
  ],
  business_days: [
    'id', 'business_id', 'branch_id', 'device_id', 'terminal_code', 'business_date',
    'opened_at', 'opened_by', 'closed_at', 'closed_by', 'status', 'counted_cash',
    'expected_cash', 'cash_variance', 'notes', 'created_at', 'seq',
  ],
  // Phase 2b. `applied` is deliberately absent for the same reason sync_status
  // is: it describes THIS device's progress applying the event, not the event.
  events: [
    'id', 'business_id', 'branch_id', 'device_id', 'seq',
    'kind', 'target_table', 'target_id', 'payload', 'created_at',
  ],
};

export function replicatedColumns(table: ReplicatedTable): string[] {
  return COLUMNS[table];
}

/**
 * Order lines travel WITH their order, as `_items` on the payload, rather than
 * as a sixth replicated table.
 *
 * They have no device_id and no seq of their own — they are not independent
 * facts, they are part of one. Giving them their own sequence would mean a
 * cursor could legitimately sit between an order and its lines, and a branch
 * report would then show a sale with no items in it, which reads as a bug in the
 * till rather than as replication in progress.
 *
 * The node needs them: the branch top-products view is built on order_items, and
 * the old /node/orders path carried them for exactly that reason.
 */
const ORDER_ITEM_COLUMNS = [
  'id', 'order_id', 'product_id', 'product_name', 'category_name',
  'unit_price', 'quantity', 'subtotal', 'course', 'fire_status',
];

/**
 * Payments travel inside their order for the same reason lines do — and their
 * absence was visible before it was found in code: the manager's branch Orders
 * list showed a peer till's sale with no payment method, and the branch
 * payment-method split omitted every peer drawer, so cash + M-Pesa + Glovo did
 * not sum to branch revenue. The revenue total was right (it reads orders);
 * the breakdown under it was silently missing every terminal but the node's.
 *
 * `sync_status` is deliberately excluded and stamped 'peer' on insert: unlike
 * order_items, the local payments table HAS that column with DEFAULT 'pending',
 * and a peer payment sitting in 'pending' on the node is a row some future
 * unscoped query would try to push.
 */
const PAYMENT_COLUMNS = [
  'id', 'order_id', 'method', 'amount', 'amount_tendered',
  'change_given', 'reference', 'status', 'created_at',
];

/**
 * `sync_status` for a row this device did not create.
 *
 * Own-row scoping already keeps peer rows out of every collection query, so this
 * is defence in depth rather than the mechanism. It earns its place because the
 * failure it guards is silent: a query that forgets its scope predicate would
 * otherwise pick up peer rows in state 'pending' and push somebody else's shift
 * to the cloud from the wrong device. With a status no push path selects, that
 * same mistake surfaces as a row that never moves — visible, and harmless.
 */
export const PEER_SYNC_STATUS = 'peer';

// ── Sequence allocation ──────────────────────────────────────────────────────

/**
 * The next seq for a row THIS device is creating.
 *
 * Read from device_seq, not `MAX(seq)+1` over the table: on a node those tables
 * hold peers' rows too, so MAX would hand this device a number derived from
 * another terminal's counter — and then two devices would disagree about what
 * "device X up to 41" contains.
 *
 * Callers must be inside the same transaction as the INSERT they are numbering.
 * A seq allocated and then not used leaves a gap, which is harmless (a cursor
 * asks for "> N", it does not count), but a seq used twice is not.
 */
export function nextSeq(table: ReplicatedTable): number {
  const db = getLocalDb();
  db.prepare(
    `INSERT INTO device_seq (table_name, next_seq) VALUES (?, 1)
     ON CONFLICT(table_name) DO NOTHING`,
  ).run(table);
  const row = db.prepare(
    `UPDATE device_seq SET next_seq = next_seq + 1
      WHERE table_name = ? RETURNING next_seq - 1 AS seq`,
  ).get(table) as { seq: number } | undefined;
  if (!row) throw new Error(`device_seq allocation failed for ${table}`);
  return row.seq;
}

/**
 * Backfill seq on rows this device created before v45.
 *
 * Ordered by created_at so the numbering matches the order things actually
 * happened, and scoped to this device's own rows — a node upgrading in place
 * already holds peers' rows and must not renumber them into its own sequence.
 * Runs once; rows that already have a seq are left alone.
 */
export function backfillOwnSeq(): number {
  const db = getLocalDb();
  const own = getDeviceConfig()?.device_id ?? null;
  let total = 0;

  for (const table of REPLICATED_TABLES) {
    const rows = db.prepare(
      `SELECT id FROM ${table}
        WHERE seq IS NULL AND COALESCE(device_id,'') = COALESCE(?,'')
        ORDER BY created_at, rowid`,
    ).all(own) as Array<{ id: string }>;
    if (!rows.length) continue;

    const setSeq = db.prepare(`UPDATE ${table} SET seq = ? WHERE id = ?`);
    db.transaction(() => {
      for (const r of rows) setSeq.run(nextSeq(table), r.id);
    })();
    total += rows.length;
  }
  return total;
}

// ── Ingest ───────────────────────────────────────────────────────────────────

export interface IngestResult {
  applied: number;
  duplicate: number;
  /** Rows refused, with the reason. Reported to the peer; never silently dropped. */
  rejected: Array<{ id: string; table: string; reason: string }>;
  /** Highest seq now held per (device, table), for the peer to checkpoint against. */
  cursor: number;
  /** A19: peer orders forwarded into this node's cloud sync_queue this pass. Not
   *  every applied order relays — an old peer that sends no payload, or one that
   *  can't be relayed faithfully, is applied for branch reports but not forwarded. */
  relayed?: number;
}

/**
 * Take a peer's rows into this device's tables.
 *
 * Idempotent on id: a row already held is a duplicate, not an error, because the
 * peer retrying is the normal case and an outage should cost a no-op rather than
 * a conflict.
 *
 * Rows are applied in seq order and the cursor advances only over rows actually
 * applied, so a batch that fails halfway resumes from the right place instead of
 * skipping the remainder.
 */
/**
 * Insert an ingested order's children — lines and payments. Always additive:
 * INSERT OR IGNORE keyed on each child's own id, so calling it for an order the
 * node already holds fills holes and changes nothing else. Callers wrap it in
 * the order's transaction.
 */
function insertOrderChildren(db: ReturnType<typeof getLocalDb>, row: any): void {
  if (Array.isArray(row._items) && row._items.length) {
    const insertItem = db.prepare(
      `INSERT OR IGNORE INTO order_items (${ORDER_ITEM_COLUMNS.join(', ')})
       VALUES (${ORDER_ITEM_COLUMNS.map(() => '?').join(', ')})`,
    );
    for (const item of row._items) {
      insertItem.run(...ORDER_ITEM_COLUMNS.map(c => item?.[c] ?? null));
    }
  }
  if (Array.isArray(row._payments) && row._payments.length) {
    const insertPay = db.prepare(
      `INSERT OR IGNORE INTO payments (${PAYMENT_COLUMNS.join(', ')}, sync_status)
       VALUES (${PAYMENT_COLUMNS.map(() => '?').join(', ')}, '${PEER_SYNC_STATUS}')`,
    );
    for (const pay of row._payments) {
      insertPay.run(...PAYMENT_COLUMNS.map(c => pay?.[c] ?? null));
    }
  }
}

/**
 * A19: forward a peer order to the cloud by putting its ORIGINAL payload into
 * this node's own `sync_queue`. The node's existing push (pushPendingOrders)
 * then POSTs it with `X-Idempotency-Key = sync_queue.order_id`, so the cloud
 * attributes it to the peer's device and dedupes on the peer's id.
 *
 * Three independent guards against double-counting a sale: `sync_queue.order_id`
 * is UNIQUE and this is INSERT OR IGNORE (a re-offered order never enqueues
 * twice); the push carries the peer's stable id as the idempotency key; and the
 * cloud short-circuits duplicates on (business, idempotency_key). A peer on the
 * old build pushing straight to cloud AND this node forwarding the same order
 * therefore converge on ONE cloud row.
 *
 * This BRIDGES the two queues without merging them: the peer→node queue
 * (node_queue) is untouched; this only adds a peer-origin row to the cloud queue.
 */
function enqueuePeerRelay(db: ReturnType<typeof getLocalDb>, orderId: string, payload: Record<string, any>): void {
  db.prepare(
    `INSERT OR IGNORE INTO sync_queue (order_id, payload, created_at, status)
     VALUES (?, ?, datetime('now'), 'pending')`,
  ).run(orderId, JSON.stringify(payload));
}

export function applyPeerRows(
  table: ReplicatedTable,
  peerDeviceId: string,
  rows: any[],
): IngestResult {
  const db = getLocalDb();
  const cfg = getDeviceConfig();
  const result: IngestResult = { applied: 0, duplicate: 0, rejected: [], cursor: 0, relayed: 0 };

  // A peer that presents no device_id cannot be attributed, and NULL is not
  // neutral here: "mine" is COALESCE(device_id,'') = COALESCE(own,''), so a NULL
  // peer row matches "mine" on any till that has not been assigned a device_id
  // itself. Silently, and on the sell gate.
  if (!peerDeviceId) {
    for (const r of rows) {
      result.rejected.push({ id: String(r?.id ?? '?'), table, reason: 'peer sent no device_id' });
    }
    return result;
  }

  // A peer claiming OUR device_id would have its rows indistinguishable from
  // ours in every own-row query — including the four that push to the cloud,
  // which would then double-push, and getOpenShift, which the sell gate reads.
  // Almost certainly a cloned install rather than an attack, and either way the
  // answer is the same: refuse, and say so, because the fix is to re-run setup
  // on that till and it is not discoverable from the symptom.
  if (cfg?.device_id && peerDeviceId === cfg.device_id) {
    for (const r of rows) {
      result.rejected.push({
        id: String(r?.id ?? '?'), table,
        reason: 'peer is presenting this node\'s own device_id — that till was probably '
              + 'cloned from this one. Re-run setup on it to mint a distinct device id.',
      });
    }
    return result;
  }

  const cols = COLUMNS[table];
  const placeholders = cols.map(() => '?').join(', ');
  const insert = db.prepare(
    `INSERT INTO ${table} (${cols.join(', ')}, sync_status)
     VALUES (${placeholders}, '${PEER_SYNC_STATUS}')`,
  );
  const exists = db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`);

  const ordered = [...rows].sort((a, b) => (Number(a?.seq) || 0) - (Number(b?.seq) || 0));

  for (const row of ordered) {
    const id = row?.id ? String(row.id) : null;
    if (!id) { result.rejected.push({ id: '?', table, reason: 'row has no id' }); continue; }

    // The peer's own attribution must survive the trip. If it disagrees with the
    // device the payload came from, something re-stamped it in transit and the
    // row can no longer be attributed to anyone honestly.
    const rowDevice = row.device_id ? String(row.device_id) : null;
    if (rowDevice && rowDevice !== peerDeviceId) {
      result.rejected.push({
        id, table,
        reason: `row device_id ${rowDevice} does not match the sending device ${peerDeviceId}`,
      });
      continue;
    }

    // A row with no seq cannot be checkpointed: the cursor would not advance past
    // it, so it would be re-offered forever, or it would be skipped and lost. It
    // means the peer is on a build older than 45.
    const seq = Number(row.seq);
    if (!Number.isInteger(seq) || seq <= 0) {
      result.rejected.push({
        id, table,
        reason: 'row has no sequence number — that till is on a build older than schema 45',
      });
      continue;
    }

    // Branch scope. The node holds one branch; a row from another is either a
    // misconfigured till or a device moved between sites, and ingesting it would
    // put another branch's cash into this branch's report.
    if (cfg?.branch_id && row.branch_id && String(row.branch_id) !== cfg.branch_id) {
      result.rejected.push({ id, table, reason: 'row belongs to a different branch' });
      continue;
    }

    if (exists.get(id)) {
      // Already held. Deliberately NOT updated.
      //
      // A shift mutates — it opens, then closes with expected_cash and variance —
      // so "ignore duplicates" does mean a closed peer shift will not update on
      // the node until Phase 2 replicates mutations as events. That is a known
      // and bounded gap: the branch report shows the shift, and its close figures
      // arrive from the cloud, which is the authority for them anyway (C6).
      // Overwriting here would mean last-writer-wins on cash numbers across the
      // LAN, which is the conflict resolution the append-only design exists to
      // avoid having to write.
      //
      // Children are the one exception, and only additively. Orders ingested
      // before payments replicated exist on nodes with no payment rows; a peer
      // re-offering after a cursor reset (/node/cursors) is the only vehicle
      // that can repair them. INSERT OR IGNORE keyed on the payment/line id
      // cannot change a row that is already there — it can only fill a hole.
      if (table === 'orders') {
        try { db.transaction(() => insertOrderChildren(db, row))(); } catch { /* repair is best-effort */ }
      }
      result.duplicate++;
      if (seq > result.cursor) result.cursor = seq;
      continue;
    }

    try {
      let relayedThisRow = false;
      db.transaction(() => {
        insert.run(...cols.map(c => (c === 'device_id' ? peerDeviceId : row[c] ?? null)));
        // Same transaction as the order. An order without its lines on the node
        // is worse than no order at all: the branch sales total is right and the
        // top-products breakdown silently under-reports, so the two disagree and
        // nothing says why. Payments identically: without them the branch
        // method split omits this terminal and stops summing to revenue.
        if (table === 'orders') {
          insertOrderChildren(db, row);
          // A19: also forward this order to the cloud, atomically with applying
          // it. buildPeerRelay refuses anything that can't be relayed faithfully
          // (no payload / no items / no payments / mis-attributed) — that order
          // still lands here for branch reports, it just isn't forwarded, which
          // is the pre-A19 status quo rather than a regression.
          const relay = buildPeerRelay(row);
          if (relay.ok) { enqueuePeerRelay(db, relay.orderId, relay.payload); relayedThisRow = true; }
        }
      })();
      result.applied++;
      if (relayedThisRow) result.relayed = (result.relayed ?? 0) + 1;
      if (seq > result.cursor) result.cursor = seq;
    } catch (err: any) {
      // Stop at the first genuine failure rather than continuing past it. The
      // cursor has not advanced over this row, so the peer re-offers it and the
      // rest of the batch next pass — where a partial advance would leave a hole
      // nothing ever fills.
      result.rejected.push({ id, table, reason: String(err?.message ?? 'insert failed') });
      break;
    }
  }

  if (result.cursor > 0) advanceCursor(peerDeviceId, table, result.cursor);
  return result;
}

// ── Peer cursors ─────────────────────────────────────────────────────────────

export function getCursor(deviceId: string, table: ReplicatedTable): number {
  const row = getLocalDb().prepare(
    `SELECT last_seq FROM peer_cursors WHERE device_id = ? AND table_name = ?`,
  ).get(deviceId, table) as { last_seq: number } | undefined;
  return row?.last_seq ?? 0;
}

/**
 * Move a peer's high-water mark forward. Never backwards: a peer that was
 * reinstalled restarts its counter at 1, and accepting that would re-offer rows
 * this node already holds and, worse, make the cursor lie about what it has.
 * A genuinely reset peer needs a new device_id, which is what setup mints.
 */
export function advanceCursor(deviceId: string, table: ReplicatedTable, seq: number): void {
  getLocalDb().prepare(
    `INSERT INTO peer_cursors (device_id, table_name, last_seq, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(device_id, table_name) DO UPDATE
       SET last_seq = MAX(peer_cursors.last_seq, excluded.last_seq),
           updated_at = excluded.updated_at`,
  ).run(deviceId, table, seq);
}

/** Every peer this node has heard from, with how recently. Feeds staleness. */
export function listPeers(): Array<{ device_id: string; table_name: string; last_seq: number; updated_at: string }> {
  return getLocalDb().prepare(
    `SELECT device_id, table_name, last_seq, updated_at FROM peer_cursors
      ORDER BY device_id, table_name`,
  ).all() as any[];
}

// ── The node outbox ──────────────────────────────────────────────────────────

/**
 * Record that this till owes the node a row.
 *
 * Separate from sync_queue on purpose. The node and the cloud are two
 * destinations, and one status column cannot hold two opinions — the attempt to
 * make it (marking a node-acked order 'synced') is what made a peer till close
 * its shift against a server that did not have the sales.
 *
 * INSERT OR IGNORE on (table_name, row_id): enqueueing twice is a no-op, so a
 * caller that cannot easily tell whether it already enqueued may just call it.
 */
export function enqueueForNode(table: ReplicatedTable, rowId: string, payload: unknown): void {
  getLocalDb().prepare(
    `INSERT OR IGNORE INTO node_queue (table_name, row_id, payload, created_at, status)
     VALUES (?, ?, ?, datetime('now'), 'pending')`,
  ).run(table, rowId, JSON.stringify(payload));
}

export interface NodeQueueRow {
  id: number; table_name: ReplicatedTable; row_id: string;
  payload: string; attempts: number; created_at: string;
}

// ── Filling the outbox ───────────────────────────────────────────────────────

/** How far this till has offered its own rows of `table` to the node. */
export function getOutboxCursor(table: ReplicatedTable): number {
  const row = getLocalDb().prepare(
    `SELECT last_seq FROM outbox_cursors WHERE table_name = ?`,
  ).get(table) as { last_seq: number } | undefined;
  return row?.last_seq ?? 0;
}

function advanceOutboxCursor(table: ReplicatedTable, seq: number): void {
  getLocalDb().prepare(
    `INSERT INTO outbox_cursors (table_name, last_seq, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(table_name) DO UPDATE
       SET last_seq = MAX(outbox_cursors.last_seq, excluded.last_seq),
           updated_at = excluded.updated_at`,
  ).run(table, seq);
}

/**
 * Forget how far this till has offered its rows, so the NEXT outbox fill offers
 * everything again. Register A21.
 *
 * WHY THIS HAS TO EXIST
 * ---------------------
 * `outbox_cursors` is keyed by `table_name` ALONE — there is no record of which
 * node the rows were offered to. `peer_cursors` on the node side is correctly
 * keyed `(device_id, table_name)`; this side is not. That asymmetry is
 * invisible until the node is replaced, and then it loses rows:
 *
 *   1. Peer C has offered `orders` up to seq 500 to the old node.
 *   2. The old node distributed only to seq 430 before it died.
 *   3. Peer C is repointed at the promoted till. Its cursor still says 500.
 *   4. Peer C never re-offers 431-500. Those sales are on peer C and on a dead
 *      machine's disk, and absent from the new source of truth, the day close,
 *      and the cloud — with nothing reporting a gap.
 *
 * "No data loss on failover" was very nearly true, which is the worst kind.
 *
 * WHY RESETTING IS SAFE
 * ---------------------
 * Re-offering is free. Ingest is `INSERT OR IGNORE` / upsert-by-id on stable
 * client-generated UUIDs, and every row keeps its ORIGIN device_id and seq end
 * to end — so a row the new node already holds is recognised and ignored rather
 * than duplicated or re-stamped. This is the same property that lets a peer
 * retry a push indefinitely.
 *
 * WHY NOT KEY THE TABLE BY NODE
 * -----------------------------
 * Cleaner, and it is the right answer if a branch ever runs two nodes at once.
 * But it is a local-schema change to the mechanism that decides whether a field
 * till works, and D6 already records six generations of that going undocumented.
 * A reset costs one re-offer of rows that are ignored on arrival. Revisit if
 * multi-node ever lands.
 *
 * Cost: the next fill walks each replicated table from seq 0. Bounded by local
 * retention, and it happens only on an explicit, human-initiated repoint.
 */
export function resetOutboxCursors(): void {
  getLocalDb().prepare(`DELETE FROM outbox_cursors`).run();
}

/**
 * Put this till's own new rows into the outbox.
 *
 * Scanned rather than enqueued at each creation site, deliberately. There are
 * insert sites for these five tables across syncEngine, shiftService, dayService
 * and ipcHandlers, and a replication path that depends on every one of them
 * remembering a second call is a path that will silently miss rows — the failure
 * being one till's expenses quietly absent from the branch report, which looks
 * exactly like a till that had no expenses.
 *
 * `seq` is assigned here rather than at insert, for the same reason: it means no
 * creation site has to change at all. A row is numbered when it first becomes
 * replicable, in created_at order. seq is therefore an order of DELIVERY, not of
 * creation — which is all a cursor needs, and is honest about what it is.
 */
export function fillNodeOutbox(): number {
  const db = getLocalDb();
  const own = getDeviceConfig()?.device_id ?? null;
  let enqueued = 0;

  for (const table of REPLICATED_TABLES) {
    // own: a till offers the node ITS OWN rows. A node running this same code
    // must not offer a peer's rows back to itself, and on a mesh peer it would
    // re-offer another till's history as though it were its own.
    const unnumbered = db.prepare(
      `SELECT id FROM ${table}
        WHERE seq IS NULL AND COALESCE(device_id,'') = COALESCE(?,'')
        ORDER BY created_at, rowid LIMIT 500`,
    ).all(own) as Array<{ id: string }>;

    if (unnumbered.length) {
      const setSeq = db.prepare(`UPDATE ${table} SET seq = ? WHERE id = ?`);
      db.transaction(() => {
        for (const r of unnumbered) setSeq.run(nextSeq(table), r.id);
      })();
    }

    const cols = COLUMNS[table];
    // own: as above — only this terminal's rows are its to offer.
    const rows = db.prepare(
      `SELECT ${cols.join(', ')} FROM ${table}
        WHERE seq IS NOT NULL AND seq > ? AND COALESCE(device_id,'') = COALESCE(?,'')
        ORDER BY seq LIMIT 500`,
    ).all(getOutboxCursor(table), own) as any[];
    if (!rows.length) continue;

    let high = 0;
    const readItems = table === 'orders'
      ? db.prepare(`SELECT ${ORDER_ITEM_COLUMNS.join(', ')} FROM order_items WHERE order_id = ?`)
      : null;
    const readPays = table === 'orders'
      ? db.prepare(`SELECT ${PAYMENT_COLUMNS.join(', ')} FROM payments WHERE order_id = ?`)
      : null;
    // A19: the ORIGINAL cloud payload the till stored at sale time (receipt_payloads,
    // written for every order since A94). It holds the full items WITH their variant
    // and modifier selections — which the replicated order_items above do NOT — so it
    // is the only faithful source for a forward the cloud will re-price correctly.
    const readReceipt = table === 'orders'
      ? db.prepare(`SELECT payload FROM receipt_payloads WHERE order_id = ?`)
      : null;
    db.transaction(() => {
      for (const row of rows) {
        // branch-wide: keyed by order_id to the row above, which is already
        // scoped. Lines have no device of their own; they belong to their order.
        if (readItems) row._items = readItems.all(String(row.id));
        // Payments the same — they are how the branch method split is built,
        // and without them a peer sale reaches the node with no way to say
        // whether it was cash in a drawer or money that never touched one.
        if (readPays) row._payments = readPays.all(String(row.id));
        // A19: carry the original payload so the node can forward this sale to the
        // cloud verbatim. Rebuilt through the SHARED builder from the stored raw
        // payload (faithful items) plus this row's own envelope (device_id/shift_id/
        // created_at), so the node's forward and the till's own direct push are the
        // same payload. If the receipt was pruned or is unparseable, we leave it
        // unset: the order is not forwarded but still reaches the cloud by the till's
        // own sync_queue — the forward is a best-effort accelerator, never the only
        // path, so a missing payload loses nothing.
        if (readReceipt) {
          const rp = readReceipt.get(String(row.id)) as { payload: string } | undefined;
          if (rp?.payload) {
            try {
              const raw = JSON.parse(rp.payload);
              row._relayPayload = buildCloudOrderPayload(raw, {
                shiftId: row.shift_id ?? null,
                deviceId: row.device_id ?? null,
                orderId: String(row.id),
                createdAt: row.created_at,
                // A169 — the peer stored the real cashier on its order row; forward
                // that same value so the relay and the peer's direct push match.
                cashierId: row.cashier_id ?? null,
              });
            } catch { /* leave _relayPayload unset — see note above */ }
          }
        }
        enqueueForNode(table, String(row.id), row);
        if (Number(row.seq) > high) high = Number(row.seq);
      }
    })();
    // Advance only after the rows are in the outbox, so a crash between the two
    // costs a repeat scan rather than a permanently skipped row.
    if (high) advanceOutboxCursor(table, high);
    enqueued += rows.length;
  }
  return enqueued;
}

// ── Draining the outbox ──────────────────────────────────────────────────────


/**
 * The next batch owed to the node, oldest first.
 *
 * 'failed' rows are excluded: the node answered and refused on the merits, and
 * re-offering every pass would loop forever while burying the reason.
 */
export function takeNodeQueueBatch(limit = 100): NodeQueueRow[] {
  return getLocalDb().prepare(
    `SELECT id, table_name, row_id, payload, attempts, created_at
       FROM node_queue WHERE status = 'pending'
      ORDER BY created_at, id LIMIT ?`,
  ).all(limit) as NodeQueueRow[];
}

export function markNodeQueueDelivered(ids: number[]): void {
  if (!ids.length) return;
  const db = getLocalDb();
  const mark = db.prepare(`UPDATE node_queue SET status='delivered', attempts=attempts+1 WHERE id=?`);
  db.transaction(() => { for (const id of ids) mark.run(id); })();
}

/**
 * A delivery attempt that did not land.
 *
 * `escalate` distinguishes the two cases that look identical from a distance and
 * must not be treated alike: a node that is switched off (retry indefinitely — a
 * branch server rebooting must not exhaust anything) versus a node that answered
 * and refused (escalate to 'failed' after five attempts, so the reason reaches a
 * human instead of a count that never clears).
 */
export function markNodeQueueFailed(ids: number[], error: string, escalate: boolean): void {
  if (!ids.length) return;
  const db = getLocalDb();
  const mark = db.prepare(
    escalate
      ? `UPDATE node_queue SET attempts=attempts+1, last_error=?,
           status=CASE WHEN attempts+1 >= 5 THEN 'failed' ELSE 'pending' END WHERE id=?`
      : `UPDATE node_queue SET attempts=attempts+1, last_error=? WHERE id=?`,
  );
  db.transaction(() => { for (const id of ids) mark.run(error, id); })();
}

/** Counts for the POS header and the tech panel. Own rows only, by construction. */
export function nodeQueueDepth(): { pending: number; failed: number } {
  const r = getLocalDb().prepare(
    `SELECT COUNT(*) FILTER (WHERE status='pending') AS pending,
            COUNT(*) FILTER (WHERE status='failed')  AS failed
       FROM node_queue`,
  ).get() as { pending: number; failed: number };
  return { pending: Number(r?.pending ?? 0), failed: Number(r?.failed ?? 0) };
}

// ── Phase 2a — distribution: every till holds the branch ─────────────────────
//
// The replicated STAR (see PHASE2-3-DESIGN.md): tills push their own rows to
// the node (above), and PULL every other device's rows back down here. The
// node is distribution, not authority — each row keeps its origin device_id
// and origin seq end to end, and the receiving till runs it through the SAME
// applyPeerRows as the node's own ingest, so every Phase 1 refusal (re-stamped
// rows, rows claiming the receiver's identity, wrong branch, missing seq)
// protects this direction without one line of new ingest code.

export interface DistributionCursors { [deviceId: string]: { [table: string]: number } }
export interface DistributionBatch { device_id: string; table: ReplicatedTable; rows: any[] }

/**
 * What the node knows that the requester doesn't. Origins are this node's own
 * device plus every device that has ever pushed to it; the requester's own
 * rows are excluded at the source — a till must never be offered its own rows
 * back, both as waste and because applyPeerRows would (correctly) refuse a
 * sender presenting the receiver's identity.
 */
export function collectDistribution(
  requesterDeviceId: string,
  cursors: DistributionCursors,
  limit = 500,
): { batches: DistributionBatch[]; has_more: boolean } {
  const db = getLocalDb();
  const own = getDeviceConfig()?.device_id ?? '';

  const origins = new Set<string>();
  if (own) origins.add(own);
  for (const p of listPeers()) origins.add(p.device_id);
  origins.delete(requesterDeviceId);

  const batches: DistributionBatch[] = [];
  let budget = Math.max(1, Math.min(limit, 2000));
  let has_more = false;

  for (const origin of origins) {
    for (const table of REPLICATED_TABLES) {
      if (budget <= 0) { has_more = true; return { batches, has_more }; }
      const after = Number(cursors?.[origin]?.[table] ?? 0);
      const cols = COLUMNS[table].join(', ');
      const rows = db.prepare(
        // branch-wide: distribution serves OTHER devices' rows by design — that
        // is the entire point of the endpoint. Scoped to one origin per query
        // and resumable by that origin's own seq.
        `SELECT ${cols} FROM ${table}
          WHERE COALESCE(device_id,'') = COALESCE(?,'') AND seq > ?
          ORDER BY seq LIMIT ?`,
      ).all(origin, after, budget + 1) as any[];
      if (!rows.length) continue;
      if (rows.length > budget) { has_more = true; rows.length = budget; }
      budget -= rows.length;

      if (table === 'orders') {
        const readItems = db.prepare(
          `SELECT ${ORDER_ITEM_COLUMNS.join(', ')} FROM order_items WHERE order_id = ?`);
        const readPays = db.prepare(
          `SELECT ${PAYMENT_COLUMNS.join(', ')} FROM payments WHERE order_id = ?`);
        for (const r of rows) {
          // branch-wide: children keyed to the order above, which is already
          // origin-scoped. Same rule as the push direction.
          r._items = readItems.all(String(r.id));
          r._payments = readPays.all(String(r.id));
        }
      }
      batches.push({ device_id: origin, table, rows });
    }
  }
  return { batches, has_more };
}

/**
 * Peer side: apply a distribution response. Each batch goes through
 * applyPeerRows under its ORIGIN's identity, and the per-origin cursor
 * advances only to what actually applied — a mid-batch failure leaves the
 * remainder for the next pull, exactly like the push direction.
 */
export function applyDistribution(
  batches: Array<{ device_id: string; table: string; rows: any[] }>,
): { applied: number; duplicate: number; rejected: number } {
  const totals = { applied: 0, duplicate: 0, rejected: 0 };
  for (const b of batches) {
    if (!isReplicatedTable(b.table)) continue;   // a newer node's table this build doesn't know
    const r = applyPeerRows(b.table, b.device_id, b.rows ?? []);
    totals.applied += r.applied;
    totals.duplicate += r.duplicate;
    totals.rejected += r.rejected.length;
    if (r.cursor > getCursor(b.device_id, b.table)) {
      advanceCursor(b.device_id, b.table, r.cursor);
    }
  }
  // Same rule as the node's ingest: every pull round ends with an event sweep.
  applyPendingEvents();
  return totals;
}

/** The cursor map this till sends when pulling: everything it has heard of. */
export function distributionCursors(): DistributionCursors {
  const out: DistributionCursors = {};
  for (const p of listPeers()) {
    (out[p.device_id] ??= {})[p.table_name] = p.last_seq;
  }
  return out;
}

// ── Phase 2b — mutations as events ───────────────────────────────────────────
//
// The append-only design's one dishonesty: a shift closes, a day closes, an
// order is voided — and every replica keeps the OLD row forever, because
// "ignore duplicates" is the rule that makes replication safe. Events resolve
// it without touching that rule: the mutation itself becomes an append-only
// fact, rides the existing outbox → push → ingest → distribution untouched
// (it is just the sixth replicated table), and a per-kind APPLIER mutates the
// replica when — and only when — the event's origin owns the target row.

const EVENT_WHITELIST: Record<string, { table: ReplicatedTable; columns: string[] }> = {
  // The whitelist is the security boundary: payload keys outside it are
  // silently dropped, so an event can never smuggle a device_id, seq, id, or
  // sync_status into a replica — the columns that make replication safe are
  // exactly the ones no event may name.
  shift_closed: {
    table: 'shifts',
    columns: ['status', 'closed_at', 'closing_float', 'expected_cash',
              'cash_variance', 'notes', 'close_method', 'closed_by'],
  },
  day_closed: {
    table: 'business_days',
    columns: ['status', 'closed_at', 'closed_by', 'counted_cash',
              'expected_cash', 'cash_variance', 'notes'],
  },
  order_voided: {
    table: 'orders',
    columns: ['status', 'void_reason', 'voided_at', 'voided_by'],
  },
};

/**
 * Record a mutation that just happened to one of THIS device's rows.
 * `applied` starts at 1: the local row was mutated by the caller in the same
 * transaction — the event exists for everyone else.
 */
export function emitEvent(
  kind: keyof typeof EVENT_WHITELIST,
  targetId: string,
  payload: Record<string, unknown>,
): void {
  const spec = EVENT_WHITELIST[kind];
  if (!spec) throw new Error(`unknown event kind: ${kind}`);
  const db = getLocalDb();
  const cfg = getDeviceConfig();
  // business_id lives on the owner session, not device config — same source
  // the order-create path uses.
  const sess = db.prepare(`SELECT business_id FROM session WHERE id = 1`).get() as { business_id?: string } | undefined;
  const clean: Record<string, unknown> = {};
  for (const c of spec.columns) if (c in payload) clean[c] = payload[c];
  db.prepare(`
    INSERT INTO events (id, business_id, branch_id, device_id, seq,
                        kind, target_table, target_id, payload, created_at, applied)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `).run(
    crypto.randomUUID(),
    sess?.business_id ?? null, cfg?.branch_id ?? null, cfg?.device_id ?? null,
    nextSeq('events'),
    kind, spec.table, targetId, JSON.stringify(clean), new Date().toISOString(),
  );
}

/**
 * Apply every event not yet applied on this device. Idempotent and safe to
 * call after every ingest/pull round; that repetition is the whole answer to
 * cross-table ordering — an event that arrives before its target row simply
 * stays applied=0 until a later sweep finds the row.
 *
 * Origin-only, enforced at application: the UPDATE matches the target id AND
 * the event's own device_id, so an event can only ever mutate a row its
 * origin owns. If the target exists under a DIFFERENT owner, the event is
 * marked refused (-1) — a forged or misattributed mutation is recorded as
 * such, not retried forever and not applied.
 */
export function applyPendingEvents(): { applied: number; waiting: number; refused: number } {
  const db = getLocalDb();
  const out = { applied: 0, waiting: 0, refused: 0 };
  const pending = db.prepare(
    // branch-wide: the sweep exists to apply OTHER devices' events to their
    // own rows on this replica — that is its entire purpose.
    `SELECT id, device_id, kind, target_table, target_id, payload FROM events WHERE applied = 0`,
  ).all() as Array<{ id: string; device_id: string | null; kind: string; target_table: string; target_id: string; payload: string }>;

  const markApplied = db.prepare(`UPDATE events SET applied = 1 WHERE id = ?`);
  const markRefused = db.prepare(`UPDATE events SET applied = -1 WHERE id = ?`);

  for (const ev of pending) {
    const spec = EVENT_WHITELIST[ev.kind];
    // An event kind (or a retargeted table) this build does not know is left
    // waiting, not guessed at: a newer till emitted it, and this till will
    // understand it after its own upgrade.
    if (!spec || spec.table !== ev.target_table) { out.waiting++; continue; }

    let payload: Record<string, unknown>;
    try { payload = JSON.parse(ev.payload) ?? {}; } catch { markRefused.run(ev.id); out.refused++; continue; }
    const cols = spec.columns.filter(c => c in payload);
    if (!cols.length) { markApplied.run(ev.id); out.applied++; continue; }  // nothing to do IS done

    const r = db.prepare(
      // branch-wide: mutates the ORIGIN's replica row by design; the device_id
      // equality IS the origin-only rule.
      `UPDATE ${spec.table} SET ${cols.map(c => `${c} = ?`).join(', ')}
        WHERE id = ? AND COALESCE(device_id,'') = COALESCE(?,'')`,
    ).run(...cols.map(c => payload[c] ?? null), ev.target_id, ev.device_id);

    if (r.changes > 0) { markApplied.run(ev.id); out.applied++; continue; }

    const holder = db.prepare(
      // branch-wide: existence probe to tell "not here yet" from "owned by
      // someone else" — the first waits, the second is refused.
      `SELECT device_id FROM ${spec.table} WHERE id = ?`,
    ).get(ev.target_id) as { device_id: string | null } | undefined;
    if (!holder) { out.waiting++; continue; }
    markRefused.run(ev.id); out.refused++;
  }
  return out;
}
