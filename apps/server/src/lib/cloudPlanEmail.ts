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

// ── A612 phase 3: the invoice per business, a line per branch (to the business's owner) ──────────────────────────────
// Owner, 2026-10-30: "the owner should be the one who gets the invoice not individual branch" — ONE invoice per business,
// a line per branch due that day (each branch still pays and locks on its own). A light, printable page (an accountant
// prints or forwards it): ZapTill's details, "Billed to", the lines, the total, how to pay. The seller's and the payment
// details are ZapTill's, set in the admin portal; until they are, SAMPLE_SELLER stands in (marked as a sample). Never a
// word of a lock, a pause or a deadline (A584).

export interface InvoiceSeller {
  legalName: string;
  address: string;
  kraPin: string | null;
  phone: string;
  email: string | null;
  /** M-Pesa Paybill (business number) — or a Till number (Buy Goods) when paybill is null. */
  mpesaPaybill: string | null;
  mpesaTill: string | null;
  /** What the client types as the account number on a Paybill: the invoice number unless set. */
  accountRef: 'invoice' | 'business';
  /** Shown on the invoice while the details are placeholders. */
  sample?: boolean;
}

/** Placeholders until ZapTill enters its own in the admin portal (A612 phase 3). */
export const SAMPLE_SELLER: InvoiceSeller = {
  legalName: 'ZapTill Limited', address: 'P.O. Box 00000-00100, Nairobi, Kenya', kraPin: 'P000000000X',
  phone: ZAPTILL_PHONE, email: null, mpesaPaybill: '000000', mpesaTill: null, accountRef: 'invoice', sample: true,
};

/** Owner, 2026-10-30: the items — "Cloud - dashboard and, backup, remote till management", "Analytics", "Attendance",
 *  "Themes" (A586: "POS", never "till", in what a client reads). Each listed in small type under its line. */
export const CLOUD_INCLUDES = ['Web dashboard', 'Backup', 'Remote POS management'];
export const PREMIUM_ITEMS: Record<string, string> = {
  Analytics: 'Sales insights, best sellers, items bought together',
  Attendance: 'Fingerprint device, worked-hours report',
  Themes: 'Brand colours and logo on the dashboard and the POS',
};

/** The Premium package (owner, 2026-10-30): the Cloud and every premium item, one price a branch. */
export const PACKAGE_ITEM = 'Premium package';
export const PACKAGE_INCLUDES = ['Cloud', 'Analytics', 'Attendance', 'Themes'];

/** One branch on the invoice: its cloud price for the period and its premium features (A612 phase 4), each priced — or the
 *  Premium package (its price in place of the cloud and the items). `period` set: the branch's own plan length, when the
 *  invoice's branches differ (its items then say so). */
export interface BranchBill { branch: string; cloud: number; premium?: Array<{ name: string; price: number }>; package?: number | null; period?: PlanPeriod | null }
export interface BranchInvoiceFacts {
  invoiceNumber: string;
  issuedAt: string;
  currency: string;
  business: { name: string; ownerName: string | null; phone: string | null; email: string | null; code?: string | null };
  /** The period this invoice covers — once, in the header (the branches due together share it). */
  periodStart: string;
  periodEnd: string | null;
  period: PlanPeriod;
  branches: BranchBill[];
  seller: InvoiceSeller;
}
/** A billed item: what, how many (branches), the unit price, the amount. */
export interface InvoiceItem { description: string; detail: string | null; qty: number; unitPrice: number; amount: number }

/**
 * Owner, 2026-10-30: "do we really need a column for period … we itemize the items being billed, give unit price and under
 * note we add list of branches". The items: the cloud (one per branch), then each premium feature (one per branch that has
 * it) — the same item at another price is its own line. Pure.
 */
export function invoiceItems(branches: readonly BranchBill[]): InvoiceItem[] {
  const out: InvoiceItem[] = [];
  const add = (description: string, detail: string | null, unitPrice: number) => {
    const hit = out.find((i) => i.description === description && i.unitPrice === unitPrice);
    if (hit) { hit.qty++; hit.amount += unitPrice; return; }
    out.push({ description, detail, qty: 1, unitPrice, amount: unitPrice });
  };
  const lengths = new Set(branches.map((b) => b.period ?? null));
  const tag = (b: BranchBill, d: string) => (lengths.size > 1 && b.period ? `${d} (${b.period === 'custom' ? 'agreed period' : PERIOD_LABEL[b.period]})` : d);
  for (const b of branches) if (b.package != null) add(tag(b, PACKAGE_ITEM), PACKAGE_INCLUDES.join(' · '), Number(b.package || 0));
  for (const b of branches) if (b.package == null) add(tag(b, 'Cloud'), CLOUD_INCLUDES.join(' · '), Number(b.cloud || 0));
  for (const b of branches) if (b.package == null) for (const p of b.premium ?? []) add(tag(b, p.name), PREMIUM_ITEMS[p.name] ?? null, Number(p.price || 0));
  return out;
}

const kes = (currency: string, n: number) => `${esc(currency)} ${whole(n)}`;

/** The client's invoice: one per business, to its owner — items, unit prices, and the branches in the note. */
export function branchInvoiceEmailHtml(f: BranchInvoiceFacts): { subject: string; html: string; total: number; items: InvoiceItem[] } {
  const items = invoiceItems(f.branches);
  const total = items.reduce((t, i) => t + i.amount, 0);
  const s = f.seller;
  const account = s.accountRef === 'business' && f.business.code ? f.business.code : f.invoiceNumber;
  const pay = s.mpesaPaybill
    ? `<b>M-Pesa Paybill</b> ${esc(s.mpesaPaybill)} &nbsp;·&nbsp; <b>Account</b> ${esc(account)}`
    : s.mpesaTill ? `<b>M-Pesa Buy Goods Till number</b> ${esc(s.mpesaTill)}` : `Call or WhatsApp ${esc(s.phone)}`;
  const span = f.periodEnd ? `${planDate(f.periodStart)} – ${planDate(f.periodEnd)}` : `from ${planDate(f.periodStart)}`;
  const planName = f.period === 'custom' ? 'Agreed period' : PERIOD_LABEL[f.period];
  // Branches on different plan lengths: the period starts together, each item says its own length.
  const mixed = new Set(f.branches.map((b) => b.period ?? f.period)).size > 1;
  const periodLine = mixed ? `from <b style="color:#0f172a;">${esc(planDate(f.periodStart))}</b>` : `<b style="color:#0f172a;">${esc(span)}</b> (${esc(planName)})`;
  const th = 'padding:10px 12px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#64748b;border-bottom:1px solid #e2e8f0;';
  const td = 'padding:12px;font-size:13px;color:#0f172a;border-bottom:1px solid #f1f5f9;vertical-align:top;';
  const num = 'text-align:right;white-space:nowrap;';
  const rows = items.map((i) => `<tr>
      <td style="${td}"><div style="font-weight:600;">${esc(i.description)}</div>${i.detail ? `<div style="font-size:11px;color:#64748b;margin-top:2px;">${esc(i.detail)}</div>` : ''}</td>
      <td style="${td}text-align:center;">${i.qty}</td>
      <td style="${td}${num}">${kes(f.currency, i.unitPrice)}</td>
      <td style="${td}${num}font-weight:600;">${kes(f.currency, i.amount)}</td></tr>`).join('');
  const branchNote = f.branches.map((b) => `<b>${esc(b.branch)}</b> — ${b.package != null ? PACKAGE_ITEM
    : `Cloud${(b.premium ?? []).map((p) => `, ${esc(p.name)}`).join('')}`}`).join('<br>');
  const who = [f.business.ownerName, f.business.phone, f.business.email].filter(Boolean).map((x) => esc(x)).join('<br>');
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Invoice ${esc(f.invoiceNumber)}</title></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#0f172a;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:32px 16px;"><tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;background:#ffffff;border:1px solid #e2e8f0;border-radius:14px;overflow:hidden;">
  ${s.sample ? `<tr><td style="background:#fef3c7;color:#92400e;font-size:12px;padding:8px 24px;">Sample details — ZapTill's company and payment details are set in the admin portal.</td></tr>` : ''}
  <tr><td style="padding:28px 28px 8px;">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="vertical-align:top;"><div style="font-size:22px;font-weight:800;color:#16a34a;">ZapTill</div>
        <div style="font-size:12px;color:#64748b;line-height:1.6;margin-top:4px;">${esc(s.legalName)}<br>${esc(s.address)}${s.kraPin ? `<br>KRA PIN ${esc(s.kraPin)}` : ''}<br>${esc(s.phone)}${s.email ? ` · ${esc(s.email)}` : ''}</div></td>
      <td style="vertical-align:top;text-align:right;"><div style="font-size:24px;font-weight:800;letter-spacing:.04em;">INVOICE</div>
        <div style="font-size:12px;color:#64748b;line-height:1.7;margin-top:4px;">No. <b style="color:#0f172a;">${esc(f.invoiceNumber)}</b><br>Issued ${esc(planDate(f.issuedAt))}<br>Period ${periodLine}<br>Due on receipt</div></td>
    </tr></table></td></tr>
  <tr><td style="padding:16px 28px 4px;">
    <div style="font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#64748b;">Billed to</div>
    <div style="font-size:15px;font-weight:700;margin-top:4px;">${esc(f.business.name)}</div>
    ${who ? `<div style="font-size:13px;color:#334155;line-height:1.6;">${who}</div>` : ''}</td></tr>
  <tr><td style="padding:20px 16px 0;">
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr><th style="${th}text-align:left;">Item</th><th style="${th}text-align:center;">Qty</th><th style="${th}text-align:right;">Unit price</th><th style="${th}text-align:right;">Amount</th></tr>
      ${rows}
      <tr><td colspan="3" style="padding:14px 12px;font-size:14px;font-weight:700;text-align:right;">Total</td>
          <td style="padding:14px 12px;font-size:16px;font-weight:800;${num}">${kes(f.currency, total)}</td></tr>
    </table></td></tr>
  <tr><td style="padding:8px 28px 0;">
    <div style="font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#64748b;">Note — branches billed (quantities are branches)</div>
    <div style="font-size:12px;color:#475569;line-height:1.7;margin-top:4px;">${branchNote}</div></td></tr>
  <tr><td style="padding:20px 28px;">
    <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:14px 16px;">
      <div style="font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#15803d;font-weight:700;">How to pay</div>
      <div style="font-size:14px;margin-top:6px;">${pay}</div>
      <div style="font-size:12px;color:#475569;margin-top:6px;">Then WhatsApp or call ${esc(s.phone)} — we confirm and send your receipt. You may also pay ahead for 3, 6 or 12 months.</div>
    </div></td></tr>
  <tr><td style="padding:0 28px 26px;font-size:12px;color:#94a3b8;">Thank you for using ZapTill.</td></tr>
</table></td></tr></table></body></html>`;
  return { subject: subjectSafe(`ZapTill invoice ${f.invoiceNumber} — ${f.business.name} — ${f.currency} ${whole(total)}`), html, total, items };
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
