/**
 * monthlyPack.ts (job) — A455: on the 1st of every month, each business that switched it on gets last month's pack by
 * email: one Excel workbook per branch (Summary, Expenses, Expenses by type, Cash / M-Pesa books, Movements), to the
 * same people as the daily report (the owner, branch managers, the scheduler's added addresses).
 *
 * Owner, 2026-10-12: "email and downloadable". Switched on in Reports › Monthly pack ("Email it on the 1st"), stored in
 * the report schedule (report_schedule.monthly_pack). Hourly; the decision is jobs/monthlyPackDecision.ts.
 */
import cron from 'node-cron';
import ExcelJS from 'exceljs';
// A478: formatInTimeZone CONVERTS to EAT; date-fns-tz's format(…, { timeZone }) only labels the machine's local time — on
// Render (UTC) the 21:00 / 09:00 / Monday 08:00 / 1st-07:00 sends ran three hours late. A Nairobi-time PC hid it.
import { formatInTimeZone } from 'date-fns-tz';
const tzFormat = (d: Date, fmt: string, o: { timeZone: string }) => formatInTimeZone(d, o.timeZone, fmt);
import { supabase } from '../lib/supabase';
import { sendEmail, type MailAttachment } from '../lib/mailer';
import { loadPack } from '../lib/monthlyPackData';
import { writePackWorkbook, type Pack } from '../lib/monthlyPack';
import { readReportSchedule, gatherRecipients } from './dailySummary';
import { decideMonthlySend } from './monthlyPackDecision';

const EAT = 'Africa/Nairobi';
const LAST_SENT_KEY = 'monthly_pack_last_sent';

export function startMonthlyPackJob(): void {
  const schedule = process.env.MONTHLY_PACK_CRON ?? '23 * * * *';
  cron.schedule(schedule, async () => {
    try { await runMonthlyPack(); } catch (err: any) { console.error('[monthlyPack] Job failed:', err?.message); }
  }, { timezone: 'UTC' });
  console.log(`[monthlyPack] Scheduled: ${schedule} (sends on the 1st, from 07:00 EAT)`);
}

async function readLastSent(businessId: string): Promise<string | null> {
  const { data } = await supabase.from('business_settings').select('value')
    .eq('business_id', businessId).eq('key', LAST_SENT_KEY).maybeSingle();
  return data?.value ? String(data.value).replace(/"/g, '') : null;
}
async function writeLastSent(businessId: string, month: string): Promise<void> {
  const { data: existing } = await supabase.from('business_settings').select('id')
    .eq('business_id', businessId).eq('key', LAST_SENT_KEY).maybeSingle();
  if (existing) await supabase.from('business_settings').update({ value: month, updated_at: new Date().toISOString() }).eq('id', existing.id);
  else await supabase.from('business_settings').insert({ business_id: businessId, key: LAST_SENT_KEY, value: month });
}

const fmt = (n: number) => Number(n || 0).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The email body: one line per branch — the month's sales, what the managers counted, the variance, the expenses. */
export function monthlyPackHtml(businessName: string, month: string, currency: string, packs: { branch: string; pack: Pack }[]): string {
  const rows = packs.map(({ branch, pack }) => `<tr>
    <td style="padding:6px 10px;border-bottom:1px solid #eee">${escHtml(branch)}</td>
    <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right">${fmt(pack.summary.total)}</td>
    <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right">${fmt(pack.summary.counted)}</td>
    <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;color:${pack.summary.variance < 0 ? '#c0392b' : '#333'}">${fmt(pack.summary.variance)}</td>
    <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right">${fmt(pack.expenses.total)}</td></tr>`).join('');
  return `<div style="font-family:Arial,sans-serif;color:#222">
  <h2 style="color:#1e3a5f;margin-bottom:4px">${escHtml(businessName)} — monthly pack, ${month}</h2>
  <p style="margin-top:0;color:#555">One Excel file per branch is attached: daily sales by payment method, expenses, the cash and M-Pesa books. Amounts in ${escHtml(currency)}.</p>
  <table style="border-collapse:collapse;font-size:14px">
    <tr style="background:#1e3a5f;color:#fff"><th style="padding:6px 10px;text-align:left">Branch</th><th style="padding:6px 10px">Sales</th><th style="padding:6px 10px">Counted</th><th style="padding:6px 10px">Variance</th><th style="padding:6px 10px">Expenses</th></tr>
    ${rows}
  </table>
  <p style="color:#777;font-size:12px">Sent by ZapTill on the 1st of the month. Turn it off in Reports › Monthly pack.</p></div>`;
}

async function runMonthlyPack(): Promise<void> {
  const now = new Date();
  const nowEatDate = tzFormat(now, 'yyyy-MM-dd', { timeZone: EAT });
  const nowEatHour = Number(tzFormat(now, 'H', { timeZone: EAT }));
  if (nowEatDate.slice(8, 10) !== '01') return;   // cheap exit on every other day

  const { data: businesses } = await supabase.from('businesses').select('id, name, owner_id, currency');
  for (const biz of businesses ?? []) {
    try {
      const schedule = await readReportSchedule(biz.id) as { monthly_pack?: boolean; recipients?: string[] };
      const month = decideMonthlySend(schedule.monthly_pack === true, nowEatDate, nowEatHour, await readLastSent(biz.id));
      if (!month) continue;
      const recipients = await gatherRecipients(biz as any, schedule);
      if (!recipients.length) { console.warn(`[monthlyPack] ${biz.name}: switched on but no recipients — skipping.`); continue; }
      const { data: branches } = await supabase.from('branches').select('id, name, status').eq('business_id', biz.id);
      const packs: { branch: string; pack: Pack }[] = [];
      const attachments: MailAttachment[] = [];
      for (const br of (branches ?? []).filter((b: any) => b.status !== 'inactive' && b.status !== 'deleted')) {
        const pack = await loadPack(biz.id, br.id, month);
        packs.push({ branch: br.name, pack });
        const wb = new ExcelJS.Workbook();
        wb.creator = 'ZapTill';
        writePackWorkbook(wb, pack, biz.currency ?? 'KES');
        const buf = Buffer.from(await wb.xlsx.writeBuffer());
        attachments.push({
          filename: `${String(br.name).replace(/[^A-Za-z0-9]+/g, '-')}-${month}.xlsx`, content: buf,
          contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        });
      }
      if (!packs.length) continue;
      await sendEmail({
        to: recipients.join(', '),
        subject: `${biz.name} — monthly pack ${month}`,
        html: monthlyPackHtml(biz.name, month, biz.currency ?? 'KES', packs),
        attachments,
      });
      await writeLastSent(biz.id, month);   // after a successful send, so a failure retries next hour
      console.log(`[monthlyPack] Sent ${month} for ${biz.name} → ${recipients.length} recipient(s), ${packs.length} branch(es)`);
    } catch (err: any) {
      console.error(`[monthlyPack] Failed for ${biz.name} (${biz.id}):`, err?.message);
    }
  }
}
