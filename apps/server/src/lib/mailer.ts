import { Resend } from 'resend';
import nodemailer from 'nodemailer';

// ─────────────────────────────────────────────────────────────────────────────
// FROM ADDRESS
// Currently uses a single platform-level sender (NOTIFY_FROM_EMAIL).
//
// TODO (Step 19 — Settings / Step 21 — Billing):
//   Replace with per-business sending domain. Each business will supply their
//   own verified domain (e.g. hello@mamaoliech.co.ke). Store in business_settings
//   under key 'notify_from_email' and pass into sendEmail() as fromOverride.
//   Resend supports custom domains via their Domain API.
// ─────────────────────────────────────────────────────────────────────────────
const DEFAULT_FROM = process.env.NOTIFY_FROM_EMAIL ?? 'SwiftPOS <noreply@swiftpos.co.ke>';

const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

const smtpTransport = (
  process.env.SMTP_HOST &&
  process.env.SMTP_USER &&
  process.env.SMTP_PASS
) ? nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT ?? '587'),
  secure: process.env.SMTP_PORT === '465',

  connectionTimeout: 10_000,
  greetingTimeout:   10_000,
  socketTimeout:     20_000,

  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
}) : null;

// A free-mail FROM address cannot work on Resend: it will only send from a
// domain you have verified, so `NOTIFY_FROM_EMAIL=…@gmail.com` fails EVERY send
// with "The gmail.com domain is not verified" and silently demotes the whole
// platform to the SMTP fallback. That is a config mistake with no symptom until
// you read the logs, so name it once at boot instead.
const FREE_MAIL = /@(gmail|googlemail|yahoo|outlook|hotmail|live|icloud|aol)\./i;
if (resend && FREE_MAIL.test(DEFAULT_FROM)) {
  console.warn(
    `[mailer] NOTIFY_FROM_EMAIL is "${DEFAULT_FROM}" — Resend cannot send from a ` +
    'free-mail domain and will reject every message. Verify your own domain at ' +
    'https://resend.com/domains and set NOTIFY_FROM_EMAIL to an address on it.',
  );
}

export interface MailOptions {
  to: string;
  subject: string;
  html: string;
  /** Override the FROM address — used for per-business domains (Step 19/21) */
  from?: string;
}

/**
 * Send an email via Resend (primary) with Nodemailer SMTP as fallback.
 * Logs a warning if neither provider is configured (dev/test environments).
 */
export async function sendEmail(opts: MailOptions): Promise<void> {
  const from = opts.from ?? DEFAULT_FROM;

  // ── Primary: Resend ───────────────────────────────────────
  if (resend) {
    try {
      const { error } = await resend.emails.send({
        from,
        to: opts.to,
        subject: opts.subject,
        html: opts.html,
      });
      if (!error) return;
      console.warn('[mailer] Resend error, falling back to SMTP:', error.message);
    } catch (err: any) {
      console.warn('[mailer] Resend threw, falling back to SMTP:', err.message);
    }
  }

  // ── Fallback: Nodemailer SMTP ─────────────────────────────
  if (smtpTransport) {
    await smtpTransport.sendMail({
      from,
      to: opts.to,
      subject: opts.subject,
      html: opts.html,
    });
    return;
  }

  // ── Neither configured ────────────────────────────────────
  console.warn('[mailer] No email provider configured. Email not sent:', opts.subject, '→', opts.to);
}
