/**
 * adminAlertPolicy.ts — A589: what reaches the ZapTill admin, how, and when. PURE: no database, no network, no clock.
 *
 * Owner, 2026-10-25: "till not closed should not come as an email for each client; let it be a notification on the admin
 * portal — right now I am getting like 7 emails for different clients — or if they must come as an email let it be a
 * table containing the clients list, not each client an email; also invoices let it be the same; [emails] maybe when the
 * server is down or overloaded".
 *
 *   SYSTEM (emailed at once, one email each, + Telegram; reminded every 3 h while it lasts — as before):
 *     server error burst (5xx), server overloaded, database unreachable, a sign-in attack, a nightly backup failed or
 *     missed, a failed deploy check or dependency scan.
 *   CLIENT (a day not closed, a POS not syncing / signed out / refused, M-Pesa, eTIMS, a POS to update):
 *     the admin portal only — the bell (admin_notifications) and the Alerts page; NO email per client. Telegram: ONE
 *     message per watchdog run listing the new ones. Email: ONE morning digest with a table
 *     (client | branch / POS | problem | since) of what is still open.
 *   BILLING (invoice issued, unpaid day 5, locked, trial ended, not interested — ZapTill's copies; the client's own
 *     invoice and receipt emails are unchanged): the bell; ONE daily billing summary email with a table
 *     (client | invoice | amount | due | status).
 * A super admin may move any category to "email at once" (Alerts › Email settings); client categories emailed at once
 * still come as ONE email per run with a table, never one per client. The digest time (default 07:00 Nairobi) and the two
 * daily emails can be changed there too. Stored in public.admin_settings (migration 174), key 'alert_settings'.
 */

export type AlertCategory =
  | 'server_errors' | 'overload' | 'database' | 'signin_attack' | 'backup' | 'deploy' | 'other_system'
  | 'day_not_closed' | 'pos_not_syncing' | 'pos_signed_out' | 'pos_refused' | 'mpesa' | 'etims' | 'pos_updates'
  | 'billing';

export type CategoryGroup = 'system' | 'client' | 'billing';

export interface CategoryInfo { id: AlertCategory; label: string; group: CategoryGroup; instantDefault: boolean }

export const ALERT_CATEGORIES: readonly CategoryInfo[] = [
  { id: 'server_errors', label: 'Server error burst (10+ server errors in 5 min)', group: 'system', instantDefault: true },
  { id: 'overload', label: 'Server overloaded (slow answers, a busy server, a slow database)', group: 'system', instantDefault: true },
  { id: 'database', label: 'Database unreachable', group: 'system', instantDefault: true },
  { id: 'signin_attack', label: 'Many failed sign-ins (someone guessing passwords)', group: 'system', instantDefault: true },
  { id: 'backup', label: 'Nightly backup failed or missed', group: 'system', instantDefault: true },
  { id: 'deploy', label: 'Deploy check or dependency scan failed', group: 'system', instantDefault: true },
  { id: 'other_system', label: 'Other cloud alerts', group: 'system', instantDefault: true },
  { id: 'day_not_closed', label: 'Day not closed', group: 'client', instantDefault: false },
  { id: 'pos_not_syncing', label: 'POS not syncing, quiet, or with refused records', group: 'client', instantDefault: false },
  { id: 'pos_signed_out', label: 'POS signed out and could not sign back in', group: 'client', instantDefault: false },
  { id: 'pos_refused', label: 'POS sync refused by the cloud', group: 'client', instantDefault: false },
  { id: 'mpesa', label: 'M-Pesa payments unanswered or not matched', group: 'client', instantDefault: false },
  { id: 'etims', label: 'eTIMS invoices failed', group: 'client', instantDefault: false },
  { id: 'pos_updates', label: 'Points of sale that need updating', group: 'client', instantDefault: false },
  { id: 'billing', label: 'Billing notices (invoice issued, unpaid day 5, locked, trial ended, not interested)', group: 'billing', instantDefault: false },
];

const BY_ID = new Map(ALERT_CATEGORIES.map((c) => [c.id, c]));

/** The category of a watchdog alert, from its key (the part before the first ':'). */
export function categoryOf(key: string): AlertCategory {
  const p = String(key ?? '').split(':')[0];
  switch (p) {
    case 'server_errors': return 'server_errors';
    case 'server_overload': return 'overload';
    case 'database_unreachable': return 'database';
    case 'signin_failures': case 'signin_failures_ip': return 'signin_attack';
    case 'backup_missed': case 'backup_failed': return 'backup';
    case 'deploy_check': case 'vuln_scan': return 'deploy';
    case 'day_not_closed': return 'day_not_closed';
    case 'till_not_syncing': case 'till_parked': return 'pos_not_syncing';
    case 'till_signed_out': return 'pos_signed_out';
    case 'sync_refused': case 'sync_rows_refused': return 'pos_refused';
    case 'mpesa_unanswered': case 'payment_exception': return 'mpesa';
    case 'etims_failed': return 'etims';
    case 'old_tills': return 'pos_updates';
    case 'billing': return 'billing';
    default: return 'other_system';
  }
}

export function groupOf(key: string): CategoryGroup {
  return BY_ID.get(categoryOf(key))?.group ?? 'system';
}

export interface AlertSettings {
  /** The categories emailed at once (system ones one email each; client ones one grouped email per run). */
  instant: AlertCategory[];
  /** The morning digest email (the table of open client problems). Telegram gets the digest either way. */
  digestEmail: boolean;
  /** 'HH:MM', Africa/Nairobi. */
  digestTime: string;
  /** The daily billing summary email (the table of billing notices). */
  billingSummaryEmail: boolean;
}

export const DEFAULT_ALERT_SETTINGS: AlertSettings = Object.freeze({
  instant: ALERT_CATEGORIES.filter((c) => c.instantDefault).map((c) => c.id),
  digestEmail: true,
  digestTime: '07:00',
  billingSummaryEmail: true,
}) as AlertSettings;

export const DIGEST_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Whatever is stored (or posted) → valid settings; anything missing or wrong falls back to the default. */
export function normalizeAlertSettings(raw: unknown): AlertSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const instant = Array.isArray(r.instant)
    ? [...new Set(r.instant.filter((x): x is AlertCategory => typeof x === 'string' && BY_ID.has(x as AlertCategory)))]
    : [...DEFAULT_ALERT_SETTINGS.instant];
  const time = typeof r.digestTime === 'string' && DIGEST_TIME_RE.test(r.digestTime) ? r.digestTime : DEFAULT_ALERT_SETTINGS.digestTime;
  return {
    instant,
    digestEmail: typeof r.digestEmail === 'boolean' ? r.digestEmail : DEFAULT_ALERT_SETTINGS.digestEmail,
    digestTime: time,
    billingSummaryEmail: typeof r.billingSummaryEmail === 'boolean' ? r.billingSummaryEmail : DEFAULT_ALERT_SETTINGS.billingSummaryEmail,
  };
}

/** Is this alert (by key) emailed at once? */
export function isInstant(key: string, s: AlertSettings): boolean {
  return s.instant.includes(categoryOf(key));
}

// ── Time, in the owner's words (Nairobi, UTC+3, no daylight saving) ──────────────────────────────────────────────────

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const EAT_MS = 3 * 3600_000;

/** '24 Oct 21:05' (Nairobi). */
export function nairobiStamp(iso: string | null | undefined): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return '—';
  const d = new Date(t + EAT_MS);
  return `${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

/** '24 Oct 2026' (Nairobi). */
export function nairobiDate(iso: string | null | undefined): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return '—';
  const d = new Date(t + EAT_MS);
  return `${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** The Nairobi date 'YYYY-MM-DD' and minutes past midnight of a moment. */
export function nairobiClock(now: Date): { date: string; minutes: number } {
  const d = new Date(now.getTime() + EAT_MS);
  return { date: d.toISOString().slice(0, 10), minutes: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

/** "2 h 15 min" / "45 min" / "3 d 4 h". */
export function sinceLabel(fromIso: string | null | undefined, now: Date): string {
  const t = fromIso ? Date.parse(fromIso) : NaN;
  if (!Number.isFinite(t)) return '—';
  const m = Math.max(0, Math.round((now.getTime() - t) / 60_000));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}

/**
 * Is the morning digest due now? Once a Nairobi day, at or after the digest time, and only in the 3 hours after it — a
 * server that starts at 15:00 does not send the morning's digest in the afternoon.
 */
export function digestDue(now: Date, digestTime: string, lastSentDate: string | null | undefined): boolean {
  const { date, minutes } = nairobiClock(now);
  if (lastSentDate === date) return false;
  const [h, m] = (DIGEST_TIME_RE.test(digestTime) ? digestTime : DEFAULT_ALERT_SETTINGS.digestTime).split(':').map(Number);
  const at = h * 60 + m;
  return minutes >= at && minutes < at + 180;
}

// ── The rows of a table ──────────────────────────────────────────────────────────────────────────────────────────────

export interface ProblemFacts { client: string; where: string; problem: string; since: string }

/** What an alert says, as a row: its own fields when the rule set them, else read from its title ("Client: problem"). */
export function problemFacts(a: { title: string; client?: string | null; where?: string | null; problem?: string | null; businessId?: string | null; business_id?: string | null },
  since: string | null | undefined, now: Date): ProblemFacts {
  let client = a.client ?? null, problem = a.problem ?? null;
  if (!client || !problem) {
    const i = a.title.indexOf(': ');
    const system = !(a.businessId ?? a.business_id);
    if (i > 0 && !system) { client = client ?? a.title.slice(0, i); problem = problem ?? a.title.slice(i + 2); }
    else { client = client ?? 'ZapTill cloud'; problem = problem ?? a.title; }
  }
  return { client, where: a.where || '—', problem, since: since ? `${nairobiStamp(since)} (${sinceLabel(since, now)})` : '—' };
}

const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** One HTML table (inline styles: email clients ignore <style>). */
export function htmlTable(headers: string[], rows: string[][]): string {
  const th = 'text-align:left;padding:6px 10px;border-bottom:2px solid #ddd;font-size:13px;background:#f6f7f9';
  const td = 'padding:6px 10px;border-bottom:1px solid #eee;font-size:13px;vertical-align:top';
  return `<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;max-width:900px">`
    + `<thead><tr>${headers.map((h) => `<th style="${th}">${esc(h)}</th>`).join('')}</tr></thead>`
    + `<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td style="${td}">${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

const page = (title: string, body: string) =>
  `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#111;font-size:14px;line-height:1.5">`
  + `<h2 style="font-size:18px;margin:0 0 12px">${esc(title)}</h2>${body}`
  + `<p style="font-size:12px;color:#666;margin-top:18px">Details and "mark as read": the admin portal › Alerts. `
  + `Which alerts are emailed at once, and the digest time: Alerts › Email settings (super admin).</p></div>`;

export const PROBLEM_HEADERS = ['Client', 'Branch / POS', 'Problem', 'Since'];

const factsRow = (f: ProblemFacts) => [f.client, f.where, f.problem, f.since];
const textRow = (f: ProblemFacts) => `• ${f.client} — ${f.where === '—' ? '' : `${f.where} — `}${f.problem} — since ${f.since}`;

// ── One watchdog run → who hears what ───────────────────────────────────────────────────────────────────────────────

export interface RunAlert { key: string; severity: 'critical' | 'warning'; businessId: string | null; title: string; detail?: string | null;
  client?: string | null; where?: string | null; problem?: string | null }

export interface RunInput {
  /** Critical problems told for the first time (new, or a warning that became critical). */
  opened: Array<{ alert: RunAlert; firstSeenAt: string }>;
  /** Critical problems still open and due a reminder (every 3 h). */
  reminders: Array<{ alert: RunAlert; firstSeenAt: string }>;
  /** Problems that cleared and had been told. */
  resolved: Array<{ key: string; title: string; first_seen_at: string; business_id?: string | null }>;
}

export interface NotificationRow { category: AlertCategory; business_id: string | null; alert_key: string | null; title: string; detail: string | null;
  data: Record<string, unknown> }

export interface RoutedRun {
  /** One email + Telegram each — the system emergencies (new and reminders), as before. */
  instantEach: Array<{ subject: string; text: string; key: string }>;
  /** ONE email (a table) for the client categories a super admin chose to email at once — never one per client. */
  instantGroup: { subject: string; text: string; html: string; keys: string[] } | null;
  /** ONE Telegram message: the new client problems (not emailed) and everything resolved. */
  telegramGroup: { subject: string; text: string } | null;
  /** The admin portal's bell: one row per problem told for the first time. */
  notifications: NotificationRow[];
  /** Keys whose reminder was due but stays quiet (portal and digest only) — last_notified_at moves, nothing is sent. */
  quiet: string[];
}

function alertMessage(kind: 'new' | 'reminder', a: RunAlert, since: string, now: Date): string {
  const head = kind === 'new' ? '🔴 ZapTill ALERT' : `🔴 STILL HAPPENING — for ${sinceLabel(since, now)}`;
  return `${head}\n${a.title}\n${a.detail ?? ''}`.trim();
}

export function routeRun(input: RunInput, s: AlertSettings, now: Date): RoutedRun {
  const out: RoutedRun = { instantEach: [], instantGroup: null, telegramGroup: null, notifications: [], quiet: [] };
  const groupInstant: Array<{ a: RunAlert; since: string; kind: 'new' | 'reminder' }> = [];
  const groupQuietNew: Array<{ a: RunAlert; since: string }> = [];

  for (const { alert: a, firstSeenAt } of input.opened) {
    out.notifications.push({
      category: categoryOf(a.key), business_id: a.businessId, alert_key: a.key, title: a.title, detail: a.detail ?? null,
      data: { severity: a.severity, ...problemFacts(a, firstSeenAt, now), first_seen_at: firstSeenAt },
    });
    if (!isInstant(a.key, s)) { groupQuietNew.push({ a, since: firstSeenAt }); continue; }
    if (groupOf(a.key) === 'system') out.instantEach.push({ key: a.key, subject: `ZapTill alert: ${a.title}`, text: alertMessage('new', a, firstSeenAt, now) });
    else groupInstant.push({ a, since: firstSeenAt, kind: 'new' });
  }
  for (const { alert: a, firstSeenAt } of input.reminders) {
    if (!isInstant(a.key, s)) { out.quiet.push(a.key); continue; }
    if (groupOf(a.key) === 'system') out.instantEach.push({ key: a.key, subject: `ZapTill still happening: ${a.title}`, text: alertMessage('reminder', a, firstSeenAt, now) });
    else groupInstant.push({ a, since: firstSeenAt, kind: 'reminder' });
  }

  if (groupInstant.length) {
    const rows = groupInstant.map((g) => problemFacts(g.a, g.since, now));
    const n = rows.length;
    const fresh = groupInstant.filter((g) => g.kind === 'new').length;
    const title = `ZapTill: ${n} client problem${n === 1 ? '' : 's'}${fresh && fresh < n ? ` (${fresh} new)` : ''}`;
    out.instantGroup = {
      subject: title, keys: groupInstant.map((g) => g.a.key),
      text: [`🔴 ${title}`, ...rows.map(textRow)].join('\n'),
      html: page(title, htmlTable(PROBLEM_HEADERS, rows.map(factsRow))),
    };
  }

  const lines: string[] = [];
  if (groupQuietNew.length) {
    const n = groupQuietNew.length;
    lines.push(`🔴 ZapTill — ${n} new problem${n === 1 ? '' : 's'} at clients (admin portal › Alerts; not emailed):`,
      ...groupQuietNew.map((g) => textRow(problemFacts(g.a, g.since, now))));
  }
  if (input.resolved.length) {
    if (lines.length) lines.push('');
    lines.push(`✅ Resolved (${input.resolved.length}):`,
      ...input.resolved.map((r) => `• ${r.title} (lasted ${sinceLabel(r.first_seen_at, now)})`));
  }
  if (lines.length) {
    const parts = [groupQuietNew.length ? `${groupQuietNew.length} new` : '', input.resolved.length ? `${input.resolved.length} resolved` : ''].filter(Boolean);
    out.telegramGroup = { subject: `ZapTill alerts: ${parts.join(', ')}`, text: lines.join('\n') };
  }
  return out;
}

// ── The morning digest email: ONE table of what is still open ───────────────────────────────────────────────────────

export interface DigestRow extends ProblemFacts { severity: 'critical' | 'warning' }

/** null when nothing is open — no email that says nothing. */
export function digestEmail(rows: DigestRow[], counters: { serverErrors: number; failedSignIns: number; writeGuard: number; since: string } | null, now: Date):
  { subject: string; html: string; text: string } | null {
  const crit = rows.filter((r) => r.severity === 'critical');
  const warn = rows.filter((r) => r.severity !== 'critical');
  if (!crit.length && !warn.length) return null;
  const day = nairobiDate(now.toISOString());
  const subject = `ZapTill daily check — ${day}: ${crit.length} open problem${crit.length === 1 ? '' : 's'}${warn.length ? `, ${warn.length} to look at` : ''}`;
  let body = '';
  if (crit.length) body += `<h3 style="font-size:15px;margin:14px 0 6px;color:#b42318">Still open (${crit.length})</h3>${htmlTable(PROBLEM_HEADERS, crit.map(factsRow))}`;
  if (warn.length) body += `<h3 style="font-size:15px;margin:18px 0 6px;color:#b54708">To look at (${warn.length})</h3>${htmlTable(PROBLEM_HEADERS, warn.map(factsRow))}`;
  if (counters) {
    body += `<p style="font-size:13px;color:#444;margin-top:14px">Since ${esc(nairobiStamp(counters.since))}: ${counters.serverErrors} server errors · `
      + `${counters.failedSignIns} failed sign-ins · ${counters.writeGuard} POS writes the cloud would block.</p>`;
  }
  const text = [`☀️ ${subject}`, ...(crit.length ? ['', `🔴 Still open (${crit.length}):`, ...crit.map(textRow)] : []),
    ...(warn.length ? ['', `🟡 To look at (${warn.length}):`, ...warn.map(textRow)] : [])].join('\n');
  return { subject, html: page(`ZapTill daily check — ${day}`, body), text };
}

// ── The daily billing summary email: ONE table ──────────────────────────────────────────────────────────────────────

export interface BillingRow { client: string; invoice: string | null; amount: number | null; currency: string; due: string | null; status: string }

export const BILLING_HEADERS = ['Client', 'Invoice', 'Amount', 'Due', 'Status'];

const money = (n: number | null, c: string) => (n === null || !Number.isFinite(n) ? '—' : `${c} ${Math.round(n).toLocaleString('en-US')}`);

/** The words of a billing notice's status, by milestone. */
export function billingStatus(milestone: string, f: { unpaidDays?: number | null; lockInDays?: number | null; ownerSent?: boolean | null; trial?: boolean | null }): string {
  switch (milestone) {
    case 'invoice': return `Invoice issued${f.trial ? ' (trial ended)' : ''}${f.ownerSent === false ? ' — client email NOT delivered' : ''}`;
    case 'unpaid_5': return `Unpaid ${f.unpaidDays ?? 5} days — locks in ${f.lockInDays ?? 2} days`;
    case 'locked': return 'Locked (unpaid 7 days)';
    case 'trial_end': return 'Cloud trial ended';
    case 'not_interested': return 'Not interested (unpaid 3 months) — invoices written off';
    default: return milestone;
  }
}

/** null when there is nothing to say. `notices` = since the last summary; `standing` = still unpaid / locked today. */
export function billingSummaryEmail(notices: BillingRow[], standing: BillingRow[], now: Date): { subject: string; html: string; text: string } | null {
  // A client with a notice today is one row (its notice); the others still unpaid or locked follow.
  const told = new Set(notices.map((r) => r.client));
  const rest = standing.filter((r) => !told.has(r.client));
  const rows = [...notices, ...rest];
  if (!rows.length) return null;
  const day = nairobiDate(now.toISOString());
  const subject = `ZapTill billing summary — ${day}: ${notices.length} notice${notices.length === 1 ? '' : 's'}${rest.length ? `, ${rest.length} still unpaid or locked` : ''}`;
  const cells = (r: BillingRow) => [r.client, r.invoice ?? '—', money(r.amount, r.currency), r.due ? nairobiDate(r.due) : '—', r.status];
  const html = page(`ZapTill billing summary — ${day}`, htmlTable(BILLING_HEADERS, rows.map(cells))
    + '<p style="font-size:13px;color:#444;margin-top:12px">Record a payment: admin portal › client › Plan &amp; billing › Record payment. '
    + 'The clients\' own invoice emails went out as usual.</p>');
  const text = [`💳 ${subject}`, ...rows.map((r) => `• ${cells(r).join(' — ')}`)].join('\n');
  return { subject, html, text };
}
