/**
 * changeApply.ts — A448: the cloud's side of a change made on a till (rules: lib/tillChanges.ts, the same file the till runs).
 *
 * A till saves a manager's change first and sends it later, with the values it saw before (`base`). Here each change is:
 *   applied    nobody else changed it — applied as it is
 *   identical  the cloud already holds the same (the same change made elsewhere, a replay, the same new station/category/
 *              product under another id — then `canonical_id` tells the till to use the cloud's id)
 *   awaiting   someone else changed it differently — NOT applied; the owner is notified and decides (decideChange)
 *   refused    it cannot be applied: who made it may not, what it names no longer exists, a PIN someone else has
 * and recorded in change_requests by the till's own id for it, so a change sent twice is answered the same way.
 *
 * Owner, 2026-10-12: "if they are the same keep them, if not notify the owner requesting approval"; "offline supersedes
 * online when it comes to PIN change" — a PIN set on a till is applied whatever the cloud held, unless another person has it.
 */
import bcrypt from 'bcrypt';
import { supabase } from './supabase';
import { ENTITY_SPECS, judgeCreate, judgeUpdate, describeChange, type TillChange } from './tillChanges';
import { verifyPin } from '../routes/auth';
import { isElevatedRoleName } from './roleCeiling';

export type ChangeStatus = 'applied' | 'identical' | 'awaiting' | 'approved' | 'rejected' | 'refused';
export interface ChangeResult { id: string; status: ChangeStatus; message?: string | null; canonical_id?: string | null;
  /** Not recorded: send it again later (what it names has not reached the cloud yet). */
  retry?: boolean }
export interface ChangeContext { businessId: string; branchId: string | null; deviceId: string | null;
  /** The caller is a person with these keys (a manager's own sign-in) — else the maker's own permissions are checked. */
  callerKeys?: string[] | null; callerIsOwner?: boolean; callerUserId?: string | null }

type Row = Record<string, any>;

/** May `userId` make this kind of change? The owner, '*', or one of the entity's keys (role grants + user overrides). */
async function makerMay(businessId: string, userId: string | null, keys: string[]): Promise<{ ok: boolean; name: string | null }> {
  if (!userId) return { ok: false, name: null };
  const { data: biz } = await supabase.from('businesses').select('owner_id').eq('id', businessId).maybeSingle();
  const { data: u } = await supabase.from('users')
    .select('id, name, status, roles ( role_permissions ( permissions ( key ) ) ), user_permissions ( granted, permissions ( key ) )')
    .eq('id', userId).eq('business_id', businessId).maybeSingle();
  if ((biz as Row | null)?.owner_id === userId) return { ok: true, name: (u as Row | null)?.name ?? 'Owner' };
  if (!u || (u as Row).status !== 'active') return { ok: false, name: (u as Row | null)?.name ?? null };
  const eff: Record<string, boolean> = {};
  for (const rp of ((u as Row).roles?.role_permissions ?? [])) if (rp.permissions?.key) eff[rp.permissions.key] = true;
  for (const up of ((u as Row).user_permissions ?? [])) if (up.permissions?.key) eff[up.permissions.key] = up.granted;
  return { ok: eff['*'] === true || keys.some((k) => eff[k] === true), name: (u as Row).name ?? null };
}

/** Whose PIN is this already (another active person of the business), or null. */
async function pinTakenBy(businessId: string, pin: string, exceptId: string | null): Promise<string | null> {
  const { data: staff } = await supabase.from('users').select('id, name, pin_hash').eq('business_id', businessId).eq('status', 'active');
  for (const s of (staff ?? []) as Row[]) {
    if (s.id === exceptId || !s.pin_hash) continue;
    if ((await verifyPin(pin, s.pin_hash, businessId)).valid) return s.name ?? 'another staff member';
  }
  return null;
}
async function isOwnerOf(businessId: string, userId: string | null): Promise<boolean> {
  if (!userId) return false;
  const { data } = await supabase.from('businesses').select('owner_id').eq('id', businessId).maybeSingle();
  return (data as Row | null)?.owner_id === userId;
}

const pick = (row: Row, keys: string[]) => Object.fromEntries(keys.map((k) => [k, row[k] ?? null]));

async function record(ctx: ChangeContext, c: TillChange, r: ChangeResult, extra: { cloud_value?: Row | null; proposed?: Row } = {}) {
  await supabase.from('change_requests').insert({
    id: c.id, business_id: ctx.businessId, branch_id: ctx.branchId, device_id: ctx.deviceId,
    entity: c.entity, entity_id: c.entity_id, op: c.op, base: c.base,
    // A PIN is never stored: only that one was set.
    proposed: extra.proposed ?? (c.entity === 'staff_pin' ? { pin_set: true }
      : c.entity === 'staff' && c.op === 'create' ? { name: c.data.name, role_id: c.data.role_id, pin_set: true } : c.data),
    cloud_value: extra.cloud_value ?? null, status: r.status, message: r.message ?? null, canonical_id: r.canonical_id ?? null,
    made_by: c.made_by, made_by_name: c.made_by_name, made_at: c.made_at,
  });
}

async function notifyOwner(ctx: ChangeContext, c: TillChange, title: string, message: string) {
  const { data: biz } = await supabase.from('businesses').select('owner_id').eq('id', ctx.businessId).maybeSingle();
  await supabase.from('notifications').insert({
    business_id: ctx.businessId, branch_id: ctx.branchId, user_id: (biz as Row | null)?.owner_id ?? null,
    type: 'change_approval', title, message: `${message} [change:${c.id}]`, link: '/dashboard/approvals',
  });
}

/** Write the change's values (no clash check): a create (with its own id) or an update. */
async function write(ctx: ChangeContext, c: TillChange, targetId: string, create: boolean): Promise<string | null> {
  const spec = ENTITY_SPECS[c.entity];
  if (c.entity === 'staff_pin') {
    const hash = await bcrypt.hash(String(c.data.pin), 10);
    const { error } = await supabase.from('users').update({ pin_hash: hash }).eq('id', targetId).eq('business_id', ctx.businessId);
    return error?.message ?? null;
  }
  if (c.entity === 'staff' && create) {
    // bcrypt, so the cashier is on every till's staff list (A446) at once — the web's create kept a legacy hash that the
    // lists skip until a first online sign-in.
    const hash = await bcrypt.hash(String(c.data.pin), 10);
    const { error } = await supabase.from('users').insert({ id: targetId, business_id: ctx.businessId, name: c.data.name,
      role_id: c.data.role_id, pin_hash: hash, status: 'active' });
    if (error) return (error as { code?: string }).code === '23505' ? 'already exists' : error.message;
    if (ctx.branchId) await addToBranch(targetId, ctx.branchId);
    return null;
  }
  const values: Row = { ...c.data };
  if (c.entity === 'station' || c.entity === 'product') values.updated_at = new Date().toISOString();
  if (create) {
    const row: Row = { ...spec.defaults, ...values, id: targetId, business_id: ctx.businessId };
    if (c.entity === 'station') row.branch_id = ctx.branchId;
    const { error } = await supabase.from(spec.table).insert(row);
    return error ? `${(error as { code?: string }).code === '23505' ? 'already exists' : error.message}` : null;
  }
  const { error } = await supabase.from(spec.table).update(values).eq('id', targetId).eq('business_id', ctx.businessId);
  return error?.message ?? null;
}

/** Things a value names must be this business's (a product's category) and stay unique (a barcode). */
async function namesAreOurs(ctx: ChangeContext, c: TillChange): Promise<string | null> {
  if (c.entity === 'product' && c.data.category_id) {
    const { data } = await supabase.from('categories').select('id').eq('id', c.data.category_id).eq('business_id', ctx.businessId).maybeSingle();
    if (!data) return 'its category is not on the cloud (yet) — it goes again on the next sync';
  }
  if (c.entity === 'product' && c.data.barcode) {
    const { data } = await supabase.from('products').select('id').eq('business_id', ctx.businessId).eq('barcode', c.data.barcode).neq('id', c.entity_id).maybeSingle();
    if (data) return `barcode ${c.data.barcode} is already another product's`;
  }
  return null;
}

/** One change from a till. Never throws (a failure is a 'refused' with the reason). */
export async function applyChange(ctx: ChangeContext, c: TillChange): Promise<ChangeResult> {
  // A replay: answered as before (the till lost the first answer, or sends again until it hears).
  const { data: seen } = await supabase.from('change_requests').select('status, message, canonical_id')
    .eq('id', c.id).eq('business_id', ctx.businessId).maybeSingle();
  if (seen) return { id: c.id, status: (seen as Row).status, message: (seen as Row).message, canonical_id: (seen as Row).canonical_id };

  const spec = ENTITY_SPECS[c.entity];
  const done = async (r: ChangeResult, extra?: { cloud_value?: Row | null }) => { await record(ctx, c, r, extra); return r; };

  // Who may: the person signed in (their own keys), or — sent later by the till's own session — the person who made it.
  const callerOk = ctx.callerIsOwner || (ctx.callerKeys ?? []).some((k) => k === '*' || spec.permissions.includes(k));
  const maker = callerOk && ctx.callerUserId === c.made_by ? { ok: true } : await makerMay(ctx.businessId, c.made_by, spec.permissions);
  if (!callerOk && !maker.ok) return done({ id: c.id, status: 'refused', message: `${c.made_by_name ?? 'Whoever made it'} may not make this change` });

  try {
    if (c.entity === 'staff' && c.op === 'create') {
      const { data: had } = await supabase.from('users').select('id').eq('id', c.entity_id).eq('business_id', ctx.businessId).maybeSingle();
      if (had) return done({ id: c.id, status: 'identical' });
      // A manager may not add someone above themselves (the web's own rule).
      const makerIsOwner = await isOwnerOf(ctx.businessId, c.made_by);
      if (!makerIsOwner) {
        const { data: role } = await supabase.from('roles').select('name').eq('id', c.data.role_id).maybeSingle();
        if (!role || isElevatedRoleName((role as Row).name)) return done({ id: c.id, status: 'refused', message: 'only the owner adds staff with that role' });
      }
      const clash = await pinTakenBy(ctx.businessId, String(c.data.pin), null);
      if (clash) {
        await notifyOwner(ctx, c, 'A PIN set on a till is already someone else\'s',
          `${c.data.name} (added on a till by ${c.made_by_name ?? 'a manager'}) was given ${clash}'s PIN — set a different one.`);
        return done({ id: c.id, status: 'refused', message: `that PIN is already ${clash}'s — choose another` });
      }
      const err = await write(ctx, c, c.entity_id, true);
      return err ? { id: c.id, status: 'refused', message: err } : done({ id: c.id, status: 'applied' });
    }

    if (c.op === 'create') {
      const { data: byId } = await supabase.from(spec.table).select('*').eq('id', c.entity_id).eq('business_id', ctx.businessId).maybeSingle();
      let same = byId as Row | null;
      // The same thing created elsewhere under another id ("Grill" added on the web and on a till): by name (and category).
      if (!same && spec.sameBy.length) {
        let q = supabase.from(spec.table).select('*').eq('business_id', ctx.businessId);
        for (const k of spec.sameBy) q = c.data[k] === null || c.data[k] === undefined ? q.is(k, null) : (k === 'name' ? q.ilike(k, String(c.data[k]).replace(/[\\%_]/g, (m) => `\\${m}`)) : q.eq(k, c.data[k]));
        const { data: rows } = await q.limit(1);
        same = (rows ?? [])[0] ?? null;
      }
      if (same) {
        const v = judgeCreate(c.entity, same, c.data);
        const canonical = same.id !== c.entity_id ? same.id : null;
        if (v.verdict === 'identical') return done({ id: c.id, status: 'identical', canonical_id: canonical });
        await notifyOwner(ctx, c, 'A till added something that already exists differently',
          `${describeChange(c)} on a till (${c.made_by_name ?? 'a manager'}) differs from the cloud's: ${(v as { fields: string[] }).fields.join(', ')}. Approve to take the till's.`);
        return done({ id: c.id, status: 'awaiting', canonical_id: canonical, message: 'differs from the cloud\'s — waiting for the owner' },
          { cloud_value: pick(same, Object.keys(c.data)) });
      }
      const bad = await namesAreOurs(ctx, c);
      if (bad) return { id: c.id, status: 'refused', message: bad, retry: true };   // not recorded: it is sent again once fixable
      const err = await write(ctx, c, c.entity_id, true);
      return err ? { id: c.id, status: 'refused', message: err } : done({ id: c.id, status: 'applied' });
    }

    const { data: cur } = await supabase.from(spec.table).select('*').eq('id', c.entity_id).eq('business_id', ctx.businessId).maybeSingle();
    if (c.op === 'delete') {
      if (!cur) return done({ id: c.id, status: 'identical' });   // already gone
      const err = c.entity === 'product'
        ? (await supabase.from('products').update({ status: 'inactive', updated_at: new Date().toISOString() }).eq('id', c.entity_id).eq('business_id', ctx.businessId)).error?.message
        : (await supabase.from(spec.table).delete().eq('id', c.entity_id).eq('business_id', ctx.businessId)).error?.message;
      return err ? { id: c.id, status: 'refused', message: err } : done({ id: c.id, status: 'applied' });
    }

    // Update.
    if (!cur) return done({ id: c.id, status: 'refused', message: 'it no longer exists on the cloud' });
    if (c.entity === 'staff_pin') {
      // Offline supersedes online — but a PIN is one person's: refused (and the owner told) when another has it.
      const clash = await pinTakenBy(ctx.businessId, String(c.data.pin), c.entity_id);
      if (clash) {
        await notifyOwner(ctx, c, 'A PIN set on a till is already someone else\'s',
          `${(cur as Row).name ?? 'A staff member'}'s new PIN (set on a till by ${c.made_by_name ?? 'a manager'}) is ${clash}'s too — set a different one.`);
        return done({ id: c.id, status: 'refused', message: `that PIN is already ${clash}'s — choose another` });
      }
    }
    if (c.entity === 'staff') {
      // A459: the web's own rules for a staff edit (routes/staff.ts PATCH): only the owner changes an owner or admin, or
      // gives anyone such a role; a manager changes people of their own branch.
      const refusal = await staffEditRefusal(ctx, c, cur as Row);
      if (refusal) return done({ id: c.id, status: 'refused', message: refusal });
    }
    const bad = await namesAreOurs(ctx, c);
    if (bad) return { id: c.id, status: 'refused', message: bad, retry: true };
    const v = judgeUpdate(c.entity, cur as Row, c.base, c.data);
    if (v.verdict === 'identical') return done({ id: c.id, status: 'identical' });
    if (v.verdict === 'clash') {
      await notifyOwner(ctx, c, 'Two changes to the same thing — your approval',
        `${describeChange(c, (cur as Row).name)}: a till (${c.made_by_name ?? 'a manager'}) and the cloud changed ${v.fields.join(', ')} differently. Approve to take the till's.`);
      return done({ id: c.id, status: 'awaiting', message: 'changed differently on the cloud — waiting for the owner' },
        { cloud_value: pick(cur as Row, Object.keys(c.data)) });
    }
    const err = await write(ctx, c, c.entity_id, false);
    return err ? { id: c.id, status: 'refused', message: err } : done({ id: c.id, status: 'applied' });
  } catch (e: any) {
    return { id: c.id, status: 'refused', message: e?.message ?? 'could not be applied' };
  }
}

/** The owner decides a change that waits: approve = the till's values are applied (to the cloud's own row when it had the
 *  same thing under another id); reject = the cloud's stay, and the till takes them on its next pull. */
export async function decideChange(businessId: string, id: string, approve: boolean, by: { id: string | null; name: string | null }):
  Promise<{ ok: boolean; error?: string; status?: ChangeStatus }> {
  const { data: row } = await supabase.from('change_requests').select('*').eq('id', id).eq('business_id', businessId).maybeSingle();
  if (!row) return { ok: false, error: 'not found' };
  if ((row as Row).status !== 'awaiting') return { ok: false, error: `already ${(row as Row).status}` };
  if (approve) {
    const r = row as Row;
    const target = r.canonical_id ?? r.entity_id;
    const values: Row = { ...(r.proposed ?? {}) };
    if (r.entity === 'station' || r.entity === 'product') values.updated_at = new Date().toISOString();
    const { error } = await supabase.from(ENTITY_SPECS[r.entity as keyof typeof ENTITY_SPECS].table).update(values).eq('id', target).eq('business_id', businessId);
    if (error) return { ok: false, error: error.message };
  }
  const status: ChangeStatus = approve ? 'approved' : 'rejected';
  await supabase.from('change_requests').update({ status, decided_by: by.id, decided_by_name: by.name, decided_at: new Date().toISOString() })
    .eq('id', id).eq('business_id', businessId);
  await supabase.from('notifications').update({ read_at: new Date().toISOString() })
    .eq('business_id', businessId).eq('type', 'change_approval').ilike('message', `%[change:${id}]%`);
  return { ok: true, status };
}

/** A459: why a staff edit from a till may not be made — the web's rules (routes/staff.ts PATCH) — or null. */
async function staffEditRefusal(ctx: ChangeContext, c: TillChange, cur: Row): Promise<string | null> {
  if (await isOwnerOf(ctx.businessId, c.made_by)) return null;
  const roleName = async (id: unknown) => {
    if (!id) return null;
    const { data } = await supabase.from('roles').select('name').eq('id', String(id)).maybeSingle();
    return (data as Row | null)?.name ?? null;
  };
  if (await isOwnerOf(ctx.businessId, c.entity_id) || isElevatedRoleName(await roleName(cur.role_id))) return 'only the owner changes an owner or an admin';
  if (c.data.role_id !== undefined && isElevatedRoleName(await roleName(c.data.role_id))) return 'only the owner gives that role';
  if (ctx.branchId) {
    const { data: theirs } = await supabase.from('user_branches').select('branch_id').eq('user_id', c.entity_id);
    const list = ((theirs ?? []) as Row[]).map((b) => b.branch_id);
    if (list.length && !list.includes(ctx.branchId)) return 'they work at another branch — change them there or on the web';
  }
  return null;
}

/** A cashier added on a till works at that till's branch. */
async function addToBranch(userId: string, branchId: string): Promise<void> {
  await supabase.from('user_branches').insert({ user_id: userId, branch_id: branchId });
}
