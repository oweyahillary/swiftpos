/**
 * ops.ts — A525: the GitHub workflows post what they found.
 *
 *   POST /api/ops/events   Authorization: Bearer <OPS_INGEST_TOKEN>
 *     { kind: 'deploy_check' | 'vuln_scan' | 'backup' | 'uptime', status: 'ok' | 'warn' | 'fail', commit?, title, details?, source? }
 *     → 201 { id }
 *
 * .github/workflows/verify-prod-deploy.yml (did the newest server change reach production?) and security-scan.yml (npm
 * audit on every app). Not a user session: the token is the repository secret, the same value as the server's
 * OPS_INGEST_TOKEN (at least 32 characters; unset = 503 OPS_INGEST_DISABLED). The global API limiter applies, and this
 * route's own: 60 per address per 10 minutes. A 'fail' also tells the ZapTill admin (Telegram and e-mail,
 * lib/alertNotify.ts) — best effort, never the answer. The admin portal's System page reads them (routes/opsAdmin.ts).
 * A589: a failed nightly backup ('backup', .github/workflows/nightly-backup.yml) is the "backup FAILED" emergency —
 * emailed at once (category 'backup' in Alerts › Email settings; a failed deploy check or scan: 'deploy'), and on the
 * admin portal's bell. A category a super admin set to digest-only reaches Telegram and the bell, not the email.
 */
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { safeRouter } from '../middleware/asyncHandler';
import { supabase } from '../lib/supabase';
import { ingestAuth, IngestSchema, failAlertText } from '../lib/opsEvents';
import { notifyAdmin } from '../lib/alertNotify';
import { readAlertSettings, addAdminNotifications } from '../lib/adminAlerts';   // A589
import { isInstant } from '../lib/adminAlertPolicy';

const router = safeRouter();

/** A525: 60 posts per address per 10 minutes — a workflow posts one or two per run. */
export const INGEST_PER_WINDOW = 60;
const ingestLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: INGEST_PER_WINDOW,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `ops:${ipKeyGenerator(req.ip ?? '')}`,
  message: { error: 'Too many ops events — wait a few minutes.', code: 'RATE_LIMITED' },
});

router.post('/events', ingestLimiter, async (req, res) => {
  const auth = ingestAuth(req.header('authorization'));
  if (auth === 'disabled') {
    res.status(503).json({ error: 'Ops events are off on this server (OPS_INGEST_TOKEN is not set, or shorter than 32 characters).', code: 'OPS_INGEST_DISABLED' });
    return;
  }
  if (auth !== 'ok') { res.status(401).json({ error: 'Wrong ops token', code: 'OPS_TOKEN_INVALID' }); return; }

  const parsed = IngestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', errors: parsed.error.issues.map((e) => ({ field: e.path.join('.'), message: e.message })) });
    return;
  }
  const ev = parsed.data;
  const { data, error } = await supabase.from('ops_events').insert({
    kind: ev.kind, status: ev.status, commit: ev.commit || null, title: ev.title, details: ev.details, source: ev.source,
    created_at: new Date().toISOString(),
  }).select('id').single();
  if (error) {
    console.warn('[ops] event not stored (migration 149?):', error.message ?? error);
    res.status(503).json({ error: 'Ops events are not available right now (migration 149?).', code: 'OPS_EVENTS_UNAVAILABLE' });
    return;
  }
  console.log(`[ops] ${ev.kind} ${ev.status} from ${ev.source}: ${ev.title}`);
  if (ev.status === 'fail') {
    // Best effort: the row is stored whatever Telegram or the mail say; never awaited by the answer.
    const { subject, text } = failAlertText(ev);
    void (async () => {
      const key = ev.kind === 'backup' ? 'backup_failed' : ev.kind;
      const instant = isInstant(key, await readAlertSettings());
      await addAdminNotifications([{ category: ev.kind === 'backup' ? 'backup' : 'deploy', business_id: null, alert_key: key, title: ev.title, detail: text, data: { kind: ev.kind } }]);
      await notifyAdmin(subject, text, { email: instant });
    })().catch((err: any) => console.warn('[ops] alert not sent:', err?.message ?? err));
  }
  res.status(201).json({ id: (data as { id: string }).id });
});

export default router;
