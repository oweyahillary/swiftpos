/**
 * buffer.ts — Till stage 2 (docs/ANDROID-APP-DESIGN.md §4.7, §4.8): the Shop POS's offline BUFFER. The rules are the one
 * shared module @zaptill/core/tillBuffer; this wraps them with somewhere to keep the rows on the tablet.
 *
 * The buffer holds captured WRITE REQUESTS a cashier made offline (the exact call the online POS makes). `enqueue` is
 * called by the offline-writes seam (shop/offlineWrites.ts) when there is no connection; shop/replay.ts drains it when the
 * connection returns and marks each row with the cloud's answer. §4.8 retention is a sweep the app runs on a timer.
 *
 * Two stores: IndexedDbBuffer for the tablet (survives a kill or a reboot — §4.7's "kill the app while offline, nothing
 * lost"), and InMemoryBuffer for tests and as a safe fallback where IndexedDB is blocked. Both satisfy BufferStore, so the
 * ops below — and every test — work the same against either.
 */
import {
  type BufferRow, type BufferRequest, type Ack, type BufferStatus, type SyncState,
  applyAcks as coreApplyAcks, partitionForRetention, bufferStatus,
  bufferableKind, orderUuidOf, withIdempotencyKey, RETENTION_SENT_MS,
} from '@zaptill/core/tillBuffer';

/** Where buffered rows live. Small and async so IndexedDB and an in-memory map satisfy it the same way. */
export interface BufferStore {
  all(): Promise<BufferRow[]>;
  put(row: BufferRow): Promise<void>;
  putMany(rows: readonly BufferRow[]): Promise<void>;
  remove(ids: readonly string[]): Promise<void>;
  clear(): Promise<void>;
}

const nowIso = () => new Date().toISOString();
const uuid = () => (globalThis.crypto?.randomUUID?.() ?? `id-${Date.now()}-${Math.random().toString(16).slice(2)}`);

/**
 * Queue a captured write (offline). Returns the stored row, or null when the write may NOT be taken offline — the caller
 * then refuses it ("Needs connection"), so nothing a Shop POS cannot replay silently vanishes (§4.7).
 */
export async function enqueue(store: BufferStore, req: BufferRequest, at: string = nowIso()): Promise<BufferRow | null> {
  const kind = bufferableKind(req.method, req.path);
  if (!kind) return null;
  const orderUuid = orderUuidOf(kind, req.path, req.body);
  if (!orderUuid) return null;                                   // no id to dedupe on → refuse, never guess
  const body = withIdempotencyKey(req.body, orderUuid);
  const rows = await store.all();
  const seq = rows.reduce((m, r) => Math.max(m, r.seq), 0) + 1; // monotonic creation order on THIS tablet
  const row: BufferRow = {
    id: uuid(), seq, kind, orderUuid, createdAt: at,
    req: { method: req.method, path: req.path, body }, state: 'pending', tries: 0, syncedAt: null,
  };
  await store.put(row);
  return row;
}

/** Mark rows a given state (replay sets 'syncing' before it sends, so the status bar shows the push in flight). */
export async function setState(store: BufferStore, ids: readonly string[], state: SyncState): Promise<void> {
  const want = new Set(ids);
  const next = (await store.all()).filter((r) => want.has(r.id)).map((r) => ({ ...r, state }));
  if (next.length) await store.putMany(next);
}

/** Apply the cloud's acks to the queue (§4.7 step 5) and persist. Returns the new rows. */
export async function recordAcks(store: BufferStore, acks: readonly Ack[], at: string = nowIso()): Promise<BufferRow[]> {
  const next = coreApplyAcks(await store.all(), acks, at);
  await store.putMany(next);
  return next;
}

/** §4.8 sweep: remove only rows that are sent AND older than the window; keep everything unsent. Returns how many went. */
export async function sweepRetention(store: BufferStore, at: string = nowIso(), windowMs: number = RETENTION_SENT_MS): Promise<number> {
  const { remove } = partitionForRetention(await store.all(), at, windowMs);
  if (remove.length) await store.remove(remove.map((r) => r.id));
  return remove.length;
}

/** The status bar's numbers (online/offline, sales waiting, stuck, last synced). */
export async function status(store: BufferStore, online: boolean): Promise<BufferStatus> {
  return bufferStatus(await store.all(), online);
}

// ── in-memory (tests and fallback) ───────────────────────────────────────────────────────────────────────────────────

export class InMemoryBuffer implements BufferStore {
  private rows = new Map<string, BufferRow>();
  async all(): Promise<BufferRow[]> { return [...this.rows.values()]; }
  async put(row: BufferRow): Promise<void> { this.rows.set(row.id, row); }
  async putMany(rows: readonly BufferRow[]): Promise<void> { for (const r of rows) this.rows.set(r.id, r); }
  async remove(ids: readonly string[]): Promise<void> { for (const id of ids) this.rows.delete(id); }
  async clear(): Promise<void> { this.rows.clear(); }
}

// ── IndexedDB (the tablet) ───────────────────────────────────────────────────────────────────────────────────────────

const DB_NAME = 'zaptill-till-buffer';
const STORE = 'rows';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => { const db = req.result; if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' }); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
  });
}

function tx<T>(db: IDBDatabase, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const r = run(t.objectStore(STORE));
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB request failed'));
  });
}

/** The tablet's durable buffer. Survives a kill, a crash and a reboot (§4.7: "nothing lost"). */
export class IndexedDbBuffer implements BufferStore {
  private db: IDBDatabase | null = null;
  private async handle(): Promise<IDBDatabase> { return (this.db ??= await openDb()); }
  async all(): Promise<BufferRow[]> { return tx(await this.handle(), 'readonly', (s) => s.getAll() as IDBRequest<BufferRow[]>); }
  async put(row: BufferRow): Promise<void> { await tx(await this.handle(), 'readwrite', (s) => s.put(row)); }
  async putMany(rows: readonly BufferRow[]): Promise<void> {
    const db = await this.handle();
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction(STORE, 'readwrite'); const s = t.objectStore(STORE);
      for (const r of rows) s.put(r);
      t.oncomplete = () => resolve(); t.onerror = () => reject(t.error ?? new Error('IndexedDB write failed'));
    });
  }
  async remove(ids: readonly string[]): Promise<void> {
    const db = await this.handle();
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction(STORE, 'readwrite'); const s = t.objectStore(STORE);
      for (const id of ids) s.delete(id);
      t.oncomplete = () => resolve(); t.onerror = () => reject(t.error ?? new Error('IndexedDB delete failed'));
    });
  }
  async clear(): Promise<void> { await tx(await this.handle(), 'readwrite', (s) => s.clear()); }
}

/** The buffer to use: IndexedDB when it is there, else in-memory (a private window, or storage blocked). */
export function makeBuffer(): BufferStore {
  try { if (typeof indexedDB !== 'undefined') return new IndexedDbBuffer(); } catch { /* fall through */ }
  return new InMemoryBuffer();
}
