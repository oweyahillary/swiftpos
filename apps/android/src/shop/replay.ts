/**
 * replay.ts — Till stage 2 (docs/ANDROID-APP-DESIGN.md §4.7): drain the offline buffer when the connection returns.
 *
 * §4.7 reconnect: (3) push the queue IN CREATION ORDER, idempotent by the order uuid; (4) resolve automatically, asking a
 * person only where a sale's LINKAGE is contested (a dine-in table taken); (5) mark acknowledged rows synced. A sale is a
 * fact — a transport failure (no answer, 5xx, a session to renew) is a retry, never a drop; a permanent refusal (a 4xx
 * that is not 401) parks the row 'failed', kept and surfaced to a manager.
 *
 * The loop is pure orchestration over a BufferStore and an injected Sender, so a test drives it with an in-memory buffer
 * and a fake sender; cloudSender re-issues a captured call through the app's own cloud client (CapacitorHttp).
 */
import { type BufferRow, type Ack, type Conflict, nextBatch, pendingRows, conflictsToAsk, MAX_TRIES } from '@zaptill/core/tillBuffer';
import { API_URL } from '../config';
import { type BufferStore, recordAcks, setState } from './buffer';

/** The cloud URL for a captured path (the path already includes /api, as the web POS fetch used). */
function cloudUrl(path: string): string {
  const p = path.startsWith('/api') ? path : `/api${path.startsWith('/') ? '' : '/'}${path}`;
  return `${API_URL}${p}`;
}

/** Re-issue one captured write and say what the cloud did with it. Must never throw — a thrown error is a retry. */
export type Sender = (row: BufferRow) => Promise<Ack>;

export interface ReplayResult {
  attempted: number;
  synced: number;
  conflicts: Conflict[];
  stuck: number;        // rows parked 'failed' at MAX_TRIES (a manager must see these)
}

const nowIso = () => new Date().toISOString();

/**
 * Push the buffer until it is empty or it stops making progress (transport down, or every remaining row only retries).
 * Returns what was sent and the table-taken questions to put to a person. Safe to call again at any time.
 */
export async function runReplay(store: BufferStore, send: Sender, at: string = nowIso()): Promise<ReplayResult> {
  let attempted = 0, synced = 0;
  const conflicts: Conflict[] = [];
  for (let guard = 0; guard < 10_000; guard++) {
    const rows = await store.all();
    const batch = nextBatch(rows);
    if (batch.length === 0) break;
    const before = pendingRows(rows).length;

    await setState(store, batch.map((r) => r.id), 'syncing');
    const acks: Ack[] = [];
    for (const row of batch) {
      attempted++;
      try { acks.push(await send(row)); }
      catch { acks.push({ orderUuid: row.orderUuid, id: row.id, result: 'retry' }); }
    }
    const next = await recordAcks(store, acks, at);
    for (const c of conflictsToAsk(acks)) conflicts.push(c);
    synced += acks.filter((a) => a.result === 'ok' || a.result === 'conflict').length;

    if (pendingRows(next).length >= before) break;   // no progress — stop, try again on the next reconnect
  }
  const finalRows = await store.all();
  const stuck = finalRows.filter((r) => r.state === 'failed' && r.tries >= MAX_TRIES).length;
  return { attempted, synced, conflicts, stuck };
}

/**
 * Map a cloud HTTP outcome to an ack. Pure, so it is tested directly:
 *   2xx                         → ok (idempotent upsert; a replay of a synced order is a no-op server-side)
 *   0 / OFFLINE / 5xx / 408     → retry (transport; the sale is kept and goes next time)
 *   401                         → retry (the POS session must renew first; never a refusal of the sale)
 *   429                         → retry (rate-limited)
 *   other 4xx                   → failed (a permanent refusal — a validation error; parked and surfaced)
 * A future server signal can add 'conflict' here (a dine-in table taken); until then a table clash is detected on the
 * next pull, not in this answer, and the sale is always accepted.
 */
export function ackFromStatus(row: BufferRow, status: number): Ack {
  if (status >= 200 && status < 300) return { orderUuid: row.orderUuid, id: row.id, result: 'ok', at: nowIso() };
  if (status === 0 || status === 408 || status === 401 || status === 429 || status >= 500) return { orderUuid: row.orderUuid, id: row.id, result: 'retry' };
  return { orderUuid: row.orderUuid, id: row.id, result: 'failed' };
}

/**
 * The real sender: re-issue the captured call through CapacitorHttp with the POS's fresh token. `getToken` is
 * tillSession.tillToken (renewed as needed); the x-device-id header names this POS, as the online call did.
 */
export function cloudSender(getToken: () => Promise<{ token: string; deviceId: string }>): Sender {
  return async (row: BufferRow): Promise<Ack> => {
    let status = 0;
    try {
      const { token, deviceId } = await getToken();
      const { CapacitorHttp } = await import('@capacitor/core');
      const res = await CapacitorHttp.request({
        method: row.req.method as 'POST' | 'PUT' | 'PATCH',
        url: cloudUrl(row.req.path),
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'x-device-id': deviceId },
        data: row.req.body, connectTimeout: 15_000, readTimeout: 20_000,
      });
      status = res.status;
    } catch { status = 0; }                 // no answer → retry
    return ackFromStatus(row, status);
  };
}
