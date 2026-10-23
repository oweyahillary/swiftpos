/**
 * cloudPlanReminders.ts — A581: the cloud plan's reminders by email, to the client's owner AND to ZapTill.
 *
 * Owner, 2026-10-23: "always remind me on email about expiry and also the client". Hourly; between 07:00 and 20:00
 * Nairobi time a business on the plan (lib/cloudPlan.ts — a plan row or a cloud trial) whose paid-until is 14, 7, 3 or 1
 * day(s) away, is today, or has passed (every 7 days, at most 8) gets the milestone it is in — ONCE: the
 * (business, paid-until, milestone) row is claimed in cloud_plan_reminders before anything is sent (unique), so two
 * cloud instances or a re-run never send it twice, and a payment (a new paid-until) starts afresh.
 *
 *   owner:   the owner's sign-in email (else the business email) — HTML (lib/cloudPlanEmail.ts), lib/mailer.ts
 *   ZapTill: notifyAdmin (ADMIN_ALERT_EMAIL and Telegram when set — lib/alertNotify.ts)
 * No email provider set (SendGrid is the owner's pending action): logged and skipped, never a crash — the claim is kept
 * (a milestone is tried once; the admin portal's client list shows the expiry regardless).
 * A suspended business is skipped.
 */
import cron from 'node-cron';
import { supabase } from '../lib/supabase';
import { sendEmailChecked } from '../lib/mailer';
import { notifyAdmin } from '../lib/alertNotify';
import {
  gatedBusinessIds, readCloudFacts, cloudStanding, reminderMilestone, reminderHour, defaultAmount, CLOUD_MONTHLY_KES,
  type PlanPeriod,
} from '../lib/cloudPlan';
import { reminderEmailHtml, reminderAdminText, type ReminderFacts } from '../lib/cloudPlanEmail';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function startCloudPlanRemindersJob(): void {
  const schedule = process.env.CLOUD_PLAN_REMINDERS_CRON ?? '40 * * * *';
  cron.schedule(schedule, async () => {
    try { await runCloudPlanReminders(new Date()); } catch (err: any) { console.error('[cloudPlan] reminders failed:', err?.message); }
  }, { timezone: 'UTC' });
  console.log(`[cloudPlan] Scheduled: ${schedule} (cloud plan reminders to the owner and ZapTill)`);
}

async function ownerEmailOf(ownerId: string | null | undefined, fallback: string | null | undefined): Promise<string | null> {
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

export interface ReminderRun { sent: Array<{ business_id: string; milestone: string; owner: boolean; admin: boolean }>; skipped: number }

/** One pass. `force` ignores the daytime window (tests). */
export async function runCloudPlanReminders(now: Date = new Date(), opts: { force?: boolean } = {}): Promise<ReminderRun> {
  const out: ReminderRun = { sent: [], skipped: 0 };
  const t = now.getTime();
  if (!opts.force && !reminderHour(t)) return out;
  const ids = await gatedBusinessIds();
  if (!ids.length) return out;
  const facts = await readCloudFacts(ids);
  for (const [businessId, f] of facts) {
    try {
      if (f.suspended) { out.skipped++; continue; }
      const s = cloudStanding(f, t);
      if (!s.gated || s.daysLeft === null || !s.paidUntil) { out.skipped++; continue; }
      const milestone = reminderMilestone(s.daysLeft);
      if (!milestone) { out.skipped++; continue; }
      // The claim: once per (business, paid-until, milestone) — asked first, and the unique key settles a race.
      const seen = await supabase.from('cloud_plan_reminders').select('id')
        .eq('business_id', businessId).eq('paid_until', s.paidUntil).eq('milestone', milestone).maybeSingle();
      if (seen.error || seen.data) { out.skipped++; continue; }
      const claim = await supabase.from('cloud_plan_reminders')
        .insert({ business_id: businessId, paid_until: s.paidUntil, milestone, sent_at: now.toISOString() }).select('id').single();
      if (claim.error) {
        if ((claim.error as { code?: string }).code !== '23505') console.warn(`[cloudPlan] reminder not claimed for ${businessId}:`, claim.error.message);
        out.skipped++; continue;
      }
      const claimId = (claim.data as { id: string }).id;
      const period: PlanPeriod = f.plan?.period ?? 'monthly';
      const amount = Number(f.plan?.amount ?? defaultAmount(period) ?? CLOUD_MONTHLY_KES);
      const ownerEmail = await ownerEmailOf(f.ownerId, f.email);
      const rf: ReminderFacts = {
        businessName: f.name ?? 'your business', milestone, daysLeft: s.daysLeft, paidUntil: s.paidUntil, syncStopsAt: s.syncStopsAt,
        amount, currency: f.plan?.currency ?? 'KES', period, trial: s.trial || s.state === 'ended', syncStopped: s.syncRefused, ownerEmail,
      };
      const errors: string[] = [];
      let ownerSent = false;
      if (ownerEmail) {
        const mail = reminderEmailHtml(rf);
        try {
          const r = await sendEmailChecked({ to: ownerEmail, subject: mail.subject, html: mail.html });
          ownerSent = r.ok;
          if (!r.ok) errors.push(`owner: ${r.error ?? `not sent (${r.provider})`}`);
        } catch (e: any) { errors.push(`owner: ${e?.message ?? e}`); }
      } else errors.push('owner: no email on file');
      let adminSent = false;
      try {
        const a = reminderAdminText(rf);
        const r = await notifyAdmin(a.subject, a.text, { email: true });
        adminSent = r.email || r.telegram;
        if (!adminSent) errors.push('ZapTill: no alert channel worked (ADMIN_ALERT_EMAIL / Telegram)');
      } catch (e: any) { errors.push(`ZapTill: ${e?.message ?? e}`); }
      if (errors.length) console.warn(`[cloudPlan] ${f.name} ${milestone}: ${errors.join('; ')}`);
      await supabase.from('cloud_plan_reminders').update({
        owner_email: ownerEmail, owner_sent: ownerSent, admin_sent: adminSent, error: errors.length ? errors.join('; ').slice(0, 500) : null,
      }).eq('id', claimId);
      out.sent.push({ business_id: businessId, milestone, owner: ownerSent, admin: adminSent });
    } catch (e: any) {
      console.error(`[cloudPlan] reminder failed for ${businessId}:`, e?.message ?? e);
    }
  }
  return out;
}
