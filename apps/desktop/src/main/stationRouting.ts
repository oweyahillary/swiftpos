/**
 * stationRouting.ts — A411: which categories print at a station is saved on the till first, and sent to the cloud after.
 *
 * Owner, 2026-10-05: "why does it have to save to the cloud cant it save local then push later if the till is fully
 * offline what happens since it cant reach the cloud?" A tap on a category (Printing › Stations) used to go to the cloud
 * first and do nothing on the till until the cloud said yes — so with no connection (or the cloud refusing, A409) the
 * tick simply vanished.
 *
 * Now:
 *   1. The tap is written to this till's own routing (category_stations) at once — tickets print the new way straight
 *      away, online or not — and the station is marked pending (maintenance_state `station_routing_pending`).
 *   2. The pending set is sent to the cloud (PUT /api/stations/:id/categories — through the branch server on a peer,
 *      A410) now, and again on every sync until the cloud takes it.
 *   3. A pull from the cloud (or from the branch server) does not undo it while it waits: the pending sets are laid
 *      back over whatever the pull wrote.
 *   4. The cloud refusing it (a category it does not know, a station deleted elsewhere) ends the wait — the next pull
 *      brings the cloud's routing back, and the screen said why.
 *   5. Two tills changing one station: the later save to reach the cloud wins (the whole set is sent, never a diff).
 */
import type Database from 'better-sqlite3';

export const PENDING_KEY = 'station_routing_pending';

export interface PendingSet { category_ids: string[]; at: string; by?: string | null }
export type PendingMap = Record<string, PendingSet>;

export function readPending(db: Database.Database): PendingMap {
  try {
    const row = db.prepare(`SELECT value FROM maintenance_state WHERE key = ?`).get(PENDING_KEY) as { value: string } | undefined;
    const parsed = row?.value ? JSON.parse(row.value) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as PendingMap : {};
  } catch { return {}; }
}

function writePending(db: Database.Database, map: PendingMap): void {
  if (!Object.keys(map).length) { db.prepare(`DELETE FROM maintenance_state WHERE key = ?`).run(PENDING_KEY); return; }
  db.prepare(`INSERT OR REPLACE INTO maintenance_state (key, value, updated_at) VALUES (?, ?, ?)`)
    .run(PENDING_KEY, JSON.stringify(map), new Date().toISOString());
}

/** May this person change where categories print? The cloud's own rule: stations.manage or products.manage. */
export function mayRoute(roleName: string | null | undefined, permissionsJson: string | null | undefined): boolean {
  if (['owner', 'admin'].includes(String(roleName ?? '').toLowerCase())) return true;
  let p: Record<string, unknown> = {};
  try { p = JSON.parse(permissionsJson || '{}'); } catch { p = {}; }
  return p['*'] === true || p['stations.manage'] === true || p['products.manage'] === true;
}

function setLinks(db: Database.Database, stationId: string, ids: string[]): void {
  db.prepare(`DELETE FROM category_stations WHERE station_id = ?`).run(stationId);
  const ins = db.prepare(`INSERT OR IGNORE INTO category_stations (category_id, station_id) VALUES (?, ?)`);
  for (const id of ids) ins.run(id, stationId);
}

/** Save a station's categories on this till and mark them for the cloud. Returns the set as saved. */
export function saveRoutingLocally(db: Database.Database, stationId: string, categoryIds: string[], by: string | null = null,
                                   now = new Date().toISOString()): string[] {
  const ids = [...new Set(categoryIds.map(String).filter(Boolean))];
  db.transaction(() => {
    setLinks(db, stationId, ids);
    const map = readPending(db);
    map[stationId] = { category_ids: ids, at: now, by };
    writePending(db, map);
  })();
  return ids;
}

/** After a pull rewrote the routing: lay the waiting sets back over it. A station the pull no longer has is dropped. */
export function overlayPending(db: Database.Database): number {
  const map = readPending(db);
  const ids = Object.keys(map);
  if (!ids.length) return 0;
  let applied = 0;
  db.transaction(() => {
    for (const stationId of ids) {
      const exists = db.prepare(`SELECT 1 FROM print_stations WHERE id = ?`).get(stationId);
      if (!exists) { delete map[stationId]; continue; }
      setLinks(db, stationId, map[stationId].category_ids);
      applied++;
    }
    writePending(db, map);
  })();
  return applied;
}

export type PushOutcome = { state: 'saved'; category_ids: string[]; rejected: string[] }
  | { state: 'pending'; message: string }
  | { state: 'refused'; message: string };

/**
 * Send every waiting set. `put` makes the cloud call (and renews the sign-in on a 401); it returns the status and the
 * parsed body, or throws when there is no connection. Never throws.
 */
export async function pushPendingRouting(
  db: Database.Database,
  put: (stationId: string, categoryIds: string[]) => Promise<{ status: number; body: any }>,
  describe: (body: any, status: number) => string = (b, s) => String(b?.error ?? `HTTP ${s}`),
): Promise<Record<string, PushOutcome>> {
  const out: Record<string, PushOutcome> = {};
  for (const [stationId, set] of Object.entries(readPending(db))) {
    let r: { status: number; body: any };
    try { r = await put(stationId, set.category_ids); }
    catch (e: any) { out[stationId] = { state: 'pending', message: `Saved on this till — it goes to the cloud when the connection is back (${e?.message ?? e}).` }; continue; }

    if (r.status >= 200 && r.status < 300) {
      const accepted: string[] = Array.isArray(r.body?.category_ids) ? r.body.category_ids.map(String) : set.category_ids;
      const rejected: string[] = Array.isArray(r.body?.rejected) ? r.body.rejected.map(String) : [];
      db.transaction(() => {
        const map = readPending(db);
        // Changed again while this was on its way: keep waiting with the newer set.
        if (map[stationId]?.at === set.at) {
          delete map[stationId];
          setLinks(db, stationId, accepted);
        }
        writePending(db, map);
      })();
      out[stationId] = { state: 'saved', category_ids: accepted, rejected };
      continue;
    }
    if (r.status >= 500 || r.status === 401 || r.status === 408 || r.status === 429) {
      out[stationId] = { state: 'pending', message: `Saved on this till — the cloud did not take it yet (HTTP ${r.status}); it retries at the next sync.` };
      continue;
    }
    // A real refusal (403 role, 404 station gone, 400): stop waiting; the next pull brings the cloud's routing back.
    db.transaction(() => {
      const map = readPending(db);
      if (map[stationId]?.at === set.at) delete map[stationId];
      writePending(db, map);
    })();
    out[stationId] = { state: 'refused', message: describe(r.body, r.status) };
  }
  return out;
}
