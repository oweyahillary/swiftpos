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
import {
  type AdminMessage, type AlertLinks, type LinkButton, type Line, type MessageSection, type RenderedMessage, type Tone,
  DEFAULT_LINKS, renderMessage, htmlTable, emailHeading, stampAgo, eatDay, eatStamp, minutesSince, durationLabel, shortDuration,
  alertsUrl, systemUrl, clientUrl, guideUrl,
} from './alertFormat';   // A592: how every admin message looks
import { RULE_WORDS, type RuleId } from './watchdogRules';   // A592: each rule's short name and what to do

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

/** "2 h 15 min" / "45 min" / "3 days 4 h". */
export function sinceLabel(fromIso: string | null | undefined, now: Date): string {
  const t = fromIso ? Date.parse(fromIso) : NaN;
  if (!Number.isFinite(t)) return '—';
  return durationLabel((now.getTime() - t) / 60_000);   // A592: "8 days 22 h", never "214 h"
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

/**
 * One problem as a row. A592 (owner, 2026-10-26 — "a small, simple table, one row per client problem, with a
 * recommendation column": Client | Problem | Since | What to do): `label` + `pos` make the Problem cell ("Day not closed
 * (T1)"), `ago` the Since cell ("16 days"), `todo` the What to do cell. `problem` (the rule's full words), `where` and
 * `since` (the Nairobi stamp) stay for the admin portal's bell.
 */
export interface ProblemFacts { client: string; where: string; problem: string; since: string; label: string; pos: string; ago: string; todo: string }

/** A592: what to do when the rule's own words are not at hand (a stored row) — by category. */
export const CATEGORY_TODO: Record<AlertCategory, string> = {
  server_errors: RULE_WORDS.server_errors.todo, overload: RULE_WORDS.server_overload.todo, database: RULE_WORDS.database_unreachable.todo,
  signin_attack: RULE_WORDS.signin_failures_ip.todo, backup: RULE_WORDS.backup_missed.todo, deploy: 'Open the run on GitHub and fix what it names',
  other_system: 'Open the Alerts page in the admin portal', day_not_closed: RULE_WORDS.day_not_closed.todo, pos_not_syncing: RULE_WORDS.till_not_syncing.todo,
  pos_signed_out: RULE_WORDS.till_signed_out.todo, pos_refused: RULE_WORDS.sync_refused.todo, mpesa: RULE_WORDS.payment_exception.todo,
  etims: RULE_WORDS.etims_failed.todo, pos_updates: RULE_WORDS.old_tills.todo, billing: 'Record the payment when it comes in',
};

/** The rule's words from its key ("day_not_closed:…" → Day not closed / Close it at the POS …), when it has an entry. */
function wordsOfKey(key: string | null | undefined): { label: string; todo: string } | null {
  const p = String(key ?? '').split(':')[0] as RuleId;
  return (RULE_WORDS as Record<string, { label: string; todo: string }>)[p] ?? null;
}

/** What an alert says, as a row: its own fields when the rule set them, else read from its title ("Client: problem"). */
export function problemFacts(a: { title: string; client?: string | null; where?: string | null; problem?: string | null; businessId?: string | null; business_id?: string | null;
  key?: string | null; label?: string | null; todo?: string | null; sinceAt?: string | null },
  since: string | null | undefined, now: Date): ProblemFacts {
  const began = a.sinceAt || since;   // a day not closed: since the day ended, not since the watchdog first saw it
  let client = a.client ?? null, problem = a.problem ?? null;
  if (!client || !problem) {
    const i = a.title.indexOf(': ');
    const system = !(a.businessId ?? a.business_id);
    if (i > 0 && !system) { client = client ?? a.title.slice(0, i); problem = problem ?? a.title.slice(i + 2); }
    else { client = client ?? 'ZapTill cloud'; problem = problem ?? a.title; }
  }
  const where = a.where || '—';
  const byKey = wordsOfKey(a.key);
  const cat = categoryOf(a.key ?? '');
  // The POS of "Main / T1" is T1; a list of points of sale ("T1, T2") is kept short.
  const pos = where === '—' ? '' : (where.includes(' / ') ? where.split(' / ').pop()! : where);
  return {
    client, where, problem,
    since: since ? stampAgo(since, now) : '—',   // "Sat 24 Oct 21:05 EAT (2 h 15 min ago)"
    label: a.label || byKey?.label || (a.key ? CATEGORY_HEADLINE[cat] : problem),
    pos: pos.length > 18 ? `${pos.slice(0, 17)}…` : pos,
    ago: began ? shortDuration(minutesSince(began, now)) : '—',
    todo: a.todo || byKey?.todo || (a.key ? CATEGORY_TODO[cat] : 'See the Alerts page in the admin portal'),
  };
}

export { htmlTable };

/** A592: the owner's four columns. */
export const PROBLEM_HEADERS = ['Client', 'Problem', 'Since', 'What to do'];

/** "Day not closed (T1)". */
const problemCell = (f: ProblemFacts) => `${f.label}${f.pos ? ` (${f.pos})` : ''}`;
const factsRow = (f: ProblemFacts) => [f.client, problemCell(f), f.ago, f.todo];
/**
 * A592: one problem on Telegram, two lines (a phone does not wrap them; Telegram has no tables):
 *   • <b>Sample Shop</b> · T1 — Day not closed · 16 days
 *       → Close it at the POS or by Remote Day Close
 */
const problemLine = (f: ProblemFacts): Line => ({ lead: f.client, rest: `${f.pos ? `· ${f.pos} ` : ''}— ${f.label} · ${f.ago}`, sub: f.todo });
/** The same rows as a fixed-width <pre> table (alertFormat.ts preTable) — kept for comparison; Telegram uses the lines. */
export const problemTableRow = (f: ProblemFacts) => [f.client, problemCell(f), f.ago, f.todo];
/** A system alert's title without its "Cloud: " / "Backup: " prefix, as a headline. */
const systemHeadline = (title: string) => { const t = title.replace(/^(Cloud|Backup)\s*:\s*/i, ''); return t ? t[0].toUpperCase() + t.slice(1) : title; };

/** A592: the words of each category in a headline. */
export const CATEGORY_HEADLINE: Record<AlertCategory, string> = {
  server_errors: 'Server errors', overload: 'Server overloaded', database: 'Database unreachable', signin_attack: 'Failed sign-ins',
  backup: 'Backup', deploy: 'Deploy check', other_system: 'Cloud alert', day_not_closed: 'Day not closed', pos_not_syncing: 'POS not syncing',
  pos_signed_out: 'POS signed out', pos_refused: 'Sync refused', mpesa: 'M-Pesa', etims: 'eTIMS', pos_updates: 'POS update needed', billing: 'Billing',
};

/** The buttons of one alert: the client's page (a day not closed: "Close it remotely" — the POS & days tab), a guide, the Alerts page. */
export function alertButtons(a: { key: string; businessId?: string | null }, links: AlertLinks = DEFAULT_LINKS): LinkButton[] {
  const cat = categoryOf(a.key);
  const out: LinkButton[] = [];
  if (a.businessId) {
    if (cat === 'day_not_closed') out.push({ text: 'Close it remotely', url: clientUrl(links, a.businessId, 'tills') });
    else out.push({ text: 'Open client', url: clientUrl(links, a.businessId, ['pos_not_syncing', 'pos_signed_out', 'pos_refused', 'pos_updates'].includes(cat) ? 'tills' : undefined) });
  }
  if (cat === 'backup') out.push({ text: 'Guide', url: guideUrl(links, 'docs/BACKUPS.md') });
  out.push({ text: 'Open in admin', url: cat === 'backup' || cat === 'deploy' ? systemUrl(links) : alertsUrl(links) });
  return out;
}

// ── One watchdog run → who hears what ───────────────────────────────────────────────────────────────────────────────

export interface RunAlert { key: string; severity: 'critical' | 'warning'; businessId: string | null; title: string; detail?: string | null;
  client?: string | null; where?: string | null; problem?: string | null; action?: string | null;
  label?: string | null; todo?: string | null; sinceAt?: string | null }

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
  instantEach: Array<RenderedMessage & { key: string }>;
  /** ONE email (a table) for the client categories a super admin chose to email at once — never one per client. */
  instantGroup: (RenderedMessage & { keys: string[] }) | null;
  /** ONE Telegram message: the new client problems (not emailed) and everything resolved. */
  telegramGroup: RenderedMessage | null;
  /** The admin portal's bell: one row per problem told for the first time. */
  notifications: NotificationRow[];
  /** Keys whose reminder was due but stays quiet (portal and digest only) — last_notified_at moves, nothing is sent. */
  quiet: string[];
}

/** The most lines of a list in one message; the rest are "+N more in the admin portal". */
export const MAX_LINES = 15;
const section = (title: string, lines: Line[], tone?: Tone): MessageSection =>
  ({ title, tone, lines: lines.slice(0, MAX_LINES), more: Math.max(0, lines.length - MAX_LINES) || undefined });

/**
 * A592: one alert, new or a reminder — "🔴 Still open · 9 days · Database unreachable", "Since: Mon 26 Oct 13:07 EAT (2 h
 * ago)", "👉 what to do". The buttons are added by routeRun.
 */
export function alertMessage(kind: 'new' | 'reminder', a: RunAlert, since: string, now: Date): AdminMessage {
  const f = problemFacts(a, since, now);
  const cat = categoryOf(a.key);
  const client = Boolean(a.businessId);
  const what = client ? `${CATEGORY_HEADLINE[cat]} · ${f.client}` : systemHeadline(a.title);
  const age = shortDuration(minutesSince(since, now));
  return {
    tone: 'critical',
    headline: kind === 'new' ? what : `Still open · ${age} · ${what}`,
    subject: kind === 'new' ? `🔴 ${a.title}` : `🔴 Still open · ${age} · ${a.title}`,
    summary: client ? `${f.where === '—' ? '' : `${f.where} — `}${f.problem}` : undefined,
    facts: [['Since', stampAgo(since, now)]],
    action: (a.action || a.detail || '').trim() || undefined,
  };
}

export function routeRun(input: RunInput, s: AlertSettings, now: Date, links: AlertLinks = DEFAULT_LINKS): RoutedRun {
  const out: RoutedRun = { instantEach: [], instantGroup: null, telegramGroup: null, notifications: [], quiet: [] };
  const groupInstant: Array<{ a: RunAlert; since: string; kind: 'new' | 'reminder' }> = [];
  const groupQuietNew: Array<{ a: RunAlert; since: string }> = [];
  const one = (kind: 'new' | 'reminder', a: RunAlert, since: string) =>
    ({ key: a.key, ...renderMessage({ ...alertMessage(kind, a, since, now), buttons: alertButtons(a, links) }, links) });

  for (const { alert: a, firstSeenAt } of input.opened) {
    out.notifications.push({
      category: categoryOf(a.key), business_id: a.businessId, alert_key: a.key, title: a.title, detail: a.detail ?? null,
      data: { severity: a.severity, ...problemFacts(a, firstSeenAt, now), first_seen_at: firstSeenAt },
    });
    if (!isInstant(a.key, s)) { groupQuietNew.push({ a, since: firstSeenAt }); continue; }
    if (groupOf(a.key) === 'system') out.instantEach.push(one('new', a, firstSeenAt));
    else groupInstant.push({ a, since: firstSeenAt, kind: 'new' });
  }
  for (const { alert: a, firstSeenAt } of input.reminders) {
    if (!isInstant(a.key, s)) { out.quiet.push(a.key); continue; }
    if (groupOf(a.key) === 'system') out.instantEach.push(one('reminder', a, firstSeenAt));
    else groupInstant.push({ a, since: firstSeenAt, kind: 'reminder' });
  }

  if (groupInstant.length) {
    const rows = groupInstant.map((g) => problemFacts(g.a, g.since, now));
    const n = rows.length;
    const fresh = groupInstant.filter((g) => g.kind === 'new').length;
    const title = `${n} client problem${n === 1 ? '' : 's'}${fresh && fresh < n ? ` (${fresh} new)` : ''}`;
    const msg: AdminMessage = {
      tone: 'critical', headline: title, subject: `🔴 ZapTill: ${title}`,
      sections: [section('At clients', rows.map(problemLine))],
      buttons: [{ text: 'Open alerts', url: alertsUrl(links) }],
    };
    out.instantGroup = { keys: groupInstant.map((g) => g.a.key), ...renderMessage(msg, links, htmlTable(PROBLEM_HEADERS, rows.map(factsRow))) };
  }

  const sections: MessageSection[] = [];
  let headline = '', tone: Tone = 'critical', summary: string | undefined;
  if (groupQuietNew.length) {
    const n = groupQuietNew.length;
    headline = `${n} new problem${n === 1 ? '' : 's'} at clients`;
    sections.push(section('New', groupQuietNew.map((g) => problemLine(problemFacts(g.a, g.since, now)))));
  }
  if (input.resolved.length) {
    const after = (r: { first_seen_at: string }) => durationLabel(minutesSince(r.first_seen_at, now));
    if (!headline && input.resolved.length === 1) {
      // "✅ Resolved after 2 h 10 min" — and what it was.
      tone = 'resolved';
      headline = `Resolved after ${after(input.resolved[0])}`;
      summary = input.resolved[0].title;
    } else {
      if (!headline) { tone = 'resolved'; headline = `${input.resolved.length} problems resolved`; }
      sections.push(section(`Resolved (${input.resolved.length})`, input.resolved.map((r) => `${r.title} — after ${after(r)}`), 'resolved'));
    }
  }
  if (headline) {
    const parts = [groupQuietNew.length ? `${groupQuietNew.length} new` : '', input.resolved.length ? `${input.resolved.length} resolved` : ''].filter(Boolean);
    out.telegramGroup = renderMessage({
      tone, headline, summary, sections, subject: `ZapTill alerts: ${parts.join(', ')}`,
      note: groupQuietNew.length ? 'On the admin portal bell and in the morning digest — not emailed.' : undefined,
      buttons: [{ text: 'Open alerts', url: alertsUrl(links) }],
    }, links);
  }
  return out;
}

// ── The morning digest: Telegram (one line per problem) and ONE email (a table) ─────────────────────────────────────

export interface DigestRow extends ProblemFacts { severity: 'critical' | 'warning' }
export interface DigestCountersLite { serverErrors: number; failedSignIns: number; writeGuard: number; since: string }

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const countersNote = (c: DigestCountersLite | null) => (c
  ? `Since ${eatStamp(c.since)}: ${plural(c.serverErrors, 'server error')} · ${plural(c.failedSignIns, 'failed sign-in')} · `
    + `${plural(c.writeGuard, 'POS write')} the cloud would block`
  : undefined);

/**
 * A592: the morning digest on Telegram — grouped by severity, one line per problem, at most MAX_LINES lines of problems
 * (critical first), then "+N more in the admin portal" and a button. The billing lines (lib/cloudPlan.ts
 * billingDigestLines) follow. Sent every morning, "All clients look healthy" included.
 */
export function digestTelegram(rows: DigestRow[], counters: DigestCountersLite | null, now: Date, billing: string[] = [], links: AlertLinks = DEFAULT_LINKS): RenderedMessage {
  const crit = rows.filter((r) => r.severity === 'critical');
  const warn = rows.filter((r) => r.severity !== 'critical');
  const sections: MessageSection[] = [];
  let room = MAX_LINES;
  const take = (list: DigestRow[], title: string, tone: Tone) => {
    if (!list.length) return;
    const shown = list.slice(0, Math.max(0, room));
    room -= shown.length;
    sections.push({ title: `${title} (${list.length})`, tone, lines: shown.map(problemLine), more: list.length - shown.length || undefined });
  };
  take(crit, 'Still open', 'critical');
  take(warn, 'To look at', 'warning');
  // The billing lines: "💳 Cloud locked (2):" headings, "• …" lines, and single "💳 …" sentences.
  let current: MessageSection | null = null;
  for (const raw of billing) {
    const l = String(raw ?? '').trim();
    if (!l) continue;
    if (l.startsWith('• ')) {
      if (!current) { current = { title: 'Billing', tone: 'billing', lines: [] }; sections.push(current); }
      current.lines.push(l.slice(2));
      continue;
    }
    const t = l.replace(/^💳\s*/u, '');
    if (t.endsWith(':')) { current = { title: t.slice(0, -1), tone: 'billing', lines: [] }; sections.push(current); }
    else { current = null; sections.push({ title: 'Billing', tone: 'billing', lines: [t] }); }
  }
  for (const sct of sections) if (sct.tone === 'billing' && sct.lines.length > 8) { sct.more = sct.lines.length - 8; sct.lines = sct.lines.slice(0, 8); }
  const day = eatDay(now);
  const summary = rows.length
    ? [crit.length ? `${crit.length} still open` : '', warn.length ? `${warn.length} to look at` : ''].filter(Boolean).join(' · ')
    : 'All clients look healthy.';
  return renderMessage({
    tone: 'digest', headline: `Daily check · ${day}`, subject: `🗓 Daily check · ${day}`, summary, sections,
    note: countersNote(counters), buttons: [{ text: rows.length > MAX_LINES ? `Open all ${rows.length} in admin` : 'Open alerts', url: alertsUrl(links) }],
  }, links);
}

/** The digest EMAIL — null when nothing is open (no email that says nothing). ONE table per severity, a pill on each. */
export function digestEmail(rows: DigestRow[], counters: DigestCountersLite | null, now: Date, links: AlertLinks = DEFAULT_LINKS):
  { subject: string; html: string; text: string } | null {
  const crit = rows.filter((r) => r.severity === 'critical');
  const warn = rows.filter((r) => r.severity !== 'critical');
  if (!crit.length && !warn.length) return null;
  const day = eatDay(now);
  const subject = `🗓 Daily check · ${day} — ${plural(crit.length, 'open problem')}${warn.length ? `, ${warn.length} to look at` : ''}`;
  let body = '';
  if (crit.length) body += emailHeading('Still open', { text: `Critical · ${crit.length}`, kind: 'critical' }) + htmlTable(PROBLEM_HEADERS, crit.map(factsRow));
  if (warn.length) body += emailHeading('To look at', { text: `Warning · ${warn.length}`, kind: 'warning' }) + htmlTable(PROBLEM_HEADERS, warn.map(factsRow));
  const msg: AdminMessage = {
    tone: 'digest', headline: `Daily check · ${day}`, subject,
    summary: [crit.length ? `${crit.length} still open` : '', warn.length ? `${warn.length} to look at` : ''].filter(Boolean).join(' · '),
    // The text part lists every row (no "+N more" in an email).
    sections: [{ title: 'Still open', tone: 'critical' as Tone, lines: crit.map(problemLine) }, { title: 'To look at', tone: 'warning' as Tone, lines: warn.map(problemLine) }]
      .filter((x) => x.lines.length),
    note: countersNote(counters), buttons: [{ text: 'Open alerts', url: alertsUrl(links) }],
  };
  const r = renderMessage(msg, links, body);
  return { subject: r.subject, html: r.html, text: r.emailText };
}

// ── The daily billing summary email: ONE table ──────────────────────────────────────────────────────────────────────

export interface BillingRow { client: string; invoice: string | null; amount: number | null; currency: string; due: string | null; status: string }

/** A592: the owner's four columns, as for the client problems. */
export const BILLING_HEADERS = PROBLEM_HEADERS;

/** A592: what to do about a billing notice, by its status words (at most 60 characters). */
export function billingTodo(status: string): string {
  const s = String(status ?? '');
  if (/NOT delivered/i.test(s)) return 'Send the invoice by hand — its email failed';
  if (/^Invoice issued/i.test(s)) return 'Follow up the payment before the due date';
  if (/^Unpaid/i.test(s)) return 'Call the client — the cloud locks soon';
  if (/^Locked/i.test(s)) return 'Record the payment to unlock their cloud';
  if (/trial ended/i.test(s)) return 'Offer a plan, or record a payment';
  if (/Not interested/i.test(s)) return 'Nothing to do — the invoices are written off';
  return 'Open the client\'s Plan & billing';
}

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
export function billingSummaryEmail(notices: BillingRow[], standing: BillingRow[], now: Date, links: AlertLinks = DEFAULT_LINKS): { subject: string; html: string; text: string } | null {
  // A client with a notice today is one row (its notice); the others still unpaid or locked follow.
  const told = new Set(notices.map((r) => r.client));
  const rest = standing.filter((r) => !told.has(r.client));
  const rows = [...notices, ...rest];
  if (!rows.length) return null;
  const day = eatDay(now);
  const subject = `💳 Billing summary · ${day} — ${plural(notices.length, 'notice')}${rest.length ? `, ${rest.length} still unpaid or locked` : ''}`;
  // Client | Problem ("Unpaid 5 days — locks in 2 days · INV-0042 · KES 3,000") | Since (the due date) | What to do.
  const problem = (r: BillingRow) => [r.status, r.invoice, r.amount === null ? null : money(r.amount, r.currency)].filter(Boolean).join(' · ');
  const since = (r: BillingRow) => {
    const m = minutesSince(r.due, now);
    if (!Number.isFinite(m)) return '—';
    return m < 0 ? `due ${eatDay(r.due)}` : `${shortDuration(m)} (due ${eatDay(r.due)})`;
  };
  const cells = (r: BillingRow) => [r.client, problem(r), since(r), billingTodo(r.status)];
  const msg: AdminMessage = {
    tone: 'billing', headline: `Billing summary · ${day}`, subject,
    summary: `${plural(notices.length, 'notice')} since the last summary${rest.length ? ` · ${rest.length} still unpaid or locked` : ''}`,
    action: 'Record a payment: admin portal › the client › Plan & billing › Record payment. The clients\' own invoice emails went out as usual.',
    sections: [{ title: 'Clients', tone: 'billing', lines: rows.map((r) => ({ lead: r.client, rest: `— ${problem(r)} · ${since(r)}`, sub: billingTodo(r.status) })) }],
    buttons: [{ text: 'Open alerts', url: alertsUrl(links) }],
  };
  const r = renderMessage(msg, links, htmlTable(BILLING_HEADERS, rows.map(cells)));
  return { subject: r.subject, html: r.html, text: r.emailText };
}
