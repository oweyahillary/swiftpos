/**
 * attendance.ts — A599: Attendance (premium), /api/attendance/*.
 *
 * Owner, 2026-10-27/28: punches come ONLY from a ZKTeco device (K90 Pro first), for everyone; the branch server pulls them
 * and sends them here; fingerprints never leave the device. Premium: the business's 'attendance' feature flag (set by
 * ZapTill in the admin portal) — OFF: every route here answers 403 { code: 'ATTENDANCE_OFF' } and the dashboard shows
 * nothing attendance-related. The rules (pairing, business day, hours, numbers) are lib/attendanceRules.ts.
 *
 * THE WEB (the dashboard; requireWebSurface): who may do what —
 *   attendance.view     GET /access, GET /report, GET /people
 *   attendance.edit     POST /punches (add), POST /punches/:id/move, POST /punches/:id/remove — each with a REQUIRED reason,
 *                       the original kept (voided, with who / when / why); GET /unmatched, POST /unmatched/link
 *   attendance.devices  GET/POST/PATCH/DELETE /devices, POST/PATCH /people (numbers, attendance-only people),
 *                       GET /device-users ("New on the device"), POST /device-users/link
 *   The owner and a partner (A550 web dashboard access) hold all three whatever their role; anyone else by their keys.
 *   Pay (hours × users.hourly_rate) is in the report only for the owner or a holder of staff.pay — else no pay field at all.
 *   Branches: the owner names one (?branch_id, else X-Branch-Id) or sees all; anyone else their own (rbac.branchFilter).
 *
 * THE BRANCH SERVER (/node/*): a confirmed branch server of the business (lib/branchDrawers.ts serverBranch — the device's
 * own session, role node/office confirmed, approved, not retired), for ITS branch only (the device's branch on the cloud,
 * never one it names):
 *   GET  /node/config                 → { branch_id, utc_offset_minutes, devices: [{ id, name, ip, port, comm_key, serial }],
 *                                         people: [{ person_id, attendance_no, name }], actions: [{ id, device_id, action,
 *                                         attendance_no, name, overwrite }] }  — one call a beat: what to pull from and what
 *                                         to do. overwrite false: write only onto an empty slot or the same name; a delete
 *                                         removes the user only if it still carries that name.
 *   POST /node/punches                { device_id, punches: [{ device_user_id, at (ISO), status?, punch?, uid? }] } (≤ 500)
 *                                     → { accepted, duplicates, unmatched, refused: [{ index, error }] }. Idempotent: the
 *                                       unique (business, device serial, device user id, time) — a resend is a duplicate.
 *   POST /node/devices/:id/state      { serial?, model?, firmware?, clock_drift_s?, error?, users_on_device?,
 *                                       punches_on_device?, pulled_at?, users?: [{ device_user_id, name, privilege, uid }] }
 *                                     → { ok, queued } — the device's identity, health and user list; what is missing on
 *                                       the device (or should go) is queued as actions.
 *   POST /node/actions/:id/ack        { ok: boolean, error? } → { ok, status } — done, or failed after 5 tries.
 */
import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { safeRouter } from '../middleware/asyncHandler';
import { requireAuth, requireWebSurface } from '../middleware/auth';
import { can, branchFilter, byBranch, assertBranchAccess, rowInBranches, NO_BRANCH, type BranchFilter } from '../middleware/rbac';
import { supabase } from '../lib/supabase';
import { getDayCutoff } from '../lib/dayCutoff';
import { businessRangeEAT, businessDateEAT } from '../lib/businessDay';
import { serverBranch } from '../lib/branchDrawers';
import { traffic } from '../lib/trafficStats';
import {
  ATTENDANCE_OFF_MESSAGE, MAX_SHIFT_HOURS, INGEST_MAX, rangeError, personPeriod, estimatePay, nextFreeNumber,
  cleanAttendanceNo, cleanPersonName, cleanIncomingPunch, newOnDevice, deviceDiff, datesBetween, deviceName,
  type Punch, type Correction, type DeviceUser, type IncomingPunch,
} from '../lib/attendanceRules';
import { attendanceEnabled, queuePersonOnDevices, takenNumbers, nextNumber, deviceClaims, type PersonRow } from '../lib/attendanceStore';
import { cloudFactsFor } from '../lib/cloudPlan';                 // A612
import { featureBranches } from '../lib/branchBilling';           // A612: premium per branch

const router = safeRouter();
router.use(requireAuth);

/** An id as it can be looked up (uuids in the database; anything else simply finds nothing). */
const UUID = /^[0-9A-Za-z-]{1,64}$/;
const PERSON_COLS = 'id, business_id, branch_id, user_id, name, attendance_no, active';
const PUNCH_COLS = 'id, staff_id, person_id, branch_id, event_type, recorded_at, source, device_id, attendance_no, device_user_id, reason, created_by, corrects_id, voided_at, voided_by, void_reason, created_at';
const ACTION_MAX_TRIES = 5;
const off = (res: Response) => res.status(403).json({ error: ATTENDANCE_OFF_MESSAGE, code: 'ATTENDANCE_OFF' });
/** A612 phase 4 (premium per branch): billed per branch, the branches that pay for Attendance (premium or the package);
 *  null: billed as one — the business's flag alone, as before. */
const attendanceBranches = async (businessId: string | null | undefined): Promise<string[] | null> =>
  (businessId ? featureBranches(await cloudFactsFor(businessId).catch(() => null), 'attendance') : null);
const nowIso = () => new Date().toISOString();

// ── The branch server ──────────────────────────────────────────────────────────────────────────────────────────────
type NodeReq = Request & { attBranch?: string };
async function nodeGate(req: NodeReq, res: Response, next: NextFunction): Promise<void> {
  const who = await serverBranch({ businessId: req.businessId, deviceId: req.deviceId ?? null, isTill: !!req.isTill, surface: req.surface ?? null });
  if ('status' in who) { res.status(who.status).json({ error: who.error, code: who.code }); return; }
  if (!(await attendanceEnabled(req.businessId))) { off(res); return; }
  // A612: a branch that does not pay for Attendance — its branch server reads no device
  const paying = await attendanceBranches(req.businessId);
  if (paying && !paying.includes(who.branchId)) { off(res); return; }
  req.attBranch = who.branchId;
  next();
}
const nodeRouter = safeRouter();
nodeRouter.use(nodeGate);

/** A device of the server's own branch (not removed), or null. */
async function ownDevice(req: NodeReq, id: string): Promise<any | null> {
  if (!UUID.test(id)) return null;
  const { data } = await supabase.from('attendance_devices').select('id, branch_id, serial, name')
    .eq('id', id).eq('business_id', req.businessId).eq('branch_id', req.attBranch!).is('removed_at', null).maybeSingle();
  return data ?? null;
}

nodeRouter.get('/config', async (req: NodeReq, res) => {
  traffic.count('attendance.node_config');
  const b = req.attBranch!;
  const [devices, people, actions] = await Promise.all([
    supabase.from('attendance_devices').select('id, name, ip, port, comm_key, serial').eq('business_id', req.businessId).eq('branch_id', b).is('removed_at', null),
    supabase.from('attendance_people').select('id, attendance_no, name').eq('business_id', req.businessId).eq('branch_id', b).eq('active', true),
    supabase.from('attendance_device_actions').select('id, device_id, action, attendance_no, name, overwrite, created_at').eq('business_id', req.businessId).eq('branch_id', b)
      .eq('status', 'pending').order('created_at', { ascending: true }).limit(200),
  ]);
  const err = devices.error ?? people.error ?? actions.error;
  if (err) { res.status(503).json({ error: 'Attendance could not be read right now - the branch server asks again shortly.', code: 'ATTENDANCE_BUSY' }); return; }
  res.set('Cache-Control', 'no-store');
  res.json({
    branch_id: b, utc_offset_minutes: 180,
    devices: devices.data ?? [],
    people: ((people.data ?? []) as any[]).map((p) => ({ person_id: p.id, attendance_no: p.attendance_no, name: p.name })),
    actions: actions.data ?? [],
  });
});

nodeRouter.post('/punches', async (req: NodeReq, res) => {
  const body = req.body ?? {};
  const dev = await ownDevice(req, String(body.device_id ?? ''));
  if (!dev) { res.status(404).json({ error: 'That device is not one of this branch\'s attendance devices.', code: 'DEVICE_NOT_FOUND' }); return; }
  if (!dev.serial) { res.status(409).json({ error: 'Report the device\'s state (its serial number) before its punches.', code: 'DEVICE_SERIAL_UNKNOWN' }); return; }
  const list = Array.isArray(body.punches) ? body.punches : null;
  if (!list) { res.status(400).json({ error: 'punches must be a list.', code: 'BAD_PUNCHES' }); return; }
  if (list.length > INGEST_MAX) { res.status(413).json({ error: `At most ${INGEST_MAX} punches a call.`, code: 'TOO_MANY_PUNCHES' }); return; }
  const refused: Array<{ index: number; error: string }> = [];
  const clean: IncomingPunch[] = [];
  list.forEach((raw: unknown, index: number) => {
    const c = cleanIncomingPunch(raw);
    if ('error' in c) refused.push({ index, error: c.error }); else clean.push(c);
  });
  // the numbers → people (one read); a number nobody has is kept with its number ("Not matched")
  const nos = [...new Set(clean.map((c) => cleanAttendanceNo(c.device_user_id)).filter((n): n is number => n !== null))];
  const byNo = new Map<number, PersonRow>();
  if (nos.length) {
    const { data, error } = await supabase.from('attendance_people').select(PERSON_COLS).eq('business_id', req.businessId).in('attendance_no', nos);
    if (error) { res.status(503).json({ error: 'The punches could not be stored right now - send them again.', code: 'ATTENDANCE_BUSY' }); return; }
    for (const p of (data ?? []) as PersonRow[]) byNo.set(p.attendance_no, p);
  }
  // …and only where the slot on THIS device is theirs (written or linked by this system). A device's own people from
  // before ZapTill share numbers with ours (a real K40: 138 people from 1) — their punches stay "Not matched".
  let claims = new Map<number, string | null>();
  if (byNo.size) {
    try { claims = (await deviceClaims(req.businessId, [dev.id], [...byNo.keys()])).get(dev.id) ?? claims; }
    catch { res.status(503).json({ error: 'The punches could not be stored right now - send them again.', code: 'ATTENDANCE_BUSY' }); return; }
  }
  // one row per key (a batch may carry the same punch twice)
  const seen = new Set<string>();
  const rows: any[] = [];
  for (const c of clean) {
    const k = `${c.device_user_id}|${c.at}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const no = cleanAttendanceNo(c.device_user_id);
    const cand = no !== null ? byNo.get(no) : undefined;
    const person = cand && claims.get(no!) === cand.id ? cand : undefined;
    rows.push({
      id: randomUUID(),   // the dedupe is the unique (business, serial, device user, time), never the id
      business_id: req.businessId, branch_id: dev.branch_id, staff_id: person?.user_id ?? null, person_id: person?.id ?? null,
      event_type: 'punch', recorded_at: c.at, source: 'device', device_id: dev.id, device_serial: dev.serial,
      device_user_id: c.device_user_id, attendance_no: no, raw_status: c.status, raw_punch: c.punch,
    });
  }
  let accepted = 0;
  if (rows.length) {
    const { data, error } = await supabase.from('clock_events')
      .upsert(rows, { onConflict: 'business_id,device_serial,device_user_id,recorded_at', ignoreDuplicates: true })
      .select('id, person_id');
    if (error) { console.warn(`[attendance] punches: ${error.message}`); res.status(503).json({ error: 'The punches could not be stored right now - send them again.', code: 'ATTENDANCE_BUSY' }); return; }
    accepted = (data ?? []).length;
  }
  await supabase.from('attendance_devices').update({ last_pull_at: nowIso(), updated_at: nowIso() }).eq('id', dev.id).eq('business_id', req.businessId);
  traffic.count('attendance.punches', accepted);
  res.json({ accepted, duplicates: clean.length - accepted, unmatched: rows.filter((r) => !r.person_id).length, refused });
});

nodeRouter.post('/devices/:id/state', async (req: NodeReq, res) => {
  const dev = await ownDevice(req, req.params.id);
  if (!dev) { res.status(404).json({ error: 'That device is not one of this branch\'s attendance devices.', code: 'DEVICE_NOT_FOUND' }); return; }
  const b = req.body ?? {};
  const text = (v: unknown, max = 64) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
  const int = (v: unknown) => (Number.isInteger(v) && Math.abs(v as number) < 1e9 ? (v as number) : undefined);
  const upd: Record<string, unknown> = { updated_at: nowIso() };
  const serial = text(b.serial);
  if (serial) {
    // a serial another of the business's devices already has is refused (two rows must never share a dedupe key)
    const { data: twin } = await supabase.from('attendance_devices').select('id').eq('business_id', req.businessId).eq('serial', serial).is('removed_at', null).neq('id', dev.id).maybeSingle();
    if (twin) { res.status(409).json({ error: 'Another attendance device of this business has that serial number.', code: 'SERIAL_TAKEN' }); return; }
    if (dev.serial && dev.serial !== serial) { res.status(409).json({ error: 'This is a different device from the one set up here - set it up again on the web.', code: 'SERIAL_CHANGED' }); return; }
    upd.serial = serial;
  }
  for (const k of ['model', 'firmware'] as const) { const v = text(b[k]); if (v) upd[k] = v; }
  for (const k of ['clock_drift_s', 'users_on_device', 'punches_on_device'] as const) { const v = int(b[k]); if (v !== undefined) upd[k] = v; }
  if (typeof b.error === 'string' && b.error.trim()) { upd.last_error = b.error.trim().slice(0, 300); upd.last_error_at = nowIso(); }
  else if (b.error === null) upd.last_error = null;
  if (typeof b.pulled_at === 'string' && Number.isFinite(Date.parse(b.pulled_at))) upd.last_pull_at = new Date(b.pulled_at).toISOString();
  const { error } = await supabase.from('attendance_devices').update(upd).eq('id', dev.id).eq('business_id', req.businessId);
  if (error) { res.status(503).json({ error: 'The device could not be updated right now.', code: 'ATTENDANCE_BUSY' }); return; }

  let queued = 0, clashes = 0;
  if (Array.isArray(b.users)) {
    const users: DeviceUser[] = (b.users as any[]).slice(0, 5000).map((u) => ({
      device_user_id: typeof u?.device_user_id === 'number' ? String(u.device_user_id) : String(u?.device_user_id ?? u?.user_id ?? '').trim(),
      name: typeof u?.name === 'string' ? u.name.slice(0, 60) : null,
      privilege: Number.isInteger(u?.privilege) ? u.privilege : 0,
      uid: Number.isInteger(u?.uid) ? u.uid : null,
    })).filter((u) => /^[0-9A-Za-z]{1,9}$/.test(u.device_user_id));
    await supabase.from('attendance_device_users').delete().eq('device_id', dev.id).eq('business_id', req.businessId);
    if (users.length) {
      const { error: e2 } = await supabase.from('attendance_device_users').insert(users.map((u) => ({
        business_id: req.businessId, device_id: dev.id, device_user_id: u.device_user_id, device_uid: u.uid, name: u.name, privilege: u.privilege ?? 0, seen_at: nowIso(),
      })));
      if (e2) console.warn(`[attendance] device users: ${e2.message}`);
    }
    // what the device should hold against what it holds → actions (not already pending)
    const { data: ppl } = await supabase.from('attendance_people').select(PERSON_COLS).eq('business_id', req.businessId);
    const all = (ppl ?? []) as PersonRow[];
    const want = all.filter((p) => p.active && p.branch_id === dev.branch_id).map((p) => ({ attendance_no: p.attendance_no, name: p.name, id: p.id }));
    const retired = all.filter((p) => !p.active || p.branch_id !== dev.branch_id).map((p) => p.attendance_no);
    const claims = (await deviceClaims(req.businessId, [dev.id])).get(dev.id) ?? new Map();
    const diff = deviceDiff(want, users, retired, claims);
    clashes = diff.clashes.length;
    // an automatic write queued while the slot looked free, which now holds someone else: cancelled (never run over them)
    const clashNos = diff.clashes.map((c) => c.attendance_no);
    if (clashNos.length) {
      await supabase.from('attendance_device_actions').update({ status: 'cancelled', done_at: nowIso(), last_error: 'that number on the device is someone else' })
        .eq('business_id', req.businessId).eq('device_id', dev.id).eq('status', 'pending').eq('action', 'write_user').eq('overwrite', false).in('attendance_no', clashNos);
    }
    const { data: pend } = await supabase.from('attendance_device_actions').select('attendance_no, action').eq('business_id', req.businessId).eq('device_id', dev.id).eq('status', 'pending');
    const pending = new Set(((pend ?? []) as any[]).map((a) => `${a.action}|${a.attendance_no}`));
    const rows = [
      ...diff.write.filter((p) => !pending.has(`write_user|${p.attendance_no}`)).map((p) => ({ action: 'write_user', attendance_no: p.attendance_no, name: deviceName(p.name), person_id: p.id ?? null,
        overwrite: p.id !== undefined && (claims.get(p.attendance_no) ?? null) === p.id })),
      ...diff.remove.filter((n) => !pending.has(`delete_user|${n}`)).map((n) => { const who = all.find((p) => p.attendance_no === n);
        return { action: 'delete_user', attendance_no: n, name: who ? deviceName(who.name) : null, person_id: who?.id ?? null, overwrite: false }; }),
    ].map((r) => ({ ...r, business_id: req.businessId, branch_id: dev.branch_id, device_id: dev.id, status: 'pending' }));
    if (rows.length) {
      const { error: e3 } = await supabase.from('attendance_device_actions').insert(rows);
      if (!e3) queued = rows.length;
    }
  }
  res.json({ ok: true, queued, clashes });
});

nodeRouter.post('/actions/:id/ack', async (req: NodeReq, res) => {
  if (!UUID.test(req.params.id)) { res.status(404).json({ error: 'Action not found.', code: 'ACTION_NOT_FOUND' }); return; }
  const { data: a } = await supabase.from('attendance_device_actions').select('id, status, attempts, action, device_id, attendance_no, person_id, created_at')
    .eq('id', req.params.id).eq('business_id', req.businessId).eq('branch_id', req.attBranch!).maybeSingle();
  if (!a) { res.status(404).json({ error: 'Action not found.', code: 'ACTION_NOT_FOUND' }); return; }
  if ((a as any).status !== 'pending') { res.json({ ok: true, status: (a as any).status }); return; }
  const done = req.body?.ok === true;
  const attempts = ((a as any).attempts ?? 0) + 1;
  const status = done ? 'done' : attempts >= ACTION_MAX_TRIES ? 'failed' : 'pending';
  const lastError = done ? null : String(req.body?.error ?? 'failed').slice(0, 300);
  await supabase.from('attendance_device_actions').update({ status, attempts, last_error: lastError, done_at: status === 'pending' ? null : nowIso() })
    .eq('id', (a as any).id).eq('business_id', req.businessId);
  // the slot is theirs now: punches from it that came in while the write waited (a lost acknowledgement is repeated next
  // run) are theirs too — only from that device, that number, and since the write was queued
  const w = a as any;
  if (done && w.action === 'write_user' && w.person_id) {
    const { data: p } = await supabase.from('attendance_people').select('id, user_id').eq('id', w.person_id).eq('business_id', req.businessId).maybeSingle();
    if (p) {
      let q = supabase.from('clock_events').update({ person_id: (p as any).id, staff_id: (p as any).user_id ?? null })
        .eq('business_id', req.businessId).eq('source', 'device').eq('device_id', w.device_id).eq('attendance_no', w.attendance_no).is('person_id', null);
      if (w.created_at) q = q.gte('recorded_at', w.created_at);
      await q;
    }
  }
  res.json({ ok: true, status });
});

router.use('/node', nodeRouter);

// ── The web ────────────────────────────────────────────────────────────────────────────────────────────────────────
router.use(requireWebSurface);
router.use(async (req, res, next) => {
  if (!(await attendanceEnabled(req.businessId))) { off(res); return; }
  // A612: billed per branch — only the branches that pay for Attendance (none: off)
  const paying = await attendanceBranches(req.businessId);
  if (paying && !paying.length) { off(res); return; }
  (req as { attendanceBranches?: string[] | null }).attendanceBranches = paying;
  next();
});

type Right = 'attendance.view' | 'attendance.edit' | 'attendance.devices';
/** The owner and a partner hold all three (owner decision, A599); anyone else by their keys. */
export function mayAttendance(req: Request, key: Right): boolean {
  return req.isOwner === true || req.webPartner === true || can(req, key);
}
/** Pay figures: the owner, or a holder of staff.pay. */
export const maySeePay = (req: Request): boolean => req.isOwner === true || can(req, 'staff.pay');
const need = (key: Right) => (req: Request, res: Response, next: NextFunction) => {
  if (mayAttendance(req, key)) { next(); return; }
  res.status(403).json({ error: 'Forbidden', detail: `Missing permission: ${key}` });
};

/** The branches a read covers: the owner names one (?branch_id first — the page's own picker — then X-Branch-Id) or all. */
function readScope(req: Request): BranchFilter {
  const f = readScopeBefore(req);
  // A612: billed per branch — the branches that pay for Attendance only
  const paying = (req as { attendanceBranches?: string[] | null }).attendanceBranches;
  if (!paying) return f;
  if (f.kind === 'one') return paying.includes(f.id) ? f : { kind: 'one', id: NO_BRANCH };
  const ids = (f.kind === 'set' ? f.ids : paying).filter((b) => paying.includes(b) && !req.pausedBranches?.has(b));
  return ids.length ? { kind: 'set', ids } : { kind: 'one', id: NO_BRANCH };
}
function readScopeBefore(req: Request): BranchFilter {
  if (req.isOwner) {
    const q = typeof req.query.branch_id === 'string' ? req.query.branch_id.trim() : '';
    const h = String(req.headers['x-branch-id'] ?? '').trim();
    const one = q && q !== 'all' ? q : !q && h && h !== 'all' && h !== 'mine' ? h : '';
    // A612: a paused branch named is nobody's (NO_BRANCH); none named while some are paused — the open ones (branchFilter).
    if (one) return { kind: 'one', id: req.pausedBranches?.has(one) ? NO_BRANCH : one };
    return req.pausedBranches?.size ? branchFilter(req) : { kind: 'all' };
  }
  return branchFilter(req);
}
const reason = (v: unknown): string | null => (typeof v === 'string' && v.trim().length >= 3 ? v.trim().slice(0, 300) : null);

async function readPages<T>(build: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>, max = 20_000): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < max; from += 1000) {
    const { data, error } = await build(from, from + 999);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

router.get('/access', need('attendance.view'), (req, res) => {
  res.json({
    enabled: true,
    view: true, edit: mayAttendance(req, 'attendance.edit'), devices: mayAttendance(req, 'attendance.devices'), pay: maySeePay(req),
  });
});

// ── The report ─────────────────────────────────────────────────────────────────────────────────────────────────────
interface Who { key: string; personId: string | null; userId: string | null; name: string; attendanceNo: number | null; branchId: string | null; attendanceOnly: boolean; active: boolean; rate: unknown }

router.get('/report', need('attendance.view'), async (req, res) => {
  const from = req.query.from, to = req.query.to;
  const bad = rangeError(from, to);
  if (bad) { res.status(400).json(bad); return; }
  const scope = readScope(req);
  const oneBranch = scope.kind === 'one' ? scope.id : null;
  const cutoff = await getDayCutoff(req.businessId, oneBranch);
  const { start, end } = businessRangeEAT(from as string, to as string, cutoff);
  const readFrom = new Date(Date.parse(start) - MAX_SHIFT_HOURS * 3_600_000).toISOString();
  const readTo = new Date(Date.parse(end) + MAX_SHIFT_HOURS * 3_600_000).toISOString();
  const wantPerson = typeof req.query.person === 'string' ? req.query.person : null;

  let people: PersonRow[], users: any[], events: any[], branches: any[];
  try {
    [people, users, events, branches] = await Promise.all([
      readPages<PersonRow>((a, b) => supabase.from('attendance_people').select(PERSON_COLS).eq('business_id', req.businessId).range(a, b)),
      readPages<any>((a, b) => supabase.from('users').select('id, name, status, hourly_rate, user_branches ( branch_id )').eq('business_id', req.businessId).range(a, b)),
      readPages<any>((a, b) => supabase.from('clock_events').select(PUNCH_COLS).eq('business_id', req.businessId)
        .gte('recorded_at', readFrom).lte('recorded_at', readTo).order('recorded_at', { ascending: true }).range(a, b), 50_000),
      readPages<any>((a, b) => supabase.from('branches').select('id, name').eq('business_id', req.businessId).range(a, b)),
    ]);
  } catch (e) {
    console.warn(`[attendance] report: ${(e as Error).message}`);
    res.status(503).json({ error: 'The attendance report could not be read right now - try again.', code: 'ATTENDANCE_BUSY' }); return;
  }
  const userById = new Map(users.map((u) => [u.id, u]));
  const branchName = new Map(branches.map((b) => [b.id, b.name]));
  const personById = new Map(people.map((p) => [p.id, p]));
  const personByUser = new Map(people.filter((p) => p.user_id).map((p) => [p.user_id as string, p]));
  const whoOf = new Map<string, Who>();
  const keyOfPerson = (p: PersonRow): string => {
    const k = `p:${p.id}`;
    if (!whoOf.has(k)) {
      const u = p.user_id ? userById.get(p.user_id) : null;
      whoOf.set(k, { key: k, personId: p.id, userId: p.user_id, name: u?.name || p.name, attendanceNo: p.attendance_no, branchId: p.branch_id,
        attendanceOnly: !p.user_id, active: p.active && (!u || u.status === 'active'), rate: u?.hourly_rate ?? null });
    }
    return k;
  };
  const keyOfUser = (id: string): string | null => {
    const p = personByUser.get(id);
    if (p) return keyOfPerson(p);
    const u = userById.get(id);
    if (!u) return null;
    const k = `u:${id}`;
    if (!whoOf.has(k)) whoOf.set(k, { key: k, personId: null, userId: id, name: u.name || 'Unnamed staff', attendanceNo: null,
      branchId: u.user_branches?.[0]?.branch_id ?? null, attendanceOnly: false, active: u.status === 'active', rate: u.hourly_rate ?? null });
    return k;
  };
  for (const p of people) keyOfPerson(p);

  const punchesOf = new Map<string, Punch[]>();
  const correctionsOf = new Map<string, Correction[]>();
  const byId = new Map(events.map((e) => [e.id, e]));
  const movedFrom = new Set(events.filter((e) => e.corrects_id).map((e) => e.corrects_id));
  const nameOf = (id: string | null) => (id ? userById.get(id)?.name ?? null : null);
  for (const e of events) {
    const k = e.person_id && personById.has(e.person_id) ? keyOfPerson(personById.get(e.person_id)!) : e.staff_id ? keyOfUser(e.staff_id) : null;
    if (!k) continue;   // a device punch nobody has: "Not matched"
    if (!e.voided_at) (punchesOf.get(k) ?? punchesOf.set(k, []).get(k)!).push({ id: e.id, at: e.recorded_at, source: e.source, reason: e.reason });
    const list = correctionsOf.get(k) ?? correctionsOf.set(k, []).get(k)!;
    if (e.source === 'correction') {
      const was = e.corrects_id ? byId.get(e.corrects_id)?.recorded_at ?? null : null;
      list.push({ id: e.id, kind: e.corrects_id ? 'moved' : 'added', at: e.recorded_at, was, reason: e.reason, by: e.created_by, byName: nameOf(e.created_by), when: e.created_at });
    } else if (e.voided_at && !movedFrom.has(e.id)) {
      list.push({ id: e.id, kind: 'removed', at: null, was: e.recorded_at, reason: e.void_reason, by: e.voided_by, byName: nameOf(e.voided_by), when: e.voided_at });
    }
  }
  const pay = maySeePay(req);
  const dates = datesBetween(from as string, to as string);
  const out: any[] = [];
  for (const w of whoOf.values()) {
    if (!rowInBranches(scope, w.branchId)) continue;
    const period = personPeriod(punchesOf.get(w.key) ?? [], from as string, to as string, cutoff, correctionsOf.get(w.key) ?? []);
    if (!period.days.length && !w.active) continue;   // someone gone, with nothing in the period
    if (!w.personId && !period.days.length) continue; // staff with no number and nothing recorded: listed under People
    const daily: Record<string, number> = {};
    for (const d of period.days) if (d.hours) daily[d.date] = d.hours;
    const row: any = {
      key: w.key, person_id: w.personId, user_id: w.userId, name: w.name, attendance_no: w.attendanceNo, attendance_only: w.attendanceOnly,
      active: w.active, branch_id: w.branchId, branch_name: w.branchId ? branchName.get(w.branchId) ?? null : null,
      totals: period.totals, daily, missing: period.days.filter((d) => d.missingOut).map((d) => d.date),
    };
    if (pay) { row.hourly_rate = w.rate ?? null; row.pay = estimatePay(period.totals.hours, w.rate); }
    if (wantPerson && (wantPerson === w.key || wantPerson === w.personId || wantPerson === w.userId)) row.days = period.days;
    out.push(row);
  }
  out.sort((a, b) => b.totals.hours - a.totals.hours || a.name.localeCompare(b.name));
  const team: any = { hours: Math.round(out.reduce((s, r) => s + r.totals.hours, 0) * 100) / 100, people: out.filter((r) => r.totals.daysWorked > 0).length,
    missedOuts: out.reduce((s, r) => s + r.totals.missedOuts, 0), corrections: out.reduce((s, r) => s + r.totals.corrections, 0) };
  if (pay) team.pay = Math.round(out.reduce((s, r) => s + (r.pay ?? 0), 0) * 100) / 100;
  res.set('Cache-Control', 'no-store');
  res.json({ from, to, cutoff, dates, today: businessDateEAT(new Date(), cutoff), branch_id: oneBranch, payVisible: pay, people: out, team });
});

// ── People and numbers ─────────────────────────────────────────────────────────────────────────────────────────────
router.get('/people', need('attendance.view'), async (req, res) => {
  const scope = readScope(req);
  const [ppl, usr] = await Promise.all([
    supabase.from('attendance_people').select(PERSON_COLS).eq('business_id', req.businessId).order('attendance_no', { ascending: true }),
    supabase.from('users').select('id, name, status, user_branches ( branch_id )').eq('business_id', req.businessId).eq('status', 'active'),
  ]);
  if (ppl.error || usr.error) { res.status(503).json({ error: 'People could not be read right now.', code: 'ATTENDANCE_BUSY' }); return; }
  const people = (ppl.data ?? []) as PersonRow[];
  const has = new Set(people.map((p) => p.user_id).filter(Boolean));
  const without = ((usr.data ?? []) as any[]).filter((u) => !has.has(u.id))
    .map((u) => ({ user_id: u.id, name: u.name, branch_id: u.user_branches?.[0]?.branch_id ?? null }))
    .filter((u) => rowInBranches(scope, u.branch_id, true));
  res.json({
    people: people.filter((p) => rowInBranches(scope, p.branch_id, true)).map((p) => ({ ...p, attendance_only: !p.user_id })),
    staff_without_number: without,
    next_number: await nextNumber(req.businessId),
  });
});

/** POST /people — give a member of staff a number ({ user_id, attendance_no?, branch_id? }), or make an attendance-only
 *  person ({ name, branch_id, attendance_no? }). The number defaults to the next free one. */
router.post('/people', need('attendance.devices'), async (req, res) => {
  const made = await makePerson(req, req.body ?? {});
  if ('status' in made) { res.status(made.status).json(made.body); return; }
  res.status(201).json(made.person);
});

type Made = { person: PersonRow } | { status: number; body: { error: string; code: string } };
async function makePerson(req: Request, b: any, forcedNo?: number): Promise<Made> {
  const userId = typeof b.user_id === 'string' && UUID.test(b.user_id) ? b.user_id : null;
  let name = cleanPersonName(b.name);
  let branchId: string | null = typeof b.branch_id === 'string' && UUID.test(b.branch_id) ? b.branch_id : null;
  if (userId) {
    const { data: u } = await supabase.from('users').select('id, name, status, user_branches ( branch_id )').eq('id', userId).eq('business_id', req.businessId).maybeSingle();
    if (!u) return { status: 404, body: { error: 'Staff member not found.', code: 'STAFF_NOT_FOUND' } };
    name = cleanPersonName((u as any).name) ?? 'Staff';
    branchId = branchId ?? (u as any).user_branches?.[0]?.branch_id ?? null;
    const { data: had } = await supabase.from('attendance_people').select('id').eq('business_id', req.businessId).eq('user_id', userId).maybeSingle();
    if (had) return { status: 409, body: { error: 'This staff member already has a device number.', code: 'HAS_NUMBER' } };
  } else if (!name) {
    return { status: 400, body: { error: 'A name (1-60 characters) is required for a person without a sign-in.', code: 'BAD_NAME' } };
  }
  if (!branchId) return { status: 400, body: { error: 'Choose the branch whose device they use.', code: 'BRANCH_REQUIRED' } };
  if (!assertBranchAccess(req, branchId)) return { status: 403, body: { error: 'You can only add people at your own branch.', code: 'BRANCH_SCOPE' } };
  const { data: br } = await supabase.from('branches').select('id').eq('id', branchId).eq('business_id', req.businessId).maybeSingle();
  if (!br) return { status: 404, body: { error: 'Branch not found.', code: 'BRANCH_NOT_FOUND' } };
  const taken = await takenNumbers(req.businessId);
  const typed = b.attendance_no !== undefined && b.attendance_no !== null && b.attendance_no !== '';
  const asked = forcedNo ?? (typed ? cleanAttendanceNo(b.attendance_no) : await nextNumber(req.businessId));
  if (asked === null) return { status: 400, body: { error: 'A device number is a whole number from 1.', code: 'BAD_NUMBER' } };
  if (taken.includes(asked)) return { status: 409, body: { error: `Number ${asked} is already someone's.`, code: 'NUMBER_TAKEN' } };
  const { data: row, error } = await supabase.from('attendance_people').insert({
    business_id: req.businessId, branch_id: branchId, user_id: userId, name, attendance_no: asked, active: true, created_by: req.userId ?? null,
  }).select(PERSON_COLS).single();
  if (error) {
    if ((error as any).code === '23505') return { status: 409, body: { error: `Number ${asked} is already someone's.`, code: 'NUMBER_TAKEN' } };
    return { status: 503, body: { error: 'The person could not be saved right now.', code: 'ATTENDANCE_BUSY' } };
  }
  await queuePersonOnDevices(req.businessId, row as PersonRow, null, req.userId ?? null, forcedNo !== undefined || typed);
  return { person: row as PersonRow };
}

/** PATCH /people/:id — { name?, branch_id?, attendance_no?, active? }. A staff member's name follows their staff record. */
router.patch('/people/:id', need('attendance.devices'), async (req, res) => {
  if (!UUID.test(req.params.id)) { res.status(404).json({ error: 'Person not found.', code: 'PERSON_NOT_FOUND' }); return; }
  const { data: had } = await supabase.from('attendance_people').select(PERSON_COLS).eq('id', req.params.id).eq('business_id', req.businessId).maybeSingle();
  if (!had) { res.status(404).json({ error: 'Person not found.', code: 'PERSON_NOT_FOUND' }); return; }
  const before = had as PersonRow;
  if (!assertBranchAccess(req, before.branch_id) && !req.isOwner) { res.status(403).json({ error: 'You can only change people at your own branch.', code: 'BRANCH_SCOPE' }); return; }
  const b = req.body ?? {};
  const after: PersonRow = { ...before };
  if (b.name !== undefined) {
    if (before.user_id) { res.status(400).json({ error: 'A staff member\'s name is changed on their staff record.', code: 'NAME_FROM_STAFF' }); return; }
    const n = cleanPersonName(b.name);
    if (!n) { res.status(400).json({ error: 'A name is 1-60 characters.', code: 'BAD_NAME' }); return; }
    after.name = n;
  }
  if (b.branch_id !== undefined) {
    if (typeof b.branch_id !== 'string' || !UUID.test(b.branch_id) || !assertBranchAccess(req, b.branch_id)) { res.status(403).json({ error: 'You can only move people to your own branch.', code: 'BRANCH_SCOPE' }); return; }
    const { data: br } = await supabase.from('branches').select('id').eq('id', b.branch_id).eq('business_id', req.businessId).maybeSingle();
    if (!br) { res.status(404).json({ error: 'Branch not found.', code: 'BRANCH_NOT_FOUND' }); return; }
    after.branch_id = b.branch_id;
  }
  if (b.attendance_no !== undefined) {
    const n = cleanAttendanceNo(b.attendance_no);
    if (n === null) { res.status(400).json({ error: 'A device number is a whole number from 1.', code: 'BAD_NUMBER' }); return; }
    if (n !== before.attendance_no && (await takenNumbers(req.businessId)).includes(n)) { res.status(409).json({ error: `Number ${n} is already someone's.`, code: 'NUMBER_TAKEN' }); return; }
    after.attendance_no = n;
  }
  if (b.active !== undefined) after.active = b.active === true;
  const upd: Record<string, unknown> = { name: after.name, branch_id: after.branch_id, attendance_no: after.attendance_no, active: after.active, updated_at: nowIso() };
  if (after.active !== before.active) upd.deactivated_at = after.active ? null : nowIso();
  const { error } = await supabase.from('attendance_people').update(upd).eq('id', before.id).eq('business_id', req.businessId);
  if (error) {
    if ((error as any).code === '23505') { res.status(409).json({ error: `Number ${after.attendance_no} is already someone's.`, code: 'NUMBER_TAKEN' }); return; }
    res.status(503).json({ error: 'The person could not be saved right now.', code: 'ATTENDANCE_BUSY' }); return;
  }
  // a new number: the punches nobody had under it are theirs now (as linking does)
  if (after.attendance_no !== before.attendance_no) await assignUnmatched(req.businessId, after);
  await queuePersonOnDevices(req.businessId, after, before, req.userId ?? null, after.attendance_no !== before.attendance_no);
  res.json({ ...after, attendance_only: !after.user_id });
});

/** The punches of a number nobody had → this person (retroactively, every date). */
async function assignUnmatched(businessId: string, p: PersonRow): Promise<number> {
  const { data, error } = await supabase.from('clock_events').update({ person_id: p.id, staff_id: p.user_id })
    .eq('business_id', businessId).eq('attendance_no', p.attendance_no).eq('source', 'device').is('person_id', null).select('id');
  if (error) throw new Error(error.message);
  return (data ?? []).length;
}

/**
 * Link a number (seen in punches nobody had, or on a device) to someone: an existing attendance person (person_id), a
 * member of staff (user_id — their attendance person is made, or renumbered), or a new attendance-only person ({ name,
 * branch_id }). The number becomes theirs; the punches under it are assigned to them.
 */
async function linkNumber(req: Request, res: Response): Promise<void> {
  const b = req.body ?? {};
  const no = cleanAttendanceNo(b.attendance_no ?? b.device_user_id);
  if (no === null) { res.status(400).json({ error: 'Only a numeric device user can be linked (a number from 1).', code: 'BAD_NUMBER' }); return; }
  const { data: owner } = await supabase.from('attendance_people').select(PERSON_COLS).eq('business_id', req.businessId).eq('attendance_no', no).maybeSingle();
  if (owner) { res.status(409).json({ error: `Number ${no} is already ${(owner as any).name}'s.`, code: 'NUMBER_TAKEN' }); return; }
  let person: PersonRow | null = null;
  const pid = typeof b.person_id === 'string' && UUID.test(b.person_id) ? b.person_id : null;
  const uid = typeof b.user_id === 'string' && UUID.test(b.user_id) ? b.user_id : null;
  const existing = pid
    ? (await supabase.from('attendance_people').select(PERSON_COLS).eq('id', pid).eq('business_id', req.businessId).maybeSingle()).data
    : uid ? (await supabase.from('attendance_people').select(PERSON_COLS).eq('user_id', uid).eq('business_id', req.businessId).maybeSingle()).data : null;
  if (pid && !existing) { res.status(404).json({ error: 'Person not found.', code: 'PERSON_NOT_FOUND' }); return; }
  if (existing) {
    const before = existing as PersonRow;
    if (!assertBranchAccess(req, before.branch_id) && !req.isOwner) { res.status(403).json({ error: 'You can only link people at your own branch.', code: 'BRANCH_SCOPE' }); return; }
    const after = { ...before, attendance_no: no };
    const { error } = await supabase.from('attendance_people').update({ attendance_no: no, updated_at: nowIso() }).eq('id', before.id).eq('business_id', req.businessId);
    if (error) { res.status((error as any).code === '23505' ? 409 : 503).json({ error: 'The number could not be linked right now.', code: 'LINK_FAILED' }); return; }
    await queuePersonOnDevices(req.businessId, after, before, req.userId ?? null, true);
    person = after;
  } else {
    const made = await makePerson(req, { user_id: uid, name: b.name, branch_id: b.branch_id }, no);
    if ('status' in made) { res.status(made.status).json(made.body); return; }
    person = made.person;
  }
  const assigned = await assignUnmatched(req.businessId, person);
  res.json({ person: { ...person, attendance_only: !person.user_id }, assigned });
}

// ── Not matched (punches of a number nobody has) ───────────────────────────────────────────────────────────────────
router.get('/unmatched', need('attendance.edit'), async (req, res) => {
  const scope = readScope(req);
  let q = supabase.from('clock_events').select('attendance_no, device_user_id, device_id, branch_id, recorded_at')
    .eq('business_id', req.businessId).eq('source', 'device').is('person_id', null).is('voided_at', null).order('recorded_at', { ascending: false }).limit(5000);
  q = byBranch(q, scope);
  const [{ data, error }, devs] = await Promise.all([q, supabase.from('attendance_devices').select('id, name').eq('business_id', req.businessId)]);
  if (error) { res.status(503).json({ error: 'Could not be read right now.', code: 'ATTENDANCE_BUSY' }); return; }
  const devName = new Map(((devs.data ?? []) as any[]).map((d) => [d.id, d.name]));
  const { data: du } = await supabase.from('attendance_device_users').select('device_user_id, name').eq('business_id', req.businessId);
  const onDevice = new Map(((du ?? []) as any[]).map((u) => [u.device_user_id, u.name]));
  const groups = new Map<string, any>();
  for (const r of (data ?? []) as any[]) {
    const k = r.device_user_id;
    const g = groups.get(k) ?? { device_user_id: k, attendance_no: r.attendance_no, punches: 0, first: r.recorded_at, last: r.recorded_at, devices: [] as string[], name_on_device: onDevice.get(k) ?? null };
    g.punches++; if (r.recorded_at < g.first) g.first = r.recorded_at; if (r.recorded_at > g.last) g.last = r.recorded_at;
    const dn = devName.get(r.device_id); if (dn && !g.devices.includes(dn)) g.devices.push(dn);
    groups.set(k, g);
  }
  res.json({ unmatched: [...groups.values()].sort((a, b) => (b.last > a.last ? 1 : -1)) });
});
router.post('/unmatched/link', need('attendance.edit'), linkNumber);

// ── New on the device ──────────────────────────────────────────────────────────────────────────────────────────────
router.get('/device-users', need('attendance.devices'), async (req, res) => {
  const scope = readScope(req);
  let dq = supabase.from('attendance_devices').select('id, name, branch_id').eq('business_id', req.businessId).is('removed_at', null);
  dq = byBranch(dq, scope);
  const [{ data: devs }, { data: du }, { data: ppl }] = await Promise.all([
    dq,
    supabase.from('attendance_device_users').select('device_id, device_user_id, name, privilege').eq('business_id', req.businessId),
    supabase.from('attendance_people').select('id, attendance_no, name, branch_id, active').eq('business_id', req.businessId),
  ]);
  const devices = new Map(((devs ?? []) as any[]).map((d) => [d.id, d]));
  const users = ((du ?? []) as any[]).filter((u) => devices.has(u.device_id))
    .map((u) => ({ device_user_id: u.device_user_id, name: u.name, privilege: u.privilege, uid: null, device_id: u.device_id }));
  const people = (ppl ?? []) as any[];
  const fresh = newOnDevice(users, people) as Array<DeviceUser & { device_id: string }>;
  // A number on a device that one of our people has, but the device's user there is someone else (a device bought before
  // ZapTill keeps its own people, numbered from 1): never overwritten, its punches "Not matched" — the manager gives
  // the person the number they really have on the device (or a new one).
  let claims = new Map<string, Map<number, string | null>>();
  try { claims = await deviceClaims(req.businessId, [...devices.keys()]); } catch { /* no claims read: every slot shows as a clash, nothing is written */ }
  const byNo = new Map(people.filter((p) => p.active).map((p) => [p.attendance_no, p]));
  const clashes = users.flatMap((u) => {
    const n = cleanAttendanceNo(u.device_user_id);
    const p = n !== null ? byNo.get(n) : undefined;
    const dev = devices.get(u.device_id);
    if (!p || !dev || p.branch_id !== dev.branch_id || claims.get(u.device_id)?.get(n!) === p.id) return [];
    if ((u.privilege ?? 0) === 0 && (u.name ?? '') === deviceName(p.name)) return [];   // the same name: it is them (claimed at the next pull)
    return [{ device_id: u.device_id, device_name: dev.name ?? null, device_user_id: u.device_user_id, name_on_device: u.name ?? null,
      admin: (u.privilege ?? 0) !== 0, person_id: p.id, person_name: p.name }];
  });
  res.json({
    new_on_device: fresh.map((u) => ({ ...u, device_name: devices.get(u.device_id)?.name ?? null, admin: (u.privilege ?? 0) !== 0, linkable: cleanAttendanceNo(u.device_user_id) !== null })),
    clashes,
  });
});
router.post('/device-users/link', need('attendance.devices'), linkNumber);

// ── Corrections ────────────────────────────────────────────────────────────────────────────────────────────────────
/** The person a correction is for: { person_id } or { user_id } (a member of staff with no number yet). */
async function correctionTarget(req: Request, b: any): Promise<{ personId: string | null; staffId: string | null; branchId: string | null } | null> {
  if (typeof b.person_id === 'string' && UUID.test(b.person_id)) {
    const { data } = await supabase.from('attendance_people').select(PERSON_COLS).eq('id', b.person_id).eq('business_id', req.businessId).maybeSingle();
    return data ? { personId: (data as any).id, staffId: (data as any).user_id, branchId: (data as any).branch_id } : null;
  }
  if (typeof b.user_id === 'string' && UUID.test(b.user_id)) {
    const { data } = await supabase.from('users').select('id, user_branches ( branch_id )').eq('id', b.user_id).eq('business_id', req.businessId).maybeSingle();
    return data ? { personId: null, staffId: (data as any).id, branchId: (data as any).user_branches?.[0]?.branch_id ?? null } : null;
  }
  return null;
}
const punchTime = (v: unknown): string | null => {
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  if (!Number.isFinite(t) || t > Date.now() + 5 * 60_000 || t < Date.UTC(2015, 0, 1)) return null;
  return new Date(Math.floor(t / 1000) * 1000).toISOString();
};

router.post('/punches', need('attendance.edit'), async (req, res) => {
  const b = req.body ?? {};
  const why = reason(b.reason);
  if (!why) { res.status(400).json({ error: 'Say why (at least 3 characters).', code: 'REASON_REQUIRED' }); return; }
  const at = punchTime(b.at);
  if (!at) { res.status(400).json({ error: 'at must be a time, not in the future.', code: 'BAD_TIME' }); return; }
  const who = await correctionTarget(req, b);
  if (!who) { res.status(404).json({ error: 'Person not found.', code: 'PERSON_NOT_FOUND' }); return; }
  if (!req.isOwner && !assertBranchAccess(req, who.branchId)) { res.status(403).json({ error: 'You can only correct attendance at your own branch.', code: 'BRANCH_SCOPE' }); return; }
  const { data, error } = await supabase.from('clock_events').insert({
    business_id: req.businessId, staff_id: who.staffId, person_id: who.personId, branch_id: who.branchId, event_type: 'punch',
    recorded_at: at, source: 'correction', reason: why, created_by: req.userId ?? null,
  }).select('id, recorded_at, source, reason').single();
  if (error) { res.status(503).json({ error: 'The punch could not be saved right now.', code: 'ATTENDANCE_BUSY' }); return; }
  res.status(201).json(data);
});

async function punchFor(req: Request, id: string): Promise<any | null> {
  if (!UUID.test(id)) return null;
  const { data } = await supabase.from('clock_events').select(PUNCH_COLS).eq('id', id).eq('business_id', req.businessId).maybeSingle();
  return data ?? null;
}
async function personBranch(req: Request, e: any): Promise<string | null> {
  if (e.person_id) {
    const { data } = await supabase.from('attendance_people').select('branch_id').eq('id', e.person_id).eq('business_id', req.businessId).maybeSingle();
    if (data) return (data as any).branch_id ?? null;
  }
  return e.branch_id ?? null;
}

/** POST /punches/:id/move { at, reason } — the original kept (voided, with the reason); a correction at the new time. */
router.post('/punches/:id/move', need('attendance.edit'), async (req, res) => {
  const why = reason(req.body?.reason);
  if (!why) { res.status(400).json({ error: 'Say why (at least 3 characters).', code: 'REASON_REQUIRED' }); return; }
  const at = punchTime(req.body?.at);
  if (!at) { res.status(400).json({ error: 'at must be a time, not in the future.', code: 'BAD_TIME' }); return; }
  const e = await punchFor(req, req.params.id);
  if (!e) { res.status(404).json({ error: 'Punch not found.', code: 'PUNCH_NOT_FOUND' }); return; }
  if (e.voided_at) { res.status(409).json({ error: 'This punch was already corrected.', code: 'ALREADY_CORRECTED' }); return; }
  if (!e.person_id && !e.staff_id) { res.status(409).json({ error: 'Link this number to someone first.', code: 'NOT_MATCHED' }); return; }
  if (!req.isOwner && !assertBranchAccess(req, await personBranch(req, e))) { res.status(403).json({ error: 'You can only correct attendance at your own branch.', code: 'BRANCH_SCOPE' }); return; }
  const { data: made, error } = await supabase.from('clock_events').insert({
    business_id: req.businessId, staff_id: e.staff_id, person_id: e.person_id, branch_id: e.branch_id, event_type: 'punch',
    recorded_at: at, source: 'correction', reason: why, created_by: req.userId ?? null, corrects_id: e.id,
  }).select('id, recorded_at, source, reason, corrects_id').single();
  if (error) { res.status(503).json({ error: 'The punch could not be saved right now.', code: 'ATTENDANCE_BUSY' }); return; }
  const { error: e2 } = await supabase.from('clock_events').update({ voided_at: nowIso(), voided_by: req.userId ?? null, void_reason: why })
    .eq('id', e.id).eq('business_id', req.businessId).is('voided_at', null);
  if (e2) {
    await supabase.from('clock_events').delete().eq('id', (made as any).id).eq('business_id', req.businessId);   // never two punches for one
    res.status(503).json({ error: 'The punch could not be saved right now.', code: 'ATTENDANCE_BUSY' }); return;
  }
  res.json(made);
});

/** POST /punches/:id/remove { reason } — the punch stays, voided (who, when, why); it no longer counts. */
router.post('/punches/:id/remove', need('attendance.edit'), async (req, res) => {
  const why = reason(req.body?.reason);
  if (!why) { res.status(400).json({ error: 'Say why (at least 3 characters).', code: 'REASON_REQUIRED' }); return; }
  const e = await punchFor(req, req.params.id);
  if (!e) { res.status(404).json({ error: 'Punch not found.', code: 'PUNCH_NOT_FOUND' }); return; }
  if (e.voided_at) { res.status(409).json({ error: 'This punch was already corrected.', code: 'ALREADY_CORRECTED' }); return; }
  if (!req.isOwner && !assertBranchAccess(req, await personBranch(req, e))) { res.status(403).json({ error: 'You can only correct attendance at your own branch.', code: 'BRANCH_SCOPE' }); return; }
  const { error } = await supabase.from('clock_events').update({ voided_at: nowIso(), voided_by: req.userId ?? null, void_reason: why })
    .eq('id', e.id).eq('business_id', req.businessId).is('voided_at', null);
  if (error) { res.status(503).json({ error: 'The punch could not be removed right now.', code: 'ATTENDANCE_BUSY' }); return; }
  res.json({ ok: true, id: e.id });
});

/** GET /punches?person=&date= — one person's punches of one business day, for the correction dialog (voided ones too). */
router.get('/punches', need('attendance.view'), async (req, res) => {
  const date = typeof req.query.date === 'string' ? req.query.date : '';
  if (rangeError(date, date)) { res.status(400).json({ error: 'date must be YYYY-MM-DD.', code: 'BAD_RANGE' }); return; }
  const who = await correctionTarget(req, { person_id: req.query.person, user_id: req.query.user });
  if (!who) { res.status(404).json({ error: 'Person not found.', code: 'PERSON_NOT_FOUND' }); return; }
  if (!rowInBranches(readScope(req), who.branchId, true)) { res.status(403).json({ error: 'You can see your own branch only.', code: 'BRANCH_SCOPE' }); return; }
  const cutoff = await getDayCutoff(req.businessId, who.branchId);
  const { start, end } = businessRangeEAT(date, date, cutoff);
  let q = supabase.from('clock_events').select(PUNCH_COLS).eq('business_id', req.businessId)
    .gte('recorded_at', new Date(Date.parse(start) - 2 * 3_600_000).toISOString()).lte('recorded_at', new Date(Date.parse(end) + MAX_SHIFT_HOURS * 3_600_000).toISOString())
    .order('recorded_at', { ascending: true });
  q = who.personId ? q.eq('person_id', who.personId) : q.eq('staff_id', who.staffId as string);
  const { data, error } = await q;
  if (error) { res.status(503).json({ error: 'Could not be read right now.', code: 'ATTENDANCE_BUSY' }); return; }
  res.json({ punches: data ?? [] });
});

// ── Devices ────────────────────────────────────────────────────────────────────────────────────────────────────────
const DEVICE_WEB_COLS = 'id, branch_id, name, ip, port, serial, model, firmware, last_pull_at, last_error, last_error_at, clock_drift_s, users_on_device, punches_on_device, created_at';
const cleanIp = (v: unknown) => (typeof v === 'string' && /^[0-9A-Za-z.:-]{1,64}$/.test(v.trim()) ? v.trim() : null);

router.get('/devices', need('attendance.devices'), async (req, res) => {
  let q = supabase.from('attendance_devices').select(DEVICE_WEB_COLS + ', comm_key').eq('business_id', req.businessId).is('removed_at', null).order('created_at', { ascending: true });
  q = byBranch(q, readScope(req));
  const { data, error } = await q;
  if (error) { res.status(503).json({ error: 'Could not be read right now.', code: 'ATTENDANCE_BUSY' }); return; }
  const { data: pend } = await supabase.from('attendance_device_actions').select('device_id, status').eq('business_id', req.businessId).in('status', ['pending', 'failed']);
  const count = (id: string, s: string) => ((pend ?? []) as any[]).filter((a) => a.device_id === id && a.status === s).length;
  // the comm key never leaves the cloud for the web — only whether one is set
  res.json({ devices: ((data ?? []) as any[]).map(({ comm_key, ...d }) => ({ ...d, comm_key_set: Number(comm_key) > 0, pending_actions: count(d.id, 'pending'), failed_actions: count(d.id, 'failed') })) });
});

/** A614: a branch has one attendance device — the words when a second is added. */
export const oneDeviceRefusal = (existing: string | null) => ({
  error: `This branch already has its attendance device${existing ? ` (${existing})` : ''}. A branch has one device — remove it first to put another in its place.`,
  code: 'BRANCH_HAS_DEVICE',
});

router.post('/devices', need('attendance.devices'), async (req, res) => {
  const b = req.body ?? {};
  const name = cleanPersonName(b.name), ip = cleanIp(b.ip);
  const port = b.port === undefined || b.port === null || b.port === '' ? 4370 : Number(b.port);
  const key = b.comm_key === undefined || b.comm_key === null || b.comm_key === '' ? 0 : Number(b.comm_key);
  if (!name) { res.status(400).json({ error: 'Give the device a name.', code: 'BAD_NAME' }); return; }
  if (!ip) { res.status(400).json({ error: 'The device\'s address (for example 192.168.1.201) is needed.', code: 'BAD_IP' }); return; }
  if (!Number.isInteger(port) || port < 1 || port > 65535) { res.status(400).json({ error: 'The port is a number from 1 to 65535 (usually 4370).', code: 'BAD_PORT' }); return; }
  if (!Number.isInteger(key) || key < 0 || key > 999999) { res.status(400).json({ error: 'The communication key is a number from 0 to 999999.', code: 'BAD_KEY' }); return; }
  const branchId = typeof b.branch_id === 'string' && UUID.test(b.branch_id) ? b.branch_id : null;
  if (!branchId || !assertBranchAccess(req, branchId)) { res.status(403).json({ error: 'Choose one of your branches.', code: 'BRANCH_SCOPE' }); return; }
  const { data: br } = await supabase.from('branches').select('id').eq('id', branchId).eq('business_id', req.businessId).maybeSingle();
  if (!br) { res.status(404).json({ error: 'Branch not found.', code: 'BRANCH_NOT_FOUND' }); return; }
  // A612: a device goes only to a branch that pays for Attendance
  const paying = (req as { attendanceBranches?: string[] | null }).attendanceBranches;
  if (paying && !paying.includes(branchId)) { res.status(403).json({ error: 'This branch does not have Attendance. ZapTill turns it on per branch.', code: 'ATTENDANCE_OFF' }); return; }
  // A614 (owner, 2026-10-30): "we bind an attendance device to a branch and a branch can never have two attendance device".
  // The web is the one place a device is added (the desktop reads its branch's device from here); migration 183's unique
  // index holds it in the database too (a second insert racing this check: 23505, answered the same).
  const { data: has, error: hasErr } = await supabase.from('attendance_devices').select('id, name')
    .eq('business_id', req.businessId).eq('branch_id', branchId).is('removed_at', null).limit(1);
  if (hasErr) { res.status(503).json({ error: 'The device could not be saved right now.', code: 'ATTENDANCE_BUSY' }); return; }
  if ((has ?? []).length) { res.status(409).json(oneDeviceRefusal((has as Array<{ name: string }>)[0].name)); return; }
  const { data, error } = await supabase.from('attendance_devices').insert({
    business_id: req.businessId, branch_id: branchId, name, ip, port, comm_key: key, created_by: req.userId ?? null,
  }).select(DEVICE_WEB_COLS).single();
  if (error && (error as { code?: string }).code === '23505') { res.status(409).json(oneDeviceRefusal(null)); return; }
  if (error) { res.status(503).json({ error: 'The device could not be saved right now.', code: 'ATTENDANCE_BUSY' }); return; }
  // everyone already at the branch goes onto the new device
  const { data: ppl } = await supabase.from('attendance_people').select(PERSON_COLS).eq('business_id', req.businessId).eq('branch_id', branchId).eq('active', true);
  const rows = ((ppl ?? []) as PersonRow[]).map((p) => ({ business_id: req.businessId, branch_id: branchId, device_id: (data as any).id, action: 'write_user',
    person_id: p.id, attendance_no: p.attendance_no, name: p.name, status: 'pending', created_by: req.userId ?? null }));
  if (rows.length) await supabase.from('attendance_device_actions').insert(rows);
  res.status(201).json({ ...(data as any), queued: rows.length });
});

router.patch('/devices/:id', need('attendance.devices'), async (req, res) => {
  if (!UUID.test(req.params.id)) { res.status(404).json({ error: 'Device not found.', code: 'DEVICE_NOT_FOUND' }); return; }
  const { data: d } = await supabase.from('attendance_devices').select('id, branch_id').eq('id', req.params.id).eq('business_id', req.businessId).is('removed_at', null).maybeSingle();
  if (!d || !assertBranchAccess(req, (d as any).branch_id)) { res.status(404).json({ error: 'Device not found.', code: 'DEVICE_NOT_FOUND' }); return; }
  const b = req.body ?? {};
  const upd: Record<string, unknown> = { updated_at: nowIso() };
  if (b.name !== undefined) { const n = cleanPersonName(b.name); if (!n) { res.status(400).json({ error: 'Give the device a name.', code: 'BAD_NAME' }); return; } upd.name = n; }
  if (b.ip !== undefined) { const ip = cleanIp(b.ip); if (!ip) { res.status(400).json({ error: 'That is not a device address.', code: 'BAD_IP' }); return; } upd.ip = ip; }
  if (b.port !== undefined) { const p = Number(b.port); if (!Number.isInteger(p) || p < 1 || p > 65535) { res.status(400).json({ error: 'The port is a number from 1 to 65535.', code: 'BAD_PORT' }); return; } upd.port = p; }
  if (b.comm_key !== undefined) { const k = Number(b.comm_key); if (!Number.isInteger(k) || k < 0 || k > 999999) { res.status(400).json({ error: 'The communication key is a number from 0 to 999999.', code: 'BAD_KEY' }); return; } upd.comm_key = k; }
  const { data, error } = await supabase.from('attendance_devices').update(upd).eq('id', (d as any).id).eq('business_id', req.businessId).select(DEVICE_WEB_COLS).single();
  if (error) { res.status(503).json({ error: 'The device could not be saved right now.', code: 'ATTENDANCE_BUSY' }); return; }
  res.json(data);
});

/** DELETE /devices/:id — the device is retired (its punches stay); what was waiting for it is cancelled. */
router.delete('/devices/:id', need('attendance.devices'), async (req, res) => {
  if (!UUID.test(req.params.id)) { res.status(404).json({ error: 'Device not found.', code: 'DEVICE_NOT_FOUND' }); return; }
  const { data: d } = await supabase.from('attendance_devices').select('id, branch_id').eq('id', req.params.id).eq('business_id', req.businessId).is('removed_at', null).maybeSingle();
  if (!d || !assertBranchAccess(req, (d as any).branch_id)) { res.status(404).json({ error: 'Device not found.', code: 'DEVICE_NOT_FOUND' }); return; }
  await supabase.from('attendance_devices').update({ removed_at: nowIso(), updated_at: nowIso() }).eq('id', (d as any).id).eq('business_id', req.businessId);
  await supabase.from('attendance_device_actions').update({ status: 'cancelled', done_at: nowIso() }).eq('device_id', (d as any).id).eq('business_id', req.businessId).eq('status', 'pending');
  res.json({ ok: true });
});

export default router;
