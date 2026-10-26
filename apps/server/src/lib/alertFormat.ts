/**
 * alertFormat.ts — A592: how an admin alert LOOKS — on Telegram (HTML, link buttons) and in the email (one layout, with a
 * plain-text part) — and the words for time (Nairobi). PURE: no database, no network, no clock (`now` is passed).
 *
 * Owner, 2026-10-26, showing two Telegram messages ("ZapTill nightly backup FAILED — 26 Oct 13:07 / 🔴 The nightly backup
 * … FAILED … (exit 252) …" and "🔴 STILL HAPPENING — for 214 h 40 min / [a client]: day 2026-10-09 not closed on T1 / The
 * business day ended 397 h 50 min ago …"): "How can we make these messages look better".
 *
 * Every admin message is ONE shape (AdminMessage) rendered three ways:
 *   telegramHtml   🔴 <b>headline</b> · one summary line · "Label: value" facts · 👉 one line of what to do · sections of
 *                  bullet lines (max lines, then "+N more in the admin portal") · buttons as an inline keyboard of URLs
 *                  (no callback buttons). Every interpolated value is escaped (escapeHtml); capped under Telegram's 4096.
 *   plainText      the same words without tags, the buttons as "Open run: https://…" lines — Telegram's fallback when it
 *                  refuses the HTML (lib/alertNotify.ts: a 400 → once more as plain text, so an alert is never lost) and the
 *                  email's text/plain part.
 *   emailHtml      Gmail-safe: tables and inline styles only (no <style>, no external CSS), a coloured top bar, the
 *                  headline, the facts, the action box, the buttons, any table (the digest), and one footer with the
 *                  admin portal's Alerts and Email settings.
 * Times: "Mon 26 Oct 13:07 EAT"; durations "just now" / "3 h 15 min" / "8 days 22 h" (lib/watchdogRules.ts — kept there
 * because that file is imported as TypeScript by the tests and must stay import-free).
 */
import { durationLabel, shortDuration, dayLabel } from './watchdogRules';

export { durationLabel, shortDuration, dayLabel };

export type Tone = 'critical' | 'warning' | 'resolved' | 'digest' | 'billing' | 'info' | 'test';

export const TONE_EMOJI: Record<Tone, string> = {
  critical: '🔴', warning: '🟠', resolved: '✅', digest: '🗓', billing: '💳', info: 'ℹ️', test: '🧪',
};
const TONE_COLOR: Record<Tone, string> = {
  critical: '#d92d20', warning: '#dc6803', resolved: '#079455', digest: '#1570ef', billing: '#7a5af8', info: '#475467', test: '#475467',
};
const TONE_WORD: Record<Tone, string> = {
  critical: 'Critical', warning: 'Warning', resolved: 'Resolved', digest: 'Daily check', billing: 'Billing', info: 'Notice', test: 'Test',
};
/** The soft background and text of a severity pill. */
export const PILL: Record<'critical' | 'warning' | 'resolved' | 'info', { bg: string; fg: string }> = {
  critical: { bg: '#fee4e2', fg: '#b42318' }, warning: { bg: '#fef0c7', fg: '#b54708' },
  resolved: { bg: '#dcfae6', fg: '#067647' }, info: { bg: '#eaecf0', fg: '#344054' },
};

export interface LinkButton { text: string; url: string }
/**
 * A bullet line: `lead` in bold (a client's name), then the rest; `sub` is a second line under it ("→ what to do") —
 * A592's two-line row, the owner's table on a phone.
 */
export type Line = string | { lead: string; rest?: string; sub?: string };
export interface MessageSection { title: string; tone?: Tone; lines: Line[]; /** shown as "+N more in the admin portal" */ more?: number }

export interface AdminMessage {
  tone: Tone;
  /** Without the emoji — "Backup failed — Mon 26 Oct 13:07 EAT". */
  headline: string;
  /** The email's subject; default: the emoji and the headline. */
  subject?: string;
  /** One line under the headline. */
  summary?: string;
  /** "Step: checking the upload", "Last good backup: Sun 25 Oct (1 day ago)". */
  facts?: Array<[string, string]>;
  /** What to do, one line (the 👉 line). */
  action?: string;
  sections?: MessageSection[];
  /** Small print at the end (the digest's counters). */
  note?: string;
  buttons?: LinkButton[];
}

// ── Escaping ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Telegram HTML and email HTML alike: & < > and " (an attribute). Telegram's parser knows exactly these entities;
 * anything else unescaped ("A&B <Shop>") makes it refuse the whole message.
 */
export function escapeHtml(v: unknown): string {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** A value never runs away with the message (a stack trace in a detail, a client called with a paragraph). */
const cap = (v: unknown, n = 400) => { const s = String(v ?? '').replace(/\s+\n/g, '\n').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };

/** Only http(s) URLs become buttons — Telegram refuses the message over one bad URL. */
export function validUrl(u: unknown): boolean {
  if (typeof u !== 'string' || u.length > 2000) return false;
  try { const x = new URL(u); return x.protocol === 'https:' || x.protocol === 'http:'; } catch { return false; }
}

// ── Time, Nairobi (UTC+3 all year) ───────────────────────────────────────────────────────────────────────────────────

const EAT_MS = 3 * 3600_000;
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const toMs = (t: string | number | Date | null | undefined) => (t instanceof Date ? t.getTime() : typeof t === 'number' ? t : t ? Date.parse(t) : NaN);

/** "Mon 26 Oct" (Nairobi). */
export function eatDay(t: string | number | Date | null | undefined): string {
  const ms = toMs(t);
  if (!Number.isFinite(ms)) return '—';
  const d = new Date(ms + EAT_MS);
  return `${WEEKDAY[d.getUTCDay()]} ${d.getUTCDate()} ${MONTH[d.getUTCMonth()]}`;
}
/** "13:07 EAT". */
export function eatTime(t: string | number | Date | null | undefined): string {
  const ms = toMs(t);
  if (!Number.isFinite(ms)) return '—';
  const d = new Date(ms + EAT_MS);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} EAT`;
}
/** "Mon 26 Oct 13:07 EAT". */
export function eatStamp(t: string | number | Date | null | undefined): string {
  const ms = toMs(t);
  return Number.isFinite(ms) ? `${eatDay(ms)} ${eatTime(ms)}` : '—';
}
/** Minutes from `t` to `now` (NaN when unknown). */
export function minutesSince(t: string | number | Date | null | undefined, now: Date): number {
  const ms = toMs(t);
  return Number.isFinite(ms) ? (now.getTime() - ms) / 60_000 : NaN;
}
/** "just now" / "45 min ago" / "16 days ago". */
export function agoLabel(t: string | number | Date | null | undefined, now: Date): string {
  const m = minutesSince(t, now);
  if (!Number.isFinite(m)) return '—';
  const s = shortDuration(m);
  return s === 'just now' ? s : `${s} ago`;
}
/** "Mon 26 Oct 13:07 EAT (3 h ago)". */
export function stampAgo(t: string | number | Date | null | undefined, now: Date): string {
  return Number.isFinite(toMs(t)) ? `${eatStamp(t)} (${agoLabel(t, now)})` : '—';
}

/** "On but not syncing" → "on but not syncing" after a dash; "POS …", "M-Pesa …", "3 records …" stay as they are. */
export function lowerFirst(s: string): string {
  return /^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s;
}

// ── Links ────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface AlertLinks { admin: string; repo: string }
export const DEFAULT_LINKS: AlertLinks = Object.freeze({ admin: 'https://admin.zaptill.co.ke', repo: 'https://github.com/oweyahillary/swiftpos' });

const base = (u: string) => String(u || '').replace(/\/+$/, '');
/** The admin portal's Alerts page (AdminPortal.tsx reads ?open=). */
export const alertsUrl = (l: AlertLinks = DEFAULT_LINKS) => `${base(l.admin)}/?open=alerts`;
/** The admin portal's System page (backups, deploy checks). */
export const systemUrl = (l: AlertLinks = DEFAULT_LINKS) => `${base(l.admin)}/?open=system`;
/** A client's page in the admin portal; tab 'tills' = "POS & days" (close a day or a POS for the client — A523). */
export const clientUrl = (l: AlertLinks, businessId: string, tab?: 'tills' | 'billing' | 'updates') =>
  `${base(l.admin)}/?client=${encodeURIComponent(businessId)}${tab ? `&tab=${tab}` : ''}`;
/** A guide in the repository, e.g. docs/BACKUPS.md. */
export const guideUrl = (l: AlertLinks, doc: string) => `${base(l.repo)}/blob/main/${doc.replace(/^\/+/, '')}`;

// ── Rendering ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Telegram's limit is 4096 characters after the entities are read; the HTML is kept under this, tags included. */
export const TELEGRAM_MAX = 3900;

const ARROW = '\n    → ';
const lineText = (l: Line) => (typeof l === 'string' ? l
  : `${l.lead}${l.rest ? ` ${l.rest}` : ''}${l.sub ? `${ARROW}${l.sub}` : ''}`);
const lineHtml = (l: Line) => (typeof l === 'string' ? escapeHtml(cap(l, 300))
  : `<b>${escapeHtml(cap(l.lead, 120))}</b>${l.rest ? ` ${escapeHtml(cap(l.rest, 300))}` : ''}${l.sub ? `${ARROW}${escapeHtml(cap(l.sub, 120))}` : ''}`);
const lineEmail = (l: Line) => (typeof l === 'string' ? escapeHtml(cap(l, 300))
  : `<b>${escapeHtml(cap(l.lead, 120))}</b>${l.rest ? ` ${escapeHtml(cap(l.rest, 300))}` : ''}`
    + (l.sub ? `<br><span style="color:#667085">→ ${escapeHtml(cap(l.sub, 120))}</span>` : ''));

/**
 * A592: rows as a fixed-width table inside <pre> (Telegram shows <pre> in a monospace font). Each column is padded to its
 * widest cell, capped by `widths`; a longer cell is cut with "…". Kept to compare with the two-line rows — at four
 * columns a phone's ~40 characters leave the "What to do" column a few letters wide, so the messages use the lines.
 */
export function preTable(headers: string[], rows: string[][], widths: number[]): string {
  const fit = (v: string, w: number) => { const t = String(v ?? ''); return t.length > w ? `${t.slice(0, Math.max(1, w - 1))}…` : t.padEnd(w); };
  const w = headers.map((h, i) => Math.min(widths[i] ?? 12, Math.max(h.length, ...rows.map((r) => String(r[i] ?? '').length))));
  const line = (r: string[]) => r.map((c, i) => fit(c, w[i])).join(' ').trimEnd();
  return `<pre>${escapeHtml([line(headers), w.map((x) => '─'.repeat(x)).join(' '), ...rows.map(line)].join('\n'))}</pre>`;
}
const moreText = (n: number) => `+${n} more in the admin portal`;

function buttonsOf(m: AdminMessage): LinkButton[] {
  return (m.buttons ?? []).filter((b) => b && validUrl(b.url) && String(b.text ?? '').trim()).slice(0, 6)
    .map((b) => ({ text: cap(b.text, 40), url: b.url }));
}

export function subjectOf(m: AdminMessage): string {
  return cap(m.subject ?? `${TONE_EMOJI[m.tone]} ${m.headline}`, 180).replace(/\s*\n\s*/g, ' ');
}

/** The Telegram HTML (parse_mode HTML). Under TELEGRAM_MAX: section lines are dropped into "+N more" until it fits. */
export function telegramHtml(m: AdminMessage): string {
  const render = (sections: MessageSection[]) => {
    const out: string[] = [`${TONE_EMOJI[m.tone]} <b>${escapeHtml(cap(m.headline, 200))}</b>`];
    if (m.summary) out.push(escapeHtml(cap(m.summary, 500)));
    if (m.facts?.length) out.push('', ...m.facts.map(([k, v]) => `<b>${escapeHtml(cap(k, 60))}:</b> ${escapeHtml(cap(v, 300))}`));
    if (m.action) out.push('', `👉 ${escapeHtml(cap(m.action, 500))}`);
    for (const s of sections) {
      out.push('', `${s.tone ? `${TONE_EMOJI[s.tone]} ` : ''}<b>${escapeHtml(cap(s.title, 120))}</b>`, ...s.lines.map((l) => `• ${lineHtml(l)}`));
      if (s.more) out.push(`<i>${escapeHtml(moreText(s.more))}</i>`);
    }
    if (m.note) out.push('', `<i>${escapeHtml(cap(m.note, 500))}</i>`);
    return out.join('\n');
  };
  let sections = (m.sections ?? []).map((s) => ({ ...s, lines: [...s.lines] }));
  let html = render(sections);
  while (html.length > TELEGRAM_MAX && sections.some((s) => s.lines.length)) {
    const s = [...sections].reverse().find((x) => x.lines.length)!;
    s.lines.pop(); s.more = (s.more ?? 0) + 1;
    html = render(sections);
  }
  return html.length > TELEGRAM_MAX ? html.slice(0, TELEGRAM_MAX) : html;   // never reached with capped values
}

/** The same words as plain text, the buttons as "Text: URL" lines (Telegram's fallback, the email's text part). */
export function plainText(m: AdminMessage): string {
  const out: string[] = [`${TONE_EMOJI[m.tone]} ${cap(m.headline, 200)}`];
  if (m.summary) out.push(cap(m.summary, 500));
  if (m.facts?.length) out.push('', ...m.facts.map(([k, v]) => `${cap(k, 60)}: ${cap(v, 300)}`));
  if (m.action) out.push('', `👉 ${cap(m.action, 500)}`);
  for (const s of m.sections ?? []) {
    out.push('', `${s.tone ? `${TONE_EMOJI[s.tone]} ` : ''}${cap(s.title, 120)}`, ...s.lines.map((l) => `• ${cap(lineText(l), 400)}`));
    if (s.more) out.push(moreText(s.more));
  }
  if (m.note) out.push('', cap(m.note, 500));
  const b = buttonsOf(m);
  if (b.length) out.push('', ...b.map((x) => `${x.text}: ${x.url}`));
  return out.join('\n').slice(0, 4000);
}

/** Telegram's reply_markup: URL buttons, two to a row. null when there is none. */
export function telegramKeyboard(buttons: LinkButton[] | undefined): { inline_keyboard: Array<Array<{ text: string; url: string }>> } | null {
  const b = buttonsOf({ tone: 'info', headline: '', buttons });
  if (!b.length) return null;
  const rows: Array<Array<{ text: string; url: string }>> = [];
  for (let i = 0; i < b.length; i += 2) rows.push(b.slice(i, i + 2));
  return { inline_keyboard: rows };
}

// ── The email ────────────────────────────────────────────────────────────────────────────────────────────────────────

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/** A coloured pill ("Critical · 7"). */
export function pill(text: string, kind: keyof typeof PILL): string {
  const c = PILL[kind];
  return `<span style="display:inline-block;background:${c.bg};color:${c.fg};border-radius:999px;padding:2px 10px;font-size:12px;font-weight:600;line-height:18px">${escapeHtml(text)}</span>`;
}

/** One data table (inline styles; email clients drop <style>). Zebra rows; the header row on a soft grey. */
export function htmlTable(headers: string[], rows: string[][]): string {
  const th = `text-align:left;padding:8px 10px;border-bottom:1px solid #d0d5dd;font:600 12px/1.4 ${FONT};color:#475467;background:#f9fafb`;
  const td = (i: number) => `padding:8px 10px;border-bottom:1px solid #eaecf0;font:13px/1.45 ${FONT};color:#101828;vertical-align:top${i % 2 ? ';background:#fcfcfd' : ''}`;
  return `<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;border:1px solid #eaecf0">`
    + `<thead><tr>${headers.map((h) => `<th style="${th}">${escapeHtml(h)}</th>`).join('')}</tr></thead>`
    + `<tbody>${rows.map((r, i) => `<tr>${r.map((c) => `<td style="${td(i)}">${escapeHtml(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

/** A section heading in the email: a title and, optionally, a pill. */
export function emailHeading(title: string, p?: { text: string; kind: keyof typeof PILL }): string {
  return `<div style="margin:18px 0 8px;font:600 15px/1.4 ${FONT};color:#101828">${escapeHtml(title)}${p ? ` &nbsp;${pill(p.text, p.kind)}` : ''}</div>`;
}

/**
 * The whole email. `bodyHtml` (already escaped — a table) replaces the bullet sections when given. The footer is the
 * same on every admin email: the Alerts page and its Email settings.
 */
export function emailHtml(m: AdminMessage, links: AlertLinks = DEFAULT_LINKS, bodyHtml?: string): string {
  const color = TONE_COLOR[m.tone];
  const row = (inner: string, pad = '0 28px 14px') => `<tr><td style="padding:${pad}">${inner}</td></tr>`;
  const parts: string[] = [];
  parts.push(`<tr><td style="height:6px;background:${color};font-size:0;line-height:0;border-radius:12px 12px 0 0">&nbsp;</td></tr>`);
  parts.push(row(`<div style="font:600 11px/1.4 ${FONT};letter-spacing:.08em;text-transform:uppercase;color:#667085">ZapTill admin · ${escapeHtml(TONE_WORD[m.tone])}</div>`, '22px 28px 6px'));
  parts.push(row(`<div style="font:700 20px/1.3 ${FONT};color:#101828">${TONE_EMOJI[m.tone]} ${escapeHtml(cap(m.headline, 200))}</div>`, '0 28px 10px'));
  if (m.summary) parts.push(row(`<div style="font:15px/1.5 ${FONT};color:#344054">${escapeHtml(cap(m.summary, 500))}</div>`));
  if (m.facts?.length) {
    parts.push(row(`<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%">${m.facts.map(([k, v]) =>
      `<tr><td style="padding:4px 12px 4px 0;font:13px/1.45 ${FONT};color:#667085;white-space:nowrap;vertical-align:top;width:1%">${escapeHtml(cap(k, 60))}</td>`
      + `<td style="padding:4px 0;font:600 13px/1.45 ${FONT};color:#101828;vertical-align:top">${escapeHtml(cap(v, 300))}</td></tr>`).join('')}</table>`));
  }
  if (m.action) {
    parts.push(row(`<div style="background:#f9fafb;border-left:4px solid ${color};border-radius:6px;padding:10px 14px;font:14px/1.5 ${FONT};color:#101828">👉 ${escapeHtml(cap(m.action, 500))}</div>`));
  }
  if (bodyHtml) parts.push(row(bodyHtml));
  else {
    for (const s of m.sections ?? []) {
      const lines = s.lines.map((l) => `<li style="margin:0 0 6px">${lineEmail(l)}</li>`).join('');
      parts.push(row(`<div style="font:600 14px/1.4 ${FONT};color:#101828;margin:4px 0 6px">${s.tone ? `${TONE_EMOJI[s.tone]} ` : ''}${escapeHtml(s.title)}</div>`
        + `<ul style="margin:0;padding:0 0 0 18px;font:13px/1.5 ${FONT};color:#344054">${lines}</ul>`
        + (s.more ? `<div style="font:italic 12px/1.5 ${FONT};color:#667085;margin-top:4px">${escapeHtml(moreText(s.more))}</div>` : '')));
    }
  }
  if (m.note) parts.push(row(`<div style="font:12px/1.5 ${FONT};color:#667085">${escapeHtml(cap(m.note, 500))}</div>`));
  const b = buttonsOf(m);
  if (b.length) {
    parts.push(row(b.map((x, i) => `<a href="${escapeHtml(x.url)}" style="display:inline-block;margin:0 8px 8px 0;padding:10px 16px;border-radius:8px;`
      + `background:${i === 0 ? color : '#ffffff'};color:${i === 0 ? '#ffffff' : '#344054'};border:1px solid ${i === 0 ? color : '#d0d5dd'};`
      + `font:600 14px/1 ${FONT};text-decoration:none">${escapeHtml(x.text)}</a>`).join(''), '6px 28px 20px'));
  }
  const footer = `<div style="font:12px/1.6 ${FONT};color:#667085;padding:14px 8px 0;text-align:center">`
    + `Sent by the ZapTill watchdog. <a href="${escapeHtml(alertsUrl(links))}" style="color:#475467">Admin portal › Alerts</a>`
    + ` · <a href="${escapeHtml(alertsUrl(links))}" style="color:#475467">Email settings</a> (which alerts are emailed at once, the digest time)</div>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>`
    + `<body style="margin:0;padding:0;background:#f2f4f7">`
    + `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f2f4f7"><tr><td align="center" style="padding:24px 12px">`
    + `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:680px;background:#ffffff;border:1px solid #eaecf0;border-radius:12px;border-collapse:separate">`
    + parts.join('') + `</table>${footer}</td></tr></table></body></html>`;
}

/** The email's text/plain part: the plain words and the same footer. */
export function emailText(m: AdminMessage, links: AlertLinks = DEFAULT_LINKS): string {
  return `${plainText(m)}\n\n—\nAdmin portal › Alerts: ${alertsUrl(links)}\nEmail settings (which alerts are emailed at once, the digest time): Alerts › Email settings.`;
}

export interface RenderedMessage { subject: string; text: string; tgHtml: string; buttons: LinkButton[]; html: string; emailText: string }

/** All of it at once — what lib/alertNotify.ts notifyAdmin sends. */
export function renderMessage(m: AdminMessage, links: AlertLinks = DEFAULT_LINKS, emailBodyHtml?: string): RenderedMessage {
  return { subject: subjectOf(m), text: plainText(m), tgHtml: telegramHtml(m), buttons: buttonsOf(m), html: emailHtml(m, links, emailBodyHtml), emailText: emailText(m, links) };
}
