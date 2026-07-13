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
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
}) : null;

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
