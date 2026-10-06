/**
 * tillWastage.ts — A414: wastage recorded on the till, saved on the till first and sent to the cloud after.
 *
 * Owner, 2026-10-06: "Recording wastage on the till itself" — decided: "save on till, sync later" (like A411's station
 * routing). A manager on the till writes off what spoiled, expired or was dropped; it is kept on this till at once
 * (maintenance_state `wastage_pending`) and sent to POST /api/wastage now if the cloud can be reached — through the
 * branch server on a till that has one (A410) — else at the next sync.
 *
 *   - Each recording carries its own id (client_id): sent again after a lost answer, the cloud recognises it and does
 *     not record it twice.
 *   - The cloud refusing it (more than the branch holds, an item no longer in the catalogue) ends the wait; the
 *     recording moves to `wastage_refused` with the reason, shown on the till's Wastage screen.
 *   - The person and the time are the till's (recorded_by_name, recorded_at), not the till's sign-in.
 */
import type Database from 'better-sqlite3';

export const PENDING_KEY = 'wastage_pending';
export const REFUSED_KEY = 'wastage_refused';
export const ITEMS_KEY = 'wastage_items_cache';

export interface WasteItem { kind: 'product' | 'ingredient'; id: string; name: string; quantity: number }
export interface WasteRecording {
  client_id: string; branch_id: string; reason: string; note: string;
  items: WasteItem[]; recorded_by_name: string; recorded_at: string;
}
export interface Refused extends WasteRecording { refused_at: string; message: string }

const REASONS = ['expired', 'spoiled', 'damaged', 'kitchen_mistake', 'returned', 'staff_meal', 'other'];

function readJson<T>(db: Database.Database, key: string, fallback: T): T {
  try {
    const row = db.prepare(`SELECT value FROM maintenance_state WHERE key = ?`).get(key) as { value: string } | undefined;
    return row?.value ? JSON.parse(row.value) as T : fallback;
  } catch { return fallback; }
}
function writeJson(db: Database.Database, key: string, value: unknown, empty: boolean): void {
  if (empty) { db.prepare(`DELETE FROM maintenance_state WHERE key = ?`).run(key); return; }
  db.prepare(`INSERT OR REPLACE INTO maintenance_state (key, value, updated_at) VALUES (?, ?, ?)`)
    .run(key, JSON.stringify(value), new Date().toISOString());
}

export const readPending = (db: Database.Database): WasteRecording[] => readJson<WasteRecording[]>(db, PENDING_KEY, []);
export const readRefused = (db: Database.Database): Refused[] => readJson<Refused[]>(db, REFUSED_KEY, []);

/** May this person write off stock? The cloud's own rule: inventory.waste or inventory.adjust (or the owner). */
export function mayWaste(roleName: string | null | undefined, permissionsJson: string | null | undefined): boolean {
  if (['owner', 'admin'].includes(String(roleName ?? '').toLowerCase())) return true;
  let p: Record<string, unknown> = {};
  try { p = JSON.parse(permissionsJson || '{}'); } catch { p = {}; }
  return p['*'] === true || p['inventory.waste'] === true || p['inventory.adjust'] === true;
}

/** What is wrong with a recording before it is kept, or null. The cloud checks again (stock held, the catalogue). */
export function recordingProblem(r: Pick<WasteRecording, 'reason' | 'note' | 'items'>): string | null {
  if (!REASONS.includes(r.reason)) return 'Choose why it was wasted.';
  if (r.reason === 'other' && !String(r.note ?? '').trim()) return 'Say what happened (the reason is "Other").';
  if (!Array.isArray(r.items) || !r.items.length) return 'Add the items wasted.';
  if (r.items.length > 100) return 'At most 100 items at once.';
  for (const i of r.items) {
    if (i.kind !== 'product' && i.kind !== 'ingredient') return 'Each item is a product or an ingredient.';
    if (!(Number(i.quantity) > 0)) return `${i.name}: enter how much.`;
  }
  return null;
}

/** Keep a recording on this till. */
export function queueRecording(db: Database.Database, r: WasteRecording): void {
  db.transaction(() => {
    const list = readPending(db).filter((x) => x.client_id !== r.client_id);
    list.push(r);
    writeJson(db, PENDING_KEY, list, false);
  })();
}

export type WasteOutcome =
  | { state: 'saved'; ref: string; value: number }
  | { state: 'pending'; message: string }
  | { state: 'refused'; message: string };

/**
 * Send what is waiting, oldest first. `post` makes the cloud call (and renews the sign-in on a 401); it returns the
 * status and body, or throws when there is no connection — then everything stays and nothing after it is tried.
 */
export async function pushPendingWastage(
  db: Database.Database,
  post: (r: WasteRecording) => Promise<{ status: number; body: any }>,
  describe: (body: any, status: number) => string = (b, s) => String(b?.error ?? `HTTP ${s}`),
): Promise<Record<string, WasteOutcome>> {
  const out: Record<string, WasteOutcome> = {};
  for (const r of readPending(db)) {
    let res: { status: number; body: any };
    try { res = await post(r); }
    catch (e: any) {
      for (const left of readPending(db)) if (!out[left.client_id]) out[left.client_id] = { state: 'pending', message: `Saved on this till — it goes to the cloud when the connection is back (${e?.message ?? e}).` };
      break;
    }
    if (res.status >= 200 && res.status < 300) {
      const left = readPending(db).filter((x) => x.client_id !== r.client_id);
      writeJson(db, PENDING_KEY, left, left.length === 0);
      out[r.client_id] = { state: 'saved', ref: String(res.body?.ref ?? ''), value: Number(res.body?.value) || 0 };
      continue;
    }
    if (res.status >= 500 || res.status === 401 || res.status === 408 || res.status === 429) {
      out[r.client_id] = { state: 'pending', message: `Saved on this till — the cloud did not take it yet (HTTP ${res.status}); it retries at the next sync.` };
      continue;
    }
    // A real refusal: stop waiting, keep it where the manager can see why.
    const message = describe(res.body, res.status);
    db.transaction(() => {
      const left = readPending(db).filter((x) => x.client_id !== r.client_id);
      writeJson(db, PENDING_KEY, left, left.length === 0);
      const refused = [{ ...r, refused_at: new Date().toISOString(), message }, ...readRefused(db)].slice(0, 20);
      writeJson(db, REFUSED_KEY, refused, false);
    })();
    out[r.client_id] = { state: 'refused', message };
  }
  return out;
}

/** The manager has read a refusal: take it off the screen. */
export function dismissRefused(db: Database.Database, clientId: string): void {
  const left = readRefused(db).filter((x) => x.client_id !== clientId);
  writeJson(db, REFUSED_KEY, left, left.length === 0);
}
