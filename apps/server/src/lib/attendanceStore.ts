/**
 * attendanceStore.ts — A599 (Attendance, premium): the database side the routes and the staff hooks share.
 *
 *   attendanceEnabled   the business's 'attendance' feature flag (ZapTill sets it in the admin portal; the client cannot —
 *                       PUT /api/flags refuses every key not in CLIENT_SETTABLE_FLAGS). Kept 60 s per business while the
 *                       catalogue generation stands (an admin write moves it for every business, lib/forgetOnWrite.ts),
 *                       so the branch server's beat and the report do not read it on every ask. A failed read is OFF.
 *   queuePersonOnDevices  a person added, renamed, renumbered, moved or (de)activated → one action per device of their
 *                       branch for the branch server (write_user / delete_user); an opposite action still pending for the
 *                       same number on the same device is cancelled (the newest wins).
 *   attendanceStaffChanged  routes/staff.ts calls it when a member of staff is created, renamed, moved or deactivated —
 *                       with the flag on, their device user follows (created with the next free number; removed when
 *                       deactivated). Best effort: a failure is logged, never fails the staff change.
 */
import { supabase } from './supabase';
import { catalogueGen } from './writeActivity';
import { ATTENDANCE_FLAG, nextFreeNumber, deviceName, cleanAttendanceNo, slotClaims } from './attendanceRules';

const FLAG_TTL_MS = 60_000;
const flagMemo = new Map<string, { at: number; on: boolean; gen: string }>();

export async function attendanceEnabled(businessId: string | null | undefined): Promise<boolean> {
  if (!businessId) return false;
  const hit = flagMemo.get(businessId);
  const gen = catalogueGen(businessId);
  if (hit && hit.gen === gen && Date.now() - hit.at < FLAG_TTL_MS) return hit.on;
  const { data, error } = await supabase.from('feature_flags').select('enabled')
    .eq('business_id', businessId).eq('key', ATTENDANCE_FLAG).maybeSingle();
  if (error) return false;
  const on = (data as { enabled?: boolean } | null)?.enabled === true;
  flagMemo.set(businessId, { at: Date.now(), on, gen });
  return on;
}
/** Tests, and an admin write on this instance: read the flag afresh. */
export function forgetAttendanceFlag(businessId?: string): void {
  if (businessId) flagMemo.delete(businessId); else flagMemo.clear();
}

export interface PersonRow {
  id: string; business_id: string; branch_id: string | null; user_id: string | null; name: string;
  attendance_no: number; active: boolean;
}

/** The devices (not removed) of a branch. */
export async function branchDevices(businessId: string, branchId: string | null): Promise<Array<{ id: string; branch_id: string }>> {
  if (!branchId) return [];
  const { data, error } = await supabase.from('attendance_devices').select('id, branch_id')
    .eq('business_id', businessId).eq('branch_id', branchId).is('removed_at', null);
  if (error) throw new Error(`attendance devices: ${error.message}`);
  return (data ?? []) as Array<{ id: string; branch_id: string }>;
}

/** Who holds which number on each device, as far as this system knows (attendanceRules.slotClaims), per device id. */
export async function deviceClaims(businessId: string, deviceIds: readonly string[], numbers?: readonly number[]): Promise<Map<string, Map<number, string | null>>> {
  const out = new Map<string, Map<number, string | null>>();
  if (!deviceIds.length) return out;
  let q = supabase.from('attendance_device_actions').select('device_id, attendance_no, action, person_id, status, overwrite, created_at')
    .eq('business_id', businessId).in('device_id', [...deviceIds]).in('status', ['done', 'pending']);
  if (numbers?.length) q = q.in('attendance_no', [...numbers]);
  const { data, error } = await q;
  if (error) throw new Error(`attendance actions: ${error.message}`);
  const byDev = new Map<string, any[]>();
  for (const a of (data ?? []) as any[]) { const l = byDev.get(a.device_id) ?? []; l.push(a); byDev.set(a.device_id, l); }
  for (const id of deviceIds) out.set(id, slotClaims(byDev.get(id) ?? []));
  return out;
}

/** Each device's users as the branch server last reported them: device id → number → { name, privilege }. */
export async function deviceSlots(businessId: string, deviceIds: readonly string[]): Promise<Map<string, Map<number, { name: string | null; privilege: number }>>> {
  const out = new Map<string, Map<number, { name: string | null; privilege: number }>>();
  for (const id of deviceIds) out.set(id, new Map());
  if (!deviceIds.length) return out;
  const { data, error } = await supabase.from('attendance_device_users').select('device_id, device_user_id, name, privilege')
    .eq('business_id', businessId).in('device_id', [...deviceIds]);
  if (error) throw new Error(`attendance device users: ${error.message}`);
  for (const u of (data ?? []) as any[]) {
    const n = cleanAttendanceNo(u.device_user_id);
    if (n !== null) out.get(u.device_id)?.set(n, { name: u.name ?? null, privilege: u.privilege ?? 0 });
  }
  return out;
}

/**
 * Queue one action per device of `branchId` (the person's branch): write_user (number + name) or delete_user (number).
 * A pending action for the same number on the same device is cancelled first — the newest wins.
 * Never onto someone else's fingerprint (a real K40 held 138 people before ZapTill, numbered from 1):
 *   write_user  skipped on a device whose slot holds a user this person does not hold there — unless `claim` (the manager
 *               said so: linked that device user, or typed this number for them), when the slot becomes theirs
 *   delete_user only on a device where the slot is ours (written or linked by this system); a stranger is never deleted
 * Returns the actions queued.
 */
export async function queueOnDevices(businessId: string, branchId: string | null, action: 'write_user' | 'delete_user',
  attendanceNo: number, name: string | null, personId: string | null, by: string | null, claim = false): Promise<number> {
  const all = await branchDevices(businessId, branchId);
  if (!all.length) return 0;
  const ids = all.map((d) => d.id);
  const [claims, slots] = await Promise.all([deviceClaims(businessId, ids, [attendanceNo]), action === 'write_user' && !claim ? deviceSlots(businessId, ids) : null]);
  const devices = all.filter((d) => {
    const holder = claims.get(d.id)?.get(attendanceNo);
    if (action === 'delete_user') return holder !== undefined && holder !== null;
    if (claim) return true;
    const slot = slots?.get(d.id)?.get(attendanceNo);
    return !slot || (holder !== undefined && holder !== null && holder === personId) || (slot.privilege === 0 && (slot.name ?? '') === deviceName(name ?? ''));
  });
  if (!devices.length) return 0;
  await supabase.from('attendance_device_actions').update({ status: 'cancelled', done_at: new Date().toISOString() })
    .eq('business_id', businessId).eq('attendance_no', attendanceNo).eq('status', 'pending').in('device_id', devices.map((d) => d.id));
  // a write may replace another name only when the manager chose the slot, or it is already this person's (a rename);
  // a delete names the person it removes — the branch server deletes only that name, never whoever holds the slot now
  const rows = devices.map((d) => ({
    business_id: businessId, branch_id: d.branch_id, device_id: d.id, action, person_id: personId,
    attendance_no: attendanceNo, name: name ? deviceName(name) : null,
    overwrite: action === 'write_user' && (claim || (claims.get(d.id)?.get(attendanceNo) ?? null) === personId),
    status: 'pending', created_by: by,
  }));
  const { error } = await supabase.from('attendance_device_actions').insert(rows);
  if (error) throw new Error(`attendance actions: ${error.message}`);
  return rows.length;
}

/**
 * A person's device user brought in line with them: written where they are (active), removed where they were.
 * `claim`: the manager chose this number for them (a link, or a number typed) — the slot on the device becomes theirs.
 */
export async function queuePersonOnDevices(businessId: string, after: PersonRow, before: PersonRow | null, by: string | null, claim = false): Promise<void> {
  const moved = before && (before.branch_id !== after.branch_id || before.attendance_no !== after.attendance_no);
  if (before && before.active && (moved || !after.active)) {
    await queueOnDevices(businessId, before.branch_id, 'delete_user', before.attendance_no, before.name, before.id, by);
  }
  if (after.active && (!before || moved || !before.active || before.name !== after.name)) {
    await queueOnDevices(businessId, after.branch_id, 'write_user', after.attendance_no, after.name, after.id, by, claim);
  }
}

/** Every number the business has given. */
export async function takenNumbers(businessId: string): Promise<number[]> {
  const { data, error } = await supabase.from('attendance_people').select('attendance_no').eq('business_id', businessId);
  if (error) throw new Error(`attendance people: ${error.message}`);
  return ((data ?? []) as Array<{ attendance_no: number }>).map((r) => r.attendance_no);
}

/** Every number on any of the business's devices (as last reported) — a new number is never one of these. */
export async function numbersOnDevices(businessId: string): Promise<number[]> {
  const { data, error } = await supabase.from('attendance_device_users').select('device_user_id').eq('business_id', businessId);
  if (error) throw new Error(`attendance device users: ${error.message}`);
  return ((data ?? []) as Array<{ device_user_id: string }>).map((r) => cleanAttendanceNo(r.device_user_id)).filter((n): n is number => n !== null);
}

/** The next number to give: free among people AND on every device (a device's own people keep theirs). */
export async function nextNumber(businessId: string): Promise<number> {
  const [given, onDevices] = await Promise.all([takenNumbers(businessId), numbersOnDevices(businessId)]);
  return nextFreeNumber([...given, ...onDevices]);
}

/**
 * routes/staff.ts: a member of staff was created or changed. With the flag on: a new (or first-time) active member gets the
 * next free number at their first branch; a rename or a move follows on the devices; deactivated → removed from them.
 */
export async function attendanceStaffChanged(businessId: string | null | undefined, user: { id: string; name?: string | null; status?: string | null; branch_id?: string | null } , by: string | null): Promise<void> {
  if (!businessId || !user?.id) return;
  try {
    if (!(await attendanceEnabled(businessId))) return;
    const { data: had } = await supabase.from('attendance_people').select('id, business_id, branch_id, user_id, name, attendance_no, active')
      .eq('business_id', businessId).eq('user_id', user.id).maybeSingle();
    const before = (had ?? null) as PersonRow | null;
    const active = (user.status ?? 'active') === 'active';
    if (!before) {
      if (!active || !user.name) return;
      const n = await nextNumber(businessId);
      const { data: made, error } = await supabase.from('attendance_people').insert({
        business_id: businessId, branch_id: user.branch_id ?? null, user_id: user.id, name: user.name, attendance_no: n, active: true, created_by: by,
      }).select('id, business_id, branch_id, user_id, name, attendance_no, active').single();
      if (error) throw new Error(error.message);
      await queuePersonOnDevices(businessId, made as PersonRow, null, by);
      return;
    }
    const after: PersonRow = { ...before, name: user.name ?? before.name, branch_id: user.branch_id !== undefined ? user.branch_id : before.branch_id, active };
    if (after.name === before.name && after.branch_id === before.branch_id && after.active === before.active) return;
    const { error } = await supabase.from('attendance_people').update({
      name: after.name, branch_id: after.branch_id, active: after.active,
      deactivated_at: after.active ? null : new Date().toISOString(), updated_at: new Date().toISOString(),
    }).eq('id', before.id).eq('business_id', businessId);
    if (error) throw new Error(error.message);
    await queuePersonOnDevices(businessId, after, before, by);
  } catch (e) {
    console.warn(`[attendance] staff ${user.id}: the device user could not follow — ${(e as Error)?.message ?? e}`);
  }
}
