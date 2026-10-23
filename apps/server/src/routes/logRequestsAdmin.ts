/**
 * logRequestsAdmin.ts — A533: "Pull logs" in the admin portal (client page › Desktop updates › Support logs).
 *
 * Owner, 2026-10-19: "add a feature where we can pull local logs of a server or a till to cloud so that we can be
 * investigating such issues" — and, on the Desktop updates tab: "how do I pull logs".
 *
 *   GET  /api/admin/clients/:businessId/log-requests            — the client's requests (newest first, waiting ones past
 *        their 7 days expired first) with the device's label, version and last seen, and the linked support log's
 *        reference; and the devices that can be asked (approved, not retired; a note on each one too old to answer).
 *   POST /api/admin/clients/:businessId/log-requests            — { device_id, reason (required), range_hours 24|72|168,
 *        include: { auth } } → a waiting request; the business's sockets hear the doorbell (lib/liveHub.ts).
 *   POST /api/admin/clients/:businessId/log-requests/:id/cancel — a waiting request withdrawn.
 *
 * Any active admin (requireAdmin — super admins AND agents: support is both their job, as A519's logs and A523's tills
 * and days). A support action like A519: audited in admin_audit_log, no owner notice. At most REQUESTS_PER_ADMIN_HOUR
 * new requests per admin per hour (counted in the table — every cloud instance agrees). A device of another business,
 * a retired or unapproved one, is refused.
 *
 * Mounted at /admin/clients before /admin (routes/index.ts): a path this router does not serve falls through to the
 * admin router's own /clients routes.
 */
import crypto from 'crypto';
import { safeRouter } from '../middleware/asyncHandler';
import { requireAdmin } from '../middleware/adminAuth';
import { supabase } from '../lib/supabase';
import { sendError } from '../lib/sendError';
import { ringLogRequest } from '../lib/liveHub';
import {
  cleanReason, rangeOf, includeOf, expireWaiting, versionNote, canAnswerPull, EXPIRES_AFTER_MS,
  REQUESTS_PER_ADMIN_HOUR, type PullAbility,
} from '../lib/logRequests';

const router = safeRouter();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REQ_COLS = 'id, business_id, device_id, requested_by_admin, requested_by_email, requested_at, reason, range_hours, include, status, delivered_at, support_log_id, cancelled_at, expires_at';
const DEV_COLS = 'device_id, device_label, device_role, terminal_code, branch_id, status, retired_at, app_version, last_seen_at, last_sync_at';

type Dev = { device_id: string; device_label?: string | null; device_role?: string | null; terminal_code?: string | null; branch_id?: string | null;
  status?: string | null; retired_at?: string | null; app_version?: string | null; last_seen_at?: string | null; last_sync_at?: string | null };

async function clientOf(req: any, res: any): Promise<{ id: string; name: string | null } | null> {
  const id = String(req.params.businessId ?? '');
  if (!UUID.test(id)) { res.status(400).json({ error: 'businessId must be an id' }); return null; }
  const { data, error } = await supabase.from('businesses').select('id, name').eq('id', id).maybeSingle();
  if (error) { sendError(res, error); return null; }
  if (!data) { res.status(404).json({ error: 'No such client' }); return null; }
  return data as { id: string; name: string | null };
}

async function adminAudit(req: any, client: { id: string; name: string | null }, action: string, after: object, reason: string): Promise<void> {
  const { error } = await supabase.from('admin_audit_log').insert({
    admin_id: req.adminId, admin_email: req.adminEmail, action, resource: 'log_requests',
    business_id: client.id, business_name: client.name, before_data: null, after_data: after, reason, ip_address: req.ip ?? null,
  });
  if (error) console.error('[admin log-requests] admin audit not written:', error.message);
}

const lastSeen = (d: Dev | undefined) => {
  const a = d?.last_seen_at ?? null, b = d?.last_sync_at ?? null;
  return a && b ? (a > b ? a : b) : (a ?? b);
};
const labelOf = (d: Dev | undefined, id: string) => d?.device_label || d?.terminal_code || id;
const deviceView = (d: Dev, branches: Map<string, string>, ability: PullAbility = {}) => ({
  device_id: d.device_id, label: labelOf(d, d.device_id), terminal_code: d.terminal_code ?? null,
  role: d.device_role ?? 'till', branch: d.branch_id ? (branches.get(d.branch_id) ?? null) : null,
  app_version: d.app_version ?? null, last_seen_at: lastSeen(d),
  can_answer: canAnswerPull(d.app_version, ability), note: versionNote(d.app_version, ability),   // A554: what it reports, not only its version
});

/**
 * A554: per device of the business, what says it answers a pull beyond its version — `log_pull: true` in its update
 * state (A534's report; a cloud before migration 154 has no column: nothing known) and whether it answered one before.
 * Never throws: unknown → the version decides, as before.
 */
async function pullAbilities(businessId: string, deviceIds: string[] = []): Promise<Map<string, PullAbility>> {
  const out = new Map<string, PullAbility>();
  const get = (id: string) => { let a = out.get(id); if (!a) { a = {}; out.set(id, a); } return a; };
  try {
    let q = supabase.from('user_devices').select('device_id, update_state').eq('business_id', businessId);
    if (deviceIds.length) q = q.in('device_id', deviceIds);
    const { data, error } = await q.limit(500);
    if (!error) for (const r of (data ?? []) as Array<{ device_id?: string; update_state?: { log_pull?: unknown } | null }>) {
      if (r.device_id && r.update_state && r.update_state.log_pull === true) get(r.device_id).reportsLogPull = true;
    }
  } catch { /* the version decides */ }
  try {
    let q = supabase.from('log_requests').select('device_id').eq('business_id', businessId).eq('status', 'delivered');
    if (deviceIds.length) q = q.in('device_id', deviceIds);
    const { data, error } = await q.limit(500);
    if (!error) for (const r of (data ?? []) as Array<{ device_id?: string }>) if (r.device_id) get(r.device_id).answeredBefore = true;
  } catch { /* the version decides */ }
  return out;
}

// A533: a log request changes nothing a till reads — no need for the /admin write hook to forget every business's
// cache and make every till socket sign in again (lib/forgetOnWrite.ts honours this).
router.use('/:businessId/log-requests', (_req, res, next) => { res.locals.forgetNothing = true; next(); });

router.get('/:businessId/log-requests', requireAdmin, async (req: any, res) => {
  const client = await clientOf(req, res);
  if (!client) return;
  await expireWaiting(client.id);
  const { data, error } = await supabase.from('log_requests').select(REQ_COLS).eq('business_id', client.id)
    .order('requested_at', { ascending: false }).limit(50);
  if (error) { res.status(503).json({ error: 'Log requests are not available right now (migration 152?).', code: 'LOG_REQUESTS_UNAVAILABLE' }); return; }
  const rows = (data ?? []) as Array<Record<string, any>>;
  const { data: devs } = await supabase.from('user_devices').select(DEV_COLS).eq('business_id', client.id).limit(500);
  const devices = ((devs ?? []) as Dev[]).filter((d) => d.device_id);
  const byId = new Map(devices.map((d) => [d.device_id, d]));
  const branchIds = [...new Set(devices.map((d) => d.branch_id).filter(Boolean))] as string[];
  const { data: brs } = branchIds.length ? await supabase.from('branches').select('id, name').in('id', branchIds) : { data: [] };
  const branches = new Map(((brs ?? []) as Array<{ id: string; name: string }>).map((b) => [b.id, b.name]));
  const logIds = rows.map((r) => r.support_log_id).filter(Boolean);
  const { data: logs } = logIds.length ? await supabase.from('support_logs').select('id, reference, bytes, trimmed, created_at').in('id', logIds) : { data: [] };
  const logById = new Map(((logs ?? []) as Array<Record<string, any>>).map((l) => [l.id, l]));
  const ability = await pullAbilities(client.id);   // A554
  res.json({
    requests: rows.map((r) => {
      const d = byId.get(r.device_id);
      const log = r.support_log_id ? logById.get(r.support_log_id) : null;
      return { ...r, device_label: labelOf(d, r.device_id), terminal_code: d?.terminal_code ?? null, app_version: d?.app_version ?? null,
        last_seen_at: lastSeen(d), note: r.status === 'waiting' ? versionNote(d?.app_version, ability.get(r.device_id)) : null,
        support_log: log ? { id: log.id, reference: log.reference, bytes: log.bytes, trimmed: log.trimmed, created_at: log.created_at } : null };
    }),
    devices: devices.filter((d) => d.status === 'approved' && !d.retired_at).map((d) => deviceView(d, branches, ability.get(d.device_id))),
  });
});

router.post('/:businessId/log-requests', requireAdmin, async (req: any, res) => {
  const client = await clientOf(req, res);
  if (!client) return;
  const b = req.body ?? {};
  const deviceId = typeof b.device_id === 'string' ? b.device_id.trim() : '';
  const reason = cleanReason(b.reason);
  const range = rangeOf(b.range_hours);
  if (!deviceId) { res.status(400).json({ error: 'Choose the till or server to pull the log from.', code: 'DEVICE_REQUIRED' }); return; }
  if (!reason) { res.status(400).json({ error: 'Say why (the reason is kept with the request and in the admin log).', code: 'REASON_REQUIRED' }); return; }
  if (range === null) { res.status(400).json({ error: 'The range is 24 hours, 3 days or 7 days.', code: 'BAD_RANGE' }); return; }

  const { data: dev, error: dErr } = await supabase.from('user_devices').select(DEV_COLS)
    .eq('business_id', client.id).eq('device_id', deviceId).maybeSingle();
  if (dErr) { sendError(res, dErr); return; }
  const d = dev as Dev | null;
  if (!d) { res.status(404).json({ error: 'That device is not one of this client\'s tills.', code: 'NO_SUCH_DEVICE' }); return; }
  if (d.retired_at || d.status !== 'approved') {
    res.status(409).json({ error: d.retired_at ? 'That till is retired — it cannot answer.' : 'That till is not approved — it cannot answer.', code: 'DEVICE_NOT_ACTIVE' });
    return;
  }

  const since = new Date(Date.now() - 3_600_000).toISOString();
  const { count, error: cErr } = await supabase.from('log_requests').select('id', { count: 'exact', head: true })
    .eq('requested_by_admin', req.adminId).gte('requested_at', since);
  if (cErr) { res.status(503).json({ error: 'Log requests are not available right now (migration 152?).', code: 'LOG_REQUESTS_UNAVAILABLE' }); return; }
  if ((count ?? 0) >= REQUESTS_PER_ADMIN_HOUR) {
    res.status(429).json({ error: `${REQUESTS_PER_ADMIN_HOUR} log requests from you in the last hour — wait a little.`, code: 'RATE_LIMITED' });
    return;
  }

  const now = Date.now();
  const row = {
    id: crypto.randomUUID(), business_id: client.id, device_id: deviceId, requested_by_admin: req.adminId, requested_by_email: req.adminEmail ?? null,
    requested_at: new Date(now).toISOString(), reason, range_hours: range, include: includeOf(b.include), status: 'waiting',
    delivered_at: null, support_log_id: null, cancelled_at: null, expires_at: new Date(now + EXPIRES_AFTER_MS).toISOString(),
  };
  const { data: made, error } = await supabase.from('log_requests').insert(row).select(REQ_COLS).single();
  if (error || !made) { res.status(503).json({ error: 'The request could not be saved right now (migration 152?).', code: 'LOG_REQUESTS_UNAVAILABLE' }); return; }
  const id = String((made as { id: string }).id);
  await adminAudit(req, client, 'log_requests.create', { request_id: id, device_id: deviceId, till: labelOf(d, deviceId), range_hours: range, include: row.include }, reason);
  const rang = ringLogRequest(client.id, deviceId);
  console.log(`[log-requests] ${req.adminEmail} asked ${labelOf(d, deviceId)} (${client.id}) for ${range} h — request ${id}; ${rang} socket(s) rung`);
  const ability = (await pullAbilities(client.id, [deviceId])).get(deviceId);   // A554
  res.status(201).json({ request: { ...(made as object), device_label: labelOf(d, deviceId), last_seen_at: lastSeen(d) }, rung: rang, note: versionNote(d.app_version, ability) });
});

router.post('/:businessId/log-requests/:id/cancel', requireAdmin, async (req: any, res) => {
  const client = await clientOf(req, res);
  if (!client) return;
  const id = String(req.params.id ?? '');
  if (!UUID.test(id)) { res.status(400).json({ error: 'id must be an id' }); return; }
  await expireWaiting(client.id);
  const { data: cur, error: rErr } = await supabase.from('log_requests').select(REQ_COLS).eq('id', id).eq('business_id', client.id).maybeSingle();
  if (rErr) { res.status(503).json({ error: 'Log requests are not available right now.', code: 'LOG_REQUESTS_UNAVAILABLE' }); return; }
  if (!cur) { res.status(404).json({ error: 'No such request' }); return; }
  if ((cur as { status: string }).status !== 'waiting') {
    res.status(409).json({ error: `That request is ${(cur as { status: string }).status} — only a waiting one can be cancelled.`, code: 'NOT_WAITING', status: (cur as { status: string }).status });
    return;
  }
  const { data: upd, error } = await supabase.from('log_requests').update({ status: 'cancelled', cancelled_at: new Date().toISOString() })
    .eq('id', id).eq('business_id', client.id).eq('status', 'waiting').select(REQ_COLS);
  if (error) { res.status(503).json({ error: 'The request could not be cancelled right now.', code: 'LOG_REQUESTS_UNAVAILABLE' }); return; }
  if (!(upd ?? []).length) { res.status(409).json({ error: 'That request was answered or cancelled a moment ago.', code: 'NOT_WAITING' }); return; }
  const reason = cleanReason(req.body?.reason) || 'cancelled';
  await adminAudit(req, client, 'log_requests.cancel', { request_id: id, device_id: (cur as { device_id: string }).device_id }, reason);
  res.json({ request: (upd as object[])[0] });
});

export default router;
