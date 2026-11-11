/**
 * tillBuffer.ts — Till stage 2 (docs/ANDROID-APP-DESIGN.md §4.7, §4.8): the rules for a Shop POS that KEEPS SELLING
 * OFFLINE. Store-and-forward (Tier 1): the tablet's database is a BUFFER, not a mirror — it queues the writes a cashier
 * makes offline and replays them, in order, when the connection returns. Pure TypeScript, no IO, no native deps, so the
 * cloud, the desktop POS and the Android Shop POS can all share and test it (one rule, both POS — the owner's standing
 * rule). The Android app wraps these with an IndexedDB buffer and the online write client it already uses.
 *
 * Owner decisions this encodes:
 *   - "cloud should never block a till from working … offline supersedes online"; a sale is a fact — replay, never drop.
 *   - deltas, not totals, for stock (an oversell is reported as a variance, never un-sold).
 *   - "never trust the tablet's clock" for who-was-first across tills — a row's createdAt orders rows on THIS tablet only
 *     (its own creation order); contested state is decided by the SERVER (which wins the table), and the sale is kept.
 *
 * The buffer holds captured WRITE REQUESTS — the very call the online POS makes (method, path, body). Replaying a row is
 * re-issuing its call; the server dedupes by idempotency_key (orders.idempotency_key — the order's own uuid), so a replay
 * is idempotent and a sale is never counted twice. A void or refund carries the uuid of the ORDER it acts on, so it is
 * ordered after that order and sent in the same batch (§4.7: "the server accepts it in the same batch as its order").
 *
 * §4.8 — two independent clocks for retention:
 *   - UNSENT data is kept until the server acknowledges it, however old. Never removed by age.
 *   - SENT data is kept RETENTION_SENT_MS (30 days, a setting) for reprints and this tablet's own report, then removed —
 *     it lives on the server. Remove ONLY rows that are sent AND older than the window.
 */

// ── the buffered write ───────────────────────────────────────────────────────────────────────────────────────────────

/** What a buffered write is about (§4.7's buffer list). Order lines ride inside the 'order' body; they are not their own
 *  kind. 'shift_event' is a shift opening/closing/drawer movement. 'order_op' is a non-financial change to an OPEN order —
 *  moving it to another table, firing a held course to the kitchen — each idempotent, so a replay is safe. */
export type BufferKind = 'order' | 'payment' | 'void' | 'refund' | 'expense' | 'wastage' | 'shift_event' | 'order_op';
export const BUFFER_KINDS: readonly BufferKind[] = ['order', 'payment', 'void', 'refund', 'expense', 'wastage', 'shift_event', 'order_op'];

export type SyncState = 'pending' | 'syncing' | 'synced' | 'failed';

/** A captured write waiting to reach the cloud. */
export interface BufferRow {
  /** The tablet's own id for this queue row (a uuid it minted). */
  id: string;
  /** A monotonic creation sequence on THIS tablet — the replay order (§4.7 "in creation order"). Ties on createdAt are
   *  broken by seq, so the queue is total and stable even within the same millisecond. */
  seq: number;
  kind: BufferKind;
  /** The business entity's uuid: for an 'order' its own uuid; for a 'payment'/'void'/'refund' the ORDER uuid it belongs
   *  to (so it orders after and batches with that order). Also the idempotency key the server dedupes on. */
  orderUuid: string;
  /** The tablet clock when it was rung up. Shown to the cashier and used to order rows on THIS tablet only — NEVER
   *  trusted for who-was-first across tills (§4.7: that is the server's call, anchored to server time). */
  createdAt: string;
  /** The exact online call to replay: method, cloud-relative path, body. */
  req: BufferRequest;
  state: SyncState;
  /** How many times a replay has been attempted; MAX_TRIES then 'failed' (kept, surfaced to a manager — never dropped). */
  tries: number;
  /** Set when the server acknowledged the row — the retention clock (§4.8) starts here. */
  syncedAt?: string | null;
}

export interface BufferRequest { method: string; path: string; body: unknown }

export const RETENTION_SENT_MS = 30 * 24 * 60 * 60 * 1000;  // §4.8: sent rows kept 30 days (a setting), then removed
export const BATCH_MAX = 200;                                // rows per replay batch (the server also caps; halve on 413)
export const MAX_TRIES = 5;                                  // a row that keeps failing is parked 'failed', never dropped

// ── what may be taken offline ────────────────────────────────────────────────────────────────────────────────────────

/** The write paths a Shop POS may take offline, newest-POS write set (§4.7). A path not here is NOT buffered: offline it
 *  is refused so nothing silently vanishes (the caller shows "Needs connection"). Matched on the cloud-relative path with
 *  its leading /api stripped and the query dropped. Kept deliberately small and explicit. */
interface WriteRoute { kind: BufferKind; re: RegExp }
const WRITE_ROUTES: readonly WriteRoute[] = [
  { kind: 'void',        re: /^\/orders\/[^/]+\/void$/ },
  { kind: 'refund',      re: /^\/orders\/[^/]+\/refund$/ },
  { kind: 'payment',     re: /^\/orders\/[^/]+\/(pay|payments?)$/ },
  { kind: 'order',       re: /^\/orders$/ },
  { kind: 'expense',     re: /^\/expenses$/ },
  { kind: 'wastage',     re: /^\/wastage(-entries)?$/ },
  { kind: 'shift_event', re: /^\/shifts(\/[^/]+)?(\/(open|close|drawer|movement))?$/ },
  // A restaurant keeps serving during an outage: move an open table order, fire a held course to the kitchen. Both act on
  // an order the till already made (its own uuid in the path) and are idempotent on the server — move-table sets the
  // table (last write wins), fire-course only fires still-'held' items (a replay finds none) — so they replay safely in
  // seq order, after the order they belong to. The server resolves the till's order uuid (routes/orders.ts cloudOrderId).
  { kind: 'order_op',    re: /^\/orders\/[^/]+\/move-table$/ },
  { kind: 'order_op',    re: /^\/orders\/[^/]+\/fire-course$/ },
];

/** Normalise a cloud-relative path for matching: drop the query, a trailing slash and a leading /api. */
export function normalisePath(path: string): string {
  let p = String(path || '').split('?')[0].split('#')[0];
  if (p.startsWith('/api/')) p = p.slice(4);
  else if (p === '/api') p = '/';
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p || '/';
}

/** The kind of a write, or null when it is a read or a write a Shop POS must not take offline. Only POST/PUT/PATCH are
 *  writes; GET/HEAD are reads (never buffered); DELETE offline is refused (a hard delete is not store-and-forward). */
export function bufferableKind(method: string, path: string): BufferKind | null {
  const m = String(method || '').toUpperCase();
  if (m !== 'POST' && m !== 'PUT' && m !== 'PATCH') return null;
  const p = normalisePath(path);
  for (const r of WRITE_ROUTES) if (r.re.test(p)) return r.kind;
  return null;
}

/** The ORDER uuid a write belongs to: an order's own uuid, else the :id in /orders/:id/… . For a non-order write with no
 *  order in its path (an expense, wastage, a shift event) it is the body's own uuid/id — its idempotency key. */
export function orderUuidOf(_kind: BufferKind, path: string, body: unknown): string | null {
  const p = normalisePath(path);
  const inPath = p.match(/^\/orders\/([^/]+)\//);
  if (inPath) return inPath[1];
  const b = (body && typeof body === 'object' ? body as Record<string, unknown> : {});
  const own = b.idempotency_key ?? b.uuid ?? b.id ?? b.client_uuid;
  return typeof own === 'string' && own ? own : null;
}

/** Ensure a bufferable body carries an idempotency_key, so a replay cannot double-count. Returns a new body; never
 *  mutates. An order with no key gets `uuid` (which must be the order's own uuid). */
export function withIdempotencyKey(body: unknown, uuid: string): Record<string, unknown> {
  const b = (body && typeof body === 'object' ? { ...(body as Record<string, unknown>) } : {} as Record<string, unknown>);
  if (!b.idempotency_key) b.idempotency_key = uuid;
  return b;
}

// ── the queue: order, batch, retry ───────────────────────────────────────────────────────────────────────────────────

/** Total order over the queue: creation order on this tablet (seq), stable and independent of the wall clock. */
export function compareRows(a: BufferRow, b: BufferRow): number {
  return a.seq - b.seq || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Rows still to send (not synced, not parked after MAX_TRIES), in creation order. */
export function pendingRows(rows: readonly BufferRow[]): BufferRow[] {
  return rows.filter((r) => r.state !== 'synced' && !(r.state === 'failed' && r.tries >= MAX_TRIES)).slice().sort(compareRows);
}

/** The next batch to replay (§4.7 step 3): the oldest pending rows, in creation order, up to `max`. A void/refund/payment
 *  for an order is kept WITH that order — the batch never ends between an order and a later row that acts on it, and a
 *  dependent row is never sent before its order (so the server sees the order first, then accepts the void in the same
 *  batch). If a single order's own group is larger than `max`, the whole group still goes (a sale is never split). */
export function nextBatch(rows: readonly BufferRow[], max: number = BATCH_MAX): BufferRow[] {
  const pend = pendingRows(rows);
  if (pend.length === 0) return [];
  const out: BufferRow[] = [];
  let i = 0;
  while (i < pend.length) {
    // Take one whole order-group: the run of consecutive pending rows sharing this orderUuid is small, but a group is
    // defined by orderUuid across the queue, so collect every pending row of this order that is not already taken.
    const groupKey = pend[i].orderUuid;
    const group = pend.filter((r) => r.orderUuid === groupKey && !out.includes(r));
    if (out.length > 0 && out.length + group.length > max) break;   // would overflow: stop at a group boundary
    for (const r of group) out.push(r);
    // advance past every row of this group
    while (i < pend.length && (pend[i].orderUuid === groupKey || out.includes(pend[i]))) i++;
    if (out.length >= max) break;
  }
  return out.sort(compareRows);
}

/** The server's word on one replayed row. `ok` means accepted (idempotent upsert); `conflict` carries a contested
 *  linkage to ask a person about; `retry` means try again later (transport/5xx); `failed` means a permanent refusal. */
export interface Ack {
  orderUuid: string;
  /** The row id, when the server echoes it; else matched by orderUuid + kind. */
  id?: string;
  result: 'ok' | 'conflict' | 'retry' | 'failed';
  at?: string | null;        // server time of acknowledgement (the retention clock)
  conflict?: Conflict | null;
}

/** Apply the server's acks to the queue (§4.7 step 5). Pure: returns a NEW rows array.
 *   ok      → 'synced', syncedAt = ack.at ?? now (idempotent: a re-ack of a synced row is a no-op).
 *   conflict→ 'synced' for the sale itself (it is kept, never lost) — the conflict is surfaced separately to be asked.
 *   retry   → stays 'pending', tries+1 (parked 'failed' once tries reach MAX_TRIES).
 *   failed  → 'failed' at once (a permanent refusal; kept and surfaced, never dropped). */
export function applyAcks(rows: readonly BufferRow[], acks: readonly Ack[], now: string): BufferRow[] {
  const byId = new Map<string, Ack>();
  const byOrder = new Map<string, Ack>();
  for (const a of acks) { if (a.id) byId.set(a.id, a); byOrder.set(`${a.orderUuid}:${a.result}`, a); byOrder.set(a.orderUuid, a); }
  return rows.map((r) => {
    const a = (r.id && byId.get(r.id)) || byOrder.get(r.orderUuid);
    if (!a) return r;
    switch (a.result) {
      case 'ok':
      case 'conflict':
        return r.state === 'synced' ? r : { ...r, state: 'synced' as SyncState, syncedAt: a.at ?? now };
      case 'retry': {
        const tries = r.tries + 1;
        return { ...r, state: (tries >= MAX_TRIES ? 'failed' : 'pending') as SyncState, tries };
      }
      case 'failed':
        return { ...r, state: 'failed' as SyncState, tries: Math.max(r.tries + 1, MAX_TRIES) };
      default:
        return r;
    }
  });
}

// ── conflicts (§4.7) ─────────────────────────────────────────────────────────────────────────────────────────────────

/** The only conflicts store-and-forward can meet. A paid sale, a held order, a void/refund are never conflicts — they are
 *  facts the server upserts. A dine-in table taken while offline is the one real one: the server wins the table, the
 *  tablet keeps the order, and a person is asked to move it. A stock oversell is a soft conflict: reported as a variance,
 *  the sale is never un-sold. */
export type ConflictKind = 'table_taken' | 'stock_variance';
export interface Conflict {
  kind: ConflictKind;
  orderUuid: string;
  /** For table_taken: the order's number to show, and the table now taken. */
  orderNumber?: string | number | null;
  table?: string | null;
  /** For stock_variance: the item and by how much it went below zero on the server. */
  item?: string | null;
  shortBy?: number | null;
}

/** The question to put to a person for a table_taken conflict (§4.7: "Order #3012 was on Table 5, now taken — move it?").
 *  A stock_variance is informational — no question, shown to a manager as a variance. */
export function conflictPrompt(c: Conflict): string | null {
  if (c.kind !== 'table_taken') return null;
  const n = c.orderNumber == null ? '' : `#${c.orderNumber} `;
  const t = c.table ? `Table ${c.table}` : 'its table';
  return `Order ${n}was on ${t}, now taken — move it?`;
}

/** Collect the conflicts to ask about from a set of acks, in queue order of their orders. */
export function conflictsToAsk(acks: readonly Ack[]): Conflict[] {
  const out: Conflict[] = [];
  for (const a of acks) if (a.result === 'conflict' && a.conflict) out.push(a.conflict);
  return out;
}

// ── retention (§4.8) ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Split the buffer into what to keep and what to remove (§4.8). Remove ONLY rows that are BOTH synced AND older than the
 *  window; unsent rows (pending/syncing/failed) are kept however old. Pure: the caller deletes `remove` from its store. */
export function partitionForRetention(
  rows: readonly BufferRow[],
  now: string,
  sentWindowMs: number = RETENTION_SENT_MS,
): { keep: BufferRow[]; remove: BufferRow[] } {
  const cutoff = Date.parse(now) - sentWindowMs;
  const keep: BufferRow[] = [];
  const remove: BufferRow[] = [];
  for (const r of rows) {
    const sent = r.state === 'synced' && !!r.syncedAt;
    const old = sent && Date.parse(r.syncedAt as string) <= cutoff;
    (sent && old ? remove : keep).push(r);
  }
  return { keep, remove };
}

/** May a synced receipt still be reprinted offline? (§4.8: not once it is older than the window — it lives on the server.) */
export function canReprintOffline(row: BufferRow, now: string, sentWindowMs: number = RETENTION_SENT_MS): boolean {
  if (row.state !== 'synced' || !row.syncedAt) return true;   // unsent: always on this tablet
  return Date.parse(row.syncedAt) > Date.parse(now) - sentWindowMs;
}

// ── status bar (§4.7 / Till stage 2) ─────────────────────────────────────────────────────────────────────────────────

export interface BufferStatus {
  online: boolean;
  /** Sales still to reach the cloud (pending order rows). */
  salesWaiting: number;
  /** Rows parked after MAX_TRIES — a manager must see these. */
  stuck: number;
  /** The oldest pending row's createdAt, or null when the queue is empty. */
  oldestPending: string | null;
  /** The newest syncedAt seen, or null — "last synced HH:MM". */
  lastSynced: string | null;
}

export function bufferStatus(rows: readonly BufferRow[], online: boolean): BufferStatus {
  let salesWaiting = 0, stuck = 0;
  let oldest: string | null = null, last: string | null = null;
  for (const r of rows) {
    const parked = r.state === 'failed' && r.tries >= MAX_TRIES;   // a refusal, surfaced to a manager — not "waiting"
    const queued = r.state !== 'synced' && !parked;                // still goes automatically
    if (parked) stuck++;
    if (queued) {
      if (r.kind === 'order') salesWaiting++;
      if (oldest === null || Date.parse(r.createdAt) < Date.parse(oldest)) oldest = r.createdAt;
    }
    if (r.state === 'synced' && r.syncedAt) {
      if (!last || Date.parse(r.syncedAt) > Date.parse(last)) last = r.syncedAt;
    }
  }
  return { online, salesWaiting, stuck, oldestPending: oldest, lastSynced: last };
}
