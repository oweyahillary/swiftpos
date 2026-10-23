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
 *   POST /api/admin/clients/:businessId/cloud-plan/complimentary — { paid_until, reason }: A584 — a manual paid-until for
 *        a special case (no payment, no invoice): web access on, the client put on the plan, a trial converted; the reason
 *        required; audited ('cloud_plan.complimentary'). Super admin.
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
  readCloudFacts, forgetStanding, nextInvoiceNumber, insertCloudInvoice, standingView, type PlanPeriod, type CloudPlanRow,
} from '../lib/cloudPlan';
import { receiptEmailHtml } from '../lib/cloudPlanEmail';
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
  return {
    plan: facts?.plan ?? null,
    standing: s ? standingView(s) : null,
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
  const period: PlanPeriod | null = isPeriod(b.period) ? b.period : plan?.period ?? null;
  if (!period) { res.status(400).json({ error: 'Choose the period this payment covers (or set the plan first).', code: 'BAD_PERIOD' }); return; }
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
  // A584: within the 7 unpaid days the payment covers the period that was invoiced (from its due date).
  const standing = cloudStanding(facts, now);
  const continueFrom = !standing.trial && standing.state === 'unpaid' ? standing.dueAt : null;
  const ext = nextPaidUntil({ period, now, paidUntil: before, continueFrom, customUntil: isoOrNull(b.paid_until) ?? plan?.custom_until ?? null });
  if (ext.ok === false) { res.status(400).json({ error: ext.error, code: ext.code }); return; }

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
  let invoiceNumber: string | null = null;
  try {
    const { data: open } = await supabase.from('invoices').select('id, invoice_number')
      .eq('business_id', client.id).eq('period_start', ext.from).eq('status', 'pending').limit(1).maybeSingle();
    let invoiceId: string | null = null;
    if (open) {
      const u = await supabase.from('invoices').update({
        status: 'paid', amount, payment_method: method, payment_reference: reference, paid_at: paidAt, period_end: ext.until,
      }).eq('id', (open as { id: string }).id).select('id');
      if (!u.error) { invoiceId = (open as { id: string }).id; invoiceNumber = (open as { invoice_number: string }).invoice_number; }
    } else {
      const number = await nextInvoiceNumber();
      const inv = await insertCloudInvoice({
        business_id: client.id, invoice_number: number, amount, currency: 'KES', status: 'paid',
        payment_method: method, payment_reference: reference, period_start: ext.from, period_end: ext.until, paid_at: paidAt,
      });
      if (!inv.error && inv.data) { invoiceId = inv.data.id; invoiceNumber = inv.data.invoice_number ?? number; }
    }
    if (invoiceId) await supabase.from('cloud_payments').update({ invoice_id: invoiceId }).eq('id', payment.id);
  } catch { invoiceNumber = null; }

  forgetStanding(client.id);
  await audit(req, client, 'cloud_plan.payment', { paid_until: before, state: standing.state },
    { amount, currency: 'KES', period, method, reference, paid_at: paidAt, paid_until: ext.until, from: ext.from, invoice_number: invoiceNumber, trial_converted: trialConverted },
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

  res.status(201).json({ payment: { ...payment, paid_until_after: ext.until }, trial_converted: trialConverted, invoice_number: invoiceNumber, receipt_sent: receiptSent, ...(await planView(client.id)) });
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

export default router;
