import { Resend } from 'resend';
import nodemailer from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';

/**
 * `family` is honoured by nodemailer at runtime — it is forwarded to
 * net.connect — but it is absent from @types/nodemailer 8.0.x, and supplying an
 * unknown key makes TypeScript fall through to a different createTransport
 * overload and report the misleading "'host' does not exist". Widening the type
 * here is narrower and more honest than casting the whole options object to
 * any, which would have silenced real mistakes in the same literal.
 */
type SmtpOptions = SMTPTransport.Options & { family?: 4 | 6 };

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
) ? nodemailer.createTransport(<SmtpOptions>{
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT ?? '587'),
  secure: process.env.SMTP_PORT === '465',

  // ── WHY family: 4 ─────────────────────────────────────────────────────────
  // Without it, Node resolves AAAA first and Render's container has no usable
  // route to Google's IPv6 space, so every send died before TLS:
  //
  //   [dailySummary] Failed for Beryl: connect ENETUNREACH 2607:f8b0:400e:c02::6c:587
  //
  // That is a NETWORK-layer failure on connect(), so nothing was authenticated
  // and no recipient was ever offered — which is how we know it was not bad
  // addresses on the test businesses: a bad recipient produces an SMTP 550
  // after RCPT TO, and Beryl (a real client) failed identically. Nine
  // businesses, every night, two days observed, zero delivered.
  //
  // The `Connection timeout` entries in the same run are the same fault hitting
  // connectionTimeout below instead of failing instantly — a different IPv6
  // route, not a different problem.
  //
  // This is the FALLBACK path, so it is what everything lands on whenever
  // Resend is unset or has a bad day. It has to work on its own. See A50.
  family: 4,

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
 * Prove at boot that mail can actually be sent, and say so plainly if not.
 *
 * ── WHY THIS EXISTS (register A50) ────────────────────────────────────────────
 * Daily summaries failed for NINE businesses on every run across two observed
 * days and nobody knew, because `dailySummary.ts:61` catches per business, logs,
 * and moves on. The only trace was a line in a log at 18:00 UTC. A feature the
 * customers believe they have was dead, silently, for as long as anyone has
 * been looking.
 *
 * A boot check turns a nightly silent failure into one line at startup, next to
 * the other things that are wrong. It does NOT gate anything — a shop's tills
 * must not fail to trade because nobody verified a mail domain. Same reasoning
 * as `reportSeededAdmins`.
 *
 * `verify()` opens a connection and authenticates without sending, so it catches
 * exactly the class that bit us: ENETUNREACH, timeouts, bad credentials. It
 * cannot catch a `from` domain the provider will later refuse — the free-mail
 * check above handles the common case of that.
 *
 * Never throws, never awaited by the caller.
 */
export async function reportMailReadiness(): Promise<void> {
  if (!resend && !smtpTransport) {
    console.warn(
      '[mailer] NO EMAIL PROVIDER CONFIGURED. Daily summaries and low-stock '
      + 'alerts will not be delivered. Set RESEND_API_KEY, or SMTP_HOST + '
      + 'SMTP_USER + SMTP_PASS.',
    );
    return;
  }

  if (resend) {
    console.info('[mailer] Resend configured (primary).');
  } else {
    console.info(
      '[mailer] RESEND_API_KEY not set — SMTP is the ONLY path, so a failure '
      + 'here means no email is delivered at all.',
    );
  }

  if (!smtpTransport) {
    console.warn(
      '[mailer] No SMTP fallback configured. If Resend rejects a message '
      + '(unverified domain is the usual cause) it will not be delivered.',
    );
    return;
  }

  try {
    await smtpTransport.verify();
    console.info(
      `[mailer] SMTP fallback reachable: ${process.env.SMTP_HOST}:`
      + `${process.env.SMTP_PORT ?? '587'} (IPv4).`,
    );
  } catch (err: any) {
    console.error(
      `[mailer] SMTP FALLBACK IS DEAD — ${process.env.SMTP_HOST}:`
      + `${process.env.SMTP_PORT ?? '587'} — ${err?.message ?? err}\n`
      + '         Nothing will be delivered through it. If this reads ENETUNREACH\n'
      + '         with an IPv6 address, the `family: 4` above is not taking effect.',
    );
  }
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
