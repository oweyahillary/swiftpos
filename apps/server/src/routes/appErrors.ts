/**
 * appErrors.ts — POST /api/app-errors: the ZapTill Android app reports a crash or an error (docs/ANDROID-APP-DESIGN.md,
 * Stage 0, "Crash and error reports into the existing alerts").
 *
 *   body: AppErrorReport (@zaptill/core/androidApp) — { surface, kind: 'crash' | 'error', appVersion, message, stack?, device? }
 *   → 202 { notified }   (notified: whether this report rang the admin portal's bell, or was a repeat in the window)
 *
 * A session is optional: in Stage 0 the app has no sign-in yet, and a crash before sign-in matters most. With a session
 * the bell row names the business. Without one the route is open, so: the global API limiter, this route's own
 * (REPORTS_PER_WINDOW per address per 10 minutes), every field trimmed and redacted (lib/appErrors.ts),
 * and one bell row per crash per 6 hours however many devices send it. Every report is still written to the cloud's log.
 * Category app_errors: the bell and the Alerts page only — never an email per crash (A589's client categories).
 */
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { safeRouter } from '../middleware/asyncHandler';
import { sessionIfSent } from '../middleware/sessionIfSent';
import { addAdminNotifications } from '../lib/adminAlerts';
import { cleanErrorReport, errorFingerprint, errorNotification, ErrorGate } from '../lib/appErrors';

const router = safeRouter();

export const REPORTS_PER_WINDOW = 30;
const reportLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: REPORTS_PER_WINDOW,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `app-errors:${ipKeyGenerator(req.ip ?? '')}`,
  message: { error: 'Too many error reports — wait a few minutes.', code: 'RATE_LIMITED' },
});

const gate = new ErrorGate();


router.post('/', reportLimiter, sessionIfSent, async (req, res) => {
  const report = cleanErrorReport(req.body);
  if (!report) { res.status(400).json({ error: 'Not an error report.', code: 'BAD_REPORT' }); return; }
  const businessId = req.businessId ?? null;
  const fingerprint = errorFingerprint(report);
  console.warn(`[app-errors] ${report.surface} ${report.appVersion} ${report.kind} ${fingerprint} business=${businessId ?? '-'}: ${report.message.split('\n')[0].slice(0, 200)}`);
  const notified = gate.shouldNotify(fingerprint);
  if (notified) await addAdminNotifications([errorNotification(report, businessId, fingerprint)]);
  res.status(202).json({ notified });
});

export default router;
