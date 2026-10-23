/**
 * cloudPlanEmail.ts — A581: the cloud plan reminder's words — the owner's email (HTML, the daily email's look) and
 * ZapTill's copy (plain text: the admin alert email and Telegram, lib/alertNotify.ts). Pure, so a test reads exactly what
 * is sent.
 *
 * Plain and polite: the amount, the period, the paid-until date, what happens and when, and how to pay (WhatsApp or call
 * ZapTill on 0717 675 635 — no company email yet). Never a threat; always that the tills keep selling.
 */
import { esc, emailShell, subjectSafe } from '../jobs/ownerEmails';
import { PERIOD_LABEL, ZAPTILL_PHONE, type PlanPeriod } from './cloudPlan';

export interface ReminderFacts {
  businessName: string;
  milestone: string;              // before_14 … lapsed_w8 (lib/cloudPlan.ts reminderMilestone)
  daysLeft: number;               // calendar days to paid-until (negative: lapsed)
  paidUntil: string;
  syncStopsAt: string | null;     // paid-until + the grace (a trial: its end)
  amount: number;
  currency: string;
  period: PlanPeriod;
  trial: boolean;
  syncStopped: boolean;           // the tills' sync is refused now
  ownerEmail: string | null;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "23 Nov 2026", in Nairobi time. */
export function planDate(iso: string | null | undefined): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return '—';
  const d = new Date(t + 3 * 3_600_000);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
const whole = (n: number) => Math.round(Number(n || 0)).toLocaleString('en-KE');
const days = (n: number) => `${n} day${n === 1 ? '' : 's'}`;

/** "KES 3,000 for one month (Monthly)", "KES 18,000 for 6 months". */
export function priceLine(f: Pick<ReminderFacts, 'amount' | 'currency' | 'period'>): string {
  const what = f.period === 'monthly' ? 'one month (month on month)' : f.period === 'custom' ? 'the agreed period' : PERIOD_LABEL[f.period];
  return `${f.currency} ${whole(f.amount)} for ${what}`;
}

/** The headline, the explanation and the subject, for both copies. */
export function reminderWords(f: ReminderFacts): { subject: string; headline: string; lines: string[] } {
  const thing = f.trial ? 'ZapTill cloud trial' : 'ZapTill cloud subscription';
  const until = planDate(f.paidUntil);
  const stops = planDate(f.syncStopsAt);
  const keepSelling = 'Your tills keep selling whatever happens — every sale stays on the till.';
  let headline: string; let when: string;
  if (f.daysLeft > 0) {
    headline = `Your ${thing} for ${f.businessName} ${f.trial ? 'ends' : 'is paid until'} ${until} — ${days(f.daysLeft)} left`;
    when = f.trial
      ? `When the trial ends, the cloud stops syncing your tills and the web dashboard goes to reports only, then closes a week later.`
      : `If it is not renewed, the web dashboard and syncing carry on until ${stops}; after that the cloud stops syncing your tills and no new till can be joined until it is paid.`;
  } else if (f.daysLeft === 0) {
    headline = `Your ${thing} for ${f.businessName} ${f.trial ? 'ends' : 'is due'} today (${until})`;
    when = f.trial || f.syncStopped
      ? `The cloud has stopped syncing your tills, and no new till can be joined, until it is paid.`
      : `The web dashboard and syncing carry on until ${stops}; after that the cloud stops syncing your tills and no new till can be joined until it is paid.`;
  } else {
    headline = `Your ${thing} for ${f.businessName} ended on ${until} — ${days(-f.daysLeft)} ago`;
    when = f.syncStopped
      ? `The cloud has stopped syncing your tills and no new till can be joined. Your sales are kept on the tills and go up as soon as it is paid.`
      : `The web dashboard and syncing carry on until ${stops}; after that the cloud stops syncing your tills and no new till can be joined until it is paid.`;
  }
  const lines = [
    when,
    `To ${f.trial ? 'keep the cloud' : 'renew'}: ${priceLine(f)}. Pay ahead for 3, 6 or 12 months if you prefer.`,
    `How to pay: WhatsApp or call ZapTill on ${ZAPTILL_PHONE} — we confirm your payment and the cloud carries on (or starts syncing again at once).`,
    keepSelling,
  ];
  const short = f.daysLeft > 0 ? `${days(f.daysLeft)} left (${until})` : f.daysLeft === 0 ? `due today (${until})` : `ended ${until}`;
  return { subject: subjectSafe(`ZapTill cloud: ${f.businessName} — ${f.trial ? 'trial ' : ''}${short}`), headline, lines };
}

/** The owner's email. */
export function reminderEmailHtml(f: ReminderFacts): { subject: string; html: string } {
  const w = reminderWords(f);
  const facts: Array<[string, string]> = [
    [f.trial ? 'Trial ends' : 'Paid until', planDate(f.paidUntil)],
    ['Plan', f.period === 'custom' ? 'Agreed period' : PERIOD_LABEL[f.period]],
    ['Amount', `${f.currency} ${whole(f.amount)}`],
    ['Cloud syncing', f.syncStopped ? 'Stopped until paid' : f.syncStopsAt ? `Until ${planDate(f.syncStopsAt)}` : '—'],
  ];
  const body = `
  <tr><td style="padding-top:16px;"><table width="100%" cellpadding="0" cellspacing="0" style="background:#111;border:1px solid #1a1a1a;border-radius:12px;padding:8px 20px;">
    ${facts.map(([k, v]) => `<tr><td style="padding:9px 0;font-size:13px;color:#9ca3af;">${esc(k)}</td><td style="padding:9px 0;font-size:13px;color:#fff;text-align:right;font-weight:600;">${esc(v)}</td></tr>`).join('')}
  </table></td></tr>
  ${w.lines.map((l) => `<tr><td style="padding:14px 4px 0;font-size:14px;line-height:1.55;color:#d1d5db;">${esc(l)}</td></tr>`).join('')}`;
  const html = emailShell({
    businessName: f.businessName, kind: 'Cloud plan', banner: w.headline, body,
    cta: { href: `https://wa.me/254717675635`, label: `WhatsApp ZapTill · ${ZAPTILL_PHONE}` },
  }).replace('Choose which emails you get in Settings › Report Scheduler.', 'This reminder is about your ZapTill cloud plan.');
  return { subject: w.subject, html };
}

/** ZapTill's copy (the admin alert email and Telegram): the same facts and who the owner's copy went to. */
export function reminderAdminText(f: ReminderFacts): { subject: string; text: string } {
  const w = reminderWords(f);
  return {
    subject: subjectSafe(`[ZapTill billing] ${f.businessName} — ${f.milestone.replace(/_/g, ' ')}`),
    text: [
      w.headline,
      `${f.trial ? 'Trial ends' : 'Paid until'}: ${planDate(f.paidUntil)} · ${priceLine(f)}`,
      `Sync: ${f.syncStopped ? 'STOPPED (lapsed past the grace)' : f.syncStopsAt ? `runs until ${planDate(f.syncStopsAt)}` : '—'}`,
      `Owner's copy: ${f.ownerEmail ?? 'no email on file'}`,
      'Record the payment: admin portal › client › Plan & billing › Record payment.',
    ].join('\n'),
  };
}
