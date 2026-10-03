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
const DEFAULT_FROM = process.env.NOTIFY_FROM_EMAIL ?? 'SwiftPOS <noreply@zaptill.co.ke>';

const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

// ─────────────────────────────────────────────────────────────────────────────
// SENDGRID (A352, 2026-09-28) — owner: "resend is the primary, if it fails sendgrid kicks in or smtp, the two
// work as backup". Order: Resend → SendGrid → SMTP; each is tried only when the one before it is not set or fails.
// Over HTTPS (api.sendgrid.com:443), never SMTP: Render filters outbound SMTP
// (A54 — the reason no mail has been delivered), and 443 is always open. Plain
// fetch, so no new dependency. SendGrid only sends from a VERIFIED sender: a
// Single Sender (one address) or, better, an authenticated domain; anything
// else is refused with 403 "does not match a verified Sender Identity".
// ─────────────────────────────────────────────────────────────────────────────
const SENDGRID_KEY = process.env.SENDGRID_API_KEY || null;
const SENDGRID_URL = 'https://api.sendgrid.com/v3/mail/send';

/** "SwiftPOS <noreply@x.co.ke>" → { name: 'SwiftPOS', email: 'noreply@x.co.ke' }; a bare address → { email }. */
export function parseFrom(from: string): { email: string; name?: string } {
  const m = /^\s*(?:"?([^"<]*?)"?\s*)?<([^<>\s]+@[^<>\s]+)>\s*$/.exec(from);
  if (m) return m[1] ? { name: m[1].trim(), email: m[2] } : { email: m[2] };
  return { email: from.trim() };
}

/** "a@x.com, b@y.com" (or ;-separated) → ['a@x.com', 'b@y.com'], blanks and duplicates dropped. */
export function splitRecipients(to: string): string[] {
  return [...new Set(String(to ?? '').split(/[,;]/).map((t) => t.trim()).filter(Boolean))];
}

/**
 * One send through SendGrid's v3 API. Resolves null on success (SendGrid answers 202 Accepted), else the
 * provider's own error text — SendGrid returns { errors: [{ message }] } — so the caller can log it or fall back.
 * Never throws: a network failure comes back as its message, like a refusal.
 */
export async function sendViaSendGrid(opts: { from: string; to: string; subject: string; html: string }): Promise<string | null> {
  if (!SENDGRID_KEY) return 'SENDGRID_API_KEY is not set';
  try {
    const res = await fetch(SENDGRID_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${SENDGRID_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // One "a@x, b@y" string (dailySummary joins its recipients) → one entry per address; SendGrid refuses the joined form.
        personalizations: [{ to: splitRecipients(opts.to).map((email) => ({ email })) }],
        from: parseFrom(opts.from),
        subject: opts.subject,
        content: [{ type: 'text/html', value: opts.html }],
      }),
    });
    if (res.status >= 200 && res.status < 300) return null;
    let detail = '';
    try {
      const j: any = await res.json();
      detail = Array.isArray(j?.errors) ? j.errors.map((e: any) => e?.message).filter(Boolean).join('; ') : '';
    } catch { /* not JSON */ }
    return `HTTP ${res.status}${detail ? ` — ${detail}` : ''}`;
  } catch (err: any) {
    return err?.message ?? String(err);
  }
}

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
 * counted IPv6 as supported and chose it roughly half the time.
 *
 * ── CORRECTION, 2026-08-10 (register A54) ─────────────────────────────────────
 * This comment used to end: *"That also explains the mixed ENETUNREACH and
 * Connection timeout lines in the same run — different random picks, one failing
 * instantly and one hitting connectionTimeout. **Not two problems; one.**"*
 *
 * **That was wrong, and production disproved it.** With the pin applied and IPv6
 * eliminated by construction, the boot check still reported:
 *
 *   [mailer] SMTP FALLBACK IS DEAD — smtp.gmail.com:587
 *            (pinned to 74.125.195.108) — Connection timeout
 *
 * `74.125.195.108` is IPv4, so the pin demonstrably worked and the ENETUNREACH
 * half is genuinely closed. The timeout survived it. It **was** two problems.
 *
 * The second one is not a DNS fault and no amount of address pinning reaches it:
 * a connect-layer timeout to a valid IPv4 literal means the SYN is being dropped,
 * i.e. the port is filtered upstream. Render blocks outbound 25/465/587 on FREE
 * web services (25 is blocked on every plan, they run on EC2). `render.yaml`
 * declares `plan: starter`, on which 465 and 587 are permitted — so either the
 * live instance is not on the plan the blueprint declares, or something else
 * filters 587.
 *
 * Nothing in this file can fix a filtered port. What it CAN do is stop reporting
 * the same four-line hint for every failure class, which is what sent the last
 * diagnosis down the DNS hole. `classifySmtpFailure` below reads the error and
 * names the cause. Rule 6: the class, not the line that shouted.
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
async function getSmtpTransport(portOverride?: number) {
  if (!SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) return null;

  const ipv4 = await resolveSmtpIPv4();

  // Defaults to the configured port. The override exists ONLY for the boot
  // probe (A54): when the configured port times out, we try the alternate and
  // tell the owner which one answered. The SEND path never passes it, so send
  // behaviour is unchanged — a probe that silently rerouted real mail to a port
  // the owner did not configure would be a worse bug than the one it diagnoses.
  const port = portOverride ?? SMTP_PORT;

  return nodemailer.createTransport({
    // The literal when we have one; the hostname only as a last resort, which
    // is no worse than the behaviour that was already failing.
    host: ipv4 ?? SMTP_HOST,
    port,
    secure: port === 465,

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
// SendGrid (a backup) will verify a free-mail Single Sender, but Gmail/Yahoo's DMARC policy then sends the mail to spam or
// rejects it at the recipient — the same silent non-delivery. Say so at boot.
if (SENDGRID_KEY && FREE_MAIL.test(DEFAULT_FROM)) {
  console.warn(
    `[mailer] NOTIFY_FROM_EMAIL is "${DEFAULT_FROM}" — a free-mail sender through SendGrid fails ` +
    'the recipient\'s DMARC check (spam or rejected). Authenticate your own domain in SendGrid ' +
    '(Settings → Sender Authentication) and send from an address on it.',
  );
}
if (resend && FREE_MAIL.test(DEFAULT_FROM)) {
  console.warn(
    `[mailer] NOTIFY_FROM_EMAIL is "${DEFAULT_FROM}" — Resend cannot send from a ` +
    'free-mail domain and will reject every message. Verify your own domain at ' +
    'https://resend.com/domains and set NOTIFY_FROM_EMAIL to an address on it.',
  );
}

/**
 * Turn an SMTP failure into the thing the reader should go and check.
 *
 * ── WHY (register A54) ────────────────────────────────────────────────────────
 * The previous boot check printed the SAME four-line hint for every failure —
 * and that hint only described ENETUNREACH, one specific cause on one specific
 * layer. When the real failure turned out to be a connect timeout, the hint said
 * nothing useful about it and actively pointed at DNS, which had already been
 * fixed. A50 was diagnosed, fixed and reopened three times; at least one of those
 * rounds went down the wrong hole because the log only knew how to describe one
 * fault.
 *
 * These classes are ordered most-specific first. Every one of them is a cause
 * that has actually been observed on this deployment or is the documented
 * behaviour of the host, not a guess at what might go wrong.
 */
export function classifySmtpFailure(err: any, host: string, port: number): string {
  const code = String(err?.code ?? '');
  const msg  = String(err?.message ?? err ?? '');

  // ENETUNREACH to a v6 literal means the IPv4 pin is not reaching the socket.
  // A pinned A record cannot resolve to an IPv6 address, so this is a REGRESSION
  // of the A50 fix rather than a new fault. Colons in the address are the tell.
  if (code === 'ENETUNREACH' || /ENETUNREACH/.test(msg)) {
    if (/:[0-9a-f]*:/i.test(msg)) {
      return 'The IPv4 pin is NOT being applied — this is an IPv6 address, and a '
           + 'pinned A record cannot resolve to one. Check that resolveSmtpIPv4() '
           + 'returned a literal and that host: uses it (register A50).';
    }
    return 'The network has no route to that address at all. Check outbound '
         + 'egress rules on the host.';
  }

  // A connect-layer timeout to a valid literal is a dropped SYN, i.e. filtering.
  // This is the A54 case and the one the old hint could not describe.
  if (code === 'ETIMEDOUT' || code === 'ESOCKET' || /timeout/i.test(msg)) {
    return `Connect timed out against a valid address, which means the SYN is `
         + `being dropped — port ${port} is filtered upstream, NOT a DNS or `
         + `credential problem.\n`
         + `         MOST LIKELY: Render blocks outbound 25/465/587 on FREE web `
         + `services (25 is blocked on every plan). render.yaml declares `
         + `plan: starter, on which 465 and 587 are allowed.\n`
         + `         CHECK THE LIVE INSTANCE TYPE IN THE RENDER DASHBOARD FIRST`
         + ` — the blueprint is not proof of what is running.\n`
         + `         No change to this file can fix a filtered port.`;
  }

  // Gmail rejects a plain account password outright once 2FA is on. This fails
  // at AUTH, well after connect, so it is a different fault from the above and
  // must not be described as one.
  if (code === 'EAUTH' || /535|5\.7\.\d|invalid login|username and password/i.test(msg)) {
    return 'The connection SUCCEEDED and authentication was rejected — so the '
         + 'network path is fine and SMTP_USER / SMTP_PASS are the problem. '
         + 'Gmail refuses ordinary account passwords: SMTP_PASS must be a '
         + '16-character App Password generated for this account.';
  }

  if (code === 'ECONNREFUSED') {
    return `Something answered and refused the connection — ${host}:${port} is `
         + `reachable but not speaking SMTP there. Check SMTP_HOST and SMTP_PORT.`;
  }

  if (/certificate|self.signed|altname/i.test(msg)) {
    return 'TLS validation failed. Because we connect to a pinned literal, '
         + 'tls.servername must carry the real hostname or the certificate is '
         + 'checked against the IP address and every send fails here.';
  }

  return 'Unrecognised failure class — record it in register A54 with the '
       + 'verbatim text (rule 11) rather than guessing at a cause.';
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

  if (!resend && !SENDGRID_KEY && !smtp) {
    console.warn(
      '[mailer] NO EMAIL PROVIDER CONFIGURED. Daily summaries and low-stock '
      + 'alerts will not be delivered. Set RESEND_API_KEY (primary), and '
      + 'SENDGRID_API_KEY or SMTP_HOST + SMTP_USER + SMTP_PASS as backup.',
    );
    return;
  }

  // No send at boot for any provider (it would email someone on every deploy); "Send test email" proves delivery.
  if (resend) {
    console.info('[mailer] Resend configured (primary).');
  } else {
    console.warn('[mailer] RESEND_API_KEY not set — the primary is missing, so the backups carry every email.');
  }
  if (SENDGRID_KEY) {
    console.info(`[mailer] SendGrid configured (backup${resend ? '' : ', standing in for Resend'}), sending as ${DEFAULT_FROM}.`);
  }
  if (!resend && !SENDGRID_KEY) {
    console.info(
      '[mailer] Neither Resend nor SendGrid is set — SMTP is the ONLY path, so a '
      + 'failure here means no email is delivered at all.',
    );
  }

  if (!smtp) {
    if (!SENDGRID_KEY) {
      console.warn(
        '[mailer] No backup configured (neither SendGrid nor SMTP). If Resend rejects '
        + 'a message (unverified domain is the usual cause) it will not be delivered.',
      );
    } else if (!resend) {
      console.warn('[mailer] SendGrid is the only provider — if it refuses a message, it is not delivered.');
    }
    return;
  }

  try {
    await smtp.verify();
    console.info(
      `[mailer] SMTP fallback reachable: ${SMTP_HOST}:${SMTP_PORT} `
      + `via ${_pinnedIPv4 ?? 'hostname'} (IPv4 pinned).`,
    );
  } catch (err: any) {
    const onlyPath = !resend && !SENDGRID_KEY;
    console.error(
      `[mailer] SMTP ${onlyPath ? 'IS DEAD AND IS THE ONLY PATH' : 'FALLBACK IS DEAD'}`
      + ` — ${SMTP_HOST}:${SMTP_PORT} `
      + `(pinned to ${_pinnedIPv4 ?? 'NOTHING — A-record lookup failed'}) — `
      + `${err?.message ?? err}\n`
      + `         ${classifySmtpFailure(err, SMTP_HOST!, SMTP_PORT)}`,
    );

    // Probe the other standard submission port and say whether it answers.
    // Diagnostic ONLY — this never changes where mail is sent. The owner reads
    // one line and knows whether to change SMTP_PORT or to go and look at the
    // instance plan, instead of the two being indistinguishable in the log.
    const alt = SMTP_PORT === 587 ? 465 : SMTP_PORT === 465 ? 587 : null;
    if (alt) {
      const altSmtp = await getSmtpTransport(alt);
      if (altSmtp) {
        try {
          await altSmtp.verify();
          console.error(
            `[mailer] …but port ${alt} DOES answer on the same host. Set `
            + `SMTP_PORT=${alt} and mail will flow. (Only ${SMTP_PORT} is `
            + `filtered, so this is not the free-instance SMTP block, which `
            + `covers 465 and 587 together.)`,
          );
        } catch (altErr: any) {
          console.error(
            `[mailer] …and port ${alt} fails too: ${altErr?.message ?? altErr}. `
            + `Both submission ports blocked is the signature of the host `
            + `filtering SMTP outright, not of a misconfigured port.`,
          );
        }
      }
    }
  }
}

/**
 * Send an email: Resend (primary), then SendGrid (backup, A352), then Nodemailer SMTP (backup).
 * Logs a warning if neither provider is configured (dev/test environments).
 */
export async function sendEmail(opts: MailOptions): Promise<void> {
  const from = opts.from ?? DEFAULT_FROM;
  const failures: string[] = [];

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
      failures.push(`Resend: ${error.message}`);
      console.warn('[mailer] Resend error, falling back to SendGrid / SMTP:', error.message);
    } catch (err: any) {
      failures.push(`Resend: ${err?.message ?? err}`);
      console.warn('[mailer] Resend threw, falling back to SendGrid / SMTP:', err?.message);
    }
  }

  // ── Backup 1: SendGrid (A352) ─────────────────────────────
  if (SENDGRID_KEY) {
    const sgError = await sendViaSendGrid({ from, to: opts.to, subject: opts.subject, html: opts.html });
    if (!sgError) return;
    failures.push(`SendGrid: ${sgError}`);
    console.warn('[mailer] SendGrid error, falling back to SMTP:', sgError);
  }

  // ── Backup 2: Nodemailer SMTP ─────────────────────────────
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

  // ── Every configured provider refused: a FAILURE, not "no provider" — throw so the job's per-business catch
  //    logs it with each provider's reason (A352), exactly as an SMTP failure throws above.
  if (failures.length) throw new Error(`Email "${opts.subject}" to ${opts.to} was not sent — ${failures.join('; ')}`);

  // ── Nothing configured ────────────────────────────────────
  console.warn('[mailer] No email provider configured. Email not sent:', opts.subject, '→', opts.to);
}

export interface SendResult {
  ok: boolean;
  provider: 'sendgrid' | 'resend' | 'smtp' | 'none';
  error?: string;
}

/**
 * Like sendEmail, but RETURNS the outcome instead of logging and swallowing it.
 *
 * The jobs (daily summary, low-stock) are fire-and-forget and use sendEmail —
 * a failure there must not crash a job, so it logs and moves on. But a human
 * asking "does email work?" needs the answer handed back, not left in a log:
 * the owner-only test-email endpoint (register A54) calls this to prove one real
 * message was delivered, by which provider, or to read the exact provider error.
 * Same order as sendEmail (Resend first, SMTP fallback) so it tests the real path.
 */
export async function sendEmailChecked(opts: MailOptions): Promise<SendResult> {
  const from = opts.from ?? DEFAULT_FROM;
  const failures: string[] = [];

  if (resend) {
    try {
      const { error } = await resend.emails.send({
        from, to: opts.to, subject: opts.subject, html: opts.html,
      });
      if (!error) return { ok: true, provider: 'resend' };
      failures.push(`Resend: ${error.message}`);
    } catch (err: any) {
      failures.push(`Resend: ${err?.message ?? String(err)}`);
    }
  }

  if (SENDGRID_KEY) {
    const sgError = await sendViaSendGrid({ from, to: opts.to, subject: opts.subject, html: opts.html });
    if (!sgError) return { ok: true, provider: 'sendgrid' };
    failures.push(`SendGrid: ${sgError}`);
  }

  const smtp = await getSmtpTransport();
  if (smtp) {
    try {
      await smtp.sendMail({ from, to: opts.to, subject: opts.subject, html: opts.html });
      return { ok: true, provider: 'smtp' };
    } catch (err: any) {
      return {
        ok: false, provider: 'smtp',
        error: `${failures.length ? `${failures.join('; ')}; ` : ''}SMTP: ${err?.message ?? err} — ${classifySmtpFailure(err, SMTP_HOST!, SMTP_PORT)}`,
      };
    }
  }

  if (failures.length) {
    return {
      ok: false, provider: SENDGRID_KEY ? 'sendgrid' : 'resend',
      error: `${failures.join('; ')} — and no SMTP fallback is configured.`,
    };
  }
  return {
    ok: false, provider: 'none',
    error: 'No email provider configured. Set RESEND_API_KEY (primary), and SENDGRID_API_KEY or SMTP_HOST + SMTP_USER + SMTP_PASS as backup.',
  };
}
