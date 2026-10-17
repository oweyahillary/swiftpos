/**
 * supportAdmin.ts — A519: the admin portal reads the logs tills sent to support (POST /api/support/logs).
 *
 *   GET /api/admin/support-logs?business=<id>      — that client's last 50 logs (no log text): reference, till, version,
 *                                                     who sent it, size, when.
 *   GET /api/admin/support-logs?reference=K7Q2XM   — find one by the reference the client read out.
 *   GET /api/admin/support-logs/:id                — one log, unpacked ({ ..., text }); ?download=1 → a .txt file.
 *
 * Any active admin (super admin or agent — support is both their job); never a business's own token. Read only. The log
 * was redacted on the till and again before it was stored.
 */
import zlib from 'zlib';
import { safeRouter } from '../middleware/asyncHandler';
import { requireAdmin } from '../middleware/adminAuth';
import { supabase } from '../lib/supabase';

const router = safeRouter();
const LIST_COLS = 'id, business_id, branch_id, device_id, terminal_code, app_version, reference, sent_by, bytes, trimmed, created_at';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.get('/', requireAdmin, async (req, res) => {
  const business = String(req.query.business ?? '').trim();
  const reference = String(req.query.reference ?? '').trim().toUpperCase();
  if (!business && !reference) { res.status(400).json({ error: 'business or reference is required' }); return; }
  if (business && !UUID.test(business)) { res.status(400).json({ error: 'business must be an id' }); return; }
  let q = supabase.from('support_logs').select(LIST_COLS);
  if (business) q = q.eq('business_id', business);
  if (reference) q = q.eq('reference', reference);
  const { data, error } = await q.order('created_at', { ascending: false }).limit(50);
  if (error) { res.status(503).json({ error: 'Support logs are not available right now (migration 145?).', code: 'SUPPORT_LOGS_UNAVAILABLE' }); return; }
  // Never the log text in a list (the column list says so; this says so again).
  res.json({ logs: ((data ?? []) as Array<Record<string, unknown>>).map(({ log_gz_b64: _drop, ...meta }) => meta) });
});

router.get('/:id', requireAdmin, async (req, res) => {
  const id = String(req.params.id);
  if (!UUID.test(id)) { res.status(400).json({ error: 'id must be an id' }); return; }
  const { data, error } = await supabase.from('support_logs').select(`${LIST_COLS}, log_gz_b64`).eq('id', id).maybeSingle();
  if (error) { res.status(503).json({ error: 'Support logs are not available right now.', code: 'SUPPORT_LOGS_UNAVAILABLE' }); return; }
  if (!data) { res.status(404).json({ error: 'No such log' }); return; }
  const { log_gz_b64, ...meta } = data as Record<string, unknown> & { log_gz_b64: string };
  let text: string;
  try { text = zlib.gunzipSync(Buffer.from(String(log_gz_b64 ?? ''), 'base64')).toString('utf8'); }
  catch { res.status(500).json({ error: 'That log could not be unpacked.' }); return; }
  console.log(`[support-logs] admin ${req.adminId} read ${String(meta.reference)} (${String(meta.business_id)})`);
  if (req.query.download === '1') {
    const name = `zaptill-${String(meta.terminal_code ?? 'till')}-${String(meta.reference)}.txt`.replace(/[^\w.-]/g, '_');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.send(text);
    return;
  }
  res.json({ ...meta, text });
});

export default router;
