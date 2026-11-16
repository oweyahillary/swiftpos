/**
 * branchSync.ts — Till stage 3, Slice B (docs/SCOPE-TILL-STAGE-3.md, docs/BUILD-TILL-STAGE-3B.md): a MINIMAL tablet
 * replication client. A completed sale the Shop POS made is PUSHED to the joined branch server's own store
 * (POST /node/sync), so the server aggregates it for the branch's reports and RELAYS it to the cloud (A19) — the whole
 * branch keeps working, and a tablet's sale reaches the cloud through the server even when the tablet itself has no
 * internet. It reuses the server's existing idempotent ingest (apps/desktop nodeIngest.ts applyPeerRows); it does NOT
 * port the desktop's heavy SQLite seq / cursor / outbox / quarantine machinery onto the tablet.
 *
 * PUSH ONLY. Pulling the whole branch's orders (/node/since) is deferred — the tablet has no local orders store and the
 * web POS reads /api/orders from the cloud, so a branch-wide view is a separate screen, not this slice (see the build
 * sheet). A POS with no branch server joined does nothing here.
 *
 * The source of a sale is the captured cloud `POST /api/orders` body (the web POS's own payload — PaymentModal
 * buildOrderPayload): it carries idempotency_key (the order's uuid), branch_id, order_number, the money fields, items and
 * payments. That body IS the faithful cloud payload the server relays (A19 needs the original, never a reconstructed one
 * — apps/desktop peerRelay.ts), and it carries the figures the branch report shows.
 */
import { Preferences } from '@capacitor/preferences';
import { deviceId } from './tillSession';
import { readServerLink, nodeRequest, type ServerLink, type NodeResponse } from './branchServer';

// ── tablet-side sequence ─────────────────────────────────────────────────────────────────────────────────────────────
// Every /node/sync row needs a per-device monotonic `seq` the server checkpoints against (nodeIngest.applyPeerRows
// refuses a row with none). The tablet keeps one counter — it is the only device under this device_id, so a simple
// persisted integer is enough (no SQLite device_seq table).
const SEQ_KEY = 'zaptill.nodeSeq';
export async function nextNodeSeq(): Promise<number> {
  let current = 0;
  try { const { value } = await Preferences.get({ key: SEQ_KEY }); current = Number(value) || 0; } catch { current = 0; }
  const next = current + 1;
  try { await Preferences.set({ key: SEQ_KEY, value: String(next) }); } catch { /* best-effort — a repeat seq only re-orders */ }
  return next;
}

// ── reshape a captured order body into a /node/sync orders row ────────────────────────────────────────────────────────
export interface OrderSyncCtx {
  deviceId: string;
  seq: number;
  branchId: string | null;
  createdAt: string;
  businessId?: string | null;
  /** The cashier who rang the sale, when known — credited on the A19 relay (else the cloud credits per the relaying
   *  token, the pre-A169 behaviour for relays). The tablet's OWN online push already credits the cashier by its token. */
  cashierId?: string | null;
}

const keep = (v: unknown): unknown => (v === undefined ? null : v);

function categoryName(item: Record<string, any>): string | null {
  const cats = item?.product?.categories;
  if (Array.isArray(cats) && cats.length) { const first = cats[0]; return typeof first === 'string' ? first : (first?.name ?? null); }
  return null;
}

/**
 * Reshape a captured cloud order body into the branch server's replicated orders row (nodeIngest COLUMNS.orders) with
 * its lines (`_items`) and payments (`_payments`) inline, plus `_relayPayload` — the verbatim body the server forwards
 * to the cloud (A19). Pure; null when the body has no id to key on. Money/customer columns come straight from the body
 * (accurate); business_id / cashier_id / covers are not in the body (best-effort, see ctx), and line/payment ids are
 * synthesised stably from the order id so the server's INSERT OR IGNORE de-dupes a re-push.
 */
export function orderRowFromBody(body: Record<string, any>, ctx: OrderSyncCtx): Record<string, unknown> | null {
  const id = typeof body?.idempotency_key === 'string' && body.idempotency_key
    ? body.idempotency_key
    : (typeof body?.uuid === 'string' && body.uuid ? body.uuid : null);
  if (!id) return null;
  const items: any[] = Array.isArray(body?.items) ? body.items : [];
  const payments: any[] = Array.isArray(body?.payments) ? body.payments : [];
  return {
    id,
    business_id: ctx.businessId ?? null,
    branch_id: body?.branch_id ?? ctx.branchId ?? null,
    order_number: keep(body?.order_number),
    order_type: keep(body?.order_type),
    delivery_person: keep(body?.delivery_person),
    status: 'completed',
    subtotal: keep(body?.subtotal),
    vat_amount: keep(body?.vat_amount),
    ctl_amount: keep(body?.ctl_amount),
    discount_amount: keep(body?.discount_amount),
    tip_amount: keep(body?.tip_amount),
    total: keep(body?.total),
    covers: keep(body?.covers),
    cashier_id: ctx.cashierId ?? null,
    shift_id: keep(body?.shift_id),
    customer_id: keep(body?.customer_id),
    customer_name: keep(body?.customer_name),
    customer_phone: keep(body?.customer_phone),
    created_at: ctx.createdAt,
    device_id: ctx.deviceId,
    pump_id: keep(body?.pump_id),
    seq: ctx.seq,
    notes: keep(body?.notes),
    delivery_fee: keep(body?.delivery_fee),
    delivery_free: keep(body?.delivery_free),
    refunded_at: null,
    refunded_amount: null,
    refund_reason: null,
    _items: items.map((it, i) => ({
      id: `${id}-i${i}`, order_id: id,
      product_id: it?.product?.id ?? null, product_name: it?.product?.name ?? null, category_name: categoryName(it),
      unit_price: it?.unitPrice ?? null, quantity: it?.quantity ?? null, subtotal: it?.lineTotal ?? null,
      course: it?.course ?? null, fire_status: it?.fire_status ?? null, notes: it?.notes ?? null,
    })),
    _payments: payments.map((p, i) => ({
      id: `${id}-p${i}`, order_id: id, method: p?.method ?? null, amount: p?.amount ?? null,
      amount_tendered: p?.amount_tendered ?? null, change_given: p?.change_given ?? null,
      reference: p?.reference ?? null, status: 'completed', created_at: ctx.createdAt,
    })),
    // A19: the faithful cloud payload (idempotency_key === id), with the cashier added when known. buildPeerRelay accepts
    // it — it has branch_id, order_number, items and payments, and no device_id to disagree with the row's.
    _relayPayload: { ...body, ...(ctx.cashierId ? { cashier_id: ctx.cashierId } : {}) },
  };
}

// ── the push (/node/sync) ────────────────────────────────────────────────────────────────────────────────────────────
export interface NodeSyncOutcome { ok: boolean; appliedIds: string[]; rejected: Array<{ id: string; reason: string }> }

export interface PushDeps { link?: ServerLink | null; device?: string; request?: typeof nodeRequest }

/**
 * Offer a batch of orders rows to the branch server. `ok:false` means a transport problem (no server, no answer, not
 * 200) — the caller keeps the rows and tries again. `appliedIds` are the ids the server now HOLDS (applied or already
 * held); the caller removes exactly those. Never throws.
 */
export async function pushOrdersToNode(rows: Record<string, unknown>[], deps: PushDeps = {}): Promise<NodeSyncOutcome> {
  if (!rows.length) return { ok: true, appliedIds: [], rejected: [] };
  const link = deps.link !== undefined ? deps.link : await readServerLink();
  if (!link) return { ok: false, appliedIds: [], rejected: [] };
  const device = deps.device ?? await deviceId();
  const request = deps.request ?? nodeRequest;
  const branchId = (rows[0] as Record<string, unknown>)?.branch_id ?? null;
  const bodyStr = JSON.stringify({ device_id: device, branch_id: branchId, tables: { orders: rows } });
  const r: NodeResponse | null = await request(link, 'POST', '/node/sync', bodyStr,
    { 'Content-Type': 'application/json', 'x-device-id': device, 'x-device-token': link.deviceToken }, 15000);
  if (!r || r.status !== 200) return { ok: false, appliedIds: [], rejected: [] };
  let parsed: any = null;
  try { parsed = r.body ? JSON.parse(r.body) : null; } catch { parsed = null; }
  const res = parsed?.results?.orders;
  const appliedIds: string[] = Array.isArray(res?.applied_ids) ? res.applied_ids.filter((x: unknown) => typeof x === 'string') : [];
  const rejected = Array.isArray(res?.rejected)
    ? res.rejected.map((x: any) => ({ id: String(x?.id ?? '?'), reason: String(x?.reason ?? '') }))
    : [];
  return { ok: true, appliedIds, rejected };
}

// ── the outbox (durable, separate from the cloud buffer — "two destinations, their own state", nodeClient.ts) ────────
export interface OutboxRow { id: string; seq: number; row: Record<string, unknown>; tries: number }
export interface NodeOutbox {
  all(): Promise<OutboxRow[]>;
  put(row: OutboxRow): Promise<void>;
  remove(ids: readonly string[]): Promise<void>;
  clear(): Promise<void>;
}

/** A row the server refuses this many times is dropped (it would never be taken — bad shape), so the outbox is bounded.
 *  A sale is never lost from the CLOUD by this: the tablet's own cloud push/buffer is a separate, retained path. */
export const OUTBOX_MAX_TRIES = 8;

export async function enqueueOrderFor(outbox: NodeOutbox, body: Record<string, any>, ctx: Omit<OrderSyncCtx, 'seq'>): Promise<OutboxRow | null> {
  const seq = await nextNodeSeq();
  const row = orderRowFromBody(body, { ...ctx, seq });
  if (!row) return null;
  const out: OutboxRow = { id: row.id as string, seq, row, tries: 0 };
  await outbox.put(out);   // keyed on id — enqueuing the same sale twice is a no-op overwrite
  return out;
}

/**
 * Push the outbox to the branch server, oldest first. Rows the server holds leave the outbox; a row refused is tried
 * again until OUTBOX_MAX_TRIES, then dropped. A transport problem stops the pass (tried again on the next beat). Never
 * throws. Returns what happened.
 */
export async function drainToNode(outbox: NodeOutbox, deps: PushDeps & { batch?: number } = {}): Promise<{ held: number; dropped: number }> {
  let held = 0, dropped = 0;
  try {
    const link = deps.link !== undefined ? deps.link : await readServerLink();
    if (!link) return { held, dropped };
    const rows = (await outbox.all()).sort((a, b) => a.seq - b.seq);
    if (!rows.length) return { held, dropped };
    const device = deps.device ?? await deviceId();
    const batch = deps.batch ?? 100;
    for (let i = 0; i < rows.length; i += batch) {
      const chunk = rows.slice(i, i + batch);
      const outcome = await pushOrdersToNode(chunk.map((r) => r.row), { link, device, request: deps.request });
      if (!outcome.ok) break;   // transport — stop; the next beat tries again
      const heldSet = new Set(outcome.appliedIds);
      const remove: string[] = [];
      const bump: OutboxRow[] = [];
      for (const r of chunk) {
        if (heldSet.has(r.id)) { remove.push(r.id); held++; }
        else {
          const tries = r.tries + 1;
          if (tries >= OUTBOX_MAX_TRIES) { remove.push(r.id); dropped++; } else bump.push({ ...r, tries });
        }
      }
      if (remove.length) await outbox.remove(remove);
      for (const b of bump) await outbox.put(b);
    }
  } catch { /* best-effort */ }
  return { held, dropped };
}

// ── stores ───────────────────────────────────────────────────────────────────────────────────────────────────────────
export class InMemoryNodeOutbox implements NodeOutbox {
  private rows = new Map<string, OutboxRow>();
  async all(): Promise<OutboxRow[]> { return [...this.rows.values()]; }
  async put(row: OutboxRow): Promise<void> { this.rows.set(row.id, row); }
  async remove(ids: readonly string[]): Promise<void> { for (const id of ids) this.rows.delete(id); }
  async clear(): Promise<void> { this.rows.clear(); }
}

const DB_NAME = 'zaptill-node-outbox';
const STORE = 'orders';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => { const db = req.result; if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' }); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
  });
}

/** The tablet's durable node-sync outbox (survives a kill/reboot like the cloud buffer). */
export class IndexedDbNodeOutbox implements NodeOutbox {
  private db: IDBDatabase | null = null;
  private async handle(): Promise<IDBDatabase> { return (this.db ??= await openDb()); }
  async all(): Promise<OutboxRow[]> {
    const db = await this.handle();
    return new Promise((resolve, reject) => {
      const r = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
      r.onsuccess = () => resolve(r.result as OutboxRow[]); r.onerror = () => reject(r.error ?? new Error('read failed'));
    });
  }
  async put(row: OutboxRow): Promise<void> {
    const db = await this.handle();
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction(STORE, 'readwrite'); t.objectStore(STORE).put(row);
      t.oncomplete = () => resolve(); t.onerror = () => reject(t.error ?? new Error('write failed'));
    });
  }
  async remove(ids: readonly string[]): Promise<void> {
    const db = await this.handle();
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction(STORE, 'readwrite'); const s = t.objectStore(STORE);
      for (const id of ids) s.delete(id);
      t.oncomplete = () => resolve(); t.onerror = () => reject(t.error ?? new Error('delete failed'));
    });
  }
  async clear(): Promise<void> {
    const db = await this.handle();
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction(STORE, 'readwrite'); t.objectStore(STORE).clear();
      t.oncomplete = () => resolve(); t.onerror = () => reject(t.error ?? new Error('clear failed'));
    });
  }
}

/** The outbox to use: IndexedDB when it is there, else in-memory (a private window, or storage blocked). */
export function makeNodeOutbox(): NodeOutbox {
  try { if (typeof indexedDB !== 'undefined') return new IndexedDbNodeOutbox(); } catch { /* fall through */ }
  return new InMemoryNodeOutbox();
}
