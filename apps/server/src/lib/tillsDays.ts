/**
 * tillsDays.ts — A523: "Tills & days" — every till of the business, its open trading day and drawers, and the actions that
 * close them from the cloud, for the owner, a manager of the branch, and ZapTill support.
 *
 * Owner, 2026-10-17: "I don't want this back and forth, clients not being able to do simple tasks day to day operations,
 * to make it worse there is no location on the cloud where I can close day as the owner or tech support remote force
 * close." Chose: the page for the owner (and managers holding shifts.close_day / shifts.force_close, their branch), the
 * same page in the admin portal for support (super admins AND agents), and the cloud wins:
 *
 *   • Close day takes effect AT ONCE on the cloud — the till's business_day is closed in the cloud's own database now
 *     (closed_at, closed_by, the note, expected = its drawers' expected cash, counted = the managers' confirmed shift
 *     counts — A452's rule — or the count entered), and a close is queued for the till (`cloud_closed` in its payload).
 *     When the till connects it adopts that close (branchClose.executeCloseDay closes its own day on its own books); its
 *     offline sales land on that day's drawers afterwards (lib/lateRows.ts). The till's own push of the same day never
 *     makes a second close and never reopens it before it has adopted it (mergeCloudClosedDays, routes/sync.ts).
 *     A drawer still open refuses (DRAWER_OPEN) unless the second tick "force-close the open drawer first" is given; a
 *     shift waiting for a manager's confirmation refuses (SHIFTS_UNCONFIRMED — confirm it on the web first).
 *   • Force-close drawer — uncounted (closed_unreconciled, as POST /api/shifts/:id/force-close) or, with a count, a
 *     counted close; the till adopts it (remoteShiftClose — its own expected cash kept, A521).
 *   • Cancel a stuck close (A522) — never one the web already carried out (the day is closed here; the till adopts it).
 *   • Close as abandoned (A522) — a retired or 24-h-silent till.
 * Every action: a REQUIRED reason, the last-sync tick for a silent till (A522), audit_log, the owner told.
 * routes/tills-days.ts (business sign-in) and routes/tillsDaysAdmin.ts (admin portal) call these; they decide who may.
 */
import { supabase } from './supabase';
import { computeExpectedCash } from '../routes/shifts';
import { notifyOwner, kes } from './ownerNotice';
import { mayAbandon, silentHours, ABANDON_SILENT_HOURS } from './dayCloseRules';
import { abandonTillDays } from './abandonTill';
import { sendEmailChecked } from './mailer';

/** A till heard from within this long is current — no tick asked (the web's lib/tillSync.ts RECENT_SYNC_MIN). */
export const SILENT_MINUTES = 15;
export const REASON_MAX = 300;
const r2 = (n: number) => Math.round(n * 100) / 100;

export function isSilent(lastSyncAt: string | null | undefined, now: Date = new Date()): boolean {
  return silentHours(lastSyncAt, now) * 60 >= SILENT_MINUTES;
}

/** Who is acting. A person of the business (owner / manager) has a userId; ZapTill support has `support` and no userId. */
export interface Actor {
  businessId: string;
  userId: string | null;
  /** "Mary", or "ZapTill support (agent@zaptill.co)". */
  name: string | null;
  /** The branch the caller is limited to; null = every branch (the owner, support). */
  branchId: string | null;
  support?: { adminId: string; email: string; role: string } | null;
}

export class TillsDaysError extends Error {
  constructor(public status: number, message: string, public code?: string, public extra: Record<string, unknown> = {}) { super(message); }
}

function mayReach(actor: Actor, branchId: string | null | undefined): boolean {
  if (actor.branchId === null) return true;
  return !!branchId && branchId === actor.branchId;
}

export function cleanReason(raw: unknown): string {
  const reason = typeof raw === 'string' ? raw.trim().slice(0, REASON_MAX) : '';
  if (!reason) throw new TillsDaysError(400, 'Say why (a short reason is required — it is kept with the close).', 'REASON_REQUIRED');
  return reason;
}

function cleanCount(raw: unknown): number | null {
  if (raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '')) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new TillsDaysError(400, 'The count must be 0 or more — or leave it empty.', 'BAD_COUNT');
  return r2(n);
}

const tillName = (d: { terminal_code?: string | null; device_label?: string | null; device_id?: string } | null | undefined, id: string) =>
  d?.terminal_code || d?.device_label || id.slice(0, 8);
const labelOf = (d: any, id: string) =>
  d?.terminal_code ? `${d.terminal_code}${d.device_label ? ` — ${d.device_label}` : ''}` : (d?.device_label ?? id);

async function namesOf(ids: Array<string | null | undefined>): Promise<Map<string, string>> {
  const want = [...new Set(ids.filter((x): x is string => !!x))];
  const out = new Map<string, string>();
  if (!want.length) return out;
  const { data } = await supabase.from('users').select('id, name').in('id', want);
  for (const u of (data ?? []) as Array<{ id: string; name: string | null }>) if (u.name) out.set(u.id, u.name);
  return out;
}

async function deviceOf(businessId: string, deviceId: string): Promise<any | null> {
  const { data, error } = await supabase.from('user_devices')
    .select('device_id, device_label, terminal_code, branch_id, status, last_sync_at, retired_at, app_version, device_role')
    .eq('business_id', businessId).eq('device_id', deviceId).maybeSingle();
  if (error) throw new Error(`till: ${error.message}`);
  return data ?? null;
}

function silentRefusal(dev: any, deviceId: string): TillsDaysError {
  const ago = Math.floor(silentHours(dev?.last_sync_at));
  const when = !dev?.last_sync_at ? 'has never synced' : ago < 1 ? 'last synced over 15 minutes ago' : `last synced ${ago} h ago`;
  return new TillsDaysError(409,
    `${tillName(dev, deviceId)} ${when} — its sales since then are not on the cloud yet; it applies this when it next connects. Tick to go ahead.`,
    'SILENT_CONFIRM_REQUIRED', { last_sync_at: dev?.last_sync_at ?? null });
}

// ── The overview ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface TillCard {
  device_id: string; label: string; terminal_code: string | null; device_label: string | null; device_role: string | null;
  branch_id: string | null; branch_name: string | null; app_version: string | null; last_sync_at: string | null;
  silent: boolean; long_silent: boolean; retired: boolean; on_fleet: boolean; may_abandon: boolean;
  open_days: Array<{ id: string; business_date: string; opened_at: string | null }>;
  open_drawers: Array<{ id: string; cashier_name: string; opened_at: string; opening_float: number; expected_cash: number | null; business_day_id: string | null }>;
  awaiting: Array<{ id: string; cashier_name: string; closed_at: string | null; business_day_id: string | null }>;
  pending: Array<{ id: string; business_date: string; created_at: string; delivered_at: string | null; waiting: boolean;
    code: string | null; error: string | null; cloud_closed: boolean; reason: string | null }>;
}

/** One answer with everything the page needs, per till, per branch. Figures (expected so far) only when `seesFigures`. */
export async function tillsOverview(businessId: string, o: { branchId: string | null; branchIds?: string[] | null; seesFigures: boolean; now?: Date }): Promise<{
  branches: Array<{ id: string; name: string }>; tills: TillCard[]; abandon_after_hours: number; silent_after_minutes: number; generated_at: string;
}> {
  const now = o.now ?? new Date();
  // A582: a partner's "All my branches" — exactly their branches (branchIds), never every branch
  const set = Array.isArray(o.branchIds) && o.branchIds.length ? o.branchIds : null;
  const scoped = <T>(q: T): T => (set ? (q as any).in('branch_id', set) : o.branchId ? (q as any).eq('branch_id', o.branchId) : q);

  let brQ = supabase.from('branches').select('id, name').eq('business_id', businessId);
  if (set) brQ = brQ.in('id', set);
  else if (o.branchId) brQ = brQ.eq('id', o.branchId);   // branches key on id, not branch_id
  const { data: brs, error: bErr } = await brQ;
  if (bErr) throw new Error(`branches: ${bErr.message}`);
  const branches = (brs ?? []) as Array<{ id: string; name: string }>;
  const branchName = new Map(branches.map((b) => [b.id, b.name]));

  const { data: devs, error: dErr } = await scoped(supabase.from('user_devices')
    .select('device_id, device_label, terminal_code, branch_id, status, last_sync_at, retired_at, app_version, device_role')
    .eq('business_id', businessId) as any) as any;
  if (dErr) throw new Error(`tills: ${dErr.message}`);
  const { data: days, error: dyErr } = await scoped(supabase.from('business_days').select('id, device_id, business_date, opened_at, branch_id')
    .eq('business_id', businessId).eq('status', 'open') as any) as any;
  if (dyErr) throw new Error(`open days: ${dyErr.message}`);
  const { data: open, error: oErr } = await scoped(supabase.from('shifts')
    .select('id, cashier_id, device_id, terminal_code, opened_at, opening_float, business_day_id, branch_id')
    .eq('business_id', businessId).eq('status', 'open') as any) as any;
  if (oErr) throw new Error(`open drawers: ${oErr.message}`);
  // The branch filter before the order / limit (filters first, then the transforms).
  const { data: aw, error: aErr } = await (scoped(supabase.from('shifts')
    .select('id, cashier_id, device_id, terminal_code, closed_at, business_day_id, branch_id')
    .eq('business_id', businessId).eq('status', 'closed').is('confirmed_at', null).not('declared_methods', 'is', null) as any) as any)
    .order('closed_at', { ascending: false }).limit(300);
  if (aErr) throw new Error(`shifts to confirm: ${aErr.message}`);
  const { data: ins, error: iErr } = await (scoped(supabase.from('day_close_instructions')
    .select('id, device_id, business_date, status, created_at, delivered_at, ack, payload, branch_id')
    .eq('business_id', businessId).eq('status', 'pending') as any) as any)
    .order('created_at', { ascending: false });
  if (iErr) throw new Error(`closes waiting: ${iErr.message}`);

  const names = await namesOf([...(open ?? []), ...(aw ?? [])].map((s: any) => s.cashier_id));
  const cards = new Map<string, TillCard>();
  const card = (deviceId: string, dev: any | null, branchId: string | null): TillCard => {
    let c = cards.get(deviceId);
    if (!c) {
      const b = dev?.branch_id ?? branchId ?? null;
      c = {
        device_id: deviceId, label: labelOf(dev, deviceId), terminal_code: dev?.terminal_code ?? null, device_label: dev?.device_label ?? null,
        device_role: dev?.device_role ?? null, branch_id: b, branch_name: b ? branchName.get(b) ?? null : null,
        app_version: dev?.app_version ?? null, last_sync_at: dev?.last_sync_at ?? null,
        silent: isSilent(dev?.last_sync_at, now), long_silent: silentHours(dev?.last_sync_at, now) >= ABANDON_SILENT_HOURS,
        retired: !!dev?.retired_at, on_fleet: !!dev, may_abandon: mayAbandon(dev, now),
        open_days: [], open_drawers: [], awaiting: [], pending: [],
      };
      cards.set(deviceId, c);
    }
    return c;
  };
  const devById = new Map<string, any>();
  for (const d of (devs ?? []) as any[]) {
    if (!d.device_id) continue;
    devById.set(d.device_id, d);
    // Every approved till (and a retired one, flagged) — one waiting for approval has no day of its own yet.
    if ((d.status ?? 'approved') === 'approved' || d.retired_at) card(d.device_id, d, d.branch_id ?? null);
  }
  for (const d of (days ?? []) as any[]) {
    if (!d.device_id) continue;
    card(d.device_id, devById.get(d.device_id) ?? null, d.branch_id ?? null).open_days.push({ id: d.id, business_date: d.business_date, opened_at: d.opened_at ?? null });
  }
  const openRows = ((open ?? []) as any[]).filter((s) => s.device_id);
  let figuresBudget = 60;   // expected so far is computed per drawer — bounded
  for (const s of openRows) {
    let expected: number | null = null;
    if (o.seesFigures && figuresBudget-- > 0) {
      try { expected = r2(await computeExpectedCash(s.id, Number(s.opening_float) || 0)); } catch { expected = null; }
    }
    card(s.device_id, devById.get(s.device_id) ?? null, s.branch_id ?? null).open_drawers.push({
      id: s.id, cashier_name: names.get(s.cashier_id) ?? 'Cashier', opened_at: s.opened_at, opening_float: Number(s.opening_float) || 0,
      expected_cash: expected, business_day_id: s.business_day_id ?? null,
    });
  }
  for (const s of ((aw ?? []) as any[]).filter((x) => x.device_id)) {
    card(s.device_id, devById.get(s.device_id) ?? null, s.branch_id ?? null).awaiting.push({
      id: s.id, cashier_name: names.get(s.cashier_id) ?? 'Cashier', closed_at: s.closed_at ?? null, business_day_id: s.business_day_id ?? null,
    });
  }
  for (const i of (ins ?? []) as any[]) {
    if (!i.device_id) continue;
    const ack = (i.ack ?? {}) as Record<string, any>;
    card(i.device_id, devById.get(i.device_id) ?? null, i.branch_id ?? null).pending.push({
      id: i.id, business_date: String(i.business_date ?? '').slice(0, 10), created_at: i.created_at, delivered_at: i.delivered_at ?? null,
      waiting: ack.waiting === true, code: ack.code ?? null, error: ack.error ?? null, cloud_closed: !!i.payload?.cloud_closed,
      reason: typeof i.payload?.reason === 'string' ? i.payload.reason : null,
    });
  }
  const tills = [...cards.values()]
    .filter((c) => !o.branchId || c.branch_id === o.branchId)
    .sort((a, b) => String(a.branch_name ?? '').localeCompare(String(b.branch_name ?? '')) || a.label.localeCompare(b.label));
  return { branches, tills, abandon_after_hours: ABANDON_SILENT_HOURS, silent_after_minutes: SILENT_MINUTES, generated_at: now.toISOString() };
}

// ── Audit and the owner ──────────────────────────────────────────────────────────────────────────────────────────────

async function audit(actor: Actor, action: string, table: string, recordId: string | null, branchId: string | null, after: Record<string, unknown>): Promise<void> {
  try {
    const { error } = await supabase.from('audit_log').insert({
      business_id: actor.businessId, branch_id: branchId, user_id: actor.userId, user_name: actor.name,
      action, table_name: table, record_id: recordId,
      after_data: { ...after, ...(actor.support ? { support: { admin_id: actor.support.adminId, email: actor.support.email, role: actor.support.role } } : {}) },
    });
    if (error) console.error('[tills-days] audit not written:', error.message);
  } catch (e) { console.error('[tills-days] audit not written:', (e as Error)?.message ?? e); }
}

/** The owner hears of it in the notifications list — not of their own action. */
async function tellOwner(actor: Actor, branchId: string | null, type: string, title: string, message: string): Promise<void> {
  try {
    if (actor.userId) {
      const { data: biz } = await supabase.from('businesses').select('owner_id').eq('id', actor.businessId).maybeSingle();
      if ((biz as any)?.owner_id && (biz as any).owner_id === actor.userId) return;
    }
  } catch { /* told anyway */ }
  await notifyOwner(actor.businessId, branchId, type, title, message, '/dashboard/tills-days');
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** A523: support acted on a client's till — the owner is e-mailed ("ZapTill support closed T2's day for 2026-10-15 —
 *  reason: …"). Never throws; the answer says whether it was sent. */
export async function emailOwnerOfSupportAction(businessId: string, line: string, detail: string): Promise<boolean> {
  try {
    const { data: biz } = await supabase.from('businesses').select('name, email').eq('id', businessId).maybeSingle();
    const to = String((biz as any)?.email ?? '').trim();
    if (!/@/.test(to)) return false;
    const sent = await sendEmailChecked({
      to,
      subject: line.slice(0, 180),
      html: `<div style="font-family:system-ui,sans-serif;font-size:15px;color:#0f172a">
  <p>Hi,</p>
  <p>${esc(line)}${(biz as any)?.name ? ` (<b>${esc((biz as any).name)}</b>)` : ''}.</p>
  <p>${esc(detail)}</p>
  <p>It is in your notifications and on the Tills &amp; days page. If you did not ask for this, call ZapTill support.</p></div>`,
    });
    if (!sent.ok) console.error('[tills-days] the owner was not e-mailed:', sent.error);
    return sent.ok === true;
  } catch (e) { console.error('[tills-days] the owner was not e-mailed:', (e as Error)?.message ?? e); return false; }
}

// ── Close a till's day — on the cloud, at once ───────────────────────────────────────────────────────────────────────

export interface CloseDayInput { deviceId: string; businessDate?: string | null; countedCash?: unknown; reason: unknown; forceDrawers?: boolean; silentOk?: boolean }
export interface CloseDayResult {
  ok: true; till: string; day: { id: string; business_date: string; closed_at: string; counted_cash: number; expected_cash: number; cash_variance: number };
  instruction_id: string | null; drawers_force_closed: string[]; counted_from: 'confirmed_shifts' | 'count_entered';
}

export async function cloudCloseDay(actor: Actor, input: CloseDayInput): Promise<CloseDayResult> {
  const reason = cleanReason(input.reason);
  const counted = cleanCount(input.countedCash);
  const deviceId = String(input.deviceId ?? '').trim();
  if (!deviceId) throw new TillsDaysError(400, 'device_id is required');
  const date = typeof input.businessDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.businessDate) ? input.businessDate : null;

  const dev = await deviceOf(actor.businessId, deviceId);
  let daysQ = supabase.from('business_days').select('id, business_date, branch_id, notes, status, opened_at')
    .eq('business_id', actor.businessId).eq('device_id', deviceId).eq('status', 'open');
  if (date) daysQ = daysQ.eq('business_date', date);
  const { data: days, error: dErr } = await daysQ.order('business_date', { ascending: true });
  if (dErr) throw new Error(`open days: ${dErr.message}`);
  const day = ((days ?? []) as any[])[0] ?? null;
  if (!dev && !day) throw new TillsDaysError(404, 'That till is not one of this business’s.');
  const branchId = dev?.branch_id ?? day?.branch_id ?? null;
  if (!mayReach(actor, branchId)) throw new TillsDaysError(403, 'You do not have access to this branch');
  if (dev?.retired_at) throw new TillsDaysError(409, 'This till is retired and will never adopt a close — close its day as abandoned instead.', 'TILL_RETIRED');
  if (!day) throw new TillsDaysError(409, `${tillName(dev, deviceId)} has no open trading day${date ? ` for ${date}` : ''} on the cloud.`, 'NOTHING_OPEN');
  if (isSilent(dev?.last_sync_at) && input.silentOk !== true) throw silentRefusal(dev, deviceId);

  // What is on that day: the drawers still open (the till's own, and any other on the day), the shifts to confirm.
  const { data: ownOpen, error: oErr } = await supabase.from('shifts').select('id, cashier_id, opened_at, opening_float, notes, business_day_id')
    .eq('business_id', actor.businessId).eq('device_id', deviceId).eq('status', 'open');
  if (oErr) throw new Error(`open drawers: ${oErr.message}`);
  const { data: dayShifts, error: sErr } = await supabase.from('shifts')
    .select('id, cashier_id, status, opened_at, closed_at, opening_float, notes, expected_cash, closing_float, confirmed_methods, confirmed_at, declared_methods')
    .eq('business_id', actor.businessId).eq('business_day_id', day.id);
  if (sErr) throw new Error(`the day's drawers: ${sErr.message}`);
  const openById = new Map<string, any>();
  for (const s of (ownOpen ?? []) as any[]) openById.set(s.id, s);
  for (const s of (dayShifts ?? []) as any[]) if (s.status === 'open') openById.set(s.id, s);
  const awaiting = ((dayShifts ?? []) as any[]).filter((s) => s.status === 'closed' && s.declared_methods != null && !s.confirmed_at);
  const names = await namesOf([...openById.values(), ...awaiting].map((s) => s.cashier_id));
  const hm = (iso: string | null | undefined) => (iso ? String(iso).slice(11, 16) : '?');

  if (awaiting.length) {
    throw new TillsDaysError(409,
      `${awaiting.length === 1 ? 'A shift must' : `${awaiting.length} shifts must`} be confirmed first: ` +
      awaiting.map((s) => `${names.get(s.cashier_id) ?? 'Cashier'} ${hm(s.opened_at)}–${hm(s.closed_at)}`).join(', ') +
      ' — confirm them on the web (Open drawers › Shifts to confirm), then close the day.',
      'SHIFTS_UNCONFIRMED', { shifts: awaiting.map((s) => ({ id: s.id, cashier_name: names.get(s.cashier_id) ?? 'Cashier', closed_at: s.closed_at ?? null })) });
  }
  if (openById.size && input.forceDrawers !== true) {
    const list = [...openById.values()].map((s) => ({ id: s.id, cashier_name: names.get(s.cashier_id) ?? 'Cashier', opened_at: s.opened_at }));
    throw new TillsDaysError(409,
      `${list.map((d) => `${d.cashier_name}'s drawer`).join(', ')} ${list.length === 1 ? 'is' : 'are'} still open on ${tillName(dev, deviceId)}. ` +
      'Count it on the till, close it here with a count, or tick “force-close the open drawer first” (recorded uncounted).',
      'DRAWER_OPEN', { drawers: list });
  }

  const now = new Date().toISOString();
  const forced: string[] = [];
  for (const s of openById.values()) {
    const expected = r2(await computeExpectedCash(s.id, Number(s.opening_float) || 0));   // throws on a failed read — nothing half-done
    const { data: done, error } = await supabase.from('shifts').update({
      status: 'closed_unreconciled', close_method: 'forced', closed_at: now, closed_by: actor.userId,
      expected_cash: expected, closing_float: null, cash_variance: null,
      notes: [s.notes, `Force-closed by manager: ${reason} (closed with the day on the web${actor.support ? ' by ZapTill support' : ''}).`].filter(Boolean).join('\n'),
    }).eq('id', s.id).eq('business_id', actor.businessId).eq('status', 'open').select('id').maybeSingle();
    if (error) throw new Error(`force-close ${s.id}: ${error.message}`);
    if (done) forced.push(s.id);
  }

  // The day's figures, as the till would close it (A452: the cash the managers confirmed, shift by shift; expected = the
  // drawers' own). Read again — the drawers just force-closed carry their expected cash now.
  const { data: after, error: aErr } = await supabase.from('shifts')
    .select('id, status, expected_cash, closing_float, confirmed_methods').eq('business_id', actor.businessId).eq('business_day_id', day.id);
  if (aErr) throw new Error(`the day's drawers: ${aErr.message}`);
  const rows = (after ?? []) as Array<{ status: string; expected_cash: unknown; closing_float: unknown; confirmed_methods: any }>;
  const expected = r2(rows.reduce((n, s) => n + (Number(s.expected_cash) || 0), 0));
  const confirmed = r2(rows.filter((s) => s.status === 'closed').reduce((n, s) => {
    const c = s.confirmed_methods && typeof s.confirmed_methods === 'object' ? Number(s.confirmed_methods.cash) : NaN;
    return n + (Number.isFinite(c) ? c : Number(s.closing_float) || 0);
  }, 0));
  const dayCounted = counted ?? confirmed;
  const variance = r2(dayCounted - expected);
  const who = actor.name ?? 'a manager';
  const note = `Closed on the web by ${who}: ${reason}. ` +
    (counted === null ? `Counted: the confirmed shift counts (${kes(confirmed)}).` : `Counted: ${kes(counted)}, entered on the web.`) +
    (forced.length ? ` ${forced.length} open drawer${forced.length === 1 ? '' : 's'} force-closed uncounted first.` : '') +
    ` The till adopts this close when it next connects; sales it made offline are added to its drawers when they arrive.`;
  const { data: closed, error: cErr } = await supabase.from('business_days').update({
    status: 'closed', closed_at: now, closed_by: actor.userId, counted_cash: dayCounted, expected_cash: expected, cash_variance: variance,
    notes: [day.notes, note].filter(Boolean).join('\n'), updated_at: now,
  }).eq('id', day.id).eq('business_id', actor.businessId).eq('status', 'open').select('id').maybeSingle();
  if (cErr) throw new Error(`close day ${day.business_date}: ${cErr.message}`);
  if (!closed) throw new TillsDaysError(409, 'That day was closed a moment ago — reload.', 'ALREADY_CLOSED');

  // Queued for the till: it adopts the close on its own books (one live close per till and day).
  await supabase.from('day_close_instructions').delete().eq('business_id', actor.businessId).eq('device_id', deviceId)
    .eq('business_date', day.business_date).eq('status', 'pending');
  const { data: queued, error: qErr } = await supabase.from('day_close_instructions').insert({
    business_id: actor.businessId, branch_id: branchId, device_id: deviceId, business_date: day.business_date,
    payload: {
      business_date: day.business_date, counted_cash: counted, notes: `Closed on the web by ${who}: ${reason}`, reason,
      closed_by_staff_id: actor.userId, closed_by_name: who, wait_for_till: true,
      cloud_closed: { at: now, by_name: who, counted_cash: dayCounted, expected_cash: expected },
    },
    status: 'pending', created_by: actor.userId,
  }).select('id').maybeSingle();
  if (qErr) console.error('[tills-days] the close was not queued for the till:', qErr.message);

  const till = tillName(dev, deviceId);
  await audit(actor, 'tills_days.close_day', 'business_days', day.id, branchId, {
    device_id: deviceId, till, business_date: day.business_date, reason, counted_cash: dayCounted, expected_cash: expected,
    cash_variance: variance, counted_from: counted === null ? 'confirmed_shifts' : 'count_entered', drawers_force_closed: forced,
    last_sync_at: dev?.last_sync_at ?? null, silent: isSilent(dev?.last_sync_at),
  });
  await tellOwner(actor, branchId, 'day_closed_on_web', `${till}: trading day ${day.business_date} closed on the web`,
    `${who} closed ${till}'s day for ${day.business_date} (${reason}). Counted ${kes(dayCounted)}, expected ${kes(expected)}, difference ${kes(variance)}.` +
    (forced.length ? ` ${forced.length} drawer${forced.length === 1 ? '' : 's'} force-closed uncounted.` : '') + ' The till adopts it when it next connects.');
  return {
    ok: true, till, day: { id: day.id, business_date: day.business_date, closed_at: now, counted_cash: dayCounted, expected_cash: expected, cash_variance: variance },
    instruction_id: (queued as any)?.id ?? null, drawers_force_closed: forced, counted_from: counted === null ? 'confirmed_shifts' : 'count_entered',
  };
}

// ── Force-close (or count-close) one drawer ──────────────────────────────────────────────────────────────────────────

export async function closeDrawer(actor: Actor, input: { shiftId: string; reason: unknown; countedCash?: unknown; silentOk?: boolean }): Promise<Record<string, unknown>> {
  const reason = cleanReason(input.reason);
  const counted = cleanCount(input.countedCash);
  const id = String(input.shiftId ?? '').trim();
  if (!id) throw new TillsDaysError(400, 'shift_id is required');
  const { data: shift, error } = await supabase.from('shifts').select('*').eq('id', id).eq('business_id', actor.businessId).maybeSingle();
  if (error) throw new Error(`drawer: ${error.message}`);
  if (!shift) throw new TillsDaysError(404, 'That drawer is not one of this business’s.', 'NOT_FOUND');
  const s = shift as Record<string, any>;
  if (!mayReach(actor, s.branch_id ?? null)) throw new TillsDaysError(403, 'You do not have access to this branch');
  if (s.status !== 'open') throw new TillsDaysError(409, 'That drawer is already closed.', 'ALREADY_CLOSED', { status: s.status });
  const dev = s.device_id ? await deviceOf(actor.businessId, s.device_id) : null;
  if (dev && isSilent(dev.last_sync_at) && input.silentOk !== true) throw silentRefusal(dev, s.device_id);

  const expected = r2(await computeExpectedCash(id, Number(s.opening_float) || 0));
  const { data: unpaid } = await supabase.from('orders').select('order_number').eq('business_id', actor.businessId).eq('shift_id', id).eq('status', 'open').limit(20);
  const unpaidNote = (unpaid ?? []).length
    ? ` ${unpaid!.length} unpaid kitchen order${unpaid!.length === 1 ? '' : 's'} (${(unpaid ?? []).slice(0, 4).map((o: any) => `#${o.order_number}`).join(', ')}) stay open on the till.`
    : '';
  const who = actor.name ?? 'a manager';
  const now = new Date().toISOString();
  const patch = counted === null
    ? { status: 'closed_unreconciled', close_method: 'forced', closed_at: now, closed_by: actor.userId, expected_cash: expected,
        closing_float: null, cash_variance: null,
        notes: [s.notes, `Force-closed by manager: ${reason}${actor.support ? ` (ZapTill support, ${actor.support.email})` : ''}.${unpaidNote}`].filter(Boolean).join('\n') }
    : { status: 'closed', close_method: 'counted', closed_at: now, closed_by: actor.userId, expected_cash: expected,
        closing_float: counted, cash_variance: r2(counted - expected),
        notes: [s.notes, `Closed on the web with a count by ${who}: ${reason}.${unpaidNote}`].filter(Boolean).join('\n') };
  const { data: closed, error: uErr } = await supabase.from('shifts').update(patch)
    .eq('id', id).eq('business_id', actor.businessId).eq('status', 'open').select('id, status, closed_at, expected_cash, closing_float, cash_variance').maybeSingle();
  if (uErr) throw new Error(`close drawer: ${uErr.message}`);
  if (!closed) throw new TillsDaysError(409, 'That drawer was closed a moment ago — reload.', 'ALREADY_CLOSED');

  const till = s.device_id ? tillName(dev, s.device_id) : (s.terminal_code || 'the web till');
  const cashier = (await namesOf([s.cashier_id])).get(s.cashier_id) ?? 'Cashier';
  await audit(actor, counted === null ? 'tills_days.force_close_drawer' : 'tills_days.count_close_drawer', 'shifts', id, s.branch_id ?? null, {
    device_id: s.device_id ?? null, till, cashier, reason, expected_cash: expected, counted_cash: counted,
    cash_variance: counted === null ? null : r2(counted - expected), last_sync_at: dev?.last_sync_at ?? null,
  });
  await tellOwner(actor, s.branch_id ?? null, 'drawer_closed_on_web', `${till}: ${cashier}'s drawer ${counted === null ? 'force-closed' : 'closed with a count'} on the web`,
    `${who} ${counted === null ? 'force-closed (uncounted)' : `closed with a count of ${kes(counted)}`} ${cashier}'s drawer on ${till} (${reason}). Expected ${kes(expected)}.` +
    ' The till closes it too when it next connects.');
  return { ok: true, till, cashier, shift: closed, counted: counted !== null };
}

// ── Withdraw a stuck close (A522) ────────────────────────────────────────────────────────────────────────────────────

export async function cancelClose(actor: Actor, input: { instructionId: string; reason: unknown }): Promise<Record<string, unknown>> {
  const reason = cleanReason(input.reason);
  const id = String(input.instructionId ?? '').trim();
  const { data: ins, error } = await supabase.from('day_close_instructions')
    .select('id, device_id, business_date, branch_id, status, delivered_at, payload').eq('id', id).eq('business_id', actor.businessId).maybeSingle();
  if (error) throw new Error(`close: ${error.message}`);
  if (!ins) throw new TillsDaysError(404, 'That close is not one of this business’s.');
  const i = ins as Record<string, any>;
  if (!mayReach(actor, i.branch_id ?? null)) throw new TillsDaysError(403, 'You do not have access to this branch');
  if (i.status !== 'pending') throw new TillsDaysError(409, 'That close is no longer waiting — nothing to withdraw.', 'NOT_PENDING', { status: i.status });
  if (i.payload?.cloud_closed) {
    throw new TillsDaysError(409, 'This day is already closed on the web — the till only adopts it. Withdrawing it would leave the till’s day open while the web shows it closed.', 'CLOUD_CLOSED');
  }
  const at = new Date().toISOString();
  const { data: done, error: upErr } = await supabase.from('day_close_instructions')
    .update({ status: 'cancelled', acked_at: at, ack: { ok: false, cancelled: true, by: actor.userId, by_name: actor.name, at, reason } })
    .eq('id', id).eq('business_id', actor.businessId).eq('status', 'pending').select('id, status').maybeSingle();
  if (upErr) throw new Error(`withdraw: ${upErr.message}`);
  if (!done) throw new TillsDaysError(409, 'The till answered just now — reload.', 'NOT_PENDING');
  const dev = await deviceOf(actor.businessId, i.device_id).catch(() => null);
  const till = tillName(dev, String(i.device_id));
  await audit(actor, 'tills_days.cancel_close', 'day_close_instructions', id, i.branch_id ?? null,
    { device_id: i.device_id, till, business_date: i.business_date, delivered: !!i.delivered_at, reason });
  await tellOwner(actor, i.branch_id ?? null, 'day_close_withdrawn', `${till}: a waiting day close was withdrawn`,
    `${actor.name ?? 'A manager'} withdrew the close of ${till}'s day ${String(i.business_date).slice(0, 10)} (${reason}).` +
    (i.delivered_at ? ' The till had already collected it and may still carry it out.' : ''));
  return { ok: true, id, status: 'cancelled', delivered: !!i.delivered_at, till };
}

// ── Close a dead / retired till's day as abandoned (A522) ────────────────────────────────────────────────────────────

export async function abandonDay(actor: Actor, input: { deviceId: string; businessDate?: string | null; reason: unknown; confirm?: boolean }): Promise<Record<string, unknown>> {
  const reason = cleanReason(input.reason);
  if (input.confirm !== true) throw new TillsDaysError(400, 'Tick that you understand the till’s unsent sales are not in this close.', 'CONFIRM_REQUIRED');
  const deviceId = String(input.deviceId ?? '').trim();
  if (!deviceId) throw new TillsDaysError(400, 'device_id is required');
  const businessDate = typeof input.businessDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.businessDate) ? input.businessDate : null;
  const dev = await deviceOf(actor.businessId, deviceId);
  let branchId = dev?.branch_id ?? null;
  if (!dev) {
    const { data: day } = await supabase.from('business_days').select('branch_id')
      .eq('business_id', actor.businessId).eq('device_id', deviceId).eq('status', 'open').limit(1).maybeSingle();
    if (!day) throw new TillsDaysError(404, 'That till has no open trading day here.');
    branchId = (day as any).branch_id ?? null;
  }
  if (!mayReach(actor, branchId)) throw new TillsDaysError(403, 'You do not have access to this branch');
  if (!mayAbandon(dev)) {
    const h = Math.floor(silentHours(dev?.last_sync_at));
    throw new TillsDaysError(409,
      `This till synced ${h < 1 ? 'within the last hour' : `${h} h ago`} — close its day instead (Close day). ` +
      `A day is closed as abandoned only for a retired till or one silent for ${ABANDON_SILENT_HOURS} h.`, 'TILL_NOT_SILENT');
  }
  const till = tillName(dev, deviceId);
  const result = await abandonTillDays({ businessId: actor.businessId, deviceId, branchId, userId: actor.userId, userName: actor.name,
    reason, till, lastSyncAt: dev?.last_sync_at ?? null, businessDate });
  if (!result.days.length) throw new TillsDaysError(409, 'That till has no open trading day on the cloud now.', 'NOTHING_OPEN');
  await audit(actor, 'tills_days.abandon', 'business_days', result.days[0]?.id ?? null, branchId,
    { device_id: deviceId, till, days: result.days.map((d) => d.business_date), shifts_force_closed: result.shifts.length, reason, last_sync_at: dev?.last_sync_at ?? null });
  await tellOwner(actor, branchId, 'day_closed_abandoned', `${till}: trading day closed without the till`,
    `${actor.name ?? 'A manager'} closed ${result.days.map((d) => d.business_date).join(', ')} on ${till} as abandoned (${reason}). ` +
    `${result.shifts.length} drawer${result.shifts.length === 1 ? '' : 's'} force-closed uncounted; sales the till made after it last synced are not in it.`);
  return { ok: true, till, ...result };
}

// ── The till's own push of a day the cloud closed (routes/sync.ts) ───────────────────────────────────────────────────

export interface PushedDay {
  id: string; device_id: string | null; business_date: string; status: string; closed_at: string | null; closed_by: string | null;
  counted_cash: unknown; expected_cash: unknown; cash_variance: unknown; notes: string | null; [k: string]: unknown;
}

/**
 * A523 — one close, never two. A day the web closed at once (cloudCloseDay) and the till's own row for it, pushed later:
 *   • the till still has it OPEN (it has not adopted the web's close yet — it was off, or the push went before the
 *     instruction): the cloud's close stands — the row is written with the cloud's status and close fields;
 *   • the till CLOSED it (it adopted the close, or a manager closed it there meanwhile): one close — the cloud's time and
 *     closer stand, the till's figures (its own books, offline sales in) replace the cloud's, the cloud's note is kept.
 * Only for days with a web close (`cloud_closed`, not withdrawn); every other row is untouched. After the till has adopted
 * the web's close (its instruction acked), a later open push is the till's own reopen for a new shift (A364) — let through.
 */
export async function mergeCloudClosedDays<T extends PushedDay>(businessId: string, rows: T[],
  existing: Array<{ id: string; status?: string | null; closed_at?: string | null; closed_by?: string | null; counted_cash?: unknown;
    expected_cash?: unknown; cash_variance?: unknown; notes?: string | null; device_id?: string | null; business_date?: string | null }>): Promise<T[]> {
  const closedHere = new Map(existing.filter((e) => e.status === 'closed').map((e) => [e.id, e]));
  const touched = rows.filter((r) => closedHere.has(r.id) && r.device_id);
  if (!touched.length) return rows;
  const devices = [...new Set(touched.map((r) => String(r.device_id)))];
  const dates = [...new Set(touched.map((r) => String(r.business_date).slice(0, 10)))];
  const { data: ins, error } = await supabase.from('day_close_instructions').select('device_id, business_date, status, payload')
    .eq('business_id', businessId).in('device_id', devices).in('business_date', dates);
  if (error) { console.error('[tills-days] web closes not read — the push is taken as sent:', error.message); return rows; }
  const webClose = new Map<string, string>();   // device|date → the instruction's status
  for (const i of (ins ?? []) as any[]) {
    if (!i?.payload?.cloud_closed || i.status === 'cancelled') continue;
    const k = `${i.device_id}|${String(i.business_date).slice(0, 10)}`;
    if (webClose.get(k) !== 'pending') webClose.set(k, i.status);
  }
  return rows.map((r) => {
    const have = closedHere.get(r.id);
    const st = have ? webClose.get(`${r.device_id}|${String(r.business_date).slice(0, 10)}`) : undefined;
    if (!have || !st) return r;
    if (r.status === 'open') {
      if (st !== 'pending') return r;   // adopted, then reopened on the till for a new shift (A364)
      return { ...r, status: 'closed', closed_at: have.closed_at ?? null, closed_by: have.closed_by ?? null, counted_cash: have.counted_cash ?? null,
        expected_cash: have.expected_cash ?? null, cash_variance: have.cash_variance ?? null, notes: have.notes ?? r.notes } as T;
    }
    const mine = String(r.notes ?? '');
    const keep = String(have.notes ?? '').split('\n').filter((l) => l.trim() && !mine.includes(l.trim()));
    return { ...r, closed_at: have.closed_at ?? r.closed_at, closed_by: have.closed_by ?? r.closed_by,
      notes: [mine.trim() || null, ...keep].filter(Boolean).join('\n') || null } as T;
  });
}
