// day-close.ts — A275: cloud relay for REMOTE day close (Option i).
// ─────────────────────────────────────────────────────────────────────────────
// The faithful remote form of branchClose.ts: a manager who is off-site queues a
// close_day instruction here; the till pulls it on its normal cloud sync, runs
// executeCloseDay() LOCALLY (computing its own expected cash + variance), and
// acks. The till stays the cash authority — the cloud never does cash arithmetic
// and never writes a business_days close directly (closes flow up, never down).
// A523: except Tills & days (routes/tills-days.ts, lib/tillsDays.ts) and A522's abandon — the web's close takes effect
// at once there, and the instruction it queues (payload.cloud_closed) is the till ADOPTING that close on its own books.
//
// Two audiences:
//   • Manager (requireAnyPermission shifts.force_close | settings.manage):
//       POST /instruct   — queue a close for a till (one live per till per day)
//       GET  /overview   — open trading days + latest instruction, for the screen
//       POST /:id/cancel — A522: withdraw a pending close (audited)
//       POST /abandon    — A522: close a retired / long-silent till's open day as abandoned (lib/abandonTill.ts)
//   • Till (requireAuth + X-Device-Id, same as /api/sync):
//       GET  /pending    — collect this till's pending instructions (marks delivered)
//       POST /ack        — record this till's verdict, retiring the instruction

import { requirePermission, assertBranchAccess, branchScope, branchFilter, byBranch } from '../middleware/rbac';
import { sendError } from '../lib/sendError';
import { safeRouter } from '../middleware/asyncHandler';
import { requireAuth } from '../middleware/auth';
import { supabase } from '../lib/supabase';
import { waitingCode, mayAbandon, silentHours, ABANDON_SILENT_HOURS } from '../lib/dayCloseRules';   // A522
import { abandonTillDays } from '../lib/abandonTill';   // A522
import { notifyOwner } from '../lib/ownerNotice';   // A522

const router = safeRouter();
router.use(requireAuth);

const MANAGER = requirePermission('shifts.close_day');

// Same normalisation as sync.ts / terminalKey.ts — a duplicated header arrives
// comma-joined, and device_id is the hard key.
function deviceIdOf(req: any): string {
  return String(req.header('X-Device-Id') ?? '').split(',')[0].trim().slice(0, 64);
}

/** A494: the till's own session, for itself — its id from its token; a header naming another device is refused. */
function ownTill(req: any): string | null {
  if (!req.isTill || !req.deviceId) return null;
  const said = deviceIdOf(req);
  return !said || said === req.deviceId ? String(req.deviceId) : null;
}

// ── Manager: queue a close for one till ──────────────────────────────────────
// Body: { device_id, business_date, counted_cash?, notes?, closed_by_name? }
// A522 (owner, 2026-10-17: "nothing may wait on a till that is switched off"): counted_cash is OPTIONAL. Absent / null /
// empty = "use the confirmed shift counts" — the till closes on the cash its managers confirmed shift by shift (A452,
// branchClose.executeCloseDay → confirmedDayCash), exactly as Close Branch does. An off-site manager no longer has to
// invent a figure, and an empty box is never turned into 0 (which recorded the whole drawer as short).
router.post('/instruct', MANAGER, async (req: any, res) => {
  const deviceId     = String(req.body?.device_id ?? '').trim();
  const businessDate = String(req.body?.business_date ?? '').trim();
  const rawCount     = req.body?.counted_cash;
  const countedCash  = rawCount === null || rawCount === undefined || (typeof rawCount === 'string' && rawCount.trim() === '') ? null : Number(rawCount);
  const notes        = typeof req.body?.notes === 'string' ? req.body.notes.trim() : undefined;
  const closedByName = typeof req.body?.closed_by_name === 'string' ? req.body.closed_by_name.trim() : null;

  if (!deviceId)                 { res.status(400).json({ error: 'device_id is required' }); return; }
  // A494: the till must be one of this business's, at a branch the caller works at — its branch is the device's own,
  // never one named in the body (a manager could queue a close for another branch's till).
  const { data: dev, error: devErr } = await supabase.from('user_devices').select('device_id, branch_id, retired_at')
    .eq('business_id', req.businessId).eq('device_id', deviceId).maybeSingle();
  if (devErr) { sendError(res, devErr); return; }
  if (!dev) { res.status(404).json({ error: 'That till is not one of this business’s' }); return; }
  const branchId = (dev as { branch_id?: string | null }).branch_id ?? null;
  if (!assertBranchAccess(req, branchId)) { res.status(403).json({ error: 'You do not have access to this branch' }); return; }
  // A522: a retired till never collects an instruction — its day is closed as abandoned (POST /abandon).
  if ((dev as { retired_at?: string | null }).retired_at) {
    res.status(409).json({ error: 'This till is retired and will never collect a close — close its day as abandoned instead.', code: 'TILL_RETIRED' });
    return;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) { res.status(400).json({ error: 'business_date must be YYYY-MM-DD' }); return; }
  if (countedCash !== null && (!Number.isFinite(countedCash) || countedCash < 0)) {
    res.status(400).json({ error: 'counted_cash must be 0 or more — or leave it empty to close on the confirmed shift counts' });
    return;
  }

  // The payload the till will hand straight to executeCloseDay(). business_date
  // is included so the till REFUSES a date mismatch rather than closing the
  // wrong day (branchClose.ts). A522: counted_cash null = the till's confirmed shift counts.
  const payload = {
    business_date: businessDate,
    counted_cash:  countedCash,
    notes,
    closed_by_staff_id: req.userId ?? null,
    closed_by_name:     closedByName,
  };

  // Replace any still-pending close for this till+day rather than stacking them
  // (mirrors createCloseInstruction). Then insert the new one.
  const del = await supabase
    .from('day_close_instructions')
    .delete()
    .eq('business_id', req.businessId)
    .eq('device_id', deviceId)
    .eq('business_date', businessDate)
    .eq('status', 'pending');
  if (del.error) { sendError(res, del.error); return; }

  const { data, error } = await supabase
    .from('day_close_instructions')
    .insert({
      business_id:   req.businessId,
      branch_id:     branchId,
      device_id:     deviceId,
      business_date: businessDate,
      payload,
      status:        'pending',
      created_by:    req.userId ?? null,
    })
    .select('id, device_id, business_date, status, created_at')
    .single();
  if (error) { sendError(res, error); return; }
  res.json(data);
});

// ── Till: collect this device's pending instructions ─────────────────────────
router.get('/pending', async (req: any, res) => {
  // A494: only a till's own session collects, and only its own (they carry the counted cash and who closes).
  const deviceId = ownTill(req);
  if (!deviceId) { res.status(403).json({ error: 'Only a till collects its own day-close instructions.', code: 'TILL_ONLY' }); return; }

  const { data, error } = await supabase
    .from('day_close_instructions')
    .select('id, payload')
    .eq('business_id', req.businessId)
    .eq('device_id', deviceId)
    .eq('status', 'pending')
    .order('created_at', { ascending: true });
  if (error) { sendError(res, error); return; }

  const rows = data ?? [];
  if (rows.length) {
    // Visibility for the manager screen; status stays 'pending' until an ack.
    const ids = rows.map((r: any) => r.id);
    await supabase
      .from('day_close_instructions')
      .update({ delivered_at: new Date().toISOString() })
      .in('id', ids)
      .is('delivered_at', null);
  }
  res.json(rows.map((r: any) => ({ id: r.id, kind: 'close_day', payload: r.payload })));
});

// ── Till: record a verdict, retiring the instruction ─────────────────────────
// Body: { instruction_id, ok, error?, summary? }
router.post('/ack', async (req: any, res) => {
  const deviceId      = ownTill(req);   // A494: the till's own session, for itself
  const instructionId = String(req.body?.instruction_id ?? '').trim();
  const ok            = req.body?.ok === true;
  if (!deviceId)      { res.status(403).json({ error: 'Only a till acknowledges its own day-close instructions.', code: 'TILL_ONLY' }); return; }
  if (!instructionId) { res.status(400).json({ error: 'instruction_id is required' }); return; }

  // A522: "not yet" is not "no". A drawer still open on the till, or a shift counted offline and not yet confirmed: the
  // instruction stays pending, the reason shown on the web — the till tries it again at every beat and closes as soon as
  // the drawer is closed / the shift confirmed. It used to be marked failed for good, and the till woke day-locked.
  const waiting = ok ? null : waitingCode(req.body);
  if (waiting) {
    const note = { ok: false, waiting: true, code: waiting, error: req.body?.error ?? null, summary: req.body?.summary ?? null, at: new Date().toISOString() };
    const { data: still, error: wErr } = await supabase
      .from('day_close_instructions')
      .update({ ack: note })
      .eq('id', instructionId)
      .eq('business_id', req.businessId)
      .eq('device_id', deviceId)          // a till can only answer its OWN instruction
      .eq('status', 'pending')
      .select('id, status')
      .maybeSingle();
    if (wErr) { sendError(res, wErr); return; }
    res.json({ ...(still ?? { id: instructionId, status: 'pending' }), waiting: true, code: waiting });
    return;
  }

  const ack = { ok, error: req.body?.error ?? null, summary: req.body?.summary ?? null };
  const { data, error } = await supabase
    .from('day_close_instructions')
    .update({ status: ok ? 'acked' : 'failed', ack, acked_at: new Date().toISOString() })
    .eq('id', instructionId)
    .eq('business_id', req.businessId)
    .eq('device_id', deviceId)          // a till can only ack its OWN instruction
    .eq('status', 'pending')
    .select('id, status')
    .maybeSingle();
  if (error) { sendError(res, error); return; }
  res.json(data ?? { id: instructionId, status: ok ? 'acked' : 'failed' });
});

// ── Manager: the screen — open trading days + latest instruction per till ────
router.get('/overview', MANAGER, async (req: any, res) => {
  // A494: a non-owner sees their own branch only (branchScope); the owner any branch, or every branch.
  // A550: a partner of every branch: the branch picked (branchScope keeps it to theirs), or every branch.
  const branchId = req.isOwner ? (String(req.query.branch_id ?? '').trim() || branchScope(req) || '')
    : req.allBranches ? (branchScope(req) || '') : String(branchScope(req) ?? '');

  // A582: a partner's "All my branches" — their branches combined (branchScope is NO_BRANCH there: never every branch)
  const bf = branchFilter(req);
  const setIds = bf.kind === 'set' ? bf.ids : null;
  const narrow = <Q>(q: Q): Q => (setIds ? byBranch(q, bf) : branchId ? (q as any).eq('branch_id', branchId) : q);

  let daysQ = supabase
    .from('business_days')
    .select('device_id, business_date, branch_id, status, opened_at')
    .eq('business_id', req.businessId)
    .eq('status', 'open');
  daysQ = narrow(daysQ);
  const { data: days, error: daysErr } = await daysQ;
  if (daysErr) { sendError(res, daysErr); return; }

  // A522: every approved till of the branch (or business), with when it last synced — the screen warns about a silent
  // one and lists them all; a retired till is never listed as one to close (its day can only be closed as abandoned).
  let devQ = supabase
    .from('user_devices')
    .select('device_id, device_label, terminal_code, branch_id, status, last_sync_at, retired_at')
    .eq('business_id', req.businessId);
  devQ = narrow(devQ);
  const { data: devRows } = await devQ;
  const devById = new Map<string, any>();
  for (const d of (devRows ?? []) as any[]) if (d.device_id) devById.set(d.device_id, d);
  const labelOf = (id: string): string => {
    const d = devById.get(id);
    if (!d) return id;
    return d.terminal_code ? `${d.terminal_code}${d.device_label ? ` — ${d.device_label}` : ''}` : (d.device_label ?? d.device_id);
  };

  const deviceIds = [...new Set([...(days ?? []).map((d: any) => d.device_id), ...devById.keys()].filter(Boolean))];

  // A522: the latest instruction for each till AND DAY — "Day D+1 · Closed" no longer shows the ack of day D's close.
  const latestByDay: Record<string, any> = {};
  const pendingByDevice: Record<string, any> = {};
  if (deviceIds.length) {
    const { data: ins } = await supabase
      .from('day_close_instructions')
      .select('id, device_id, business_date, status, created_at, delivered_at, acked_at, ack')
      .eq('business_id', req.businessId)
      .in('device_id', deviceIds)
      .order('created_at', { ascending: false });
    for (const row of ins ?? []) {
      const key = `${row.device_id}|${String(row.business_date ?? '').slice(0, 10)}`;
      if (!latestByDay[key]) latestByDay[key] = row;
      if (row.status === 'pending' && !pendingByDevice[row.device_id]) pendingByDevice[row.device_id] = row;
    }
  }

  const now = new Date();
  const dayRow = (d: any) => {
    const dev = devById.get(d.device_id) ?? null;
    return {
      device_id:     d.device_id,
      label:         labelOf(d.device_id),
      business_date: d.business_date,
      opened_at:     d.opened_at,
      last_sync_at:  dev?.last_sync_at ?? null,
      retired:       !!dev?.retired_at,
      may_abandon:   mayAbandon(dev, now),
      instruction:   latestByDay[`${d.device_id}|${String(d.business_date ?? '').slice(0, 10)}`] ?? null,
    };
  };
  const all = (days ?? []).map(dayRow);
  const tills = all.filter((t: any) => !t.retired);
  const retired_open_days = all.filter((t: any) => t.retired);
  const openDayOf = new Map<string, string>();
  for (const d of (days ?? []) as any[]) openDayOf.set(d.device_id, d.business_date);
  const devices = [...devById.values()]
    .filter((d: any) => !d.retired_at && (d.status ?? 'approved') === 'approved')
    .map((d: any) => ({
      device_id:    d.device_id,
      label:        labelOf(d.device_id),
      last_sync_at: d.last_sync_at ?? null,
      open_day:     openDayOf.get(d.device_id) ?? null,
      delivered_at: pendingByDevice[d.device_id]?.delivered_at ?? null,
    }));
  res.json({ branch_id: setIds ? null : branchId || null, tills, retired_open_days, devices, abandon_after_hours: ABANDON_SILENT_HOURS });
});

/** A522: a row in the business's audit log for a remote day-close decision (best-effort — never fails the action). */
async function audit(req: any, action: string, recordId: string | null, branchId: string | null, after: Record<string, unknown>): Promise<void> {
  try {
    const { data: me } = req.userId ? await supabase.from('users').select('name').eq('id', req.userId).maybeSingle() : { data: null };
    const { error } = await supabase.from('audit_log').insert({
      business_id: req.businessId, branch_id: branchId, user_id: req.userId ?? null, user_name: (me as any)?.name ?? null,
      action, table_name: 'day_close_instructions', record_id: recordId, after_data: after,
    });
    if (error) console.error('[day-close] audit not written:', error.message);
  } catch (e) { console.error('[day-close] audit not written:', (e as Error)?.message ?? e); }
}

// ── Manager: withdraw a pending remote close ─────────────────────────────────
// A522: "Close pending…" used to disable the button for ever when the till never came back. The owner or a holder of
// shifts.close_day withdraws it (audited). One the till already collected may still be carried out by it — the answer
// says so (delivered: true) and the screen warns.
router.post('/:id/cancel', MANAGER, async (req: any, res) => {
  const id = String(req.params.id ?? '').trim();
  const { data: ins, error } = await supabase.from('day_close_instructions')
    .select('id, device_id, business_date, branch_id, status, delivered_at')
    .eq('id', id).eq('business_id', req.businessId).maybeSingle();
  if (error) { sendError(res, error); return; }
  if (!ins) { res.status(404).json({ error: 'That close is not one of this business’s' }); return; }
  if (!assertBranchAccess(req, (ins as any).branch_id ?? null)) { res.status(403).json({ error: 'You do not have access to this branch' }); return; }
  if ((ins as any).status !== 'pending') { res.status(409).json({ error: 'That close is no longer waiting — nothing to withdraw.', code: 'NOT_PENDING', status: (ins as any).status }); return; }
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 300) : '';
  const at = new Date().toISOString();
  const { data: done, error: upErr } = await supabase.from('day_close_instructions')
    .update({ status: 'cancelled', acked_at: at, ack: { ok: false, cancelled: true, by: req.userId ?? null, at, reason: reason || null } })
    .eq('id', id).eq('business_id', req.businessId).eq('status', 'pending')
    .select('id, status').maybeSingle();
  if (upErr) { sendError(res, upErr); return; }
  if (!done) { res.status(409).json({ error: 'The till answered just now — reload.', code: 'NOT_PENDING' }); return; }
  await audit(req, 'day_close_cancelled', id, (ins as any).branch_id ?? null,
    { device_id: (ins as any).device_id, business_date: (ins as any).business_date, delivered: !!(ins as any).delivered_at, reason: reason || null });
  res.json({ id, status: 'cancelled', delivered: !!(ins as any).delivered_at });
});

// ── Manager: close a dead / retired till's open day as abandoned ─────────────
// A522: body { device_id, business_date?, reason, confirm: true }. Only for a till that is retired or has not synced for
// ABANDON_SILENT_HOURS (lib/dayCloseRules.ts) — one that is alive closes its own day (POST /instruct). The day is closed
// on the cloud with what the cloud knows (lib/abandonTill.ts: its open drawers force-closed uncounted, no count, the
// note says sales after its last sync are not in it); the till, should it come back, closes its own day too. Audited,
// and the owner is told.
router.post('/abandon', MANAGER, async (req: any, res) => {
  const deviceId = String(req.body?.device_id ?? '').trim();
  const businessDate = typeof req.body?.business_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.body.business_date) ? req.body.business_date : null;
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 300) : '';
  if (!deviceId) { res.status(400).json({ error: 'device_id is required' }); return; }
  if (!reason) { res.status(400).json({ error: 'Say why this till’s day is closed without it (e.g. the till is broken / replaced).', code: 'REASON_REQUIRED' }); return; }
  if (req.body?.confirm !== true) { res.status(400).json({ error: 'Tick that you understand the till’s unsent sales are not in this close.', code: 'CONFIRM_REQUIRED' }); return; }
  const { data: dev, error: devErr } = await supabase.from('user_devices')
    .select('device_id, branch_id, retired_at, last_sync_at, terminal_code, device_label')
    .eq('business_id', req.businessId).eq('device_id', deviceId).maybeSingle();
  if (devErr) { sendError(res, devErr); return; }
  // A till not on the fleet: its days' own branch decides access.
  let branchId = (dev as any)?.branch_id ?? null;
  if (!dev) {
    const { data: day } = await supabase.from('business_days').select('branch_id')
      .eq('business_id', req.businessId).eq('device_id', deviceId).eq('status', 'open').limit(1).maybeSingle();
    if (!day) { res.status(404).json({ error: 'That till has no open trading day here.' }); return; }
    branchId = (day as any).branch_id ?? null;
  }
  if (!assertBranchAccess(req, branchId)) { res.status(403).json({ error: 'You do not have access to this branch' }); return; }
  if (!mayAbandon(dev as any)) {
    const h = Math.floor(silentHours((dev as any)?.last_sync_at));
    res.status(409).json({
      error: `This till synced ${h < 1 ? 'within the last hour' : `${h} h ago`} — close its day normally (it closes itself at its next sync). ` +
             `A day is closed as abandoned only for a retired till or one silent for ${ABANDON_SILENT_HOURS} h.`,
      code: 'TILL_NOT_SILENT',
    });
    return;
  }
  const { data: me } = req.userId ? await supabase.from('users').select('name').eq('id', req.userId).maybeSingle() : { data: null };
  const till = (dev as any)?.terminal_code || (dev as any)?.device_label || deviceId.slice(0, 8);
  let result;
  try {
    result = await abandonTillDays({ businessId: req.businessId, deviceId, branchId, userId: req.userId ?? null, userName: (me as any)?.name ?? null,
      reason, till, lastSyncAt: (dev as any)?.last_sync_at ?? null, businessDate });
  } catch (e) { sendError(res, e as Error); return; }
  if (!result.days.length) { res.status(409).json({ error: 'That till has no open trading day on the cloud now.', code: 'NOTHING_OPEN' }); return; }
  await audit(req, 'day_closed_as_abandoned', null, branchId,
    { device_id: deviceId, till, days: result.days.map((d) => d.business_date), shifts_force_closed: result.shifts.length, reason, last_sync_at: (dev as any)?.last_sync_at ?? null });
  await notifyOwner(req.businessId, branchId, 'day_closed_abandoned',
    `${till}: trading day closed without the till`,
    `${(me as any)?.name ?? 'A manager'} closed ${result.days.map((d) => d.business_date).join(', ')} on ${till} as abandoned (${reason}). ` +
    `${result.shifts.length} drawer${result.shifts.length === 1 ? '' : 's'} force-closed uncounted; sales the till made after it last synced are not in it.`,
    '/dashboard/shifts');
  res.json({ ok: true, ...result });
});

export default router;
