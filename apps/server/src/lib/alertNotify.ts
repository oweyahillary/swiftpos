/**
 * alertNotify.ts — A383: tell the ZapTill admin — Telegram and email together ("telegram and email combo").
 *
 * A392 (owner, 2026-10-04): "all alerts emails should only get critical failures" — the watchdog passes email: false for
 * everything else (the digest, "resolved"); those reach Telegram and the admin portal's Alerts page.
 *
 * A592 (owner, 2026-10-26: "How can we make these messages look better"): a message laid out by lib/alertFormat.ts goes
 * to Telegram as HTML (parse_mode HTML, every value escaped) with URL buttons under it (reply_markup inline_keyboard —
 * "Open in admin", "Open run", "Guide"). Telegram refuses a message it cannot read (400 "can't parse entities", or a
 * button it will not take) — then it is sent ONCE MORE as plain text, the links written out, so an alert is never lost.
 * The email gets its HTML and a text/plain part.
 *
 *   TELEGRAM_BOT_TOKEN   the bot's token from @BotFather
 *   TELEGRAM_CHAT_ID     who gets it: a chat, a group or a channel id (several: comma-separated)
 *   ADMIN_ALERT_EMAIL    who gets the email (several: comma-separated); sent through lib/mailer.ts (Resend → SendGrid)
 *   ADMIN_PORTAL_URL     the admin portal the buttons open (default https://admin.zaptill.co.ke)
 *   GITHUB_REPO_URL      where the guides are (default https://github.com/oweyahillary/swiftpos)
 *
 * Either channel alone works; neither = the watchdog only logs. Never throws: a failed alert is logged, the job goes on.
 */
import { sendEmailChecked } from './mailer';
import { DEFAULT_LINKS, telegramKeyboard, emailHtml, escapeHtml, type AlertLinks, type LinkButton } from './alertFormat';

const TG_API = 'https://api.telegram.org';
const list = (v: string | undefined) => String(v ?? '').split(/[,;]/).map((s) => s.trim()).filter(Boolean);

export function alertChannels(): { telegram: boolean; email: boolean } {
  return {
    telegram: Boolean(process.env.TELEGRAM_BOT_TOKEN) && list(process.env.TELEGRAM_CHAT_ID).length > 0,
    email: list(process.env.ADMIN_ALERT_EMAIL).length > 0,
  };
}

/** A592: where the buttons point — the admin portal and the repository's guides. */
export function alertLinks(env: Record<string, string | undefined> = process.env): AlertLinks {
  const ok = (u: string | undefined) => (u && /^https?:\/\//.test(u.trim()) ? u.trim().replace(/\/+$/, '') : null);
  return { admin: ok(env.ADMIN_PORTAL_URL) ?? DEFAULT_LINKS.admin, repo: ok(env.GITHUB_REPO_URL) ?? DEFAULT_LINKS.repo };
}

export interface TelegramRich { html?: string; buttons?: LinkButton[] }

/**
 * One Telegram message to every configured chat. `text` is the plain text; `rich.html` (lib/alertFormat.ts telegramHtml)
 * is sent instead when given, with `rich.buttons`. A 400 on the HTML → once more as `text`, plain (its links written out).
 * null = sent; else the error.
 */
export async function sendTelegram(text: string, rich: TelegramRich = {}): Promise<string | null> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chats = list(process.env.TELEGRAM_CHAT_ID);
  if (!token || !chats.length) return 'Telegram is not set (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID)';
  const keyboard = telegramKeyboard(rich.buttons);
  const post = async (body: Record<string, unknown>) => {
    const res = await fetch(`${TG_API}/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    let d = '';
    if (!res.ok) { try { d = String(((await res.json()) as any)?.description ?? ''); } catch { /* not JSON */ } }
    return { ok: res.ok, status: res.status, d };
  };
  const errors: string[] = [];
  for (const chat_id of chats) {
    try {
      const plain = { chat_id, text: text.slice(0, 4000), disable_web_page_preview: true };
      let r = rich.html
        ? await post({ chat_id, text: rich.html, parse_mode: 'HTML', disable_web_page_preview: true, ...(keyboard ? { reply_markup: keyboard } : {}) })
        : await post({ ...plain, ...(keyboard ? { reply_markup: keyboard } : {}) });
      if (!r.ok && r.status === 400) {
        // "can't parse entities" (a value the escaping missed) or a button Telegram refused: never lose the alert.
        console.warn(`[alerts] Telegram refused the formatted message for chat ${chat_id} (${r.d || 'HTTP 400'}) — sending it as plain text`);
        r = await post(plain);
      }
      if (!r.ok) errors.push(`chat ${chat_id}: HTTP ${r.status}${r.d ? ` — ${r.d}` : ''}`);
    } catch (err: any) {
      errors.push(`chat ${chat_id}: ${err?.message ?? String(err)}`);
    }
  }
  return errors.length ? errors.join('; ') : null;
}

/**
 * The email: `htmlBody` when given (lib/alertFormat.ts emailHtml — the layout, a table), else the text in the same layout.
 * `text` is the text/plain part. null = sent; else the error.
 */
export async function sendAlertEmail(subject: string, text: string, htmlBody?: string): Promise<string | null> {
  const to = list(process.env.ADMIN_ALERT_EMAIL);
  if (!to.length) return 'ADMIN_ALERT_EMAIL is not set';
  const html = htmlBody ?? emailHtml({ tone: 'info', headline: subject }, alertLinks(),
    `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:14px;line-height:1.5;color:#344054;white-space:pre-wrap">${escapeHtml(text)}</div>`);
  try {
    const r = await sendEmailChecked({ to: to.join(', '), subject, html, text });
    return r.ok ? null : (r.error ?? 'not sent');
  } catch (err: any) {
    return err?.message ?? String(err);
  }
}

export interface NotifyOptions {
  email?: boolean;
  telegram?: boolean;
  /** The email's HTML (lib/alertFormat.ts emailHtml). */
  html?: string;
  /** A592: Telegram's HTML (lib/alertFormat.ts telegramHtml) — `text` stays the plain fallback. */
  tgHtml?: string;
  /** A592: the URL buttons under the Telegram message. */
  buttons?: LinkButton[];
  /** A592: the email's text/plain part, when it differs from `text` (the footer). */
  emailText?: string;
}

/**
 * Both channels (or Telegram only: email false; or A589: email only — telegram false). `html` is the email's body when
 * given; Telegram gets `tgHtml` and `buttons` when given (A592), else the plain text. Resolves which ones worked; logs the
 * ones that did not.
 */
export async function notifyAdmin(subject: string, text: string, opts: NotifyOptions = {}): Promise<{ telegram: boolean; email: boolean }> {
  const all = alertChannels();
  const ch = { telegram: all.telegram && opts.telegram !== false, email: all.email && opts.email !== false };
  const [tg, em] = await Promise.all([
    ch.telegram ? sendTelegram(text, { html: opts.tgHtml, buttons: opts.buttons }) : Promise.resolve('off'),
    ch.email ? sendAlertEmail(subject, opts.emailText ?? text, opts.html) : Promise.resolve('off'),
  ]);
  if (ch.telegram && tg) console.warn('[watchdog] Telegram not sent:', tg);
  if (ch.email && em) console.warn('[watchdog] alert email not sent:', em);
  if (!all.telegram && !all.email) console.warn(`[watchdog] no alert channel set — ${subject}\n${text}`);
  return { telegram: ch.telegram && !tg, email: ch.email && !em };
}

/** A592: a message rendered by lib/alertFormat.ts renderMessage, sent as it is. */
export function notifyRendered(m: { subject: string; text: string; tgHtml: string; buttons: LinkButton[]; html: string; emailText: string },
  opts: { email?: boolean; telegram?: boolean } = {}): Promise<{ telegram: boolean; email: boolean }> {
  return notifyAdmin(m.subject, m.text, { ...opts, html: m.html, tgHtml: m.tgHtml, buttons: m.buttons, emailText: m.emailText });
}
