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
import { ENTITY_SPECS, changeKeys, judgeCreate, judgeUpdate, describeChange, type TillChange } from './tillChanges';
import { verifyPin } from '../routes/auth';
import { canAssignRole } from './roleCeiling';
import { hasPermission, keysBeyond } from './permissions';   // A490
import { effectiveKeysForRow } from './effectivePermissions';
import { isOwnerRoleName } from './ownerRole';
import { roleKeyMap, personKeys } from './roleKeys';

/** A490: a person holds EVERY key a change needs (tillChanges.changeKeys — fine keys, never expanded from broad ones). */
const holdsAll = (held: Iterable<string>, keys: readonly string[]): boolean => {
  const set = new Set(held);
  return keys.every((k) => hasPermission(set, k));
};
import { isDataError } from './orderErrors';

export type ChangeStatus = 'applied' | 'identical' | 'awaiting' | 'approved' | 'rejected' | 'refused';
export interface ChangeResult { id: string; status: ChangeStatus; message?: string | null; canonical_id?: string | null;
  /** Not recorded: send it again later (what it names has not reached the cloud yet). */
  retry?: boolean }
export interface ChangeContext { businessId: string; branchId: string | null; deviceId: string | null;
  /** The caller is a person with these keys (a manager's own sign-in) — else the maker's own permissions are checked. */
  callerKeys?: string[] | null; callerIsOwner?: boolean; callerUserId?: string | null;
  /** A494: sent by a till's own session (no person) — the maker named in the change must be proven (makerSignedInHere). */
  tillSession?: boolean }

type Row = Record<string, any>;

/**
 * P1-8b (audit 2026-10-14): a failure that says nothing about the change itself — the database unreachable, a timeout, an
 * unknown error. Thrown, and answered `refused` + `retry: true`: the till keeps the change and sends it again. It used to be
 * a plain `refused`, on which the till UNDOES a create (undoRefusedCreate) — a product, a cashier or a station made on the
 * till deleted there because the cloud had a hiccup. `refused` without retry stays for decisions only: who may, a PIN
 * someone else has, a value the database refuses on its merits (Postgres classes 22 / 23, lib/orderErrors.isDataError).
 */
class TransientChangeError extends Error {}
/** A read's error → thrown as transient (a failed read is never "not there"). */
function readOk(error: { message?: string } | null | undefined, what: string): void {
  if (error) throw new TransientChangeError(`${what}: ${error.message ?? 'read failed'}`);
}
/** A write's error → its message when the database refused the VALUES (a decision); thrown as transient otherwise. */
function writeRefusal(error: { code?: string; message?: string } | null | undefined): string | null {
  if (!error) return null;
  if (!isDataError(error)) throw new TransientChangeError(error.message ?? 'write failed');
  return error.code === '23505' ? 'already exists' : (error.message ?? 'refused by the database');
}
const retryLater = (c: TillChange, e: unknown): ChangeResult =>
  ({ id: c.id, status: 'refused', message: `${(e as Error)?.message ?? 'could not be applied'} — it is sent again`, retry: true });

/** May `userId` make this kind of change? The owner, '*', or one of the entity's keys (role grants + user overrides, in
 *  fine keys — A490: lib/effectivePermissions.ts, the one place a person's keys are worked out). */
async function makerMay(businessId: string, userId: string | null, keys: string[]): Promise<{ ok: boolean; name: string | null }> {
  if (!userId) return { ok: false, name: null };
  const { data: biz, error: bizErr } = await supabase.from('businesses').select('owner_id').eq('id', businessId).maybeSingle();
  readOk(bizErr, 'business');
  const { data: u, error: uErr } = await supabase.from('users')
    .select('id, name, status, roles ( name, role_permissions ( permissions ( key ) ) ), user_permissions ( granted, permissions ( key ) )')
    .eq('id', userId).eq('business_id', businessId).maybeSingle();
  readOk(uErr, 'who made it');   // a failed read is not "may not": refusing would undo the change on the till
  if ((biz as Row | null)?.owner_id === userId) return { ok: true, name: (u as Row | null)?.name ?? 'Owner' };
  if (!u || (u as Row).status !== 'active') return { ok: false, name: (u as Row | null)?.name ?? null };
  const held = effectiveKeysForRow(u as Row);
  return { ok: holdsAll(held, keys), name: (u as Row).name ?? null };
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
  const { data, error } = await supabase.from('businesses').select('owner_id').eq('id', businessId).maybeSingle();
  readOk(error, 'business');
  return (data as Row | null)?.owner_id === userId;
}

/** A494: what the till is told when a PIN is someone else's — never whose (the owner's notification names them). */
export const PIN_IN_USE = 'that PIN is already in use — choose another';

/** A494: how long a PIN sign-in on a branch's till counts as proof that its maker was there. */
export const MAKER_PROOF_DAYS = 30;

/**
 * A494: a change sent by a till's OWN session names its maker (made_by) — anyone holding the till's token could name the
 * owner. The maker is believed only when they really signed in (with their PIN, online) on this till or another till of
 * its branch (a branch server relays its tills' changes) within MAKER_PROOF_DAYS: a refresh_tokens row of theirs whose
 * device is one of them. A sign-in made offline leaves no such row — then the change waits for the owner (or, for staff
 * and PINs, which the cloud cannot apply later without the PIN, is sent again until the maker has signed in online).
 */
async function makerSignedInHere(ctx: ChangeContext, userId: string | null): Promise<boolean> {
  if (!userId) return false;
  const devices = new Set<string>();
  if (ctx.deviceId) devices.add(ctx.deviceId);
  if (ctx.branchId) {
    const { data: devs, error } = await supabase.from('user_devices').select('device_id')
      .eq('business_id', ctx.businessId).eq('branch_id', ctx.branchId);
    readOk(error, "the branch's tills");
    for (const d of (devs ?? []) as Row[]) if (d.device_id) devices.add(String(d.device_id));
  }
  if (!devices.size) return false;
  const since = new Date(Date.now() - MAKER_PROOF_DAYS * 86_400_000).toISOString();
  const { data, error } = await supabase.from('refresh_tokens').select('id')
    .eq('business_id', ctx.businessId).eq('user_id', userId).in('device_hint', [...devices]).gte('created_at', since).limit(1);
  readOk(error, 'who signed in here');
  return (data ?? []).length > 0;
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
    return writeRefusal(error);
  }
  if (c.entity === 'staff' && create) {
    // bcrypt, so the cashier is on every till's staff list (A446) at once — the web's create kept a legacy hash that the
    // lists skip until a first online sign-in.
    const hash = await bcrypt.hash(String(c.data.pin), 10);
    const { error } = await supabase.from('users').insert({ id: targetId, business_id: ctx.businessId, name: c.data.name,
      role_id: c.data.role_id, pin_hash: hash, status: 'active' });
    if (error) return writeRefusal(error);   // 23505 → 'already exists'; a transient failure throws (retry)
    if (ctx.branchId) await addToBranch(targetId, ctx.branchId);
    return null;
  }
  const values: Row = { ...c.data };
  if (c.entity === 'station' || c.entity === 'product') values.updated_at = new Date().toISOString();
  if (create) {
    const row: Row = { ...spec.defaults, ...values, id: targetId, business_id: ctx.businessId };
    if (c.entity === 'station') row.branch_id = ctx.branchId;
    const { error } = await supabase.from(spec.table).insert(row);
    return writeRefusal(error);
  }
  const { error } = await supabase.from(spec.table).update(values).eq('id', targetId).eq('business_id', ctx.businessId);
  return writeRefusal(error);
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
  const { data: seen, error: seenErr } = await supabase.from('change_requests').select('status, message, canonical_id')
    .eq('id', c.id).eq('business_id', ctx.businessId).maybeSingle();
  if (seenErr) return retryLater(c, new Error(`could not check the change: ${seenErr.message}`));   // P1-8b
  if (seen) return { id: c.id, status: (seen as Row).status, message: (seen as Row).message, canonical_id: (seen as Row).canonical_id };

  const spec = ENTITY_SPECS[c.entity];
  const done = async (r: ChangeResult, extra?: { cloud_value?: Row | null }) => { await record(ctx, c, r, extra); return r; };

  // Who may (A494):
  //   - a person's session: THEIR keys (callerOk), and they are who made it — a made_by in the body naming someone else
  //     is never believed (it decided the staff rules below: naming the owner skipped them);
  //   - the till's own session: the maker's keys, and the maker proven to have signed in at this branch (else held).
  const needed = changeKeys(c.entity, c.op, c.data);   // A490: all of them (a price change needs menu.prices, …)
  let holdForOwner = false;
  if (!ctx.tillSession) {
    const callerOk = ctx.callerIsOwner || holdsAll(ctx.callerKeys ?? [], needed);
    if (!callerOk) return done({ id: c.id, status: 'refused', message: 'You may not make this change' });
    if (c.made_by !== (ctx.callerUserId ?? null)) c = { ...c, made_by: ctx.callerUserId ?? null, made_by_name: null };
  } else {
    let maker: { ok: boolean };
    let proven = false;
    try {
      maker = await makerMay(ctx.businessId, c.made_by, needed);
      if (maker.ok) proven = await makerSignedInHere(ctx, c.made_by);
    } catch (e) { return retryLater(c, e); }
    if (!maker.ok) return done({ id: c.id, status: 'refused', message: `${c.made_by_name ?? 'Whoever made it'} may not make this change` });
    if (!proven) {
      // Staff and PINs cannot wait for the owner (the PIN is never stored here): sent again until the maker has signed in
      // online at this branch. Anything else waits for the owner's approval.
      if (c.entity === 'staff' || c.entity === 'staff_pin') {
        return { id: c.id, status: 'refused', retry: true,
          message: `${c.made_by_name ?? 'Whoever made it'} has not signed in online at this branch yet — it is sent again` };
      }
      holdForOwner = true;
    }
  }

  if (holdForOwner) {
    try {
      const { data: cur, error: curErr } = await supabase.from(spec.table).select('*').eq('id', c.entity_id).eq('business_id', ctx.businessId).maybeSingle();
      readOk(curErr, spec.table);
      await notifyOwner(ctx, c, 'A change from a till — your approval',
        `${describeChange(c, (cur as Row | null)?.name)} on a till, named as made by ${c.made_by_name ?? 'someone'} who has not signed in online at that branch. Approve to apply it.`);
      return done({ id: c.id, status: 'awaiting', message: 'who made it could not be confirmed — waiting for the owner' },
        { cloud_value: cur ? pick(cur as Row, Object.keys(c.data ?? {})) : null });
    } catch (e) { return retryLater(c, e); }
  }

  try {
    if (c.entity === 'staff' && c.op === 'create') {
      const { data: had, error: hadErr } = await supabase.from('users').select('id').eq('id', c.entity_id).eq('business_id', ctx.businessId).maybeSingle();
      readOk(hadErr, 'staff');
      if (had) return done({ id: c.id, status: 'identical' });
      // A manager may not add someone above themselves (the web's own rule).
      const makerIsOwner = await isOwnerOf(ctx.businessId, c.made_by);
      if (!makerIsOwner) {
        const { data: role, error: roleErr } = await supabase.from('roles').select('name').eq('id', c.data.role_id).maybeSingle();
        readOk(roleErr, 'role');
        // A490: by keys — the maker gives only a role holding nothing beyond them (never the owner's role).
        const mayGive = role ? await makerMayGiveRole(ctx.businessId, c.made_by, String(c.data.role_id), (role as Row).name) : false;
        if (!mayGive) return done({ id: c.id, status: 'refused', message: 'only the owner adds staff with that role' });
      }
      const clash = await pinTakenBy(ctx.businessId, String(c.data.pin), null);
      if (clash) {
        await notifyOwner(ctx, c, 'A PIN set on a till is already someone else\'s',
          `${c.data.name} (added on a till by ${c.made_by_name ?? 'a manager'}) was given ${clash}'s PIN — set a different one.`);
        return done({ id: c.id, status: 'refused', message: PIN_IN_USE });
      }
      const err = await write(ctx, c, c.entity_id, true);
      return err ? { id: c.id, status: 'refused', message: err } : done({ id: c.id, status: 'applied' });
    }

    if (c.op === 'create') {
      const { data: byId, error: byIdErr } = await supabase.from(spec.table).select('*').eq('id', c.entity_id).eq('business_id', ctx.businessId).maybeSingle();
      readOk(byIdErr, spec.table);
      let same = byId as Row | null;
      // The same thing created elsewhere under another id ("Grill" added on the web and on a till): by name (and category).
      if (!same && spec.sameBy.length) {
        let q = supabase.from(spec.table).select('*').eq('business_id', ctx.businessId);
        for (const k of spec.sameBy) q = c.data[k] === null || c.data[k] === undefined ? q.is(k, null) : (k === 'name' ? q.ilike(k, String(c.data[k]).replace(/[\\%_]/g, (m) => `\\${m}`)) : q.eq(k, c.data[k]));
        const { data: rows, error: sameErr } = await q.limit(1);
        readOk(sameErr, spec.table);
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

    const { data: cur, error: curErr } = await supabase.from(spec.table).select('*').eq('id', c.entity_id).eq('business_id', ctx.businessId).maybeSingle();
    readOk(curErr, spec.table);   // a failed read is never "it no longer exists"
    if (c.op === 'delete') {
      if (!cur) return done({ id: c.id, status: 'identical' });   // already gone
      const err = writeRefusal(c.entity === 'product'
        ? (await supabase.from('products').update({ status: 'inactive', updated_at: new Date().toISOString() }).eq('id', c.entity_id).eq('business_id', ctx.businessId)).error
        : (await supabase.from(spec.table).delete().eq('id', c.entity_id).eq('business_id', ctx.businessId)).error);
      return err ? { id: c.id, status: 'refused', message: err } : done({ id: c.id, status: 'applied' });
    }

    // Update.
    if (!cur) return done({ id: c.id, status: 'refused', message: 'it no longer exists on the cloud' });
    if (c.entity === 'staff_pin') {
      // Audit 2026-10-14: a PIN change is a staff edit — the same rules (routes/staff.ts PATCH): only the owner sets an owner's or an
      // admin's PIN, a manager sets the PINs of people at their own branch. Checked BEFORE the clash, so a refused change
      // never learns whose PIN it would have matched.
      const pinRefusal = await staffEditRefusal(ctx, c, cur as Row);
      if (pinRefusal) return done({ id: c.id, status: 'refused', message: pinRefusal });
      // Offline supersedes online — but a PIN is one person's: refused (and the owner told) when another has it.
      const clash = await pinTakenBy(ctx.businessId, String(c.data.pin), c.entity_id);
      if (clash) {
        await notifyOwner(ctx, c, 'A PIN set on a till is already someone else\'s',
          `${(cur as Row).name ?? 'A staff member'}'s new PIN (set on a till by ${c.made_by_name ?? 'a manager'}) is ${clash}'s too — set a different one.`);
        return done({ id: c.id, status: 'refused', message: PIN_IN_USE });
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
    // P1-8b: nothing here was decided — a read or write failed, or something unexpected threw. The till keeps the change
    // and sends it again (retry), instead of undoing what it created.
    return retryLater(c, e);
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
    const spec = ENTITY_SPECS[r.entity as keyof typeof ENTITY_SPECS];
    const target = r.canonical_id ?? r.entity_id;
    const values: Row = { ...(r.proposed ?? {}) };
    if (r.entity === 'station' || r.entity === 'product') values.updated_at = new Date().toISOString();
    // A494: a change held because its maker was not proven may be a delete, or a create the cloud does not have yet.
    if (r.op === 'delete') {
      const { error } = r.entity === 'product'
        ? await supabase.from('products').update({ status: 'inactive', updated_at: new Date().toISOString() }).eq('id', target).eq('business_id', businessId)
        : await supabase.from(spec.table).delete().eq('id', target).eq('business_id', businessId);
      if (error) return { ok: false, error: error.message };
    } else {
      const { data: there } = r.op === 'create'
        ? await supabase.from(spec.table).select('id').eq('id', target).eq('business_id', businessId).maybeSingle()
        : { data: { id: target } };
      const { error } = there
        ? await supabase.from(spec.table).update(values).eq('id', target).eq('business_id', businessId)
        : await supabase.from(spec.table).insert({ ...spec.defaults, ...values, id: target, business_id: businessId,
            ...(r.entity === 'station' ? { branch_id: r.branch_id ?? null } : {}) });
      if (error) return { ok: false, error: error.message };
    }
  }
  const status: ChangeStatus = approve ? 'approved' : 'rejected';
  await supabase.from('change_requests').update({ status, decided_by: by.id, decided_by_name: by.name, decided_at: new Date().toISOString() })
    .eq('id', id).eq('business_id', businessId);
  await supabase.from('notifications').update({ read_at: new Date().toISOString() })
    .eq('business_id', businessId).eq('type', 'change_approval').ilike('message', `%[change:${id}]%`);
  return { ok: true, status };
}

/** A490: may this maker (not the owner) give this role? Their own fine keys against the role's (lib/roleCeiling.ts). */
async function makerMayGiveRole(businessId: string, makerId: string | null, roleId: string, roleName: string | null): Promise<boolean> {
  if (!makerId) return false;
  const maker = await personKeys(businessId, makerId);
  if (!maker) return false;
  const keys = (await roleKeyMap([roleId])).get(roleId) ?? new Set<string>();
  return canAssignRole(maker.keys, { name: roleName, keys });
}

/** A459: why a staff edit from a till may not be made — the web's rules (routes/staff.ts PATCH) — or null. */
async function staffEditRefusal(ctx: ChangeContext, c: TillChange, cur: Row): Promise<string | null> {
  if (await isOwnerOf(ctx.businessId, c.made_by)) return null;
  const roleName = async (id: unknown) => {
    if (!id) return null;
    const { data } = await supabase.from('roles').select('name').eq('id', String(id)).maybeSingle();
    return (data as Row | null)?.name ?? null;
  };
  // A490: the owner's role is the owner's; anyone else is changed only by someone holding at least what they hold.
  if (await isOwnerOf(ctx.businessId, c.entity_id) || isOwnerRoleName(await roleName(cur.role_id))) return 'only the owner changes an owner or an admin';
  const maker = c.made_by ? await personKeys(ctx.businessId, c.made_by) : null;
  const target = await personKeys(ctx.businessId, c.entity_id);
  if (!maker || (target && keysBeyond(maker.keys, target.keys).length)) return 'only the owner changes someone with more rights than the one who made the change';
  if (c.data.role_id !== undefined && c.data.role_id !== cur.role_id
    && !(await makerMayGiveRole(ctx.businessId, c.made_by, String(c.data.role_id), await roleName(c.data.role_id)))) return 'only the owner gives that role';
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
