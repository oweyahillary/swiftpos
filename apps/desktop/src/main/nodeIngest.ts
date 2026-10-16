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
import { logLine } from './logFile';
import { replicaOrderNumber } from './billNumber';   // A500
import { joinProofFromHash } from './serverJoin';     // A503 (pure; crypto only)

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
    'notes',   // A367 (58): the order's note. An older node ignores it; an older peer sends none (NULL).
    'delivery_fee',   // 0.6.27 (59): on top of the bill (pass-through). Same rule as notes.
    'delivery_free',  // 0.6.33 (63): a free delivery (the shop paid the rider). Same rule as notes.
    // F8 (2026-10-14): a refund on the order as it stood when offered. A refund made AFTER the order crossed travels as
    // an `order_refunded` event (below) — rows are append-only. An older node ignores these; an older peer sends none.
    'refunded_at', 'refunded_amount', 'refund_reason',
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
    'order_id',   // 0.6.27 (59): a rider's pay-out tied to its sale. Same rule as orders.notes.
  ],
  expenses: [
    'id', 'business_id', 'branch_id', 'expense_category_id', 'description', 'amount',
    'paid_by', 'expense_date', 'shift_id', 'created_at', 'device_id', 'seq',
    'payment_method', 'expense_type_name',   // 0.6.27 (59): how it was paid; the type's name. Same rule as orders.notes.
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
  'notes',   // A367 (58): the line's note ("3 normal, 2 spicy"). Same tolerance as the order's.
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
  let total = 0;
  // Bounded rounds of the same step fillNodeOutbox runs, so the two can never number differently.
  for (let round = 0; round < 1000; round++) {
    const n = numberOwnRows(500);
    total += n;
    if (!n) break;
  }
  return total;
}

/**
 * Number this device's own unnumbered rows (seq), oldest first, at most `limit` per table. Returns how many.
 *
 * F9 (2026-10-14): this step used to live only inside fillNodeOutbox, which runs on a till WITH a branch server — so
 * the branch server itself never numbered its own orders, shifts, expenses or days, and collectDistribution (which
 * serves `seq > cursor`) never handed them to a single peer. The node now runs this on its own replication beat.
 *
 * own: only this terminal's rows are its to number — a node holds peers' rows and must not renumber them. A web sale
 * downloaded onto this till's drawer (orders.origin) is not this till's to offer either.
 */
/**
 * A501: "rows of device X" written so SQLite can use the (device_id, seq) index. `COALESCE(device_id,'') = ?` wraps the
 * column in a function, and SQLite then reads the whole table for every origin, every table, every till's pull — the
 * branch server's distribution and numbering were a full scan each, slower with every day of trading it holds. Same
 * rows as before: a device id when there is one; a device with none matches NULL or '' (what COALESCE matched).
 */
export function deviceScope(device: string | null | undefined): { sql: string; args: string[] } {
  // own: this is the "mine" predicate itself, in the form the index can use.
  return device ? { sql: 'device_id = ?', args: [device] } : { sql: "(device_id IS NULL OR device_id = '')", args: [] };
}

/** A501: the distribution read for one origin and table — exported so the test can EXPLAIN exactly this. */
export function distributionSql(table: ReplicatedTable): string {
  // branch-wide: distribution serves OTHER devices' rows by design — that is the entire point of the endpoint. Scoped to
  // one origin per query (device_id = ?, so the (device_id, seq) index answers it) and resumable by that origin's own seq.
  return `SELECT ${COLUMNS[table].join(', ')} FROM ${table}
          WHERE device_id = ? AND seq > ?
          ORDER BY seq LIMIT ?`;
}

/** A501: this device's unnumbered rows of `table`, oldest first — exported so the test can EXPLAIN exactly this. */
export function unnumberedSql(table: ReplicatedTable, own: string | null): { sql: string; args: string[] } {
  const scope = deviceScope(own);
  const notDownloaded = table === 'orders' ? 'AND origin IS NULL' : '';
  return { sql: `SELECT id FROM ${table}
        WHERE seq IS NULL AND ${scope.sql} ${notDownloaded}
        ORDER BY created_at, rowid LIMIT ?`, args: scope.args };
}

export function numberOwnRows(limit = 500): number {
  const db = getLocalDb();
  const own = getDeviceConfig()?.device_id ?? null;
  let total = 0;
  for (const table of REPLICATED_TABLES) {
    const q = unnumberedSql(table, own);   // A501: device_id = ? — the index, not a scan
    const rows = db.prepare(q.sql).all(...q.args, limit) as Array<{ id: string }>;
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
  /** F1 (2026-10-14): the ids this device now HOLDS from the batch (applied or already held). The peer marks exactly
   *  these delivered — a row in neither this list nor `rejected` stays pending and is offered again. A node on an
   *  older build sends no list; the peer then falls back to "not rejected and seq <= cursor". */
  applied_ids: string[];
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
 * Rows are applied in seq order, each on its own: a row that cannot be applied is
 * refused alone (F1) and the rest still go in. The answer names every id now held
 * (`applied_ids`), which is all the sending till marks delivered.
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
  // F5 (2026-10-14): stamped ISO like every row the till itself queues. datetime('now') ("2026-10-14 09:00:00") sorts
  // BEFORE every ISO stamp ("2026-10-14T…"), so a backlog of relayed peer sales went out ahead of the node's own.
  db.prepare(
    `INSERT OR IGNORE INTO sync_queue (order_id, payload, created_at, status)
     VALUES (?, ?, ?, 'pending')`,
  ).run(orderId, JSON.stringify(payload), new Date().toISOString());
}

export interface ApplyOptions {
  /** A19: forward an applied peer order to the cloud from this device's sync_queue. Only the branch server does this,
   *  and (F7) only for a till it knows — one that joined / polls it — sending its own rows. Off on a peer applying
   *  distribution: the order's own till (and the server) already send it. */
  relay?: boolean;
  /** Distribution (a peer pulling from the server): a row that cannot be applied is refused ALONE and the cursor moves
   *  past it — otherwise one bad row stalls that origin's table on this till forever. The node's own ingest keeps its
   *  cursor at what it holds (the peer re-offers anything not acknowledged). */
  advancePastFailures?: boolean;
}

export function applyPeerRows(
  table: ReplicatedTable,
  peerDeviceId: string,
  rows: any[],
  opts: ApplyOptions = {},
): IngestResult {
  const db = getLocalDb();
  const cfg = getDeviceConfig();
  const result: IngestResult = { applied: 0, duplicate: 0, rejected: [], cursor: 0, relayed: 0, applied_ids: [] };

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
  // The highest seq the cursor may move to: held rows always; refused rows only when the caller moves past failures.
  let passed = 0;
  const refuse = (id: string, reason: string, seq: number) => {
    result.rejected.push({ id, table, reason });
    if (opts.advancePastFailures && Number.isInteger(seq) && seq > passed) passed = seq;
  };

  for (const row of ordered) {
    const id = row?.id ? String(row.id) : null;
    const seq = Number(row?.seq);
    if (!id) { refuse('?', 'row has no id', seq); continue; }

    // The peer's own attribution must survive the trip. If it disagrees with the
    // device the payload came from, something re-stamped it in transit and the
    // row can no longer be attributed to anyone honestly.
    const rowDevice = row.device_id ? String(row.device_id) : null;
    if (rowDevice && rowDevice !== peerDeviceId) {
      refuse(id, `row device_id ${rowDevice} does not match the sending device ${peerDeviceId}`, seq);
      continue;
    }

    // A row with no seq cannot be checkpointed: the cursor would not advance past
    // it, so it would be re-offered forever, or it would be skipped and lost. It
    // means the peer is on a build older than 45.
    if (!Number.isInteger(seq) || seq <= 0) {
      refuse(id, 'row has no sequence number — that till is on a build older than schema 45', seq);
      continue;
    }

    // Branch scope. The node holds one branch; a row from another is either a
    // misconfigured till or a device moved between sites, and ingesting it would
    // put another branch's cash into this branch's report.
    if (cfg?.branch_id && row.branch_id && String(row.branch_id) !== cfg.branch_id) {
      refuse(id, 'row belongs to a different branch', seq);
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
      result.applied_ids.push(id);
      if (seq > result.cursor) result.cursor = seq;
      continue;
    }

    try {
      let relayedThisRow = false;
      db.transaction(() => {
        // A500: a bill number another row here already holds (a reinstalled till restarting its counter, two tills on
        // one code) no longer refuses the sale — its copy here takes `<number>~<device>`; the id stays its identity.
        const alias = table === 'orders' ? replicaOrderNumber(db, { id, order_number: row.order_number, device_id: peerDeviceId }) : null;
        if (alias) logLine('node', `A500: ${table} ${id} from ${peerDeviceId.slice(0, 8)} has bill ${row.order_number}, already held here by another sale — kept as ${alias}`);
        insert.run(...cols.map(c => (c === 'device_id' ? peerDeviceId : c === 'order_number' && alias ? alias : row[c] ?? null)));
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
          // F7: only for a till this server knows, and only its OWN sale (the row names the sending device).
          if (opts.relay && rowDevice === peerDeviceId) {
            const relay = buildPeerRelay(row);
            if (relay.ok) { enqueuePeerRelay(db, relay.orderId, relay.payload); relayedThisRow = true; }
          }
        }
      })();
      result.applied++;
      result.applied_ids.push(id);
      if (relayedThisRow) result.relayed = (result.relayed ?? 0) + 1;
      if (seq > result.cursor) result.cursor = seq;
    } catch (err: any) {
      // F1 (2026-10-14): refuse THIS row and carry on with the rest. It used to `break` here, expecting the peer to
      // re-offer the remainder — but the peer marked every row not named in `rejected` as delivered, so the rest of
      // the batch was lost from the node for good. Now the answer names exactly what is held (applied_ids); the
      // refused row is reported with its reason, and the cursor does not claim it (unless the caller moves past).
      refuse(id, String(err?.message ?? 'insert failed'), seq);
      continue;
    }
  }

  if (passed > result.cursor) result.cursor = passed;
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

// ── F7: each till's own key on the branch server ─────────────────────────────
//
// The branch code (X-Node-Secret) is one secret for the whole branch — every till has it, and so does anything that
// ever read it off a till. On its own it let its holder speak AS any till: push rows under another device_id, relay
// "sales" to the cloud in its name, hand the server staff changes. Now each till also carries its own key
// (X-Device-Token, 32 random bytes); the server keeps only a SHA-256 of it, per device.
//
//   - Issued by the server when a person allows a till to join (the join grant carries it), or
//   - recorded the first time a till presents one (every till installed before this build, or set up with the typed
//     code). From then on that device id is spoken for: a request naming it without its key is refused.
//   - Older tills that send no key at all: /node/sync still works (with a warning in the log), nothing else that
//     needs the key does — see nodeServer.ts.
//
// Node-local table, created on first use (like node_state): no LOCAL_SCHEMA_VERSION change, nothing sent anywhere.

function ensureDeviceKeys(): void {
  getLocalDb().exec(`CREATE TABLE IF NOT EXISTS node_device_keys (
    device_id  TEXT PRIMARY KEY,
    key_hash   TEXT NOT NULL,
    source     TEXT NOT NULL,      -- 'join' (issued at Allow) | 'first_use' (recorded when first presented)
    created_at TEXT NOT NULL,
    last_seen  TEXT
  )`);
}

const keyHash = (token: string) => crypto.createHash('sha256').update(token, 'utf8').digest('hex');

/** ok: the key matches · enrolled: first sight, recorded · mismatch: wrong key · missing: none sent for a device that
 *  has one · absent: no key sent and none on record (an older till) — or no device named · unknown (A496): a key from a
 *  device this server never knew — not recorded; it must join. */
export type DeviceKeyVerdict = 'ok' | 'enrolled' | 'mismatch' | 'missing' | 'absent' | 'unknown';

// ── A496: who may still record a key on first use ────────────────────────────────────────────────────────────────
// Branch-server audit: checkDeviceKey recorded ANY never-seen device id that presented a key — so a holder of the branch
// code alone could mint a "till" of their own choosing (and, through it, relays to the cloud). First-use recording exists
// for tills that were on this server BEFORE device keys (F7). Those are the devices it had heard from: peer_cursors and
// node_peer_state rows. They are written down ONCE, the first time this build runs (node_enrol_allowed); only they may
// still record a key on first use. Any other device joins (the person at the server allows it — issueDeviceKey).
function ensureEnrolAllowed(): void {
  const db = getLocalDb();
  db.exec(`CREATE TABLE IF NOT EXISTS node_enrol_allowed (device_id TEXT PRIMARY KEY, noted_at TEXT NOT NULL)`);
  const done = db.prepare(`SELECT value FROM maintenance_state WHERE key = 'node_enrol_snapshot'`).get() as { value?: string } | undefined;
  if (done?.value) return;
  const now = new Date().toISOString();
  db.transaction(() => {
    const ins = db.prepare(`INSERT OR IGNORE INTO node_enrol_allowed (device_id, noted_at) VALUES (?, ?)`);
    for (const t of ['peer_cursors', 'node_peer_state']) {
      try { for (const r of db.prepare(`SELECT DISTINCT device_id FROM ${t}`).all() as Array<{ device_id: string }>) if (r.device_id) ins.run(String(r.device_id), now); }
      catch { /* that table not there on this machine */ }
    }
    db.prepare(`INSERT OR REPLACE INTO maintenance_state (key, value, updated_at) VALUES ('node_enrol_snapshot', ?, ?)`).run(now, now);
  })();
}
/** A496: note the tills known before device keys (once) — the branch server calls it when it starts. */
export function prepareDeviceEnrolment(): void { ensureEnrolAllowed(); }

/** A496: a device this server knew before device keys — it may record its key on first use. */
export function mayEnrolOnFirstUse(deviceId: string): boolean {
  try { ensureEnrolAllowed(); return !!getLocalDb().prepare(`SELECT 1 FROM node_enrol_allowed WHERE device_id = ?`).get(String(deviceId)); }
  catch { return false; }
}

export function checkDeviceKey(deviceId: string | null | undefined, token: string | null | undefined): DeviceKeyVerdict {
  const id = String(deviceId ?? '').trim();
  if (!id) return 'absent';
  ensureDeviceKeys();
  const db = getLocalDb();
  const row = db.prepare(`SELECT key_hash FROM node_device_keys WHERE device_id = ?`).get(id) as { key_hash: string } | undefined;
  const t = typeof token === 'string' && /^[0-9a-f]{64}$/.test(token) ? token : null;
  if (!t) return row ? 'missing' : 'absent';
  const now = new Date().toISOString();
  if (!row) {
    if (!mayEnrolOnFirstUse(id)) return 'unknown';   // A496: never seen before — it joins, it does not enrol itself
    db.prepare(`INSERT OR IGNORE INTO node_device_keys (device_id, key_hash, source, created_at, last_seen) VALUES (?, ?, 'first_use', ?, ?)`)
      .run(id, keyHash(t), now, now);
    return 'enrolled';
  }
  const a = Buffer.from(keyHash(t), 'hex');
  const b = Buffer.from(row.key_hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return 'mismatch';
  db.prepare(`UPDATE node_device_keys SET last_seen = ? WHERE device_id = ?`).run(now, id);
  return 'ok';
}

/** Join: a person allowed this till — issue it a fresh key (replacing any it had). Returns the key, once. */
export function issueDeviceKey(deviceId: string): string {
  ensureDeviceKeys();
  const token = crypto.randomBytes(32).toString('hex');
  const now = new Date().toISOString();
  getLocalDb().prepare(`INSERT OR REPLACE INTO node_device_keys (device_id, key_hash, source, created_at, last_seen) VALUES (?, ?, 'join', ?, NULL)`)
    .run(String(deviceId), keyHash(token), now);
  return token;
}

/** "Forget this till": its key goes too. A496: and its first-use right — if it comes back it joins again. */
export function forgetDeviceKey(deviceId: string): void {
  ensureDeviceKeys();
  ensureEnrolAllowed();
  getLocalDb().prepare(`DELETE FROM node_device_keys WHERE device_id = ?`).run(String(deviceId));
  getLocalDb().prepare(`DELETE FROM node_enrol_allowed WHERE device_id = ?`).run(String(deviceId));
}

/** A496: does this device hold a key here (a join must not replace it — the till is forgotten first)? */
export function holdsDeviceKey(deviceId: string): boolean {
  ensureDeviceKeys();
  return !!getLocalDb().prepare(`SELECT 1 FROM node_device_keys WHERE device_id = ?`).get(String(deviceId ?? ''));
}

/**
 * A503: may a join for `deviceId` go ahead (the person at the server is then asked)? 'none' — no key here;
 * 'unused' — its key came from a join and was never used (the till never got it: a lost answer, a failed enrolment);
 * 'proven' — the request's X-Join-Proof shows it holds its current key (serverJoin.joinProofFromHash, bound to this
 * server's security code); 'held' — refused (409), as before. See serverJoin.ts.
 */
export function joinVerdict(deviceId: string, proof: string | null | undefined, serverCode: string | null): 'none' | 'unused' | 'proven' | 'held' {
  ensureDeviceKeys();
  const id = String(deviceId ?? '');
  const row = getLocalDb().prepare(`SELECT key_hash, source, last_seen FROM node_device_keys WHERE device_id = ?`).get(id) as
    { key_hash: string; source: string; last_seen: string | null } | undefined;
  if (!row) return 'none';
  if (row.source === 'join' && !row.last_seen) return 'unused';
  const p = typeof proof === 'string' && /^[0-9a-f]{64}$/.test(proof) ? Buffer.from(proof, 'hex') : null;
  if (p) {
    const want = Buffer.from(joinProofFromHash(row.key_hash, id, serverCode), 'hex');
    if (p.length === want.length && crypto.timingSafeEqual(p, want)) return 'proven';
  }
  return 'held';
}

/** A till this server knows: it holds a key here (a join, or a first-use key from a known device), it was known before
 *  device keys (A496: node_enrol_allowed), or it reports to the Close Branch poll (only a known till is recorded there). */
export function isKnownTill(deviceId: string | null | undefined): boolean {
  const id = String(deviceId ?? '');
  if (!id) return false;
  ensureDeviceKeys();
  const db = getLocalDb();
  return !!db.prepare(`SELECT 1 FROM node_device_keys WHERE device_id = ?`).get(id)
      || mayEnrolOnFirstUse(id)
      || !!db.prepare(`SELECT 1 FROM node_peer_state WHERE device_id = ?`).get(id);
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
  const db = getLocalDb();
  db.transaction(() => {
    db.prepare(`DELETE FROM outbox_cursors`).run();
    // F2 (2026-10-14): resetting the cursor alone re-offered nothing. The scan re-enqueues with INSERT OR IGNORE on
    // (table_name, row_id), and every row it found was already in node_queue as 'delivered' (or 'failed') — so the
    // "re-offer" was a no-op and the new server never got the rows. The queue rows themselves are re-armed here.
    // node_queue holds only this till's own rows (fillNodeOutbox is own-scoped), so this touches nothing else.
    // last_error is kept: it is how skipHeldByNode tells a row the old server REFUSED from one it simply holds.
    db.prepare(`UPDATE node_queue SET status = 'pending', attempts = 0 WHERE status <> 'pending' OR attempts > 0`).run();
    // Then ask the new server what it already holds and skip that (pushToNode, /node/cursors) — once.
    db.prepare(`INSERT OR REPLACE INTO maintenance_state (key, value, updated_at) VALUES ('node_rearm_skip', '1', ?)`)
      .run(new Date().toISOString());
  })();
}

/**
 * F2: the branch server this till sends to has changed (a rejoin, a repoint or promotion, a new access code — what a
 * 401 that a fresh code fixes looks like). Everything is offered again: cursors reset, every queue row pending with a
 * clean attempt count, failed rows included (F3 — a new server deserves a fresh try). Re-offering is free: ingest is
 * idempotent on the row's own id.
 */
export function rearmNodeOutbox(): void {
  resetOutboxCursors();
}

/** The identity of the server this till sends to — its address and access code, hashed (never stored in clear here). */
export function nodeTargetKey(url: string | null | undefined, secret: string | null | undefined): string {
  return crypto.createHash('sha256').update(`${String(url ?? '').replace(/\/+$/, '')}|${String(secret ?? '')}`).digest('hex').slice(0, 32);
}

/**
 * F2: re-arm when the server changed since the last pass. Returns what happened: 'same', 'changed' (re-armed) or
 * 'first' — the first pass on this build. On 'first' only the last 14 days are offered again, without the
 * /node/cursors skip: before F1 a batch with one failing row lost the rest of itself from the node while the till
 * marked it delivered, and this is the one chance to put those rows back. Duplicates are ignored on arrival.
 */
export function noteNodeTarget(key: string): 'same' | 'changed' | 'first' {
  const db = getLocalDb();
  const row = db.prepare(`SELECT value FROM maintenance_state WHERE key = 'node_target'`).get() as { value?: string } | undefined;
  if (row?.value === key) return 'same';
  const now = new Date().toISOString();
  if (!row) {
    db.transaction(() => {
      db.prepare(`UPDATE node_queue SET status = 'pending', attempts = 0
                   WHERE status = 'delivered' AND created_at >= datetime('now', '-14 days')`).run();
      db.prepare(`INSERT OR REPLACE INTO maintenance_state (key, value, updated_at) VALUES ('node_target', ?, ?)`).run(key, now);
    })();
    return 'first';
  }
  db.transaction(() => {
    resetOutboxCursors();
    rearmPeerQuarantine();   // A501: rows held back from the old server's tills are tried again from the new one
    db.prepare(`INSERT OR REPLACE INTO maintenance_state (key, value, updated_at) VALUES ('node_target', ?, ?)`).run(key, now);
  })();
  return 'changed';
}

/** F2: is the one-time "skip what the new server already holds" step still owed? */
export function nodeRearmSkipOwed(): boolean {
  return !!getLocalDb().prepare(`SELECT 1 FROM maintenance_state WHERE key = 'node_rearm_skip'`).get();
}

/**
 * F2: the server answered /node/cursors — mark delivered the pending rows it already holds (seq at or below its
 * cursor for this device and table). Rows a server ever REFUSED (a last_error that is not a transport note) are left
 * pending: a cursor is a high-water mark, and a row refused below it is exactly the one it does not prove.
 * Returns how many were skipped.
 */
export function skipHeldByNode(cursors: Array<{ table_name: string; last_seq: number }>): number {
  const db = getLocalDb();
  let n = 0;
  db.transaction(() => {
    const mark = db.prepare(`UPDATE node_queue SET status = 'delivered'
                              WHERE status = 'pending' AND table_name = ?
                                AND (last_error IS NULL OR last_error LIKE '${TRANSPORT_NOTE}%')
                                AND CAST(json_extract(payload, '$.seq') AS INTEGER) <= ?`);
    for (const c of cursors ?? []) {
      if (!isReplicatedTable(String(c?.table_name)) || !(Number(c?.last_seq) > 0)) continue;
      n += mark.run(String(c.table_name), Number(c.last_seq)).changes;
    }
    db.prepare(`DELETE FROM maintenance_state WHERE key = 'node_rearm_skip'`).run();
  })();
  return n;
}

/** F3: how a transport failure (not counted) is written in node_queue.last_error. */
export const TRANSPORT_NOTE = 'transport: ';

/**
 * A500: once per machine, undo what bill-number clashes did before A500 — sales the branch server refused for their
 * number go to it again (node_queue), and the origins whose sales this till skipped in a distribution pull are pulled
 * again from the start (duplicates are ignored on arrival; the skipped ones now land under `<number>~<device>`).
 * Returns what was re-armed. Never throws.
 */
export function repairBillNumberRefusals(): { requeued: number; origins: number } {
  const out = { requeued: 0, origins: 0 };
  try {
    const db = getLocalDb();
    if (db.prepare(`SELECT 1 FROM maintenance_state WHERE key = 'a500_bill_repair'`).get()) return out;
    const CLASH = '%UNIQUE constraint failed: orders.order_number%';
    db.transaction(() => {
      out.requeued = db.prepare(`UPDATE node_queue SET status = 'pending', attempts = 0, last_error = NULL
                                  WHERE table_name = 'orders' AND last_error LIKE ?`).run(CLASH).changes;
      const keys = db.prepare(`SELECT key FROM maintenance_state WHERE key LIKE 'distribution_refused:%:orders:%' AND value LIKE ?`)
        .all(CLASH) as Array<{ key: string }>;
      const origins = new Set(keys.map((k) => k.key.split(':')[1]).filter(Boolean));
      for (const o of origins) db.prepare(`UPDATE peer_cursors SET last_seq = 0 WHERE device_id = ? AND table_name = 'orders'`).run(o);
      for (const k of keys) db.prepare(`DELETE FROM maintenance_state WHERE key = ?`).run(k.key);
      out.origins = origins.size;
      db.prepare(`INSERT OR REPLACE INTO maintenance_state (key, value, updated_at) VALUES ('a500_bill_repair', ?, ?)`)
        .run(JSON.stringify(out), new Date().toISOString());
    })();
    if (out.requeued || out.origins) logLine('node', `A500: ${out.requeued} sale(s) refused for their bill number offered to the branch server again; ${out.origins} till(s)' sales pulled again`);
  } catch (e: any) { logLine('node', `A500 repair skipped: ${e?.message ?? e}`); }
  return out;
}

/** F3: put rows the old server refused back in line (on a server change, or asked for on the Tech page). */
export function rearmFailedNodeRows(): number {
  return getLocalDb().prepare(`UPDATE node_queue SET status = 'pending', attempts = 0 WHERE status = 'failed'`).run().changes;
}

/**
 * A501: who this till is talking to, as far as a failed row is concerned — the server's certificate (security code),
 * its device id, and THIS till's branch. Any of them changing means a row refused before may be taken now: a cloud
 * sign-in that rebinds the till to another branch (every route answers 403) and then back, a server reinstalled, a
 * till re-pinned. Hashed; never stored in clear.
 */
export function nodeIdentityKey(parts: { certCode: string | null; serverDevice: string | null; branch: string | null }): string {
  return crypto.createHash('sha256').update(`${parts.certCode ?? ''}|${parts.serverDevice ?? ''}|${parts.branch ?? ''}`).digest('hex').slice(0, 32);
}

/**
 * A501: note the identity seen this pass. 'changed' (and 'first' — this build's first look) re-arm what the old
 * identity refused: the outbox's failed rows and the distribution quarantine. 'same' does nothing.
 */
export function noteNodeIdentity(key: string): { verdict: 'same' | 'changed' | 'first'; rearmed: number; released: number } {
  const db = getLocalDb();
  const row = db.prepare(`SELECT value FROM maintenance_state WHERE key = 'node_identity'`).get() as { value?: string } | undefined;
  if (row?.value === key) return { verdict: 'same', rearmed: 0, released: 0 };
  let rearmed = 0, released = 0;
  db.transaction(() => {
    rearmed = rearmFailedNodeRows();
    released = rearmPeerQuarantine();
    db.prepare(`INSERT OR REPLACE INTO maintenance_state (key, value, updated_at) VALUES ('node_identity', ?, ?)`).run(key, new Date().toISOString());
  })();
  return { verdict: row ? 'changed' : 'first', rearmed, released };
}

/**
 * A501: the till followed ITS OWN server to a new address (same pinned certificate, same server device id — see
 * nodeFollow.ts). The target key moves with it WITHOUT a re-arm: nothing about what the server holds changed.
 */
export function adoptNodeTarget(key: string): void {
  getLocalDb().prepare(`INSERT OR REPLACE INTO maintenance_state (key, value, updated_at) VALUES ('node_target', ?, ?)`)
    .run(key, new Date().toISOString());
}

// ── A501: the distribution quarantine ───────────────────────────────────────────────────────────────────────────────
//
// A row a till could not apply from a pull used to be skipped for good: F1 moved the origin's cursor past it (so one bad
// row could not stall the table), and nothing ever asked for it again. Some of those rows were never bad — only early:
// a till that closes yesterday and opens today in one go hands the server today's day row AND the event closing
// yesterday; the pull applies tables before events, the one-open-day-per-till index refuses today's row, the event then
// closes yesterday — and today's trading day was missing from every other till for good. The row now waits here, with
// its reason, and is tried again after every pull's event sweep, with backoff, a bounded number of times; and again on
// every server change and on the Tech page's "Retry failed records". It never blocks another row.
//
// Node-local table, created on first use (like node_device_keys): nothing about it is sent anywhere.

export const QUARANTINE_MAX_ATTEMPTS = 12;
const QUARANTINE_BASE_MS = 30_000;
const QUARANTINE_MAX_BACKOFF_MS = 3_600_000;

function ensureQuarantine(): void {
  getLocalDb().exec(`CREATE TABLE IF NOT EXISTS peer_quarantine (
    origin      TEXT NOT NULL,
    table_name  TEXT NOT NULL,
    row_id      TEXT NOT NULL,
    seq         INTEGER,
    payload     TEXT NOT NULL,
    reason      TEXT,
    attempts    INTEGER NOT NULL DEFAULT 0,
    next_at     TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'waiting',   -- 'waiting' | 'given_up' (after QUARANTINE_MAX_ATTEMPTS)
    first_at    TEXT NOT NULL,
    last_at     TEXT NOT NULL,
    PRIMARY KEY (origin, table_name, row_id)
  )`);
}

/** The wait before attempt n+1 (n tries made): 30 s, 1 min, 2 min … at most an hour. */
export function quarantineBackoffMs(attempts: number): number {
  return Math.min(QUARANTINE_MAX_BACKOFF_MS, QUARANTINE_BASE_MS * 2 ** Math.max(0, attempts - 1));
}

/** Keep a refused peer row to try again. A row already waiting keeps its count; its reason is refreshed. */
export function quarantinePeerRow(origin: string, table: ReplicatedTable, row: any, reason: string, now = Date.now()): void {
  const id = row?.id ? String(row.id) : null;
  if (!id || !origin) return;
  ensureQuarantine();
  const at = new Date(now).toISOString();
  const seq = Number(row?.seq);
  getLocalDb().prepare(`
    INSERT INTO peer_quarantine (origin, table_name, row_id, seq, payload, reason, attempts, next_at, status, first_at, last_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?, 'waiting', ?, ?)
    ON CONFLICT(origin, table_name, row_id) DO UPDATE SET payload = excluded.payload, reason = excluded.reason, last_at = excluded.last_at`,
  ).run(origin, table, id, Number.isInteger(seq) ? seq : null, JSON.stringify(row), String(reason ?? '').slice(0, 300),
    new Date(now + QUARANTINE_BASE_MS).toISOString(), at, at);
}

/**
 * Try the quarantined rows that are due (all of them with `force`). A row applied — or found already held — leaves the
 * quarantine; one refused again waits longer, and after QUARANTINE_MAX_ATTEMPTS it is kept as 'given_up' (shown on the
 * Tech page) until a server change or a person retries it. Never throws. Ends with an event sweep when anything landed.
 */
export function retryPeerQuarantine(opts: { force?: boolean; now?: number } = {}): { applied: number; waiting: number; givenUp: number } {
  const out = { applied: 0, waiting: 0, givenUp: 0 };
  try {
    ensureQuarantine();
    const db = getLocalDb();
    const now = opts.now ?? Date.now();
    const due = db.prepare(
      `SELECT origin, table_name, row_id, payload, attempts FROM peer_quarantine
        WHERE status = 'waiting' ${opts.force ? '' : 'AND next_at <= ?'}
        ORDER BY table_name = 'events', seq LIMIT 500`,
    ).all(...(opts.force ? [] : [new Date(now).toISOString()])) as Array<{ origin: string; table_name: string; row_id: string; payload: string; attempts: number }>;
    const drop = db.prepare(`DELETE FROM peer_quarantine WHERE origin = ? AND table_name = ? AND row_id = ?`);
    const again = db.prepare(`UPDATE peer_quarantine SET attempts = ?, reason = ?, next_at = ?, status = ?, last_at = ? WHERE origin = ? AND table_name = ? AND row_id = ?`);
    for (const q of due) {
      if (!isReplicatedTable(q.table_name)) continue;
      let row: any;
      try { row = JSON.parse(q.payload); } catch { drop.run(q.origin, q.table_name, q.row_id); continue; }
      const r = applyPeerRows(q.table_name, q.origin, [row], { relay: false });
      if (r.applied_ids.includes(q.row_id)) {
        drop.run(q.origin, q.table_name, q.row_id);
        try { db.prepare(`DELETE FROM maintenance_state WHERE key = ?`).run(`distribution_refused:${q.origin}:${q.table_name}:${q.row_id}`); } catch { /* kept */ }
        out.applied++;
        logLine('node', `A501: ${q.table_name} ${q.row_id} from ${q.origin.slice(0, 8)} applied on retry ${q.attempts + 1} (it was refused earlier)`);
        continue;
      }
      const attempts = q.attempts + 1;
      const gaveUp = attempts >= QUARANTINE_MAX_ATTEMPTS;
      again.run(attempts, String(r.rejected[0]?.reason ?? 'refused').slice(0, 300), new Date(now + quarantineBackoffMs(attempts)).toISOString(),
        gaveUp ? 'given_up' : 'waiting', new Date(now).toISOString(), q.origin, q.table_name, q.row_id);
      if (gaveUp) {
        out.givenUp++;
        logLine('node', `A501: ${q.table_name} ${q.row_id} from ${q.origin.slice(0, 8)} still refused after ${attempts} tries (${String(r.rejected[0]?.reason ?? '').slice(0, 160)}) — kept; Tech › Retry failed records tries it again`);
      } else out.waiting++;
    }
    if (out.applied) applyPendingEvents();
  } catch (e: any) { logLine('node', `A501: quarantine retry skipped: ${e?.message ?? e}`); }
  return out;
}

/** Every quarantined row due now, given-up ones included, with a clean count (a server change; the Tech page button). */
export function rearmPeerQuarantine(): number {
  try {
    ensureQuarantine();
    return getLocalDb().prepare(`UPDATE peer_quarantine SET status = 'waiting', attempts = 0, next_at = ?`).run(new Date(0).toISOString()).changes;
  } catch { return 0; }
}

/** For the Tech page: how many wait, how many were given up on, and the commonest reason. */
export function peerQuarantineSummary(): { waiting: number; givenUp: number; reason: string | null } {
  try {
    ensureQuarantine();
    const db = getLocalDb();
    const r = db.prepare(`SELECT COUNT(*) FILTER (WHERE status='waiting') AS w, COUNT(*) FILTER (WHERE status='given_up') AS g FROM peer_quarantine`).get() as { w: number; g: number };
    const top = db.prepare(`SELECT reason, COUNT(*) n FROM peer_quarantine GROUP BY reason ORDER BY n DESC LIMIT 1`).get() as { reason?: string } | undefined;
    return { waiting: Number(r?.w ?? 0), givenUp: Number(r?.g ?? 0), reason: top?.reason ?? null };
  } catch { return { waiting: 0, givenUp: 0, reason: null }; }
}

/**
 * A501, the server's ingest (/node/sync): rows refused only because of their order within one batch (a new trading day
 * before the event closing the last one) are tried once more after the event sweep, and the answer is corrected — the
 * till then marks them delivered at once instead of counting a refusal and sending them again.
 */
export function retryRefusedAfterEvents(table: ReplicatedTable, peerDeviceId: string, rows: any[], result: IngestResult, opts: ApplyOptions = {}): IngestResult {
  if (!result?.rejected?.length) return result;
  const refusedIds = new Set(result.rejected.map((r) => String(r.id)));
  const again = (rows ?? []).filter((r) => r?.id && refusedIds.has(String(r.id)));
  if (!again.length) return result;
  const r2 = applyPeerRows(table, peerDeviceId, again, opts);
  if (!r2.applied_ids.length) return result;
  const held = new Set(r2.applied_ids);
  return {
    ...result,
    applied: result.applied + r2.applied,
    duplicate: result.duplicate + r2.duplicate,
    rejected: result.rejected.filter((x) => !held.has(String(x.id))),
    applied_ids: [...result.applied_ids, ...r2.applied_ids],
    cursor: Math.max(result.cursor, r2.cursor),
    relayed: (result.relayed ?? 0) + (r2.relayed ?? 0),
  };
}

/**
 * P3: housekeeping. Delivered outbox rows older than 7 days go (a re-arm re-enqueues from the tables themselves, so
 * nothing is lost by it); on the server, instructions answered more than 7 days ago go too.
 */
export function pruneNodeQueue(days = 7): number {
  return getLocalDb().prepare(
    `DELETE FROM node_queue WHERE status = 'delivered' AND created_at < datetime('now', ?)`,
  ).run(`-${Math.max(1, Math.floor(days))} days`).changes;
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
  // F8: a refund made since the order crossed becomes an event first, so it goes in this same pass.
  try { emitRefundEvents(); } catch { /* the next pass */ }

  for (const table of REPLICATED_TABLES) {
    // own: a till offers the node ITS OWN rows. A node running this same code
    // must not offer a peer's rows back to itself, and on a mesh peer it would
    // re-offer another till's history as though it were its own.
    // Cross-sync (2026-09-27): a web sale downloaded onto this till's drawer (orders.origin) is not this
    // till's to offer — it was never rung here, and the cloud already has it.
    const notDownloaded = table === 'orders' ? 'AND origin IS NULL' : '';
    const uq = unnumberedSql(table, own);   // A501: device_id = ? — the index, not a scan
    const unnumbered = db.prepare(uq.sql).all(...uq.args, 500) as Array<{ id: string }>;

    if (unnumbered.length) {
      const setSeq = db.prepare(`UPDATE ${table} SET seq = ? WHERE id = ?`);
      db.transaction(() => {
        for (const r of unnumbered) setSeq.run(nextSeq(table), r.id);
      })();
    }

    const cols = COLUMNS[table];
    // own: as above — only this terminal's rows are its to offer. A501: device_id = ? (deviceScope), so the
    // (device_id, seq) index walks from the cursor instead of reading the table.
    const scope = deviceScope(own);
    const rows = db.prepare(
      `SELECT ${cols.join(', ')} FROM ${table}
        WHERE ${scope.sql} AND seq IS NOT NULL AND seq > ? ${notDownloaded}
        ORDER BY seq LIMIT 500`,
    ).all(...scope.args, getOutboxCursor(table)) as any[];
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
export function takeNodeQueueBatch(limit = 100, maxBytes = NODE_BATCH_BYTES): NodeQueueRow[] {
  const rows = getLocalDb().prepare(
    `SELECT id, table_name, row_id, payload, attempts, created_at
       FROM node_queue WHERE status = 'pending'
      ORDER BY created_at, id LIMIT ?`,
  ).all(limit) as NodeQueueRow[];
  // F14 (2026-10-14): a batch is capped by SIZE as well as count. 200 orders with their lines, payments and the relay
  // payload could pass the server's 5 MB body limit — it cut the request, the till saw "unreachable" and sent the same
  // batch again, forever. Always at least one row (a single row over the limit is the server's to refuse, by name).
  const out: NodeQueueRow[] = [];
  let bytes = 0;
  for (const r of rows) {
    const size = Buffer.byteLength(r.payload ?? '', 'utf8') + 64;
    if (out.length && bytes + size > maxBytes) break;
    out.push(r);
    bytes += size;
  }
  return out;
}

/** F14: the most a till sends the server in one /node/sync (the server refuses over 5 MB with a 413). */
export const NODE_BATCH_BYTES = 2_000_000;

/**
 * F1: what a /node/sync answer means for each queue row of the batch.
 *   delivered — the server holds it (named in `applied_ids`);
 *   refused   — named in `rejected`, with the server's reason (counts toward 'failed');
 *   pending   — neither: it is offered again next pass, no attempt counted.
 * A server on an older build sends no `applied_ids`: then a row not rejected counts as held only when its seq is at or
 * below the server's cursor for the table — that build stopped at its first failure, and the cursor is the last row
 * it really took, so the rows after the stop stay pending instead of being lost.
 */
export function settleNodeBatch(batch: NodeQueueRow[], results: Record<string, any>):
  { delivered: number[]; refused: Array<{ id: number; reason: string }>; pending: number[] } {
  const delivered: number[] = [];
  const refused: Array<{ id: number; reason: string }> = [];
  const pending: number[] = [];
  const cache = new Map<string, { rejected: Map<string, string>; held: Set<string> | null; cursor: number }>();
  const verdictFor = (table: string) => {
    let v = cache.get(table);
    if (!v) {
      const res = results?.[table];
      v = res ? {
        rejected: new Map<string, string>((Array.isArray(res.rejected) ? res.rejected : []).map((r: any) => [String(r?.id), String(r?.reason ?? 'refused')])),
        held: Array.isArray(res.applied_ids) ? new Set<string>(res.applied_ids.map(String)) : null,
        cursor: Number(res.cursor) || 0,
      } : { rejected: new Map(), held: new Set<string>(), cursor: 0 };
      cache.set(table, v);
    }
    return v;
  };
  for (const q of batch) {
    const v = verdictFor(q.table_name);
    const reason = v.rejected.get(String(q.row_id)) ?? v.rejected.get('*');
    if (reason) { refused.push({ id: q.id, reason }); continue; }
    if (v.held) { (v.held.has(String(q.row_id)) ? delivered : pending).push(q.id); continue; }
    let seq = NaN;
    try { seq = Number(JSON.parse(q.payload)?.seq); } catch { /* unreadable: stays pending */ }
    (Number.isFinite(seq) && seq > 0 && seq <= v.cursor ? delivered : pending).push(q.id);
  }
  return { delivered, refused, pending };
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
 *
 * F3 (2026-10-14): a pass that did not land for a TRANSPORT reason (no answer, a 5xx, a 401 the next access code
 * fixes) no longer counts as an attempt at all. It used to add one even with escalate=false, so a node switched off
 * for a weekend put every row one refusal away from 'failed'. Only an answer on the row's merits counts.
 */
export function markNodeQueueFailed(ids: number[], error: string, escalate: boolean): void {
  if (!ids.length) return;
  const db = getLocalDb();
  const mark = db.prepare(
    escalate
      ? `UPDATE node_queue SET attempts=attempts+1, last_error=?,
           status=CASE WHEN attempts+1 >= 5 THEN 'failed' ELSE 'pending' END WHERE id=?`
      : `UPDATE node_queue SET last_error=? WHERE id=?`,
  );
  const note = escalate ? error : `${TRANSPORT_NOTE}${error}`;
  db.transaction(() => { for (const id of ids) mark.run(note, id); })();
}

/** Counts for the POS header and the tech panel. Own rows only, by construction. */
export function nodeQueueDepth(): { pending: number; failed: number; oldestPendingAt?: string | null; failedReason?: string | null } {
  const db = getLocalDb();
  const r = db.prepare(
    `SELECT COUNT(*) FILTER (WHERE status='pending') AS pending,
            COUNT(*) FILTER (WHERE status='failed')  AS failed,
            MIN(created_at) FILTER (WHERE status='pending') AS oldest
       FROM node_queue`,
  ).get() as { pending: number; failed: number; oldest: string | null };
  // A501: how long the oldest has waited (the manager's notice speaks up only when it has waited long) and why rows failed.
  let failedReason: string | null = null;
  if (Number(r?.failed ?? 0) > 0) {
    try {
      failedReason = (db.prepare(`SELECT last_error, COUNT(*) n FROM node_queue WHERE status='failed' AND last_error IS NOT NULL
                                   GROUP BY last_error ORDER BY n DESC LIMIT 1`).get() as { last_error?: string } | undefined)?.last_error ?? null;
    } catch { /* the count alone */ }
  }
  // created_at is SQLite's datetime('now') — UTC, "YYYY-MM-DD HH:MM:SS"; handed on as ISO.
  const oldest = r?.oldest ? (/T/.test(r.oldest) ? r.oldest : `${r.oldest.replace(' ', 'T')}Z`) : null;
  return { pending: Number(r?.pending ?? 0), failed: Number(r?.failed ?? 0), oldestPendingAt: oldest, failedReason };
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
      // A501: device_id = ? (an origin always has an id) — the (device_id, seq) index, not a scan per origin and table.
      const rows = db.prepare(distributionSql(table)).all(origin, after, budget + 1) as any[];
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
 * applyPeerRows under its ORIGIN's identity.
 *
 * F1 (2026-10-14): a row this till cannot apply is refused ALONE — recorded (maintenance_state
 * `distribution_refused:<origin>:<table>:<id>`, and the log) — and the origin's cursor moves past it. It used to stop
 * at the row and ask again from there, so one bad row stalled that till's whole table here for good.
 * Never relays: forwarding a sale to the cloud is the branch server's job (and the sale's own till's).
 */
export function applyDistribution(
  batches: Array<{ device_id: string; table: string; rows: any[] }>,
): { applied: number; duplicate: number; rejected: number } {
  const totals = { applied: 0, duplicate: 0, rejected: 0 };
  const db = getLocalDb();
  for (const b of batches) {
    if (!isReplicatedTable(b.table)) continue;   // a newer node's table this build doesn't know
    const r = applyPeerRows(b.table, b.device_id, b.rows ?? [], { relay: false, advancePastFailures: true });
    // A501: the cursor still moves past a refused row (it never stalls the table) — and the row is kept to try again.
    if (r.rejected.length) {
      const byId = new Map((b.rows ?? []).filter((x: any) => x?.id).map((x: any) => [String(x.id), x]));
      for (const x of r.rejected) {
        const row = byId.get(String(x.id));
        if (row) { try { quarantinePeerRow(b.device_id, b.table, row, x.reason); } catch { /* the log has it */ } }
      }
    }
    totals.applied += r.applied;
    totals.duplicate += r.duplicate;
    totals.rejected += r.rejected.length;
    if (r.rejected.length) {
      const now = new Date().toISOString();
      const note = db.prepare(`INSERT OR REPLACE INTO maintenance_state (key, value, updated_at) VALUES (?, ?, ?)`);
      for (const x of r.rejected) {
        try { note.run(`distribution_refused:${b.device_id}:${b.table}:${x.id}`, String(x.reason).slice(0, 300), now); } catch { /* the log has it */ }
      }
      logLine('node', `distribution: refused ${r.rejected.length} ${b.table} row(s) from ${String(b.device_id).slice(0, 8)} `
        + `and moved on — first: ${r.rejected[0].id} (${String(r.rejected[0].reason).slice(0, 160)})`);
    }
    if (r.cursor > getCursor(b.device_id, b.table)) {
      advanceCursor(b.device_id, b.table, r.cursor);
    }
  }
  // Same rule as the node's ingest: every pull round ends with an event sweep.
  applyPendingEvents();
  // A501: then the rows refused only for their order (a new day ahead of the event closing the last one) — at once,
  // this pass, for the rows refused just now; the rest when their backoff is due.
  const fresh = retryFreshQuarantine();
  totals.applied += fresh;
  retryPeerQuarantine();
  return totals;
}

/** A501: the rows quarantined in this very pass (no attempt made yet) are tried once after the event sweep. */
function retryFreshQuarantine(): number {
  try {
    ensureQuarantine();
    const db = getLocalDb();
    const fresh = db.prepare(`SELECT COUNT(*) n FROM peer_quarantine WHERE status = 'waiting' AND attempts = 0`).get() as { n: number };
    if (!fresh.n) return 0;
    db.prepare(`UPDATE peer_quarantine SET next_at = ? WHERE status = 'waiting' AND attempts = 0`).run(new Date(0).toISOString());
    return retryPeerQuarantine().applied;
  } catch { return 0; }
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
  // A364: a shift opened after today's cash-up reopens the day (dayService.reopenDay).
  day_reopened: {
    table: 'business_days',
    columns: ['status', 'closed_at', 'closed_by', 'counted_cash',
              'expected_cash', 'cash_variance', 'notes'],
  },
  order_voided: {
    table: 'orders',
    columns: ['status', 'void_reason', 'voided_at', 'voided_by'],
  },
  // F8 (2026-10-14): a refund on a sale that already crossed. Rows are append-only, so without this every other till
  // and the branch server kept the sale at full value. The refund legs (payments, status 'refunded', negative amounts)
  // ride along as `payments` and are inserted — additively, by their own ids — only once the order update landed.
  order_refunded: {
    table: 'orders',
    columns: ['refunded_at', 'refunded_amount', 'refund_reason'],
  },
};

/** F8: what an `order_refunded` event may carry besides its columns — the refund legs, by their own ids. */
const REFUND_PAYMENT_COLUMNS = ['id', 'method', 'amount', 'reference', 'status', 'created_at'];

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
  // business_id lives on the till session, not device config — same source
  // the order-create path uses.
  const sess = db.prepare(`SELECT business_id FROM session WHERE id = 1`).get() as { business_id?: string } | undefined;
  const clean: Record<string, unknown> = {};
  for (const c of spec.columns) if (c in payload) clean[c] = payload[c];
  if (kind === 'order_refunded' && Array.isArray(payload.payments)) {
    clean.payments = (payload.payments as any[]).map((p) => Object.fromEntries(REFUND_PAYMENT_COLUMNS.map((c) => [c, p?.[c] ?? null])));
  }
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
  const refuse = (id: string, kind: string, reason: string) => {
    try { markRefused.run(id); } catch { /* the next sweep */ }
    out.refused++;
    logLine('node', `event ${id} (${kind}) refused: ${reason.slice(0, 200)}`);
  };

  for (const ev of pending) {
    // F13 (2026-10-14): every event on its own. A value SQLite cannot bind (an object, say) used to throw out of the
    // sweep — and the sweep runs inside every /node/sync, so ONE bad event answered every till's push with a 500.
    try {
      const spec = EVENT_WHITELIST[ev.kind];
      // An event kind (or a retargeted table) this build does not know is left
      // waiting, not guessed at: a newer till emitted it, and this till will
      // understand it after its own upgrade.
      if (!spec || spec.table !== ev.target_table) { out.waiting++; continue; }

      let payload: Record<string, unknown>;
      try { payload = JSON.parse(ev.payload) ?? {}; } catch { refuse(ev.id, ev.kind, 'payload is not JSON'); continue; }
      if (typeof payload !== 'object' || Array.isArray(payload)) { refuse(ev.id, ev.kind, 'payload is not an object'); continue; }
      const cols = spec.columns.filter(c => c in payload);
      const bad = cols.find(c => payload[c] !== null && typeof payload[c] === 'object');
      if (bad) { refuse(ev.id, ev.kind, `${bad} is not a plain value`); continue; }
      if (!cols.length) { markApplied.run(ev.id); out.applied++; continue; }  // nothing to do IS done

      let changed = 0;
      db.transaction(() => {
        changed = db.prepare(
          // branch-wide: mutates the ORIGIN's replica row by design; the device_id
          // equality IS the origin-only rule.
          `UPDATE ${spec.table} SET ${cols.map(c => `${c} = ?`).join(', ')}
            WHERE id = ? AND COALESCE(device_id,'') = COALESCE(?,'')`,
        ).run(...cols.map(c => payload[c] ?? null), ev.target_id, ev.device_id).changes;
        // F8: the refund legs, once the origin-owned order took the refund. Additive by id, stamped 'peer' like every
        // replicated payment, so no push path on this device ever picks them up.
        if (changed > 0 && ev.kind === 'order_refunded' && Array.isArray(payload.payments)) {
          const ins = db.prepare(`INSERT OR IGNORE INTO payments (id, order_id, method, amount, amount_tendered, change_given, reference, status, created_at, sync_status)
                                  VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?, '${PEER_SYNC_STATUS}')`);
          for (const p of payload.payments as any[]) {
            if (!p?.id) continue;
            ins.run(String(p.id), ev.target_id, String(p.method ?? 'cash'), Number(p.amount) || 0, p.reference == null ? null : String(p.reference),
              String(p.status ?? 'refunded'), String(p.created_at ?? new Date().toISOString()));
          }
        }
      })();

      if (changed > 0) { markApplied.run(ev.id); out.applied++; continue; }

      const holder = db.prepare(
        // branch-wide: existence probe to tell "not here yet" from "owned by
        // someone else" — the first waits, the second is refused.
        `SELECT device_id FROM ${spec.table} WHERE id = ?`,
      ).get(ev.target_id) as { device_id: string | null } | undefined;
      if (!holder) { out.waiting++; continue; }
      refuse(ev.id, ev.kind, 'the target row belongs to another device');
    } catch (err: any) {
      refuse(ev.id, ev.kind, String(err?.message ?? err));
    }
  }
  return out;
}

/**
 * F8: turn this device's refunds into `order_refunded` events — once each. Scanned rather than emitted at each refund
 * site (the online refund, the offline one, a refund made on the web of a sale rung here), for the same reason the
 * outbox is scanned: a path that depends on every site remembering a second call is one that silently misses rows.
 * Returns how many were emitted.
 */
export function emitRefundEvents(limit = 200): number {
  const db = getLocalDb();
  const own = getDeviceConfig()?.device_id ?? null;
  const rows = db.prepare(
    // own: only this terminal's sales are its to report refunded; a web sale downloaded here (origin) is the cloud's.
    `SELECT o.id, o.refunded_at, o.refunded_amount, o.refund_reason FROM orders o
      WHERE o.refunded_at IS NOT NULL AND o.origin IS NULL AND COALESCE(o.device_id,'') = COALESCE(?,'')
        AND NOT EXISTS (SELECT 1 FROM events e WHERE e.kind = 'order_refunded' AND e.target_id = o.id)
      ORDER BY o.refunded_at LIMIT ?`,
  ).all(own, limit) as Array<{ id: string; refunded_at: string; refunded_amount: number | null; refund_reason: string | null }>;
  if (!rows.length) return 0;
  // branch-wide: keyed by order_id to the own-scoped order above (a payment has no device of its own).
  const legs = db.prepare(`SELECT id, method, amount, reference, status, created_at FROM payments WHERE order_id = ? AND status = 'refunded'`);
  db.transaction(() => {
    for (const r of rows) {
      emitEvent('order_refunded', r.id, {
        refunded_at: r.refunded_at, refunded_amount: Number(r.refunded_amount) || 0, refund_reason: r.refund_reason ?? null,
        payments: legs.all(r.id),
      });
    }
  })();
  return rows.length;
}
