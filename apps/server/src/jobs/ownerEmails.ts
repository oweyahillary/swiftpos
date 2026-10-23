/**
 * ownerEmails.ts — A476: the HTML (and subject lines) of the owner's extra emails and of the daily email's new
 * sections. Pure: every function takes plain data and returns a string, so a test reads exactly what is sent.
 *
 * Every name a person typed (business, branch, till, cashier, product, reason, description) goes through esc() —
 * an email client renders HTML, and a till named "<img src=x onerror=…>" must arrive as text. Subject lines are plain
 * text: subjectSafe() drops line breaks (a header cannot be split) and caps the length.
 *
 * The look is the daily email's (dark card, green section headers) so the owner reads one family of emails.
 */

export const esc = (v: unknown): string => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export const subjectSafe = (s: string): string => String(s ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, 180);

export const money = (n: number): string => Number(n || 0).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const whole = (n: number): string => Math.round(Number(n || 0)).toLocaleString('en-KE');

/** "14 Oct 21:05" in East Africa Time (UTC+3, no daylight saving). '—' for nothing. */
export function eatLabel(iso: string | null | undefined): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return '—';
  const d = new Date(t + 3 * 3_600_000);
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
  return `${d.getUTCDate()} ${mon} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

/** "5 h", "1 d 3 h" */
export function hoursLabel(h: number | null | undefined): string {
  if (h === null || h === undefined || !Number.isFinite(h)) return 'a long time';
  const H = Math.max(1, Math.floor(h));
  return H < 24 ? `${H} h` : `${Math.floor(H / 24)} d${H % 24 ? ` ${H % 24} h` : ''}`;
}

const DASH = () => process.env.DASHBOARD_URL ?? 'https://app.zaptill.co.ke';

// ── building blocks in the daily email's look ────────────────────────────────

const TH = 'padding:10px 0;font-size:11px;color:#4b5563;';
const TD = 'padding:10px 0;font-size:13px;';

export function sectionHeader(title: string): string {
  return `
    <tr><td style="padding:28px 0 12px;">
      <p style="margin:0;font-size:13px;font-weight:600;color:#22c55e;text-transform:uppercase;letter-spacing:0.08em;">${esc(title)}</p>
    </td></tr>`;
}

function card(inner: string): string {
  return `
  <tr><td style="background:#111;border:1px solid #1a1a1a;border-radius:12px;padding:4px 20px;">
    <table width="100%" cellpadding="0" cellspacing="0">${inner}</table>
  </td></tr>`;
}

function table(headers: { label: string; align?: 'left' | 'center' | 'right' }[], rows: string[][], aligns?: ('left' | 'center' | 'right')[]): string {
  const head = `<tr style="border-bottom:1px solid #222;">${headers.map((h) => `<td style="${TH}text-align:${h.align ?? 'left'};">${esc(h.label)}</td>`).join('')}</tr>`;
  const body = rows.map((r) => `<tr style="border-bottom:1px solid #1a1a1a;">${r.map((c, i) =>
    `<td style="${TD}color:${i === 0 ? '#fff' : '#9ca3af'};text-align:${(aligns ?? [])[i] ?? headers[i]?.align ?? 'left'};padding-right:6px;">${c}</td>`).join('')}</tr>`).join('');
  return head + body;
}

const note = (text: string, color = '#6b7280'): string =>
  `<tr><td colspan="9" style="padding:16px 0;font-size:13px;color:${color};">${text}</td></tr>`;

/** The whole email around some sections, in the daily email's look. */
export function emailShell(opts: { businessName: string; kind: string; banner: string; bannerSub?: string; body: string; cta?: { href: string; label: string } }): string {
  const cta = opts.cta ?? { href: `${DASH()}/dashboard/reports`, label: 'Open ZapTill →' };
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0a;padding:40px 20px;">
<tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;">
  <tr><td style="padding-bottom:24px;">
    <p style="margin:0;font-size:22px;font-weight:700;color:#22c55e;">ZapTill</p>
    <p style="margin:4px 0 0;font-size:12px;color:#6b7280;">${esc(opts.businessName)} · ${esc(opts.kind)}</p>
  </td></tr>
  <tr><td style="background:#111;border:1px solid #1a1a1a;border-radius:12px;padding:20px 24px;">
    <p style="margin:0;font-size:16px;font-weight:600;color:#fff;">${esc(opts.banner)}</p>
    ${opts.bannerSub ? `<p style="margin:4px 0 0;font-size:13px;color:#6b7280;">${esc(opts.bannerSub)}</p>` : ''}
  </td></tr>
  ${opts.body}
  <tr><td style="padding-top:28px;text-align:center;">
    <a href="${esc(cta.href)}" style="display:inline-block;background:#22c55e;color:#000;font-weight:700;font-size:14px;padding:14px 32px;border-radius:8px;text-decoration:none;">${esc(cta.label)}</a>
  </td></tr>
  <tr><td style="padding-top:32px;text-align:center;">
    <p style="margin:0;font-size:11px;color:#374151;">Sent by ZapTill · ${esc(opts.businessName)} · Choose which emails you get in Settings › Report Scheduler.</p>
  </td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

// ── open / unconfirmed tills ─────────────────────────────────────────────────

export interface OpenTillLine {
  branch: string;
  till: string;
  cashier: string;
  openedAt: string;
  state: 'open' | 'awaiting_confirm';
  older: boolean;
  expectedCash: number | null;
}

function openTillRows(lines: OpenTillLine[], currency: string, withBranch: boolean): string[][] {
  return lines.map((l) => {
    const status = l.state === 'open'
      ? (l.older ? `<span style="color:#f97316;font-weight:600;">Open since ${esc(eatLabel(l.openedAt))}</span>` : 'Open')
      : `<span style="color:#f59e0b;">Closed, not confirmed</span>`;
    const row = [
      esc(l.till),
      esc(l.cashier),
      esc(eatLabel(l.openedAt)),
      status,
      l.expectedCash === null ? '—' : `${esc(currency)} ${money(l.expectedCash)}`,
    ];
    return withBranch ? [esc(l.branch), ...row] : row;
  });
}

const OPEN_HEADERS = [
  { label: 'TILL' }, { label: 'CASHIER' }, { label: 'OPENED' }, { label: 'STATUS' }, { label: 'EXPECTED CASH', align: 'right' as const },
];

/** The daily email's "Tills not closed or confirmed" section — or the ✓ line when every till is done. */
export function openTillsSection(lines: OpenTillLine[], currency: string): string {
  if (!lines.length) {
    return sectionHeader('Tills') + card(note('✓ All tills closed and confirmed.', '#22c55e'));
  }
  // grouped by branch: a branch heading row, then its tills
  const byBranch = new Map<string, OpenTillLine[]>();
  for (const l of lines) byBranch.set(l.branch, [...(byBranch.get(l.branch) ?? []), l]);
  let inner = '';
  for (const [branch, list] of byBranch) {
    inner += `<tr><td colspan="5" style="padding:14px 0 4px;font-size:12px;font-weight:600;color:#e5e7eb;">${esc(branch)} · ${list.length} not done</td></tr>`;
    inner += table(OPEN_HEADERS, openTillRows(list, currency, false));
  }
  return sectionHeader(`Tills not closed or confirmed (${lines.length})`) + card(inner);
}

export interface BranchTillsEmail { subject: string; html: string }

/** The branch managers' email (always sent when a branch has a till not closed / not confirmed). */
export function branchOpenTillsEmail(opts: {
  businessName: string; branchName: string; slot: 'evening' | 'morning'; lines: OpenTillLine[]; currency: string;
}): BranchTillsEmail {
  const n = opts.lines.length;
  const tills = `${n} till${n === 1 ? '' : 's'}`;
  const subject = opts.slot === 'morning'
    ? `Still not closed this morning: ${tills} — ${opts.branchName}`
    : `${tills} not closed or confirmed — ${opts.branchName}`;
  const body = sectionHeader(opts.slot === 'morning' ? 'Still open from yesterday or earlier' : 'Tills to close or confirm')
    + card(table(OPEN_HEADERS, openTillRows(opts.lines, opts.currency, false)));
  const html = emailShell({
    businessName: opts.businessName,
    kind: `${opts.branchName} · Tills`,
    banner: `${opts.branchName}: ${tills} not closed or confirmed`,
    bannerSub: opts.slot === 'morning'
      ? 'These were still open or waiting for a manager\'s count at 09:00. Close each drawer and confirm the count so the day can be closed.'
      : 'Close each open drawer, and confirm every closed shift\'s count, so today\'s takings are final.',
    body,
    cta: { href: `${DASH()}/manager`, label: 'Open the manager view →' },
  });
  return { subject: subjectSafe(subject), html };
}

// ── the daily email's other new sections ─────────────────────────────────────

export interface VarianceLine { branch: string; till: string; cashier: string; expected: number | null; counted: number | null; difference: number; reason: string | null }

export function variancesSection(lines: VarianceLine[], currency: string): string {
  if (!lines.length) return '';
  const rows = lines.map((v) => [
    `${esc(v.cashier)}<br><span style="font-size:11px;color:#6b7280;">${esc(v.branch)} · ${esc(v.till)}</span>`,
    v.expected === null ? '—' : money(v.expected),
    v.counted === null ? '—' : money(v.counted),
    `<span style="color:${v.difference < 0 ? '#ef4444' : '#f59e0b'};font-weight:600;">${v.difference > 0 ? '+' : ''}${money(v.difference)}</span>`
      + (v.reason ? `<br><span style="font-size:11px;color:#6b7280;">${esc(v.reason)}</span>` : ''),
  ]);
  return sectionHeader(`Cash differences at confirm (${currency})`) + card(table(
    [{ label: 'SHIFT' }, { label: 'EXPECTED', align: 'right' }, { label: 'COUNTED', align: 'right' }, { label: 'DIFFERENCE', align: 'right' }], rows));
}

export interface ReversalLine { kind: 'void' | 'refund'; orderNumber: string; branch: string; cashier: string; amount: number; reason: string | null; at: string | null }

export function voidsRefundsSection(lines: ReversalLine[], totals: { voids: number; voidValue: number; refunds: number; refundValue: number }, currency: string): string {
  if (!lines.length && !totals.voids && !totals.refunds) return '';
  const rows = lines.map((r) => [
    `${r.kind === 'void' ? 'Void' : 'Refund'} #${esc(r.orderNumber)}<br><span style="font-size:11px;color:#6b7280;">${esc(r.branch)} · ${esc(eatLabel(r.at))}</span>`,
    esc(r.cashier),
    esc(r.reason ?? '—'),
    `<span style="color:#f97316;font-weight:600;">${money(r.amount)}</span>`,
  ]);
  const sum = `<tr><td colspan="4" style="padding:12px 0 6px;font-size:13px;color:#e5e7eb;">${totals.voids} void${totals.voids === 1 ? '' : 's'} · ${esc(currency)} ${money(totals.voidValue)}
    &nbsp;&nbsp;|&nbsp;&nbsp; ${totals.refunds} refund${totals.refunds === 1 ? '' : 's'} · ${esc(currency)} ${money(totals.refundValue)}</td></tr>`;
  return sectionHeader('Voids and refunds') + card(sum + (rows.length ? table(
    [{ label: 'ORDER' }, { label: 'BY' }, { label: 'REASON' }, { label: 'AMOUNT', align: 'right' }], rows) : ''));
}

export interface SyncLine { branch: string; till: string; lastSyncAt: string | null; hours: number | null; refused: boolean }

export function notSyncingSection(lines: SyncLine[]): string {
  if (!lines.length) return '';
  const rows = lines.map((s) => [
    esc(s.till),
    esc(s.branch),
    s.refused ? '<span style="color:#ef4444;font-weight:600;">Signed out — needs rejoin</span>'
      : `<span style="color:#f97316;">Not synced for ${esc(hoursLabel(s.hours))}</span>`,
    esc(eatLabel(s.lastSyncAt)),
  ]);
  return sectionHeader(`Tills not syncing (${lines.length})`) + card(table(
    [{ label: 'TILL' }, { label: 'BRANCH' }, { label: 'STATE' }, { label: 'LAST SYNC', align: 'right' }], rows));
}

export interface ExpenseLine { branch: string; description: string; category: string; method: string; amount: number }

export function expensesSection(lines: ExpenseLine[], total: number, count: number, currency: string): string {
  if (!count) return '';
  const rows = lines.map((e) => [
    `${esc(e.description)}<br><span style="font-size:11px;color:#6b7280;">${esc(e.branch)} · ${esc(e.category)}</span>`,
    esc(e.method),
    money(e.amount),
  ]);
  const more = count > lines.length ? note(`… and ${count - lines.length} more in Expenses.`) : '';
  return sectionHeader(`Expenses — ${count} · ${currency} ${money(total)}`) + card(table(
    [{ label: 'EXPENSE' }, { label: 'PAID BY', align: 'center' }, { label: 'AMOUNT', align: 'right' }], rows, ['left', 'center', 'right']) + more);
}

// ── alerts ───────────────────────────────────────────────────────────────────

export interface AlertEmail { subject: string; html: string }

export function notSyncingAlertEmail(opts: {
  businessName: string; branchName: string; till: string; kind: 'stale' | 'refused'; hours: number | null; lastSyncAt: string | null; reason?: string | null;
}): AlertEmail {
  const where = opts.branchName || opts.businessName;
  const subject = opts.kind === 'refused'
    ? `⚠ Till '${opts.till}' is signed out and cannot sync — ${where}`
    : `⚠ Till '${opts.till}' has not synced for ${hoursLabel(opts.hours)} — ${where}`;
  const lines = opts.kind === 'refused'
    ? `The cloud refused this till's sign-in and it could not sign itself back in${opts.reason ? ` (${esc(opts.reason)})` : ''}. It keeps selling, but its sales wait on the till until it is rejoined: issue an enrolment code in Branches &amp; tills and use "Rejoin this till" on the till.`
    : `Its last sync was ${esc(eatLabel(opts.lastSyncAt))} (${esc(hoursLabel(opts.hours))} ago) while the branch is trading. Its sales are not reaching the cloud — check the till's internet and that it is switched on.`;
  const body = sectionHeader('Till not syncing') + card(`<tr><td style="padding:14px 0;font-size:13px;color:#e5e7eb;line-height:1.5;">
    <strong style="color:#fff;">${esc(opts.till)}</strong> · ${esc(opts.branchName)}<br>${lines}</td></tr>`);
  return {
    subject: subjectSafe(subject),
    html: emailShell({ businessName: opts.businessName, kind: 'Alert', banner: subjectSafe(subject).replace(/^⚠ /, ''), body,
      cta: { href: `${DASH()}/dashboard/settings/devices/terminals`, label: 'Open the tills (Fleet) →' } }),
  };
}

/** A477: another computer seems to hold a till's data (an outdated sign-in key, or the key from a machine not on record). */
export function tillSecurityAlertEmail(opts: { businessName: string; branchName: string; till: string; reason: string | null; at: string | null }): AlertEmail {
  const where = opts.branchName || opts.businessName;
  const subject = `⚠ Till '${opts.till}' — its sign-in was used from another computer — ${where}`;
  const lines = `${opts.reason ? `${esc(opts.reason)}. ` : ''}The cloud refused it (${esc(eatLabel(opts.at))}); the till itself keeps working. `
    + 'If nobody copied or moved this till, someone may hold a copy of its data: retire the old copy in Branches &amp; tills, '
    + 'and have a technician rejoin the real till if it stops syncing.';
  const body = sectionHeader('Till sign-in from another computer') + card(`<tr><td style="padding:14px 0;font-size:13px;color:#e5e7eb;line-height:1.5;">
    <strong style="color:#fff;">${esc(opts.till)}</strong> · ${esc(opts.branchName)}<br>${lines}</td></tr>`);
  return {
    subject: subjectSafe(subject),
    html: emailShell({ businessName: opts.businessName, kind: 'Alert', banner: subjectSafe(subject).replace(/^⚠ /, ''), body,
      cta: { href: `${DASH()}/dashboard/settings/devices/terminals`, label: 'Open the tills (Fleet) →' } }),
  };
}

export interface BigReversalAlertLine extends ReversalLine { approvedBy?: string | null }

export function bigReversalAlertEmail(opts: { businessName: string; currency: string; threshold: number; lines: BigReversalAlertLine[] }): AlertEmail {
  const n = opts.lines.length;
  const one = opts.lines[0];
  const subject = n === 1
    ? `⚠ ${one.kind === 'void' ? 'Void' : 'Refund'} of ${opts.currency} ${whole(one.amount)} on order #${one.orderNumber} — ${one.branch || opts.businessName}`
    : `⚠ ${n} large voids / refunds — ${opts.businessName}`;
  const rows = opts.lines.map((r) => [
    `${r.kind === 'void' ? 'Void' : 'Refund'} #${esc(r.orderNumber)}<br><span style="font-size:11px;color:#6b7280;">${esc(r.branch)} · ${esc(eatLabel(r.at))}</span>`,
    esc(r.cashier) + (r.approvedBy ? `<br><span style="font-size:11px;color:#6b7280;">approved by ${esc(r.approvedBy)}</span>` : ''),
    esc(r.reason ?? '—'),
    `<span style="color:#f97316;font-weight:600;">${money(r.amount)}</span>`,
  ]);
  const body = sectionHeader(`At or above ${opts.currency} ${whole(opts.threshold)}`) + card(table(
    [{ label: 'ORDER' }, { label: 'BY' }, { label: 'REASON' }, { label: `AMOUNT (${opts.currency})`, align: 'right' }], rows));
  return {
    subject: subjectSafe(subject),
    html: emailShell({ businessName: opts.businessName, kind: 'Alert', banner: subjectSafe(subject).replace(/^⚠ /, ''), body,
      cta: { href: `${DASH()}/dashboard/reports`, label: 'Open the voids & refunds report →' } }),
  };
}

export function varianceAlertEmail(opts: { businessName: string; currency: string; threshold: number; lines: (VarianceLine & { confirmedBy?: string | null })[] }): AlertEmail {
  const n = opts.lines.length;
  const one = opts.lines[0];
  const subject = n === 1
    ? `⚠ Cash ${one.difference < 0 ? 'short' : 'over'} ${opts.currency} ${whole(Math.abs(one.difference))} on ${one.cashier}'s shift — ${one.branch || opts.businessName}`
    : `⚠ ${n} shifts confirmed with a cash difference — ${opts.businessName}`;
  const body = variancesSection(opts.lines, opts.currency)
    + (opts.lines.some((l) => l.confirmedBy)
      ? card(`<tr><td style="padding:10px 0;font-size:12px;color:#6b7280;">Confirmed by ${esc([...new Set(opts.lines.map((l) => l.confirmedBy).filter(Boolean))].join(', '))}.</td></tr>`)
      : '');
  return {
    subject: subjectSafe(subject),
    html: emailShell({ businessName: opts.businessName, kind: 'Alert', banner: subjectSafe(subject).replace(/^⚠ /, ''),
      bannerSub: `A manager confirmed a shift with a cash difference of ${opts.currency} ${whole(opts.threshold)} or more.`, body }),
  };
}

// ── the weekly summary ───────────────────────────────────────────────────────

export interface WeekFigures {
  sales: number; orders: number; avg: number; voids: number; voidValue: number;
  expenses: number; varianceShifts: number; varianceNet: number;
  topItems: { name: string; qty: number; revenue: number }[];
}

function change(cur: number, prev: number): string {
  if (!prev) return cur ? '<span style="color:#6b7280;">new</span>' : '<span style="color:#6b7280;">—</span>';
  const pct = Math.round(((cur - prev) / Math.abs(prev)) * 100);
  const color = pct > 0 ? '#22c55e' : pct < 0 ? '#ef4444' : '#6b7280';
  return `<span style="color:${color};">${pct > 0 ? '+' : ''}${pct}%</span>`;
}

export function weeklySummaryEmail(opts: {
  businessName: string; currency: string; thisFrom: string; thisTo: string; cur: WeekFigures; prev: WeekFigures;
}): AlertEmail {
  const c = opts.currency;
  const { cur, prev } = opts;
  const line = (label: string, a: string, b: string, ch: string) => [esc(label), a, b, ch];
  const rows = [
    line('Sales', `${esc(c)} ${money(cur.sales)}`, money(prev.sales), change(cur.sales, prev.sales)),
    line('Orders', String(cur.orders), String(prev.orders), change(cur.orders, prev.orders)),
    line('Average order', money(cur.avg), money(prev.avg), change(cur.avg, prev.avg)),
    line('Voids', `${cur.voids} · ${money(cur.voidValue)}`, `${prev.voids} · ${money(prev.voidValue)}`, change(cur.voidValue, prev.voidValue)),
    line('Expenses', money(cur.expenses), money(prev.expenses), change(cur.expenses, prev.expenses)),
    line('Cash differences', `${cur.varianceShifts} shift${cur.varianceShifts === 1 ? '' : 's'} · ${money(cur.varianceNet)}`,
      `${prev.varianceShifts} · ${money(prev.varianceNet)}`, ''),
  ];
  const top = cur.topItems.length
    ? table([{ label: '#' }, { label: 'ITEM' }, { label: 'QTY', align: 'center' }, { label: 'REVENUE', align: 'right' }],
      cur.topItems.map((p, i) => [String(i + 1), esc(p.name), String(Math.round(p.qty * 100) / 100), money(p.revenue)]), ['left', 'left', 'center', 'right'])
    : note('No sales recorded last week.');
  const body = sectionHeader('Last week against the week before') + card(table(
    [{ label: '' }, { label: 'LAST WEEK', align: 'right' }, { label: 'WEEK BEFORE', align: 'right' }, { label: 'CHANGE', align: 'right' }], rows))
    + sectionHeader('Top items last week') + card(top);
  const subject = `📈 Weekly summary — ${opts.businessName} · ${opts.thisFrom} to ${opts.thisTo}`;
  return {
    subject: subjectSafe(subject),
    html: emailShell({ businessName: opts.businessName, kind: 'Weekly summary', banner: `Week of ${opts.thisFrom} to ${opts.thisTo}`,
      bannerSub: `Sales ${c} ${money(cur.sales)} (${prev.sales ? `${Math.round(((cur.sales - prev.sales) / Math.abs(prev.sales)) * 100)}% on the week before` : 'no sales the week before'}).`, body }),
  };
}

// ── A576: loss-prevention alerts in the daily email ──────────────────────────

/**
 * The day's "worth a look" lines (already ranked and capped at 10 by lib/lossAlertRules.ts emailLines), each with its
 * link to the list behind it. Plain words — a warning for investigation, never an accusation. '' when there are none.
 */
export function lossAlertsSection(lines: Array<{ message: string; link: string | null }>): string {
  if (!lines.length) return '';
  const rows = lines.map((l) => [
    `${esc(l.message)}${l.link ? `<br><a href="${esc(DASH() + l.link)}" style="font-size:11px;color:#22c55e;text-decoration:none;">See the list →</a>` : ''}`,
  ]);
  return sectionHeader('Worth a look') + card(table([{ label: 'FOR INVESTIGATION — NOT A FINDING' }], rows))
    + `<tr><td style="padding:8px 0 0;font-size:11px;color:#6b7280;">More on the dashboard's Watch list. Switch these off or change the amounts in Settings › Business › Loss prevention.</td></tr>`;
}
