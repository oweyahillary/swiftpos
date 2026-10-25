/**
 * cloudPlanEmail.ts — the cloud plan's words. Pure, so a test reads exactly what is sent.
 *
 * A584 (2026-10-23) — owner: "an invoice is sent to the client on the first day of their billing … without informing them
 * when the access will be revoked"; reminders go to ZapTill only. So the CLIENT gets:
 *   - the invoice (HTML, the daily email's look): the business, the invoice number, the period, the amount in KES, "due
 *     now", how to pay (M-Pesa, or WhatsApp / call ZapTill on 0717 675 635 — no company email yet). Never a word of a
 *     lock, a pause, a deadline or a revocation; never a countdown.
 *   - a short receipt when a payment is recorded: the amount, the reference, the paid-until date.
 * and ZAPTILL gets (plain text: the admin alert email and Telegram — lib/alertNotify.ts): the invoice issued (to whom),
 * the 5th unpaid day ("locks in 2 days"), the lock, "Not interested" (A587: 3 months unpaid, its invoices written off) —
 * and the morning digest lists the locked clients. A587: a trial's end is its first invoice (the line says the trial ended).
 */
import { esc, emailShell, subjectSafe } from '../jobs/ownerEmails';
import { PERIOD_LABEL, ZAPTILL_PHONE, type PlanPeriod } from './cloudPlan';

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
const WHATSAPP = 'https://wa.me/254717675635';

/** "KES 3,000 for one month (month on month)", "KES 18,000 for 6 months". */
export function priceLine(f: { amount: number; currency: string; period: PlanPeriod }): string {
  const what = f.period === 'monthly' ? 'one month (month on month)' : f.period === 'custom' ? 'the agreed period' : PERIOD_LABEL[f.period];
  return `${f.currency} ${whole(f.amount)} for ${what}`;
}

const factsTable = (facts: Array<[string, string]>) => `
  <tr><td style="padding-top:16px;"><table width="100%" cellpadding="0" cellspacing="0" style="background:#111;border:1px solid #1a1a1a;border-radius:12px;padding:8px 20px;">
    ${facts.map(([k, v]) => `<tr><td style="padding:9px 0;font-size:13px;color:#9ca3af;">${esc(k)}</td><td style="padding:9px 0;font-size:13px;color:#fff;text-align:right;font-weight:600;">${esc(v)}</td></tr>`).join('')}
  </table></td></tr>`;
const para = (lines: string[]) => lines.map((l) => `<tr><td style="padding:14px 4px 0;font-size:14px;line-height:1.55;color:#d1d5db;">${esc(l)}</td></tr>`).join('');

// ── The invoice (to the client) ───────────────────────────────────────────────────────────────────────────────────────

export interface InvoiceFacts {
  businessName: string;
  invoiceNumber: string;
  periodStart: string;
  periodEnd: string | null;
  amount: number;
  currency: string;
  period: PlanPeriod;
  /** A587: the first invoice after a cloud trial — its end (the line says the trial ended). */
  trialEnded?: string | null;
}

/** The invoice's words — the subject, the headline and the lines. */
export function invoiceWords(f: InvoiceFacts): { subject: string; headline: string; lines: string[]; facts: Array<[string, string]> } {
  const span = f.periodEnd ? `${planDate(f.periodStart)} – ${planDate(f.periodEnd)}` : `from ${planDate(f.periodStart)}`;
  return {
    subject: subjectSafe(`ZapTill invoice ${f.invoiceNumber} — ${f.businessName}`),
    headline: `Invoice ${f.invoiceNumber} for your ZapTill cloud`,
    facts: [
      ['Business', f.businessName],
      ['Invoice', f.invoiceNumber],
      ['Period', span],
      ['Plan', f.period === 'custom' ? 'Agreed period' : PERIOD_LABEL[f.period]],
      ['Amount', `${f.currency} ${whole(f.amount)}`],
      ['Due', 'Now'],
    ],
    lines: [
      ...(f.trialEnded ? [`Your one-month ZapTill cloud trial ended on ${planDate(f.trialEnded)} — thank you for trying it.`] : []),
      `Thank you for using ZapTill. This is your invoice for the ZapTill cloud — the web dashboard, the online features and syncing — for ${span}: ${priceLine(f)}.`,
      `How to pay: M-Pesa, or WhatsApp or call ZapTill on ${ZAPTILL_PHONE} and we will confirm your payment and send you a receipt.`,
      'You may also pay ahead for 3, 6 or 12 months.',
    ],
  };
}

/** The client's invoice email. */
export function invoiceEmailHtml(f: InvoiceFacts): { subject: string; html: string } {
  const w = invoiceWords(f);
  const html = emailShell({
    businessName: f.businessName, kind: 'Invoice', banner: w.headline, bannerSub: `${f.currency} ${whole(f.amount)} · due now`,
    body: factsTable(w.facts) + para(w.lines),
    cta: { href: WHATSAPP, label: `WhatsApp ZapTill · ${ZAPTILL_PHONE}` },
  }).replace('Choose which emails you get in Settings › Report Scheduler.', 'This is your ZapTill cloud invoice.');
  return { subject: w.subject, html };
}

// ── The receipt (to the client, when a payment is recorded) ───────────────────────────────────────────────────────────

export interface ReceiptFacts { businessName: string; amount: number; currency: string; method: string; reference: string | null; paidAt: string; paidUntil: string; invoiceNumber: string | null }
const METHOD: Record<string, string> = { mpesa: 'M-Pesa', bank: 'Bank', cash: 'Cash', other: 'Payment' };

export function receiptEmailHtml(f: ReceiptFacts): { subject: string; html: string; text: string } {
  const how = `${METHOD[f.method] ?? 'Payment'}${f.reference ? ` ${f.reference}` : ''}`;
  const lines = [
    `Thank you — we received ${f.currency} ${whole(f.amount)} (${how}) on ${planDate(f.paidAt)}.`,
    `Your ZapTill cloud is paid until ${planDate(f.paidUntil)}.`,
  ];
  const facts: Array<[string, string]> = [['Amount', `${f.currency} ${whole(f.amount)}`], ['Reference', how], ['Paid until', planDate(f.paidUntil)]];
  if (f.invoiceNumber) facts.push(['Invoice', `${f.invoiceNumber} (paid)`]);
  const html = emailShell({
    businessName: f.businessName, kind: 'Receipt', banner: 'Payment received — thank you',
    body: factsTable(facts) + para(lines),
    cta: { href: WHATSAPP, label: `WhatsApp ZapTill · ${ZAPTILL_PHONE}` },
  }).replace('Choose which emails you get in Settings › Report Scheduler.', 'This is your ZapTill cloud receipt.');
  return { subject: subjectSafe(`ZapTill receipt — ${f.businessName} — ${f.currency} ${whole(f.amount)}`), html, text: lines.join('\n') };
}

// ── ZapTill's notices (admin only) ────────────────────────────────────────────────────────────────────────────────────

export interface AdminNoticeFacts {
  businessName: string;
  milestone: 'invoice' | 'unpaid_5' | 'locked' | 'trial_end' | 'not_interested';
  dueAt: string | null;
  lockAt: string | null;
  unpaidDays: number | null;
  lockInDays: number | null;
  amount: number;
  currency: string;
  period: PlanPeriod;
  invoiceNumber?: string | null;
  ownerEmail: string | null;
  ownerSent?: boolean;
  /** A587: the client is on a cloud trial (its first invoice). */
  trial?: boolean;
  /** A587: when it became "Not interested", and the invoices written off. */
  notInterestedAt?: string | null;
  writtenOff?: string[];
}

/** ZapTill's copy (the admin alert email and Telegram). */
export function adminNoticeText(f: AdminNoticeFacts): { subject: string; text: string } {
  const record = 'Record the payment: admin portal › client › Plan & billing › Record payment.';
  const price = priceLine(f);
  if (f.milestone === 'invoice') {
    return {
      subject: subjectSafe(`[ZapTill billing] ${f.businessName} — invoice ${f.invoiceNumber ?? ''} issued, ${f.currency} ${whole(f.amount)}`),
      text: [
        `Invoice ${f.invoiceNumber ?? '(not raised)'} issued to ${f.businessName}: ${price}, due ${planDate(f.dueAt)}.`,
        `Client's copy: ${f.ownerEmail ? `${f.ownerEmail}${f.ownerSent === false ? ' (NOT delivered — check the email provider)' : ''}` : 'no email on file — send it yourself'}.`,
        ...(f.trial ? ['The one-month cloud trial has ended: this is its first invoice, billed as a paid client is.'] : []),
        `If unpaid it locks at the end of ${planDate(f.lockAt ? new Date(Date.parse(f.lockAt) - 1).toISOString() : null)} (7 days). The client is not told when.`,
        record,
      ].join('\n'),
    };
  }
  if (f.milestone === 'unpaid_5') {
    const n = f.lockInDays ?? 2;
    return {
      subject: subjectSafe(`[ZapTill billing] ${f.businessName} — unpaid ${days(f.unpaidDays ?? 5)}, locks in ${days(n)}`),
      text: [
        `${f.businessName} has not paid ${price} (due ${planDate(f.dueAt)}) — unpaid ${days(f.unpaidDays ?? 5)}.`,
        `Locks in ${days(n)} (at the end of ${planDate(f.lockAt ? new Date(Date.parse(f.lockAt) - 1).toISOString() : null)}): the web dashboard pauses, sync stops, no POS can join. Points of sale keep selling.`,
        `Owner: ${f.ownerEmail ?? 'no email on file'}. A call now may save the lock.`,
        record,
      ].join('\n'),
    };
  }
  if (f.milestone === 'locked') {
    return {
      subject: subjectSafe(`[ZapTill billing] ${f.businessName} — locked (unpaid since ${planDate(f.dueAt)})`),
      text: [
        `${f.businessName} is locked: unpaid since ${planDate(f.dueAt)} (${price}).`,
        'The web dashboard is paused, the cloud refuses sync from its points of sale and no POS can join. The points of sale keep selling and keep their sales.',
        'A recorded payment opens everything at once and starts a fresh period from that day (pay as you go — the locked time is not charged; its unpaid invoice is closed). The morning digest lists it while locked.',
        record,
      ].join('\n'),
    };
  }
  if (f.milestone === 'not_interested') {
    const n = f.writtenOff ?? [];
    return {
      subject: subjectSafe(`[ZapTill billing] ${f.businessName} — Not interested (unpaid 3 months)`),
      text: [
        `${f.businessName} has not paid since ${planDate(f.dueAt)} — 3 months. It is now marked "Not interested" (since ${planDate(f.notInterestedAt)}).`,
        n.length ? `Written off: ${n.join(', ')}.` : 'No open cloud invoice to write off.',
        'No more invoices go out; the cloud stays locked (web paused, sync refused, no POS joins). The points of sale keep selling.',
        'If the client pays later, the payment starts a fresh period from that day (pay as you go — no arrears): admin portal › client › Plan & billing › Record payment.',
      ].join('\n'),
    };
  }
  return {
    subject: subjectSafe(`[ZapTill billing] ${f.businessName} — cloud trial ended ${planDate(f.dueAt)}`),
    text: [
      `${f.businessName}'s one-month cloud trial ended on ${planDate(f.dueAt)}: sync has stopped and the web dashboard reads reports only for 7 days, then closes.`,
      `Owner: ${f.ownerEmail ?? 'no email on file'}.`,
      'Convert to paid: admin portal › client › Plan & billing › Record payment.',
    ].join('\n'),
  };
}
