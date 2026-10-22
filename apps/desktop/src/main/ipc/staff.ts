// IPC: staff and roles. Registered from ipcHandlers.ts (D10); two register functions so the channels register in
// the order they always did.
import { getLocalDb } from '../localDb';
import { roleMap } from '../tillAccess';
import { staffChangedHere } from '../staffRoster';
import { recordTillChange } from '../changeQueue';
import { signedIn } from '../tillAccess';   // A562
import { type IpcShared } from './shared';

/** Staff and roles: list, add, set a PIN. */
export function registerStaffHandlers(ctx: IpcShared) {
  const { handle, requireKey, manageFetch, overlayOnList, savedRoles, requireStaffChange } = ctx;

  handle('manage:listStaff', async () => { requireKey(['staff.view', 'staff.edit'], 'Your role does not see the staff list.'); return overlayOnList('staff', await manageFetch('/api/staff', 'GET')); });
  // A448: the roles are kept on this till too, so a cashier can be added offline with their role's name and permissions.
  handle('manage:listRoles', async () => {
    requireKey(['staff.view', 'staff.edit'], 'Your role does not see the staff list.');   // A490
    try {
      const roles = await manageFetch('/api/staff/roles', 'GET');
      getLocalDb().prepare(`INSERT OR REPLACE INTO maintenance_state (key, value, updated_at) VALUES ('roles_cache', ?, ?)`)
        .run(JSON.stringify(roles ?? []), new Date().toISOString());
      return roles;
    } catch (e) {
      const row = getLocalDb().prepare(`SELECT value FROM maintenance_state WHERE key = 'roles_cache'`).get() as { value?: string } | undefined;
      if (row?.value) return JSON.parse(row.value);
      throw e;
    }
  });
  // A448 (owner, 2026-10-12: "offline supersedes online when it comes to PIN change"): a staff member's PIN set on this
  // till works here at once (and on the branch's other tills through the branch server), and wins on the cloud — unless
  // another person has that PIN, when the owner is told.
  handle('manage:setStaffPin', async (_e, { id, pin }: { id: string; pin: string }) => {
    requireStaffChange({ targetId: String(id) });   // A490
    recordTillChange({ entity: 'staff_pin', op: 'update', entity_id: String(id), data: { pin: String(pin) } });
    return { ok: true };
  });
  // A446: a staff member created or changed here reaches this till's own list at once, and the branch server's (so its
  // other tills): the cashier signs in anywhere at the branch within seconds — not after the next menu pull.
  handle('manage:createStaff', async (_e, payload: any) => {
    // A448: a cashier (name, PIN, role) is added on this till first — they sign in here at once, offline too. An override
    // PIN or an email still needs the cloud first.
    // Only for a role this till has saved (it gives the new cashier their permissions here); otherwise the cloud, as before.
    // A490: staff.edit, and never a role that can do more than the person adding (nor the owner's role) — this closes the
    // hole where anyone who could manage staff created an owner on this till, signed in here at once, offline.
    requireStaffChange({ roleId: payload?.role_id });
    const roles = savedRoles();
    const role = payload?.role_id ? roles.find((r) => r?.id === payload.role_id) : null;
    if (role && !payload?.override_pin && !payload?.email) {
      const perms = roleMap(role);   // A490: the role's map as the cloud sends it (fine keys and the marker, or the older list)
      const ch = recordTillChange({ entity: 'staff', op: 'create', data: { name: payload?.name, role_id: payload?.role_id, pin: payload?.pin } },
        { roleName: role?.name ?? null, permissions: perms });
      return { id: ch.entity_id, name: ch.data.name, role_id: ch.data.role_id, change_state: 'pending' };
    }
    const out = await manageFetch('/api/staff', 'POST', payload);
    void staffChangedHere();
    return out;
  });
}

/** Changing a member of staff. */
export function registerStaffUpdateHandlers(ctx: IpcShared) {
  const { handle, manageFetch, requireStaffChange } = ctx;

  handle('manage:updateStaff', async (_e, { id, patch }: { id: string; patch: any }) => {
    requireStaffChange({ roleId: patch?.role_id, targetId: String(id) });   // A490
    // A459: the screen's Deactivate sent { is_active } — a field the cloud does not know (it never deactivated anyone).
    const p: Record<string, unknown> = { ...(patch ?? {}) };
    if (typeof p.is_active === 'boolean') { p.status = p.is_active ? 'active' : 'inactive'; delete p.is_active; }
    // A562: nobody deactivates themselves (the cloud refuses SELF_DEACTIVATE; a till-first change would have done it here).
    if (typeof p.status === 'string' && p.status !== 'active' && signedIn()?.staffId === String(id)) throw new Error('You cannot deactivate yourself.');
    // A459 (owner, 2026-10-13: rename, role and deactivate on the till, offline too): these go on this till first — at
    // once, offline too — and reach the branch server and the cloud later (A448). Anything else (an override PIN, branches,
    // an email) still needs the cloud first.
    const tillFirst = Object.keys(p).length > 0 && Object.keys(p).every((k) => ['name', 'role_id', 'status'].includes(k));
    if (tillFirst) {
      try {
        const ch = recordTillChange({ entity: 'staff', op: 'update', entity_id: String(id), data: p });
        void staffChangedHere();
        return { id: ch.entity_id, ...p, change_state: 'pending' };
      } catch (e: any) {
        if (!/not on this till/.test(String(e?.message ?? ''))) throw e;   // someone this till does not hold: the cloud, as before
      }
    }
    const out = await manageFetch(`/api/staff/${id}`, 'PATCH', p);
    void staffChangedHere();
    return out;
  });
}
