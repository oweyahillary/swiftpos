/**
 * changeQueue.ts — A448: the app's side of localChanges.ts (which takes the database and the cloud calls in, so the tests
 * run it as it is): who is signed in and may make the change, the PIN kept wrapped with safeStorage, sending to the cloud
 * now and on every beat, handing the change to the branch server, and pulling once something settled.
 */
import { safeStorage } from 'electron';
import { getLocalDb } from './localDb';
import { getDeviceConfig, isNodeRole } from './deviceConfig';
import { recordChange, pushLocalChanges, changeStates, relayChange, type RecordInput, type Secrets, type LocalChangeRow } from './localChanges';
import { ENTITY_SPECS, type ChangeEntity, type TillChange } from './tillChanges';
import { tillChangesPost, tillChangesState, syncAll } from './syncEngine';
import { relayChangesToNode, hasNode } from './nodeClient';
import { refreshStaffRosterNow } from './staffRoster';
import { logLine } from './logFile';

/** safeStorage when the machine has it (Windows: DPAPI); a till without it keeps the PIN marked plain until sent. */
export const tillSecrets: Secrets = {
  wrap: (s) => { try { return safeStorage.isEncryptionAvailable() ? `enc:${safeStorage.encryptString(s).toString('base64')}` : `raw:${s}`; } catch { return `raw:${s}`; } },
  unwrap: (s) => {
    if (s.startsWith('enc:')) { try { return safeStorage.decryptString(Buffer.from(s.slice(4), 'base64')); } catch { return ''; } }
    return s.startsWith('raw:') ? s.slice(4) : s;
  },
  seal: (s) => safeStorage.encryptString(s).toString('base64'),
};

/** The signed-in person and their permission keys (staff_session). */
function signedIn(): { id: string | null; name: string | null; role: string | null; perms: Record<string, unknown> } {
  const st = getLocalDb().prepare(`SELECT staff_id, staff_name, role_name, permissions FROM staff_session WHERE id = 1`).get() as any;
  let perms: Record<string, unknown> = {};
  try { perms = JSON.parse(st?.permissions || '{}'); } catch { perms = {}; }
  return { id: st?.staff_id ?? null, name: st?.staff_name ?? null, role: st?.role_name ?? null, perms };
}

/** May the signed-in person make this kind of change? The cloud's own keys (checked there again for the maker). */
export function mayChange(entity: ChangeEntity): boolean {
  const me = signedIn();
  if (!me.id) return false;
  if (['owner', 'admin'].includes(String(me.role ?? '').toLowerCase())) return true;
  return me.perms['*'] === true || ENTITY_SPECS[entity].permissions.some((k) => me.perms[k] === true);
}

/** Record a change made on this till by the signed-in person: it works here at once; it goes to the cloud (and the
 *  branch server) now if they can be reached, else on the next beat. */
export function recordTillChange(input: RecordInput, local: { roleName?: string | null; permissions?: unknown } = {}): TillChange {
  if (!mayChange(input.entity)) throw new Error('Your role does not allow this change.');
  const me = signedIn();
  const r = recordChange(getLocalDb(), input, { id: me.id, name: me.name }, tillSecrets,
    { ...local, branchId: getDeviceConfig()?.branch_id ?? null });
  if (!r.ok) throw new Error((r as { error: string }).error);
  const change = (r as { change: TillChange }).change;
  logLine('change', `${input.entity} ${input.op} saved on this till — it reaches the cloud when it can`);
  void sendTillChangesNow();
  return change;
}

let sending: Promise<void> | null = null;
let again = false;
/** Hand waiting changes to the branch server (a till behind one) and send them to the cloud. Never throws. A call while a
 *  send runs is not dropped: one more pass follows it (a change made mid-send goes now, not on the next 20-s beat). */
export function sendTillChangesNow(): Promise<void> {
  if (sending) { again = true; return sending; }
  sending = (async () => {
    try {
      do { again = false; await sendOnce(); } while (again);
    } finally { sending = null; }
  })();
  return sending;
}

async function sendOnce(): Promise<void> {
  try {
    const db = getLocalDb();
    const cfg = getDeviceConfig();
    if (hasNode() && !isNodeRole(cfg?.device_role ?? null)) {
      // Every waiting change, every beat — the server keeps each once (by its id); cheap on the shop's network.
      const rows = db.prepare(`SELECT * FROM local_changes WHERE state = 'pending' ORDER BY made_at LIMIT 50`).all() as LocalChangeRow[];
      if (rows.length) await relayChangesToNode(rows.map((r) => relayChange(r, tillSecrets)));
    }
    const r = await pushLocalChanges(db, {
      post: (changes) => tillChangesPost(changes),
      state: (ids) => tillChangesState(ids),
      secrets: tillSecrets,
      log: (line) => logLine('change', line),
    });
    if (r.settled > 0) {
      // The cloud's answer is the cloud's state now: pull it (and the staff list, for a cashier or a PIN).
      syncAll().catch(() => { /* the next beat */ });
      void refreshStaffRosterNow('a change made on this till settled');
    }
  } catch (e: any) {
    logLine('change', `sending changes failed: ${e?.message ?? e}`);
  }
}

/** What waits on this till, for the screens. */
export function tillChangeStates(entity?: ChangeEntity) { return changeStates(getLocalDb(), entity); }
