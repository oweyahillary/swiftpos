import { Resend } from 'resend';
import nodemailer from 'nodemailer';
import dns from 'node:dns/promises';


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

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = parseInt(process.env.SMTP_PORT ?? '587');

/**
 * The SMTP host, pinned to an IPv4 literal.
 *
 * ── WHY THIS IS NOT `family: 4` (register A50, second attempt) ────────────────
 * The first fix set `family: 4` on the transport. It changed nothing, and the
 * boot check said so in production:
 *
 *   [mailer] SMTP FALLBACK IS DEAD — smtp.gmail.com:587 —
 *            connect ENETUNREACH 2607:f8b0:400e:c20::6c:587
 *
 * **nodemailer never reads `family` when resolving.** `smtp-connection/index.js`
 * builds its DNS options as `{ port, host, allowInternalNetworkInterfaces,
 * timeout }` — `family` is not among them. Resolution then goes through
 * `dns.lookup(host, { all: true })`, filters with `isFamilySupported()` (which
 * asks whether this machine HAS an IPv6 interface, not whether it has a working
 * ROUTE), and `formatDNSValue()` picks **a random address from what survives**.
 *
 * Render's container has an IPv6 interface and no usable route, so nodemailer
 * counted IPv6 as supported and chose it roughly half the time. That also
 * explains the mixed `ENETUNREACH` and `Connection timeout` lines in the same
 * run — different random picks, one failing instantly and one hitting
 * connectionTimeout. Not two problems; one.
 *
 * Because the pick is RANDOM rather than ordered, `dns.setDefaultResultOrder
 * ('ipv4first')` would not have fixed it either. The only reliable lever is to
 * hand nodemailer an address it cannot get wrong.
 *
 * So: resolve A records ourselves and connect to the literal, with
 * `tls.servername` set to the real hostname so certificate validation still
 * matches — without it, TLS would be checked against "74.125.126.108" and every
 * send would fail verification instead of routing.
 *
 * Re-resolved on a TTL because Google rotates these addresses. On failure we
 * keep the last good value rather than falling back to the hostname, since the
 * hostname is exactly what does not work here.
 */
let _pinnedIPv4: string | null = null;
let _pinnedAt = 0;
const PIN_TTL_MS = 10 * 60_000;

async function resolveSmtpIPv4(): Promise<string | null> {
  if (!SMTP_HOST) return null;
  if (_pinnedIPv4 && Date.now() - _pinnedAt < PIN_TTL_MS) return _pinnedIPv4;
  try {
    const [addr] = await dns.resolve4(SMTP_HOST);
    if (addr) { _pinnedIPv4 = addr; _pinnedAt = Date.now(); }
  } catch {
    // Keep the previous value. A DNS blip must not demote us back to the
    // hostname, because the hostname is the failure mode.
  }
  return _pinnedIPv4;
}

/**
 * Built per send rather than once at module load, because the pinned address
 * has a TTL. Creating a transport is cheap — it opens no socket until sendMail.
 */
async function getSmtpTransport() {
  if (!SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) return null;

  const ipv4 = await resolveSmtpIPv4();

  return nodemailer.createTransport({
    // The literal when we have one; the hostname only as a last resort, which
    // is no worse than the behaviour that was already failing.
    host: ipv4 ?? SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,

    connectionTimeout: 10_000,
    greetingTimeout:   10_000,
    socketTimeout:     20_000,

    // Certificate validation must still be against the NAME, not the address.
    tls: { servername: SMTP_HOST },

    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

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
  const smtp = await getSmtpTransport();

  if (!resend && !smtp) {
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

  if (!smtp) {
    console.warn(
      '[mailer] No SMTP fallback configured. If Resend rejects a message '
      + '(unverified domain is the usual cause) it will not be delivered.',
    );
    return;
  }

  try {
    await smtp.verify();
    console.info(
      `[mailer] SMTP fallback reachable: ${SMTP_HOST}:${SMTP_PORT} `
      + `via ${_pinnedIPv4 ?? 'hostname'} (IPv4 pinned).`,
    );
  } catch (err: any) {
    console.error(
      `[mailer] SMTP FALLBACK IS DEAD — ${SMTP_HOST}:${SMTP_PORT} `
      + `(pinned to ${_pinnedIPv4 ?? 'NOTHING — A-record lookup failed'}) — `
      + `${err?.message ?? err}\n`
      + '         Nothing will be delivered through it. An ENETUNREACH on an\n'
      + '         IPv6 address here would mean the pin is not being applied at\n'
      + '         all, since a pinned A record cannot resolve to one.',
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
  const smtp = await getSmtpTransport();
  if (smtp) {
    await smtp.sendMail({
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
