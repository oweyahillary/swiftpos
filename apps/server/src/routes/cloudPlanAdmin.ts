/**
 * cloudPlanAdmin.ts — A581: the client's cloud payment plan in the admin portal (client › Plan & billing › Cloud plan).
 * A584: the ONE way web access is turned on — a recorded payment, or a super admin's complimentary paid-until (audited).
 *
 * Owner, 2026-10-23: "add payment plan option such that i can select month on month" (A581) · "build a robust structure"
 * and "an invoice is sent to the client on the first day of their billing" (A584). Rules in lib/cloudPlan.ts; the
 * paid-until is businesses.web_access_expires_at.
 *
 *   GET  /api/admin/clients/:businessId/cloud-plan           — the plan (or the defaults), where the client stands (due,
 *        unpaid days, lock), the payments (newest first), the invoices and ZapTill's notices sent. Any admin.
 *   PUT  /api/admin/clients/:businessId/cloud-plan           — { period, amount, custom_until?, notes? }: sets the plan.
 *        Super admin.
 *   POST /api/admin/clients/:businessId/cloud-plan/payments  — { amount, method, reference, paid_at?, period?,
 *        paid_until? (custom), note? }: records a payment — paid-until moves on one period from: the current paid-until
 *        when still ahead (early: no lost days); the due date when the client is within its 7 unpaid days (the invoiced
 *        period); else today (locked, first payment, a trial). Web access on; a trial converted; the period's pending
 *        invoice marked paid (else a paid invoice raised); a short receipt to the owner; audited ('cloud_plan.payment').
 *        Everything opens at once. Super admin (a money write).
 *        A587 (owner, 2026-10-24: "it's pay as you go, not pay for missed months, since they won't be using the system at
 *        that time"): a LOCKED (or "Not interested") client starts a fresh period from the payment day, and the open cloud
 *        invoice(s) of the locked time are closed — written off, not charged (audited in 'cloud_plan.payment'). Within the
 *        7 unpaid days the payment continues from the due date and pays that invoice (A584). A client switched off pays
 *        like any other (and is switched on).
 *   POST /api/admin/clients/:businessId/cloud-plan/payments/preview — { period, paid_until? }: A587 — what that payment
 *        would cover (no write): the new period, the invoice it pays, or the invoices it closes unpaid. The Record payment
 *        form shows it ("Starts a new period: 24 Oct – 24 Nov. INV-… (not used while paused) is closed, not charged."). Any admin.
 *   POST /api/admin/clients/:businessId/cloud-plan/complimentary — { paid_until, reason }: A584 — a manual paid-until for
 *        a special case (no payment, no invoice): web access on, the client put on the plan, a trial converted; the reason
 *        required; audited ('cloud_plan.complimentary'). Super admin.
 *
 * A612 phase 3 — the cloud billed per branch (docs/A612-per-branch-cloud.md). A client whose branches have their own plans
 * (branch_cloud_plans) is billed per branch; GET adds the branches (each its plan, premium, package and where it stands):
 *   PUT  …/cloud-plan/branches/:branchId     — { period, amount, custom_until?, web_off?, premium?, package?, notes? }: a
 *        branch's plan; web_off is "Disable" for that branch alone. Super admin, audited ('cloud_plan.branch').
 *   POST …/cloud-plan/branches/start         — every branch without a plan gets the business's (its period, amount and
 *        paid-until): the client billed per branch from now. Super admin, audited ('cloud_plan.branches_start').
 *   POST …/cloud-plan/branch-payments/preview — { branch_ids }: what a payment would cover per branch (no write). Any admin.
 *   POST …/cloud-plan/branch-payments        — { branch_ids, amount, method, reference, paid_at?, note? }: each branch named
 *        moves on one of ITS periods by the same rules as the business's (early: no lost days; within its 7 unpaid days:
 *        from its due date; locked or "Not interested": afresh from today, its locked time's invoices closed unpaid); the
 *        open invoice(s) of exactly those branches marked paid (else a paid one raised, itemised); the business's
 *        paid-until the latest of its branches' (sign-in stays open while one is paid); receipt, audit. Super admin.
 *
 * Payment DETECTION is manual for now (M-Pesa Daraja later) — nothing here takes money.
 *
 * Mounted at /admin/clients before /admin (routes/index.ts): a path this router does not serve falls through.
 */
import { safeRouter } from '../middleware/asyncHandler';
import { requireAdmin, requireSuperAdmin } from '../middleware/adminAuth';
import { supabase } from '../lib/supabase';
import { sendError } from '../lib/sendError';
import { sendEmailChecked } from '../lib/mailer';
import { CLOUD_TRIAL_KEY, readTrial } from '../lib/cloudTrial';
import {
  CLOUD_MONTHLY_KES, PERIOD_LABEL, PLAN_PERIODS, PAYMENT_METHODS, isPeriod, defaultAmount, nextPaidUntil, cloudStanding,
  readCloudFacts, forgetStanding, nextInvoiceNumber, insertCloudInvoice, standingView, openCloudInvoices, paymentCovers,
  writeOffCloudInvoices, branchFactsFor, invoicePeriod, type PlanPeriod, type CloudPlanRow, type CloudFactsRow, type PaymentCover,
  type CloudStanding, type BranchPlanRow,
} from '../lib/cloudPlan';
import { receiptEmailHtml, invoiceItems, type BranchBill } from '../lib/cloudPlanEmail';
import { readBillingDetails, branchBill, periodMonths, premiumOf, isPremiumKey, PREMIUM_KEYS } from '../lib/branchBilling';   // A612
import { ownerEmailOf } from '../jobs/cloudPlanReminders';

const router = safeRouter();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MPESA_CODE = /^[A-Z0-9]{8,12}$/;
const AMOUNT_MAX = 10_000_000;

async function clientOf(req: any, res: any): Promise<{ id: string; name: string | null } | null> {
  const id = String(req.params.businessId ?? '');
  if (!UUID.test(id)) { res.status(400).json({ error: 'businessId must be an id' }); return null; }
  const { data, error } = await supabase.from('businesses').select('id, name').eq('id', id).maybeSingle();
  if (error) { sendError(res, error); return null; }
  if (!data) { res.status(404).json({ error: 'No such client' }); return null; }
  return data as { id: string; name: string | null };
}

async function audit(req: any, client: { id: string; name: string | null }, action: string, before: object | null, after: object, reason?: string | null): Promise<void> {
  const { error } = await supabase.from('admin_audit_log').insert({
    admin_id: req.adminId, admin_email: req.adminEmail, action, resource: 'cloud_plan',
    business_id: client.id, business_name: client.name, before_data: before, after_data: after, reason: reason ?? null, ip_address: req.ip ?? null,
  });
  if (error) console.error('[cloud-plan] admin audit not written:', error.message);
}

const money = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v.replace(/[, ]/g, '')) : Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
};
const text = (v: unknown, max: number): string | null => {
  const s = typeof v === 'string' ? v.trim().slice(0, max) : '';
  return s || null;
};
const isoOrNull = (v: unknown): string | null => (typeof v === 'string' && v && Number.isFinite(Date.parse(v)) ? new Date(Date.parse(v)).toISOString() : null);

/** Everything the Plan & billing card shows. */
async function planView(businessId: string) {
  const now = Date.now();
  const facts = (await readCloudFacts([businessId])).get(businessId);
  const [payments, reminders] = await Promise.all([
    supabase.from('cloud_payments').select('*').eq('business_id', businessId).order('recorded_at', { ascending: false }).limit(50),
    supabase.from('cloud_plan_reminders').select('milestone, paid_until, sent_at, owner_sent, admin_sent, error').eq('business_id', businessId).order('sent_at', { ascending: false }).limit(20),
  ]);
  const s = facts ? cloudStanding(facts, now) : null;
  const open = facts ? await openCloudInvoices(businessId) : [];
  // A612: the branches — each its own plan (or none: it follows the business), premium and where it stands.
  const rows = facts?.branchPlans ?? [];
  const rowBy = new Map(rows.map((r) => [String(r.branch_id), r]));
  const { data: brs } = await supabase.from('branches').select('id, name, is_main').eq('business_id', businessId).order('created_at', { ascending: true });
  const details = await readBillingDetails(now);
  const branches = ((brs ?? []) as Array<{ id: string; name: string | null; is_main?: boolean }>).map((b) => {
    const row = rowBy.get(String(b.id)) ?? null;
    const bs = row && facts ? cloudStanding(branchFactsFor(facts, row), now) : null;
    const months = row ? periodMonths(row.period, now ? new Date(now).toISOString() : null, row.custom_until) : 1;
    const bill = row ? branchBill(row, b.name ?? 'Branch', details.prices, months) : null;
    return { branch_id: b.id, name: b.name, is_main: !!b.is_main, plan: row, premium: row ? [...premiumOf(row)] : [], package: !!row?.package,
      standing: bs ? standingView(bs) : null, period_total: bill ? invoiceItems([bill]).reduce((t, i) => t + i.amount, 0) : null };
  });
  return {
    plan: facts?.plan ?? null,
    standing: s ? standingView(s) : null,
    per_branch: rows.length > 0,   // A612
    branches,
    prices: details.prices,
    open_invoices: open,   // A587: what a payment offsets, oldest first
    payments: payments.data ?? [],
    reminders: reminders.data ?? [],
    defaults: {
      monthly: CLOUD_MONTHLY_KES,
      periods: PLAN_PERIODS.map((p) => ({ value: p, label: PERIOD_LABEL[p], amount: defaultAmount(p) })),
      methods: PAYMENT_METHODS,
    },
  };
}

async function webAccessOn(req: any, businessId: string, note: string): Promise<void> {
  const fl = await supabase.from('feature_flags').upsert({
    business_id: businessId, key: 'web_hosting', enabled: true, notes: note, set_by: req.adminEmail ?? null, updated_at: new Date().toISOString(),
  }, { onConflict: 'business_id,key' });
  if (fl.error) console.error('[cloud-plan] web access not switched on:', fl.error.message);
}

async function convertTrial(businessId: string, now: number): Promise<boolean> {
  try {
    const trial = await readTrial(businessId);
    if (trial && !trial.converted_at) {
      const t = await supabase.from('business_settings').update({ value: { ...trial, converted_at: new Date(now).toISOString() }, updated_at: new Date(now).toISOString() })
        .eq('business_id', businessId).eq('key', CLOUD_TRIAL_KEY);
      return !t.error;
    }
  } catch (e) { console.error('[cloud-plan] trial not marked converted:', (e as Error)?.message); }
  return false;
}

type WorkedOut = { ok: true; period: PlanPeriod; standing: CloudStanding; from: string; until: string; cover: PaymentCover } | { ok: false; status: number; body: { error: string; code: string } };

/**
 * A587: what a payment would buy — the period, where the paid time starts (early: the current paid-until; unpaid or
 * LOCKED: the original due date — offset, no free gap; "Not interested": today, afresh) and the outstanding invoices it
 * settles. A client switched off is read as if on (it pays like any other). Shared by Record payment and its preview.
 */
async function workOut(clientId: string, facts: CloudFactsRow, b: any, now: number): Promise<WorkedOut> {
  const plan = facts.plan;
  const period: PlanPeriod | null = isPeriod(b.period) ? b.period : plan?.period ?? null;
  if (!period) return { ok: false, status: 400, body: { error: 'Choose the period this payment covers (or set the plan first).', code: 'BAD_PERIOD' } };
  const standing = cloudStanding({ ...facts, webHosting: facts.webHosting === false ? true : facts.webHosting }, now);
  // A587 (pay as you go): locked or "Not interested" — a fresh period from today, the locked time not charged.
  const fresh = standing.state === 'locked' || standing.state === 'not_interested';
  // A584: within the 7 unpaid days (it still had access) the payment covers the invoiced period, from its due date.
  const continueFrom = standing.state === 'unpaid' ? standing.dueAt : null;
  const ext = nextPaidUntil({ period, now, paidUntil: fresh ? null : facts.expiresAt, continueFrom, customUntil: isoOrNull(b.paid_until) ?? plan?.custom_until ?? null });
  if (ext.ok === false) return { ok: false, status: 400, body: { error: ext.error, code: ext.code } };
  const outstanding = await openCloudInvoices(clientId);
  return { ok: true, period, standing, from: ext.from, until: ext.until, cover: paymentCovers({ from: ext.from, until: ext.until, outstanding, fresh }) };
}

const coverView = (w: Extract<WorkedOut, { ok: true }>) => ({
  period: w.period, from: w.from, until: w.until, state: w.standing.state, fresh: w.cover.fresh,
  settles: w.cover.settles, closes: w.cover.closes, not_interested_at: w.standing.notInterestedAt,
});

router.post('/:businessId/cloud-plan/payments/preview', requireAdmin, async (req, res) => {
  const client = await clientOf(req, res); if (!client) return;
  const facts = (await readCloudFacts([client.id])).get(client.id);
  if (!facts) { res.status(404).json({ error: 'No such client' }); return; }
  const w = await workOut(client.id, facts, req.body ?? {}, Date.now());
  if (w.ok === false) { res.status(w.status).json(w.body); return; }
  res.json(coverView(w));
});

router.get('/:businessId/cloud-plan', requireAdmin, async (req, res) => {
  const client = await clientOf(req, res); if (!client) return;
  try { res.json(await planView(client.id)); }
  catch (e) { sendError(res, e); }
});

router.put('/:businessId/cloud-plan', requireAdmin, requireSuperAdmin, async (req, res) => {
  const client = await clientOf(req, res); if (!client) return;
  const b = req.body ?? {};
  if (!isPeriod(b.period)) { res.status(400).json({ error: `period must be one of: ${PLAN_PERIODS.join(', ')}`, code: 'BAD_PERIOD' }); return; }
  const amount = money(b.amount);
  if (amount === null || amount < 0 || amount > AMOUNT_MAX) { res.status(400).json({ error: 'Type the amount per period (KES).', code: 'BAD_AMOUNT' }); return; }
  const customUntil = isoOrNull(b.custom_until);
  if (b.period === 'custom' && b.custom_until && !customUntil) { res.status(400).json({ error: 'custom_until must be a date', code: 'BAD_DATE' }); return; }
  const { data: before } = await supabase.from('cloud_plans').select('*').eq('business_id', client.id).maybeSingle();
  const row: CloudPlanRow = {
    business_id: client.id, period: b.period as PlanPeriod, amount, currency: 'KES',
    custom_until: b.period === 'custom' ? customUntil : null, notes: text(b.notes, 500), updated_by: req.adminEmail ?? null,
  };
  const { data, error } = await supabase.from('cloud_plans')
    .upsert({ ...row, updated_at: new Date().toISOString(), ...(before ? {} : { created_at: new Date().toISOString() }) }, { onConflict: 'business_id' }).select().single();
  if (error) { sendError(res, error); return; }
  forgetStanding(client.id);
  await audit(req, client, before ? 'cloud_plan.update' : 'cloud_plan.create', (before as object | null) ?? null,
    { period: row.period, amount: row.amount, custom_until: row.custom_until });
  res.json({ plan: data, ...(await planView(client.id)) });
});

router.post('/:businessId/cloud-plan/payments', requireAdmin, requireSuperAdmin, async (req, res) => {
  const client = await clientOf(req, res); if (!client) return;
  const b = req.body ?? {};
  const now = Date.now();
  const facts = (await readCloudFacts([client.id])).get(client.id);
  if (!facts) { res.status(404).json({ error: 'No such client' }); return; }
  const plan = facts.plan;
  if (!isPeriod(b.period) && !plan?.period) { res.status(400).json({ error: 'Choose the period this payment covers (or set the plan first).', code: 'BAD_PERIOD' }); return; }
  const amount = money(b.amount);
  if (amount === null || amount <= 0 || amount > AMOUNT_MAX) { res.status(400).json({ error: 'Type the amount the client paid (KES).', code: 'BAD_AMOUNT' }); return; }
  const method = (PAYMENT_METHODS as readonly string[]).includes(b.method) ? b.method as string : 'mpesa';
  let reference = text(b.reference, 60);
  if (method === 'mpesa') {
    reference = reference ? reference.toUpperCase().replace(/\s+/g, '') : null;
    if (!reference || !MPESA_CODE.test(reference)) {
      res.status(400).json({ error: 'Type the M-Pesa code (letters and numbers, e.g. SJK4H7Q2LM).', code: 'BAD_REFERENCE' }); return;
    }
    const { data: dup } = await supabase.from('cloud_payments').select('id, business_id').eq('method', 'mpesa').eq('reference', reference).maybeSingle();
    if (dup) { res.status(409).json({ error: `M-Pesa code ${reference} is already recorded${(dup as any).business_id === client.id ? ' for this client' : ' for another client'}.`, code: 'DUPLICATE_REFERENCE' }); return; }
  }
  const paidAt = isoOrNull(b.paid_at) ?? new Date(now).toISOString();
  if (Date.parse(paidAt) > now + 60_000) { res.status(400).json({ error: 'The payment date cannot be in the future.', code: 'BAD_DATE' }); return; }

  const before = facts.expiresAt;
  // A584: within the 7 unpaid days the payment covers the invoiced period (from its due date). A587: a locked or "Not
  // interested" client starts afresh from today (pay as you go).
  const w = await workOut(client.id, facts, b, now);
  if (w.ok === false) { res.status(w.status).json(w.body); return; }
  const { period, standing, cover } = w;
  const ext = { from: w.from, until: w.until };

  // 1. the payment (an M-Pesa code is unique in the table too — two admins at once: one wins).
  const ins = await supabase.from('cloud_payments').insert({
    business_id: client.id, amount, currency: 'KES', period, method, reference, paid_at: paidAt,
    paid_until_before: before, paid_until_after: ext.until, recorded_by: req.adminId ?? null,
    recorded_by_email: req.adminEmail ?? 'admin', note: text(b.note, 500),
  }).select().single();
  if (ins.error) {
    if ((ins.error as { code?: string }).code === '23505') { res.status(409).json({ error: `M-Pesa code ${reference} is already recorded.`, code: 'DUPLICATE_REFERENCE' }); return; }
    sendError(res, ins.error); return;
  }
  const payment = ins.data as { id: string };

  // 2. paid-until moves only from the value this payment was worked out from — two payments at once never lose one.
  let upd = supabase.from('businesses').update({ web_access_expires_at: ext.until }).eq('id', client.id);
  upd = before ? upd.eq('web_access_expires_at', before) : upd.is('web_access_expires_at', null);
  const moved = await upd.select('id');
  if (moved.error || !(moved.data ?? []).length) {
    await supabase.from('cloud_payments').delete().eq('id', payment.id);
    if (moved.error) { sendError(res, moved.error); return; }
    res.status(409).json({ error: 'The paid-until changed while this was being recorded — reload and record it again.', code: 'PAID_UNTIL_CHANGED' }); return;
  }

  // 3. the plan (a first payment puts the client on it), web access on, a trial converted, the invoice.
  if (!plan) {
    const p = await supabase.from('cloud_plans').upsert({
      business_id: client.id, period, amount, currency: 'KES',
      custom_until: period === 'custom' ? ext.until : null, updated_by: req.adminEmail ?? null, created_at: new Date(now).toISOString(),
    }, { onConflict: 'business_id' });
    if (p.error) console.error('[cloud-plan] plan not saved with the first payment:', p.error.message);
  }
  await webAccessOn(req, client.id, `Cloud plan — paid until ${ext.until.slice(0, 10)} (A581)`);
  const trialConverted = await convertTrial(client.id, now);
  // A584: the period's invoice (raised on its due day, pending) is marked paid; else a paid one is raised.
  // A587 (pay as you go): a fresh start closes the locked time's open invoices — written off, not charged.
  let invoiceNumber: string | null = null;
  const settled: string[] = [];
  let closed: string[] = [];
  try {
    let invoiceId: string | null = null;
    const inv0 = cover.settles[0];
    if (inv0) {
      const u = await supabase.from('invoices').update({
        status: 'paid', amount, payment_method: method, payment_reference: reference, paid_at: paidAt, period_end: ext.until,
      }).eq('id', inv0.id).eq('business_id', client.id).eq('status', 'pending').select('id');
      if (!u.error && (u.data ?? []).length) { settled.push(inv0.invoice_number); invoiceId = inv0.id; }
    }
    if (!invoiceId) {
      const number = await nextInvoiceNumber();
      const inv = await insertCloudInvoice({
        business_id: client.id, invoice_number: number, amount, currency: 'KES', status: 'paid',
        payment_method: method, payment_reference: reference, period_start: ext.from, period_end: ext.until, paid_at: paidAt,
      });
      if (!inv.error && inv.data) { invoiceId = inv.data.id; settled.push(inv.data.invoice_number ?? number); }
    }
    if (cover.closes.length) {
      const wo = await writeOffCloudInvoices(client.id, cover.closes.map((i) => i.id));
      if (wo.error) console.error('[cloud-plan] unpaid invoices of the locked time not closed:', wo.error);
      closed = wo.numbers;
    }
    invoiceNumber = settled[0] ?? null;
    if (invoiceId) await supabase.from('cloud_payments').update({ invoice_id: invoiceId }).eq('id', payment.id);
  } catch { invoiceNumber = null; }

  forgetStanding(client.id);
  await audit(req, client, 'cloud_plan.payment', { paid_until: before, state: standing.state },
    { amount, currency: 'KES', period, method, reference, paid_at: paidAt, paid_until: ext.until, from: ext.from, invoice_number: invoiceNumber, trial_converted: trialConverted,
      fresh_start: cover.fresh, not_charged: closed, ...(closed.length ? { not_charged_reason: 'Not charged — access was paused (pay as you go, A587)' } : {}) },
    text(b.note, 500));

  // A584: a short receipt to the owner (best effort — never fails the payment).
  let receiptSent = false;
  try {
    const { data: bz } = await supabase.from('businesses').select('owner_id, email').eq('id', client.id).maybeSingle();
    const to = await ownerEmailOf((bz as any)?.owner_id, (bz as any)?.email);
    if (to) {
      const m = receiptEmailHtml({ businessName: client.name ?? 'your business', amount, currency: 'KES', method, reference, paidAt, paidUntil: ext.until, invoiceNumber });
      receiptSent = (await sendEmailChecked({ to, subject: m.subject, html: m.html })).ok;
    }
  } catch (e) { console.warn('[cloud-plan] receipt not sent:', (e as Error)?.message); }

  res.status(201).json({ payment: { ...payment, paid_until_after: ext.until }, trial_converted: trialConverted, invoice_number: invoiceNumber, not_charged: closed,
    covers: coverView(w), receipt_sent: receiptSent, ...(await planView(client.id)) });
});

router.post('/:businessId/cloud-plan/complimentary', requireAdmin, requireSuperAdmin, async (req, res) => {
  const client = await clientOf(req, res); if (!client) return;
  const b = req.body ?? {};
  const now = Date.now();
  const until = isoOrNull(b.paid_until);
  if (!until) { res.status(400).json({ error: 'Choose the date it is paid until.', code: 'BAD_DATE' }); return; }
  if (Date.parse(until) <= now) { res.status(400).json({ error: 'The date must be in the future.', code: 'BAD_DATE' }); return; }
  const reason = text(b.reason, 500);
  if (!reason || reason.length < 3) { res.status(400).json({ error: 'Say why (a complimentary or manual paid-until is audited).', code: 'REASON_REQUIRED' }); return; }
  const facts = (await readCloudFacts([client.id])).get(client.id);
  if (!facts) { res.status(404).json({ error: 'No such client' }); return; }
  const before = facts.expiresAt;
  const { error } = await supabase.from('businesses').update({ web_access_expires_at: until }).eq('id', client.id);
  if (error) { sendError(res, error); return; }
  if (!facts.plan) {
    const p = await supabase.from('cloud_plans').upsert({
      business_id: client.id, period: 'monthly', amount: CLOUD_MONTHLY_KES, currency: 'KES', custom_until: null,
      notes: 'A584: put on the plan with a complimentary paid-until', updated_by: req.adminEmail ?? null, created_at: new Date(now).toISOString(),
    }, { onConflict: 'business_id' });
    if (p.error) console.error('[cloud-plan] plan not saved with the complimentary date:', p.error.message);
  }
  await webAccessOn(req, client.id, `Complimentary — paid until ${until.slice(0, 10)} (A584)`);
  const trialConverted = await convertTrial(client.id, now);
  forgetStanding(client.id);
  await audit(req, client, 'cloud_plan.complimentary', { paid_until: before }, { paid_until: until, trial_converted: trialConverted }, reason);
  res.json({ paid_until: until, trial_converted: trialConverted, ...(await planView(client.id)) });
});

// ── A612 phase 3: billed per branch ──────────────────────────────────────────────────────────────────────────────────

const branchRowsOf = async (businessId: string) => {
  const facts = (await readCloudFacts([businessId])).get(businessId) ?? null;
  return { facts, rowBy: new Map((facts?.branchPlans ?? []).map((r) => [String(r.branch_id), r])) };
};

router.put('/:businessId/cloud-plan/branches/:branchId', requireAdmin, requireSuperAdmin, async (req, res) => {
  const client = await clientOf(req, res); if (!client) return;
  const branchId = String(req.params.branchId ?? '');
  if (!UUID.test(branchId)) { res.status(400).json({ error: 'branchId must be an id' }); return; }
  const { data: br } = await supabase.from('branches').select('id, name').eq('id', branchId).eq('business_id', client.id).maybeSingle();
  if (!br) { res.status(404).json({ error: 'No such branch for this client', code: 'BRANCH_NOT_FOUND' }); return; }
  const b = req.body ?? {};
  const { facts, rowBy } = await branchRowsOf(client.id);
  const before = rowBy.get(branchId) ?? null;
  const period: PlanPeriod | null = isPeriod(b.period) ? b.period : before?.period ?? facts?.plan?.period ?? null;
  if (!period) { res.status(400).json({ error: `period must be one of: ${PLAN_PERIODS.join(', ')}`, code: 'BAD_PERIOD' }); return; }
  const amount = b.amount === undefined ? Number(before?.amount ?? defaultAmount(period) ?? CLOUD_MONTHLY_KES) : money(b.amount);
  if (amount === null || amount < 0 || amount > AMOUNT_MAX) { res.status(400).json({ error: 'Type the amount per period (KES).', code: 'BAD_AMOUNT' }); return; }
  const customUntil = isoOrNull(b.custom_until);
  if (b.premium !== undefined && (!Array.isArray(b.premium) || !b.premium.every(isPremiumKey))) {
    res.status(400).json({ error: `premium is a list of: ${PREMIUM_KEYS.join(', ')}`, code: 'BAD_PREMIUM' }); return;
  }
  const row = {
    branch_id: branchId, business_id: client.id, period, amount, currency: 'KES',
    custom_until: period === 'custom' ? customUntil ?? before?.custom_until ?? null : null,
    web_off: b.web_off === undefined ? !!before?.web_off : b.web_off === true,
    premium: b.premium === undefined ? before?.premium ?? [] : [...new Set(b.premium as string[])],
    package: b.package === undefined ? !!before?.package : b.package === true,
    notes: b.notes === undefined ? before?.notes ?? null : text(b.notes, 500),
    updated_by: req.adminEmail ?? null, updated_at: new Date().toISOString(),
    // a new row: paid until the business's date (it inherits, as migration 182 did), billing from today
    ...(before ? {} : { paid_until: facts?.expiresAt ?? null, created_at: new Date().toISOString() }),
  };
  const { error } = await supabase.from('branch_cloud_plans').upsert(row, { onConflict: 'branch_id' });
  if (error) { sendError(res, error); return; }
  forgetStanding(client.id);
  await audit(req, client, 'cloud_plan.branch', before as object | null,
    { branch: (br as { name: string | null }).name, period, amount, web_off: row.web_off, premium: row.premium, package: row.package });
  res.json(await planView(client.id));
});

router.post('/:businessId/cloud-plan/branches/start', requireAdmin, requireSuperAdmin, async (req, res) => {
  const client = await clientOf(req, res); if (!client) return;
  const { facts, rowBy } = await branchRowsOf(client.id);
  if (!facts?.plan) { res.status(409).json({ error: 'Set the client\'s plan first — each branch starts from it.', code: 'NO_PLAN' }); return; }
  const { data: brs, error: bErr } = await supabase.from('branches').select('id, name').eq('business_id', client.id);
  if (bErr) { sendError(res, bErr); return; }
  const fresh = ((brs ?? []) as Array<{ id: string; name: string | null }>).filter((b) => !rowBy.has(String(b.id)));
  if (fresh.length) {
    const now = new Date().toISOString();
    const { error } = await supabase.from('branch_cloud_plans').insert(fresh.map((b) => ({
      branch_id: b.id, business_id: client.id, period: facts.plan!.period, amount: facts.plan!.amount, currency: facts.plan!.currency ?? 'KES',
      custom_until: facts.plan!.custom_until ?? null, paid_until: facts.expiresAt ?? null, billing_from: facts.plan!.billing_from ?? null,
      created_at: facts.plan!.created_at ?? now, updated_by: req.adminEmail ?? null,
    })));
    if (error) { sendError(res, error); return; }
  }
  forgetStanding(client.id);
  await audit(req, client, 'cloud_plan.branches_start', null, { branches: fresh.map((b) => b.name), paid_until: facts.expiresAt });
  res.json(await planView(client.id));
});

type BranchWorked = { branch_id: string; name: string; row: BranchPlanRow; before: string | null; from: string; until: string; fresh: boolean; state: string; bill: BranchBill };

/** What a payment buys each branch named (the business's rules, per branch). */
async function workOutBranches(clientId: string, facts: CloudFactsRow, ids: string[], now: number):
  Promise<{ ok: true; branches: BranchWorked[]; expected: number } | { ok: false; status: number; body: { error: string; code: string } }> {
  const rowBy = new Map((facts.branchPlans ?? []).map((r) => [String(r.branch_id), r]));
  if (!ids.length) return { ok: false, status: 400, body: { error: 'Tick the branches this payment is for.', code: 'NO_BRANCHES' } };
  const missing = ids.filter((id) => !rowBy.has(id));
  if (missing.length) return { ok: false, status: 400, body: { error: 'A branch named has no plan of its own — set its plan first.', code: 'BRANCH_NO_PLAN' } };
  const { data: brs } = await supabase.from('branches').select('id, name').eq('business_id', clientId).in('id', ids);
  const names = new Map(((brs ?? []) as Array<{ id: string; name: string | null }>).map((b) => [String(b.id), b.name ?? 'Branch']));
  const details = await readBillingDetails(now);
  const out: BranchWorked[] = [];
  for (const id of ids) {
    const row = rowBy.get(id)!;
    const s = cloudStanding({ ...branchFactsFor(facts, row), webHosting: true }, now);   // a branch switched off pays like any other
    const fresh = s.state === 'locked' || s.state === 'not_interested';
    const continueFrom = s.state === 'unpaid' ? s.dueAt : null;
    const ext = nextPaidUntil({ period: row.period, now, paidUntil: fresh ? null : row.paid_until, continueFrom, customUntil: row.custom_until ?? null });
    if (ext.ok === false) return { ok: false, status: 400, body: { error: `${names.get(id) ?? 'A branch'}: ${ext.error}`, code: ext.code } };
    const ip = invoicePeriod(row, ext.from);
    const bill = branchBill(row, names.get(id) ?? 'Branch', details.prices, periodMonths(row.period, ext.from, ip.end ?? ext.until));
    out.push({ branch_id: id, name: names.get(id) ?? 'Branch', row, before: row.paid_until, from: ext.from, until: ext.until, fresh, state: s.state, bill });
  }
  return { ok: true, branches: out, expected: invoiceItems(out.map((w) => w.bill)).reduce((t, i) => t + i.amount, 0) };
}

const idsOf = (v: unknown): string[] => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && UUID.test(x)))] : []);

router.post('/:businessId/cloud-plan/branch-payments/preview', requireAdmin, async (req, res) => {
  const client = await clientOf(req, res); if (!client) return;
  const facts = (await readCloudFacts([client.id])).get(client.id);
  if (!facts) { res.status(404).json({ error: 'No such client' }); return; }
  const w = await workOutBranches(client.id, facts, idsOf(req.body?.branch_ids), Date.now());
  if (w.ok === false) { res.status(w.status).json(w.body); return; }
  res.json({ expected: w.expected, branches: w.branches.map((b) => ({ branch_id: b.branch_id, name: b.name, from: b.from, until: b.until, fresh: b.fresh, state: b.state })) });
});

router.post('/:businessId/cloud-plan/branch-payments', requireAdmin, requireSuperAdmin, async (req, res) => {
  const client = await clientOf(req, res); if (!client) return;
  const b = req.body ?? {};
  const now = Date.now();
  const facts = (await readCloudFacts([client.id])).get(client.id);
  if (!facts) { res.status(404).json({ error: 'No such client' }); return; }
  const amount = money(b.amount);
  if (amount === null || amount <= 0 || amount > AMOUNT_MAX) { res.status(400).json({ error: 'Type the amount the client paid (KES).', code: 'BAD_AMOUNT' }); return; }
  const method = (PAYMENT_METHODS as readonly string[]).includes(b.method) ? b.method as string : 'mpesa';
  let reference = text(b.reference, 60);
  if (method === 'mpesa') {
    reference = reference ? reference.toUpperCase().replace(/\s+/g, '') : null;
    if (!reference || !MPESA_CODE.test(reference)) { res.status(400).json({ error: 'Type the M-Pesa code (letters and numbers, e.g. SJK4H7Q2LM).', code: 'BAD_REFERENCE' }); return; }
    const { data: dup } = await supabase.from('cloud_payments').select('id, business_id').eq('method', 'mpesa').eq('reference', reference).maybeSingle();
    if (dup) { res.status(409).json({ error: `M-Pesa code ${reference} is already recorded${(dup as any).business_id === client.id ? ' for this client' : ' for another client'}.`, code: 'DUPLICATE_REFERENCE' }); return; }
  }
  const paidAt = isoOrNull(b.paid_at) ?? new Date(now).toISOString();
  if (Date.parse(paidAt) > now + 60_000) { res.status(400).json({ error: 'The payment date cannot be in the future.', code: 'BAD_DATE' }); return; }
  const w = await workOutBranches(client.id, facts, idsOf(b.branch_ids), now);
  if (w.ok === false) { res.status(w.status).json(w.body); return; }
  const ids = w.branches.map((x) => x.branch_id);
  const latest = w.branches.map((x) => x.until).sort().slice(-1)[0];

  // 1. the payment (an M-Pesa code is unique — two admins at once: one wins)
  const ins = await supabase.from('cloud_payments').insert({
    business_id: client.id, amount, currency: 'KES', period: w.branches[0].row.period, method, reference, paid_at: paidAt,
    paid_until_before: facts.expiresAt, paid_until_after: latest, recorded_by: req.adminId ?? null,
    recorded_by_email: req.adminEmail ?? 'admin', note: text(b.note, 500), branch_ids: ids,
  }).select().single();
  if (ins.error) {
    if ((ins.error as { code?: string }).code === '23505') { res.status(409).json({ error: `M-Pesa code ${reference} is already recorded.`, code: 'DUPLICATE_REFERENCE' }); return; }
    sendError(res, ins.error); return;
  }
  const payment = ins.data as { id: string };

  // 2. each branch's paid-until moves only from the value it was worked out from (two payments at once never lose one)
  const moved: BranchWorked[] = [];
  for (const x of w.branches) {
    let upd = supabase.from('branch_cloud_plans').update({ paid_until: x.until, updated_at: new Date(now).toISOString() }).eq('branch_id', x.branch_id);
    upd = x.before ? upd.eq('paid_until', x.before) : upd.is('paid_until', null);
    const r = await upd.select('branch_id');
    if (r.error || !(r.data ?? []).length) {
      for (const m of moved) await supabase.from('branch_cloud_plans').update({ paid_until: m.before }).eq('branch_id', m.branch_id).eq('paid_until', m.until);
      await supabase.from('cloud_payments').delete().eq('id', payment.id);
      if (r.error) { sendError(res, r.error); return; }
      res.status(409).json({ error: `${x.name}'s paid-until changed while this was being recorded — reload and record it again.`, code: 'PAID_UNTIL_CHANGED' }); return;
    }
    moved.push(x);
  }

  // 3. the business: paid until its latest branch (sign-in stays open while one is paid), web access on, a trial converted
  const allUntil = (facts.branchPlans ?? []).map((r) => (ids.includes(String(r.branch_id)) ? w.branches.find((x) => x.branch_id === String(r.branch_id))!.until : r.paid_until))
    .filter((d): d is string => !!d).sort();
  const bizUntil = allUntil.slice(-1)[0] ?? latest;
  const bu = await supabase.from('businesses').update({ web_access_expires_at: bizUntil }).eq('id', client.id);
  if (bu.error) console.error('[cloud-plan] business paid-until not moved with the branch payment:', bu.error.message);
  await webAccessOn(req, client.id, `Cloud plan per branch — ${w.branches.map((x) => x.name).join(', ')} paid (A612)`);
  const trialConverted = await convertTrial(client.id, now);

  // 4. the invoices: exactly these branches' open invoice(s) — paid; a fresh start's (locked time) closed, not charged
  const settled: string[] = [];
  let closed: string[] = [];
  try {
    const { data: open } = await supabase.from('invoices').select('id, invoice_number, branch_ids')
      .eq('business_id', client.id).eq('kind', 'cloud').eq('status', 'pending').order('period_start', { ascending: true });
    const mine = ((open ?? []) as Array<{ id: string; invoice_number: string; branch_ids: string[] | null }>)
      .filter((i) => (i.branch_ids ?? []).length && (i.branch_ids ?? []).every((x) => ids.includes(x)));
    const freshIds = new Set(w.branches.filter((x) => x.fresh).map((x) => x.branch_id));
    const toClose = mine.filter((i) => (i.branch_ids ?? []).every((x) => freshIds.has(x)));
    const toPay = mine.filter((i) => !toClose.includes(i));
    let invoiceId: string | null = null;
    for (const i of toPay) {
      const u = await supabase.from('invoices').update({ status: 'paid', payment_method: method, payment_reference: reference, paid_at: paidAt })
        .eq('id', i.id).eq('business_id', client.id).eq('status', 'pending').select('id');
      if (!u.error && (u.data ?? []).length) { settled.push(i.invoice_number); invoiceId = invoiceId ?? i.id; }
    }
    if (!invoiceId) {
      const items = invoiceItems(w.branches.map((x) => x.bill));
      const number = await nextInvoiceNumber();
      const inv = await insertCloudInvoice({
        business_id: client.id, invoice_number: number, amount, currency: 'KES', status: 'paid', payment_method: method, payment_reference: reference,
        period_start: w.branches.map((x) => x.from).sort()[0], period_end: latest, paid_at: paidAt, branch_ids: ids,
        lines: { items, branches: w.branches.map((x) => ({ branch_id: x.branch_id, name: x.name, bill: x.bill })) },
      });
      if (!inv.error && inv.data) { invoiceId = inv.data.id; settled.push(inv.data.invoice_number ?? number); }
    }
    if (toClose.length) {
      const wo = await writeOffCloudInvoices(client.id, toClose.map((i) => i.id));
      if (wo.error) console.error('[cloud-plan] unpaid invoices of the locked time not closed:', wo.error);
      closed = wo.numbers;
    }
    if (invoiceId) await supabase.from('cloud_payments').update({ invoice_id: invoiceId }).eq('id', payment.id);
  } catch (e) { console.error('[cloud-plan] branch payment invoices:', (e as Error)?.message); }

  forgetStanding(client.id);
  await audit(req, client, 'cloud_plan.payment', { paid_until: facts.expiresAt, branches: w.branches.map((x) => ({ name: x.name, paid_until: x.before, state: x.state })) },
    { amount, currency: 'KES', method, reference, paid_at: paidAt, expected: w.expected, branches: w.branches.map((x) => ({ name: x.name, from: x.from, until: x.until, fresh: x.fresh })),
      invoice_number: settled[0] ?? null, trial_converted: trialConverted, not_charged: closed,
      ...(closed.length ? { not_charged_reason: 'Not charged — access was paused (pay as you go, A587)' } : {}) },
    text(b.note, 500));

  let receiptSent = false;
  try {
    const { data: bz } = await supabase.from('businesses').select('owner_id, email').eq('id', client.id).maybeSingle();
    const to = await ownerEmailOf((bz as any)?.owner_id, (bz as any)?.email);
    if (to) {
      const m = receiptEmailHtml({ businessName: client.name ?? 'your business', amount, currency: 'KES', method, reference, paidAt, paidUntil: latest, invoiceNumber: settled[0] ?? null });
      receiptSent = (await sendEmailChecked({ to, subject: m.subject, html: m.html })).ok;
    }
  } catch (e) { console.warn('[cloud-plan] receipt not sent:', (e as Error)?.message); }

  res.status(201).json({ payment: { ...payment, branch_ids: ids }, expected: w.expected, invoice_number: settled[0] ?? null, not_charged: closed,
    // paid_branches: not `branches` — the plan view's own branches follow
    paid_branches: w.branches.map((x) => ({ branch_id: x.branch_id, name: x.name, from: x.from, until: x.until, fresh: x.fresh })),
    trial_converted: trialConverted, receipt_sent: receiptSent, ...(await planView(client.id)) });
});

export default router;
