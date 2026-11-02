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
 *      the business email) — never a word of a lock — and ZapTill's copy (A589: the admin portal's bell).
 *   3. ZAPTILL ONLY: the 5th unpaid day ("locks in 2 days"), the lock (once — the morning digest lists locked clients
 *      after: jobs/watchdog.ts).
 * A589 (owner, 2026-10-25: "also invoices let it be the same" — not an email per client): ZapTill's copy of each notice
 * (the invoice issued, day 5, locked, trial ended, not interested) is a notification on the admin portal's bell
 * (public.admin_notifications, category 'billing', migration 174) — never an email each. ONE daily billing summary email
 * lists them in a table (client | invoice | amount | due | status) with the clients still unpaid or locked
 * (jobs/watchdog.ts sendBillingSummary). The client's own invoice email is unchanged.
 * A587 (owner, 2026-10-24 — "it's pay as you go, not pay for missed months"): a locked client gets no further invoices;
 * 3 months after its first unpaid due date it is "Not interested": its open cloud invoices are written off (audited
 * 'cloud_plan.not_interested'), still locked, and ZapTill hears once. A trial's end is its due day — an invoice like a
 * paid client's. The bridge keeps a licence that was already locked under the old ladder locked at once
 * (cloud_plans.billing_from = its own date) — no fresh 7 days and no arrears invoice.
 * Once each: the (business, due date, milestone) row is claimed in cloud_plan_reminders (unique) before anything is
 * sent; an invoice that could not be written gives the claim back for the next hour. No email provider (SendGrid is the
 * owner's pending action): logged and recorded, never a crash. A suspended business is skipped.
 *
 * A612 phase 3 (owner, 2026-10-30: the cloud billed per branch; "the owner should be the one who gets the invoice not
 * individual branch"): a business whose branches have their own plans (branch_cloud_plans, migration 182) is billed per
 * branch — each branch's ladder is its own (lib/cloudPlan.ts branchPause), and the branches with the same milestone on the
 * same day go together: ONE invoice to the owner for the branches due that day (items, unit prices, the branches in a note —
 * lib/cloudPlanEmail.ts branchInvoiceEmailHtml, ZapTill's details and prices from the admin portal, lib/branchBilling.ts),
 * one notice to ZapTill for the branches on their 5th unpaid day, locked, or not interested (only their invoices written
 * off). The claim is the same (business, date, milestone).
 */
import { meterJob } from '../lib/supabaseMeter';   // A591: this job's Supabase calls, counted
import cron from 'node-cron';
import { supabase } from '../lib/supabase';
import { sendEmailChecked } from '../lib/mailer';
import { addAdminNotifications } from '../lib/adminAlerts';           // A589: the admin portal's bell, not an email each
import { billingStatus } from '../lib/adminAlertPolicy';
import {
  cloudBusinessIds, readCloudFacts, cloudStanding, adminMilestones, reminderHour, invoicePeriod, inferBridgePeriod, defaultAmount,
  nextInvoiceNumber, insertCloudInvoice, forgetStanding, invoiceStarts, lockedUnderOldLadder, writeOffCloudInvoices, branchPause,
  WRITTEN_OFF, type CloudFactsRow, type AdminMilestone, type CloudStanding, type BranchPause, type BranchPlanRow,
} from '../lib/cloudPlan';
import { invoiceEmailHtml, adminNoticeText, branchInvoiceEmailHtml, invoiceItems, type BranchBill } from '../lib/cloudPlanEmail';
import { readBillingDetails, branchBill, periodMonths } from '../lib/branchBilling';   // A612

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function startCloudPlanRemindersJob(): void {
  const schedule = process.env.CLOUD_PLAN_REMINDERS_CRON ?? '40 * * * *';
  cron.schedule(schedule, meterJob('cloudPlanReminders', async () => {
    try { await runCloudBilling(new Date()); } catch (err: any) { console.error('[cloudPlan] billing pass failed:', err?.message); }
  }), { timezone: 'UTC' });
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
  sent: Array<{ business_id: string; milestone: AdminMilestone; owner: boolean; admin: boolean; invoice?: string | null; period_start?: string; branches?: string[] }>;
  skipped: number;
}

/** 1. The bridge: a plan row for a dated business that has none. Returns the row, or null (not written). */
async function bridge(businessId: string, f: CloudFactsRow, now: Date): Promise<CloudFactsRow['plan']> {
  const { data: last } = await supabase.from('invoices').select('period_start, period_end, created_at')
    .eq('business_id', businessId).order('created_at', { ascending: false }).limit(1).maybeSingle();
  const period = inferBridgePeriod(last as { period_start?: string | null; period_end?: string | null } | null);
  // A587 (owner: "Should already-locked clients get the 7 days? — no"): a licence already locked under the old ladder
  // stays locked — due from its own date (billing_from), invoiced for that overdue period.
  const keptLocked = lockedUnderOldLadder(f.expiresAt, now.getTime());
  const row: Record<string, unknown> = {
    business_id: businessId, period, amount: defaultAmount(period) ?? 0, currency: 'KES', custom_until: null,
    notes: `A584: put on the plan from the web-access licence (paid until ${String(f.expiresAt).slice(0, 10)})${keptLocked ? ' — already locked under the old rules, kept locked (A587)' : ''} — check the period and amount.`,
    updated_by: 'A584 bridge', created_at: now.toISOString(), updated_at: now.toISOString(),
    ...(keptLocked ? { billing_from: f.expiresAt } : {}),
  };
  let ins = await supabase.from('cloud_plans').insert(row).select().single();
  if (ins.error && keptLocked && /billing_from/.test(String(ins.error.message))) {
    // A cloud before migration 173: no billing_from — the A584 bridge (the 7 days from today).
    const { billing_from: _drop, ...older } = row;
    // business_id: the same row as above (row.business_id), only billing_from taken out.
    ins = await supabase.from('cloud_plans').insert(older).select().single();
  }
  if (ins.error) {
    if ((ins.error as { code?: string }).code !== '23505') console.warn(`[cloudPlan] bridge not written for ${businessId}:`, ins.error.message);
    return null;
  }
  const { error: aErr } = await supabase.from('admin_audit_log').insert({
    admin_id: null, admin_email: 'system (A584 bridge)', action: 'cloud_plan.bridge', resource: 'cloud_plan',
    business_id: businessId, business_name: f.name ?? null, before_data: { web_access_expires_at: f.expiresAt, plan: null },
    after_data: { period, amount: row.amount, billing_from: (ins.data as { billing_from?: string | null })?.billing_from ?? row.created_at, kept_locked: keptLocked && !!(ins.data as { billing_from?: string | null })?.billing_from },
    reason: keptLocked ? 'A licence already locked under the old rules — kept locked, invoiced for the overdue period (A587)' : 'A licence expiry set before the plan — governed by the same rules (A584)',
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
      // A612: billed per branch — each branch's own ladder, the branches due together on one invoice.
      const pause = branchPause(f, t);
      if (pause) { await branchBilling(businessId, f, pause, now, out); continue; }
      let s = cloudStanding(f, t);
      if (s.bridgePending) {
        const plan = await bridge(businessId, f, now);
        if (!plan) { out.skipped++; continue; }
        f.onPlan = true; f.plan = plan; f.planCreatedAt = plan.created_at ?? now.toISOString(); f.billingFrom = plan.billing_from ?? null;
        out.bridged.push(businessId);
        s = cloudStanding(f, t);
      }
      const due = s.dueAt;
      const milestones = adminMilestones(s, t);
      if (!milestones.length || !due) { out.skipped++; continue; }
      for (const milestone of milestones) {
        // A587: 'invoice' is the due date's period (never while locked — pay as you go).
        const keys = milestone === 'invoice' ? invoiceStarts(s, f.plan, t) : [due];
        for (const key of keys) await sendOne(businessId, f, s, milestone, key, now, out);
      }
    } catch (e: any) {
      console.error(`[cloudPlan] billing failed for ${businessId}:`, e?.message ?? e);
    }
  }
  return out;
}

/** One notice, once per (business, period start / due date, milestone) — the claim first. */
async function sendOne(businessId: string, f: CloudFactsRow, s: CloudStanding, milestone: AdminMilestone, key: string, now: Date, out: BillingRun): Promise<void> {
  // The claim: once per (business, due date, milestone) — asked first, and the unique key settles a race.
  const seen = await supabase.from('cloud_plan_reminders').select('id')
    .eq('business_id', businessId).eq('paid_until', key).eq('milestone', milestone).maybeSingle();
  if (seen.error || seen.data) return;
  const claim = await supabase.from('cloud_plan_reminders')
    .insert({ business_id: businessId, paid_until: key, milestone, sent_at: now.toISOString() }).select('id').single();
  if (claim.error) {
    if ((claim.error as { code?: string }).code !== '23505') console.warn(`[cloudPlan] ${milestone} not claimed for ${businessId}:`, claim.error.message);
    return;
  }
  const claimId = (claim.data as { id: string }).id;
  const ip = invoicePeriod(f.plan, key);
  const ownerEmail = await ownerEmailOf(f.ownerId, f.email);
  const errors: string[] = [];
  let invoiceNumber: string | null = null;
  let ownerSent = false;
  let writtenOff: string[] = [];

  if (milestone === 'invoice') {
    // 2. the invoice — one per business and period (a payment recorded early may already have raised it).
    const have = await supabase.from('invoices').select('id, invoice_number, status')
      .eq('business_id', businessId).eq('period_start', key).limit(1).maybeSingle();
    if (have.error) { await supabase.from('cloud_plan_reminders').delete().eq('id', claimId); return; }
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
        return;
      }
      invoiceNumber = inv.data.invoice_number ?? number;
    }
    const paidAlready = (have.data as { status?: string } | null)?.status === 'paid';
    if (!paidAlready) {
      if (ownerEmail) {
        const mail = invoiceEmailHtml({ businessName: f.name ?? 'your business', invoiceNumber: invoiceNumber ?? '', periodStart: ip.start, periodEnd: ip.end,
          amount: ip.amount, currency: f.plan?.currency ?? 'KES', period: ip.period, trialEnded: s.trial && key === s.dueAt ? s.dueAt : null });
        try {
          const r = await sendEmailChecked({ to: ownerEmail, subject: mail.subject, html: mail.html });
          ownerSent = r.ok;
          if (!r.ok) errors.push(`owner: ${r.error ?? `not sent (${r.provider})`}`);
        } catch (e: any) { errors.push(`owner: ${e?.message ?? e}`); }
      } else errors.push('owner: no email on file');
    }
  }

  if (milestone === 'not_interested') {
    // A587: "if they fail to pay for 3 months we assume they are not interested" — the open cloud invoices closed, audited.
    const w = await writeOffCloudInvoices(businessId);
    if (w.error) {
      console.warn(`[cloudPlan] invoices not written off for ${businessId} — tried again next hour:`, w.error);
      await supabase.from('cloud_plan_reminders').delete().eq('id', claimId);
      return;
    }
    writtenOff = w.numbers;
    const { error: aErr } = await supabase.from('admin_audit_log').insert({
      admin_id: null, admin_email: 'system (A587 billing)', action: 'cloud_plan.not_interested', resource: 'cloud_plan',
      business_id: businessId, business_name: f.name ?? null,
      before_data: { state: 'locked', due_at: s.dueAt, open_invoices: w.numbers },
      after_data: { state: 'not_interested', since: s.notInterestedAt, written_off: w.numbers, invoice_status: w.status },
      reason: 'Unpaid 3 months after the first unpaid due date — taken as not interested (A587); a payment starts afresh',
    });
    if (aErr) console.error('[cloudPlan] not-interested audit not written:', aErr.message);
    forgetStanding(businessId);
  }

  // 3. ZapTill's copy / notice — A589: the admin portal's bell (and the daily billing summary email), not an email each.
  let adminSent = false;
  try {
    const dueAt = milestone === 'invoice' ? key : s.dueAt;
    const a = adminNoticeText({
      businessName: f.name ?? 'a client', milestone, dueAt, lockAt: s.lockAt, unpaidDays: s.unpaidDays, lockInDays: s.lockInDays,
      amount: ip.amount, currency: f.plan?.currency ?? 'KES', period: ip.period, invoiceNumber, ownerEmail, ownerSent,
      trial: s.trial, notInterestedAt: s.notInterestedAt, writtenOff,
    });
    adminSent = await addAdminNotifications([{
      category: 'billing', business_id: businessId, alert_key: `billing:${milestone}:${businessId}:${key}`, title: a.subject, detail: a.text,
      data: {
        milestone, client: f.name ?? 'a client', invoice: invoiceNumber, amount: ip.amount, currency: f.plan?.currency ?? 'KES', due: dueAt,
        status: billingStatus(milestone, { unpaidDays: s.unpaidDays, lockInDays: s.lockInDays, ownerSent: milestone === 'invoice' ? ownerSent : null, trial: s.trial }),
        owner_email: ownerEmail, owner_sent: milestone === 'invoice' ? ownerSent : null, written_off: writtenOff,
      },
    }], now);
    if (!adminSent) errors.push('ZapTill: the admin portal notification was not stored (migration 174?)');
  } catch (e: any) { errors.push(`ZapTill: ${e?.message ?? e}`); }
  if (errors.length) console.warn(`[cloudPlan] ${f.name} ${milestone}: ${errors.join('; ')}`);
  await supabase.from('cloud_plan_reminders').update({
    owner_email: milestone === 'invoice' ? ownerEmail : null, owner_sent: ownerSent, admin_sent: adminSent,
    error: errors.length ? errors.join('; ').slice(0, 500) : null,
  }).eq('id', claimId);
  out.sent.push({ business_id: businessId, milestone, owner: ownerSent, admin: adminSent, ...(milestone === 'invoice' ? { invoice: invoiceNumber, period_start: key } : {}) });
}

// ── A612 phase 3: billed per branch ─────────────────────────────────────────────────────────────────────────────────
interface BranchGroup { milestone: AdminMilestone; key: string; branches: string[] }

/** The branches' milestones today, grouped by (milestone, date) — one claim, one invoice or notice each. Pure. */
export function branchGroups(f: Pick<CloudFactsRow, 'branchPlans'>, pause: BranchPause, t: number): BranchGroup[] {
  const groups = new Map<string, BranchGroup>();
  for (const row of f.branchPlans ?? []) {
    const id = String(row.branch_id);
    const s = pause.standings.get(id);
    if (!s) continue;   // a branch no longer the business's
    for (const milestone of adminMilestones(s, t)) {
      const keys = milestone === 'invoice' ? invoiceStarts(s, row, t) : s.dueAt ? [s.dueAt] : [];
      for (const key of keys) {
        const k = `${milestone}|${key}`;
        const g = groups.get(k) ?? { milestone, key, branches: [] };
        g.branches.push(id);
        groups.set(k, g);
      }
    }
  }
  return [...groups.values()];
}

async function branchBilling(businessId: string, f: CloudFactsRow, pause: BranchPause, now: Date, out: BillingRun): Promise<void> {
  const groups = branchGroups(f, pause, now.getTime());
  if (!groups.length) { out.skipped++; return; }
  const { data: brs } = await supabase.from('branches').select('id, name').eq('business_id', businessId);
  const names = new Map(((brs ?? []) as Array<{ id: string; name: string | null }>).map((b) => [String(b.id), b.name ?? 'Branch']));
  for (const g of groups) await sendBranchGroup(businessId, f, pause, names, g, now, out);
}

/** One group's invoice or notice, once per (business, date, milestone) — the claim first, as sendOne. */
async function sendBranchGroup(businessId: string, f: CloudFactsRow, pause: BranchPause, names: Map<string, string>, g: BranchGroup,
  now: Date, out: BillingRun): Promise<void> {
  const { milestone, key } = g;
  const seen = await supabase.from('cloud_plan_reminders').select('id')
    .eq('business_id', businessId).eq('paid_until', key).eq('milestone', milestone).maybeSingle();
  if (seen.error || seen.data) return;
  const claim = await supabase.from('cloud_plan_reminders')
    .insert({ business_id: businessId, paid_until: key, milestone, sent_at: now.toISOString() }).select('id').single();
  if (claim.error) {
    if ((claim.error as { code?: string }).code !== '23505') console.warn(`[cloudPlan] ${milestone} not claimed for ${businessId}:`, claim.error.message);
    return;
  }
  const claimId = (claim.data as { id: string }).id;
  const rowBy = new Map((f.branchPlans ?? []).map((r) => [String(r.branch_id), r]));
  const rows = g.branches.map((id) => rowBy.get(id)).filter((r): r is BranchPlanRow => !!r);
  const branchNames = g.branches.map((id) => names.get(id) ?? 'Branch');
  const first = pause.standings.get(g.branches[0])!;
  const currency = rows[0]?.currency ?? 'KES';
  const ownerEmail = await ownerEmailOf(f.ownerId, f.email);
  const errors: string[] = [];
  let invoiceNumber: string | null = null;
  let ownerSent = false;
  let writtenOff: string[] = [];
  let amount = rows.reduce((t, r) => t + Number(r.amount ?? 0), 0);
  const giveBack = async () => { await supabase.from('cloud_plan_reminders').delete().eq('id', claimId); };

  if (milestone === 'invoice') {
    const details = await readBillingDetails(now.getTime());
    const periods = rows.map((r) => invoicePeriod(r, key));
    const bills: BranchBill[] = rows.map((r, i) => branchBill(r, branchNames[i], details.prices, periodMonths(r.period, key, periods[i].end)));
    const items = invoiceItems(bills);
    amount = items.reduce((t, i) => t + i.amount, 0);
    const ends = periods.map((p) => p.end).filter((e): e is string => !!e).sort();
    const periodEnd = ends.length ? ends[ends.length - 1] : null;
    const have = await supabase.from('invoices').select('id, invoice_number, status')
      .eq('business_id', businessId).eq('period_start', key).limit(1).maybeSingle();
    if (have.error) { await giveBack(); return; }
    if (have.data) invoiceNumber = (have.data as { invoice_number: string }).invoice_number;
    else {
      const number = await nextInvoiceNumber();
      const inv = await insertCloudInvoice({
        business_id: businessId, invoice_number: number, amount, currency, status: 'pending', period_start: key, period_end: periodEnd,
        branch_ids: g.branches,
        lines: { items, branches: g.branches.map((id, i) => ({ branch_id: id, name: branchNames[i], bill: bills[i] })) },
      });
      if (inv.error || !inv.data) {
        console.warn(`[cloudPlan] branch invoice not raised for ${businessId} — tried again next hour:`, inv.error?.message);
        await giveBack(); return;
      }
      invoiceNumber = inv.data.invoice_number ?? number;
    }
    if ((have.data as { status?: string } | null)?.status !== 'paid') {
      if (ownerEmail) {
        const mail = branchInvoiceEmailHtml({
          invoiceNumber: invoiceNumber ?? '', issuedAt: now.toISOString(), currency,
          business: { name: f.name ?? 'your business', ownerName: null, phone: null, email: ownerEmail },
          periodStart: key, periodEnd, period: rows[0]?.period ?? 'monthly', branches: bills, seller: details.seller,
        });
        try {
          const r = await sendEmailChecked({ to: ownerEmail, subject: mail.subject, html: mail.html });
          ownerSent = r.ok;
          if (!r.ok) errors.push(`owner: ${r.error ?? `not sent (${r.provider})`}`);
        } catch (e: any) { errors.push(`owner: ${e?.message ?? e}`); }
      } else errors.push('owner: no email on file');
    }
  }

  if (milestone === 'not_interested') {
    // A587, per branch: only the open invoices of these branches alone are closed (another branch's stay owed).
    const { data: open, error: oErr } = await supabase.from('invoices').select('id, branch_ids')
      .eq('business_id', businessId).eq('kind', 'cloud').eq('status', 'pending');
    if (oErr) { await giveBack(); return; }
    const mine = ((open ?? []) as Array<{ id: string; branch_ids: string[] | null }>)
      .filter((i) => (i.branch_ids ?? []).length && (i.branch_ids ?? []).every((b) => g.branches.includes(b))).map((i) => i.id);
    const w = mine.length ? await writeOffCloudInvoices(businessId, mine) : { numbers: [], status: WRITTEN_OFF, error: null };
    if (w.error) { await giveBack(); return; }
    writtenOff = w.numbers;
    const { error: aErr } = await supabase.from('admin_audit_log').insert({
      admin_id: null, admin_email: 'system (A612 billing)', action: 'cloud_plan.not_interested', resource: 'cloud_plan',
      business_id: businessId, business_name: f.name ?? null,
      before_data: { state: 'locked', due_at: key, branches: branchNames, open_invoices: w.numbers },
      after_data: { state: 'not_interested', branches: branchNames, written_off: w.numbers, invoice_status: w.status },
      reason: 'Branch unpaid 3 months after its first unpaid due date — taken as not interested (A587, per branch A612)',
    });
    if (aErr) console.error('[cloudPlan] not-interested audit not written:', aErr.message);
    forgetStanding(businessId);
  }

  let adminSent = false;
  try {
    const client = `${f.name ?? 'a client'} — ${branchNames.join(', ')}`;
    const a = adminNoticeText({
      businessName: client, milestone, dueAt: milestone === 'invoice' ? key : first.dueAt, lockAt: first.lockAt, unpaidDays: first.unpaidDays,
      lockInDays: first.lockInDays, amount, currency, period: rows[0]?.period ?? 'monthly', invoiceNumber, ownerEmail, ownerSent,
      trial: first.trial, notInterestedAt: first.notInterestedAt, writtenOff,
    });
    adminSent = await addAdminNotifications([{
      category: 'billing', business_id: businessId, alert_key: `billing:${milestone}:${businessId}:${key}`, title: a.subject, detail: a.text,
      data: {
        milestone, client, branches: branchNames, invoice: invoiceNumber, amount, currency, due: key,
        status: billingStatus(milestone, { unpaidDays: first.unpaidDays, lockInDays: first.lockInDays, ownerSent: milestone === 'invoice' ? ownerSent : null, trial: first.trial }),
        owner_email: ownerEmail, owner_sent: milestone === 'invoice' ? ownerSent : null, written_off: writtenOff,
      },
    }], now);
    if (!adminSent) errors.push('ZapTill: the admin portal notification was not stored (migration 174?)');
  } catch (e: any) { errors.push(`ZapTill: ${e?.message ?? e}`); }
  if (errors.length) console.warn(`[cloudPlan] ${f.name} ${milestone} (${branchNames.join(', ')}): ${errors.join('; ')}`);
  await supabase.from('cloud_plan_reminders').update({
    owner_email: milestone === 'invoice' ? ownerEmail : null, owner_sent: ownerSent, admin_sent: adminSent,
    error: errors.length ? errors.join('; ').slice(0, 500) : null,
  }).eq('id', claimId);
  out.sent.push({ business_id: businessId, milestone, owner: ownerSent, admin: adminSent, branches: g.branches,
    ...(milestone === 'invoice' ? { invoice: invoiceNumber, period_start: key } : {}) });
}

/** A581's name, kept for its callers and tests. */
export const runCloudPlanReminders = runCloudBilling;
