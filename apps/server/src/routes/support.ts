/**
 * support.ts — A519: two things a till asks the cloud during support and setup.
 *
 *   POST /api/support/logs — "Send logs to support" on the Tech page: the last 24 hours of the till's log (gzip + base64,
 *     the till already removed the secrets — this removes them again, logRedact.ts, for a till on an older build or a
 *     pattern added later), kept for the admin portal (GET /api/admin/support-logs, routes/supportAdmin.ts). The till's
 *     OWN session only (a person's token never sends a till's log); at most MAX_B64 characters (the JSON limit is 1 MB);
 *     at most RATE_PER_HOUR per device per hour (429). The answer is a reference the client reads out on the phone.
 *     A technician token (X-Tech-Token, verified) names who sent it.
 *
 *   A533: POST /api/support/logs with `request_id` — a till answering ZapTill support's pull (the admin portal's "Pull
 *     logs", routes/logRequestsAdmin.ts): the request must be this business's, for THIS device, and still waiting (else
 *     404 / 403 / 409 — another till can never answer it); the stored log is linked to it and it is marked delivered.
 *     Not counted against RATE_PER_HOUR (each request is answered once; requests are limited per admin).
 *   A533: GET /api/support/log-requests/mine — the waiting pulls for THIS device (the till's own session only): asked on
 *     the push channel's doorbell and on the till's 90 s beat. Waiting ones past their 7 days expire first.
 *
 *   GET /api/support/terminal-codes?branch_id=&code= — the terminal codes the branch's OTHER approved tills use, whether
 *     `code` is one of them, and the next free one (T1 → T2 …). The setup screen and the Tech page ask before a code is
 *     chosen or changed, so two tills at a branch never start as "T1" (A500 copes with the clash; this stops it at the
 *     source). The unique index of migration 52 (user_devices_terminal_code_unique) is still the guarantee. The till's own
 *     session for its own branch, the owner, or someone who approves devices.
 */
import zlib from 'zlib';
import crypto from 'crypto';
import { safeRouter } from '../middleware/asyncHandler';
import { requireAuth } from '../middleware/auth';
import { can, inBranchSet, assertBranchAccess } from '../middleware/rbac';
import { supabase } from '../lib/supabase';
import { redactLog } from '../lib/logRedact';
import { verifyTechToken } from '../lib/techToken';
import { expireWaiting } from '../lib/logRequests';   // A533

const router = safeRouter();

/** The till packs to 900 kB; a little room for the JSON around it, never past express.json's 1 MB. */
export const MAX_B64 = 950 * 1024;
/** What a log may unpack to (the till sends 2 MB + 256 kB of text at most; A533's pull 3 MB + 256 kB + its diagnostics). */
export const MAX_TEXT_BYTES = 4 * 1024 * 1024;
export const RATE_PER_HOUR = 5;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no 0/O, 1/I — read out on the phone

export function newReference(): string {
  const b = crypto.randomBytes(6);
  return Array.from(b, (x) => REF_ALPHABET[x % REF_ALPHABET.length]).join('');
}

/** The next code nobody at the branch uses: T1 → T2 …; a code without a number → its letters + 2 …. 1–4 characters. */
export function nextFreeTerminalCode(inUse: Iterable<string>, wanted?: string | null): string {
  const taken = new Set([...inUse].map((c) => String(c ?? '').trim().toUpperCase()).filter(Boolean));
  const w = String(wanted ?? '').trim().toUpperCase();
  const m = /^([A-Z]*)(\d*)$/.exec(w);
  let prefix = m?.[1] || 'T';
  let n = m?.[2] ? Number(m[2]) : 1;
  if (prefix.length > 3) prefix = prefix.slice(0, 3);
  for (let i = 0; i < 2000; i++) {
    const c = `${prefix}${n}`;
    if (c.length <= 4 && !taken.has(c)) return c;
    n++;
    if (`${prefix}${n}`.length > 4) { prefix = 'T'; n = 1; }
  }
  return w || 'T1';
}

router.post('/logs', requireAuth, async (req: any, res) => {
  if (!req.isTill) { res.status(403).json({ error: 'Only a POS sends its log (its own session).', code: 'TILL_ONLY' }); return; }
  const b64 = req.body?.log_gz_b64;
  if (typeof b64 !== 'string' || !b64) { res.status(400).json({ error: 'log_gz_b64 is required', code: 'BAD_LOG' }); return; }
  if (b64.length > MAX_B64) { res.status(413).json({ error: 'That log is too big (900 kB packed at most).', code: 'LOG_TOO_BIG' }); return; }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) { res.status(400).json({ error: 'The log is not base64.', code: 'BAD_LOG' }); return; }

  let text: string;
  try { text = zlib.gunzipSync(Buffer.from(b64, 'base64'), { maxOutputLength: MAX_TEXT_BYTES }).toString('utf8'); }
  catch { res.status(400).json({ error: 'The log could not be read (gzip), or unpacks to more than 4 MB.', code: 'BAD_LOG' }); return; }

  // A533: answering a pull — the request must be this business's, for this very device, and still waiting.
  let pull: { id: string; requested_by_email?: string | null } | null = null;
  const requestId = req.body?.request_id;
  if (requestId !== undefined && requestId !== null) {
    if (typeof requestId !== 'string' || !UUID.test(requestId)) { res.status(400).json({ error: 'request_id must be an id', code: 'BAD_REQUEST_ID' }); return; }
    await expireWaiting(req.businessId, String(req.deviceId));
    const { data: lr, error: lErr } = await supabase.from('log_requests').select('id, business_id, device_id, status, requested_by_email')
      .eq('id', requestId).maybeSingle();
    if (lErr) { res.status(503).json({ error: 'Log requests are not available right now (migration 152?).', code: 'LOG_REQUESTS_UNAVAILABLE' }); return; }
    const r = lr as { id: string; business_id: string; device_id: string; status: string; requested_by_email?: string | null } | null;
    if (!r || r.business_id !== req.businessId) { res.status(404).json({ error: 'No such log request.', code: 'NO_SUCH_REQUEST' }); return; }
    if (r.device_id !== String(req.deviceId)) { res.status(403).json({ error: 'That log request is for another POS.', code: 'NOT_YOUR_REQUEST' }); return; }
    if (r.status !== 'waiting') { res.status(409).json({ error: `That log request is ${r.status}.`, code: 'REQUEST_CLOSED', status: r.status }); return; }
    pull = r;
  }

  // At most RATE_PER_HOUR per device per hour — counted in the table, so every cloud instance agrees.
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { count, error: cErr } = await supabase.from('support_logs').select('id', { count: 'exact', head: true })
    .eq('business_id', req.businessId).eq('device_id', req.deviceId).gte('created_at', since);
  if (cErr) { res.status(503).json({ error: 'Support logs are not available right now (migration 145?).', code: 'SUPPORT_LOGS_UNAVAILABLE' }); return; }
  if (!pull && (count ?? 0) >= RATE_PER_HOUR) {
    res.status(429).json({ error: `Five logs were sent from this POS in the last hour — wait a little, or save the log to a file.`, code: 'RATE_LIMITED' });
    return;
  }

  let sentBy = 'the POS';
  const raw = req.header('x-tech-token');
  if (pull) sentBy = `pulled by ZapTill support${pull.requested_by_email ? ` (${pull.requested_by_email})` : ''}`;
  else if (raw) {
    const p = verifyTechToken(String(raw));
    if (p && p.businessId === req.businessId && p.exp * 1000 > Date.now()) sentBy = `${p.techName} (technician)`;
  }

  const clean = redactLog(text);
  const stored = zlib.gzipSync(Buffer.from(clean, 'utf8'), { level: 9 }).toString('base64');
  const row = {
    business_id: req.businessId, branch_id: req.branchId ?? null, device_id: String(req.deviceId),
    terminal_code: typeof req.body?.terminal_code === 'string' ? req.body.terminal_code.slice(0, 16) : null,
    app_version: typeof req.body?.app_version === 'string' ? req.body.app_version.slice(0, 32) : null,
    sent_by: sentBy.slice(0, 120), bytes: Buffer.byteLength(clean, 'utf8'), trimmed: req.body?.trimmed === true,
    log_gz_b64: stored, created_at: new Date().toISOString(),
  };
  for (let i = 0; i < 4; i++) {
    const reference = newReference();
    const { data: stored, error } = await supabase.from('support_logs').insert({ ...row, reference }).select('id').maybeSingle();
    if (!error) {
      if (pull) {
        // A533: linked and delivered — only while still waiting (a cancel a moment ago keeps its word; the log is kept).
        const logId = (stored as { id?: string } | null)?.id ?? null;
        const { error: uErr } = await supabase.from('log_requests').update({ status: 'delivered', delivered_at: new Date().toISOString(), support_log_id: logId })
          .eq('id', pull.id).eq('status', 'waiting');
        if (uErr) console.error(`[support-logs] request ${pull.id} not marked delivered: ${uErr.message}`);
        console.log(`[support-logs] ${reference} answers log request ${pull.id} (${req.businessId}, ${req.deviceId})`);
      }
      res.status(201).json({ reference, ...(pull ? { request_id: pull.id } : {}) });
      return;
    }
    if ((error as { code?: string }).code !== '23505') {
      res.status(503).json({ error: 'The log could not be stored right now.', code: 'SUPPORT_LOGS_UNAVAILABLE' }); return;
    }
  }
  res.status(503).json({ error: 'The log could not be stored right now.', code: 'SUPPORT_LOGS_UNAVAILABLE' });
});

router.get('/log-requests/mine', requireAuth, async (req: any, res) => {
  if (!req.isTill) { res.status(403).json({ error: 'Only a POS asks for its own log requests (its own session).', code: 'TILL_ONLY' }); return; }
  const deviceId = String(req.deviceId ?? '');
  if (!deviceId) { res.json({ requests: [] }); return; }
  await expireWaiting(req.businessId, deviceId);
  const { data, error } = await supabase.from('log_requests').select('id, device_id, range_hours, include, requested_at, expires_at')
    .eq('business_id', req.businessId).eq('device_id', deviceId).eq('status', 'waiting')
    .order('requested_at', { ascending: true }).limit(5);
  if (error) { res.status(503).json({ error: 'Log requests are not available right now (migration 152?).', code: 'LOG_REQUESTS_UNAVAILABLE' }); return; }
  res.json({ requests: ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    id: r.id, range_hours: Number(r.range_hours) || 24, include: r.include ?? {}, requested_at: r.requested_at, expires_at: r.expires_at,
  })) });
});

router.get('/terminal-codes', requireAuth, async (req: any, res) => {
  const branchId = String(req.query.branch_id ?? '');
  if (!branchId) { res.status(400).json({ error: 'branch_id is required' }); return; }
  if (req.pausedBranches?.has(branchId)) { res.status(404).json({ error: 'Branch not found' }); return; }   // A612: paused
  const allowed = req.isTill ? (!req.branchId || req.branchId === branchId)
    : (req.isOwner || (can(req, 'devices.approve') && (req.allBranches || inBranchSet(req) ? assertBranchAccess(req, branchId) : (!req.branchId || req.branchId === branchId))));   // A550, A582: a partner's set
  if (!allowed) { res.status(403).json({ error: 'Only this branch\'s own POS, the owner or someone who approves devices can see this.', code: 'FORBIDDEN' }); return; }
  const { data: branch } = await supabase.from('branches').select('id, business_id').eq('id', branchId).maybeSingle();
  if (!branch || (branch as { business_id?: string }).business_id !== req.businessId) { res.status(404).json({ error: 'Branch not found' }); return; }

  const { data, error } = await supabase.from('user_devices').select('device_id, terminal_code, device_label, status, retired_at, mac_address')
    .eq('business_id', req.businessId).eq('branch_id', branchId).eq('status', 'approved');
  if (error) { res.status(503).json({ error: 'Could not read the branch\'s points of sale right now.', code: 'UNAVAILABLE' }); return; }
  const self = req.isTill ? String(req.deviceId) : String(req.query.device_id ?? '');
  // This machine's own earlier installs (the same MAC, A182) are not "another till": a reinstalled till takes its old
  // code back. Retired tills hold no code.
  const { data: me } = self
    ? await supabase.from('user_devices').select('mac_address').eq('business_id', req.businessId).eq('device_id', self).maybeSingle()
    : { data: null };
  const myMac = String((me as { mac_address?: string | null } | null)?.mac_address ?? '').toLowerCase();
  const others = ((data ?? []) as Array<{ device_id?: string; terminal_code?: string | null; device_label?: string | null; retired_at?: string | null; mac_address?: string | null }>)
    .filter((d) => d.device_id !== self && !d.retired_at && String(d.terminal_code ?? '').trim()
      && !(myMac && String(d.mac_address ?? '').toLowerCase() === myMac));
  const inUse = [...new Set(others.map((d) => String(d.terminal_code).trim().toUpperCase()))].sort();
  const wanted = String(req.query.code ?? '').trim().toUpperCase();
  res.json({
    in_use: inUse,
    tills: others.map((d) => ({ code: String(d.terminal_code).trim().toUpperCase(), name: d.device_label ?? null })),
    ...(wanted ? { code: wanted, taken: inUse.includes(wanted) } : {}),
    suggestion: nextFreeTerminalCode(inUse, wanted || 'T1'),
  });
});

export default router;
