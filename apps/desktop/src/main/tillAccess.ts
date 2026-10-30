/**
 * tillAccess.ts — A490: ONE rule on the till for "may this person see or do this".
 *
 * Owner, 2026-10-14/15: "turn most of this features into permissions which can be set in one place" — "dont just focus on
 * reports break even other views and how to limit what users see". Before this file the till had nine different "is a
 * manager" rules (dayService.isManager, shiftService.isShiftManager, tillGates.personHolds, changeQueue.mayChange,
 * stationRouting.mayRoute, tillWastage.mayWaste, offlineReversal.mayReverseLocal / isOwnerLocal, branchStaff's
 * ELEVATED_NAME), most of them deciding on the ROLE'S NAME. Now every check in the main process names a FINE key of the
 * catalogue (permissions.ts) and asks this file:
 *
 *   - personKeys(roleName, permissions) — the fine keys a person holds: the owner's role (named owner / admin, the cloud's
 *     own rule — the ONE place a role name decides anything) holds '*'; anyone else holds expandMap(their map): broad keys
 *     an older cloud sends become the fine keys they stood for, and a map made before the catalogue (no MAP_MARKER)
 *     keeps what nobody was refused before (OPEN_BEFORE_A490).
 *   - signedInCan(...keys) — the person signed in on this till (staff_session, written at PIN sign-in, so it works
 *     offline) holds ANY of the keys. Nobody signed in → no.
 *
 * Fail closed for back-office actions only: an unreadable map grants nothing. Selling, holding, sending to the kitchen,
 * opening a drawer and syncing are never asked here (the till keeps trading offline and on older clouds).
 *
 * Also here, because they are the same rule seen from another side:
 *   - the two "switch until migration 134" rules (sales.history_all, shifts.cash_movements): a map WITHOUT the marker
 *     keeps today's behaviour (the admin portal's switch, unless the person may confirm drawers);
 *   - a role's keys from the roles this till saved (roles_cache), for the staff ceiling and the branch server's vetting;
 *   - storing a fresher permission map for the signed-in person (the roster refresh, a staff token renewal) and telling
 *     the screens (auth:permissionsChanged).
 */
import { BrowserWindow } from 'electron';
import type Database from 'better-sqlite3';
import { getLocalDb } from './localDb';
import { expandKeys, hasPermission, hasAnyPermission, keysBeyond } from '@zaptill/core/permissions';
import { personKeys, personCan, parseMap } from './personAccess';

export * from './personAccess';

// ── The signed-in person ────────────────────────────────────────────────────────────────────────────────────────

export interface SignedIn {
  staffId: string;
  name: string | null;
  roleName: string | null;
  /** The stored JSON map. */
  permissions: string;
  branchId: string | null;
}

/** Who is signed in on this till (staff_session), or null. */
export function signedIn(db: Database.Database = getLocalDb()): SignedIn | null {
  let st: any;
  try { st = db.prepare(`SELECT staff_id, staff_name, role_name, permissions, branch_id FROM staff_session WHERE id=1`).get(); }
  catch { return null; }
  if (!st?.staff_id) return null;
  return { staffId: st.staff_id, name: st.staff_name ?? null, roleName: st.role_name ?? null,
    permissions: st.permissions ?? '{}', branchId: st.branch_id ?? null };
}

/** The signed-in person's fine keys (empty when nobody is signed in). */
export function signedInKeys(db?: Database.Database): Set<string> {
  const me = signedIn(db);
  return me ? personKeys(me.roleName, me.permissions) : new Set();
}

/** The signed-in person holds ANY of these keys. Nobody signed in → false. */
export function signedInCan(...keys: string[]): boolean {
  const me = signedIn();
  return !!me && personCan(me, ...keys);
}

// ── A fresher map for the person signed in ──────────────────────────────────────────────────────────────────────

/** Tell the screens the signed-in person's permissions changed (they re-read their session). */
export function announcePermissionsChanged(): void {
  try {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('auth:permissionsChanged');
    }
  } catch { /* no window (a test, the branch server's headless start) */ }
}

const sameMap = (a: unknown, b: unknown): boolean => {
  const x = parseMap(a), y = parseMap(b);
  const kx = Object.keys(x).sort(), ky = Object.keys(y).sort();
  return kx.length === ky.length && kx.every((k, i) => k === ky[i] && x[k] === y[k]);
};

/**
 * The signed-in person's map from a fresher source (a staff token renewal, the roster). Written only for THAT person
 * (staffId must be the one signed in), only when it differs. Returns whether it changed (the screens are told).
 */
export function storeSessionPermissions(staffId: string | null | undefined, permissions: unknown,
                                        roleName?: string | null, db: Database.Database = getLocalDb()): boolean {
  if (!staffId || !permissions || typeof permissions !== 'object' || Array.isArray(permissions)) return false;
  const me = signedIn(db);
  if (!me || me.staffId !== staffId) return false;
  const roleChanged = roleName !== undefined && roleName !== null && roleName !== me.roleName;
  if (sameMap(me.permissions, permissions) && !roleChanged) return false;
  db.prepare(`UPDATE staff_session SET permissions = ?${roleChanged ? ', role_name = ?' : ''} WHERE id = 1 AND staff_id = ?`)
    .run(...(roleChanged ? [JSON.stringify(permissions), roleName, staffId] : [JSON.stringify(permissions), staffId]));
  announcePermissionsChanged();
  return true;
}

/**
 * A staff list from the cloud (or the branch server): every saved sign-in (staff_pin_cache) takes its person's current
 * role and map, and the person signed in takes theirs (storeSessionPermissions). Never throws. Returns whether the
 * signed-in person's map changed.
 */
export function refreshPermissionsFromRoster(rows: Array<{ staff_id: string; role_name?: string | null; permissions?: unknown }>,
                                             db: Database.Database = getLocalDb()): boolean {
  let changed = false;
  try {
    const upd = db.prepare(`UPDATE staff_pin_cache SET permissions = ?, role_name = ? WHERE staff_id = ?`);
    const me = signedIn(db);
    for (const r of rows ?? []) {
      if (!r?.staff_id || !r.permissions || typeof r.permissions !== 'object') continue;
      try { upd.run(JSON.stringify(r.permissions), r.role_name ?? null, r.staff_id); } catch { /* an older table */ }
      if (me && r.staff_id === me.staffId) changed = storeSessionPermissions(me.staffId, r.permissions, r.role_name ?? null, db) || changed;
    }
  } catch { /* the next list */ }
  return changed;
}

/** Re-exported so callers name one module. */
export { expandKeys, hasPermission, hasAnyPermission, keysBeyond };
