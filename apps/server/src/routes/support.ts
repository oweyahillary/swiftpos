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
import { can } from '../middleware/rbac';
import { supabase } from '../lib/supabase';
import { redactLog } from '../lib/logRedact';
import { verifyTechToken } from '../lib/techToken';

const router = safeRouter();

/** The till packs to 900 kB; a little room for the JSON around it, never past express.json's 1 MB. */
export const MAX_B64 = 950 * 1024;
/** What a log may unpack to (the till sends 2 MB + 256 kB of text at most). */
export const MAX_TEXT_BYTES = 4 * 1024 * 1024;
export const RATE_PER_HOUR = 5;
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
  if (!req.isTill) { res.status(403).json({ error: 'Only a till sends its log (its own session).', code: 'TILL_ONLY' }); return; }
  const b64 = req.body?.log_gz_b64;
  if (typeof b64 !== 'string' || !b64) { res.status(400).json({ error: 'log_gz_b64 is required', code: 'BAD_LOG' }); return; }
  if (b64.length > MAX_B64) { res.status(413).json({ error: 'That log is too big (900 kB packed at most).', code: 'LOG_TOO_BIG' }); return; }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) { res.status(400).json({ error: 'The log is not base64.', code: 'BAD_LOG' }); return; }

  let text: string;
  try { text = zlib.gunzipSync(Buffer.from(b64, 'base64'), { maxOutputLength: MAX_TEXT_BYTES }).toString('utf8'); }
  catch { res.status(400).json({ error: 'The log could not be read (gzip), or unpacks to more than 4 MB.', code: 'BAD_LOG' }); return; }

  // At most RATE_PER_HOUR per device per hour — counted in the table, so every cloud instance agrees.
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { count, error: cErr } = await supabase.from('support_logs').select('id', { count: 'exact', head: true })
    .eq('business_id', req.businessId).eq('device_id', req.deviceId).gte('created_at', since);
  if (cErr) { res.status(503).json({ error: 'Support logs are not available right now (migration 145?).', code: 'SUPPORT_LOGS_UNAVAILABLE' }); return; }
  if ((count ?? 0) >= RATE_PER_HOUR) {
    res.status(429).json({ error: `Five logs were sent from this till in the last hour — wait a little, or save the log to a file.`, code: 'RATE_LIMITED' });
    return;
  }

  let sentBy = 'the till';
  const raw = req.header('x-tech-token');
  if (raw) {
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
    const { error } = await supabase.from('support_logs').insert({ ...row, reference });
    if (!error) { res.status(201).json({ reference }); return; }
    if ((error as { code?: string }).code !== '23505') {
      res.status(503).json({ error: 'The log could not be stored right now.', code: 'SUPPORT_LOGS_UNAVAILABLE' }); return;
    }
  }
  res.status(503).json({ error: 'The log could not be stored right now.', code: 'SUPPORT_LOGS_UNAVAILABLE' });
});

router.get('/terminal-codes', requireAuth, async (req: any, res) => {
  const branchId = String(req.query.branch_id ?? '');
  if (!branchId) { res.status(400).json({ error: 'branch_id is required' }); return; }
  const allowed = req.isTill ? (!req.branchId || req.branchId === branchId)
    : (req.isOwner || (can(req, 'devices.approve') && (req.allBranches ? req.partnerBranches.includes(branchId) : (!req.branchId || req.branchId === branchId))));   // A550
  if (!allowed) { res.status(403).json({ error: 'Only this branch\'s own till, the owner or someone who approves devices can see this.', code: 'FORBIDDEN' }); return; }
  const { data: branch } = await supabase.from('branches').select('id, business_id').eq('id', branchId).maybeSingle();
  if (!branch || (branch as { business_id?: string }).business_id !== req.businessId) { res.status(404).json({ error: 'Branch not found' }); return; }

  const { data, error } = await supabase.from('user_devices').select('device_id, terminal_code, device_label, status, retired_at, mac_address')
    .eq('business_id', req.businessId).eq('branch_id', branchId).eq('status', 'approved');
  if (error) { res.status(503).json({ error: 'Could not read the branch\'s tills right now.', code: 'UNAVAILABLE' }); return; }
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
