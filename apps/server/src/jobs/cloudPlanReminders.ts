/**
 * cloudPlanReminders.ts — the cloud billing job (A581; A584 rewrote it). Hourly; between 07:00 and 20:00 Nairobi.
 *
 * Owner, 2026-10-23 (A584): "an invoice is sent to the client on the first day of their billing" · "without informing them
 * when the access will be revoked" · "after 7 days the access gets revoked immediately, no warning for web" · reminders to
 * ZapTill only. Rules: lib/cloudPlan.ts and lib/billingClock.ts. Each pass:
 *
 *   1. THE BRIDGE. A business with a paid-until date and no plan row (a licence set before the plan — not a trial, not
 *      switched off) gets its plan row: the period from its last invoice (else 12 months — the old licence was yearly),
 *      KES 3,000 a month, a note to check both; audited ('cloud_plan.bridge'). The row's created_at is the day billing
 *      began, so a licence that had already run out is due today — an invoice, then the 7 days.
 *   2. THE INVOICE, on the due day (the first day of the new period; for a monthly plan, each month): an invoice (pending,
 *      kind 'cloud', the period and amount) raised ONCE per business and period, emailed to the owner (sign-in email, else
 *      the business email) — never a word of a lock — and ZapTill's copy (ADMIN_ALERT_EMAIL / Telegram).
 *   3. ZAPTILL ONLY: the 5th unpaid day ("locks in 2 days"), the lock (once — the morning digest lists locked clients
 *      after: jobs/watchdog.ts), a trial's end.
 * Once each: the (business, due date, milestone) row is claimed in cloud_plan_reminders (unique) before anything is
 * sent; an invoice that could not be written gives the claim back for the next hour. No email provider (SendGrid is the
 * owner's pending action): logged and recorded, never a crash. A suspended business is skipped.
 */
import cron from 'node-cron';
import { supabase } from '../lib/supabase';
import { sendEmailChecked } from '../lib/mailer';
import { notifyAdmin } from '../lib/alertNotify';
import {
  cloudBusinessIds, readCloudFacts, cloudStanding, adminMilestones, reminderHour, invoicePeriod, inferBridgePeriod, defaultAmount,
  nextInvoiceNumber, insertCloudInvoice, forgetStanding, type CloudFactsRow, type AdminMilestone,
} from '../lib/cloudPlan';
import { invoiceEmailHtml, adminNoticeText } from '../lib/cloudPlanEmail';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function startCloudPlanRemindersJob(): void {
  const schedule = process.env.CLOUD_PLAN_REMINDERS_CRON ?? '40 * * * *';
  cron.schedule(schedule, async () => {
    try { await runCloudBilling(new Date()); } catch (err: any) { console.error('[cloudPlan] billing pass failed:', err?.message); }
  }, { timezone: 'UTC' });
  console.log(`[cloudPlan] Scheduled: ${schedule} (cloud billing: the bridge, invoices on the due day, ZapTill's notices)`);
}

export async function ownerEmailOf(ownerId: string | null | undefined, fallback: string | null | undefined): Promise<string | null> {
  if (ownerId && UUID_RE.test(ownerId)) {
    try {
      const { data, error } = await supabase.auth.admin.getUserById(ownerId);
      const e = !error ? data?.user?.email?.trim() : null;
      if (e) return e;
    } catch { /* the business email below */ }
  }
  const f = String(fallback ?? '').trim();
  return f.includes('@') ? f : null;
}

export interface BillingRun {
  bridged: string[];
  sent: Array<{ business_id: string; milestone: AdminMilestone; owner: boolean; admin: boolean; invoice?: string | null }>;
  skipped: number;
}

/** 1. The bridge: a plan row for a dated business that has none. Returns the row, or null (not written). */
async function bridge(businessId: string, f: CloudFactsRow, now: Date): Promise<CloudFactsRow['plan']> {
  const { data: last } = await supabase.from('invoices').select('period_start, period_end, created_at')
    .eq('business_id', businessId).order('created_at', { ascending: false }).limit(1).maybeSingle();
  const period = inferBridgePeriod(last as { period_start?: string | null; period_end?: string | null } | null);
  const row = {
    business_id: businessId, period, amount: defaultAmount(period) ?? 0, currency: 'KES', custom_until: null,
    notes: `A584: put on the plan from the web-access licence (paid until ${String(f.expiresAt).slice(0, 10)}) — check the period and amount.`,
    updated_by: 'A584 bridge', created_at: now.toISOString(), updated_at: now.toISOString(),
  };
  const ins = await supabase.from('cloud_plans').insert(row).select().single();
  if (ins.error) {
    if ((ins.error as { code?: string }).code !== '23505') console.warn(`[cloudPlan] bridge not written for ${businessId}:`, ins.error.message);
    return null;
  }
  const { error: aErr } = await supabase.from('admin_audit_log').insert({
    admin_id: null, admin_email: 'system (A584 bridge)', action: 'cloud_plan.bridge', resource: 'cloud_plan',
    business_id: businessId, business_name: f.name ?? null, before_data: { web_access_expires_at: f.expiresAt, plan: null },
    after_data: { period, amount: row.amount, billing_from: row.created_at }, reason: 'A licence expiry set before the plan — governed by the same rules (A584)',
  });
  if (aErr) console.error('[cloudPlan] bridge audit not written:', aErr.message);
  forgetStanding(businessId);
  return ins.data as CloudFactsRow['plan'];
}

/** One pass. `force` ignores the daytime window (tests). */
export async function runCloudBilling(now: Date = new Date(), opts: { force?: boolean } = {}): Promise<BillingRun> {
  const out: BillingRun = { bridged: [], sent: [], skipped: 0 };
  const t = now.getTime();
  if (!opts.force && !reminderHour(t)) return out;
  const ids = await cloudBusinessIds();
  if (!ids.length) return out;
  const facts = await readCloudFacts(ids);
  for (const [businessId, f] of facts) {
    try {
      if (f.suspended) { out.skipped++; continue; }
      let s = cloudStanding(f, t);
      if (s.bridgePending) {
        const plan = await bridge(businessId, f, now);
        if (!plan) { out.skipped++; continue; }
        f.onPlan = true; f.plan = plan; f.planCreatedAt = plan.created_at ?? now.toISOString();
        out.bridged.push(businessId);
        s = cloudStanding(f, t);
      }
      const due = s.dueAt;
      const milestones = adminMilestones(s, t);
      if (!milestones.length || !due) { out.skipped++; continue; }
      for (const milestone of milestones) {
        // The claim: once per (business, due date, milestone) — asked first, and the unique key settles a race.
        const seen = await supabase.from('cloud_plan_reminders').select('id')
          .eq('business_id', businessId).eq('paid_until', due).eq('milestone', milestone).maybeSingle();
        if (seen.error || seen.data) continue;
        const claim = await supabase.from('cloud_plan_reminders')
          .insert({ business_id: businessId, paid_until: due, milestone, sent_at: now.toISOString() }).select('id').single();
        if (claim.error) {
          if ((claim.error as { code?: string }).code !== '23505') console.warn(`[cloudPlan] ${milestone} not claimed for ${businessId}:`, claim.error.message);
          continue;
        }
        const claimId = (claim.data as { id: string }).id;
        const ip = invoicePeriod(f.plan, due);
        const ownerEmail = await ownerEmailOf(f.ownerId, f.email);
        const errors: string[] = [];
        let invoiceNumber: string | null = null;
        let ownerSent = false;

        if (milestone === 'invoice') {
          // 2. the invoice — one per business and period (a payment recorded early may already have raised it).
          const have = await supabase.from('invoices').select('id, invoice_number, status')
            .eq('business_id', businessId).eq('period_start', due).limit(1).maybeSingle();
          if (have.error) { await supabase.from('cloud_plan_reminders').delete().eq('id', claimId); continue; }
          if (have.data) invoiceNumber = (have.data as { invoice_number: string }).invoice_number;
          else {
            const number = await nextInvoiceNumber();
            const inv = await insertCloudInvoice({
              business_id: businessId, invoice_number: number, amount: ip.amount, currency: f.plan?.currency ?? 'KES', status: 'pending',
              period_start: ip.start, period_end: ip.end,
            });
            if (inv.error || !inv.data) {
              console.warn(`[cloudPlan] invoice not raised for ${businessId} — tried again next hour:`, inv.error?.message);
              await supabase.from('cloud_plan_reminders').delete().eq('id', claimId);
              continue;
            }
            invoiceNumber = inv.data.invoice_number ?? number;
          }
          const paidAlready = (have.data as { status?: string } | null)?.status === 'paid';
          if (!paidAlready) {
            if (ownerEmail) {
              const mail = invoiceEmailHtml({ businessName: f.name ?? 'your business', invoiceNumber: invoiceNumber ?? '', periodStart: ip.start, periodEnd: ip.end,
                amount: ip.amount, currency: f.plan?.currency ?? 'KES', period: ip.period });
              try {
                const r = await sendEmailChecked({ to: ownerEmail, subject: mail.subject, html: mail.html });
                ownerSent = r.ok;
                if (!r.ok) errors.push(`owner: ${r.error ?? `not sent (${r.provider})`}`);
              } catch (e: any) { errors.push(`owner: ${e?.message ?? e}`); }
            } else errors.push('owner: no email on file');
          }
        }

        // 3. ZapTill's copy / notice.
        let adminSent = false;
        try {
          const a = adminNoticeText({
            businessName: f.name ?? 'a client', milestone, dueAt: due, lockAt: s.lockAt, unpaidDays: s.unpaidDays, lockInDays: s.lockInDays,
            amount: ip.amount, currency: f.plan?.currency ?? 'KES', period: ip.period, invoiceNumber, ownerEmail, ownerSent,
          });
          const r = await notifyAdmin(a.subject, a.text, { email: true });
          adminSent = r.email || r.telegram;
          if (!adminSent) errors.push('ZapTill: no alert channel worked (ADMIN_ALERT_EMAIL / Telegram)');
        } catch (e: any) { errors.push(`ZapTill: ${e?.message ?? e}`); }
        if (errors.length) console.warn(`[cloudPlan] ${f.name} ${milestone}: ${errors.join('; ')}`);
        await supabase.from('cloud_plan_reminders').update({
          owner_email: milestone === 'invoice' ? ownerEmail : null, owner_sent: ownerSent, admin_sent: adminSent,
          error: errors.length ? errors.join('; ').slice(0, 500) : null,
        }).eq('id', claimId);
        out.sent.push({ business_id: businessId, milestone, owner: ownerSent, admin: adminSent, ...(milestone === 'invoice' ? { invoice: invoiceNumber } : {}) });
      }
    } catch (e: any) {
      console.error(`[cloudPlan] billing failed for ${businessId}:`, e?.message ?? e);
    }
  }
  return out;
}

/** A581's name, kept for its callers and tests. */
export const runCloudPlanReminders = runCloudBilling;
