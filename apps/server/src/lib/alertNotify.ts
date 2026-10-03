/**
 * alertNotify.ts — A383: tell the SwiftPOS admin — Telegram and email together ("telegram and email combo").
 *
 *   TELEGRAM_BOT_TOKEN   the bot's token from @BotFather
 *   TELEGRAM_CHAT_ID     who gets it: a chat, a group or a channel id (several: comma-separated)
 *   ADMIN_ALERT_EMAIL    who gets the email (several: comma-separated); sent through lib/mailer.ts (Resend → SendGrid)
 *
 * Either channel alone works; neither = the watchdog only logs. Never throws: a failed alert is logged, the job goes on.
 */
import { sendEmailChecked } from './mailer';

const TG_API = 'https://api.telegram.org';
const list = (v: string | undefined) => String(v ?? '').split(/[,;]/).map((s) => s.trim()).filter(Boolean);

export function alertChannels(): { telegram: boolean; email: boolean } {
  return {
    telegram: Boolean(process.env.TELEGRAM_BOT_TOKEN) && list(process.env.TELEGRAM_CHAT_ID).length > 0,
    email: list(process.env.ADMIN_ALERT_EMAIL).length > 0,
  };
}

/** One Telegram message to every configured chat. null = sent; else the error. */
export async function sendTelegram(text: string): Promise<string | null> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chats = list(process.env.TELEGRAM_CHAT_ID);
  if (!token || !chats.length) return 'Telegram is not set (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID)';
  const errors: string[] = [];
  for (const chat_id of chats) {
    try {
      const res = await fetch(`${TG_API}/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Plain text: a client's name with "_" or "*" must never break the message (no parse_mode).
        body: JSON.stringify({ chat_id, text: text.slice(0, 4000), disable_web_page_preview: true }),
      });
      if (!res.ok) {
        let d = '';
        try { d = String(((await res.json()) as any)?.description ?? ''); } catch { /* not JSON */ }
        errors.push(`chat ${chat_id}: HTTP ${res.status}${d ? ` — ${d}` : ''}`);
      }
    } catch (err: any) {
      errors.push(`chat ${chat_id}: ${err?.message ?? String(err)}`);
    }
  }
  return errors.length ? errors.join('; ') : null;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The email: the same text, kept as lines. null = sent; else the error. */
export async function sendAlertEmail(subject: string, text: string): Promise<string | null> {
  const to = list(process.env.ADMIN_ALERT_EMAIL);
  if (!to.length) return 'ADMIN_ALERT_EMAIL is not set';
  const html = `<div style="font-family:system-ui,sans-serif;font-size:14px;white-space:pre-wrap">${esc(text)}</div>`;
  try {
    const r = await sendEmailChecked({ to: to.join(', '), subject, html });
    return r.ok ? null : (r.error ?? 'not sent');
  } catch (err: any) {
    return err?.message ?? String(err);
  }
}

/** Both channels. Resolves which ones worked; logs the ones that did not. */
export async function notifyAdmin(subject: string, text: string): Promise<{ telegram: boolean; email: boolean }> {
  const ch = alertChannels();
  const [tg, em] = await Promise.all([
    ch.telegram ? sendTelegram(text) : Promise.resolve('off'),
    ch.email ? sendAlertEmail(subject, text) : Promise.resolve('off'),
  ]);
  if (ch.telegram && tg) console.warn('[watchdog] Telegram not sent:', tg);
  if (ch.email && em) console.warn('[watchdog] alert email not sent:', em);
  if (!ch.telegram && !ch.email) console.warn(`[watchdog] no alert channel set — ${subject}\n${text}`);
  return { telegram: ch.telegram && !tg, email: ch.email && !em };
}
